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

// Live deployments — keyed by the dapp's EVM-chain label. Sepolia pilot v1 mirrors the on-chain core
// (the pool from the 2026-06-14 deploy) + cETH (assetId is deterministic, identical across pool versions).
export const CONFIDENTIAL_POOL_UX = {
  sepolia: {
    chainId: 11155111,
    pool: '0x32e46B097830D93d50b0CBC89c018bCFD79b7B5a',
    deployBlock: 11052948,
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
  const relay = makeConfidentialRelay({ base: cfg.relayBase, fetchImpl: _fetch });

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
  const memo = indexer._memo;   // sealMemo / encodeMemo

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
    const { cx, cy } = pool.commitXY(value, blinding);
    const leaf = pool.leaf(meta.assetId, cx, cy, id.owner);
    const depositId = pool.depositId(meta.assetId, value, cx, cy, id.owner);
    const note = { value: value.toString(), blinding, secret, asset: meta.assetId, owner: id.owner, cx, cy };

    // self-recovery memo, sealed to the user's own pubkey; eph deterministic from the secret (the memo
    // carries the full opening, so a fixed eph is fine and makes the build reproducible).
    const ephRand = () => (BigInt(secret) % secp.CURVE.n) || 1n;
    const memoHex = memo.encodeMemo(memo.sealMemo(id.pubHex, note, ephRand));

    // pool.wrap(bytes32 assetId, uint256 amount, bytes32 cx, bytes32 cy, bytes32 owner)
    const calldata = '0x' + _selector('wrap(bytes32,uint256,bytes32,bytes32,bytes32)')
      + _word(meta.assetId) + _word(amount) + _word(cx) + _word(cy) + _word(id.owner);

    return {
      note, leaf, depositId, memo: memoHex,
      // the OP_WRAP witness the box proves (chainBinding stamped at submit); OP_WRAP is box-driven, not a queue type
      wrapOp: { asset: meta.assetId, value: value.toString(), cx, cy, owner: id.owner, blinding },
      to: cfg.pool, amount: amount.toString(), calldata,
      wrapArgs: { assetId: meta.assetId, amount: amount.toString(), cx, cy, owner: id.owner },
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

  return { cfg, assetByTicker, account, identity, rpc, ethCall, fetchEvents, balance, tickerOf, buildWrap, wrap, relay, indexer, evmLog, evmTx, pool, memo };
}
