// Dapp-side orchestration for the confidential-pool UX (Sepolia pilot v1, 2026-06-14). Wires the
// already-built primitives into one tab-facing API so tacit.js stays a thin renderer over the LIVE pool:
//   - evm-account        → the persistent Sepolia EVM identity derived from the Tacit wallet scalar
//   - confidential-evm-log + confidential-indexer → seed-only confidential balance from the pool's logs
//   - confidential-relay → the settle queue (transfer/swap/lp/otc/bid) on api.tacit.finance
// The wrap (on-chain deposit) + transfer/unwrap BUILD paths layer the op assemblers + evm-tx on top of
// this; this module owns the read path (account + balance) + the live config + the settle/RPC handles.

import { makeEvmAccount } from './evm-account.js';
import { makeConfidentialIndexer } from './confidential-indexer.js';
import { makeConfidentialEvmLog } from './confidential-evm-log.js';
import { makeConfidentialRelay } from './confidential-relay.js';
import { makeEvmTx } from './evm-tx.js';
import { makeRecoveryGuard } from './confidential-recovery-guard.js';

// Live deployments — keyed by the dapp's EVM-chain label. Sepolia pilot v1 mirrors the on-chain core
// (the pool from the 2026-06-14 deploy) + cETH (assetId is deterministic, identical across pool versions).
export const CONFIDENTIAL_POOL_UX = {
  sepolia: {
    chainId: 11155111,
    pool: '0x991726A547DCdB57ba660E395D9c7D7C3FcAdF79',
    // ConfidentialRouter (periphery: one-tx wrap / private-payment / public-AMM / zaps). Set from the next
    // DeployConfidentialPool broadcast (DEPLOY_ROUTER pins permit2 + zRouter). null ⇒ router flows disabled.
    router: null,
    permit2: '0x000000000022D473030F116dDEE9F6B43aC78BA3', // Uniswap Permit2 singleton (same on every chain)
    zRouter: '0x000000000000FB114709235f1ccBFfb925F600e4', // pinned zRouter aggregator (V2/V3/V4/Curve/zAMM)
    deployBlock: 11057316,
    rpcs: [
      'https://ethereum-sepolia-rpc.publicnode.com',
      'https://1rpc.io/sepolia',
      'https://sepolia.drpc.org',
      'https://sepolia.gateway.tenderly.co',
    ],
    relayBase: 'https://api.tacit.finance',
    evmNetwork: 'mainnet', // domain-separation tag for deriveEvmAccount (the persistent EVM identity)
    assets: [
      {
        ticker: 'cETH',
        assetId: '0x2a0f3cb492f4add38bada8b7ef18de79445846ce7c5b7dc1c4b0d768467a04c2',
        underlying: '0x0000000000000000000000000000000000000000', // native ETH (escrow-backed wrap)
        unitScale: '1',
        decimals: 18,
        native: true,
      },
    ],
  },
};

export function makeConfidentialPoolUx({ secp, keccak256, sha256, fetchImpl, network = 'sepolia' } = {}) {
  const cfg = CONFIDENTIAL_POOL_UX[network];
  if (!cfg || !cfg.pool) throw new Error(`confidential pool not deployed on "${network}"`);
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

  const assetByTicker = Object.fromEntries(cfg.assets.map((a) => [a.ticker, a]));

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
    const a = cfg.assets.find((x) => x.assetId.toLowerCase() === id);
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
    return { priv, pubHex: '0x' + _hex(pub), owner: '0x' + _hex(pub.subarray(1, 33)) };
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

  // ── gasless exit (0xbow-style relayed unwrap) ──
  // The user spends a shielded note; the relay box settles ConfidentialPool.settle() on-chain (pays the
  // gas) and is paid `fee` out of the note value as `pv.fees → msg.sender`, so the user RECEIVES
  // value−fee and signs NOTHING on-chain — a true gasless exit. The fee is in the withdrawn asset's
  // in-system units: max(minFee, ceil(feeBps/1e4 · value)). A user holding gas can self-settle (fee = 0
  // and broadcast settle themselves). The guest's OP_UNWRAP splits value → withdrawal(value−fee) +
  // fee, both public legs summing to the proven value (no separate fee proof).
  const RELAY_FEE_BPS = 30n;                                 // 0.30% of the exit
  const RELAY_MIN_FEE = { cETH: 100000000000000n };          // per-ticker floor (in-system units) to cover settle gas

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
    const floor = minFee != null ? BigInt(minFee) : (RELAY_MIN_FEE[ticker] ?? 0n);
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
  function buildUnwrap({ note, walletPriv, recipient, feeOpts, selfSettle = false } = {}) {
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
    const ctx = pool.intentContext('tacit-unwrap-intent-v1', cb, note.asset, recip32,
      [[note.cx, note.cy, note.owner]], [BigInt(note.value), fee]);
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

  return { cfg, assetByTicker, account, identity, rpc, ethCall, fetchEvents, balance, tickerOf,
    buildWrap, wrap, quoteUnwrapFee, buildUnwrap, unwrap, buildAttestMeta, chainBindingHex,
    relay, indexer, evmLog, evmTx, pool, memo };
}
