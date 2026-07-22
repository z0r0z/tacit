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
import { makeConfidentialLp } from './confidential-lp.js';
import { makeConfidentialCdp } from './confidential-cdp.js';
import { makeConfidentialFarm } from './confidential-farm.js';
import { makeConfidentialDefiActions } from './confidential-defi-actions.js';
import { makeConfidentialStealth } from './confidential-stealth.js';
import { signSchnorr, SECP_N } from './bulletproofs.js';
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
  // Public RPCs cap eth_getLogs by block range (and reject a full deploy-block→head span with "Internal
  // error"/400), so the scan walks fixed windows and concatenates. Chain order is preserved (ascending
  // windows, and each window's logs are already block+logIndex ordered).
  const LOG_WINDOW = 2000;
  async function getLogsChunked(params, from, to) {
    const out = [];
    for (let start = from; start <= to; start += LOG_WINDOW) {
      const end = Math.min(start + LOG_WINDOW - 1, to);
      const logs = await rpc('eth_getLogs', [{ ...params, fromBlock: '0x' + start.toString(16), toBlock: '0x' + end.toString(16) }]);
      if (logs && logs.length) out.push(...logs);
    }
    return out;
  }
  async function headBlock() { return parseInt(await rpc('eth_blockNumber', []), 16); }
  async function fetchEvents({ fromBlock = cfg.deployBlock, toBlock = 'latest' } = {}) {
    const from = typeof fromBlock === 'number' ? fromBlock : parseInt(String(fromBlock), 16);
    const to = toBlock === 'latest' ? await headBlock() : (typeof toBlock === 'number' ? toBlock : parseInt(String(toBlock), 16));
    const logs = await getLogsChunked(
      { address: cfg.pool, topics: [[evmLog.TOPIC0.LeavesInserted, evmLog.TOPIC0.NullifiersSpent]] },
      from, to);
    return evmLog.decodeLogs(logs);
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
    const a = cfg.assets.find((x) =>
      (x.assetId && x.assetId.toLowerCase() === id)
      || (x.bitcoinLink && x.bitcoinLink.toLowerCase() === id));
    return a ? a.ticker : null;
  }

  // ── wrap on-ramp ──
  const evmTx = makeEvmTx({ secp, keccak256 });
  const pool = indexer._pool;   // commitXY / deriveNote / leaf / depositId
  const _lp = makeConfidentialLp({ keccak256, pool }); // plain OP_LP_ADD assembler (poolId/lpShareId == pool.evm*)
  // CDP + cBTC + farm action layer (the ETH-side settle for cUSD/cBTC/farm ops). The cBTC ① lock (Taproot
  // commit/reveal) is a separate BTC-wallet driver (cbtc-lock.js); this exposes ③ mintCbtc (+ CDP/farm).
  const _cdp = makeConfidentialCdp({ keccak256, pool, signSchnorr });
  const _farm = makeConfidentialFarm({ keccak256, pool });
  const defiActions = (walletPriv) => makeConfidentialDefiActions({ pool, cdp: _cdp, farm: _farm, relay, id: identity(walletPriv), chainBindingHex, secp });
  // ③ Mint a cBTC.zk bearer note against a reflection-recorded self-custody lock. outpoint = the lock's
  // 32-byte outpoint (lockTxid‖lockVout), vBtc = locked sats, blinding = the note's recoverable blinding.
  async function mintCbtc({ walletPriv, outpoint, vBtc, blinding, waitOpts } = {}) {
    return defiActions(walletPriv).mintCbtc({ outpoint, vBtc: BigInt(vBtc), blinding, waitOpts });
  }
  // `memo` + `guard` are defined above (shared with the relay chokepoint). Wrap is the reference integration:
  // build outputs[] descriptors → guard.sealMemosForOutputs → guard.assertOutputsRecoverable before submit.

  const _hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  const _word = (v) => (typeof v === 'bigint' ? v.toString(16) : String(v).replace(/^0x/, '')).padStart(64, '0');
  // Recompute the pool root from (leaf, index, path), mirroring the guest's keccak_merkle_verify and
  // Tree.rootAndPath: sibling on the right when the index bit is 0, on the left when 1. A note whose
  // path/root/leafIndex don't reconstruct spendRoot fails guest membership (opaque "simulation failed"
  // on the network prover) — verify it here so a bad witness fails fast with a precise cause.
  const _b32b = (h) => { const s = String(h).replace(/^0x/, '').padStart(64, '0'); const o = new Uint8Array(32); for (let i = 0; i < 32; i++) o[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16); return o; };
  // The guest reads each field as a fixed-width byte vector (r32 / r33) and panics `witness field length`
  // on any other size — which the network prover only surfaces as the opaque "Program simulation failed".
  // A note field can arrive leading-zero-stripped (pool.leaf pads it, so membership still matches on-chain),
  // yet the raw op field would be short and crash the guest. Normalize to exact 32-byte width (the canonical
  // form the leaf + contract already use); throw only if it's LONGER than 32 or non-hex (a real corruption).
  const _pad32 = (h, what) => { const s = String(h == null ? '' : h).replace(/^0x/, ''); if (/[^0-9a-fA-F]/.test(s) || s.length > 64) throw new Error(`transfer: ${what} not a ≤32-byte hex value (${h})`); return '0x' + s.padStart(64, '0'); };
  const _rootFromPath = (leafHex, index, path) => {
    let h = _b32b(leafHex);
    for (let i = 0; i < path.length; i++) {
      const sib = _b32b(path[i]);
      const pair = new Uint8Array(64);
      if (((index >>> i) & 1) === 0) { pair.set(h, 0); pair.set(sib, 32); } else { pair.set(sib, 0); pair.set(h, 32); }
      h = keccak256(pair);
    }
    return '0x' + _hex(h);
  };
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
      note, leaf, depositId, commit, memo: memoHex, memos, outputs, ephRand,
      // the OP_WRAP witness the exec-wrap prover settles (consumes the deposit → mints the note leaf).
      wrapOp: { chainBinding: cb, asset: meta.assetId, value: value.toString(), cx, cy, owner: id.owner,
        sigR: wrapSig.R, sigZ: wrapSig.z },
      to: cfg.pool, amount: amount.toString(), calldata,
      wrapArgs: { assetId: meta.assetId, amount: amount.toString(), commit },
    };
  }

  // Settle a wrap DEPOSIT into its note: submit the OP_WRAP witness to the relay (type 'wrap' → exec-wrap
  // prover), which proves + calls settle(), consuming the on-chain deposit and emitting the note leaf. The
  // deposit tx (pool.wrap()) MUST already be mined — the guest checks the deposit is registered. Pass the
  // object returned by buildWrap.
  async function submitWrapSettle({ built, waitOpts } = {}) {
    if (!built || !built.wrapOp) throw new Error('submitWrapSettle: pass the buildWrap() result');
    const sub = await relay.submitOp({ type: 'wrap', op: built.wrapOp, leaves: [built.leaf], outputs: built.outputs, ephRand: built.ephRand, mode: 'settle' });
    if (sub.status === 'settled') return { jobId: sub.jobId, ...sub };
    return relay.waitForSettle(sub.jobId, waitOpts);
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
  // Wrap-permit strategy per token: 'native' (ETH → wrapETH{value}); 'eip2612' (token has EIP-2612 permit —
  // USDC, our canonical bridged 'Tacit Token' ERC20s — single-tx gasless approval); 'permit2' (no EIP-2612,
  // e.g. USDT — route through the Uniswap Permit2 singleton: one-time ERC20 approval of Permit2, then a
  // per-wrap signature). Explicit `meta.permitType` wins; otherwise a permit name implies EIP-2612.
  function wrapPermitType(meta) {
    if (meta.native) return 'native';
    if (meta.permitType) return meta.permitType;
    return meta.permitName ? 'eip2612' : 'permit2';
  }

  // Permit2 state for (owner, token): the AllowanceTransfer nonce (bound into the wrap signature) and the
  // token's current ERC20 allowance to the Permit2 singleton (the one-time approve Permit2 wraps depend on).
  async function _permit2State(token, owner) {
    const p2 = _router.PERMIT2_ADDRESS;
    let nonce = 0n, approved = 0n;
    try {
      // Permit2.allowance(owner, token, spender=router) → (uint160 amount, uint48 expiration, uint48 nonce)
      const r = await ethCall(p2, '0x' + _selector('allowance(address,address,address)') + _word(owner) + _word(token) + _word(cfg.router));
      const h = String(r || '').replace(/^0x/, '');
      if (h.length >= 3 * 64) nonce = BigInt('0x' + h.slice(128, 192));
    } catch {}
    try {
      const a = await ethCall(token, '0x' + _selector('allowance(address,address)') + _word(owner) + _word(p2));
      approved = a && a !== '0x' ? BigInt(a) : 0n;
    } catch {}
    return { nonce, approved, permit2: p2 };
  }

  // Build a one-tx router wrap, picking the right gasless-approval path for the token. Async because the
  // permit paths read on-chain nonces (EIP-2612 permit nonce / Permit2 allowance nonce). For a permit2 token
  // whose Permit2 approval is missing, returns `{ needsPermit2Approval }` instead of calldata so the caller
  // (routerWrap) broadcasts the one-time approval first, then rebuilds.
  async function buildRouterWrap({ walletPriv, amountWei, ticker = 'cETH', index = 0, permitDeadline } = {}) {
    if (!cfg.router) throw new Error('ConfidentialRouter not deployed for this network');
    const w = buildWrap({ walletPriv, amountWei, ticker, index });
    const meta = assetByTicker[ticker];
    const acct = account(walletPriv);
    const deadline = BigInt(permitDeadline ?? (Math.floor(Date.now() / 1000) + 3600));
    const kind = wrapPermitType(meta);

    if (kind === 'native') {
      const b = _router.buildWrapETH({ commit: w.commit, amount: w.amount });
      return { ...w, to: b.to, value: b.value.toString(), calldata: b.calldata, via: 'router', permitType: 'native' };
    }
    if (kind === 'eip2612') {
      const tokenNonce = await _erc2612Nonce(meta.underlying, acct.address);
      const b = _router.buildWrapWithPermit({ priv: acct.priv, owner: acct.address, token: meta.underlying,
        name: meta.permitName || meta.ticker, version: meta.permitVersion || '1', amount: w.amount, commit: w.commit, tokenNonce, deadline });
      return { ...w, to: b.to, value: '0', calldata: b.calldata, via: 'router', permitType: 'eip2612' };
    }
    // permit2 — needs a one-time ERC20 approval of the Permit2 singleton.
    const st = await _permit2State(meta.underlying, acct.address);
    if (st.approved < BigInt(w.amount)) {
      return { ...w, to: cfg.router, value: '0', via: 'router', permitType: 'permit2',
        needsPermit2Approval: { token: meta.underlying, spender: st.permit2, amount: w.amount } };
    }
    const b = _router.buildWrapWithPermit2({ priv: acct.priv, token: meta.underlying, amount: w.amount, commit: w.commit,
      permit2Nonce: st.nonce, expiration: Number(deadline), sigDeadline: deadline });
    return { ...w, to: b.to, value: '0', calldata: b.calldata, via: 'router', permitType: 'permit2' };
  }

  // True when the ConfidentialRouter is deployed for this network — the gate the unified-send dispatch and
  // the UI use to prefer router batching (single-tx wrap, and the atomic wrap-and-settle seam) over the
  // two-step pool.wrap + relayed transfer.
  function routerConfigured() { return !!cfg.router; }

  // Sign + broadcast a router wrap (one tx). Mirrors wrap() but targets cfg.router.
  // Sign + (optionally) broadcast one EIP-1559 tx. Reads the pending nonce unless one is supplied.
  async function _sendEvmTx({ acct, to, value = 0n, data, gasLimit, nonce, send = true }) {
    const n = nonce != null ? BigInt(nonce) : BigInt(await rpc('eth_getTransactionCount', [acct.address, 'pending']));
    const tip = 1500000000n;
    const base = BigInt(await rpc('eth_gasPrice', []) || '0x3b9aca00');
    const tx = { chainId: BigInt(cfg.chainId), nonce: n, maxPriorityFeePerGas: tip, maxFeePerGas: base * 2n + tip,
      gasLimit: BigInt(gasLimit), to, value: BigInt(value), data };
    const signed = evmTx.signEip1559(tx, acct.priv);
    const txHash = send ? await rpc('eth_sendRawTransaction', [signed.raw]) : null;
    return { txHash, nonce: n, signedRaw: signed.raw };
  }
  async function _waitReceipt(txHash, tries = 60) {
    for (let i = 0; i < tries; i++) {
      const r = await rpc('eth_getTransactionReceipt', [txHash]);
      if (r && r.blockNumber) return r;
      await new Promise((res) => setTimeout(res, 3000));
    }
    throw new Error(`receipt timeout ${txHash}`);
  }

  async function routerWrap({ walletPriv, amountWei, ticker = 'cETH', index = 0, gasLimit = 300000n, broadcast = true } = {}) {
    const acct = account(walletPriv);
    let w = await buildRouterWrap({ walletPriv, amountWei, ticker, index });
    // Permit2 token with no Permit2 approval yet → broadcast the one-time ERC20 approve, then rebuild the wrap.
    if (w.needsPermit2Approval) {
      if (!broadcast) throw new Error('Permit2 not approved for this token — approve the Permit2 singleton once, then wrap');
      const { token, spender } = w.needsPermit2Approval;
      const approveData = '0x' + _selector('approve(address,uint256)') + _word(spender) + _word(2n ** 256n - 1n);
      const ap = await _sendEvmTx({ acct, to: token, data: approveData, gasLimit: 80000n });
      await _waitReceipt(ap.txHash);
      w = await buildRouterWrap({ walletPriv, amountWei, ticker, index });
      if (w.needsPermit2Approval) throw new Error('Permit2 approval did not take effect');
    }
    const sent = await _sendEvmTx({ acct, to: w.to, value: BigInt(w.value), data: w.calldata, gasLimit, send: broadcast });
    return { ...w, from: acct.address, nonce: sent.nonce.toString(), signedRaw: sent.signedRaw, txHash: sent.txHash };
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
  // in ONE tx, no intermediate spendable note. The proof-bound `fee` stays 0 (user pays their own gas); the
  // self-sustaining wrap fee is a separate ETH skim (`ethFeeWei`) the router forwards to `feeRecipient`
  // (msg.value − wrapAmount for native; msg.value for ERC20). Set ethFeeWei=0 to run wrap as a loss-leader.
  async function wrapAndSend({ walletPriv, amountWei, ticker = 'cETH', recipientPubHex, amount, fee = 0n, ethFeeWei = 0n, feeRecipient, index = 0, gasLimit = 1400000n, broadcast = true, permit = null, waitOpts, onBuilt } = {}) {
    if (!cfg.router) throw new Error('ConfidentialRouter not deployed for this network');
    if (BigInt(fee) !== 0n) throw new Error('wrap-and-send: the proof-bound fee must be 0 on the user-sent path (use ethFeeWei for the wrap fee)');
    ethFeeWei = BigInt(ethFeeWei || 0n);
    const skimTo = ethFeeWei > 0n ? (feeRecipient || cfg.relayFeeRecipient) : (feeRecipient || '0x0000000000000000000000000000000000000000');
    if (ethFeeWei > 0n && (!skimTo || /^0x0+$/i.test(skimTo))) throw new Error('wrap-and-send: ethFeeWei set but no feeRecipient');
    const b = buildWrapTransferOp({ walletPriv, amountWei, ticker, recipientPubHex, amount, fee, index });
    // buildWrapTransferOp uses fresh random output blindings, so the sealed memos are NON-deterministic. Surface
    // the exact memos+commit the proof will commit to BEFORE proving, so a caller can persist them and later
    // settle (or resume) with these same bytes — rebuilding would produce different memos → MemoLeafMismatch.
    onBuilt?.({ memos: b.memos, depositCommit: b.depositCommit, wrapAmount: b.amountWei.toString(), native: !!b.meta.native });
    // Prove-only: the box returns publicValues + proof for the dapp to embed in the user-sent router tx.
    const proven = await relay.prove(
      { type: 'wraptransfer', op: b.op, leaves: b.leaves, outputs: b.outputs, ephRand: b.ephRand },
      waitOpts,
    );
    const acct = account(walletPriv);
    let value, calldata;
    if (b.meta.native) {
      value = b.amountWei + ethFeeWei; // wrapAmount + fee; router skims (msg.value − wrapAmount) to feeRecipient
      calldata = _router.wrapAndSettleETHCalldata({ wrapAmount: b.amountWei, commit: b.depositCommit, publicValues: proven.publicValues, proof: proven.proof, memos: b.memos, feeRecipient: skimTo });
    } else {
      // `permit` lets the CALLER supply a signature from a wallet we don't hold the key for — that is what
      // makes an external-wallet ERC20 wrap possible at all, since the permit must be signed by whoever holds
      // the tokens. Without one, fall back to the derived account signing for its own balance.
      let deadline, sig;
      if (permit) {
        ({ deadline } = permit);
        deadline = BigInt(deadline);
        sig = { v: permit.v, r: permit.r, s: permit.s };
      } else {
        deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
        const permitNonce = await _erc2612Nonce(b.meta.underlying, acct.address);
        sig = _router.signErc2612({
          token: b.meta.underlying, name: b.meta.permitName || b.meta.ticker, version: b.meta.permitVersion || '1',
          owner: acct.address, value: b.amountWei, nonce: permitNonce, deadline, priv: acct.priv, spender: cfg.router,
        });
      }
      value = ethFeeWei; // ERC20 wrap: the token is pulled via permit; msg.value IS the ETH fee skim
      calldata = _router.wrapAndSettleWithPermitCalldata({
        token: b.meta.underlying, amount: b.amountWei, commit: b.depositCommit, deadline, v: sig.v, r: sig.r, s: sig.s,
        publicValues: proven.publicValues, proof: proven.proof, memos: b.memos, feeRecipient: skimTo,
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
    // calldata + value are exposed so a caller can instead broadcast this router tx from an external wallet
    // (e.g. fund the wrap from MetaMask/Rabby): the note owner is bound in the proof, not the sender.
    return { ...b, from: acct.address, to: cfg.router, value: value.toString(), calldata, nonce: nonce.toString(), signedRaw: signed.raw, txHash, jobId: proven.jobId };
  }

  // Resume an atomic wrap-and-send whose prove-only job was submitted earlier (e.g. the client wait timed out
  // while the proof kept generating server-side). Fetches the finished proof by jobId and re-assembles the
  // router tx from the EXACT memos+commit the proof committed to — which the caller captured via wrapAndSend's
  // onBuilt and MUST supply here. Rebuilding is impossible: the output blindings are random, so a rebuilt op
  // would carry different memos → MemoLeafMismatch on settle. Native ETH only. broadcast defaults off.
  async function resumeWrapAndSend({ jobId, memos, depositCommit, wrapAmount, ethFeeWei = 0n, feeRecipient, gasLimit = 1400000n, waitOpts } = {}) {
    if (!cfg.router) throw new Error('ConfidentialRouter not deployed for this network');
    if (!jobId) throw new Error('resume: jobId required');
    if (!Array.isArray(memos) || !memos.length || !depositCommit || wrapAmount == null) {
      throw new Error('resume: memos + depositCommit + wrapAmount required (captured at prove time via onBuilt)');
    }
    ethFeeWei = BigInt(ethFeeWei || 0n);
    const skimTo = ethFeeWei > 0n ? (feeRecipient || cfg.relayFeeRecipient) : (feeRecipient || '0x0000000000000000000000000000000000000000');
    const proven = await relay.waitForProof(jobId, waitOpts); // the proof is (or soon will be) ready server-side
    if (!proven.publicValues || !proven.proof) throw new Error('resume: relay returned no proof for this job');
    const value = BigInt(wrapAmount) + ethFeeWei;
    const calldata = _router.wrapAndSettleETHCalldata({ wrapAmount: BigInt(wrapAmount), commit: depositCommit, publicValues: proven.publicValues, proof: proven.proof, memos, feeRecipient: skimTo });
    return { to: cfg.router, value: value.toString(), calldata, gasLimit: gasLimit.toString(), jobId, depositCommit };
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
    const pid = pool.evmPoolId(assetA, assetB, feeBps), lpAsset = pool.evmLpShareId(pid); // bind pool identity
    const ctx = pool.intentContext('tacit-lp-bond-v1', cb, assetA, assetB,
      [[nA.cx, nA.cy, id.owner], [nB.cx, nB.cy, id.owner], [controller32, bondNonce, id.owner], [lpAsset, pid, id.owner]],
      [dA, dB, dShares, BigInt(opDeadline), fee, (BigInt(rpsEntry) >> 64n), (BigInt(rpsEntry) & ((1n << 64n) - 1n))]);
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

  // Plain confidential LP add / pool init (OP_LP_ADD) — the DEFAULT liquidity path (farm bonding via lpBond is
  // the optional variant when a FarmController is configured). Spends an A note + a B note, mints a recoverable
  // LP-share note back to the provider (sealed like a transfer output), and settles through the relay (type
  // 'lp'). First mint (empty pool, sharesPre==0) sets the price; later adds use the off-ratio-safe min rule.
  // poolId/lpShareId are byte-identical to pool.evmPoolId/evmLpShareId (verified), so this targets the same
  // pool swaps trade against. The witness is produced by the canonical assembler (confidential-lp.buildAdd).
  async function lpAdd({ walletPriv, aNote, bNote, feeBps = 30, fee = 0n, deadline = 0n, selfRelay = false, waitOpts } = {}) {
    if (!aNote || !bNote) throw new Error('lp-add: need an A note and a B note');
    if (BigInt(aNote.asset) === BigInt(bNote.asset)) throw new Error('lp-add: A and B must be different assets');
    const id = identity(walletPriv);
    let nA = aNote, nB = bNote;
    if (BigInt(nA.asset) > BigInt(nB.asset)) { [nA, nB] = [nB, nA]; } // canonical pair order (assetA < assetB)
    const assetA = nA.asset, assetB = nB.asset;
    const res = await poolReserves(routePoolId(assetA, assetB, feeBps));
    const reserveAPre = res ? BigInt(res.reserveA) : 0n;
    const reserveBPre = res ? BigInt(res.reserveB) : 0n;
    const sharesPre = res ? BigInt(res.totalShares) : 0n;
    const rShares = randomScalar();
    const noteRef = (n) => ({ owner: id.owner, leafIndex: Number(n.leafIndex), path: n.path });
    const op = _lp.buildAdd({
      assetA, assetB, chainBinding: chainBindingHex(), feeBps,
      reserveAPre, reserveBPre, sharesPre,
      aNote: noteRef(nA), bNote: noteRef(nB),
      dA: BigInt(nA.value), dB: BigInt(nB.value),
      rA: BigInt(nA.blinding), rB: BigInt(nB.blinding),
      shareOwner: id.owner, rShares, deadline, fee: BigInt(fee),
    });
    op.spendRoot = nA.root; // membership root (both spent notes share it)

    // Recoverable LP-share note — sealed to the provider exactly like a transfer output.
    const beHex = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
    const pid = _lp.poolId(assetA, assetB, feeBps);
    const lpAsset = _lp.lpShareId(pid);
    const shareLeaf = pool.leaf(lpAsset, op.share.cx, op.share.cy, id.owner);
    const shareOutput = { value: op.dShares.toString(), blinding: beHex(rShares), secret: id.secret, asset: lpAsset, owner: id.owner, cx: op.share.cx, cy: op.share.cy, ownerPub: id.pubHex };
    const ephRand = () => (BigInt(id.secret) % secp.CURVE.n) || 1n;
    const memos = guard.sealMemosForOutputs({ outputs: [shareOutput], ephRand });
    guard.assertOutputsRecoverable({ leaves: [shareLeaf], outputs: [shareOutput], memos });

    // buildAdd leaves numeric fields as BigInt; the relay JSON-serializes, so normalize them to decimal
    // strings (crypto fields are already hex). Matches the buildLpBondOp / transfer op convention.
    const opWire = JSON.parse(JSON.stringify(op, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
    const r = await _dispatch({ type: 'lp', spec: { op: opWire, leaves: [shareLeaf], outputs: [shareOutput], ephRand }, sealedMemos: memos, selfRelay, walletPriv, waitOpts });
    return { ...r, dShares: op.dShares, pid, lpAsset, assetA, assetB, firstMint: sharesPre === 0n };
  }

  // Quote an in-ratio LP add for a chosen A amount: how much B it needs, the shares it mints, and the relay
  // fee. OP_LP_ADD carves the fee from the A side, and the pool's min-share rule silently donates whatever is
  // off-ratio, so the B amount is derived from (amountA − fee) rather than amountA — quoting off the gross
  // would over-contribute B and hand the difference to existing LPs.
  async function quoteLpAdd({ assetA, assetB, feeBps = 30, amountA, fee = null } = {}) {
    let a = assetA, b = assetB, flip = false;
    if (BigInt(a) > BigInt(b)) { [a, b] = [b, a]; flip = true; } // canonical pair order
    const res = await poolReserves(routePoolId(a, b, feeBps));
    const rA = res ? BigInt(res.reserveA) : 0n, rB = res ? BigInt(res.reserveB) : 0n;
    const sharesPre = res ? BigInt(res.totalShares) : 0n;
    const amtA = BigInt(amountA);
    const f = fee == null ? await gasAwareMinFee(tickerOf(a), 'lp') : BigInt(fee);
    if (f >= amtA) throw new Error(`lp-add: the relay fee (${f}) is not covered by this contribution — add more`);
    const addA = amtA - f;
    if (!res || sharesPre === 0n) {
      // First mint sets the price, so any B is "in ratio" — the caller supplies it.
      return { init: true, assetA: a, assetB: b, flip, amountA: amtA, addA, amountB: null, fee: f, sharesPre, reserveA: rA, reserveB: rB };
    }
    if (rA === 0n) throw new Error('lp-add: pool has no A reserve');
    const amountB = (addA * rB + rA - 1n) / rA; // ceil, so rounding never lands under-ratio (which would donate A)
    return { init: false, assetA: a, assetB: b, flip, amountA: amtA, addA, amountB, fee: f, sharesPre, reserveA: rA, reserveB: rB };
  }

  // Make a note worth EXACTLY `amount` of `asset`, splitting a larger one if needed. OP_LP_ADD consumes whole
  // notes, so a partial contribution has to be sized first — this is the note plumbing behind an ordinary
  // "enter an amount" flow. Returns { note, split } and settles a self-transfer only when it has to.
  async function ensureExactNote({ walletPriv, asset, amount, notes, onStep, waitOpts } = {}) {
    const want = BigInt(amount);
    const mine = (notes || []).filter((n) => String(n.asset).toLowerCase() === String(asset).toLowerCase());
    const exact = mine.find((n) => BigInt(n.value) === want);
    if (exact) return { note: exact, split: false };
    const ticker = tickerOf(asset);
    const splitFee = await gasAwareMinFee(ticker, 'transfer');
    // The split is itself a relayed transfer, so the source note must cover amount + that fee.
    const src = mine.filter((n) => BigInt(n.value) >= want + splitFee).sort((x, y) => (BigInt(x.value) > BigInt(y.value) ? 1 : -1))[0];
    if (!src) throw new Error(`lp-add: no single ${ticker} note covers ${want} plus the split fee — consolidate first`);
    onStep?.({ status: 'splitting', asset, ticker, amount: want.toString() });
    const id = identity(walletPriv);
    await transfer({ walletPriv, notes: [src], recipientPubHex: id.pubHex, amount: want, fee: splitFee, waitOpts });
    // Re-scan: the exact-sized note only exists once the split settles.
    const { byAsset } = await balance(walletPriv);
    const fresh = (byAsset[String(asset).toLowerCase()]?.notes || []).find((n) => BigInt(n.value) === want);
    if (!fresh) throw new Error('lp-add: the split settled but the sized note is not scannable yet — retry in a moment');
    return { note: fresh, split: true };
  }

  // Burn an LP-share note back into its two underlying notes (OP_LP_REMOVE) — the exit for lpAdd. Every other
  // layer already supported this (guest op 8, confidential-lp.buildRemove, the exec-lpremove prover, the relay
  // route); only this binding was missing, which left liquidity addable but not withdrawable from the dapp.
  // `dShares` defaults to the whole note. The relay fee is carved from the A withdrawal: the A note opens to
  // (dA − fee) while the pool still releases the full proportional dA, so the fee must be < dA.
  // NOTE: the burn is WHOLE-NOTE. buildRemove commits the share as commitXY(dShares, shareNote.blinding), so
  // only dShares == the note's full value reconstructs the on-chain leaf; a partial burn fails membership.
  // Partial withdrawal would need the share note split first, or a change-share output in the guest.
  async function lpRemove({ walletPriv, assetA, assetB, feeBps = 30, shareNote, fee = null, deadline = 0n, selfRelay = false, waitOpts } = {}) {
    if (!shareNote) throw new Error('lp-remove: need an LP-share note');
    if (!shareNote.path || shareNote.root == null) throw new Error('lp-remove: share note is missing its membership witness — rescan first');
    const id = identity(walletPriv);
    let a = assetA, b = assetB;
    if (BigInt(a) > BigInt(b)) { [a, b] = [b, a]; } // canonical pair order (assetA < assetB)
    const pid = _lp.poolId(a, b, feeBps);
    const lpAsset = _lp.lpShareId(pid);
    if (String(shareNote.asset).toLowerCase() !== String(lpAsset).toLowerCase()) {
      throw new Error('lp-remove: that share note belongs to a different pair or fee tier');
    }
    const res = await poolReserves(routePoolId(a, b, feeBps));
    if (!res) throw new Error('lp-remove: pool is not initialized');
    const sharesPre = BigInt(res.totalShares);
    const burn = BigInt(shareNote.value);
    if (burn <= 0n) throw new Error('lp-remove: share note has no value');

    // Quote the fee against the withdrawal it is carved from, so an amount too small to cover the settle is
    // rejected here with a legible message instead of failing the proportionality check in the guest.
    const tickerA = tickerOf(a);
    const dAExpected = (BigInt(res.reserveA) * burn) / sharesPre;
    let f = fee == null ? await gasAwareMinFee(tickerA, 'lpremove') : BigInt(fee);
    if (f >= dAExpected) {
      throw new Error(`lp-remove: the relay fee (${f}) is not covered by this withdrawal (${dAExpected} ${tickerA}) — burn more shares, or self-settle`);
    }

    const rA = randomScalar(), rB = randomScalar();
    const op = _lp.buildRemove({
      assetA: a, assetB: b, chainBinding: chainBindingHex(), feeBps,
      reserveAPre: BigInt(res.reserveA), reserveBPre: BigInt(res.reserveB), sharesPre,
      shareNote: { owner: shareNote.owner, leafIndex: Number(shareNote.leafIndex), path: shareNote.path },
      dShares: burn, rShares: BigInt(shareNote.blinding),
      aOwner: id.owner, rA, bOwner: id.owner, rB, deadline, fee: f,
    });
    op.spendRoot = shareNote.root;
    // verifyRemove compares the reconstructed root with !==, so normalize case on both sides: a hex-case
    // difference between the scanned note's root and the recomputed one would read as a membership failure.
    _lp.verifyRemove(op, {
      merkleRootFrom: (lf, idx, path) => String(_rootFromPath(lf, idx, path)).toLowerCase(),
      spendRoot: String(op.spendRoot).toLowerCase(),
    });

    const beHex = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
    const outA = { value: (op.dA - f).toString(), blinding: beHex(rA), secret: id.secret, asset: a, owner: id.owner, cx: op.a.cx, cy: op.a.cy, ownerPub: id.pubHex };
    const outB = { value: op.dB.toString(), blinding: beHex(rB), secret: id.secret, asset: b, owner: id.owner, cx: op.b.cx, cy: op.b.cy, ownerPub: id.pubHex };
    const leaves = [pool.leaf(a, op.a.cx, op.a.cy, id.owner), pool.leaf(b, op.b.cx, op.b.cy, id.owner)];
    const ephRand = () => (BigInt(id.secret) % secp.CURVE.n) || 1n;
    const memos = guard.sealMemosForOutputs({ outputs: [outA, outB], ephRand });
    guard.assertOutputsRecoverable({ leaves, outputs: [outA, outB], memos });
    if (f > 0n) { const u = await feeUsdFor(f, tickerA).catch(() => null); if (u != null) op.feeUsd = u; }

    const opWire = JSON.parse(JSON.stringify(op, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
    const r = await _dispatch({ type: 'lpremove', spec: { op: opWire, leaves, outputs: [outA, outB], ephRand }, sealedMemos: memos, selfRelay, walletPriv, waitOpts });
    return { ...r, burned: burn, dA: op.dA, dB: op.dB, netA: op.dA - f, fee: f, pid, lpAsset, assetA: a, assetB: b };
  }

  // ── CDP position set (rebuilt client-side from CdpPositionInserted) ──
  // Position leaves live in a separate tree (cdpRoot) and emit CdpPositionInserted(bytes32 indexed leaf) in
  // insertion order. Rebuild that tree from the logs so a CLOSE/TOPUP can prove membership (the index + path
  // the guest/contract check against cdpPositionRoot). eth_getLogs returns ascending block+logIndex order, so
  // the emit stream IS the insertion order — the leaf's ordinal is its tree index.
  const CDP_POS_TOPIC0 = '0x' + _hex(keccak256(new TextEncoder().encode('CdpPositionInserted(bytes32)')));
  async function cdpPositionTree() {
    const logs = await getLogsChunked({ address: cfg.pool, topics: [CDP_POS_TOPIC0] }, Number(cfg.deployBlock || 0), await headBlock());
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
  const _stealth = makeConfidentialStealth({ keccak256, secp, signSchnorr, curveOrder: SECP_N, pool, transfer: _ct });
  function buildTransferOp({ walletPriv, notes, recipientPubHex, amount, fee = 0n, feeUsd = null }) {
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
      // The relay fee leaves the shielded set as a public FeePayment, so it is NOT one of the outputs:
      // conservation is Σin = Σout + fee, and the kernel must be built over that same fee the guest reads.
      fee,
      assetId: asset,
    });
    if (!_ct.verifyTransfer(t)) throw new Error('transfer: self-verify failed');

    const beHex = (n) => '0x' + n.toString(16).padStart(64, '0');
    const ptHex = (P) => '0x' + _hex(P.toRawBytes(true));
    const xy = (P) => { const a = P.toAffine(); return { cx: beHex(a.x), cy: beHex(a.y) }; };
    const cb = chainBindingHex();
    const spendRoot = notes[0].root;

    const inMeta = notes.map((n, i) => {
      // The membership leaf must be the EXACT on-chain leaf — use the scanned note's own commitment + owner
      // (like buildUnwrap), not the recomputed commitment or id.owner. Guard: the kernel's recomputed input
      // commitment must equal the scanned one, else value/blinding recovery drifted (would fail membership).
      const c = xy(t.inC[i]);
      if (String(c.cx).toLowerCase() !== String(n.cx).toLowerCase() || String(c.cy).toLowerCase() !== String(n.cy).toLowerCase()) {
        throw new Error('transfer: recomputed input commitment ≠ scanned note (value/blinding recovery mismatch)');
      }
      const leafIndex = Number(n.leafIndex);
      if (n.root == null || !n.path || n.path.length !== 32) throw new Error(`transfer: input ${i} missing membership witness (root/path)`);
      const cx = _pad32(n.cx, `input ${i} cx`), cy = _pad32(n.cy, `input ${i} cy`);
      const owner = _pad32(n.owner, `input ${i} owner`), secret = _pad32(n.secret, `input ${i} secret`);
      const path = n.path.map((p, k) => _pad32(p, `input ${i} path[${k}]`));
      const lf = pool.leaf(asset, cx, cy, owner);
      const reRoot = _rootFromPath(lf, leafIndex, path);
      if (reRoot.toLowerCase() !== _pad32(spendRoot, 'spendRoot').toLowerCase()) {
        throw new Error(`transfer: input ${i} membership does not reconstruct spendRoot (leafIndex ${leafIndex}); note witness is stale — rescan before sending`);
      }
      return { cx, cy, owner, leafIndex, path, secret };
    });
    const outOwners = [recipientOwner]; if (change > 0n) outOwners.push(id.owner);
    const outMeta = txOutputs.map((_, j) => ({ cx: xy(t.outC[j]).cx, cy: xy(t.outC[j]).cy, owner: _pad32(outOwners[j], `output ${j} owner`) }));

    const op = {
      chainBinding: _pad32(cb, 'chainBinding'), spendRoot: _pad32(spendRoot, 'spendRoot'), asset: _pad32(asset, 'asset'), owner: _pad32(id.owner, 'owner'),
      inputs: inMeta, outputs: outMeta,
      rangeProof: '0x' + _hex(t.rangeProof), kernel: { R: ptHex(t.kernel.R), z: beHex(t.kernel.z) },
      fee: fee.toString(),
      // Priced fee for the relay's profitability gate. The guest never reads it (the harness feeds only the
      // fields it names), so it rides along without touching the proof.
      ...(feeUsd != null ? { feeUsd } : {}),
    };
    // Debug capture: the exact witness sent to the prover, so a guest-side failure can be reproduced
    // locally (run copy(window.__lastTransferOp) in the console). Contains no spend key.
    try { if (typeof window !== 'undefined') window.__lastTransferOp = JSON.parse(JSON.stringify(op)); } catch { /* ignore */ }

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
  async function transfer({ walletPriv, notes, recipientPubHex, amount, fee = 0n, feeUsd = null, selfRelay = false, waitOpts } = {}) {
    // Price the fee for the relay gate when the caller didn't. fee === 0n stays unpriced: that is a
    // self-settled / internal move (a note merge), not a relayed send the relay must profit on.
    if (feeUsd == null && BigInt(fee) > 0n) {
      feeUsd = await feeUsdFor(fee, tickerOf(notes?.[0]?.asset)).catch(() => null);
    }
    const b = buildTransferOp({ walletPriv, notes, recipientPubHex, amount, fee, feeUsd });
    return _dispatch({
      type: 'transfer', spec: { op: b.op, leaves: b.leaves, outputs: b.outputs, ephRand: b.ephRand },
      sealedMemos: b.memos, selfRelay, walletPriv, waitOpts,
    });
  }

  // ── ETH→BTC crossOut (OP bridge_burn) ──
  // Burn owned ETH notes → emit crossOut records ({destChain, destCommitment, ν, claimId}); the contract emits
  // CrossOutRecorded, the reflection Mode-B fold (T_CROSSOUT_MINT 0x65) mints the Bitcoin note past finality.
  // All burned value crosses to Bitcoin (no ETH change output): pass notes summing to amount+fee exactly, or
  // the whole selection (amount = Σnotes − fee). `destOwner` = the Bitcoin note owner (self-bridge ⇒ own owner);
  // `destBlinding` (returned) is what the recipient recovers the Bitcoin note with — PERSIST it.
  // UNVERIFIED: buildBridgeBurn is portable + proven crypto, but this ETH-side dispatch/op-shape was never
  // wired (the live crossOut used ops tooling). Prove one small crossOut settles + the Bitcoin note mints
  // before real value. Dispatches as a `transfer`-type op carrying crossOuts (the op shape the guest reads).
  async function crossOut({ walletPriv, notes, amount, destOwner, destBlinding, destChain = 1, fee = 0n, selfRelay = false, waitOpts } = {}) {
    if (!notes || !notes.length) throw new Error('crossOut: no input notes');
    const id = identity(walletPriv);
    const asset = notes[0].asset;
    if (notes.some((n) => n.asset !== asset)) throw new Error('crossOut: all inputs must be one asset');
    const total = notes.reduce((s, n) => s + BigInt(n.value), 0n);
    fee = BigInt(fee);
    amount = amount != null ? BigInt(amount) : total - fee; // default: bridge the whole selection net of fee
    if (amount + fee !== total) throw new Error('crossOut: Σnotes must equal amount+fee (no ETH change in a bridge_burn)');
    const owner = destOwner || id.owner;
    const rDest = destBlinding != null ? BigInt(destBlinding) : randomScalar();
    const t = _ct.buildBridgeBurn({
      inputs: notes.map((n) => ({ value: BigInt(n.value), blinding: BigInt(n.blinding) })),
      outputs: [{ value: amount, blinding: rDest, owner }],
      assetId: asset, destChain, bindNullifier: notes[0].nullifier, fee,
    });
    const beHex = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
    const ptHex = (P) => '0x' + _hex(P.toRawBytes(true));
    const xy = (P) => { const a = P.toAffine(); return { cx: beHex(a.x), cy: beHex(a.y) }; };
    const inMeta = notes.map((n, i) => { const c = xy(t.inC[i]); return { cx: c.cx, cy: c.cy, owner: id.owner, leafIndex: Number(n.leafIndex), path: n.path, secret: n.secret }; });
    const op = {
      chainBinding: chainBindingHex(), spendRoot: notes[0].root, asset, owner: id.owner,
      inputs: inMeta, crossOuts: t.crossOuts,
      rangeProof: '0x' + _hex(t.rangeProof), kernel: { R: ptHex(t.kernel.R), z: beHex(t.kernel.z) },
      fee: fee.toString(),
    };
    const r = await _dispatch({ type: 'transfer', spec: { op, leaves: [], outputs: null, ephRand: null }, sealedMemos: [], selfRelay, walletPriv, waitOpts });
    return { ...r, crossOuts: t.crossOuts, destOwner: owner, destBlinding: beHex(rDest), amount: amount.toString(), asset };
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
  // Relay-fee policy per asset. The relay's cost is ETH-denominated (settle gas + prove) but the fee is paid
  // IN-KIND in the op's asset (the guest emits FeePayment{assetId,value}; the pool pays msg.sender), so each
  // fee-eligible asset needs a way to express that cost in its own units.
  //   minUnderlying — floor in the asset's UNDERLYING base units (scale-independent, as cETH's always was).
  //   usd           — optional live pricing so the floor tracks gas: 'eth' (native, convert ETH cost
  //                   directly), 'stable' (1 unit == $1), or a Chainlink USD feed address.
  // An asset MISSING from this table is NOT relay-fee-eligible: relayFeeEligible() is false and the caller
  // declines to relay it rather than the relay absorbing a cost it cannot price or convert.
  // cTAC is deliberately fee-BEARING but floor-priced only, and `replenish` deliberately omits TAC from
  // FEE_ASSETS — collected TAC is never auto-sold, it accrues as protocol-owned reserve. Charging it still
  // matters: a free op is a griefing vector, and the fee reduces float rather than adding sell pressure.
  // POLICY KNOB. Derived 2026-07-22 from the live 30bps cTAC/cETH pool (reserves 2.0 cTAC / 0.00018406 cETH
  // ⇒ 1 TAC ≈ 0.000092 ETH ≈ $0.18), set to ~$0.35 so it sits alongside the stables' $0.30 floor with slack
  // for TAC's volatility. Deliberately a STATIC floor, not an AMM quote: that pool holds well under a dollar
  // of depth, so a live quote off it would be trivially manipulable into an absurd fee. Re-set from the
  // market as TAC's price moves.
  const CTAC_FEE_FLOOR_UNDERLYING = 2000000000000000000n; // 2 TAC (18dp)
  const RELAY_FEE_ASSETS = {
    cETH:  { usd: 'eth',    minUnderlying: 100000000000000n },     // 0.0001 ETH
    cUSDC: { usd: 'stable', minUnderlying: 300000n },              // $0.30 (6dp)
    cUSDT: { usd: 'stable', minUnderlying: 300000n },              // $0.30 (6dp)
    cUSD:  { usd: 'stable', minUnderlying: 300000000000000000n },  // $0.30 (18dp)
    cBTC:  { usd: '0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c', minUnderlying: 2000000000000n }, // Chainlink BTC/USD
    cTAC:  { minUnderlying: CTAC_FEE_FLOOR_UNDERLYING },
  };
  const _unitScaleOf = (ticker) => BigInt((assetByTicker[ticker] && assetByTicker[ticker].unitScale) || '1');
  // Whether the relay will accept a fee in this asset at all. False ⇒ the caller must self-settle.
  function relayFeeEligible(ticker) { return !!RELAY_FEE_ASSETS[ticker]; }
  // The relay floor in IN-SYSTEM units for `ticker` (0 if none configured).
  function relayMinFee(ticker) {
    const wei = RELAY_FEE_ASSETS[ticker] && RELAY_FEE_ASSETS[ticker].minUnderlying;
    return wei == null ? 0n : wei / _unitScaleOf(ticker);
  }
  // Measured settle gas per relayed op (+ headroom): whole-note unwrap ~361k, send-and-unwrap ~590k (change
  // leaf), shielded transfer ~600k (membership + 2 output leaves).
  const SETTLE_GAS = { unwrap: 450000n, sendunwrap: 680000n, transfer: 620000n, lp: 780000n, lpremove: 720000n, route: 600000n, swap: 600000n };
  // Succinct network prove fee per op, as wei. Measured from a live fulfillment for a shielded transfer:
  // 0.3892 PROVE x ~$0.19 = ~$0.074, ~0.00004 ETH at ~$1900/ETH. Re-derive if PROVE or ETH moves materially.
  const PROVE_COST_WEI = 40000000000000n;
  // Fee buckets. The relay fee is public, so a continuously-varying fee is a fingerprint on the payer; a
  // coarse step collapses many sends onto the same value. Sized ~1/3 of a typical fee: enough buckets to
  // still track gas, coarse enough that ordinary gas movement doesn't produce a unique fee per user.
  const FEE_QUANTUM_WEI = 50000000000000n; // 0.00005 ETH
  const FEE_QUANTUM_USD = 0.05;
  const _quantizeUp = (v, step) => ((BigInt(v) + step - 1n) / step) * step;
  // Gas-aware relay-fee floor: the fee must at least cover the relay's settle gas + prove cost × a margin,
  // else the relay loses money at higher gas. Native (cETH) only — the gas is ETH so it converts to in-system
  // units directly; for ERC20 the fee is in the token with no ETH→token oracle here, so keep the static
  // floor. Never below the static floor.
  async function gasAwareMinFee(ticker, opKind) {
    const staticFloor = relayMinFee(ticker);
    const pol = RELAY_FEE_ASSETS[ticker];
    const meta = assetByTicker[ticker];
    if (!pol || !meta) return staticFloor;
    let gwei; try { gwei = BigInt((await rpc('eth_gasPrice', [])) || '0'); } catch { return staticFloor; }
    if (gwei <= 0n) return staticFloor;
    // 1.35x, not 1.2x: minutes pass between quoting this and the settle landing, and the base fee can climb
    // materially in that window — a 1.2x margin was being wiped out by ordinary drift, settling at a loss.
    const costWei = ((SETTLE_GAS[opKind] || 500000n) * gwei + PROVE_COST_WEI) * 135n / 100n;
    let floor;
    if (pol.usd === 'eth') {
      // Quantize UP to a coarse step. A fee that tracks gas continuously is a per-user fingerprint: it is
      // PUBLIC (pv.fees), so a distinct value narrows down who sent what. Snapping to buckets makes many
      // transfers in the same gas regime carry an identical fee, and rounding up absorbs some drift.
      floor = _quantizeUp(costWei, FEE_QUANTUM_WEI) / _unitScaleOf(ticker);
    } else if (pol.usd) {
      // Non-native: price the ETH cost in USD, then convert into the asset's own underlying units. Any
      // missing leg falls back to the static floor rather than quoting a wrong (possibly overcharging) fee.
      const ethPx = await ethUsdPrice();
      const assetPx = pol.usd === 'stable' ? 1 : await feedUsdPrice(pol.usd);
      // Decimals are NOT guessed here: assuming 18 for a 6-decimal token would overcharge by 1e12. A missing
      // value falls back to the configured floor instead.
      if (!ethPx || !assetPx || !Number.isFinite(meta.decimals)) return staticFloor;
      const costUsd = Math.ceil(((Number(costWei) / 1e18) * ethPx) / FEE_QUANTUM_USD) * FEE_QUANTUM_USD;
      const underlying = BigInt(Math.ceil((costUsd / assetPx) * 10 ** meta.decimals));
      floor = underlying / _unitScaleOf(ticker);
      // Backstop against a bad feed or a decimals/scale mismatch: a live quote should track the floor, not
      // dwarf it. Cap at 50x so a misconfiguration can never bill a user an absurd fee.
      if (staticFloor > 0n && floor > staticFloor * 50n) floor = staticFloor * 50n;
    } else {
      return staticFloor; // floor-priced asset (no feed) — the configured floor IS the fee
    }
    return floor > staticFloor ? floor : staticFloor;
  }

  // Relay fee for a shielded transfer: FLAT (the quantized gas+prove floor), deliberately NOT a percentage.
  // A transfer's amount is hidden, but the fee is published in pv.fees — so charging bps would let anyone
  // divide the fee by the rate and recover the amount, defeating the point of shielding it. The relay's cost
  // is flat per settle anyway (gas and proving don't scale with amount), so proportional pricing was never
  // cost-justified here. Exits are different: their payout is already public, so quoteUnwrapFee keeps bps.
  // Unlike an exit the fee is NOT carved out of `amount` — it comes from the change, so the inputs must
  // cover amount + fee.
  async function quoteTransferFee(amount, ticker = 'cETH', { minFee } = {}) {
    const fee = minFee != null ? BigInt(minFee) : await gasAwareMinFee(ticker, 'transfer');
    const v = BigInt(amount);
    return fee > v ? v : fee; // never quote more than the amount being sent
  }

  // USD value of a fee in in-system units, for the relay's profitability gate (op.feeUsd). Chainlink ETH/USD
  // via the wired RPC; native assets only — returns null when it can't be priced, which the gate treats as
  // unpriced rather than as zero.
  const CHAINLINK_ETH_USD = '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419';
  const _feedPx = new Map(); // feed → { at, v }; ~1-min cache (feeds update on-chain slower than that)
  async function feedUsdPrice(feed) {
    const k = String(feed).toLowerCase();
    const c = _feedPx.get(k);
    if (c && Date.now() - c.at < 60000 && c.v) return c.v;
    try {
      const r = await rpc('eth_call', [{ to: feed, data: '0xfeaf968c' }, 'latest']); // latestRoundData()
      if (!r || r.length < 2 + 128) return c ? c.v : null;
      const answer = BigInt('0x' + r.slice(2).slice(64, 128)); // int256 answer (word[1]), 8 decimals
      if (answer > 0n) { const v = Number(answer) / 1e8; _feedPx.set(k, { at: Date.now(), v }); return v; }
    } catch { /* keep the last price */ }
    return c ? c.v : null;
  }
  const ethUsdPrice = () => feedUsdPrice(CHAINLINK_ETH_USD);
  async function feeUsdFor(feeUnits, ticker = 'cETH') {
    const meta = assetByTicker[ticker];
    const pol = RELAY_FEE_ASSETS[ticker];
    if (!meta || !pol || !pol.usd) return null; // floor-priced (e.g. cTAC) ⇒ unpriced, not zero
    const px = pol.usd === 'eth' ? await ethUsdPrice()
      : pol.usd === 'stable' ? 1
      : await feedUsdPrice(pol.usd);
    if (!px || !Number.isFinite(meta.decimals)) return null;
    const underlying = Number(BigInt(feeUnits) * _unitScaleOf(ticker));
    return (underlying / 10 ** meta.decimals) * px;
  }

  // CHAIN_BINDING == keccak256(abi.encodePacked(uint256 chainid, address(pool))) — the same value the
  // contract stamps; the guest must commit it so a proof is bound to this deployment.
  function chainBindingHex() {
    const cid = BigInt(cfg.chainId).toString(16).padStart(64, '0');
    const addr = cfg.pool.replace(/^0x/, '').toLowerCase().padStart(40, '0');
    const bytes = Uint8Array.from(((cid + addr).match(/../g) || []).map((h) => parseInt(h, 16)));
    return '0x' + _hex(keccak256(bytes));
  }

  // Coarse deadline snapped to a 10-min bucket ~1h out: identical retries within the window yield the SAME op →
  // same jobId → the relay dedupes them, so a double-tap / re-submit can't spawn a second settle for one note.
  function coarseDeadline(ttlSecs = 3600, bucket = 600) {
    return BigInt(Math.ceil((Math.floor(Date.now() / 1000) + ttlSecs) / bucket) * bucket);
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
    const deadline = ttlSecs > 0 ? coarseDeadline(ttlSecs) : 0n;
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

  // Resolve when the exit is CONFIRMED — whichever comes first: the relay acks 'settled' (carries the txHash),
  // OR chain state shows the spent note gone (the balance scan drops it once its nullifier is spent). The chain
  // signal can beat the relay's ack when private (Flashbots) inclusion lags it — so the UI never hangs on a
  // settle that already landed. relay.waitForSettle owns the timeout/failure path.
  async function waitForExit({ walletPriv, note, jobId, waitOpts }) {
    let stop = false;
    const relayP = relay.waitForSettle(jobId, waitOpts).then((st) => ({ status: st.status, txHash: st.txHash }));
    const chainP = new Promise((resolve) => {
      (async () => {
        for (let i = 0; i < 80 && !stop; i++) {
          await new Promise((r) => setTimeout(r, 6000));
          if (stop) return;
          try {
            const { byAsset } = await balance(walletPriv);
            const held = byAsset[String(note.asset).toLowerCase()];
            const still = held?.notes?.some((n) => String(n.cx) === String(note.cx) && String(n.cy) === String(note.cy));
            if (!still) return resolve({ status: 'settled', txHash: null });
          } catch { /* keep polling; relay is the authority on failure */ }
        }
      })();
    });
    try { return await Promise.race([relayP, chainP]); }
    finally { stop = true; }
  }

  // Submit a gasless exit to the relay (no user tx) and, by default, block until it settles on-chain.
  // The box collects `fee`; the user receives `net`. Returns the build + { jobId, status, txHash }.
  async function unwrap({ note, walletPriv, recipient, feeOpts, wait = true, waitOpts } = {}) {
    const ticker = tickerOf(note.asset) || 'cETH';
    const minFee = (feeOpts && feeOpts.minFee != null) ? feeOpts.minFee : await gasAwareMinFee(ticker, 'unwrap');
    const built = buildUnwrap({ note, walletPriv, recipient, feeOpts: { ...feeOpts, minFee } });
    const sub = await relay.submitOp({ type: 'unwrap', op: built.op, memos: [] }); // no new leaf ⇒ no memo
    if (!wait) return { ...built, jobId: sub.jobId, status: sub.status };
    const st = await waitForExit({ walletPriv, note, jobId: sub.jobId, waitOpts });
    return { ...built, jobId: sub.jobId, status: st.status, txHash: st.txHash };
  }

  // Fungible exit (OP_SEND_AND_UNWRAP): spend ONE note → pay an EXACT `amount` out to `recipient` (public) and
  // keep the remainder as a hidden change note back to self — one proof, relay-settled. `amount` is debited from
  // the note; the recipient receives amount − fee. Falls back to the whole-note unwrap when there's no change.
  async function sendUnwrap({ note, walletPriv, recipient, amount, feeOpts, wait = true, waitOpts } = {}) {
    if (!note) throw new Error('sendUnwrap: note required');
    const ticker = tickerOf(note.asset) || 'cETH';
    amount = BigInt(amount);
    const noteValue = BigInt(note.value);
    if (amount > noteValue) throw new Error('sendUnwrap: amount exceeds the note (merge notes first)');
    const minFee = (feeOpts && feeOpts.minFee != null) ? feeOpts.minFee : await gasAwareMinFee(ticker, 'sendunwrap');
    const { fee } = quoteUnwrapFee(amount, ticker, { ...feeOpts, minFee });
    const payout = amount - fee;
    if (payout <= 0n) throw new Error('sendUnwrap: amount too small for the relay fee');
    const change = noteValue - amount;
    if (change === 0n) return unwrap({ note, walletPriv, recipient, feeOpts, wait, waitOpts }); // exact-size note → whole-note exit
    const id = identity(walletPriv);
    const to = String(recipient).toLowerCase();
    const beHex = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
    // Deterministic change blinding (from note.blinding, which only the owner knows) so a retry rebuilds the
    // IDENTICAL op → relay-deduped. Randomness here would defeat the coarse-deadline dedup.
    const rChange = pool.deriveOpeningNonce(note.blinding, note.cx, 'sendunwrap-change-v1');
    const built = _stealth.buildSendUnwrap({
      chainBinding: chainBindingHex(), asset: note.asset,
      note: { cx: note.cx, cy: note.cy, owner: note.owner, blinding: note.blinding, value: noteValue, leafIndex: Number(note.leafIndex), path: note.path, secret: note.secret },
      recipient: to, payout, fee, opDeadline: coarseDeadline(3600),
      change: [{ value: change, blinding: rChange, owner: id.owner }],
      spendRoot: note.root,
    });
    // The change note goes back to self — ship its recovery descriptor so the relay seals a memo the owner can
    // scan + decode (else the change would be unrecoverable).
    const changeOut = [{ value: change.toString(), blinding: beHex(rChange), secret: id.secret, asset: note.asset, owner: id.owner, cx: built.change[0].cx, cy: built.change[0].cy, ownerPub: id.pubHex }];
    const changeLeaf = pool.leaf(note.asset, built.change[0].cx, built.change[0].cy, id.owner);
    const ephRand = () => (BigInt(id.secret) % secp.CURVE.n) || 1n;
    // The harness reads f["kernel"]["R"]/["z"] (nested) — buildSendUnwrap returns them flat, so reshape the op.
    const op = {
      chainBinding: built.chainBinding, spendRoot: built.spendRoot, asset: built.asset,
      input: built.input, recipient: built.recipient, payout: built.payout, fee: built.fee, opDeadline: built.opDeadline,
      pokR: built.pokR, pokZv: built.pokZv, pokZr: built.pokZr, change: built.change,
      rangeProof: built.rangeProof, kernel: { R: built.kernelR, z: built.kernelZ },
    };
    const sub = await relay.submitOp({ type: 'sendunwrap', op, leaves: [changeLeaf], outputs: changeOut, ephRand });
    const out = { ...built, fee, payout, change, recipient: to, ticker };
    if (!wait) return { ...out, jobId: sub.jobId, status: sub.status };
    const st = await waitForExit({ walletPriv, note, jobId: sub.jobId, waitOpts });
    return { ...out, jobId: sub.jobId, status: st.status, txHash: st.txHash };
  }

  return { cfg, assets: _poolAssets, assetByTicker, account, identity, rpc, ethCall, fetchEvents, balance, tickerOf,
    buildWrap, wrap, submitWrapSettle, buildRouterWrap, routerWrap, routerConfigured, buildWrapTransferOp, wrapAndSend, resumeWrapAndSend, buildTransferOp, transfer, crossOut, payInvoice, quoteUnwrapFee, quoteTransferFee, quoteOpFee: gasAwareMinFee, feeUsdFor, relayFeeEligible, buildUnwrap, unwrap, sendUnwrap, buildAttestMeta, chainBindingHex,
    erc2612Nonce: _erc2612Nonce, poolReserves, routePoolId, quoteRoute, route, buildLpBondOp, lpBond, lpAdd, lpRemove, quoteLpAdd, ensureExactNote, mintCbtc, defiActions, cdp: _cdp, cdpPositionTree, submitSettle,
    relay, indexer, evmLog, evmTx, pool, memo, router: _router };
}
