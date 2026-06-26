// Dapp-side orchestration for the confidential-pool UX (Sepolia pilot v1, 2026-06-14). Wires the
// already-built primitives into one tab-facing API so tacit.js stays a thin renderer over the LIVE pool:
//   - evm-account        → the persistent Sepolia EVM identity derived from the Tacit wallet scalar
//   - confidential-evm-log + confidential-indexer → seed-only confidential balance from the pool's logs
//   - confidential-relay → the settle queue (transfer/swap/lp/otc/bid) on api.tacit.finance
// The wrap (on-chain deposit) + transfer/unwrap BUILD paths layer the op assemblers + evm-tx on top of
// this; this module owns the read path (account + balance) + the live config + the settle/RPC handles.

import { getConfidentialDeployment, activeNetwork } from './confidential-deployments.js';
import { makeEvmAccount } from './evm-account.js';
import { makeConfidentialIndexer } from './confidential-indexer.js';
import { makeConfidentialEvmLog } from './confidential-evm-log.js';
import { makeConfidentialRelay } from './confidential-relay.js';
import { makeEvmTx } from './evm-tx.js';
import { makeRecoveryGuard } from './confidential-recovery-guard.js';
import { makeConfidentialRouter } from './confidential-router.js';
import { makeConfidentialTransfer } from './confidential-transfer.js';
import { makeConfidentialRoute } from './confidential-route.js';
import { randomScalar } from './bulletproofs-plus.js';

// The confidential deployment + asset register live in confidential-deployments.js (the single source the
// deploy sync patches); this module consumes a resolved record via getConfidentialDeployment(network).

