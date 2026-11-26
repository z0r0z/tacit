// The process that runs the take watcher (worker-relay/src/take-watcher.js). Off unless TAKE_WATCHER_ENABLED=true.
//
//   TAKE_WATCHER_ENABLED=true node worker-relay/src/take-watcher-main.js
//
// It runs from the fastbridge-lp image (worker-relay/Dockerfile.fastbridge-lp: it has every dapp module this reads the pool with), with this as the start command.
// It holds no key of any user and nothing it does can pay anyone but the user whose pre-signature it finishes. A coin of its own for fees is optional.
//
//   TAKE_WATCHER_API            the Tacit API that keeps the pre-signatures (default https://api.tacit.finance)
//   TAKE_WATCHER_DATA_DIR       where it keeps its state (default ./take-watcher-data): losing it only means asking the API again
//   TAKE_WATCHER_EVERY_SECS     seconds between passes (default 60)
//   TAKE_WATCHER_BTC_BASES      comma-separated esplora bases (default mempool.space and blockstream.info)
//   TAKE_WATCHER_TRACE_RPCS / TAKE_WATCHER_AGREE_RPCS   the Ethereum nodes that trace a claim, and that must agree on it (defaults as the provider's)
//   TAKE_WATCHER_FUND_KEY       64 hex: a Bitcoin key (P2WPKH) whose coins pay a fee the committed one falls short of (default: none, takes go out at their committed fee)
//   TAKE_WATCHER_MAX_FUND_SATS  the most it adds to one take (default 20000)
import { mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';
import { makeTakeWatcher } from './take-watcher.js';

const env = process.env;
if (String(env.TAKE_WATCHER_ENABLED || '') !== 'true') { console.log('take watcher: off (set TAKE_WATCHER_ENABLED=true to run it)'); process.exit(0); }
const log = (o) => console.log(JSON.stringify({ ts: new Date().toISOString(), ...o }));
const list = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
const API = String(env.TAKE_WATCHER_API || 'https://api.tacit.finance').replace(/\/+$/, '');
const BASES = list(env.TAKE_WATCHER_BTC_BASES).length ? list(env.TAKE_WATCHER_BTC_BASES) : ['https://mempool.space/api', 'https://blockstream.info/api'];
const EVERY = Math.max(15, Number(env.TAKE_WATCHER_EVERY_SECS || 60));
const dir = resolve(env.TAKE_WATCHER_DATA_DIR || 'take-watcher-data');
mkdirSync(dir, { recursive: true });

// state: one JSON file for each pre-signature, written whole and moved into place
const file = (k) => resolve(dir, k.replace(/[^0-9a-f:]/g, '').replace(/:/g, '_') + '.json');
const store = {
  get: async (k) => { try { return JSON.parse(readFileSync(file(k), 'utf8')); } catch { return null; } },
  put: async (k, v) => { const f = file(k); writeFileSync(f + '.tmp', JSON.stringify(v)); renameSync(f + '.tmp', f); },
  delete: async (k) => { try { unlinkSync(file(k)); } catch { /* gone */ } },
  list: async () => readdirSync(dir).filter((n) => n.endsWith('.json')).map((n) => { try { return JSON.parse(readFileSync(resolve(dir, n), 'utf8')); } catch { return null; } }).filter(Boolean),
};

// the pre-signatures from the API
const source = { list: async () => { const r = await fetch(`${API}/take-presig`, { signal: AbortSignal.timeout(20000) }); if (!r.ok) throw new Error(`the API answered ${r.status}`); return (await r.json()).presigs || []; } };

// Bitcoin through the explorers: a read is tried at each base in turn, a broadcast goes to every one
async function ask(path, init) {
  let last;
  for (const b of BASES) {
    try { const r = await fetch(b + path, { ...init, signal: AbortSignal.timeout(20000) }); if (r.ok || r.status === 404) return r; last = new Error(`${b} answered ${r.status}`); } catch (e) { last = e; }
  }
  throw last || new Error('no explorer answered');
}
const json = async (path) => { const r = await ask(path); if (r.status === 404) return null; return r.json(); };
const chain = {
  outspend: async (txid, vout) => { const j = await json(`/tx/${txid}/outspend/${vout}`); return j && j.spent ? j.txid : null; },
  outputSpk: async (txid, vout) => { const tx = await json(`/tx/${txid}`); return tx && tx.vout && tx.vout[vout] ? tx.vout[vout].scriptpubkey : null; },
  status: async (txid) => { const s = await json(`/tx/${txid}/status`); if (!s || !s.confirmed) return { confirmations: 0 }; const tip = Number(await (await ask('/blocks/tip/height')).text()); return { confirmations: tip - s.block_height + 1 }; },
  feeRate: async () => { const f = await json('/v1/fees/recommended').catch(() => null); if (f && f.fastestFee) return Math.max(2, Math.ceil(f.fastestFee)); const e = await json('/fee-estimates'); return Math.max(2, Math.ceil((e && (e['1'] || e['2'])) || 5)); },
  broadcast: async (hex) => {
    let ok = false, err = null;
    await Promise.all(BASES.map(async (b) => { try { const r = await fetch(b + '/tx', { method: 'POST', body: hex, signal: AbortSignal.timeout(20000) }); if (r.ok) ok = true; else err = new Error(await r.text()); } catch (e) { err = e; } }));
    if (!ok) throw err || new Error('no explorer took the transaction');
  },
};

// the pool, read as the provider's own client reads it (the claim's kernel from the settle, with the nodes that must agree)
const { secp, sha256, keccak_256, hmac } = await import('../../dapp/vendor/tacit-deps.min.js');
secp.etc.hmacSha256Sync = (k, ...m) => hmac(sha256, k, secp.etc.concatBytes(...m));
const { makeConfidentialPoolUx } = await import('../../dapp/confidential-pool-ux.js');
const { setActiveNetwork } = await import('../../dapp/confidential-deployments.js');
const { makeFastBridgeEvm, makeTxTracer, makeNodeQuorum, TRACE_NODES, AGREE_NODES } = await import('../../dapp/fastbridge-evm.js');
setActiveNetwork('mainnet');
const ux = makeConfidentialPoolUx({ secp, keccak256: keccak_256, sha256, fetchImpl: (u, o) => fetch(u, o), network: 'mainnet' });
const trace = list(env.TAKE_WATCHER_TRACE_RPCS), agree = list(env.TAKE_WATCHER_AGREE_RPCS);
if (!trace.length) trace.push(...TRACE_NODES);
if (!agree.length) agree.push(...AGREE_NODES);
if (agree.length < 2) { console.error('TAKE_WATCHER_AGREE_RPCS must name two Ethereum nodes or more'); process.exit(1); }
// (it signs and sends nothing on Ethereum: the key and the seed are made here for the module's sake and are used for nothing)
const throwaway = crypto.getRandomValues(new Uint8Array(32));
const evm = makeFastBridgeEvm({
  ux, secp, keccak256: keccak_256, hmacSha256: (k, m) => hmac(sha256, k, m), walletPriv: throwaway, seed: throwaway, asset: '0x' + '00'.repeat(32), poolAddress: ux.cfg.pool,
  log, trace: makeTxTracer({ nodes: trace, pool: ux.cfg.pool }), quorum: makeNodeQuorum({ nodes: agree }),
});
const pool = { findClaim: (nu, o) => evm.findClaim(nu, o) };

// an optional coin of its own for fees
let funder = null;
if (/^[0-9a-f]{64}$/i.test(String(env.TAKE_WATCHER_FUND_KEY || '').trim())) {
  const { makeBtcWallet } = await import('../../dapp/bitcoin-taproot-wallet.js');
  const prims = makeBtcWallet({ priv: Uint8Array.from(String(env.TAKE_WATCHER_FUND_KEY).trim().match(/../g).map((x) => parseInt(x, 16))), hrp: 'bc', fetchUtxos: async () => [], broadcastTx: async () => { throw new Error('not used'); }, fetchFeeRate: async () => 1 }).prims;
  const address = prims.wallet.address();
  funder = {
    changeSpk: prims.p2wpkhScript(prims.wallet.pub),
    coins: async () => ((await json(`/address/${address}/utxo`)) || []).filter((u) => u.status && u.status.confirmed).map((u) => ({ txid: u.txid, vout: u.vout, value: u.value })),
    sign: (tx, inputs) => inputs.map((i, k) => prims.signP2wpkhInput(tx, k + 1, i.value)),
  };
  log({ msg: 'take watcher: fee coins from', address });
}

const watcher = makeTakeWatcher({ source, pool, chain, store, funder, log, policy: { maxFundSats: Number(env.TAKE_WATCHER_MAX_FUND_SATS || 20000) } });
log({ msg: 'take watcher: running', api: API, everySecs: EVERY, funded: !!funder });
let busy = false;
const tick = async () => { if (busy) return; busy = true; try { log({ msg: 'take watcher: pass', ...(await watcher.pass()) }); } catch (e) { log({ level: 'warn', msg: 'take watcher: pass failed', why: String((e && e.message) || e).slice(0, 200) }); } finally { busy = false; } };
tick();
setInterval(tick, EVERY * 1000);