export function makeConfidentialPoolUx({ secp, keccak256, sha256, fetchImpl, network } = {}) {
  const cfg = getConfidentialDeployment(network);
  if (!cfg || !cfg.pool) throw new Error(`confidential pool not deployed on "${network || activeNetwork()}"`);
  const _fetch = fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);

  const evm = makeEvmAccount({ secp, keccak256, sha256 });
  const indexer = makeConfidentialIndexer({ secp, keccak256, sha256 });
  const evmLog = makeConfidentialEvmLog({ keccak256 });
  // Seed-only recovery guard (shared): seals one memo per output + the submit-time tripwire that no op ships
  // an unrecoverable leaf. Injected into the relay so EVERY box-settled op (transfer/swap/lp/otc/route/bid)
  // passes the recovery assert at submit; wrap (on-chain) uses it directly as the reference integration.
  const memo = indexer._memo;   // sealMemo / encodeMemo / decodeMemo
  const guard = makeRecoveryGuard({ memo });
  const relay = makeConfidentialRelay({ base: cfg.relayBase, fetchImpl: _fetch, guard });

  // Only assets with a deployed assetId are usable in the pool (cTAC/cBTC/cUSD are declared but null until
  // the suite deploys; the public TAC ERC20 is not a pool note asset).
  const _poolAssets = cfg.assets.filter((a) => a.assetId);
  const assetByTicker = Object.fromEntries(_poolAssets.map((a) => [a.ticker, a]));

  // The user's persistent Sepolia EVM account (domain-separated derivation from the Tacit wallet scalar —
  // unlinkable from the Bitcoin address). Used to sign wrap deposits + own confidential notes.
  function account(walletPriv) { return evm.deriveEvmAccount(walletPriv, cfg.evmNetwork); }

  // Minimal JSON-RPC over the pool's RPC fallback list. Throws only if every endpoint fails.
  async function rpc(method, params) {
    if (!_fetch) throw new Error('no fetch implementation');
    let lastErr;
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
    for (const url of cfg.rpcs) {
      try {
        const r = await _fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
        if (!r.ok) { lastErr = new Error(`rpc ${r.status}`); continue; }
        const j = await r.json();
        if (j && j.error) { lastErr = new Error(j.error.message || 'rpc error'); continue; }
        return j ? j.result : undefined;
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('all RPCs failed');
  }

  function ethCall(to, data) { return rpc('eth_call', [{ to: String(to).toLowerCase(), data }, 'latest']); }

  // Fetch + decode the pool's confidential event stream (LeavesInserted + NullifiersSpent) in chain order
  // from the pool's deploy block — exactly the stream the indexer folds into notes + the spent set.
  async function fetchEvents({ fromBlock = cfg.deployBlock, toBlock = 'latest' } = {}) {
    const fb = typeof fromBlock === 'number' ? '0x' + fromBlock.toString(16) : fromBlock;
    const logs = await rpc('eth_getLogs', [{
      address: cfg.pool,
      fromBlock: fb,
      toBlock,
      topics: [[evmLog.TOPIC0.LeavesInserted, evmLog.TOPIC0.NullifiersSpent]],
    }]);
    return evmLog.decodeLogs(logs || []);
  }

  // Seed-only confidential balance: recover the wallet's unspent notes from chain + scan key, grouped by
  // asset. No off-chain note storage — a wiped wallet recovers its whole confidential balance from here.
  async function balance(scanPriv, opts) {
    const events = await fetchEvents(opts);
    // memo.scan needs the scan key as a 0x-hex scalar (BigInt-able); the wallet hands it as bytes.
    const sk = scanPriv instanceof Uint8Array
      ? '0x' + Array.from(scanPriv, (x) => x.toString(16).padStart(2, '0')).join('')
      : (String(scanPriv).startsWith('0x') ? String(scanPriv) : '0x' + String(scanPriv));
    const notes = indexer.recover(events, sk);
    const byAsset = {};
    for (const n of notes) {
      const id = String(n.asset || '').toLowerCase();
      (byAsset[id] ||= { asset: id, ticker: tickerOf(id), value: 0n, notes: [] });
      byAsset[id].value += BigInt(n.value);
      byAsset[id].notes.push(n);
    }
    return { notes, byAsset };
  }

  function tickerOf(assetIdHex) {
    const id = String(assetIdHex || '').toLowerCase();
    const a = cfg.assets.find((x) => x.assetId && x.assetId.toLowerCase() === id);
    return a ? a.ticker : null;
  }

  // ── wrap on-ramp ──
  const evmTx = makeEvmTx({ secp, keccak256 });
  const pool = indexer._pool;   // commitXY / deriveNote / leaf / depositId
  // `memo` + `guard` are defined above (shared with the relay chokepoint). Wrap is the reference integration:
  // build outputs[] descriptors → guard.sealMemosForOutputs → guard.assertOutputsRecoverable before submit.

  const _hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  const _word = (v) => (typeof v === 'bigint' ? v.toString(16) : String(v).replace(/^0x/, '')).padStart(64, '0');
  const _selector = (sig) => _hex(keccak256(new TextEncoder().encode(sig)).subarray(0, 4));

  // The user's confidential identity for the pool: the scan key (recovers notes), the owner pubkey
  // (memos are sealed to it), and the 32-byte owner field bound into each leaf — all from the wallet scalar.
  function identity(walletPriv) {
    const priv = walletPriv instanceof Uint8Array
      ? walletPriv
      : Uint8Array.from((String(walletPriv).replace(/^0x/, '').match(/../g) || []).map((h) => parseInt(h, 16)));
    const pub = secp.getPublicKey(priv, true);          // compressed 33B: prefix ‖ x
    // `secret` is vestigial for EVM notes (spend = knowledge of the blinding; leaf/commit/nullifier omit it),
    // but the recovery memo carries it and the transfer/route assemblers seal it + derive the memo eph from it,
    // so it must be a defined, wallet-deterministic scalar. Domain-separated from the deriveNote secret.
    const tag = new TextEncoder().encode('tacit-evm-cnote-secret-v1');
    const buf = new Uint8Array(priv.length + tag.length); buf.set(priv); buf.set(tag, priv.length);
    return { priv, pubHex: '0x' + _hex(pub), owner: '0x' + _hex(pub.subarray(1, 33)), secret: '0x' + _hex(keccak256(buf)) };
  }

  // Build the wrap deposit: the note + the on-chain pool.wrap() calldata + the recovery memo + the
  // OP_WRAP witness. Synchronous + deterministic (eph derived from the note secret). No broadcast.
  function buildWrap({ walletPriv, amountWei, ticker = 'cETH', index = 0 }) {
    const meta = assetByTicker[ticker];
    if (!meta) throw new Error(`unknown asset ${ticker}`);
    const amount = BigInt(amountWei);
    const unitScale = BigInt(meta.unitScale);
    if (amount <= 0n || amount % unitScale !== 0n) throw new Error('amount not aligned to unitScale');
    const value = amount / unitScale;
    if (value > (2n ** 64n - 1n)) throw new Error('value exceeds u64');

    const id = identity(walletPriv);
    const { secret, blinding } = pool.deriveNote(id.priv, meta.assetId, index);
    const blindingHex = '0x' + BigInt(blinding).toString(16).padStart(64, '0'); // deriveNote gives a bigint; the wrapOp/memo/harness need hex
    const { cx, cy } = pool.commitXY(value, blindingHex);
    const leaf = pool.leaf(meta.assetId, cx, cy, id.owner);
    // The on-chain wrap takes only this digest of the coords + owner; the raw values stay off-chain
    // (carried in the private OP_WRAP witness below), so the deposit note's ν is never computable.
    const commit = pool.depositCommit(cx, cy, id.owner);
    const depositId = pool.depositId(meta.assetId, value, cx, cy, id.owner);
    const cb = chainBindingHex();
    const wrapCtx = pool.intentContext('tacit-wrap-intent-v1', cb, meta.assetId, depositId,
      [[cx, cy, id.owner]], [value]);
    const wrapNonce = pool.deriveOpeningNonce(blindingHex, wrapCtx, 'wrap');
    const wrapSig = pool.openingSigma(value, blindingHex, wrapCtx, wrapNonce);
    const note = { value: value.toString(), blinding: blindingHex, secret, asset: meta.assetId, owner: id.owner, cx, cy };

    // Recovery (channel a: memo-sealed) — the reference integration every op assembler follows: describe
    // each output leaf, seal a memo per output through the guard, then trip-wire that every leaf is
    // recoverable BEFORE submit. Wrap has one output (the deposit note), sealed to the user's own pubkey;
    // eph is deterministic from the secret (the memo carries the full opening, so a fixed eph is fine and
    // keeps the build reproducible).
    const ephRand = () => (BigInt(secret) % secp.CURVE.n) || 1n;
    const outputs = [{ ...note, ownerPub: id.pubHex }];
    const memos = guard.sealMemosForOutputs({ outputs, ephRand });
    guard.assertOutputsRecoverable({ leaves: [leaf], outputs, memos });
    const memoHex = memos[0];

    // pool.wrap(bytes32 assetId, uint256 amount, bytes32 commit) — commit = keccak(Cx‖Cy‖owner)
    const calldata = '0x' + _selector('wrap(bytes32,uint256,bytes32)')
      + _word(meta.assetId) + _word(amount) + _word(commit);

    return {
      note, leaf, depositId, commit, memo: memoHex, memos, outputs,
      // the OP_WRAP witness the box proves (chainBinding stamped at submit); OP_WRAP is box-driven, not a queue type
      wrapOp: { chainBinding: cb, asset: meta.assetId, value: value.toString(), cx, cy, owner: id.owner,
        sigR: wrapSig.R, sigZ: wrapSig.z },
      to: cfg.pool, amount: amount.toString(), calldata,
      wrapArgs: { assetId: meta.assetId, amount: amount.toString(), commit },
    };
  }

  // Sign + broadcast the wrap deposit from the user's (funded) Sepolia EVM account. Returns the txHash +
  // the note record to track until the box settles OP_WRAP and the note appears in the balance scan.
  async function wrap({ walletPriv, amountWei, ticker = 'cETH', index = 0, gasLimit = 220000n, broadcast = true } = {}) {
    const w = buildWrap({ walletPriv, amountWei, ticker, index });
    const acct = account(walletPriv);
    const nonce = BigInt(await rpc('eth_getTransactionCount', [acct.address, 'pending']));
    const tip = 1500000000n; // 1.5 gwei priority
    const base = BigInt(await rpc('eth_gasPrice', []) || '0x3b9aca00');
    const tx = {
      chainId: BigInt(cfg.chainId), nonce, maxPriorityFeePerGas: tip, maxFeePerGas: base * 2n + tip,
      gasLimit: BigInt(gasLimit), to: cfg.pool, value: BigInt(w.amount), data: w.calldata,
    };
    const signed = evmTx.signEip1559(tx, acct.priv);
    const txHash = broadcast ? await rpc('eth_sendRawTransaction', [signed.raw]) : null;
    return { ...w, from: acct.address, nonce: nonce.toString(), signedRaw: signed.raw, txHash };
  }

  // ── ConfidentialRouter one-tx wrap (periphery) ──
  // The router collapses approve+wrap into a single call so an ERC20 (or native ETH) wraps straight into a
  // shielded note. The note commitment is the SAME one buildWrap produces (so the recovery memo + scan are
  // unchanged); only the on-chain entrypoint differs. Native ETH → router.wrapETH{value}(commit); an ERC20
  // → router.wrapWithPermit(...) with an EIP-2612 permit signed by the wallet's EVM account. INERT until
  // cfg.router is set (the DeployConfidentialPool broadcast pins it) — folded in now, live on deploy.
  const _router = makeConfidentialRouter({ secp, keccak256, sha256, cfg });
  function buildRouterWrap({ walletPriv, amountWei, ticker = 'cETH', index = 0, permitDeadline } = {}) {
    if (!cfg.router) throw new Error('ConfidentialRouter not deployed for this network');
    const w = buildWrap({ walletPriv, amountWei, ticker, index });
    const meta = assetByTicker[ticker];
    if (meta.native) {
      return { ...w, to: cfg.router, value: w.amount, calldata: _router.wrapETHCalldata({ commit: w.commit }), via: 'router' };
    }
    const acct = account(walletPriv);
    const deadline = BigInt(permitDeadline ?? (Math.floor(Date.now() / 1000) + 3600));
    // EIP-2612 permit so the router pulls `amount` without a separate approve tx.
    const sig = _router.signErc2612({
      token: meta.underlying, name: meta.permitName || meta.ticker, version: meta.permitVersion || '1',
      owner: acct.address, value: w.amount, nonce: 0n, deadline, priv: acct.priv, spender: cfg.router,
    });
    return {
      ...w, to: cfg.router, value: '0',
      calldata: _router.wrapWithPermitCalldata({ token: meta.underlying, amount: w.amount, commit: w.commit, deadline, v: sig.v, r: sig.r, s: sig.s }),
      via: 'router',
    };
  }

  // True when the ConfidentialRouter is deployed for this network — the gate the unified-send dispatch and
  // the UI use to prefer router batching (single-tx wrap, and the atomic wrap-and-settle seam) over the
  // two-step pool.wrap + relayed transfer.
  function routerConfigured() { return !!cfg.router; }

  // Sign + broadcast a router wrap (one tx). Mirrors wrap() but targets cfg.router.
  async function routerWrap({ walletPriv, amountWei, ticker = 'cETH', index = 0, gasLimit = 300000n, broadcast = true } = {}) {
    const w = buildRouterWrap({ walletPriv, amountWei, ticker, index });
    const acct = account(walletPriv);
    const nonce = BigInt(await rpc('eth_getTransactionCount', [acct.address, 'pending']));
    const tip = 1500000000n;
    const base = BigInt(await rpc('eth_gasPrice', []) || '0x3b9aca00');
    const tx = {
      chainId: BigInt(cfg.chainId), nonce, maxPriorityFeePerGas: tip, maxFeePerGas: base * 2n + tip,
      gasLimit: BigInt(gasLimit), to: w.to, value: BigInt(w.value), data: w.calldata,
    };
    const signed = evmTx.signEip1559(tx, acct.priv);
    const txHash = broadcast ? await rpc('eth_sendRawTransaction', [signed.raw]) : null;
    return { ...w, from: acct.address, nonce: nonce.toString(), signedRaw: signed.raw, txHash };
  }

  // ── atomic wrap-and-send (OP_WRAP_TRANSFER, op 27) ──
  // One settle that consumes a pending PUBLIC deposit and emits a HIDDEN recipient note (+ change back to the
  // sender) — OP_WRAP fused with OP_TRANSFER's conservation. Mirrors tests/gen-confidential-wraptransfer-
  // fixture.mjs byte-for-byte: the deposit is NOT minted as a self-note leaf, it is spent into the outputs.
  // The opening sigma binds the deposit exactly as buildWrap does, so the guest's deposit_id +
  // verify_opening_sigma agree. Synchronous + deterministic deposit blinding (so the deposit commit is
  // reproducible + recoverable); the output blindings are fresh and the per-output memo carries each opening.
  function buildWrapTransferOp({ walletPriv, amountWei, ticker = 'cETH', recipientPubHex, amount, fee = 0n, index = 0 }) {
    const meta = assetByTicker[ticker];
    if (!meta) throw new Error(`unknown asset ${ticker}`);
    const deposit = BigInt(amountWei);
    const unitScale = BigInt(meta.unitScale);
    if (deposit <= 0n || deposit % unitScale !== 0n) throw new Error('amount not aligned to unitScale');
    const depositValue = deposit / unitScale;
    if (depositValue > (2n ** 64n - 1n)) throw new Error('value exceeds u64');
    amount = BigInt(amount); fee = BigInt(fee);
    if (amount <= 0n) throw new Error('wrap-and-send: zero recipient amount');
    if (amount + fee > depositValue) throw new Error('wrap-and-send: amount + fee exceeds the deposit');
    const change = depositValue - amount - fee;

    const id = identity(walletPriv);
    const recipientOwner = '0x' + String(recipientPubHex).replace(/^0x/, '').slice(2, 66); // pubkey[1:33]

    // The deposit blinding is wallet-derived (reproducible deposit commit, exactly like buildWrap); the
    // deposit is consumed (spent into the outputs), not emitted as a leaf.
    const { blinding: depBlindingBn } = pool.deriveNote(id.priv, meta.assetId, index);
    const depBlinding = '0x' + BigInt(depBlindingBn).toString(16).padStart(64, '0');
    const { cx: dcx, cy: dcy } = pool.commitXY(depositValue, depBlinding);
    const depositCommit = pool.depositCommit(dcx, dcy, id.owner);
    const depositId = pool.depositId(meta.assetId, depositValue, dcx, dcy, id.owner);

    // Conservation kernel + aggregated BP+ range over [recipient, change]; the single input is the deposit.
    const rRecv = randomScalar();
    const txOutputs = [{ value: amount, blinding: rRecv, owner: recipientOwner }];
    let rChange = null;
    if (change > 0n) { rChange = randomScalar(); txOutputs.push({ value: change, blinding: rChange, owner: id.owner }); }
    const t = _ct.buildTransfer({
      inputs: [{ value: depositValue, blinding: BigInt(depBlindingBn) }],
      outputs: txOutputs, fee, assetId: meta.assetId,
    });
    if (!_ct.verifyTransfer({ ...t, fee })) throw new Error('wrap-and-send: self-verify failed (conservation/range)');

    // Deposit opening sigma — identical binding to buildWrap (tacit-wrap-intent-v1 over the deposit id).
    const cb = chainBindingHex();
    const ctx = pool.intentContext('tacit-wrap-intent-v1', cb, meta.assetId, depositId, [[dcx, dcy, id.owner]], [depositValue]);
    const nonce = pool.deriveOpeningNonce(depBlinding, ctx, 'wrap');
    const sig = pool.openingSigma(depositValue, depBlinding, ctx, nonce);

    const beHex = (n) => '0x' + n.toString(16).padStart(64, '0');
    const ptHex = (P) => '0x' + _hex(P.toRawBytes(true));
    const xy = (P) => { const a = P.toAffine(); return { cx: beHex(a.x), cy: beHex(a.y) }; };
    const outOwners = [recipientOwner]; if (change > 0n) outOwners.push(id.owner);
    const outMeta = txOutputs.map((_, j) => ({ ...xy(t.outC[j]), owner: outOwners[j] }));

    const op = {
      chainBinding: cb, asset: meta.assetId, value: depositValue.toString(),
      deposit: { cx: dcx, cy: dcy, owner: id.owner, sigR: sig.R, sigZ: sig.z },
      outputs: outMeta.map((m) => ({ cx: m.cx, cy: m.cy, owner: m.owner })),
      rangeProof: '0x' + _hex(t.rangeProof), kernel: { R: ptHex(t.kernel.R), z: beHex(t.kernel.z) },
      fee: fee.toString(),
    };

    // Recovery descriptors: the recipient note sealed to THEIR pubkey, the change to the sender's.
    const leaves = outMeta.map((m) => pool.leaf(meta.assetId, m.cx, m.cy, m.owner));
    const outputs = [{ value: amount.toString(), blinding: beHex(rRecv), secret: id.secret, asset: meta.assetId, owner: recipientOwner, cx: outMeta[0].cx, cy: outMeta[0].cy, ownerPub: recipientPubHex }];
    if (change > 0n) outputs.push({ value: change.toString(), blinding: beHex(rChange), secret: id.secret, asset: meta.assetId, owner: id.owner, cx: outMeta[1].cx, cy: outMeta[1].cy, ownerPub: id.pubHex });
    const ephRand = () => (BigInt(id.secret) % secp.CURVE.n) || 1n;
    const memos = guard.sealMemosForOutputs({ outputs, ephRand });
    guard.assertOutputsRecoverable({ leaves, outputs, memos });

    return { op, leaves, outputs, memos, ephRand, depositCommit, depositId, amount, change, fee, asset: meta.assetId, amountWei: deposit, meta };
  }

  // Read an EIP-2612 token's current permit nonce for `owner` (USDC/USDT-style). Returns 0n on any miss so
  // the build still proceeds (the on-chain permit reverts on a stale nonce, surfacing the error there).
  async function _erc2612Nonce(token, owner) {
    try {
      const r = await ethCall(token, '0x' + _selector('nonces(address)') + _word(owner));
      return r && r !== '0x' ? BigInt(r) : 0n;
    } catch { return 0n; }
  }

  // Atomic wrap-and-send the user broadcasts themselves: prove the OP_WRAP_TRANSFER witness (prove-only via
  // the box), then send ConfidentialRouter.wrapAndSettleETH{value} (native) or .wrapAndSettleWithPermit
  // (ERC20, gasless approve) from the wallet's own EVM account — the deposit funds + the recipient note settle
  // in ONE tx, no intermediate spendable note. fee MUST be 0 here (the router's wrap-and-settle gate requires
  // it); a relayed fee-bearing wrap-and-send is a follow-up. Returns the broadcast result + the note records.
  async function wrapAndSend({ walletPriv, amountWei, ticker = 'cETH', recipientPubHex, amount, fee = 0n, index = 0, gasLimit = 1400000n, broadcast = true, waitOpts } = {}) {
    if (!cfg.router) throw new Error('ConfidentialRouter not deployed for this network');
    if (BigInt(fee) !== 0n) throw new Error('wrap-and-send: the user-sent router path is fee-free (fee must be 0); a relayed fee-bearing wrap-and-send is a follow-up');
    const b = buildWrapTransferOp({ walletPriv, amountWei, ticker, recipientPubHex, amount, fee, index });
    // Prove-only: the box returns publicValues + proof for the dapp to embed in the user-sent router tx.
    const proven = await relay.prove(
      { type: 'wraptransfer', op: b.op, leaves: b.leaves, outputs: b.outputs, ephRand: b.ephRand },
      waitOpts,
    );
    const acct = account(walletPriv);
    let value, calldata;
    if (b.meta.native) {
      value = b.amountWei;
      calldata = _router.wrapAndSettleETHCalldata({ commit: b.depositCommit, publicValues: proven.publicValues, proof: proven.proof, memos: b.memos });
    } else {
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
      const permitNonce = await _erc2612Nonce(b.meta.underlying, acct.address);
      const sig = _router.signErc2612({
        token: b.meta.underlying, name: b.meta.permitName || b.meta.ticker, version: b.meta.permitVersion || '1',
        owner: acct.address, value: b.amountWei, nonce: permitNonce, deadline, priv: acct.priv, spender: cfg.router,
      });
      value = 0n;
      calldata = _router.wrapAndSettleWithPermitCalldata({
        token: b.meta.underlying, amount: b.amountWei, commit: b.depositCommit, deadline, v: sig.v, r: sig.r, s: sig.s,
        publicValues: proven.publicValues, proof: proven.proof, memos: b.memos,
      });
    }
    const nonce = BigInt(await rpc('eth_getTransactionCount', [acct.address, 'pending']));
    const tip = 1500000000n;
    const base = BigInt(await rpc('eth_gasPrice', []) || '0x3b9aca00');
    const tx = {
      chainId: BigInt(cfg.chainId), nonce, maxPriorityFeePerGas: tip, maxFeePerGas: base * 2n + tip,
      gasLimit: BigInt(gasLimit), to: cfg.router, value: BigInt(value), data: calldata,
    };
    const signed = evmTx.signEip1559(tx, acct.priv);
    const txHash = broadcast ? await rpc('eth_sendRawTransaction', [signed.raw]) : null;
    return { ...b, from: acct.address, to: cfg.router, value: value.toString(), nonce: nonce.toString(), signedRaw: signed.raw, txHash, jobId: proven.jobId };
  }

  // ── 1-click farm entry (OP_LP_BOND, op 29) ──
  // Add liquidity AND bond the resulting shares into a farm in ONE settle — OP_LP_ADD fused with
  // OP_FARM_BOND. Spends a whole A note + a whole B note (each opening-sigma bound), derives d_shares =
  // lpAddShares, and the guest emits a farm_receipt_leaf + bond directly — the intermediate LP-share note
  // never materializes. The A/B sigmas bind the bond target (controller, owner, nonce) into the same context
  // so a relay can't re-point the bonded liquidity. Mirrors tests/gen-confidential-lpbond-fixture.mjs.
  function buildLpBondOp({ walletPriv, controller, aNote, bNote, feeBps = 30, reserveAPre, reserveBPre, sharesPre, bondNonce, rpsEntry = 0n, opDeadline = 0n, fee = 0n } = {}) {
    if (!aNote || !bNote) throw new Error('lp-bond: need an A note and a B note');
    if (!controller) throw new Error('lp-bond: farm controller address required');
    const id = identity(walletPriv);
    fee = BigInt(fee);
    // Canonical pair order: assetA < assetB (lex over the 32-byte ids); keep each note's reserve with it.
    let nA = aNote, nB = bNote, rA = BigInt(reserveAPre), rB = BigInt(reserveBPre);
    if (BigInt(nA.asset) > BigInt(nB.asset)) { [nA, nB] = [nB, nA]; [rA, rB] = [rB, rA]; }
    const assetA = nA.asset, assetB = nB.asset;
    const dA = BigInt(nA.value), dB = BigInt(nB.value);
    if (fee >= dA) throw new Error('lp-bond: fee >= A contribution');
    const S = BigInt(sharesPre);
    const dShares = pool.lpAddShares(S, dA - fee, dB, rA, rB);
    if (dShares <= 0n) throw new Error('lp-bond: zero derived shares (check the add ratio / reserves)');

    const addr20 = (a) => '0x' + String(a).replace(/^0x/, '').padStart(40, '0').slice(-40);
    const controller32 = '0x' + '00'.repeat(12) + addr20(controller).replace(/^0x/, '');
    const cb = chainBindingHex();
    // ctx binds A,B + the bond target (controller32, bond_nonce, owner) + the deltas incl. DERIVED d_shares.
    const ctx = pool.intentContext('tacit-lp-bond-v1', cb, assetA, assetB,
      [[nA.cx, nA.cy, id.owner], [nB.cx, nB.cy, id.owner], [controller32, bondNonce, id.owner]],
      [dA, dB, dShares, BigInt(opDeadline), fee]);
    const aSig = pool.openingSigma(dA, nA.blinding, ctx, pool.deriveOpeningNonce(nA.blinding, ctx, 'lp-bond-a'));
    const bSig = pool.openingSigma(dB, nB.blinding, ctx, pool.deriveOpeningNonce(nB.blinding, ctx, 'lp-bond-b'));
    if (!pool.verifyOpeningSigma(nA.cx, nA.cy, dA, aSig.R, aSig.z, ctx)) throw new Error('lp-bond: A sigma self-verify failed');
    if (!pool.verifyOpeningSigma(nB.cx, nB.cy, dB, bSig.R, bSig.z, ctx)) throw new Error('lp-bond: B sigma self-verify failed');

    const op = {
      chainBinding: cb, spendRoot: nA.root, controller: addr20(controller), owner: id.owner,
      rpsEntry: String(rpsEntry), bondNonce, assetA, assetB, feeBps: Number(feeBps),
      reserveAPre: rA.toString(), reserveBPre: rB.toString(), sharesPre: S.toString(),
      a: { cx: nA.cx, cy: nA.cy, owner: id.owner, index: Number(nA.leafIndex), path: nA.path, d: dA.toString(), sigR: aSig.R, sigZ: aSig.z },
      b: { cx: nB.cx, cy: nB.cy, owner: id.owner, index: Number(nB.leafIndex), path: nB.path, d: dB.toString(), sigR: bSig.R, sigZ: bSig.z },
      opDeadline: Number(opDeadline), fee: fee.toString(),
    };
    return { op, dShares, assetA, assetB, dA, dB, bondNonce };
  }

  // Build + settle a 1-click farm entry. Reads the pair's live reserves, derives the shares, and submits the
  // OP_LP_BOND witness gaslessly through the relay (no output-note leaves ⇒ no recovery memo, like unwrap; the
  // farm receipt is recovered from controller+nonce+shares). `bondNonce` defaults to a fresh random scalar.
  async function lpBond({ walletPriv, controller, aNote, bNote, feeBps = 30, bondNonce, rpsEntry = 0n, selfRelay = false, waitOpts } = {}) {
    if (!controller) throw new Error('lp-bond: farm controller not configured for this network');
    const res = await poolReserves(routePoolId(aNote.asset, bNote.asset, feeBps));
    if (!res) throw new Error('lp-bond: pool not initialized for this pair / fee tier');
    const nonce = bondNonce || ('0x' + BigInt(randomScalar()).toString(16).padStart(64, '0'));
    const b = buildLpBondOp({
      walletPriv, controller, aNote, bNote, feeBps,
      reserveAPre: res.reserveA, reserveBPre: res.reserveB, sharesPre: res.totalShares,
      bondNonce: nonce, rpsEntry,
    });
    const r = await _dispatch({ type: 'lpbond', spec: { op: b.op, leaves: [], outputs: null, ephRand: null }, sealedMemos: [], selfRelay, walletPriv, waitOpts });
    return { ...r, dShares: b.dShares, bondNonce: nonce, assetA: b.assetA, assetB: b.assetB };
  }

  // ── CDP position set (rebuilt client-side from CdpPositionInserted) ──
  // Position leaves live in a separate tree (cdpRoot) and emit CdpPositionInserted(bytes32 indexed leaf) in
  // insertion order. Rebuild that tree from the logs so a CLOSE/TOPUP can prove membership (the index + path
  // the guest/contract check against cdpPositionRoot). eth_getLogs returns ascending block+logIndex order, so
  // the emit stream IS the insertion order — the leaf's ordinal is its tree index.
  const CDP_POS_TOPIC0 = '0x' + _hex(keccak256(new TextEncoder().encode('CdpPositionInserted(bytes32)')));
  async function cdpPositionTree() {
    const fb = '0x' + Number(cfg.deployBlock || 0).toString(16);
    const logs = await rpc('eth_getLogs', [{ address: cfg.pool, fromBlock: fb, toBlock: 'latest', topics: [CDP_POS_TOPIC0] }]);
    const leaves = (logs || []).map((l) => l.topics[1]); // the indexed leaf
    const tree = new pool.Tree();
    for (const lf of leaves) tree.insert(lf);
    const indexOf = (leafHex) => leaves.findIndex((x) => String(x).toLowerCase() === String(leafHex).toLowerCase());
    return { tree, leaves, root: tree.root(), indexOf, pathFor: (i) => tree.rootAndPath(i) };
  }

  // ── confidential send (note-to-note transfer, OP_TRANSFER) ──
  // Spend N owned notes of one asset → mint a recipient note (sealed to their confidential pubkey so they
  // recover the blinding + spend) + an optional change note back to the sender. The witness is the exact
  // shape the SP1 guest consumes (contracts/sp1/confidential fixtures/transfer_op.json): a real aggregated
  // BP+ range proof + conservation kernel (confidential-transfer.js) over commitments the pool agrees on
  // (commitXY ≡ ct.commit, verified), plus Keccak membership for each spent input. Gasless via the relay.
  const _ct = makeConfidentialTransfer({ keccak256 });
  function buildTransferOp({ walletPriv, notes, recipientPubHex, amount, fee = 0n }) {
    if (!notes || !notes.length) throw new Error('transfer: no input notes');
    const asset = notes[0].asset;
    if (notes.some((n) => n.asset !== asset)) throw new Error('transfer: all inputs must be one asset');
    amount = BigInt(amount); fee = BigInt(fee);
    const total = notes.reduce((s, n) => s + BigInt(n.value), 0n);
    if (amount + fee > total) throw new Error('transfer: amount + fee exceeds input value');
    const change = total - amount - fee;
    const id = identity(walletPriv);
    const recipientOwner = '0x' + String(recipientPubHex).replace(/^0x/, '').slice(2, 66); // pubkey[1:33]

    // Output blindings are fresh; the memo (channel a) carries each opening to its owner.
    const rRecv = randomScalar();
    const txOutputs = [{ value: amount, blinding: rRecv, owner: recipientOwner }];
    let rChange = null;
    if (change > 0n) { rChange = randomScalar(); txOutputs.push({ value: change, blinding: rChange, owner: id.owner }); }

    const t = _ct.buildTransfer({
      inputs: notes.map((n) => ({ value: BigInt(n.value), blinding: BigInt(n.blinding) })),
      outputs: txOutputs,
      assetId: asset,
    });
    if (!_ct.verifyTransfer(t)) throw new Error('transfer: self-verify failed');

    const beHex = (n) => '0x' + n.toString(16).padStart(64, '0');
    const ptHex = (P) => '0x' + _hex(P.toRawBytes(true));
    const xy = (P) => { const a = P.toAffine(); return { cx: beHex(a.x), cy: beHex(a.y) }; };
    const cb = chainBindingHex();
    const spendRoot = notes[0].root;

    const inMeta = notes.map((n, i) => {
      const c = xy(t.inC[i]);
      return { cx: c.cx, cy: c.cy, owner: id.owner, leafIndex: Number(n.leafIndex), path: n.path, secret: n.secret };
    });
    const outOwners = [recipientOwner]; if (change > 0n) outOwners.push(id.owner);
    const outMeta = txOutputs.map((_, j) => ({ ...xy(t.outC[j]), owner: outOwners[j] }));

    const op = {
      chainBinding: cb, spendRoot, asset, owner: id.owner,
      inputs: inMeta, outputs: outMeta,
      rangeProof: '0x' + _hex(t.rangeProof), kernel: { R: ptHex(t.kernel.R), z: beHex(t.kernel.z) },
      fee: fee.toString(),
    };

    // Recovery descriptors: recipient note sealed to THEIR pubkey, change to the sender's.
    const leaves = outMeta.map((m) => pool.leaf(asset, m.cx, m.cy, m.owner));
    const outputs = [{ value: amount.toString(), blinding: beHex(rRecv), secret: id.secret, asset, owner: recipientOwner, cx: outMeta[0].cx, cy: outMeta[0].cy, ownerPub: recipientPubHex }];
    if (change > 0n) outputs.push({ value: change.toString(), blinding: beHex(rChange), secret: id.secret, asset, owner: id.owner, cx: outMeta[1].cx, cy: outMeta[1].cy, ownerPub: id.pubHex });
    const ephRand = () => (BigInt(id.secret) % secp.CURVE.n) || 1n;
    const memos = guard.sealMemosForOutputs({ outputs, ephRand });
    guard.assertOutputsRecoverable({ leaves, outputs, memos });

    return { op, leaves, outputs, memos, ephRand, amount, change, fee, asset };
  }

  // Build + relay-settle a confidential send. recipientPubHex = the recipient's confidential account pubkey.
  async function transfer({ walletPriv, notes, recipientPubHex, amount, fee = 0n, selfRelay = false, waitOpts } = {}) {
    const b = buildTransferOp({ walletPriv, notes, recipientPubHex, amount, fee });
    return _dispatch({
      type: 'transfer', spec: { op: b.op, leaves: b.leaves, outputs: b.outputs, ephRand: b.ephRand },
      sealedMemos: b.memos, selfRelay, walletPriv, waitOpts,
    });
  }

  // Pay a confidential invoice (confidential-invoice.js): wrap public funds to the invoice's commit so the
  // recipient's seed-derived note becomes consumable. Native ETH → payable pool.wrap{value}(assetId, amount,
  // commit); an ERC20 → ConfidentialRouter.wrapWithPermit (gasless approve, requires cfg.router). The payer
  // never learns the recipient's blinding (the commit binds the owner, not msg.sender).
  async function payInvoice({ payerPriv, invoice, gasLimit = 220000n, broadcast = true } = {}) {
    const acct = account(payerPriv);
    const amount = BigInt(invoice.amount);
    const native = String(invoice.underlying).toLowerCase() === '0x0000000000000000000000000000000000000000';
    let to, value, calldata;
    if (native) {
      to = cfg.pool; value = amount;
      calldata = '0x' + _selector('wrap(bytes32,uint256,bytes32)') + _word(invoice.assetId) + _word(amount) + _word(invoice.commit);
    } else {
      if (!cfg.router) throw new Error('ERC20 invoice payment needs the ConfidentialRouter (not deployed)');
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
      const sig = _router.signErc2612({ token: invoice.underlying, name: invoice.ticker, version: '1', owner: acct.address, value: amount, nonce: 0n, deadline, priv: acct.priv, spender: cfg.router });
      to = cfg.router; value = 0n;
      calldata = _router.wrapWithPermitCalldata({ token: invoice.underlying, amount, commit: invoice.commit, deadline, v: sig.v, r: sig.r, s: sig.s });
    }
    const nonce = BigInt(await rpc('eth_getTransactionCount', [acct.address, 'pending']));
    const tip = 1500000000n;
    const base = BigInt(await rpc('eth_gasPrice', []) || '0x3b9aca00');
    const tx = { chainId: BigInt(cfg.chainId), nonce, maxPriorityFeePerGas: tip, maxFeePerGas: base * 2n + tip, gasLimit: BigInt(gasLimit), to, value: BigInt(value), data: calldata };
    const signed = evmTx.signEip1559(tx, acct.priv);
    const txHash = broadcast ? await rpc('eth_sendRawTransaction', [signed.raw]) : null;
    return { from: acct.address, to, amount: amount.toString(), commit: invoice.commit, signedRaw: signed.raw, txHash };
  }

  // ── confidential AMM (route / swap, OP_SWAP_ROUTE) ──
  // The pool's AMM reserves live in the public `pools(bytes32)` mapping, so the dapp reads them with a plain
  // eth_call (no contract change). A confidential swap is a 1-hop route; a multihop route threads up to 4
  // pools, intermediate amounts flowing as private VALUES (only the start input + final output are notes).
  // Gasless via the relay (type 'route'); the trader is protected by minOut, the LPs by each hop's
  // constant-product non-decrease (confidential-route.js mirrors the guest exactly).
  const _route = makeConfidentialRoute({ keccak256, pool });
  // Read a pool's live reserves + fee from the on-chain `pools` mapping. Returns null for an uninitialized
  // pool. reserveA is the LOW asset's reserve (canonical orientation).
  async function poolReserves(poolIdHex) {
    const data = '0x' + _selector('pools(bytes32)') + _word(poolIdHex);
    const res = await ethCall(cfg.pool, data);
    const hex = String(res || '').replace(/^0x/, '');
    if (hex.length < 64 * 7) return null;
    const word = (i) => hex.slice(i * 64, i * 64 + 64);
    const init = BigInt('0x' + word(0)) !== 0n;
    if (!init) return null;
    return {
      init, assetA: '0x' + word(1), assetB: '0x' + word(2),
      reserveA: BigInt('0x' + word(3)), reserveB: BigInt('0x' + word(4)),
      feeBps: Number(BigInt('0x' + word(5))), totalShares: BigInt('0x' + word(6)),
    };
  }
  const routePoolId = (a, b, feeBps) => _route.poolId(a, b, feeBps);

  // Quote a route: walk `path` ([{ assetNext, feeBps }]) from asset0, fetching each hop's live reserves.
  // Returns { amountOut, hops } where hops carry the reserves the route op pins. null if any hop is dead.
  async function quoteRoute({ asset0, amountIn, path, fee = 0n }) {
    let curAsset = asset0, curAmount = BigInt(amountIn) - BigInt(fee);
    const hops = [];
    for (const h of path) {
      const r = await poolReserves(routePoolId(curAsset, h.assetNext, h.feeBps));
      if (!r) return null;
      const curIsLo = BigInt(curAsset) <= BigInt(h.assetNext);
      const rIn = curIsLo ? r.reserveA : r.reserveB;
      const rOut = curIsLo ? r.reserveB : r.reserveA;
      const out = _route.getAmountOut(curAmount, rIn, rOut, h.feeBps);
      hops.push({ assetNext: h.assetNext, feeBps: h.feeBps, reserveAPre: r.reserveA, reserveBPre: r.reserveB });
      curAsset = h.assetNext; curAmount = out;
    }
    return { amountOut: curAmount, assetFinal: curAsset, hops };
  }

  // Build + relay-settle a confidential route (a 1-hop path is a plain swap). `inNote` is a recovered note.
  async function route({ walletPriv, inNote, amountIn, path, minOut, fee = 0n, selfRelay = false, waitOpts } = {}) {
    const q = await quoteRoute({ asset0: inNote.asset, amountIn, path, fee });
    if (!q) throw new Error('route: a hop pool is not initialized');
    const id = identity(walletPriv);
    const rOut = randomScalar();
    const op = _route.buildRoute({
      asset0: inNote.asset, chainBinding: chainBindingHex(), inNote, amountIn: BigInt(amountIn),
      rIn: BigInt(inNote.blinding), hops: q.hops, minOut: BigInt(minOut), outOwner: id.owner, rOut,
      deadline: 0n, fee: BigInt(fee),
    });
    const beHex = (n) => '0x' + n.toString(16).padStart(64, '0');
    const leaf = pool.leaf(q.assetFinal, op.out.cx, op.out.cy, id.owner);
    const outputs = [{ value: q.amountOut.toString(), blinding: beHex(rOut), secret: id.secret, asset: q.assetFinal, owner: id.owner, cx: op.out.cx, cy: op.out.cy, ownerPub: id.pubHex }];
    const ephRand = () => (BigInt(id.secret) % secp.CURVE.n) || 1n;
    const sealedMemos = guard.sealMemosForOutputs({ outputs, ephRand });
    return _dispatch({ type: 'route', spec: { op, leaves: [leaf], outputs, ephRand }, sealedMemos, selfRelay, walletPriv, waitOpts });
  }

  // Self-settle a box-proven op (ConfidentialPool.settle) from the caller's own EVM account. Used by the CDP
  // liquidation keeper: a liquidation has no relay fee, so the keeper box-PROVES (relay prove mode) then
  // submits settle itself (it's gas-funded + the seized-basket recipient). `memos` is [] for a fee-less
  // liquidation (no minted note leaves). publicValues + proof come from the relay prove result.
  async function submitSettle({ settlerPriv, publicValues, proof, memos = [], gasLimit = 1200000n, broadcast = true } = {}) {
    const acct = account(settlerPriv);
    const pv = String(publicValues).startsWith('0x') ? publicValues : '0x' + publicValues;
    const pf = String(proof).startsWith('0x') ? proof : '0x' + proof;
    // settle(bytes publicValues, bytes proof, bytes[] memos) — ABI-encode the three dynamic args.
    const strip0x = (h) => String(h).replace(/^0x/, '');
    const enc = (hex) => { const b = strip0x(hex); const len = (b.length / 2); const padded = b + '0'.repeat((64 - (b.length % 64)) % 64); return { len, padded }; };
    const word = (n) => BigInt(n).toString(16).padStart(64, '0');
    const a = enc(pv), b = enc(pf);
    // heads: 3 offsets (pv, proof, memos). pv at 0x60; proof after pv; memos after proof.
    const pvBlock = word(a.len) + a.padded;
    const pfBlock = word(b.len) + b.padded;
    const memosOffWords = 3; // 3 head words
    const offPv = 0x60;
    const offPf = offPv + 32 + a.padded.length / 2;
    const offMemos = offPf + 32 + b.padded.length / 2;
    const memosBlock = memos.length === 0 ? word(0) : (() => { // count + offsets + each (len+data)
      let head = word(memos.length), body = '', cursor = memos.length * 32;
      for (const m of memos) { const e = enc(m); head += word(cursor); body += word(e.len) + e.padded; cursor += 32 + e.padded.length / 2; }
      return head + body;
    })();
    const data = '0x' + _selector('settle(bytes,bytes,bytes[])')
      + word(offPv) + word(offPf) + word(offMemos) + pvBlock + pfBlock + memosBlock;
    const nonce = BigInt(await rpc('eth_getTransactionCount', [acct.address, 'pending']));
    const tip = 1500000000n;
    const base = BigInt(await rpc('eth_gasPrice', []) || '0x3b9aca00');
    const tx = { chainId: BigInt(cfg.chainId), nonce, maxPriorityFeePerGas: tip, maxFeePerGas: base * 2n + tip, gasLimit: BigInt(gasLimit), to: cfg.pool, value: 0n, data };
    const signed = evmTx.signEip1559(tx, acct.priv);
    const txHash = broadcast ? await rpc('eth_sendRawTransaction', [signed.raw]) : null;
    return { from: acct.address, txHash, signedRaw: signed.raw };
  }

  // Dispatch a built leaf-bearing op: relay-settle (default) or, when `selfRelay`, box-PROVE (fee-less) and
  // broadcast settle() from the caller's own EOA. Self-relay needs no live relayer (useful while relayers are
  // still being provisioned / when one is down) at the cost of revealing the user's EOA as msg.sender. The box
  // re-seals memos deterministically from the op's outputs+ephRand, so `sealedMemos` (the build's own memos)
  // matches what was proven and is what settle() emits for recovery.
  async function _dispatch({ type, spec, sealedMemos, selfRelay, walletPriv, waitOpts }) {
    if (!selfRelay) return relay.settle({ type, ...spec }, waitOpts);
    const proven = await relay.prove({ type, ...spec }, waitOpts);
    return submitSettle({ settlerPriv: walletPriv, publicValues: proven.publicValues, proof: proven.proof, memos: sealedMemos });
  }

  // ── gasless exit (0xbow-style relayed unwrap) ──
  // The user spends a shielded note; the relay box settles ConfidentialPool.settle() on-chain (pays the
  // gas) and is paid `fee` out of the note value as `pv.fees → msg.sender`, so the user RECEIVES
  // value−fee and signs NOTHING on-chain — a true gasless exit. The fee is in the withdrawn asset's
  // in-system units: max(minFee, ceil(feeBps/1e4 · value)). A user holding gas can self-settle (fee = 0
  // and broadcast settle themselves). The guest's OP_UNWRAP splits value → withdrawal(value−fee) +
  // fee, both public legs summing to the proven value (no separate fee proof).
  const RELAY_FEE_BPS = 30n;                                 // 0.30% of the exit
  // Per-ticker settle-gas floor expressed in the UNDERLYING (wei) unit, so it is scale-independent. The
  // in-system floor = wei ÷ unitScale (e.g. cETH 1e14 wei = 0.0001 ETH → 1e4 in-system at scale 1e10, or
  // 1e14 at scale 1). Expressing it in wei is what keeps the floor correct across the cETH scale boundary.
  const RELAY_MIN_FEE_WEI = { cETH: 100000000000000n };
  const _unitScaleOf = (ticker) => BigInt((assetByTicker[ticker] && assetByTicker[ticker].unitScale) || '1');
  // The relay floor in IN-SYSTEM units for `ticker` (0 if none configured).
  function relayMinFee(ticker) {
    const wei = RELAY_MIN_FEE_WEI[ticker];
    return wei == null ? 0n : wei / _unitScaleOf(ticker);
  }

  // CHAIN_BINDING == keccak256(abi.encodePacked(uint256 chainid, address(pool))) — the same value the
  // contract stamps; the guest must commit it so a proof is bound to this deployment.
  function chainBindingHex() {
    const cid = BigInt(cfg.chainId).toString(16).padStart(64, '0');
    const addr = cfg.pool.replace(/^0x/, '').toLowerCase().padStart(40, '0');
    const bytes = Uint8Array.from(((cid + addr).match(/../g) || []).map((h) => parseInt(h, 16)));
    return '0x' + _hex(keccak256(bytes));
  }

  // Quote the relay fee for exiting a note of `value` (in-system units). { fee, net, value }.
  function quoteUnwrapFee(value, ticker = 'cETH', { feeBps = RELAY_FEE_BPS, minFee } = {}) {
    const v = BigInt(value);
    const floor = minFee != null ? BigInt(minFee) : relayMinFee(ticker);
    const pct = (v * BigInt(feeBps) + 9999n) / 10000n; // ceil
    let fee = pct > floor ? pct : floor;
    if (fee > v) fee = v; // never a negative payout; net ≤ 0 ⇒ the note is too small to relay
    return { fee, net: v - fee, value: v };
  }

  // Build the OP_UNWRAP witness for a relayed exit. `note` is a recovered note from balance().notes
  // (it carries the membership path + root). Returns { op, fee, net, recipient, ticker } — submit `op`
  // to the relay as type 'unwrap'. recipient defaults to the user's own EVM account.
  // `selfSettle: true` builds a NO-FEE exit (fee = 0, full value to the recipient) — the original
  // OP_UNWRAP behavior, for a user who settles on-chain themselves (pays their own gas). It also lets a
  // dust note (too small to relay) still exit. Otherwise the relay fee is quoted and deducted.
  function buildUnwrap({ note, walletPriv, recipient, feeOpts, selfSettle = false, ttlSecs = 3600 } = {}) {
    if (!note) throw new Error('buildUnwrap: note required');
    const ticker = tickerOf(note.asset) || 'cETH';
    let fee, net;
    if (selfSettle) {
      fee = 0n; net = BigInt(note.value);
    } else {
      ({ fee, net } = quoteUnwrapFee(note.value, ticker, feeOpts || {}));
      if (net <= 0n) throw new Error('note too small for a gasless exit (relay fee ≥ value); self-settle instead');
    }
    const to = (recipient || account(walletPriv).address).toLowerCase();
    const cb = chainBindingHex();
    // Opening sigma (NOT the raw blinding): bind the spend to (recipient, value, fee) so the relay box
    // verifies the note opening WITHOUT learning r and can neither redirect the withdrawal nor pad the
    // fee (the swap/LP trustless-settler pattern). The 20-byte recipient binds in the asset_b slot; the
    // nonce is derived per (r, context) so a relay rebuild/re-quote never reuses one. `blinding` is
    // NEVER put in the op — the box only gets the sigma.
    const recip32 = '0x' + '0'.repeat(24) + to.replace(/^0x/, '');
    // Per-op expiry, bound in the opening sigma so the relay box can't submit this exit past it (nor
    // forge/stretch it). The contract gates block.timestamp <= the batch min_deadline. 0 = no expiry.
    const deadline = ttlSecs > 0 ? BigInt(Math.floor(Date.now() / 1000) + ttlSecs) : 0n;
    const ctx = pool.intentContext('tacit-unwrap-intent-v1', cb, note.asset, recip32,
      [[note.cx, note.cy, note.owner]], [BigInt(note.value), fee, deadline]);
    const nonce = pool.deriveOpeningNonce(note.blinding, ctx, 'unwrap');
    const sig = pool.openingSigma(BigInt(note.value), note.blinding, ctx, nonce);
    const op = {
      chainBinding: cb,
      spendRoot: note.root,
      asset: note.asset,
      cx: note.cx, cy: note.cy, owner: note.owner,
      leafIndex: Number(note.leafIndex),
      path: note.path,
      secret: note.secret,
      value: String(note.value),
      recipient: to,
      fee: fee.toString(),
      deadline: deadline.toString(),
      sigR: sig.R, sigZ: sig.z,
    };
    return { op, fee, net, recipient: to, asset: note.asset, ticker, selfSettle };
  }

  // OP_ATTEST_META witness. The worker supplies the block data from one canonical block fetch; the box
  // authenticates the etch's witness envelope through BIP141 before using its ticker/decimals/CID.
  function buildAttestMeta({ etchTx, etchIndex, etchWtxidSiblings, etchCoinbase,
    etchCoinbaseTxidSiblings, etchBlockRoot, note } = {}) {
    if (!note?.path || note.root == null) throw new Error('buildAttestMeta: funded note membership required');
    if (!Array.isArray(etchWtxidSiblings) || !Array.isArray(etchCoinbaseTxidSiblings)) {
      throw new Error('buildAttestMeta: BIP141 paths required');
    }
    return {
      etchTx, etchIndex: Number(etchIndex), etchWtxidSiblings, etchCoinbase,
      etchCoinbaseTxidSiblings, etchBlockRoot,
      cx: note.cx, cy: note.cy, owner: note.owner, leafIndex: Number(note.leafIndex),
      path: note.path, poolRoot: note.root,
    };
  }

  // Submit a gasless exit to the relay (no user tx) and, by default, block until it settles on-chain.
  // The box collects `fee`; the user receives `net`. Returns the build + { jobId, status, txHash }.
  async function unwrap({ note, walletPriv, recipient, feeOpts, wait = true, waitOpts } = {}) {
    const built = buildUnwrap({ note, walletPriv, recipient, feeOpts });
    const sub = await relay.submitOp({ type: 'unwrap', op: built.op, memos: [] }); // no new leaf ⇒ no memo
    if (!wait) return { ...built, jobId: sub.jobId, status: sub.status };
    const st = await relay.waitForSettle(sub.jobId, waitOpts);
    return { ...built, jobId: sub.jobId, status: st.status, txHash: st.txHash };
  }

  return { cfg, assets: _poolAssets, assetByTicker, account, identity, rpc, ethCall, fetchEvents, balance, tickerOf,
    buildWrap, wrap, buildRouterWrap, routerWrap, routerConfigured, buildWrapTransferOp, wrapAndSend, buildTransferOp, transfer, payInvoice, quoteUnwrapFee, buildUnwrap, unwrap, buildAttestMeta, chainBindingHex,
    poolReserves, routePoolId, quoteRoute, route, buildLpBondOp, lpBond, cdpPositionTree, submitSettle,
    relay, indexer, evmLog, evmTx, pool, memo, router: _router };
}
