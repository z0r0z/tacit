// Dapp-side orchestration for the confidential-pool UX — mainnet (pool 0x…0Ed1eabD) and the
// Sepolia signet pilot, selected via confidential-deployments.js's active network. Wires
// the already-built primitives into one tab-facing API so tacit.js stays a thin renderer over the LIVE pool:
//   - evm-account        → the persistent per-network EVM identity derived from the Tacit wallet scalar
//   - confidential-evm-log + confidential-indexer → seed-only confidential balance from the pool's logs
//   - confidential-relay → the settle queue (transfer/swap/lp/otc/bid) on api.tacit.finance
// The wrap (on-chain deposit) + transfer/unwrap BUILD paths layer the op assemblers + evm-tx on top of
// this; this module owns the read path (account + balance) + the live config + the settle/RPC handles.

import { getConfidentialDeployment, activeNetwork, syncProtectedOutpoints, shownTicker } from './confidential-deployments.js';
import { makeEvmAccount } from './evm-account.js';
import { makeConfidentialIndexer } from './confidential-indexer.js';
import { makeConfidentialEvmLog } from './confidential-evm-log.js';
import { makeConfidentialRelay } from './confidential-relay.js';
import { makeEvmTx } from './evm-tx.js';
import { makeRecoveryGuard } from './confidential-recovery-guard.js';
import { makeConfidentialRouter } from './confidential-router.js';
import { makeConfidentialTransfer } from './confidential-transfer.js';
import { makeConfidentialRoute } from './confidential-route.js';
import { makeConfidentialSwap } from './confidential-swap.js';
import { makeConfidentialSwapCoordinator } from './confidential-swap-coordinator.js';
import { makeConfidentialLp } from './confidential-lp.js';
import { makeConfidentialCdp } from './confidential-cdp.js';
import { makeConfidentialFarm } from './confidential-farm.js';
import { makeConfidentialFarmProgram } from './confidential-farm-program.js';
import { makeConfidentialDefiActions } from './confidential-defi-actions.js';
import { makeConfidentialStealth } from './confidential-stealth.js';
import { makeConfidentialAirdrop } from './confidential-airdrop.js';
import { makeTacAirdrop, makeRpcCall as makeAirdropRpcCall } from './tac-airdrop.js';
import { makeConfidentialLockScan } from './confidential-lock-scan.js';
import { makeConfidentialBridgeMint } from './confidential-bridge-mint.js';
import { makeBridgeBurnBroadcaster } from './bridge-burn-broadcast.js';
import { signSchnorr, SECP_N } from './bulletproofs.js';
import { randomScalar, bppGens, G as BPP_G } from './bulletproofs-plus.js';
import { hmac, sha256 as vendorSha256 } from './vendor/tacit-deps.min.js';
import { makeConfidentialRecovery, privBytes, deriveOutputKeys } from './confidential-recovery.js';
import { makeImportedFarmStore } from './confidential-secret-store.js';
import { makeBtcHistoryProvider } from './confidential-recovery-btc.js';
import { makeCbtcNoteRecovery } from './cbtc-note-recovery.js';

// The confidential deployment + asset register live in confidential-deployments.js (the single source the
// deploy sync patches); this module consumes a resolved record via getConfidentialDeployment(network).

// Public TAC held outside the Tacit wallet's own account (a connected Ethereum wallet) also counts toward the
// holder exit rate. Shared by every ux instance: the app registers one function returning those addresses,
// and each balance() scan asks it.
let _externalTacHolders = () => [];
export function setExternalTacHolders(fn) { _externalTacHolders = typeof fn === 'function' ? fn : () => []; }

// Where a pool's chain-final logs are kept between visits: IndexedDB in a browser, nothing elsewhere. Every call settles
// (a failure reads as nothing kept), so a browser that refuses storage just reads the chain each visit as before.
let _logDb = null;
function browserLogStore() {
  if (typeof indexedDB === 'undefined') return null;
  const open = () => (_logDb ||= new Promise((res, rej) => {
    const r = indexedDB.open('tacit-pool-logs', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('q');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
    r.onblocked = () => rej(new Error('log store blocked'));
  }));
  const run = (mode, fn) => open().then((db) => new Promise((res, rej) => {
    const t = db.transaction('q', mode), req = fn(t.objectStore('q'));
    t.oncomplete = () => res(req.result);
    t.onerror = t.onabort = () => rej(t.error);
  }));
  return { get: (k) => run('readonly', (st) => st.get(k)), put: (k, v) => run('readwrite', (st) => st.put(v, k)), del: (k) => run('readwrite', (st) => st.delete(k)) };
}

// `logStore` ({ get, put, del }, each returning a promise) replaces the browser's IndexedDB store for chain-final logs;
// null keeps none.
export function makeConfidentialPoolUx({ secp, keccak256, sha256, fetchImpl, network, logStore } = {}) {
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
  // The wallet keys this instance has been handed, by the pubkey memos are sealed to (filled by identity()), so the
  // recovery guard can open a memo sealed to one of them and check it opens to its leaf. A pubkey not in the map is
  // someone else's (a recipient output) and is checked for length only.
  const _ownKeys = new Map();
  const guard = makeRecoveryGuard({ memo, openKeyFor: (pub) => _ownKeys.get(String(pub).toLowerCase()) || null });
  const relay = makeConfidentialRelay({ base: cfg.relayBase, fetchImpl: _fetch, guard, checkEmittedMemos, saveMismatchedMemos });
  // A relay that emitted different memos than the ones sealed here leaves those notes unrecoverable from the
  // chain; the sealed memos (openable with this wallet's keys) are kept locally under the settle's tx hash.
  const SAVED_MEMOS_PREFIX = 'tacit:unrecoverable-memos:';
  function saveMismatchedMemos({ txHash, leaves, memos }) {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(`${SAVED_MEMOS_PREFIX}${txHash}`, JSON.stringify({ leaves, memos, savedAt: Date.now() }));
  }
  // The memos kept by saveMismatchedMemos, by leaf. A memo is only ever accepted for a leaf after it opens to
  // that exact leaf (memo.openMemo authenticates against the leaf hash), so an entry that does not belong is inert.
  function savedMemosByLeaf() {
    const byLeaf = new Map();
    try {
      if (typeof localStorage === 'undefined') return byLeaf;
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k || !k.startsWith(SAVED_MEMOS_PREFIX)) continue;
        let rec; try { rec = JSON.parse(localStorage.getItem(k)); } catch { continue; }
        if (!rec || !Array.isArray(rec.leaves) || !Array.isArray(rec.memos)) continue;
        rec.leaves.forEach((lf, j) => { if (typeof rec.memos[j] === 'string') byLeaf.set(String(lf).toLowerCase(), rec.memos[j]); });
      }
    } catch { /* storage unavailable: nothing saved to apply */ }
    return byLeaf;
  }
  // The events with each saved memo standing in for the memo the chain carries under the same leaf, so a note whose
  // emitted memo was replaced is still recovered on the device that kept the sealed one. New objects; the input is
  // not modified.
  function withSavedMemos(events) {
    const saved = savedMemosByLeaf();
    if (!saved.size) return events;
    return events.map((ev) => {
      if (!ev || ev.type !== 'LeavesInserted' || !Array.isArray(ev.leaves) || !ev.leaves.some((lf) => saved.has(String(lf).toLowerCase()))) return ev;
      return { ...ev, memos: ev.leaves.map((lf, i) => saved.get(String(lf).toLowerCase()) ?? ev.memos[i]) };
    });
  }
  // After a relayed settle: the memo the pool emitted for each of our leaves must be byte-identical to the one
  // sealed here (the relay chooses the memo hashes it proves, so it could substitute a memo consistently).
  async function checkEmittedMemos({ txHash, leaves, memos }) {
    // Retry before giving up. A single failed receipt read turns "verified" into "unverified" — and since the
    // caller only throws on ok === false, an `ok: null` used to pass through as a success-looking result with
    // the sealed memos dropped. A settle receipt is available from any node, so one flaky response is not a
    // reason to stop checking; the relay is also the party with the most to gain from this read failing.
    let receipt = null;
    for (let attempt = 0; attempt < 3 && !receipt; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, 400 * attempt));
      try { receipt = await rpc('eth_getTransactionReceipt', [txHash]); } catch { /* reported as unchecked */ }
    }
    if (!receipt || !Array.isArray(receipt.logs)) return { ok: null, mismatched: [], reason: 'receipt unavailable' };
    const emitted = new Map();
    for (const log of receipt.logs) {
      if (cfg.pool && String(log.address || '').toLowerCase() !== String(cfg.pool).toLowerCase()) continue;
      const ev = evmLog.decodeLog(log);
      if (!ev || ev.type !== 'LeavesInserted') continue;
      ev.leaves.forEach((lf, i) => emitted.set(String(lf).toLowerCase(), String(ev.memos[i] ?? '0x').toLowerCase()));
    }
    const norm = (m) => '0x' + String(m ?? '').replace(/^0x/, '').toLowerCase();
    // A memo with other bytes that opens to the same leaf under one of this wallet's own keys recovers the note just as
    // well. That is what an op submitted twice looks like: the relay keeps the first submission's job and its memos, and
    // each build seals afresh. A memo sealed to anyone else is held to the exact bytes.
    const opensHere = (leaf, m) => [..._ownKeys.values()].some((priv) => !!memo.openMemo(priv, leaf, m));
    const mismatched = [];
    leaves.forEach((lf, i) => {
      const got = emitted.get(String(lf).toLowerCase());
      if (got !== undefined && (got === norm(memos[i]) || opensHere(lf, got))) return;
      mismatched.push({ index: i, leaf: lf, expected: norm(memos[i]), emitted: got ?? null });
    });
    return { ok: mismatched.length === 0, mismatched };
  }

  // Only assets with a deployed assetId are usable in the pool (cTAC/cBTC/cUSD are declared but null until
  // the suite deploys; the public TAC ERC20 is not a pool note asset).
  const _poolAssets = cfg.assets.filter((a) => a.assetId);
  const assetByTicker = Object.fromEntries(_poolAssets.map((a) => [a.ticker, a]));

  // The user's persistent Sepolia EVM account (domain-separated derivation from the Tacit wallet scalar —
  // unlinkable from the Bitcoin address). Used to sign wrap deposits + own confidential notes.
  function account(walletPriv) { return evm.deriveEvmAccount(walletPriv, cfg.evmNetwork); }

  // JSON-RPC over the pool's endpoint list. Every request has a timeout, so one unresponsive endpoint can't stall a
  // call, and a failed pass over the list is retried: a bare "Internal error" from eth_getLogs is often transient. An
  // endpoint that doesn't answer (a timeout, a refused connection, an HTTP error, a rate limit) goes to the back of the
  // list for a minute, so while it is down each call goes straight to one that works instead of waiting it out first.
  // A JSON-RPC error is an answer (a revert, a range it won't serve) and sends nothing to the back.
  const RPC_COOL_MS = 60000;
  const _eps = cfg.rpcs.map((url) => ({ url, coolUntil: 0, span: Infinity }));
  const _byHealth = () => { const now = Date.now(); return [..._eps.filter((e) => e.coolUntil <= now), ..._eps.filter((e) => e.coolUntil > now)]; };
  async function _post(ep, method, params, ms = 10000) {
    let r;
    try {
      r = await _fetch(ep.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(ms) });
    } catch (e) {
      throw Object.assign(new Error((e && e.message) || String(e)), { kind: 'transport', timeout: !!e && (e.name === 'TimeoutError' || e.name === 'AbortError') });
    }
    let j = null;
    try { j = await r.json(); } catch { /* not JSON */ }
    if (j && j.error) {
      const msg = String(j.error.message || 'rpc error');
      throw Object.assign(new Error(msg), { kind: r.status === 429 || /rate limit|too many requests|usage limit|requests per/i.test(msg) ? 'busy' : 'rpc' });
    }
    if (!r.ok || !j) throw Object.assign(new Error(`rpc ${r.status}`), { kind: r.status === 429 ? 'busy' : 'http' });
    return j.result;
  }
  async function rpc(method, params, { retryPasses = 2 } = {}) {
    if (!_fetch) throw new Error('no fetch implementation');
    let lastErr;
    for (let pass = 0; pass < retryPasses; pass++) {
      if (pass > 0) await new Promise((res) => setTimeout(res, 400 * pass));
      for (const ep of _byHealth()) {
        try { return await _post(ep, method, params); } catch (e) { lastErr = e; if (e.kind !== 'rpc') ep.coolUntil = Date.now() + RPC_COOL_MS; }
      }
    }
    throw lastErr || new Error('all RPCs failed');
  }

  function ethCall(to, data) { return rpc('eth_call', [{ to: String(to).toLowerCase(), data }, 'latest']); }

  // eth_getLogs over [from, to] in as few requests as the endpoints allow. Each endpoint is asked for the whole remaining
  // range first. One that won't serve a range that wide either names its cap ("max range: 800"), which it keeps for the
  // session, or says the answer is too large, and the range halves until it fits. Endpoints with no known cap go first.
  // Ranges are read in ascending order and each answer is in block and log order, so the result is in chain order.
  function _narrower(e, span) {
    if (e.kind === 'transport') return e.timeout && span > 2000 ? { span: Math.floor(span / 2) } : null;
    if (e.kind !== 'rpc') return null;
    const cap = e.message.match(/(?:max(?:imum)?\b\D{0,24}|\bover\s+|\bup to\s+|limited to\s+(?:a\s+)?)([\d,]{2,})/i);
    if (cap) { const n = Number(cap[1].replace(/,/g, '')); return n < span ? { span: n, cap: n } : null; }
    return /too (large|wide|big|many)|exceed|more than|response size/i.test(e.message) && span > 1 ? { span: Math.floor(span / 2) } : null;
  }
  async function _logsIn(params, from, to) {
    const out = [];
    for (let start = from, lastErr = null; start <= to;) {
      let got = null;
      for (let pass = 0; pass < 2 && !got; pass++) {
        if (pass > 0) await new Promise((res) => setTimeout(res, 400));
        const now = Date.now();
        const eps = _eps.map((e, i) => [e, i]).sort(([a, i], [b, j]) => (a.coolUntil > now) - (b.coolUntil > now) || (a.span < b.span) - (a.span > b.span) || i - j).map(([e]) => e);
        for (const ep of eps) {
          let span = Math.min(to - start + 1, ep.span);
          for (let tries = 0; tries < 16 && !got; tries++) {
            const end = start + span - 1;
            try {
              const logs = await _post(ep, 'eth_getLogs', [{ ...params, fromBlock: '0x' + start.toString(16), toBlock: '0x' + end.toString(16) }], 25000);
              got = { logs: Array.isArray(logs) ? logs : [], end };
            } catch (e) {
              lastErr = e;
              const n = _narrower(e, span);
              if (!n) { if (e.kind !== 'rpc') ep.coolUntil = Date.now() + RPC_COOL_MS; break; }
              if (n.cap) ep.span = Math.min(ep.span, n.cap);
              span = n.span;
            }
          }
          if (got) break;
        }
      }
      if (!got) throw lastErr || new Error('eth_getLogs: no endpoint answered');
      out.push(...got.logs);
      start = got.end + 1;
    }
    return out;
  }

  // Logs by query, kept for the session and, once FINAL blocks deep, across visits. Every scan (balance, recover and
  // each deep-recovery walk) reads the pool's history from its deploy block, so without this each would re-read all of
  // it. A query's logs up to FINAL blocks behind the last block read are chain-final and reused as they are; each read
  // re-reads the rest, so neither a reorg nor an endpoint lagging behind the head can leave a log out for good. The kept
  // logs are only a cache: scanning still runs over the whole stream every time, so this can make it faster but never
  // change what it finds. A stream carried over from an earlier visit is checked against the chain before it is used:
  // its LeavesInserted must follow on from one another and add up to the pool's leaf count, or it is read afresh.
  const FINAL = 64;
  const _logsCache = new Map(); // key -> { toBlock, logs, stored }
  const _kept = logStore === undefined ? browserLogStore() : logStore;
  const _keptAt = new Map();
  const _qkey = (params, from) => `${cfg.chainId}|${String(cfg.pool).toLowerCase()}|${JSON.stringify(params.address)}|${JSON.stringify(params.topics)}|${from}`;
  const _blockOf = (l) => Number(BigInt(l.blockNumber));
  async function _leavesAddUp(params, from, logs, to) {
    const T = String(evmLog.TOPIC0.LeavesInserted).toLowerCase(), pool = String(cfg.pool).toLowerCase();
    const t0 = params.topics && params.topics[0];
    if (t0 != null && !(Array.isArray(t0) ? t0 : [t0]).some((t) => String(t).toLowerCase() === T)) return null;
    if (from > Number(cfg.deployBlock || 0)) return null;
    let next = 0;
    for (const l of logs) {
      if (String((l.topics || [])[0] || '').toLowerCase() !== T || String(l.address || pool).toLowerCase() !== pool) continue;
      const ev = evmLog.decodeLog(l);
      if (!ev || Number(ev.firstLeafIndex) !== next) return false;
      next += ev.leaves.length;
    }
    try { return next === Number(BigInt(await rpc('eth_call', [{ to: cfg.pool, data: '0x0be4f422' }, '0x' + to.toString(16)]))); } catch { return null; }
  }
  async function getLogsChunked(params, from, to) {
    const key = _qkey(params, from);
    let cached = _logsCache.get(key);
    if (!cached && _kept) {
      const rec = await _kept.get(key).catch(() => null);
      if (rec && rec.v === 1 && Array.isArray(rec.logs) && Number.isFinite(rec.finalTo)) _logsCache.set(key, cached = { toBlock: rec.finalTo + FINAL, logs: rec.logs, stored: true });
    }
    if (cached && !cached.stored && to <= cached.toBlock - FINAL) return cached.logs.filter((l) => _blockOf(l) <= to);
    const walkFrom = cached ? Math.max(from, cached.toBlock - FINAL + 1) : from;
    let logs = [...(cached ? cached.logs.filter((l) => _blockOf(l) < walkFrom) : []), ...(await _logsIn(params, walkFrom, to))].filter((l) => _blockOf(l) <= to);
    let sound = true;
    if (cached && cached.stored && (await _leavesAddUp(params, from, logs, to)) === false) {
      logs = await _logsIn(params, from, to);
      sound = (await _leavesAddUp(params, from, logs, to)) !== false;
      if (_kept) _kept.del(key).catch(() => {});
    }
    _logsCache.set(key, { toBlock: to, logs });
    // Kept at most once a minute per query, and only what is final.
    if (_kept && sound && Date.now() - (_keptAt.get(key) || 0) > 60000) {
      _keptAt.set(key, Date.now());
      _kept.put(key, { v: 1, finalTo: to - FINAL, logs: logs.filter((l) => _blockOf(l) <= to - FINAL) }).catch(() => {});
    }
    return logs;
  }
  async function headBlock() { return parseInt(await rpc('eth_blockNumber', []), 16); }
  // The pool's event stream, read as one query whatever a caller includes (so balance, recover and every other scan share
  // one read), then narrowed to what the caller asked for: the note stream (LeavesInserted, NullifiersSpent,
  // LockLeavesInserted), plus 'wraps' (Wrap deposits), 'cdp' (position inserts), 'crossouts' (CrossOutRecorded) and 'bonds'
  // (the farm manager's Bonded and Harvested; a second contract, so each log is kept only if it came from the contract that
  // owns its event).
  async function fetchEvents({ fromBlock = cfg.deployBlock, toBlock = 'latest', include = [] } = {}) {
    const from = typeof fromBlock === 'number' ? fromBlock : parseInt(String(fromBlock), 16);
    const to = toBlock === 'latest' ? await headBlock() : (typeof toBlock === 'number' ? toBlock : parseInt(String(toBlock), 16));
    const inc = new Set(include);
    const T = evmLog.TOPIC0;
    const manager = cfg.farm && cfg.farm.manager ? String(cfg.farm.manager).toLowerCase() : null;
    const all = [T.LeavesInserted, T.NullifiersSpent, T.LockLeavesInserted, T.Wrap, T.CdpPositionInserted, T.CrossOutRecorded, ...(manager ? [T.Bonded, T.Harvested] : [])];
    const want = new Set([T.LeavesInserted, T.NullifiersSpent, T.LockLeavesInserted,
      ...(inc.has('wraps') ? [T.Wrap] : []), ...(inc.has('cdp') ? [T.CdpPositionInserted] : []), ...(inc.has('crossouts') ? [T.CrossOutRecorded] : []),
      ...(inc.has('bonds') && manager ? [T.Bonded, T.Harvested] : [])].map((t) => String(t).toLowerCase()));
    const managerTopics = new Set([T.Bonded, T.Harvested].map((t) => String(t).toLowerCase()));
    const poolLc = String(cfg.pool).toLowerCase();
    const logs = (await getLogsChunked({ address: manager ? [cfg.pool, cfg.farm.manager] : cfg.pool, topics: [all] }, from, to)).filter((l) => {
      const t = String((l.topics || [])[0] || '').toLowerCase(), a = String(l.address || '').toLowerCase();
      if (!want.has(t)) return false;
      if (managerTopics.has(t)) return !!manager && a === manager;
      return !inc.size || !a || a === poolLc;
    });
    return evmLog.decodeLogs(logs);
  }

  // ── key-only recovery ──
  // A note reaches a wallet through a memo sealed to its key (the normal channel) or, where the op derives the note from the
  // key plus public chain data, through a walk over that data (confidential-recovery.js): wrap deposits, send-and-unwrap
  // change, bridge-mint destinations and cBTC bearer notes. Every walk accepts a candidate only when its recomputed leaf is
  // one the chain inserted. `_scanNotes` runs them over one event stream; balance() and recover() both build on it.
  const lc = (h) => String(h == null ? '' : h).toLowerCase();
  // HMAC keys the derivations below; it needs the hash the HMAC implementation was built with (the bundle's), which the
  // injected `sha256` (any Uint8Array -> Uint8Array function) need not be.
  const _cbtcRec = makeCbtcNoteRecovery({ hmac, sha256: vendorSha256, curveOrder: SECP_N });
  let _rec = null;
  const recovery = () => _rec || (_rec = makeConfidentialRecovery({
    pool, memo, keccak256, secp, hmac, sha256: vendorSha256, curveOrder: SECP_N, lockScan: _lockScan, airdrop: _airdrop, cdp: _cdp,
    bpp: { H: bppGens().H, G: BPP_G },
  }));
  const _rev = (h) => (String(h).replace(/^0x/, '').match(/../g) || []).reverse().join('');
  // Bridge-mint walk memo. Recovered notes are keyed `${wallet}:${leaf}` and re-added on a rescan without searching; leaves
  // the cheap balance-read pass / the full pass searched without a match are keyed `${wallet}:${amounts}:${leaf}`, so a
  // second wallet in the same tab, or a newly known amount, searches afresh.
  const _bridgeFound = new Map();
  const _bridgeFastTried = new Set();
  const _bridgeTried = new Set();
  // Amounts a bridge-mint search tries besides the round ones, per key: what this browser's bridge journal recorded
  // (burndep-ux; every page on this origin shares it) and amounts added by hand (addBridgeAmountHint). The value is hidden
  // in the minted commitment, so an amount like 1,234.5 TAC is found only once it is tried; a wrong one costs a hash.
  const _netName = network || activeNetwork();
  const _bridgeHintKeys = (pubHex) => {
    const p = lc(pubHex).replace(/^0x/, '');
    return { journal: `tacit-burndep-bridge-v1:${_netName}:${p}`, own: `tacit-bridge-amounts-v1:${_netName}:${p}` };
  };
  function _storedBridgeAmounts(pubHex) {
    if (typeof localStorage === 'undefined') return [];
    const k = _bridgeHintKeys(pubHex), out = [];
    const num = (v) => { const x = v && typeof v === 'object' ? v.__big : v; return /^\d+$/.test(String(x ?? '')) ? String(x) : null; };
    try { for (const r of JSON.parse(localStorage.getItem(k.journal) || '[]') || []) for (const v of [r?.source?.amount, r?.dest?.value]) { const x = num(v); if (x) out.push(x); } } catch {}
    try { for (const v of JSON.parse(localStorage.getItem(k.own) || '[]') || []) { const x = num(v); if (x) out.push(x); } } catch {}
    return out;
  }
  // Remember an amount (in-system base units) to try for this key's bridged notes, on this browser. Returns false when
  // there is no storage to keep it in (the caller can still pass it as `bridgeAmounts` for one scan).
  function addBridgeAmountHint(walletPriv, amount) {
    const v = BigInt(amount);
    if (v <= 0n) throw new Error('addBridgeAmountHint: amount must be positive');
    if (typeof localStorage === 'undefined') return false;
    const k = _bridgeHintKeys(identity(walletPriv).pubHex).own;
    let list = [];
    try { list = JSON.parse(localStorage.getItem(k) || '[]') || []; } catch {}
    if (!list.includes(v.toString())) list.push(v.toString());
    try { localStorage.setItem(k, JSON.stringify(list.slice(-32))); return true; } catch { return false; }
  }
  const _btcHistoryCache = new Map();
  const BTC_HISTORY_TTL_MS = 10 * 60 * 1000;
  function _defaultBtcHistory(priv) {
    const key = _hex(privBytes(priv));
    const hit = _btcHistoryCache.get(key);
    if (hit && Date.now() - hit.at < BTC_HISTORY_TTL_MS) return hit.promise;
    const provider = makeBtcHistoryProvider({ fetchImpl: _fetch, sha256, hrp: Number(cfg.chainId) === 1 ? 'bc' : 'tb' });
    const promise = provider.history(priv);
    const entry = { at: Date.now(), promise };
    _btcHistoryCache.set(key, entry);
    promise.catch(() => { entry.at = Date.now() - BTC_HISTORY_TTL_MS + 60000; }); // retry a failed lookup after a minute
    return promise;
  }
  const _lockVBtcCache = new Map();
  async function _cbtcLockVBtc(txid, vout) {
    const outpoint = pool.outpointKey('0x' + _rev(txid), vout);
    if (_lockVBtcCache.has(outpoint)) return { outpoint, vBtc: _lockVBtcCache.get(outpoint) };
    const r = await ethCall(cfg.pool, '0x' + _selector('cbtcLockVBtc(bytes32)') + _word(outpoint));
    const vBtc = BigInt(r && r !== '0x' ? r : '0x0');
    if (vBtc > 0n) _lockVBtcCache.set(outpoint, vBtc);
    return { outpoint, vBtc };
  }

  // The pool's own record of one lock: its value plus the two states that retire it. vBtc is cacheable (it is
  // written once, at fold time); spent/redeemed are not, since either can land at any later block.
  async function cbtcLockState(txid, vout) {
    const { outpoint, vBtc } = await _cbtcLockVBtc(txid, vout);
    if (vBtc <= 0n) return { outpoint, vBtc, spent: false, redeemed: false };
    const flag = async (sig) => {
      const r = await ethCall(cfg.pool, '0x' + _selector(sig) + _word(outpoint));
      return !!(r && r !== '0x' && BigInt(r) !== 0n);
    };
    return { outpoint, vBtc, spent: await flag('cbtcLockSpent(bytes32)'), redeemed: await flag('cbtcLockRedeemed(bytes32)') };
  }

  // Rebuild the coin-selection reservation for this wallet's live cBTC locks from chain state. The local
  // registry is a browser-scoped cache, so on a second device or after a cleared cache it is empty and a
  // lock reads as ordinary spendable change — spending one is folded as a rug and slashes its escrow with no
  // cure path. The lock outputs come from the wallet's own public Bitcoin history and the pool says which of
  // them are still live, which is also what releases a redeemed lock from the set.
  async function syncCbtcLockReservations(walletPriv, { btcHistory = null } = {}) {
    const id = identity(walletPriv);
    const h = typeof btcHistory === 'function' ? await btcHistory(id.priv) : (btcHistory || await _defaultBtcHistory(id.priv));
    return syncProtectedOutpoints({ lockOutputs: h.lockOutputs || [], lockState: cbtcLockState });
  }

  // Many reads in one eth_call through Multicall3 (the same address on every chain this runs on). A read that reverts
  // comes back null.
  const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
  async function _multicall(calls) {
    if (!calls.length) return [];
    const bodies = calls.map(({ to, data }) => {
      const d = String(data).replace(/^0x/, '');
      return _word(to) + _word(1n) + _word(0x60n) + _word(BigInt(d.length / 2)) + d.padEnd(Math.ceil(d.length / 64) * 64, '0');
    });
    let off = calls.length * 32;
    const heads = bodies.map((b) => { const o = _word(BigInt(off)); off += b.length / 2; return o; });
    const out = String(await ethCall(MULTICALL3, '0x82ad56cb' + _word(0x20n) + _word(BigInt(calls.length)) + heads.join('') + bodies.join(''))).replace(/^0x/, '');
    const at = (i) => BigInt('0x' + (out.slice(i * 64, i * 64 + 64) || '0'));
    const arr = Number(at(0)) / 32;
    return calls.map((_, i) => {
      const e = arr + 1 + Number(at(arr + 1 + i)) / 32;
      if (at(e) !== 1n) return null;
      const b = e + Number(at(e + 1)) / 32, len = Number(at(b));
      return '0x' + out.slice(64 * (b + 1), 64 * (b + 1) + len * 2);
    });
  }

  // ── cBTC bonds ──
  // A lock's bond is wstETH the CollateralEngine holds for it. It is posted through the escrow helper, which keeps each
  // depositor's own share and hands it back to them; through an earlier helper, which still hands back what it took; or
  // on the engine directly. cbtcBonds gathers every lock this key has made and every bond the given accounts (the key's
  // own Tacit account is always one) posted, however posted, and says what each bond can do now:
  //   pending   not minted against yet: the bond can be taken back, and minting then waits for a new one
  //   backing   minted, lock still held: the bond backs that cBTC until the lock is redeemed
  //   free      redeemed, or spent before any mint: the bond can be taken back
  //   forfeit   spent on Bitcoin without a redemption: the bond can't come back, it belongs to the insurance reserve
  //   slashed   moved to the insurance reserve
  // `everyday` marks a lock still held at the wallet's ordinary address (early locks paid their BTC there): this app never
  // spends it, but another wallet using the same key would see it as spendable. `health` is set only while the engine's
  // margin call is armed.
  const _topic = (sig) => '0x' + _hex(keccak256(new TextEncoder().encode(sig)));
  const _addrTopic = (a) => '0x' + '0'.repeat(24) + String(a).replace(/^0x/, '').toLowerCase();
  let _btcScripts = null;
  async function cbtcBonds(walletPriv, { accounts = [], btcHistory = null } = {}) {
    const engine = lc(cfg.collateralEngine);
    if (!engine || !cfg.pool) return { maintenanceBps: 0n, graceWindow: 0n, locks: [] };
    const id = identity(walletPriv);
    const helpers = [[cfg.cbtcEscrowHelper, 'helper'], ...(cfg.cbtcEscrowHelpersRetired || []).map((a) => [a, 'retired'])].filter(([a]) => a).map(([a, src]) => [lc(a), src]);
    const accts = [...new Set([account(walletPriv).address, ...accounts].filter(Boolean).map(lc))];
    const history = typeof btcHistory === 'function' ? btcHistory(id.priv) : Promise.resolve(btcHistory || _defaultBtcHistory(id.priv));
    const [hist, posts] = await Promise.all([
      history.catch(() => null),
      headBlock().then((to) => getLogsChunked({
        address: [engine, ...helpers.map(([a]) => a)],
        topics: [[_topic('EscrowPosted(bytes32,address,uint256)'), _topic('HelperEscrowPosted(bytes32,address,uint256)')], null, accts.map(_addrTopic)],
      }, Number(cfg.deployBlock || 0), to)),
    ]);
    _btcScripts ||= makeBtcHistoryProvider({ fetchImpl: _fetch, sha256, hrp: Number(cfg.chainId) === 1 ? 'bc' : 'tb' });
    const everydaySpk = _hex(_btcScripts.walletScripts(id.priv).funding).toLowerCase();
    const outputs = new Map();
    for (const o of hist?.lockOutputs || []) outputs.set(lc(pool.outpointKey('0x' + _rev(o.txid), o.vout)), o);
    const ops = [...new Set([...outputs.keys(), ...posts.map((l) => lc(l.topics[1]))])];
    const own = [[cfg.pool, 'cbtcLockVBtc(bytes32)'], [cfg.pool, 'cbtcMinted(bytes32)'], [cfg.pool, 'cbtcLockSpent(bytes32)'], [cfg.pool, 'cbtcLockRedeemed(bytes32)'],
      [engine, 'escrowTotal(bytes32)'], [engine, 'escrowSlashed(bytes32)']];
    const shares = [...helpers.flatMap(([contract, src]) => accts.map((acct) => ({ contract, src, acct, sig: 'helperEscrowOf(bytes32,address)' }))),
      ...accts.map((acct) => ({ contract: engine, src: 'engine', acct, sig: 'escrowOf(bytes32,address)' }))];
    const per = own.length + shares.length;
    const r = await _multicall([
      { to: engine, data: '0x' + _selector('escrowMaintenanceBps()') },
      ...ops.flatMap((op) => [
        ...own.map(([to, sig]) => ({ to, data: '0x' + _selector(sig) + _word(op) })),
        ...shares.map((s) => ({ to: s.contract, data: '0x' + _selector(s.sig) + _word(op) + _word(s.acct) })),
      ]),
    ]);
    const n = (x) => (x && x !== '0x' ? BigInt(x.slice(0, 66)) : 0n);
    const maintenanceBps = n(r[0]);
    const locks = [];
    ops.forEach((op, i) => {
      const v = r.slice(1 + i * per, 1 + (i + 1) * per).map(n);
      const [vBtc, minted, spent, redeemed, total, slashed] = v;
      const mine = shares.map((s, j) => ({ ...s, share: v[own.length + j] })).filter((s) => s.share > 0n);
      if (vBtc === 0n && !mine.length) return;   // one of the wallet's other outputs, or a bond since taken back
      const state = slashed ? 'slashed' : spent ? (minted ? 'forfeit' : 'free') : redeemed ? 'free' : minted ? 'backing' : 'pending';
      const out = outputs.get(op) || null, takeable = state === 'pending' || state === 'free';
      locks.push({
        op, txid: out?.txid || null, vout: out ? out.vout : null, vBtc, state, total, minted: !!minted, spent: !!spent, redeemed: !!redeemed, slashed: !!slashed,
        everyday: !!out && out.spk === everydaySpk && !spent && !redeemed, health: null,
        bonds: mine.map((s) => ({
          src: s.src, contract: s.contract, account: s.acct, share: s.share,
          take: takeable ? { to: s.contract, data: '0x' + _selector(s.src === 'engine' ? 'claimEscrow(bytes32)' : 'reclaimEscrow(bytes32)') + _word(op) } : null,
        })),
      });
    });
    // While the margin call is armed, each backing bond's health at the engine's own mark, and when a flag runs out.
    let graceWindow = 0n;
    const backing = locks.filter((l) => l.state === 'backing');
    if (maintenanceBps > 0n && backing.length) {
      const h = await _multicall([
        { to: engine, data: '0x' + _selector('escrowGraceWindow()') },
        ...backing.flatMap((l) => [{ to: engine, data: '0x' + _selector('checkEscrowHealth(bytes32)') + _word(l.op) }, { to: engine, data: '0x' + _selector('escrowUnhealthySince(bytes32)') + _word(l.op) }]),
      ]);
      graceWindow = n(h[0]);
      backing.forEach((l, i) => {
        const x = h[1 + 2 * i], since = n(h[2 + 2 * i]);
        if (!x) return;
        const w = (k) => BigInt('0x' + x.slice(2 + 64 * k, 66 + 64 * k));
        l.health = { healthy: w(0) === 1n, have: w(1), want: w(2), flaggedAt: since, due: since > 0n ? since + graceWindow : 0n };
      });
    }
    const rank = { forfeit: 0, free: 1, pending: 2, backing: 3, slashed: 4 };
    locks.sort((a, b) => rank[a.state] - rank[b.state] || (b.health && !b.health.healthy) - (a.health && !a.health.healthy));
    return { maintenanceBps, graceWindow, locks };
  }

  // The assets an output of a wallet's settle can be in: every pool asset plus the assets of the notes the wallet has held.
  const _knownAssets = (notes) => [...new Set([..._poolAssets.map((a) => a.assetId), ...notes.map((n) => n.asset)].map(lc))];

  // A deposit whose own wrap note never landed is either still waiting for its settle or was spent by another op in its
  // place (a wrap-and-send, a one-click swap or LP), whose outputs the derived walk finds from the deposit id. The pool's
  // depositStatus tells them apart: it reads 2 once a deposit is spent, and that is final, so a spent id is read once per
  // session. A status that cannot be read leaves the deposit listed as waiting.
  const _spentDeposits = new Set();
  async function _stillWaiting(deposits) {
    const waiting = [];
    for (let i = 0; i < deposits.length; i += 8) {
      const part = deposits.slice(i, i + 8);
      const spent = await Promise.all(part.map(async (d) => {
        const k = lc(d.depositId);
        if (_spentDeposits.has(k)) return true;
        try {
          const r = await ethCall(cfg.pool, '0x' + _selector('depositStatus(bytes32)') + _word(d.depositId));
          if (r && r !== '0x' && BigInt(r) === 2n) { _spentDeposits.add(k); return true; }
        } catch { /* unread: still listed */ }
        return false;
      }));
      part.forEach((d, j) => { if (!spent[j]) waiting.push(d); });
    }
    return waiting;
  }

  async function _scanNotes({ walletPriv, events, deep = false, cbtc = true, btcHistory = null, bridge = true, bridgeAmounts = [] }) {
    const R = recovery();
    const id = identity(walletPriv);
    const { leaves, spent } = indexer.index(events);
    const tree = indexer.buildTree(leaves);
    const root = tree.root();
    const slot = new Map();
    leaves.forEach((l, i) => { if (l) slot.set(lc(l.leaf), i); });
    const nu = (n, leaf) => pool.nativeNu(n.owner, n.secret, leaf);
    const all = new Map();
    const diag = { errors: {} };
    const addDerived = (n, source, extra = {}) => {
      const lf = lc(n.leaf), leafIndex = slot.get(lf);
      if (leafIndex == null) return false;
      const held = all.get(lf);
      if (held) {
        // The same note re-derived from the wallet key: it is no longer known only from a memo somebody else
        // could have written, so the inbound label goes and the channel that vouched for it is recorded.
        if (held.inboundUnverified) { held.inboundUnverified = false; held.keyDerivedBy = source; }
        return false;
      }
      all.set(lf, { value: BigInt(n.value), blinding: n.blinding, secret: n.secret, asset: n.asset, owner: n.owner, cx: n.cx, cy: n.cy, leaf: n.leaf, leafIndex, nullifier: nu(n, n.leaf), source, ...extra });
      return true;
    };
    const emptyLeaves = leaves.filter((l) => l && (!l.memo || l.memo === '0x'));
    diag.leaves = leaves.filter(Boolean).length; diag.emptyMemoLeaves = emptyLeaves.length;

    // (a) memo channel. A memo is authenticated by the leaf it opens and by nothing else: anyone who knows this
    // wallet's scan key can seal one over a note they built themselves, and they keep that note's nk. So a note
    // known only from a memo is an INBOUND claim — spendable, but not the wallet's own work — and it is marked
    // here rather than presented as equivalent to one re-derived from the key. A key-derived channel below that
    // reaches the same leaf clears the mark.
    for (const n of memo.scan(_scanKeyHex(id.priv), leaves.filter(Boolean), [], nu)) all.set(lc(n.leaf), { ...n, inboundUnverified: true });
    diag.memoNotes = all.size;

    // (b) wrap deposits. `unsettled`: every deposit of this key whose own wrap note is not in the tree. `pending`: those of
    // them still waiting for their settle, less the ones another op spent in their place (see _stillWaiting).
    diag.wrap = { found: 0, pending: [], unsettled: [], scanned: [], truncated: [] };
    try {
      const w = R.walkWraps({ priv: id.priv, events, assets: _poolAssets, minIndex: (assetId) => _wrapIndexHint(id.pubHex, assetId) });
      diag.wrap.scanned = w.scanned;
      diag.wrap.truncated = w.scanned.filter((s) => s.stoppedAtMaxIndex).map((s) => s.assetId);
      // Each deposit keeps the transaction that made it: a settle sent later names it, so the relay can read its tip.
      const wrapTx = new Map((events || []).filter((e) => e && e.type === 'Wrap' && e.txHash).map((e) => [lc(e.depositId), e.txHash]));
      for (const n of w.found) {
        if (slot.has(lc(n.leaf))) { if (addDerived(n, 'wrap', { wrapIndex: n.index })) diag.wrap.found++; }
        else if (!all.has(lc(n.leaf))) diag.wrap.unsettled.push({ index: n.index, asset: n.asset, value: n.value, depositId: n.depositId, txHash: wrapTx.get(lc(n.depositId)) || null });
      }
    } catch (e) { diag.errors.wrap = String(e && e.message || e); }
    diag.wrap.pending = await _stillWaiting(diag.wrap.unsettled);

    const tx = R.txIndex(events);
    const unexplained = () => emptyLeaves.filter((l) => !all.has(lc(l.leaf)));

    // (c) cBTC bearer notes — the blinding comes from the wallet's Bitcoin funding prevout, so this reads public Bitcoin
    // history (esplora, by script hash). Only attempted when some empty-memo leaf is still unexplained.
    diag.cbtc = { attempted: false, found: 0, anchors: 0, lockOutputs: 0, locksRecorded: 0 };
    if (cbtc && unexplained().length) {
      diag.cbtc.attempted = true;
      try {
        const h = typeof btcHistory === 'function' ? await btcHistory(id.priv) : (btcHistory || await _defaultBtcHistory(id.priv));
        const seenA = new Set(), anchors = [];
        for (const a of h.anchors || []) { const k = `${a.txid}:${a.vout}`; if (!seenA.has(k)) { seenA.add(k); anchors.push(a); } }
        diag.cbtc.anchors = anchors.length; diag.cbtc.lockOutputs = (h.lockOutputs || []).length;
        const locks = [];
        for (const o of h.lockOutputs || []) { const r = await _cbtcLockVBtc(o.txid, o.vout); if (r.vBtc > 0n) locks.push({ outpoint: r.outpoint, vBtc: r.vBtc, txid: o.txid, vout: o.vout }); }
        diag.cbtc.locksRecorded = locks.length;
        const cbtcNotes = R.scanCbtcNotes({ priv: id.priv, anchors, locks, cbtcAsset: pool.CBTC_ZK_ASSET_ID, slotOf: (lf) => (slot.has(lc(lf)) ? slot.get(lc(lf)) : null), rec: _cbtcRec });
        for (const n of cbtcNotes) if (addDerived(n, 'cbtc', { lockOutpoint: n.lockOutpoint })) diag.cbtc.found++;
      } catch (e) { diag.errors.cbtc = String(e && e.message || e); }
    }

    // (d) bridge-mint destination notes
    diag.bridge = { attempted: false, found: 0, unexplainedLeaves: 0, candidatesTried: 0 };
    // A balance read (not the deep recover) tries only the cheapest case — the TAC asset's default destination index, the
    // one every burn-deposit uses — because the full search hashes ~900k candidates (about a minute) and would hold the
    // page. A leaf it misses stays unsearched, so recover()'s full pass still covers other assets and indexes. Known
    // amounts (the caller's and the stored ones) are tried in either pass.
    const fast = !deep;
    const amounts = [...new Set([...(bridgeAmounts || []), ..._storedBridgeAmounts(id.pubHex)].map((v) => { try { return BigInt(v); } catch { return 0n; } }).filter((v) => v > 0n).map(String))].sort();
    diag.bridge.amountsTried = amounts.length;
    if (bridge) {
      const todo = new Map();
      const wk = _hex(privBytes(id.priv));
      const triedSet = fast ? _bridgeFastTried : _bridgeTried;
      const triedKey = (lf) => `${wk}:${amounts.join(',')}:${lf}`;
      for (const l of unexplained()) {
        const lf = lc(l.leaf);
        const kept = _bridgeFound.get(wk + ':' + lf);
        if (kept) { if (addDerived(kept, 'bridge-mint', { burnNullifier: kept.burnNullifier })) diag.bridge.found++; continue; }
        if (triedSet.has(triedKey(lf))) continue;
        const t = tx.txOfLeaf.get(lf);
        if (!t || !(tx.nullifiersOfTx.get(t) || []).length) continue;
        if (!todo.has(t)) todo.set(t, []);
        todo.get(t).push(lf);
      }
      diag.bridge.unexplainedLeaves = [...todo.values()].reduce((sN, a) => sN + a.length, 0);
      if (todo.size) {
        diag.bridge.attempted = true;
        try {
          const r = await R.walkBridgeMints({ priv: id.priv, tx, unexplained: todo, assets: [...new Map(_poolAssets.filter((a) => a.bitcoinLink && (!fast || a.ticker === 'TAC' || a.ticker === 'cTAC')).map((a) => [lc(a.assetId), { assetId: a.assetId }])).values()], values: amounts.map((v) => BigInt(v)), destIndexes: fast ? 1 : 8, maxExp: fast ? 15 : 18, maxNullifiers: fast ? 4096 : 16 });
          diag.bridge.candidatesTried = r.tried;
          for (const n of r.found) { _bridgeFound.set(wk + ':' + lc(n.leaf), n); if (addDerived(n, 'bridge-mint', { burnNullifier: n.burnNullifier })) diag.bridge.found++; }
          // Only transactions the walk fully tried are settled; ones past its cap stay open for the next pass.
          for (const [t, lfs] of todo) if (!r.searched || r.searched.has(t)) for (const lf of lfs) triedSet.add(triedKey(lf));
        } catch (e) { diag.errors.bridge = String(e && e.message || e); }
      }
    }

    // (e) send-and-unwrap change: reads the settle calldata of each spent parent's transaction, so it is deep-only.
    diag.change = { attempted: false, found: 0, skipped: [] };
    if (deep) {
      diag.change.attempted = true;
      try {
        const parents = [...all.values()].map((n) => ({ ...n, nullifier: n.nullifier }));
        const getTxInput = async (h) => { const t = await rpc('eth_getTransactionByHash', [h]); return t && t.input; };
        const c = await R.walkChange({ parents, tx, knownLeaves: new Set(all.keys()), getTxInput });
        diag.change.skipped = c.skipped;
        for (const n of c.found) if (addDerived(n, 'change', { parentLeaf: n.parentLeaf })) diag.change.found++;
      } catch (e) { diag.errors.change = String(e && e.message || e); }
    }

    // (f) outputs derived from the wallet key and the anchor of the settle that made them (change, LP shares, swap outputs,
    // CDP notes, ...): read the calldata of each settle the wallet's spent notes and consumed deposits took part in.
    diag.derived = { attempted: false, found: 0, skipped: [], depositsLocated: 0 };
    if (deep) {
      diag.derived.attempted = true;
      try {
        const getTxInput = async (h) => { const t = await rpc('eth_getTransactionByHash', [h]); return t && t.input; };
        const pendingDeposits = diag.wrap.unsettled.map((d) => ({ depositId: d.depositId, asset: d.asset, value: d.value }));
        const at = pendingDeposits.length ? await R.locateDepositTx({ deposits: pendingDeposits, events, getTxInput }) : new Map();
        const deposits = pendingDeposits.map((d) => ({ ...d, txHash: at.get(lc(d.depositId)) || null })).filter((d) => d.txHash);
        diag.derived.depositsLocated = deposits.length;
        const d = await R.walkDerivedOutputs({
          priv: id.priv, parents: [...all.values()], deposits, tx, knownLeaves: new Set(all.keys()), getTxInput,
          assets: _knownAssets([...all.values()]), lpShareOf: (pid) => _lp.lpShareId(pid),
        });
        diag.derived.skipped = d.skipped;
        for (const n of d.found) if (addDerived(n, 'derived', { role: n.role, roleIndex: n.index })) diag.derived.found++;
      } catch (e) { diag.errors.derived = String(e && e.message || e); }
    }

    const owned = [...all.values()].sort((a, b) => a.leafIndex - b.leafIndex);
    const notes = owned.filter((n) => !spent.has(lc(n.nullifier))).map((n) => ({ ...n, path: tree.rootAndPath(n.leafIndex).path, root }));
    diag.unattributedEmptyLeaves = unexplained().map((l) => ({ leafIndex: l.leafIndex, leaf: l.leaf }));
    diag.inboundUnverified = notes.filter((n) => n.inboundUnverified).length;
    return { notes, owned, tree, root, slot, spent, leaves, tx, diag, id };
  }

  // Seed-only confidential balance: recover the wallet's unspent notes from chain + scan key, grouped by
  // asset. No off-chain note storage — a wiped wallet recovers its whole confidential balance from here. Notes come
  // from the wallet's memos and from the key-derived channels (wraps, bridge-mint destinations, cBTC); the walks that
  // need a transaction's calldata run in recover(). opts: { fromBlock, toBlock } plus { cbtc: false, bridge: false } to
  // skip a walk, { btcHistory } (a provider fn, or { anchors, lockOutputs }) and { bridgeAmounts } (extra amounts to try).
  async function balance(scanPriv, opts) {
    const o = opts || {};
    const events = withSavedMemos(await fetchEvents({ fromBlock: o.fromBlock, toBlock: o.toBlock, include: ['wraps'] }));
    const st = await _scanNotes({ walletPriv: scanPriv, events, cbtc: o.cbtc !== false, btcHistory: o.btcHistory || null, bridge: o.bridge !== false, bridgeAmounts: o.bridgeAmounts || [] });
    const notes = st.notes;
    const byAsset = {};
    for (const n of notes) {
      const id = String(n.asset || '').toLowerCase();
      (byAsset[id] ||= { asset: id, ticker: tickerOf(id), value: 0n, notes: [] });
      byAsset[id].value += BigInt(n.value);
      byAsset[id].notes.push(n);
    }
    // A full scan is the whole wallet, so it sets the holder tier; a windowed one only sees part of it.
    const ctac = assetByTicker.cTAC;
    if (ctac && ctac.assetId && o.fromBlock == null && o.toBlock == null) {
      const held = byAsset[String(ctac.assetId).toLowerCase()];
      _privateTacWei = held ? held.value * BigInt(ctac.unitScale || '1') : 0n;
      if (ctac.underlying) {
        try {
          let ext = [];
          try { ext = _externalTacHolders() || []; } catch {}
          const addrs = [...new Set([account(scanPriv).address, ...ext]
            .map((a) => String(a || '').toLowerCase()).filter((a) => /^0x[0-9a-f]{40}$/.test(a)))];
          let sum = 0n;
          for (const a of addrs) sum += BigInt((await ethCall(ctac.underlying, '0x70a08231' + a.slice(2).padStart(64, '0'))) || '0x0');
          _accountTacWei = sum;
        } catch { /* keep the last reading; a failed read only costs the discount, never the balance */ }
      }
    }
    // `diag` travels with the result. _scanNotes swallows a failure in any one channel so a single dead
    // endpoint cannot blank the whole wallet — but a caller that sees only `notes` cannot tell a genuinely
    // empty channel from one that errored, and for cBTC and bridge-mint notes that distinction is the
    // difference between "you hold nothing" and "we could not look". Those two channels have no memo: key +
    // chain re-derivation is the ONLY way to find them, so an esplora outage renders a real balance as zero
    // with no error anywhere. recover() has always surfaced this as diagnostics.coverage; balance() is the
    // entry point almost every tab actually calls, and it was dropping it.
    //
    // `errors` is keyed by channel and empty on a clean scan, so `Object.keys(diag.errors).length` is the
    // one test a caller needs before treating a balance as authoritative.
    return { notes, byAsset, poolStats: poolStatsFromEvents(events), diag: st.diag };
  }

  // Rough pool-wide activity stat, derived for free from the SAME event stream balance() just fetched
  // (no separate scan/RPC round trip): every LeavesInserted's firstLeafIndex+leaves.length is a running
  // total of notes ever minted, and every NullifiersSpent's array length is spends. outstandingNotes ==
  // notes minted minus notes spent == roughly how many live shielded notes currently sit in the pool — a
  // simple, honestly-labeled proxy for the pool's overall set size, not a per-note cryptographic anonymity
  // bound (a specific note's real anonymity set is narrower — same asset, same approximate value/op shape).
  function poolStatsFromEvents(events) {
    let totalNotesCreated = 0, totalNullifiersSpent = 0;
    for (const e of events || []) {
      if (e.type === 'LeavesInserted') {
        const end = Number(e.firstLeafIndex) + (e.leaves ? e.leaves.length : 0);
        if (end > totalNotesCreated) totalNotesCreated = end;
      } else if (e.type === 'NullifiersSpent') {
        totalNullifiersSpent += (e.nullifiers ? e.nullifiers.length : 0);
      }
    }
    return { totalNotesCreated, totalNullifiersSpent, outstandingNotes: Math.max(0, totalNotesCreated - totalNullifiersSpent) };
  }

  function tickerOf(assetIdHex) {
    const id = String(assetIdHex || '').toLowerCase();
    const a = cfg.assets.find((x) =>
      (x.assetId && x.assetId.toLowerCase() === id)
      || (x.bitcoinLink && x.bitcoinLink.toLowerCase() === id));
    return a ? a.ticker : null;
  }
  // The pool row for an asset id, for pricing and settling. Two configured rows can share one id (TAC, the public ERC20
  // kept so a Bitcoin-lane holding merges with it, and cTAC, the pool asset), and tickerOf returns the first, which
  // has no relay fee policy: a TAC note's exit would be quoted a zero floor and refused. Fees take the row the relay
  // prices, as its own quote does; display keeps tickerOf.
  function poolTickerOf(assetIdHex) {
    const id = lc(assetIdHex);
    const rows = cfg.assets.filter((x) => (x.assetId && lc(x.assetId) === id) || (x.bitcoinLink && lc(x.bitcoinLink) === id));
    const row = rows.find((x) => RELAY_FEE_ASSETS[x.ticker]) || rows.find((x) => /^c/.test(x.ticker)) || rows[0];
    return row ? row.ticker : null;
  }

  // ── wrap on-ramp ──
  const evmTx = makeEvmTx({ secp, keccak256 });
  const pool = indexer._pool;   // commitXY / deriveNote / leaf / depositId
  // kernelSign/rangeProve live in confidential-transfer.js and back LP's partial-add change outputs.
  // Passed as thunks because `_ct` is constructed further down; they are only invoked at build time.
  const _lp = makeConfidentialLp({
    keccak256,
    pool,
    kernelSign: (a) => _ct.kernelSign(a),
    // rangeProve takes (values[], blindings[]) as two positional args (confidential-lp's change-proof
    // call sites), not one -- forward both or a partial add/remove's change proof crashes on
    // "blindings.length" of undefined the first time it actually produces change.
    rangeProve: (...a) => _ct.rangeProve(...a),
  }); // OP_LP_ADD assembler (poolId/lpShareId == pool.evm*)
  // CDP + cBTC + farm action layer (the ETH-side settle for cUSD/cBTC/farm ops). The cBTC ① lock (Taproot
  // commit/reveal) is a separate BTC-wallet driver (cbtc-lock.js); this exposes ③ mintCbtc (+ CDP/farm).
  const _cdp = makeConfidentialCdp({ keccak256, pool, signSchnorr });
  const _farm = makeConfidentialFarm({ keccak256, pool });
  const defiActions = (walletPriv) => makeConfidentialDefiActions({ pool, cdp: _cdp, farm: _farm, relay, id: identity(walletPriv), chainBindingHex, secp, ephRand: freshEph });
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
  // A payout recipient is a FREE-TEXT field (the exit/send-unwrap forms), unlike every other address in this
  // module (derived from a key). It gets baked into the opening sigma's context and the on-chain payout leg,
  // so a malformed value (missing/extra hex digits from a copy-paste slip, no 0x prefix, a Bitcoin address
  // pasted into the wrong box) must be rejected HERE — before it's signed into a proof — rather than trusted to
  // fail somewhere downstream (or worse, get silently zero-padded/truncated into a DIFFERENT valid-looking
  // address the payout can never be recovered from). Exactly 20 bytes, hex only.
  const _evmAddr = (a, what) => {
    let s = String(a == null ? '' : a).trim();
    if (s && !s.startsWith('0x') && !s.startsWith('0X')) s = '0x' + s;
    if (!/^0x[0-9a-fA-F]{40}$/.test(s)) throw new Error(`${what}: "${a}" is not a valid Ethereum address (need 0x + 40 hex digits)`);
    return s.toLowerCase();
  };
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

  // Memo ephemeral scalar — FRESH PER MEMO, never wallet-derived.
  //
  // A wallet-constant ephemeral would put the same ephemeral pubkey on every leaf a wallet creates (making
  // its notes linkable) and would let any one counterparty open the sender's other memos.
  //
  // Nothing depends on the scalar being reproducible: memos are sealed here in the client and travel to the
  // relay as data (confidential-relay.submitOp seals then sends `sealedMemos`); no server-side code re-seals.
  const freshEph = () => randomScalar();

  // Self-owned outputs (change, a self-send's received note, LP shares, swap outputs, released collateral, claim and refund
  // notes, farm rewards) take their nullifier key and blinding from the wallet key and a public anchor of the settle, so a wallet
  // restored from its key alone can re-derive them without a memo or a saved record (confidential-recovery.js). Outputs meant for
  // someone else, and stealth-lock fields, stay on fresh randomness. The memo ephemeral stays fresh per memo as above.
  const deriveOutput = (walletPriv, anchor, role, index = 0) => deriveOutputKeys({ hmac, sha256: vendorSha256, curveOrder: SECP_N }, walletPriv, anchor, role, index);
  // The lock's leaf, from the record's own field or recomputed from the fields a sender's onBuilt carries.
  const _lockLeafOf = (r) => r.leaf || r.lockLeaf || _stealth.stealthLockLeafBlind(r.asset, r.lCx, r.lCy, r.ownerPub, r.deadline, r.refundPub);
  // The nullifier the pool records when a note is spent — the anchor of the outputs of the settle that spends it.
  const _noteAnchor = (n, id) => {
    const owner = n.owner || id.owner;
    return pool.nativeNu(owner, n.secret, pool.leaf(n.asset, n.cx, n.cy, owner));
  };

  // The user's confidential identity for the pool: the scan key (recovers notes), the owner pubkey
  // (memos are sealed to it), and the 32-byte owner field bound into each leaf — all from the wallet scalar.
  function identity(walletPriv) {
    const priv = walletPriv instanceof Uint8Array
      ? walletPriv
      : Uint8Array.from((String(walletPriv).replace(/^0x/, '').match(/../g) || []).map((h) => parseInt(h, 16)));
    const pub = secp.getPublicKey(priv, true);          // compressed 33B: prefix ‖ x
    _ownKeys.set('0x' + _hex(pub), '0x' + _hex(priv));
    // `secret` is the note's NULLIFIER KEY (nk) under the guest's secret-key ownership scheme — not a
    // vestigial field, as an earlier comment here claimed. The guest asserts nk_to_owner(nk) == owner on
    // every native spend, so `owner` MUST be keccak(nk ‖ dom); publishing the wallet pubkey (what this
    // returned) mints notes that no nk hashes to, i.e. unspendable forever on an immutable vkey.
    const tag = new TextEncoder().encode('tacit-evm-cnote-secret-v1');
    const buf = new Uint8Array(priv.length + tag.length); buf.set(priv); buf.set(tag, priv.length);
    const secret = '0x' + _hex(keccak256(buf));
    // This owner is wallet-CONSTANT: a note minted to it would publish one owner across the wallet's notes, and
    // its nk would reach the relay every time such a note is spent. No assembler mints to it; every output gets
    // a per-note nk sealed into its memo (derived from the wallet key and the settle's anchor, or seed-derived like wrap).
    // It is kept only to recognise notes an older build minted.
    return { priv, pubHex: '0x' + _hex(pub), owner: pool.nkToOwner(secret), secret };
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
    // `secret` IS the note's nullifier key (nk) under the guest's secret-key ownership scheme, and
    // deriveNote already makes it per-note (seed ‖ asset ‖ index). The published owner must therefore be
    // keccak(nk ‖ dom), NOT the wallet pubkey: the guest asserts nk_to_owner(nk) == owner on every spend, so
    // a note minted to any other owner value is unspendable forever (the vkey is immutable). Deriving it per
    // note is also what keeps a wallet's notes unlinkable — owner rides in the public leaf, so a wallet-wide
    // key would publish one constant owner across every note.
    const { secret, blinding } = pool.deriveNote(id.priv, meta.assetId, index);
    const owner = pool.nkToOwner(secret);
    const blindingHex = '0x' + BigInt(blinding).toString(16).padStart(64, '0'); // deriveNote gives a bigint; the wrapOp/memo/harness need hex
    const { cx, cy } = pool.commitXY(value, blindingHex);
    const leaf = pool.leaf(meta.assetId, cx, cy, owner);
    // The on-chain wrap takes only this digest of the coords + owner; the raw values stay off-chain
    // (carried in the private OP_WRAP witness below), so the deposit note's ν is never computable.
    const commit = pool.depositCommit(cx, cy, owner);
    const depositId = pool.depositId(meta.assetId, value, cx, cy, owner);
    const cb = chainBindingHex();
    const wrapCtx = pool.intentContext('tacit-wrap-intent-v1', cb, meta.assetId, depositId,
      [[cx, cy, owner]], [value]);
    const wrapNonce = pool.deriveOpeningNonce(blindingHex, wrapCtx, 'wrap');
    const wrapSig = pool.openingSigma(value, blindingHex, wrapCtx, wrapNonce);
    const note = { value: value.toString(), blinding: blindingHex, secret, asset: meta.assetId, owner, cx, cy };

    // Recovery (channel a: memo-sealed) — the reference integration every op assembler follows: describe
    // each output leaf, seal a memo per output through the guard, then trip-wire that every leaf is
    // recoverable BEFORE submit. Wrap has one output (the deposit note), sealed to the user's own pubkey,
    // under a fresh ephemeral (see freshEph — a reproducible one would make every note of a wallet linkable).
    const ephRand = freshEph;
    const outputs = [{ ...note, ownerPub: id.pubHex }];
    const memos = guard.sealMemosForOutputs({ outputs, ephRand });
    guard.assertOutputsRecoverable({ leaves: [leaf], outputs, memos });
    const memoHex = memos[0];

    // pool.wrap(bytes32 assetId, uint256 amount, bytes32 commit) — commit = keccak(Cx‖Cy‖owner)
    const calldata = '0x' + _selector('wrap(bytes32,uint256,bytes32)')
      + _word(meta.assetId) + _word(amount) + _word(commit);

    return {
      note, leaf, depositId, commit, memo: memoHex, memos, outputs, ephRand, index,
      // the OP_WRAP witness the exec-wrap prover settles (consumes the deposit → mints the note leaf).
      wrapOp: { chainBinding: cb, asset: meta.assetId, value: value.toString(), cx, cy, owner,
        sigR: wrapSig.R, sigZ: wrapSig.z },
      to: cfg.pool, amount: amount.toString(), calldata,
      wrapArgs: { assetId: meta.assetId, amount: amount.toString(), commit },
    };
  }

  // Settle a wrap DEPOSIT into its note: submit the OP_WRAP witness to the relay (type 'wrap' → exec-wrap
  // prover), which proves + calls settle(), consuming the on-chain deposit and emitting the note leaf. The
  // deposit tx (pool.wrap()) MUST already be mined — the guest checks the deposit is registered. Pass the
  // object returned by buildWrap.
  // `depositTx`: the deposit's transaction, when known. A deposit sent through a tip forwarder carries the relay's tip,
  // which the relay reads from that receipt so the paid wrap is not held to its free-settle allowance.
  // `selfSettle({ jobId, publicValues, proof, memos })` → { txHash }: the relay only proves, and the caller sends settle() from
  // the account it pays with (settleCalldata builds the call). A deposit's id commits to the note it becomes, so it is the
  // same wrap whoever sends it, and a relayed settle of it still queued finds it done.
  async function submitWrapSettle({ built, waitOpts, depositTx = null, selfSettle = null } = {}) {
    if (!built || !built.wrapOp) throw new Error('submitWrapSettle: pass the buildWrap() result');
    const spec = { type: 'wrap', op: built.wrapOp, leaves: [built.leaf], outputs: built.outputs, memos: built.memos, ephRand: built.ephRand };
    if (selfSettle) {
      const proven = await relay.prove(spec, waitOpts);
      if (proven.status === 'settled') return proven;
      const memos = proven.memos || built.memos;
      const sent = await selfSettle({ jobId: proven.jobId, publicValues: proven.publicValues, proof: proven.proof, memos });
      return relay.verifyEmittedMemos({ jobId: proven.jobId, status: 'settled', ...sent }, [built.leaf], memos);
    }
    const sub = await relay.submitOp({ ...spec, mode: 'settle', depositTx }, waitOpts);
    const st = sub.status === 'settled' ? { jobId: sub.jobId, ...sub } : await relay.waitForSettle(sub.jobId, waitOpts);
    return relay.verifyEmittedMemos(st, [built.leaf], sub.sealedMemos);
  }

  // The derivation index for the next wrap of `ticker`. A wrap note's secret (its nullifier key) and blinding are
  // derived from (seed, asset, index), so two deposits on one index share both: the notes are linkable to each
  // other, and opening one note (a spend hands its secret and blinding to whoever relays it) hands over the other's.
  // The same index with the same amount is a deposit id the pool already holds, and the wrap reverts. So each wrap
  // takes the first index no deposit of this wallet and asset has used. A used index is one whose deposit id, for
  // any amount a Wrap event of the asset carries, is itself a Wrap event (settled or still pending, spent or not);
  // indexes this call chose earlier count too, so wraps sent back to back do not collide before the first one
  // lands. The first index scanned resumes from the last one this device chose (localStorage when available, else
  // 0): a hint only ever skips indexes, never re-offers one, and the chain scan checks every index it does offer.
  // Reading the events can fail (a public node refusing the log range). The wrap then fails rather than guessing,
  // since the device hint cannot see indexes another device or an earlier install used. Retry, or pass an explicit
  // `index` to pin one.
  const _reservedWrapIndex = new Map();
  const WRAP_INDEX_HINT_PREFIX = 'tacit:next-wrap-index:';
  const _wrapHintKey = (pubHex, assetId) => `${WRAP_INDEX_HINT_PREFIX}${pubHex}:${String(assetId).toLowerCase()}`;
  // The first index this device has not reserved for (wallet, asset). A reservation is recorded before its deposit
  // is broadcast, so indexes below this may hold no deposit at all — the recovery walk takes it as the floor it
  // scans through, or a row of wraps built and never sent hides every wrap after them from a key-only scan.
  function _wrapIndexHint(pubHex, assetId) {
    const key = _wrapHintKey(pubHex, assetId);
    let n = 0;
    try { n = Math.max(0, parseInt(localStorage.getItem(key), 10) || 0); } catch { /* no storage: nothing reserved here */ }
    for (const i of _reservedWrapIndex.get(key) || []) n = Math.max(n, i + 1);
    return n;
  }
  async function nextWrapIndex({ walletPriv, ticker = 'cETH' } = {}) {
    const meta = assetByTicker[ticker];
    if (!meta) throw new Error(`unknown asset ${ticker}`);
    const id = identity(walletPriv);
    const assetId = String(meta.assetId).toLowerCase();
    const unitScale = BigInt(meta.unitScale);
    let events;
    try {
      const head = await headBlock();
      if (!Number.isFinite(head)) throw new Error('no head block');
      const logs = await getLogsChunked({ address: cfg.pool, topics: [evmLog.TOPIC0.Wrap, null, assetId] }, Number(cfg.deployBlock || 0), head);
      events = evmLog.decodeLogs(logs).filter((e) => e.type === 'Wrap');
    } catch (e) {
      throw new Error(`nextWrapIndex: could not read this asset's wrap deposits (${e && e.message ? e.message : e}); retry, or pass an explicit index`);
    }
    const known = new Set(events.map((e) => String(e.depositId).toLowerCase()));
    const values = [...new Set(events.filter((e) => e.amount % unitScale === 0n).map((e) => e.amount / unitScale))];
    const hintKey = _wrapHintKey(id.pubHex, assetId);
    const start = _wrapIndexHint(id.pubHex, assetId);
    const taken = _reservedWrapIndex.get(hintKey) || new Set();
    for (let i = start; ; i++) {
      if (taken.has(i)) continue;
      const { secret, blinding } = pool.deriveNote(id.priv, meta.assetId, i);
      const owner = pool.nkToOwner(secret);
      const blindingHex = '0x' + BigInt(blinding).toString(16).padStart(64, '0');
      const used = values.some((v) => {
        const { cx, cy } = pool.commitXY(v, blindingHex);
        return known.has(String(pool.depositId(meta.assetId, v, cx, cy, owner)).toLowerCase());
      });
      if (used) continue;
      taken.add(i);
      _reservedWrapIndex.set(hintKey, taken);
      try { localStorage.setItem(hintKey, String(i + 1)); } catch { /* best effort */ }
      return i;
    }
  }

  // Sign + broadcast the wrap deposit from the user's (funded) Sepolia EVM account. Returns the txHash +
  // the note record to track until the box settles OP_WRAP and the note appears in the balance scan. `index`
  // defaults to the next unused one (nextWrapIndex); pass it to pin a specific derivation index. The result
  // carries the `index` used.
  async function wrap({ walletPriv, amountWei, ticker = 'cETH', index, gasLimit = 220000n, broadcast = true } = {}) {
    if (index == null) index = await nextWrapIndex({ walletPriv, ticker });
    const w = buildWrap({ walletPriv, amountWei, ticker, index });
    const acct = account(walletPriv);
    const nonce = BigInt(await rpc('eth_getTransactionCount', [acct.address, 'pending']));
    const tip = await _priorityTip();
    const base = BigInt(await rpc('eth_gasPrice', []) || '0x3b9aca00');
    const tx = {
      chainId: BigInt(cfg.chainId), nonce, maxPriorityFeePerGas: tip, maxFeePerGas: base * 2n + tip,
      gasLimit: BigInt(gasLimit), to: cfg.pool, value: BigInt(w.amount), data: w.calldata,
    };
    const signed = evmTx.signEip1559(tx, acct.priv);
    // Simulate before spending gas. A wrap's deposit id is hash3(assetId, value, commit) and the pool
    // registers it exactly once, ever — a repeat reverts DepositExists permanently. Broadcasting blind then
    // returning a txHash regardless means a reverted wrap is reported to the user as a pending deposit, and
    // the UI tells them to wait for a note that can never arrive: gas burned, nothing escrowed, no error
    // anywhere. eth_call costs nothing and turns that into a message before the send.
    if (broadcast) {
      let simErr = null;
      try {
        await rpc('eth_call', [{ from: acct.address, to: cfg.pool, value: '0x' + BigInt(w.amount).toString(16), data: w.calldata }, 'latest']);
      } catch (e) { simErr = e; }
      if (simErr) {
        const raw = String(simErr && (simErr.data || simErr.message) || simErr);
        // DepositExists() — selector 0xad2fa98e. Worth naming explicitly: it is the one revert a
        // user can hit by doing something entirely reasonable (re-wrapping the same amount at the same
        // index), and the remedy is specific.
        const dup = /0xad2fa98e/i.test(raw) || /DepositExists/i.test(raw);
        throw new Error(dup
          ? `this exact deposit (${ticker} ${w.amount} at wrap index ${index}) has already been registered on the pool and can never be registered again — wrap a different amount, or let nextWrapIndex pick a fresh index instead of pinning one`
          : `wrap would revert on-chain, not broadcasting: ${raw.slice(0, 200)}`);
      }
    }
    const txHash = broadcast ? await rpc('eth_sendRawTransaction', [signed.raw]) : null;
    return { ...w, from: acct.address, nonce: nonce.toString(), signedRaw: signed.raw, txHash };
  }

  // ── ConfidentialRouter one-tx wrap (periphery) ──
  // The router collapses approve+wrap into a single call so an ERC20 (or native ETH) wraps straight into a
  // shielded note. The note commitment is the SAME one buildWrap produces (so the recovery memo + scan are
  // unchanged); only the on-chain entrypoint differs. Native ETH → router.wrapETH{value}(commit); an ERC20
  // → router.wrapWithPermit(...) with an EIP-2612 permit signed by the wallet's EVM account. INERT until
  // cfg.router is set (the DeployConfidentialPool broadcast pins it).
  const _router = makeConfidentialRouter({ secp, keccak256, sha256, cfg });
  // Wrap-permit strategy per token: 'native' (ETH → wrapETH{value}); 'eip2612' (token has EIP-2612 permit —
  // USDC, our canonical bridged 'Tacit Token' ERC20s — single-tx gasless approval); 'permit2' (no EIP-2612,
  // e.g. USDT — route through the canonical Permit2 singleton: one-time ERC20 approval of Permit2, then a
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
  async function buildRouterWrap({ walletPriv, amountWei, ticker = 'cETH', index, permitDeadline } = {}) {
    if (!cfg.router) throw new Error('ConfidentialRouter not deployed for this network');
    if (index == null) index = await nextWrapIndex({ walletPriv, ticker });
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
  // Priority fee: the node's own suggestion, capped at the historical 1.5 gwei. A fixed 1.5 gwei tip dominates the
  // cost when the base fee is a fraction of a gwei, and it also inflates the balance every submit must hold up
  // front (gasLimit x maxFeePerGas).
  async function _priorityTip() {
    const CAP = 1500000000n;
    try {
      const t = BigInt(await rpc('eth_maxPriorityFeePerGas', []));
      if (t > 0n) return t < CAP ? t : CAP;
      return 100000000n;
    } catch { return CAP; }
  }
  async function _sendEvmTx({ acct, to, value = 0n, data, gasLimit, nonce, send = true }) {
    const n = nonce != null ? BigInt(nonce) : BigInt(await rpc('eth_getTransactionCount', [acct.address, 'pending']));
    const tip = await _priorityTip();
    const base = BigInt(await rpc('eth_gasPrice', []) || '0x3b9aca00');
    const tx = { chainId: BigInt(cfg.chainId), nonce: n, maxPriorityFeePerGas: tip, maxFeePerGas: base * 2n + tip,
      gasLimit: BigInt(gasLimit), to, value: BigInt(value), data };
    if (send) {
      // The node holds gasLimit x maxFeePerGas plus the value up front; a public node can accept a tx it will then drop
      // for a shortfall, which looks like a hash that never lands. Say so before signing.
      const need = tx.gasLimit * tx.maxFeePerGas + tx.value;
      const have = BigInt(await rpc('eth_getBalance', [acct.address, 'latest']));
      if (have < need) throw new Error(`insufficient ETH for gas: ${acct.address} holds ${have} wei and this transaction reserves ${need} wei up front (gas limit x max fee + value)`);
      // A transaction that would revert is never sent: it costs gas and does nothing. Run it first at its own gas
      // limit, so running out of gas is caught too. A node that cannot be asked is not a verdict.
      const hexq = (v) => '0x' + BigInt(v).toString(16);
      let why = null;
      try { await rpc('eth_call', [{ from: acct.address, to, value: hexq(tx.value), data, gas: hexq(tx.gasLimit) }, 'latest']); }
      catch (e) { const m = String((e && e.message) || e); if (/revert|out of gas|gas required exceeds/i.test(m)) why = m; }
      if (why) {
        const err = new Error(`this transaction would fail on chain, so it was not sent (${why.slice(0, 160)})`);
        err.wouldRevert = true;
        throw err;
      }
    }
    const signed = evmTx.signEip1559(tx, acct.priv);
    const txHash = send ? await rpc('eth_sendRawTransaction', [signed.raw]) : null;
    return { txHash, nonce: n, signedRaw: signed.raw };
  }
  // Resolves with the receipt of a transaction that succeeded. A reverted one throws, marked `reverted`: it moved
  // nothing, so nothing that follows it (a wrap's settle, above all) may run as if it had.
  async function _waitReceipt(txHash, tries = 60) {
    for (let i = 0; i < tries; i++) {
      const r = await rpc('eth_getTransactionReceipt', [txHash]);
      if (r && r.blockNumber) {
        if (r.status === '0x0') {
          const err = new Error(`transaction ${txHash} reverted on chain, so it changed nothing`);
          err.reverted = true; err.receipt = r;
          throw err;
        }
        return r;
      }
      await new Promise((res) => setTimeout(res, 3000));
    }
    throw new Error(`receipt timeout ${txHash}`);
  }

  async function routerWrap({ walletPriv, amountWei, ticker = 'cETH', index, gasLimit = 300000n, broadcast = true } = {}) {
    const acct = account(walletPriv);
    if (index == null) index = await nextWrapIndex({ walletPriv, ticker }); // once: the approval retry below rebuilds on the same index
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
    // A token wrap pulls the tokens from this wallet's Tacit account, not from a connected wallet: say plainly when
    // they are not there, rather than letting the send fail.
    const meta = assetByTicker[ticker];
    if (broadcast && w.permitType !== 'native' && meta && meta.underlying) {
      const held = BigInt(await ethCall(meta.underlying, '0x70a08231' + _word(acct.address)) || '0x0'); // balanceOf(address)
      const want = BigInt(amountWei);
      if (held < want) {
        const dec = Number(meta.decimals ?? 18), unit = shownTicker(ticker);
        const show = (v) => { const t = (Number(v) / 10 ** dec).toLocaleString('en-US', { maximumFractionDigits: 6 }); return `${t} ${unit}`; };
        throw new Error(`your Tacit account ${acct.address} holds ${show(held)}; wrapping ${show(want)} needs that much there first`);
      }
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
  // reproducible + recoverable); the output keys derive from the wallet key and the deposit id, and the per-output memo carries each opening.
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
    // Same constraint buildTransferOp enforces, and for the same reason: a native note's owner is
    // keccak(nk ‖ dom), so a recipient owner taken from their PUBKEY mints a note no nk hashes to —
    // unspendable forever against an immutable vkey, with the wrapped ETH gone with it. Minting from a
    // sender-chosen nk is not an escape either: whoever picks nk holds spend authority, so the sender could
    // spend the recipient's note. Third-party sends belong on the stealth lock/claim path, where the
    // recipient derives their own nk. Fail closed rather than burn the deposit.
    const isSelf = String(recipientPubHex).toLowerCase() === String(id.pubHex).toLowerCase();
    if (!isSelf) {
      throw new Error(
        'wrap-and-send: cannot send to a third party directly — a native note owner is keccak(nk ‖ dom), so a '
        + 'pubkey-derived owner mints a note that is unspendable forever and burns the wrapped ETH. Use the '
        + 'stealth lock/claim path (confidential-stealth.js) instead.',
      );
    }
    // The deposit blinding is wallet-derived (reproducible deposit commit, exactly like buildWrap); the
    // deposit is consumed (spent into the outputs), not emitted as a leaf.
    const { secret: depSecret, blinding: depBlindingBn } = pool.deriveNote(id.priv, meta.assetId, index);
    // Same nk-derived owner buildWrap publishes, so the deposit commit reproduces exactly (asserted in
    // tests/confidential-pool-ux.mjs) and the guest's nk_to_owner check passes when it is consumed.
    const depOwner = pool.nkToOwner(depSecret);
    const depBlinding = '0x' + BigInt(depBlindingBn).toString(16).padStart(64, '0');
    const { cx: dcx, cy: dcy } = pool.commitXY(depositValue, depBlinding);
    const depositCommit = pool.depositCommit(dcx, dcy, depOwner);
    const depositId = pool.depositId(meta.assetId, depositValue, dcx, dcy, depOwner);

    // Self-send: a per-note nk, so the received output is spendable and unlinkable from the change. Both come from the wallet key
    // and the consumed deposit's id, so a restored wallet re-derives them (the deposit id is public once the settle lands).
    const recvKeys = deriveOutput(walletPriv, depositId, 'send', 0);
    const recvNk = recvKeys.nk;
    const recipientOwner = pool.nkToOwner(recvNk);

    // Conservation kernel + aggregated BP+ range over [recipient, change]; the single input is the deposit.
    const rRecv = recvKeys.blinding;
    const txOutputs = [{ value: amount, blinding: rRecv, owner: recipientOwner }];
    // A separate nk for the change output too, same reasoning as recvNk above: reusing id.owner across
    // every change output lets the relay link all of a wallet's ops by that one constant owner.
    let rChange = null, changeNk = null, changeOwner = null;
    if (change > 0n) {
      const changeKeys = deriveOutput(walletPriv, depositId, 'change', 0);
      rChange = changeKeys.blinding;
      changeNk = changeKeys.nk;
      changeOwner = pool.nkToOwner(changeNk);
      txOutputs.push({ value: change, blinding: rChange, owner: changeOwner });
    }
    const t = _ct.buildTransfer({
      inputs: [{ value: depositValue, blinding: BigInt(depBlindingBn) }],
      outputs: txOutputs, fee, assetId: meta.assetId,
    });
    if (!_ct.verifyTransfer({ ...t, fee })) throw new Error('wrap-and-send: self-verify failed (conservation/range)');

    // Deposit opening sigma — its own domain (tacit-wraptransfer-intent-v1), distinct from plain buildWrap:
    // sharing a tag would let a settler honor this signature as a plain OP_WRAP instead, silently downgrading
    // the depositor's intended hidden send to a visible self-note.
    const cb = chainBindingHex();
    const ctx = pool.intentContext('tacit-wraptransfer-intent-v1', cb, meta.assetId, depositId, [[dcx, dcy, depOwner]], [depositValue]);
    const nonce = pool.deriveOpeningNonce(depBlinding, ctx, 'wrap');
    const sig = pool.openingSigma(depositValue, depBlinding, ctx, nonce);

    const beHex = (n) => '0x' + n.toString(16).padStart(64, '0');
    const ptHex = (P) => '0x' + _hex(P.toRawBytes(true));
    const xy = (P) => { const a = P.toAffine(); return { cx: beHex(a.x), cy: beHex(a.y) }; };
    const outOwners = [recipientOwner]; if (change > 0n) outOwners.push(changeOwner);
    const outMeta = txOutputs.map((_, j) => ({ ...xy(t.outC[j]), owner: outOwners[j] }));

    const op = {
      chainBinding: cb, asset: meta.assetId, value: depositValue.toString(),
      deposit: { cx: dcx, cy: dcy, owner: depOwner, nk: depSecret, sigR: sig.R, sigZ: sig.z },
      outputs: outMeta.map((m) => ({ cx: m.cx, cy: m.cy, owner: m.owner })),
      rangeProof: '0x' + _hex(t.rangeProof), kernel: { R: ptHex(t.kernel.R), z: beHex(t.kernel.z) },
      fee: fee.toString(),
    };

    // Recovery descriptors: the recipient note sealed to THEIR pubkey, the change to the sender's. The
    // recipient output's owner is H(recvNk) (a per-note key, per the note above) — its memo MUST carry
    // recvNk, not id.secret (the wallet-constant nk used by the change output below). id.secret does not
    // hash to recipientOwner, so sealing it here would recover a note whose embedded "spend key" satisfies
    // nk_to_owner(nk) == owner for NO nk anyone holds: the leaf-hash authenticator in confidential-memo.js
    // only checks (asset, cx, cy, owner), never secret, so this would decrypt cleanly and LOOK recovered,
    // then fail only at spend time (nk_to_owner mismatch in the guest) — permanently unspendable.
    const leaves = outMeta.map((m) => pool.leaf(meta.assetId, m.cx, m.cy, m.owner));
    const outputs = [{ value: amount.toString(), blinding: beHex(rRecv), secret: recvNk, asset: meta.assetId, owner: recipientOwner, cx: outMeta[0].cx, cy: outMeta[0].cy, ownerPub: recipientPubHex }];
    if (change > 0n) outputs.push({ value: change.toString(), blinding: beHex(rChange), secret: changeNk, asset: meta.assetId, owner: changeOwner, cx: outMeta[1].cx, cy: outMeta[1].cy, ownerPub: id.pubHex });
    const ephRand = freshEph;
    const memos = guard.sealMemosForOutputs({ outputs, ephRand });
    guard.assertOutputsRecoverable({ leaves, outputs, memos });

    return { op, leaves, outputs, memos, ephRand, depositCommit, depositId, amount, change, fee, asset: meta.assetId, amountWei: deposit, meta, index };
  }

  // Read an EIP-2612 token's current permit nonce for `owner` (USDC/USDT-style). Returns 0n on any miss so
  // the build still proceeds (the on-chain permit reverts on a stale nonce, surfacing the error there).
  async function _erc2612Nonce(token, owner) {
    try {
      const r = await ethCall(token, '0x' + _selector('nonces(address)') + _word(owner));
      return r && r !== '0x' ? BigInt(r) : 0n;
    } catch { return 0n; }
  }

  // ── 1-click LP / swap from an EXTERNAL wallet (OP_WRAP_LP = 32, OP_WRAP_SWAP = 33) ──
  // Two pending PUBLIC deposits (or one, for a swap) are consumed directly as the contribution/input, so the
  // intermediate shielded notes never materialize: one router tx instead of wrap→wrap→settle. A deposit's
  // value is EXACT and public (bound in deposit_id, gated on-chain as pending), which is why these ops need
  // no membership, nullifier, change or kernel — there is no hidden total to conserve.
  //
  // Deposit notes are wallet-DERIVED exactly like buildWrap (blinding and per-note owner = nkToOwner(nk) from
  // deriveNote(asset, index)), so the caller must have wrapped with the same (asset, index) pair; the deposit id
  // this recomputes then names the pending deposit that wrap created. `index` disambiguates concurrent deposits
  // of one asset.
  const ZERO_RCPT_HEX = '0x' + '00'.repeat(33); // canonical no-skim protocol-fee recipient

  function _depositLeg({ id, ticker, amountWei, index }) {
    const meta = assetByTicker[ticker];
    if (!meta) throw new Error(`unknown asset ${ticker}`);
    const deposit = BigInt(amountWei);
    const unitScale = BigInt(meta.unitScale);
    if (deposit <= 0n || deposit % unitScale !== 0n) throw new Error(`${ticker}: amount not aligned to unitScale`);
    const value = deposit / unitScale;
    if (value > (2n ** 64n - 1n)) throw new Error(`${ticker}: value exceeds u64`);
    const { secret, blinding: bn } = pool.deriveNote(id.priv, meta.assetId, index);
    const owner = pool.nkToOwner(secret);
    const blinding = '0x' + BigInt(bn).toString(16).padStart(64, '0');
    const { cx, cy } = pool.commitXY(value, blinding);
    return { meta, value, blinding, cx, cy, owner, depositId: pool.depositId(meta.assetId, value, cx, cy, owner) };
  }

  // OP_WRAP_LP — add liquidity straight from two pending deposits.
  async function wrapLp({ walletPriv, aTicker, bTicker, aAmountWei, bAmountWei, feeBps = 30, fee = 0n, deadline = 0n, aIndex = 0, bIndex = 0, selfRelay = false, maxDonationBps, waitOpts } = {}) {
    const id = identity(walletPriv);
    let A = _depositLeg({ id, ticker: aTicker, amountWei: aAmountWei, index: aIndex });
    let B = _depositLeg({ id, ticker: bTicker, amountWei: bAmountWei, index: bIndex });
    if (BigInt(A.meta.assetId) === BigInt(B.meta.assetId)) throw new Error('wrap-lp: pick two different assets');
    if (BigInt(A.meta.assetId) > BigInt(B.meta.assetId)) { const t = A; A = B; B = t; } // canonical pair order
    const assetA = A.meta.assetId, assetB = B.meta.assetId;
    const res = await poolReserves(routePoolId(assetA, assetB, feeBps));
    const rA = res ? BigInt(res.reserveA) : 0n, rB = res ? BigInt(res.reserveB) : 0n;
    const sharesPre = res ? BigInt(res.totalShares) : 0n;
    if (BigInt(fee) >= A.value) throw new Error('wrap-lp: fee >= A contribution');
    const addA = A.value - BigInt(fee);
    assertLpInRatio('wrap-lp', { addA, addB: B.value, reserveA: rA, reserveB: rB, sharesPre, maxDonationBps });
    const dShares = sharesPre === 0n
      ? _lp.isqrt(addA * B.value) - _lp.MINIMUM_LIQUIDITY
      : _lp.lpAddShares(sharesPre, addA, B.value, rA, rB);
    if (dShares <= 0n) throw new Error('wrap-lp: contribution below one share');

    const pid = _lp.poolId(assetA, assetB, feeBps);
    const lpAsset = _lp.lpShareId(pid);
    // The share's keys derive from the wallet key and the first consumed deposit (public once settled).
    const shareKeys = deriveOutput(walletPriv, A.depositId, 'lpShare', 0);
    const rShares = shareKeys.blinding;
    const sC = pool.commitXY(dShares, rShares);
    const cb = chainBindingHex();
    // Per-note owner for the minted share (confirmed against the guest source — main.rs's own
    // wrap_lp ctx binds `(lp_asset, pid, s_owner)` using the SAME s_owner as the share note's own tuple,
    // not a separate caller-identity binding, so this is safe to vary independently of id.owner): every
    // wrap-lp otherwise mints its share under the wallet-constant identity().owner, letting a relay link
    // every LP position a wallet opens by that one constant owner. The A/B deposit owners are the ones their
    // wraps committed (per-note, from _depositLeg), since those are already-public pending deposits.
    const shareNk = shareKeys.nk;
    const shareOwner = pool.nkToOwner(shareNk);
    // The shared ctx binds BOTH deposits, the minted share note and the pool identity, so a relay can
    // neither redirect the position nor settle it against a different pool/tier.
    const ctx = pool.intentContext('tacit-wrap-lp-v1', cb, assetA, assetB,
      [[A.cx, A.cy, A.owner], [B.cx, B.cy, B.owner], [sC.cx, sC.cy, shareOwner], [lpAsset, pid, shareOwner]],
      [A.value, B.value, dShares, BigInt(deadline), BigInt(fee)]);
    const sigOf = (leg, tag) => pool.openingSigma(leg.value, leg.blinding, ctx, pool.deriveOpeningNonce(leg.blinding, ctx, tag));
    const aSig = sigOf(A, 'wrap-lp-a'), bSig = sigOf(B, 'wrap-lp-b');
    const sSig = pool.openingSigma(dShares, rShares, ctx, pool.deriveOpeningNonce(rShares, ctx, 'wrap-lp-share'));

    const beHex = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
    // Wire shape = exactly what the prover harness (exec-wraplp) reads: `spendRoot` (zero — no tree notes are
    // spent), `a`/`b` deposits with their public `value`, the minted `share`, `opDeadline`, and every sigma as
    // the {R, z} pair `openingSigma` returns. `deadline` rides alongside for the relay's own deadline gate.
    const op = {
      op: 32, chainBinding: cb, spendRoot: '0x' + '00'.repeat(32), assetA, assetB, feeBps: Number(feeBps),
      protocolFeeBps: 0, protocolFeeRecipient: ZERO_RCPT_HEX,
      reserveAPre: rA.toString(), reserveBPre: rB.toString(), sharesPre: sharesPre.toString(),
      a: { value: A.value.toString(), cx: A.cx, cy: A.cy, owner: A.owner, sigR: aSig.R, sigZ: aSig.z },
      b: { value: B.value.toString(), cx: B.cx, cy: B.cy, owner: B.owner, sigR: bSig.R, sigZ: bSig.z },
      share: { cx: sC.cx, cy: sC.cy, owner: shareOwner, sigR: sSig.R, sigZ: sSig.z },
      opDeadline: BigInt(deadline).toString(), deadline: BigInt(deadline).toString(), fee: BigInt(fee).toString(),
      depositIds: [A.depositId, B.depositId],
    };
    const shareLeaf = pool.leaf(lpAsset, sC.cx, sC.cy, shareOwner);
    const outputs = [{ value: dShares.toString(), blinding: beHex(rShares), secret: shareNk, asset: lpAsset, owner: shareOwner, cx: sC.cx, cy: sC.cy, ownerPub: id.pubHex }];
    const ephRand = freshEph;
    const sealedMemos = guard.sealMemosForOutputs({ outputs, ephRand });
    guard.assertOutputsRecoverable({ leaves: [shareLeaf], outputs, memos: sealedMemos });
    const r = await _dispatch({ type: 'wraplp', spec: { op, leaves: [shareLeaf], outputs, ephRand }, sealedMemos, selfRelay, walletPriv, waitOpts, pair: sharesPre === 0n ? { assetA, assetB, feeBps } : null });
    return { ...r, dShares, pid, lpAsset, assetA, assetB, firstMint: sharesPre === 0n };
  }

  // OP_WRAP_SWAP — swap straight from one pending deposit. Fee-switch pools are NOT supported here (the
  // guest fails closed on a non-zero protocol fee); those route through the ordinary swap path.
  async function wrapSwap({ walletPriv, fromTicker, toTicker, amountWei, feeBps = 30, minOut = 0n, fee = 0n, deadline = 0n, index = 0, selfRelay = false, waitOpts } = {}) {
    const id = identity(walletPriv);
    const D = _depositLeg({ id, ticker: fromTicker, amountWei, index });
    const outMeta = assetByTicker[toTicker];
    if (!outMeta) throw new Error(`unknown asset ${toTicker}`);
    const inAsset = D.meta.assetId, outAsset = outMeta.assetId;
    if (BigInt(inAsset) === BigInt(outAsset)) throw new Error('wrap-swap: pick two different assets');
    const lo = BigInt(inAsset) < BigInt(outAsset);
    const assetA = lo ? inAsset : outAsset, assetB = lo ? outAsset : inAsset;
    const res = await poolReserves(routePoolId(assetA, assetB, feeBps));
    if (!res) throw new Error('wrap-swap: pool is not initialized');
    const rA = BigInt(res.reserveA), rB = BigInt(res.reserveB);
    if (BigInt(fee) >= D.value) throw new Error('wrap-swap: fee >= input');
    const swapIn = D.value - BigInt(fee);
    const [rIn, rOut] = lo ? [rA, rB] : [rB, rA];
    const amountOut = _route.getAmountOut(swapIn, rIn, rOut, feeBps);
    if (amountOut < BigInt(minOut)) throw new Error('wrap-swap: quote below minOut');

    const outKeys = deriveOutput(walletPriv, D.depositId, 'swapOut', 0);
    const rOutBl = outKeys.blinding;
    const oC = pool.commitXY(amountOut, rOutBl);
    const pid = _lp.poolId(assetA, assetB, feeBps);
    const cb = chainBindingHex();
    const direction = lo ? 0 : 1; // SWAP_DIR_A_TO_B / B_TO_A
    // Fresh per-note owner for the swap output (confirmed against the guest: main.rs's wrap_swap ctx binds
    // `(dep_id, pid, out_owner)` using the SAME out_owner as the output's own tuple, not a separate
    // caller-identity binding, so this is safe to vary independently of id.owner). `deposit.owner` is the
    // per-note owner the earlier wrap committed (from _depositLeg), since the deposit is already public.
    const outNk = outKeys.nk;
    const outOwner = pool.nkToOwner(outNk);
    const ctx = pool.intentContext('tacit-wrap-swap-v1', cb, assetA, assetB,
      [[D.cx, D.cy, D.owner], [oC.cx, oC.cy, outOwner], [D.depositId, pid, outOwner]],
      [BigInt(direction), D.value, amountOut, BigInt(minOut), BigInt(deadline), BigInt(fee)]);
    const dSig = pool.openingSigma(D.value, D.blinding, ctx, pool.deriveOpeningNonce(D.blinding, ctx, 'wrap-swap-in'));
    const oSig = pool.openingSigma(amountOut, rOutBl, ctx, pool.deriveOpeningNonce(rOutBl, ctx, 'wrap-swap-out'));

    const beHex = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
    // Wire shape = exactly what the prover harness (exec-wrapswap) reads: `spendRoot` (zero — no tree note is
    // spent), `opDeadline`, and every sigma as the {R, z} pair `openingSigma` returns. `deadline` rides
    // alongside for the relay's own deadline gate.
    const op = {
      op: 33, chainBinding: cb, spendRoot: '0x' + '00'.repeat(32), assetA, assetB, feeBps: Number(feeBps),
      protocolFeeBps: 0, protocolFeeRecipient: ZERO_RCPT_HEX,
      reserveAPre: rA.toString(), reserveBPre: rB.toString(), direction,
      amountIn: D.value.toString(), fee: BigInt(fee).toString(),
      deposit: { cx: D.cx, cy: D.cy, owner: D.owner, sigR: dSig.R, sigZ: dSig.z },
      minOut: BigInt(minOut).toString(),
      out: { cx: oC.cx, cy: oC.cy, owner: outOwner, sigR: oSig.R, sigZ: oSig.z },
      opDeadline: BigInt(deadline).toString(), deadline: BigInt(deadline).toString(),
      depositIds: [D.depositId],
    };
    const outLeaf = pool.leaf(outAsset, oC.cx, oC.cy, outOwner);
    const outputs = [{ value: amountOut.toString(), blinding: beHex(rOutBl), secret: outNk, asset: outAsset, owner: outOwner, cx: oC.cx, cy: oC.cy, ownerPub: id.pubHex }];
    const ephRand = freshEph;
    const sealedMemos = guard.sealMemosForOutputs({ outputs, ephRand });
    guard.assertOutputsRecoverable({ leaves: [outLeaf], outputs, memos: sealedMemos });
    const r = await _dispatch({ type: 'wrapswap', spec: { op, leaves: [outLeaf], outputs, ephRand }, sealedMemos, selfRelay, walletPriv, waitOpts });
    return { ...r, amountOut, pid, assetIn: inAsset, assetOut: outAsset };
  }

  // Atomic wrap-and-send the user broadcasts themselves: prove the OP_WRAP_TRANSFER witness (prove-only via
  // the box), then send ConfidentialRouter.wrapAndSettleETH{value} (native) or .wrapAndSettleWithPermit
  // (ERC20, gasless approve) from the wallet's own EVM account — the deposit funds + the recipient note settle
  // in ONE tx, no intermediate spendable note. The proof-bound `fee` stays 0 (user pays their own gas); the
  // self-sustaining wrap fee is a separate ETH skim (`ethFeeWei`) the router forwards to `feeRecipient`
  // (msg.value − wrapAmount for native; msg.value for ERC20). Set ethFeeWei=0 to run wrap as a loss-leader.
  async function wrapAndSend({ walletPriv, amountWei, ticker = 'cETH', recipientPubHex, amount, fee = 0n, ethFeeWei = 0n, feeRecipient, index, gasLimit = 1400000n, broadcast = true, permit = null, waitOpts, onBuilt } = {}) {
    if (!cfg.router) throw new Error('ConfidentialRouter not deployed for this network');
    if (BigInt(fee) !== 0n) throw new Error('wrap-and-send: the proof-bound fee must be 0 on the user-sent path (use ethFeeWei for the wrap fee)');
    ethFeeWei = BigInt(ethFeeWei || 0n);
    const skimTo = ethFeeWei > 0n ? (feeRecipient || cfg.relayFeeRecipient) : (feeRecipient || '0x0000000000000000000000000000000000000000');
    if (ethFeeWei > 0n && (!skimTo || /^0x0+$/i.test(skimTo))) throw new Error('wrap-and-send: ethFeeWei set but no feeRecipient');
    if (index == null) index = await nextWrapIndex({ walletPriv, ticker });
    const b = buildWrapTransferOp({ walletPriv, amountWei, ticker, recipientPubHex, amount, fee, index });
    // buildWrapTransferOp seals each memo under a fresh ephemeral, so the sealed memos are NON-deterministic. Surface
    // the exact memos+commit the proof will commit to BEFORE proving, so a caller can persist them and later
    // settle (or resume) with these same bytes — rebuilding would produce different memos → MemoLeafMismatch.
    onBuilt?.({ memos: b.memos, depositCommit: b.depositCommit, wrapAmount: b.amountWei.toString(), native: !!b.meta.native });
    // Prove-only: the box returns publicValues + proof for the dapp to embed in the user-sent router tx.
    // Pass the ALREADY-sealed b.memos through (not just outputs+ephRand) — ephRand is a re-invokable scalar
    // source, so letting submitOp reseal from scratch here would commit a memoRoot over a DIFFERENT sealing
    // than the b.memos embedded in the router calldata built below, reverting settle with MemoLeafMismatch.
    const proven = await relay.prove(
      { type: 'wraptransfer', op: b.op, leaves: b.leaves, outputs: b.outputs, ephRand: b.ephRand, memos: b.memos },
      waitOpts,
    );
    const acct = account(walletPriv);
    let value, calldata;
    if (b.meta.native) {
      value = b.amountWei + ethFeeWei; // wrapAmount + fee; router skims (msg.value − wrapAmount) to feeRecipient
      calldata = _router.wrapAndSettleETHCalldata({ wrapAmount: b.amountWei, commit: b.depositCommit, publicValues: proven.publicValues, proof: proven.proof, memos: proven.memos || b.memos, feeRecipient: skimTo });
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
        publicValues: proven.publicValues, proof: proven.proof, memos: proven.memos || b.memos, feeRecipient: skimTo,
      });
    }
    const nonce = BigInt(await rpc('eth_getTransactionCount', [acct.address, 'pending']));
    const tip = await _priorityTip();
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

  // Broadcasts a {to, value, calldata, gasLimit} payload this wallet's own key can sign for — what
  // resumeWrapAndSend (and anything else that hands back unsigned calldata instead of self-broadcasting,
  // like wrapAndSend's own external-wallet path) returns. wrapAndSend signs+sends internally because it always
  // sends from its own derived account; resumeWrapAndSend doesn't, since the caller may want to resume from a
  // different sender than whoever originally built the job. This is that missing last step for the common case
  // of resuming with the same wallet.
  async function sendPreparedTx({ walletPriv, to, value = 0n, calldata, gasLimit }) {
    const acct = account(walletPriv);
    return _sendEvmTx({ acct, to, value: BigInt(value), data: calldata, gasLimit: BigInt(gasLimit) });
  }

  // ── 1-click farm entry (OP_LP_BOND, op 29) ──
  // Add liquidity AND bond the resulting shares into a farm in ONE settle — OP_LP_ADD fused with
  // OP_FARM_BOND. Spends a whole A note + a whole B note (each opening-sigma bound), derives d_shares =
  // lpAddShares, and the guest emits a farm_receipt_leaf + bond directly — the intermediate LP-share note
  // never materializes. The A/B sigmas bind the bond target (controller, owner, nonce) into the same context
  // so a relay can't re-point the bonded liquidity. Mirrors tests/gen-confidential-lpbond-fixture.mjs.

  // The receipt key and nonce of an OP_LP_BOND position, derived from the wallet key and the position itself:
  // the controller, the LP-share asset, and the anchor = the leaf of the canonical-A note the bond spends. That
  // note is consumed by the bond, so the anchor is unique per position, and the wallet re-opens its own spent
  // notes from their memos, so a restored wallet re-derives every position key from chain + key alone. `owner`
  // is the BIP-340 x-only key the receipt commits to and OP_FARM_HARVEST / OP_FARM_UNBOND verify a signature
  // under; `ownerPriv` signs those. Neither is related to any other published value, so positions stay unlinkable.
  function lpBondPosition({ walletPriv, controller, lpAsset, anchorLeaf }) {
    if (!controller || !lpAsset || !anchorLeaf) throw new Error('lp-bond: position needs controller, lpAsset and anchorLeaf');
    const id = identity(walletPriv);
    const hb = (h, n) => Uint8Array.from((String(h).replace(/^0x/, '').padStart(n * 2, '0').match(/../g) || []).map((x) => parseInt(x, 16)));
    const enc = new TextEncoder();
    const body = [hb(String(controller).replace(/^0x/, '').slice(-40), 20), hb(lpAsset, 32), hb(anchorLeaf, 32)];
    // keccak(tag ‖ walletPriv ‖ controller ‖ lpAsset ‖ anchor): keyed by the wallet scalar, as identity() is.
    const tagged = (tag) => {
      const t = enc.encode(tag);
      const m = new Uint8Array(t.length + id.priv.length + 84); m.set(t); m.set(id.priv, t.length); let o = t.length + id.priv.length;
      for (const x of body) { m.set(x, o); o += x.length; }
      return keccak256(m);
    };
    let d = 0n; for (const x of tagged('tacit-evm-lp-bond-receipt-key-v1')) d = (d << 8n) | BigInt(x);
    d %= SECP_N; if (d === 0n) d = 1n;
    const ownerPriv = '0x' + d.toString(16).padStart(64, '0');
    const owner = '0x' + _hex(secp.getPublicKey(hb(ownerPriv, 32), true).subarray(1));
    const nonce = '0x' + _hex(tagged('tacit-evm-lp-bond-nonce-v1'));
    return { owner, ownerPriv, nonce };
  }

  function buildLpBondOp({ walletPriv, controller, aNote, bNote, feeBps = 30, reserveAPre, reserveBPre, sharesPre, opDeadline = 0n, fee = 0n, maxDonationBps } = {}) {
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
    // OP_LP_BOND spends both notes whole and has no change leg, so the notes themselves must be in ratio.
    assertLpInRatio('lp-bond', { addA: dA - fee, addB: dB, reserveA: rA, reserveB: rB, sharesPre: S, maxDonationBps });
    const dShares = pool.lpAddShares(S, dA - fee, dB, rA, rB);
    if (dShares <= 0n) throw new Error('lp-bond: zero derived shares (check the add ratio / reserves)');

    const addr20 = (a) => '0x' + String(a).replace(/^0x/, '').padStart(40, '0').slice(-40);
    const controller32 = '0x' + '00'.repeat(12) + addr20(controller).replace(/^0x/, '');
    const cb = chainBindingHex();
    const pid = pool.evmPoolId(assetA, assetB, feeBps), lpAsset = pool.evmLpShareId(pid); // bind pool identity
    // Mirror the guest exactly: the A/B tuples carry the notes' OWN owners (the ones the wire sends and the guest
    // hashes), and the amounts are [d_a, d_b, d_shares, op_deadline, fee] — the entry checkpoint is stamped at
    // execution by the controller, so it is deliberately NOT part of the authorization.
    const aOwner = nA.owner || id.owner, bOwner = nB.owner || id.owner;
    // The receipt is owned by this position's own BIP-340 key (never the wallet-constant nk-hash owner, which has
    // no discrete log and so could never sign the harvest or unbond).
    const anchorLeaf = pool.leaf(assetA, nA.cx, nA.cy, aOwner);
    const position = lpBondPosition({ walletPriv, controller: addr20(controller), lpAsset, anchorLeaf });
    const { owner, nonce: bondNonce } = position;
    // ctx binds A,B + the bond target (controller32, bond_nonce, owner) + the deltas incl. DERIVED d_shares.
    const ctx = pool.intentContext('tacit-lp-bond-v1', cb, assetA, assetB,
      [[nA.cx, nA.cy, aOwner], [nB.cx, nB.cy, bOwner], [controller32, bondNonce, owner], [lpAsset, pid, owner]],
      [dA, dB, dShares, BigInt(opDeadline), fee]);
    const aSig = pool.openingSigma(dA, nA.blinding, ctx, pool.deriveOpeningNonce(nA.blinding, ctx, 'lp-bond-a'));
    const bSig = pool.openingSigma(dB, nB.blinding, ctx, pool.deriveOpeningNonce(nB.blinding, ctx, 'lp-bond-b'));
    if (!pool.verifyOpeningSigma(nA.cx, nA.cy, dA, aSig.R, aSig.z, ctx)) throw new Error('lp-bond: A sigma self-verify failed');
    if (!pool.verifyOpeningSigma(nB.cx, nB.cy, dB, bSig.R, bSig.z, ctx)) throw new Error('lp-bond: B sigma self-verify failed');

    const op = {
      chainBinding: cb, spendRoot: nA.root, controller: addr20(controller), owner,
      bondNonce, assetA, assetB, feeBps: Number(feeBps),
      reserveAPre: rA.toString(), reserveBPre: rB.toString(), sharesPre: S.toString(),
      a: { cx: nA.cx, cy: nA.cy, owner: aOwner, nk: nA.secret, index: Number(nA.leafIndex), path: nA.path, d: dA.toString(), sigR: aSig.R, sigZ: aSig.z },
      b: { cx: nB.cx, cy: nB.cy, owner: bOwner, nk: nB.secret, index: Number(nB.leafIndex), path: nB.path, d: dB.toString(), sigR: bSig.R, sigZ: bSig.z },
      opDeadline: Number(opDeadline), fee: fee.toString(),
    };
    // The one leaf the guest emits: the receipt, committing (controller, lpAsset, d_shares, owner, nonce).
    const receiptLeaf = pool.farmReceiptLeaf(controller32, lpAsset, dShares, owner, bondNonce);
    return { op, dShares, assetA, assetB, dA, dB, lpAsset, pid, bondNonce, receiptOwner: owner, receiptLeaf, anchorLeaf };
  }

  // Two notes one op spends prove their membership against one root, the A note's. A note made by a split moments
  // ago and a note from an earlier scan carry paths to different roots, and the guest cannot prove the second against
  // the first's: the proof request comes back unexecutable. Notes whose roots differ are both taken from one fresh
  // scan (`scan` stands in for balance()).
  async function sameRoot(walletPriv, a, b, { scan = balance } = {}) {
    const lcs = (x) => String(x || '').toLowerCase();
    if (a && b && a.root && lcs(a.root) === lcs(b.root)) return [a, b];
    const same = (x, n) => (x.leaf && n.leaf ? lcs(x.leaf) === lcs(n.leaf) : BigInt(x.cx) === BigInt(n.cx) && BigInt(x.cy) === BigInt(n.cy));
    const { notes = [] } = await scan(walletPriv);
    const a2 = notes.find((x) => same(x, a)), b2 = notes.find((x) => same(x, b));
    if (!a2 || !b2) throw new Error('a note to spend is not in a fresh scan (already spent, or not visible yet) — rescan and retry in a moment');
    if (lcs(a2.root) !== lcs(b2.root)) throw new Error('the notes to spend came back under two roots — retry in a moment');
    return [a2, b2];
  }

  // Build + settle a 1-click farm entry. Reads the pair's live reserves, derives the shares, and submits the
  // OP_LP_BOND witness through the relay. The guest emits one leaf (the receipt), so the settle carries one memo
  // for it: the empty seed-derived memo, since the receipt key and nonce re-derive from the wallet key and the
  // spent A note (lpBondPosition) and the shares are public in the bond's CdpMint.
  async function lpBond({ walletPriv, controller, aNote, bNote, feeBps = 30, selfRelay = false, selfSettle = null, maxDonationBps, waitOpts } = {}) {
    if (!controller) throw new Error('lp-bond: farm controller not configured for this network');
    [aNote, bNote] = await sameRoot(walletPriv, aNote, bNote);
    const res = await poolReserves(routePoolId(aNote.asset, bNote.asset, feeBps));
    if (!res) throw new Error('lp-bond: pool not initialized for this pair / fee tier');
    const b = buildLpBondOp({
      walletPriv, controller, aNote, bNote, feeBps,
      reserveAPre: res.reserveA, reserveBPre: res.reserveB, sharesPre: res.totalShares, maxDonationBps,
    });
    const leaves = [b.receiptLeaf];
    const outputs = [{ seedDerived: true }];
    const sealedMemos = guard.sealMemosForOutputs({ outputs, ephRand: freshEph });
    guard.assertOutputsRecoverable({ leaves, outputs, memos: sealedMemos });
    const r = await _dispatch({ type: 'lpbond', spec: { op: b.op, leaves, outputs, ephRand: freshEph }, sealedMemos, selfRelay, selfSettle, walletPriv, waitOpts });
    return { ...r, dShares: b.dShares, bondNonce: b.bondNonce, receiptOwner: b.receiptOwner, receiptLeaf: b.receiptLeaf, anchorLeaf: b.anchorLeaf, lpAsset: b.lpAsset, assetA: b.assetA, assetB: b.assetB };
  }

  // ── launch farm program (FarmManager) ──
  // The manager keys a position by its RECEIPT leaf. The receipt key + nonce of a bonded LP-share note derive from the
  // wallet key, the manager, the LP asset and that note's leaf (lpBondPosition), so a wallet restored from its seed
  // finds every position again from chain state alone. Nothing here returns a receipt key.
  const _farmCfg = () => {
    if (!cfg.farm || !cfg.farm.manager) throw new Error('farm: no farm program on this network');
    return cfg.farm;
  };
  const _farmC32 = (manager) => '0x' + '00'.repeat(12) + String(manager).replace(/^0x/, '').toLowerCase();
  const _scanKeyHex = (p) => (p instanceof Uint8Array ? '0x' + _hex(p) : (String(p).startsWith('0x') ? String(p) : '0x' + String(p)));
  const _noteLeaf = (n) => pool.leaf(n.asset, n.cx, n.cy, n.owner);
  function farmProgram() {
    return makeConfidentialFarmProgram({ rpc, config: { pool: cfg.pool, ..._farmCfg() } });
  }

  // Bond one whole LP-share note into the manager. The receipt key + nonce are the deterministic position key
  // for (manager, lpAsset, this note's leaf); the note is spent by the bond, so the position is unique.
  async function farmBond({ walletPriv, controller, lpNote, waitOpts } = {}) {
    const farm = _farmCfg();
    if (!lpNote) throw new Error('farm-bond: an LP-share note is required');
    if (controller && String(controller).toLowerCase() !== farm.manager.toLowerCase()) throw new Error('farm-bond: controller is not the configured farm manager');
    const lpAsset = String(lpNote.asset).toLowerCase();
    const pid = await farmProgram().pidOf(lpAsset);
    if (pid == null) throw new Error('farm-bond: the farm has no pool for this LP asset');
    const anchorLeaf = _noteLeaf(lpNote);
    const { owner, nonce } = lpBondPosition({ walletPriv, controller: farm.manager, lpAsset, anchorLeaf });
    const leg = { cx: lpNote.cx, cy: lpNote.cy, value: String(lpNote.value), index: Number(lpNote.leafIndex), path: lpNote.path, blinding: lpNote.blinding, owner: lpNote.owner, nk: lpNote.secret };
    const r = await defiActions(walletPriv).bondFarm({ controller: farm.manager, nonce, lpAsset, legs: [leg], spendRoot: lpNote.root, receiptOwner: owner, waitOpts });
    const receiptLeaf = pool.farmReceiptLeaf(_farmC32(farm.manager), lpAsset, BigInt(lpNote.value), owner, nonce);
    return { ...r, pid, lpAsset, shares: String(lpNote.value), anchorLeaf, receiptLeaf, receiptOwner: owner };
  }

  // The wallet's live farm positions, re-derived from chain + key. Two channels:
  //  - every LP-share note the wallet ever held for a configured pool is a candidate anchor (farmBond anchors on it);
  //  - the manager's public Bonded(receipt, pid, shares, unlockAt) events, each tried against every note the wallet has
  //    held as an anchor (lpBond anchors on the canonical-A note it spent): a position counts when its derived receipt
  //    leaf equals a Bonded receipt of that pool. The wallet's own spent notes are re-opened from their memos and the
  //    wrap / change walks, so no local record is needed.
  // Either way a candidate counts only when its receipt leaf is in the pool tree and the manager still holds it live.
  // A position opened under a random key cannot be derived: it is listed from a record stored by importFarmPosition.
  // opts: { walletPriv, events } — `events` may already carry the manager's Bonded events (fetchEvents include 'bonds').
  async function farmPositions({ walletPriv, events, _scan = null, _diag = null } = {}) {
    const farm = _farmCfg();
    const lpAssets = new Set((farm.pools || []).map((p) => String(p.lpAsset).toLowerCase()));
    const evs = events || await fetchEvents({ include: ['wraps', 'bonds'] });
    const st = _scan || await _scanNotes({ walletPriv, events: evs, cbtc: false, bridge: false });
    const { slot } = st;
    const c32 = _farmC32(farm.manager);
    const hits = new Map();
    const held = st.owned.filter((n) => lpAssets.has(String(n.asset).toLowerCase()));
    for (const n of held) {
      const lpAsset = String(n.asset).toLowerCase();
      const anchorLeaf = _noteLeaf(n);
      const { owner, nonce } = lpBondPosition({ walletPriv, controller: farm.manager, lpAsset, anchorLeaf });
      const receiptLeaf = pool.farmReceiptLeaf(c32, lpAsset, BigInt(n.value), owner, nonce);
      const receiptIndex = slot.get(receiptLeaf.toLowerCase());
      if (receiptIndex != null) hits.set(receiptLeaf.toLowerCase(), { lpAsset, anchorLeaf, receiptLeaf, receiptIndex, via: 'lp-note' });
    }
    const bonded = evs.filter((e) => e && e.type === 'Bonded');
    const derived = recovery().deriveFarmPositions({
      bonded, pools: farm.pools || [], anchors: st.owned.map((n) => ({ leaf: _noteLeaf(n) })), manager: farm.manager,
      lpBondPosition: ({ controller, lpAsset, anchorLeaf }) => lpBondPosition({ walletPriv, controller, lpAsset, anchorLeaf }),
    });
    for (const d of derived.found) {
      const receiptIndex = slot.get(d.receiptLeaf);
      if (receiptIndex != null && !hits.has(d.receiptLeaf)) hits.set(d.receiptLeaf, { lpAsset: d.lpAsset, anchorLeaf: d.anchorLeaf, receiptLeaf: d.receiptLeaf, receiptIndex, via: 'bonded-event' });
    }
    const imported = [];
    for (const rec of await _importedFarmRecords(walletPriv)) {
      const receiptIndex = slot.get(String(rec.receiptLeaf).toLowerCase());
      if (receiptIndex == null || hits.has(String(rec.receiptLeaf).toLowerCase())) continue;
      hits.set(String(rec.receiptLeaf).toLowerCase(), { lpAsset: rec.lpAsset, anchorLeaf: null, receiptLeaf: rec.receiptLeaf, receiptIndex, via: 'imported-record' });
      imported.push(rec.receiptLeaf);
    }
    const prog = farmProgram();
    const list = [...hits.values()];
    const live = await Promise.all(list.map((h) => prog.position(h.receiptLeaf)));
    if (_diag) {
      Object.assign(_diag, {
        bondedEvents: bonded.length, derivedFromEvents: derived.found.length, anchorsTried: st.owned.length,
        bondedNotDerived: derived.unresolved.length, importedRecords: imported.length, checkedLive: list.length,
        derivedClosed: list.filter((_h, i) => !live[i].live).map((h) => h.receiptIndex),
        receipts: list.map((h) => ({ receiptLeaf: h.receiptLeaf, lpAsset: h.lpAsset })),
      });
    }
    return list.map((h, i) => ({ h, p: live[i] })).filter(({ p }) => p.live).map(({ h, p }) => ({
      pid: p.pid, pair: (_farmPoolOf(h.lpAsset) || {}).pair || null, controller: farm.manager, lpAsset: h.lpAsset,
      shares: p.shares, receiptLeaf: h.receiptLeaf, receiptIndex: h.receiptIndex, anchorLeaf: h.anchorLeaf,
      unlockAt: p.unlockAt, pendingUnits: p.pendingUnits, pendingTac: p.pendingTac,
      ...(h.via === 'imported-record' ? { imported: true } : {}),
    })).sort((a, b) => a.receiptIndex - b.receiptIndex);
  }
  const _farmPoolOf = (lpAsset) => (_farmCfg().pools || []).find((p) => String(p.lpAsset).toLowerCase() === String(lpAsset).toLowerCase());

  // Positions whose receipt key is not derivable from the wallet key (opened under a random key) are kept as records the
  // holder saved: { lpAsset, shares, receiptLeaf, owner, nonce, ownerPriv }. importFarmPosition checks a record against the
  // chain before storing it: the receipt leaf must reproduce from (manager, lpAsset, shares, owner, nonce), ownerPriv must be
  // the private key of the x-only owner, the leaf must be in the pool tree and the manager must hold it live for that pool.
  // `ownerPriv` here is the one secret in this module that no derivation can replace — the position was opened
  // under a key this wallet never generated — so the record is sealed at rest under the wallet key instead of
  // being written in the clear (confidential-secret-store.js). A record an older build wrote in the clear is
  // still read, and resealed on the next import.
  const _farmStore = makeImportedFarmStore({ sha256 });
  const _importedFarmRecords = (walletPriv) => _farmStore.list(walletPriv);
  async function importFarmPosition(record, { events, walletPriv } = {}) {
    const farm = _farmCfg();
    const r = record || {};
    const hex32 = (v, what) => { const h = String(v || '').toLowerCase(); if (!/^0x[0-9a-f]{64}$/.test(h)) throw new Error(`farm-import: ${what} must be a 32-byte hex value`); return h; };
    const rec = {
      lpAsset: hex32(r.lpAsset, 'lpAsset'), receiptLeaf: hex32(r.receiptLeaf, 'receiptLeaf'),
      owner: hex32(r.owner, 'owner'), nonce: hex32(r.nonce, 'nonce'), ownerPriv: hex32(r.ownerPriv, 'ownerPriv'), shares: String(BigInt(r.shares)),
    };
    if (r.controller && String(r.controller).toLowerCase() !== farm.manager.toLowerCase()) throw new Error('farm-import: the record is for a different farm manager');
    if (!_farmPoolOf(rec.lpAsset)) throw new Error('farm-import: the farm has no pool for this LP asset');
    const derivedLeaf = pool.farmReceiptLeaf(_farmC32(farm.manager), rec.lpAsset, BigInt(rec.shares), rec.owner, rec.nonce);
    if (derivedLeaf.toLowerCase() !== rec.receiptLeaf) throw new Error('farm-import: the record keys do not reproduce the receipt leaf');
    const xOnly = '0x' + _hex(secp.getPublicKey(Uint8Array.from((rec.ownerPriv.slice(2).match(/../g)).map((h) => parseInt(h, 16))), true).subarray(1));
    if (xOnly !== rec.owner) throw new Error('farm-import: ownerPriv is not the private key of the receipt owner');
    const evs = events || await fetchEvents();
    const { leaves } = indexer.index(evs);
    if (!leaves.some((l) => l && String(l.leaf).toLowerCase() === rec.receiptLeaf)) throw new Error('farm-import: the receipt leaf is not in the pool tree');
    const prog = farmProgram();
    const cur = await prog.position(rec.receiptLeaf);
    if (!cur.live) throw new Error('farm-import: the manager does not hold this position live (already unbonded?)');
    const pid = await prog.pidOf(rec.lpAsset);
    if (pid == null || Number(cur.pid) !== Number(pid) || String(cur.shares) !== rec.shares) throw new Error('farm-import: the record does not match the manager\'s position');
    // Without a wallet key there is nothing to seal the record under, and it is not written in the clear: it
    // stays valid for this session and the caller is told it did not persist.
    const saved = await _farmStore.add(walletPriv || null, rec);
    await _farmStore.migrate(walletPriv || null).catch(() => ({}));
    return { imported: true, persisted: saved.persisted, receiptLeaf: rec.receiptLeaf, pid: cur.pid, lpAsset: rec.lpAsset, shares: cur.shares, unlockAt: cur.unlockAt, pendingUnits: cur.pendingUnits };
  }

  // Re-derive a position's receipt key from the wallet, confirm it matches the receipt the caller holds, and take
  // the membership proof + root from a fresh tree.
  const FARM_UNBOND_DUST_UNITS = 100000n; // 0.001 TAC of pending reward is not worth blocking an exit over
  async function _farmReceipt({ walletPriv, position }) {
    const farm = _farmCfg();
    if (!position || !position.receiptLeaf) throw new Error('farm: a position from farmPositions is required');
    const shares = BigInt(position.shares);
    // A position recovered from chain re-derives its key from the anchor note; one opened under a random key uses the
    // record importFarmPosition stored (looked up by receipt leaf, never taken from the caller's object).
    const stored = (await _importedFarmRecords(walletPriv)).find((r) => String(r.receiptLeaf).toLowerCase() === String(position.receiptLeaf).toLowerCase());
    if (!stored && !position.anchorLeaf) throw new Error('farm: a position from farmPositions is required');
    const keys = stored ? { owner: stored.owner, nonce: stored.nonce, ownerPriv: stored.ownerPriv }
      : lpBondPosition({ walletPriv, controller: farm.manager, lpAsset: position.lpAsset, anchorLeaf: position.anchorLeaf });
    const leaf = pool.farmReceiptLeaf(_farmC32(farm.manager), position.lpAsset, shares, keys.owner, keys.nonce);
    if (leaf.toLowerCase() !== String(position.receiptLeaf).toLowerCase()) throw new Error('farm: this position does not belong to this wallet');
    const cur = await farmProgram().position(leaf);
    if (!cur.live) throw new Error('farm: position is not live (already unbonded?)');
    const evs = await fetchEvents({ include: ['bonds'] });
    const { leaves } = indexer.index(evs);
    const idx = leaves.findIndex((l) => l && String(l.leaf).toLowerCase() === leaf.toLowerCase());
    if (idx < 0) throw new Error('farm: receipt leaf not in the pool tree yet');
    const tree = indexer.buildTree(leaves);
    // How many harvests this receipt has had: the ordinal of the next one, which its output keys derive from.
    const harvestCount = evs.filter((e) => e && e.type === 'Harvested' && lc(e.receipt) === lc(leaf)).length;
    return { keys, shares, idx, path: tree.rootAndPath(idx).path, root: tree.root(), cur, receiptLeaf: leaf, harvestCount };
  }

  // Claim yield without unstaking. The reward note opens to (claim − fee); the claim is `claimBps` of what is
  // pending now, read at build time: accrual only grows while the proof is built, so the full pending amount is always
  // claimable, and whatever accrues during proving is not carried over (a harvest re-stamps the position).
  async function farmHarvest({ walletPriv, position, fee = 0n, claimBps = 10000n, waitOpts } = {}) {
    const farm = _farmCfg();
    fee = BigInt(fee);
    const rc = await _farmReceipt({ walletPriv, position });
    const reward = (BigInt(rc.cur.pendingUnits) * BigInt(claimBps)) / 10000n;
    if (reward <= fee) throw new Error('farm-harvest: nothing to claim beyond the relay fee yet');
    // The reward note's keys and the harvest's freshness nonce derive from the wallet key, the receipt and the harvest's ordinal.
    // A harvest does not spend the receipt, so the receipt leaf is the anchor; two harvests never share an ordinal.
    const rk = deriveOutput(walletPriv, rc.receiptLeaf, 'harvest', rc.harvestCount);
    const rb = rk.blinding, rewardNk = rk.nk;
    const rewardNote = { ...pool.commitXY(reward - fee, rb), blinding: rb };
    const r = await defiActions(walletPriv).harvestFarm({
      controller: farm.manager, shares: rc.shares, nonce: rc.keys.nonce, harvestNonce: deriveOutput(walletPriv, rc.receiptLeaf, 'harvestNonce', rc.harvestCount).nk,
      reward, oldIndex: rc.idx, oldPath: rc.path, lpAsset: position.lpAsset, rewardAsset: farm.rewardAsset, rewardNote, rewardNk,
      fee, spendRoot: rc.root, receiptOwner: rc.keys.owner, receiptOwnerPriv: rc.keys.ownerPriv, waitOpts,
    });
    return { ...r, reward, fee, net: reward - fee };
  }

  // Exit: the receipt is spent and the LP shares come back as a fresh owned note. Self-settled (fee 0): an AMM
  // LP-share id is not a pool-registered asset, so it cannot pay a relay fee.
  async function farmUnbond({ walletPriv, position, forfeitPending = false, waitOpts } = {}) {
    const farm = _farmCfg();
    const rc = await _farmReceipt({ walletPriv, position });
    if (rc.cur.unlockAt > Math.floor(Date.now() / 1000)) throw new Error(`farm-unbond: locked until ${rc.cur.unlockAt}`);
    // Unbonding retires the position, so reward that has not been harvested is not paid out. Refuse to do that by
    // accident: harvest first, or pass forfeitPending: true to unbond without it (dust below the threshold is ignored).
    const pendingUnits = BigInt(rc.cur.pendingUnits || 0);
    if (!forfeitPending && pendingUnits > FARM_UNBOND_DUST_UNITS) {
      throw new Error(`farm-unbond: ${pendingUnits} reward units are still pending and would be forfeited; harvest first, or pass forfeitPending: true`);
    }
    const uk = deriveOutput(walletPriv, rc.receiptLeaf, 'unbond', 0);
    const ub = uk.blinding, lpNk = uk.nk;
    const releaseNote = { ...pool.commitXY(rc.shares, ub), blinding: ub };
    const r = await defiActions(walletPriv).unbondFarm({
      controller: farm.manager, shares: rc.shares, nonce: rc.keys.nonce, lpAsset: position.lpAsset, oldIndex: rc.idx, oldPath: rc.path,
      releaseNote, lpNk, fee: 0n, spendRoot: rc.root, receiptOwner: rc.keys.owner, receiptOwnerPriv: rc.keys.ownerPriv, waitOpts,
    });
    return { ...r, shares: rc.shares };
  }

  // Farmed reward note → TAC. Step one is the pool's relayed unwrap of the wTAC note to `to` (default: this wallet's
  // derived EVM account); the steps still to do come back as data for a UI to drive: WrappedTac.withdraw turns the
  // wTAC ERC20 into the TAC ERC20 1:1, and a wrap puts that TAC back into the pool as a TAC note.
  async function farmRedeem({ walletPriv, note, to, feeOpts, wait = false, waitOpts } = {}) {
    const farm = _farmCfg();
    if (!note || String(note.asset).toLowerCase() !== String(farm.rewardAsset).toLowerCase()) throw new Error('farm-redeem: a farm reward (wTAC) note is required');
    const recipient = _evmAddr(to || account(walletPriv).address, 'farm-redeem: recipient');
    const u = await unwrap({ note, walletPriv, recipient, feeOpts, wait, waitOpts });
    const wei = BigInt(u.net) * BigInt(farm.unitScale || 10n ** 10n);
    const withdrawData = '0x' + _selector('withdraw(uint256,address)') + _word(wei) + _word(recipient);
    return {
      unwrap: { jobId: u.jobId, status: u.status, txHash: u.txHash || null, fee: u.fee, net: u.net },
      recipient,
      next: [
        { step: 'withdraw', to: farm.rewardToken, data: withdrawData, amountWei: wei.toString(), note: 'once the wTAC ERC20 has landed; withdraw the balance actually received' },
        { step: 'wrap', ticker: 'TAC', token: farm.tac, amountWei: wei.toString(), note: 'optional: buildWrap/wrap the TAC ERC20 back into a TAC note' },
      ],
    };
  }

  // Plain confidential LP add / pool init (OP_LP_ADD) — the DEFAULT liquidity path (farm bonding via lpBond is
  // the optional variant when a FarmController is configured). Spends an A note + a B note, mints a recoverable
  // LP-share note back to the provider (sealed like a transfer output), and settles through the relay (type
  // 'lp'). First mint (empty pool, sharesPre==0) sets the price; later adds use the off-ratio-safe min rule.
  // poolId/lpShareId are byte-identical to pool.evmPoolId/evmLpShareId (verified), so this targets the same
  // pool swaps trade against. The witness is produced by the canonical assembler (confidential-lp.buildAdd).
  // PARTIAL ADDS: pass `contributeA` / `contributeB` to add less than a note's full value — the remainder
  // comes back as a change note in the SAME settle, with no separate split settle. Omit them to add
  // whole notes.
  // Reshapes buildAdd's internal op into the wire shape harnesses/exec-lp.rs parses (the file the
  // build-provers CI pipeline actually compiles exec-lp from — see build-all-network.sh, which copies
  // harnesses/exec-<op>.rs over harnesses/src/main.rs before building): dA/dB top-level decimal
  // strings (siblings of a/b, not nested a.d/b.d), sSig top-level (not merged into share), aKernel/
  // bKernel as nested {R,z} (not flat aKernelR/aKernelZ). reserveAPre/reserveBPre/sharesPre are
  // already top-level decimal strings on op and need no reshaping.
  function toLpAddWire(op) {
    const { dA, dB, share, sSig, aKernelR, aKernelZ, bKernelR, bKernelZ, ...rest } = op;
    const wire = JSON.parse(JSON.stringify(rest, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
    wire.dA = dA.toString();
    wire.dB = dB.toString();
    wire.share = { cx: share.cx, cy: share.cy, owner: share.owner };
    wire.sSig = { R: sSig.R, z: sSig.z };
    wire.aKernel = { R: aKernelR, z: aKernelZ };
    wire.bKernel = { R: bKernelR, z: bKernelZ };
    wire.deadline = Number(op.deadline ?? 0n);
    wire.fee = Number(op.fee ?? 0n);
    return wire;
  }
  async function lpAdd({ walletPriv, aNote, bNote, feeBps = 30, fee = 0n, deadline = 0n, selfRelay = false, contributeA = null, contributeB = null, maxDonationBps, waitOpts } = {}) {
    if (!aNote || !bNote) throw new Error('lp-add: need an A note and a B note');
    if (BigInt(aNote.asset) === BigInt(bNote.asset)) throw new Error('lp-add: A and B must be different assets');
    [aNote, bNote] = await sameRoot(walletPriv, aNote, bNote);
    const id = identity(walletPriv);
    let nA = aNote, nB = bNote;
    let cA = contributeA == null ? null : BigInt(contributeA);
    let cB = contributeB == null ? null : BigInt(contributeB);
    if (BigInt(nA.asset) > BigInt(nB.asset)) { [nA, nB] = [nB, nA]; [cA, cB] = [cB, cA]; } // canonical pair order
    const assetA = nA.asset, assetB = nB.asset;
    const dA = cA == null ? BigInt(nA.value) : cA;
    const dB = cB == null ? BigInt(nB.value) : cB;
    if (dA <= 0n || dB <= 0n) throw new Error('lp-add: contribution must be positive');
    if (dA > BigInt(nA.value) || dB > BigInt(nB.value)) throw new Error('lp-add: contribution exceeds the note');
    // One BP+ proof spans BOTH legs' change, so the JOINT count must be a legal aggregation size
    // {0,1,2,4,8} — the guest asserts this too. 0, 1 or 2 change notes is all this path can produce.
    const changeA = BigInt(nA.value) - dA;
    const changeB = BigInt(nB.value) - dB;
    // Per-note owner for each new output (share + change) rather than the wallet-constant identity().owner — confirmed
    // safe against confidential-lp.js's addCtx, which binds `(lpAsset, pid, op.share.owner)` using the SAME share owner,
    // not a separate caller identity. Keys derive from the wallet key and the first spent note's nullifier.
    const anchor = _noteAnchor(nA, id);
    const keysA = changeA > 0n ? deriveOutput(walletPriv, anchor, 'change', 0) : null;
    const keysB = changeB > 0n ? deriveOutput(walletPriv, anchor, 'change', 1) : null;
    const rChangeA = keysA ? keysA.blinding : null;
    const rChangeB = keysB ? keysB.blinding : null;
    const nkA = keysA ? keysA.nk : null;
    const nkB = keysB ? keysB.nk : null;
    const changeOwnerA = nkA ? pool.nkToOwner(nkA) : null;
    const changeOwnerB = nkB ? pool.nkToOwner(nkB) : null;
    const aChange = changeA > 0n ? [{ value: changeA, blinding: rChangeA, owner: changeOwnerA }] : [];
    const bChange = changeB > 0n ? [{ value: changeB, blinding: rChangeB, owner: changeOwnerB }] : [];
    const res = await poolReserves(routePoolId(assetA, assetB, feeBps));
    const reserveAPre = res ? BigInt(res.reserveA) : 0n;
    const reserveBPre = res ? BigInt(res.reserveB) : 0n;
    const sharesPre = res ? BigInt(res.totalShares) : 0n;
    if (BigInt(fee) >= dA) throw new Error('lp-add: fee >= A contribution');
    assertLpInRatio('lp-add', { addA: dA - BigInt(fee), addB: dB, reserveA: reserveAPre, reserveB: reserveBPre, sharesPre, maxDonationBps });
    const shareKeys = deriveOutput(walletPriv, anchor, 'lpShare', 0);
    const rShares = shareKeys.blinding;
    const shareNk = shareKeys.nk;
    const shareOwner = pool.nkToOwner(shareNk);
    // Spend legs carry the note's OWN published owner and its nk: the guest re-derives the input leaf and
    // asserts nk_to_owner(nk) == owner, so a wallet-level owner or a missing nk fails the spend.
    const noteRef = (n) => ({ owner: n.owner || id.owner, nk: n.secret, leafIndex: Number(n.leafIndex), path: n.path });
    const op = _lp.buildAdd({
      assetA, assetB, chainBinding: chainBindingHex(), feeBps,
      reserveAPre, reserveBPre, sharesPre,
      aNote: noteRef(nA), bNote: noteRef(nB),
      dA, dB,
      rA: BigInt(nA.blinding), rB: BigInt(nB.blinding),
      shareOwner, rShares, deadline, fee: BigInt(fee),
      aChange, bChange,
    });
    op.spendRoot = nA.root; // membership root (both spent notes share it)

    // Recoverable LP-share note — sealed to the provider exactly like a transfer output.
    const beHex = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
    const pid = _lp.poolId(assetA, assetB, feeBps);
    const lpAsset = _lp.lpShareId(pid);
    const shareLeaf = pool.leaf(lpAsset, op.share.cx, op.share.cy, shareOwner);
    const shareOutput = { value: op.dShares.toString(), blinding: beHex(rShares), secret: shareNk, asset: lpAsset, owner: shareOwner, cx: op.share.cx, cy: op.share.cy, ownerPub: id.pubHex };
    // Change notes are REAL notes and must be sealed + registered exactly like the share note, or the
    // provider silently loses the remainder (empty memos = no on-chain recovery). Leaf ORDER must match the
    // guest's `leaves.push` order: share note, then A change, then B change.
    const changeOutputs = [];
    const changeLeaves = [];
    for (const c of (op.aChange || [])) {
      changeLeaves.push(pool.leaf(assetA, c.cx, c.cy, changeOwnerA));
      changeOutputs.push({ value: c.value.toString(), blinding: beHex(c.blinding), secret: nkA, asset: assetA, owner: changeOwnerA, cx: c.cx, cy: c.cy, ownerPub: id.pubHex });
    }
    for (const c of (op.bChange || [])) {
      changeLeaves.push(pool.leaf(assetB, c.cx, c.cy, changeOwnerB));
      changeOutputs.push({ value: c.value.toString(), blinding: beHex(c.blinding), secret: nkB, asset: assetB, owner: changeOwnerB, cx: c.cx, cy: c.cy, ownerPub: id.pubHex });
    }
    const allOutputs = [shareOutput, ...changeOutputs];
    const allLeaves = [shareLeaf, ...changeLeaves];
    const ephRand = freshEph;
    const memos = guard.sealMemosForOutputs({ outputs: allOutputs, ephRand });
    guard.assertOutputsRecoverable({ leaves: allLeaves, outputs: allOutputs, memos });

    const opWire = toLpAddWire(op);
    const r = await _dispatch({ type: 'lp', spec: { op: opWire, leaves: allLeaves, outputs: allOutputs, ephRand }, sealedMemos: memos, selfRelay, walletPriv, waitOpts, pair: sharesPre === 0n ? { assetA, assetB, feeBps } : null });
    return { ...r, dShares: op.dShares, pid, lpAsset, assetA, assetB, firstMint: sharesPre === 0n };
  }

  // The pool mints min(S·addA/rA, S·addB/rB) shares and keeps BOTH contributions, so whatever one leg adds beyond
  // the other's ratio goes to the existing LPs. Refuse an add that would give away more than `maxDonationBps` of
  // either leg (default 0.5%) beyond one share's worth of rounding; size the legs with quoteLpAdd + ensureExactNote
  // instead. A first mint (sharesPre == 0) sets the price, so it has nothing to check against.
  const LP_MAX_DONATION_BPS = 50n;
  function assertLpInRatio(tag, { addA, addB, reserveA, reserveB, sharesPre, maxDonationBps = LP_MAX_DONATION_BPS }) {
    const S = BigInt(sharesPre);
    if (S === 0n) return;
    const a = BigInt(addA), b = BigInt(addB), rA = BigInt(reserveA), rB = BigInt(reserveB);
    const minted = pool.lpAddShares(S, a, b, rA, rB);
    const ceilDiv = (x, y) => (x + y - 1n) / y;
    const lostA = a - ceilDiv(minted * rA, S), lostB = b - ceilDiv(minted * rB, S);
    const over = (lost, add, r) => lost > ceilDiv(r, S) && lost * 10000n > add * BigInt(maxDonationBps);
    if (over(lostA, a, rA) || over(lostB, b, rB)) {
      throw new Error(`${tag}: off-ratio contribution (${lostA > 0n ? lostA : 0n} A, ${lostB > 0n ? lostB : 0n} B would go to the existing LPs); size both legs to the pool ratio with quoteLpAdd first`);
    }
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
    const f = fee == null ? await gasAwareMinFee(poolTickerOf(a), 'lp') : BigInt(fee);
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
    const ticker = poolTickerOf(asset);
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

  // Burn an LP-share note back into its two underlying notes (OP_LP_REMOVE) — the exit for lpAdd (guest op 8,
  // confidential-lp.buildRemove, the exec-lpremove prover).
  // `dShares` defaults to the whole note. The relay fee is carved from the A withdrawal: the A note opens to
  // (dA − fee) while the pool still releases the full proportional dA, so the fee must be < dA.
  // NOTE: the burn is WHOLE-NOTE. buildRemove commits the share as commitXY(dShares, shareNote.blinding), so
  // only dShares == the note's full value reconstructs the on-chain leaf; a partial burn fails membership.
  // Partial withdrawal would need the share note split first, or a change-share output in the guest.
  // Same reshape as toLpAddWire, for buildRemove's op: dA/remA/dB/remB/reserveAPre/reserveBPre/sharesPre/
  // deadline/fee as plain numbers, share's PoK (op.sPok) merged into share as pokR/pokZv/pokZr plus
  // dShares, and a/b's opening sigmas (op.aSig/op.bSig) merged in as sigR/sigZ.
  function toLpRemoveWire(op) {
    const { share, sPok, a, aSig, b, bSig, ...rest } = op;
    const wire = JSON.parse(JSON.stringify(rest, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
    wire.reserveAPre = Number(op.reserveAPre);
    wire.reserveBPre = Number(op.reserveBPre);
    wire.sharesPre = Number(op.sharesPre);
    wire.dA = Number(op.dA);
    wire.remA = Number(op.remA);
    wire.dB = Number(op.dB);
    wire.remB = Number(op.remB);
    wire.deadline = Number(op.deadline ?? 0n);
    wire.fee = Number(op.fee ?? 0n);
    wire.share = {
      cx: share.cx, cy: share.cy, owner: share.owner, leafIndex: Number(share.leafIndex), path: share.path,
      dShares: Number(op.dShares), pokR: sPok.R, pokZv: sPok.zV, pokZr: sPok.zR, nk: share.nk,
    };
    wire.a = { cx: a.cx, cy: a.cy, owner: a.owner, sigR: aSig.R, sigZ: aSig.z };
    wire.b = { cx: b.cx, cy: b.cy, owner: b.owner, sigR: bSig.R, sigZ: bSig.z };
    return wire;
  }
  async function lpRemove({ walletPriv, assetA, assetB, feeBps = 30, shareNote, fee = null, deadline = 0n, selfRelay = false, selfSettle = null, waitOpts } = {}) {
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
    const tickerA = poolTickerOf(a);
    const dAExpected = (BigInt(res.reserveA) * burn) / sharesPre;
    let f = fee == null ? await gasAwareMinFee(tickerA, 'lpremove') : BigInt(fee);
    if (f >= dAExpected) {
      throw new Error(`lp-remove: the relay fee (${f}) is not covered by this withdrawal (${dAExpected} ${tickerA}) — burn more shares, or self-settle`);
    }

    const anchor = _noteAnchor(shareNote, id);
    const keysA = deriveOutput(walletPriv, anchor, 'lpOut', 0), keysB = deriveOutput(walletPriv, anchor, 'lpOut', 1);
    const rA = keysA.blinding, rB = keysB.blinding;
    // Per-note owner for each withdrawal output — confirmed safe against confidential-lp.js's
    // removeCtx, which binds the SPENT share note's own (unchangeable) owner separately from op.a/op.b,
    // so these two are free choices, not tied to any caller-identity binding.
    const nkA = keysA.nk, nkB = keysB.nk;
    const ownerA = pool.nkToOwner(nkA), ownerB = pool.nkToOwner(nkB);
    const op = _lp.buildRemove({
      assetA: a, assetB: b, chainBinding: chainBindingHex(), feeBps,
      reserveAPre: BigInt(res.reserveA), reserveBPre: BigInt(res.reserveB), sharesPre,
      shareNote: { owner: shareNote.owner, nk: shareNote.secret, leafIndex: Number(shareNote.leafIndex), path: shareNote.path },
      dShares: burn, rShares: BigInt(shareNote.blinding),
      aOwner: ownerA, rA, bOwner: ownerB, rB, deadline, fee: f,
    });
    op.spendRoot = shareNote.root;
    // verifyRemove compares the reconstructed root with !==, so normalize case on both sides: a hex-case
    // difference between the scanned note's root and the recomputed one would read as a membership failure.
    _lp.verifyRemove(op, {
      merkleRootFrom: (lf, idx, path) => String(_rootFromPath(lf, idx, path)).toLowerCase(),
      spendRoot: String(op.spendRoot).toLowerCase(),
    });

    const beHex = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
    const outA = { value: (op.dA - f).toString(), blinding: beHex(rA), secret: nkA, asset: a, owner: ownerA, cx: op.a.cx, cy: op.a.cy, ownerPub: id.pubHex };
    const outB = { value: op.dB.toString(), blinding: beHex(rB), secret: nkB, asset: b, owner: ownerB, cx: op.b.cx, cy: op.b.cy, ownerPub: id.pubHex };
    const leaves = [pool.leaf(a, op.a.cx, op.a.cy, ownerA), pool.leaf(b, op.b.cx, op.b.cy, ownerB)];
    const ephRand = freshEph;
    const memos = guard.sealMemosForOutputs({ outputs: [outA, outB], ephRand });
    guard.assertOutputsRecoverable({ leaves, outputs: [outA, outB], memos });
    if (f > 0n) { const u = await feeUsdFor(f, tickerA).catch(() => null); if (u != null) op.feeUsd = u; }

    const opWire = toLpRemoveWire(op);
    const r = await _dispatch({ type: 'lpremove', spec: { op: opWire, leaves, outputs: [outA, outB], ephRand }, sealedMemos: memos, selfRelay, selfSettle, walletPriv, waitOpts });
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
  // BTC→ETH: mint the Ethereum note for a folded Bitcoin bridge burn through the relay (fee carried in the note).
  const _bridgeMint = makeConfidentialBridgeMint({ pool, ct: _ct, relay, fetchImpl: _fetch, relayBase: cfg.relayBase });
  // The Bitcoin half: burn a reflected note on Bitcoin (standard commit/reveal, paid in BTC) toward this pool.
  // `prims` is makeBtcWallet(...).prims; the result's mintArgs go to bridgeMint.bridgeMint once the burn is folded.
  const _bridgeBurn = makeBridgeBurnBroadcaster({ pool, bridgeMint: _bridgeMint, fetchImpl: _fetch, relayBase: cfg.relayBase });
  function bridgeBurnToPool({ prims, chainBinding, ...args } = {}) {
    return _bridgeBurn.broadcastBridgeBurn({ ...args, prims, chainBinding: chainBinding || chainBindingHex() });
  }
  function buildTransferOp({ walletPriv, notes, recipientPubHex, amount, fee = 0n, feeUsd = null }) {
    if (!notes || !notes.length) throw new Error('transfer: no input notes');
    const asset = notes[0].asset;
    if (notes.some((n) => n.asset !== asset)) throw new Error('transfer: all inputs must be one asset');
    amount = BigInt(amount); fee = BigInt(fee);
    const total = notes.reduce((s, n) => s + BigInt(n.value), 0n);
    if (amount + fee > total) throw new Error('transfer: amount + fee exceeds input value');
    const change = total - amount - fee;
    const id = identity(walletPriv);

    // A native note's owner is keccak(nk ‖ dom) — a HASH, not a curve point. That has a hard consequence:
    // whoever can compute an output's owner necessarily knows its nk, and nk is spend authority. So a sender
    // can NEVER mint a spendable-only-by-the-recipient note directly; publishing the recipient's x-only
    // pubkey as `owner` (what this did) mints a note nobody can ever spend, because no nk hashes to it.
    //
    // Third-party payments therefore go through stealth lock → claim: the lock is authorized by a SIGNATURE
    // under a one-time pubkey (signatures are homomorphic, so the sender can derive it), and the recipient's
    // claim mints the note to an owner THEY choose, picking their own nk. See confidential-stealth.js.
    //
    // A self-send (merge / consolidate) is fine: we know our own nk, so we can mint a valid owner.
    const isSelf = String(recipientPubHex).toLowerCase() === String(id.pubHex).toLowerCase();
    if (!isSelf) {
      throw new Error(
        'transfer: cannot send to a third party directly — a native note owner is keccak(nk ‖ dom), so the '
        + 'sender would have to know the recipient\'s spend key, and a pubkey-derived owner mints a note that '
        + 'is unspendable forever. Use the stealth lock/claim path (confidential-stealth.js) instead.',
      );
    }
    // Self-send: a per-note nk for the received output, so it is spendable and unlinkable from the change. Both outputs derive
    // from the wallet key and the first spent note's nullifier (a restored wallet re-derives them); the memo (channel a)
    // also carries each opening to its owner.
    const anchor = _noteAnchor(notes[0], id);
    const recvKeys = deriveOutput(walletPriv, anchor, 'send', 0);
    const recvNk = recvKeys.nk;
    const recipientOwner = pool.nkToOwner(recvNk);
    const rRecv = recvKeys.blinding;
    const txOutputs = [{ value: amount, blinding: rRecv, owner: recipientOwner }];
    // A separate nk for the change output too, same reasoning as recvNk above: reusing id.owner across
    // every change output lets the relay link all of a wallet's ops by that one constant owner.
    let rChange = null, changeNk = null, changeOwner = null;
    if (change > 0n) {
      const changeKeys = deriveOutput(walletPriv, anchor, 'change', 0);
      rChange = changeKeys.blinding;
      changeNk = changeKeys.nk;
      changeOwner = pool.nkToOwner(changeNk);
      txOutputs.push({ value: change, blinding: rChange, owner: changeOwner });
    }

    const t = _ct.buildTransfer({
      inputs: notes.map((n) => ({ value: BigInt(n.value), blinding: BigInt(n.blinding) })),
      outputs: txOutputs,
      // The relay fee leaves the shielded set as a public FeePayment, so it is NOT one of the outputs:
      // conservation is Σin = Σout + fee, and the kernel must be built over that same fee the guest reads.
      fee,
      assetId: asset,
      // Settles as OP_TRANSFER, whose kernel has its own domain (see confidential-transfer.js).
      domain: 'transfer',
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
      return { cx, cy, owner, nk: secret, leafIndex, path, secret };
    });
    const outOwners = [recipientOwner]; if (change > 0n) outOwners.push(changeOwner);
    const outMeta = txOutputs.map((_, j) => ({ cx: xy(t.outC[j]).cx, cy: xy(t.outC[j]).cy, owner: _pad32(outOwners[j], `output ${j} owner`) }));

    const op = {
      chainBinding: _pad32(cb, 'chainBinding'), spendRoot: _pad32(spendRoot, 'spendRoot'), asset: _pad32(asset, 'asset'),
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

    // Recovery descriptors: recipient note sealed to THEIR pubkey, change to the sender's. Same reasoning
    // as buildWrapTransferOp: the recipient output's owner is H(recvNk), so its memo must carry recvNk, not
    // id.secret — the leaf-hash authenticator never checks `secret`, so a wrong value here would decrypt
    // and look recovered, then be permanently unspendable (nk_to_owner mismatch) only once someone tries
    // to actually spend it.
    const leaves = outMeta.map((m) => pool.leaf(asset, m.cx, m.cy, m.owner));
    const outputs = [{ value: amount.toString(), blinding: beHex(rRecv), secret: recvNk, asset, owner: recipientOwner, cx: outMeta[0].cx, cy: outMeta[0].cy, ownerPub: recipientPubHex }];
    if (change > 0n) outputs.push({ value: change.toString(), blinding: beHex(rChange), secret: changeNk, asset, owner: changeOwner, cx: outMeta[1].cx, cy: outMeta[1].cy, ownerPub: id.pubHex });
    const ephRand = freshEph;
    const memos = guard.sealMemosForOutputs({ outputs, ephRand });
    guard.assertOutputsRecoverable({ leaves, outputs, memos });

    return { op, leaves, outputs, memos, ephRand, amount, change, fee, asset };
  }

  // Build + relay-settle a confidential send. recipientPubHex = the recipient's confidential account pubkey.
  async function transfer({ walletPriv, notes, recipientPubHex, amount, fee = 0n, feeUsd = null, selfRelay = false, selfSettle = null, waitOpts } = {}) {
    // Price the fee for the relay gate when the caller didn't. fee === 0n stays unpriced: that is a
    // self-settled / internal move (a note merge), not a relayed send the relay must profit on.
    if (feeUsd == null && BigInt(fee) > 0n) {
      feeUsd = await feeUsdFor(fee, poolTickerOf(notes?.[0]?.asset)).catch(() => null);
    }
    const b = buildTransferOp({ walletPriv, notes, recipientPubHex, amount, fee, feeUsd });
    return _dispatch({
      type: 'transfer', spec: { op: b.op, leaves: b.leaves, outputs: b.outputs, ephRand: b.ephRand },
      sealedMemos: b.memos, selfRelay, selfSettle, walletPriv, waitOpts,
    });
  }

  // ── fast-lane exit: move Bitcoin-homed notes into native notes (OP_TRANSFER, authenticated batch) ──
  // A Bitcoin-homed note (a reflected Bitcoin pool note bound to this deployment) is spent on the Ethereum side by an
  // OP_TRANSFER whose batch carries a non-zero bitcoinSpentRoot. The guest then reads every input as
  // btc_note_leaf_bound(asset, Cx, Cy, auth_key, chainBinding) proven against the Bitcoin pool root, proves each
  // input's ν absent from the reflected Bitcoin spent set, and requires a BIP-340 signature under the note's
  // Taproot x-only key over btc_note_spend_msg(chainBinding, "tacit.op.transfer", leaf, ν, output leaves, fee, 0).
  // The outputs here are native notes to the caller (a per-note nk each, memo-sealed), which then exit through the
  // ordinary unwrap / send-unwrap paths. Wire shape = harnesses/exec-fastlane.rs (relay type 'fastlane').
  //
  // The caller supplies what only the reflected Bitcoin state holds: `spendRoot` (a relay-known Bitcoin pool
  // root), each note's `leafIndex`/`path` under it, `bitcoinSpentRoot`, and each note's non-membership witness
  // `low: { value, next, index, path }` (makeScanReflectionState / the reflection assembler produce all of them).
  // Every one is re-checked here, so a stale witness fails before any proving. `authPriv` is the note's Taproot
  // key (per note, or one for all). With no relay accepting the type, prove it yourself: write
  // `{ ...op, memoHashes }` (keccak of each sealed memo) to OP_FILE, run exec-fastlane with MODE=groth16, and send
  // ConfidentialPool.settle(publicValues, proof, memos) from any account (submitSettle).
  const OP_ID_TRANSFER_HEX = '0x' + _hex(new TextEncoder().encode('tacit.op.transfer')).padEnd(64, '0');
  function buildFastlaneExitOp({ walletPriv, notes, authPriv, spendRoot, bitcoinSpentRoot, fee = 0n } = {}) {
    if (!notes || !notes.length) throw new Error('fastlane: no input notes');
    const asset = notes[0].asset;
    if (notes.some((n) => String(n.asset).toLowerCase() !== String(asset).toLowerCase())) throw new Error('fastlane: all inputs must be one asset');
    if (!spendRoot || /^(0x)?0*$/.test(String(spendRoot))) throw new Error('fastlane: spendRoot (the Bitcoin pool root) is required');
    if (!bitcoinSpentRoot || /^(0x)?0*$/.test(String(bitcoinSpentRoot))) throw new Error('fastlane: a non-zero bitcoinSpentRoot is required (it is what makes the batch Bitcoin-homed)');
    fee = BigInt(fee);
    const total = notes.reduce((s, n) => s + BigInt(n.value), 0n);
    if (fee >= total) throw new Error('fastlane: fee >= input value');
    const id = identity(walletPriv);
    const cb = chainBindingHex();
    const beHex = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
    const hb = (h) => Uint8Array.from((String(h).replace(/^0x/, '').padStart(64, '0').match(/../g) || []).map((x) => parseInt(x, 16)));
    const lt = (a, b) => BigInt(a) < BigInt(b);

    // The output keys derive from the wallet key and the first spent note's nullifier: the ν of its authenticated Bitcoin leaf.
    const anchor0 = (() => {
      const n0 = notes[0], priv0 = n0.authPriv ?? authPriv;
      if (priv0 == null) throw new Error('fastlane: input 0 needs its Taproot key (authPriv)');
      const authKey0 = '0x' + _hex(secp.getPublicKey(hb(beHex(priv0)), true).subarray(1));
      return pool.nullifier(pool.btcNoteLeafBound(asset, _pad32(n0.cx, 'input 0 cx'), _pad32(n0.cy, 'input 0 cy'), authKey0, cb));
    })();
    const outKeys = deriveOutput(walletPriv, anchor0, 'exit', 0);
    const outNk = outKeys.nk;
    const outOwner = pool.nkToOwner(outNk);
    const rOut = outKeys.blinding;
    const t = _ct.buildTransfer({
      inputs: notes.map((n) => ({ value: BigInt(n.value), blinding: BigInt(n.blinding) })),
      outputs: [{ value: total - fee, blinding: rOut, owner: outOwner }],
      fee, assetId: asset, domain: 'transfer',
    });
    if (!_ct.verifyTransfer(t)) throw new Error('fastlane: transfer self-verify failed');
    const xy = (P) => { const a = P.toAffine(); return { cx: beHex(a.x), cy: beHex(a.y) }; };
    const outs = t.outC.map((P) => ({ ...xy(P), owner: outOwner }));
    const outLeaves = outs.map((o) => pool.leaf(asset, o.cx, o.cy, o.owner));

    const inputs = notes.map((n, i) => {
      const c = xy(t.inC[i]);
      if (String(c.cx).toLowerCase() !== String(n.cx).toLowerCase() || String(c.cy).toLowerCase() !== String(n.cy).toLowerCase()) {
        throw new Error(`fastlane: input ${i} opening does not match its commitment`);
      }
      const priv = n.authPriv ?? authPriv;
      if (priv == null) throw new Error(`fastlane: input ${i} needs its Taproot key (authPriv)`);
      const authKey = '0x' + _hex(secp.getPublicKey(hb(beHex(priv)), true).subarray(1));
      if (n.authKey && String(n.authKey).toLowerCase() !== authKey) throw new Error(`fastlane: input ${i} authPriv is not the note's Taproot key`);
      const lf = pool.btcNoteLeafBound(asset, c.cx, c.cy, authKey, cb);
      if (String(_rootFromPath(lf, Number(n.leafIndex), n.path)).toLowerCase() !== String(spendRoot).toLowerCase()) {
        throw new Error(`fastlane: input ${i} is not a member of the Bitcoin pool root (stale path or wrong root)`);
      }
      const nu = pool.nullifier(lf);
      const low = n.low || {};
      const lowLeaf = pool.imtLeaf(low.value, low.next);
      const nonMember = String(_rootFromPath(lowLeaf, Number(low.index), low.path || [])).toLowerCase() === String(bitcoinSpentRoot).toLowerCase()
        && lt(low.value, nu) && (BigInt(low.next) === 0n || lt(nu, low.next));
      if (!nonMember) throw new Error(`fastlane: input ${i} non-membership witness does not prove it unspent on Bitcoin`);
      const msg = pool.btcNoteSpendMsg(cb, OP_ID_TRANSFER_HEX, lf, nu, outLeaves, fee, 0n);
      const sig = '0x' + _hex(signSchnorr(hb(msg), hb(beHex(priv))));
      return { cx: c.cx, cy: c.cy, owner: authKey, leafIndex: Number(n.leafIndex), path: n.path,
        low: { value: low.value, next: low.next, index: Number(low.index), path: low.path }, sig };
    });

    const op = {
      chainBinding: cb, spendRoot, bitcoinSpentRoot,
      transfer: {
        asset, inputs, outputs: outs,
        rangeProof: '0x' + _hex(t.rangeProof), fee: fee.toString(),
        kernel: { R: '0x' + _hex(t.kernel.R.toRawBytes(true)), z: beHex(t.kernel.z) },
      },
    };
    const outputs = [{ value: (total - fee).toString(), blinding: beHex(rOut), secret: outNk, asset, owner: outOwner, cx: outs[0].cx, cy: outs[0].cy, ownerPub: id.pubHex }];
    const memos = guard.sealMemosForOutputs({ outputs, ephRand: freshEph });
    guard.assertOutputsRecoverable({ leaves: outLeaves, outputs, memos });
    return { op, leaves: outLeaves, outputs, memos, fee, amount: total - fee, asset };
  }

  async function fastlaneExit({ selfRelay = true, waitOpts, ...args } = {}) {
    const b = buildFastlaneExitOp(args);
    return _dispatch({ type: 'fastlane', spec: { op: b.op, leaves: b.leaves, outputs: b.outputs, ephRand: freshEph }, sealedMemos: b.memos, selfRelay, walletPriv: args.walletPriv, waitOpts });
  }

  // ── stealth send / claim / refund (non-interactive third-party push, OP_STEALTH_LOCK/CLAIM/REFUND) ──
  // `transfer()` above can only ever send to yourself (a native note's owner is keccak(nk ‖ dom); minting
  // one to a third party's pubkey mints a note no nk hashes to). This is the actual third-party path: the
  // sender locks a note under a one-time address derived from the recipient's PUBLISHED static spend
  // pubkey (the exact same key `identity(priv).pubHex` / a Tacit address's Ethereum side already carry — no
  // new recipient-identification scheme), the recipient does not need to be online, and the sender cannot
  // spend it back out even though they built it. The recipient later discovers + claims it by scanning;
  // an unclaimed lock can be reclaimed by the sender after `deadline`. See dapp/confidential-stealth.js
  // for the underlying scheme.
  const _airdrop = makeConfidentialAirdrop({ stealth: _stealth, secp, sha256, keccak256, curveOrder: SECP_N, pool, transfer: _ct });
  const _lockScan = makeConfidentialLockScan({ pool });
  const _bytesHex = (b) => '0x' + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join(''); // byte array (e.g. a raw pubkey) → hex
  const _scalarHex = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0'); // a scalar (e.g. randomScalar()'s BigInt) → 32-byte hex

  // Build + relay-settle a stealth lock: consumes ONE existing note's FULL value (splitting one to size
  // it first if needed, via ensureExactNote — this is how a PARTIAL stealth send works: the note itself is
  // whole-note-only, but the wallet's existing note doesn't have to be). `recipientPubHex` is the
  // recipient's static spend pubkey. `deadline` defaults to ~90 days out. Ephemeral key / lock blinding /
  // refund key are all FRESH randomness (never wallet-derived), matching every other send in this module
  // (freshEph) — the privacy trade-off is that nothing here is reconstructible from the wallet seed alone,
  // so `onBuilt` surfaces everything needed for a later self-refund and the caller should persist it
  // (mirroring wrapAndSend's onBuilt contract) if they want a guaranteed refund path rather than relying
  // on re-discovering their own lock via a full lock-set scan.
  async function stealthSend({ walletPriv, recipientPubHex, notes, amount, deadline, selfRelay = false, selfSettle = null, waitOpts, onBuilt } = {}) {
    if (!notes || !notes.length) throw new Error('stealthSend: no input notes');
    const asset = notes[0].asset;
    if (notes.some((n) => n.asset !== asset)) throw new Error('stealthSend: all inputs must be one asset');
    amount = BigInt(amount);
    if (amount <= 0n) throw new Error('stealthSend: amount must be positive');
    const id = identity(walletPriv);
    if (String(recipientPubHex).toLowerCase() === String(id.pubHex).toLowerCase()) {
      throw new Error('stealthSend: recipient is your own address — use transfer() (a plain self-send) instead, it needs no proof round trip and no claim step');
    }
    const { note } = await ensureExactNote({ walletPriv, asset, amount, notes, waitOpts });

    const deadlineB = deadline != null ? BigInt(deadline) : coarseDeadline(90 * 24 * 3600, 3600); // ~90 days, hour-bucketed
    if (deadlineB <= 0n) throw new Error('stealthSend: deadline required');

    const ephemeralPriv = randomScalar();
    const { ownerPub } = _stealth.oneTimeAddress({ recipientSpendPub: recipientPubHex, ephemeralPriv });
    const lBlinding = _scalarHex(randomScalar()); // buildStealthLock/sealStealthMemo expect blinding as hex (pool.commitXY's convention throughout this file), not a raw BigInt
    const refundPriv = randomScalar();
    const refundPub = _bytesHex(secp.ProjectivePoint.BASE.multiply(refundPriv).toRawBytes(true).slice(1)); // x-only

    const op = _stealth.buildStealthLock({
      chainBinding: chainBindingHex(), asset, locker: note.owner, refundPub, ownerPub, amount,
      deadline: deadlineB, spendRoot: note.root, nNote: note, lBlinding,
    });
    const recipientMemo = _airdrop.sealStealthMemo({ recipientSpendPub: recipientPubHex, ephemeralPriv, asset, amount, lBlinding, deadline: deadlineB, refundPub });
    const refundPrivHex = _scalarHex(refundPriv);
    // Sender-tail (shared convention with zSwap): appended after the recipient's 145-byte memo, sealed to
    // OUR OWN identity key instead of the recipient's — lets us recover this lock's full refund authority
    // later from our own key + the on-chain-visible ephemeralPub alone, without having persisted `built`
    // (onBuilt's own contract) or re-discovering it via a lock-set scan. openStealthMemo tolerates and
    // ignores this tail (it decodes 145+ bytes), so the recipient's own decode is unaffected.
    const ephemeralPub = _bytesHex(secp.ProjectivePoint.BASE.multiply(ephemeralPriv).toRawBytes(true));
    const senderTail = _airdrop.sealStealthSenderTail({
      senderPriv: _bytesHex(id.priv), ephemeralPub,
      asset, amount, lBlinding, deadline: deadlineB, refundPriv: refundPrivHex, ownerPub, recipientPub: recipientPubHex,
    });
    const memo = recipientMemo + senderTail.replace(/^0x/, '');
    // lCx/lCy/ownerPub/lBlinding are carried in `built` (not just used to build `op`) so a caller who
    // persists this object has everything stealthRefund's lockRecord needs except lIndex/lPath — those
    // only exist once the lock is mined, via stealthLockPosition.
    const built = { lockLeaf: op.lockLeaf, asset, amount: amount.toString(), deadline: deadlineB.toString(), refundPriv: refundPrivHex, refundPub, recipientPubHex, memo, lCx: op.lCx, lCy: op.lCy, ownerPub, lBlinding };
    onBuilt?.(built);

    const r = await _dispatch({ type: 'stealthlock', spec: { op, lockMemos: [memo] }, sealedMemos: [memo], selfRelay, selfSettle, walletPriv, waitOpts });
    const memoCheck = await checkEmittedLockMemos({ txHash: r && r.txHash, lockLeaves: [op.lockLeaf], memos: [memo] });
    return { ...r, ...built, ...(memoCheck ? { memoCheck } : {}) };
  }

  // The lock memo, checked against the chain — the one memo on this op, and the only channel either side has.
  //
  // A stealth lock ships no note leaves, so `spec` carries no `leaves` and relay.settle's verifyEmittedMemos
  // has nothing to compare: the memo bypassed the check entirely. It is also the memo that matters most. It
  // carries BOTH halves of the payment — the recipient's discovery and one-time-key material, and the
  // sender's own refund tail — so a relay that proves the same op against a garbage memo produces a settle
  // that succeeds, a memoRoot that matches, a recipient who can never find the payment, and a sender whose
  // chain-only refund scan finds nothing either. The only thing left is this browser's saved record.
  //
  // Lock memos ride the settle CALLDATA (the tail past the note memos), not LeavesInserted, so
  // checkEmittedMemos cannot see them however it is called — hence a separate reader over the same decoder
  // the lock scanner already uses. `ok: null` means the comparison could not run, which is reported rather
  // than treated as a pass.
  async function checkEmittedLockMemos({ txHash, lockLeaves, memos }) {
    if (!txHash) return { ok: null, mismatched: [], reason: 'no settle tx hash — the lock memo was never checked' };
    let input = null;
    try { const t = await rpc('eth_getTransactionByHash', [txHash]); input = t && t.input; } catch { /* reported below */ }
    if (!input) return { ok: null, mismatched: [], reason: 'settle calldata unavailable — the lock memo was not checked' };
    const decoded = _lockScan.decodeSettleCalls(input);
    const norm = (m) => '0x' + String(m ?? '').replace(/^0x/, '').toLowerCase();
    const want = lockLeaves.map((lf) => String(lf).toLowerCase());
    for (const call of (decoded && decoded.calls) || []) {
      let fields;
      try { fields = _lockScan.decodePublicValuesLockFields(call.publicValues); } catch { continue; }
      const got = (fields.lockLeaves || []).map((lf) => String(lf).toLowerCase());
      if (got.length !== want.length || got.some((lf, i) => lf !== want[i])) continue;
      if (call.memos.length !== fields.leavesCount + fields.lockLeaves.length) continue;
      const tail = call.memos.slice(fields.leavesCount);
      const mismatched = [];
      memos.forEach((m, i) => { if (norm(tail[i]) !== norm(m)) mismatched.push({ index: i, lockLeaf: lockLeaves[i], expected: norm(m), emitted: tail[i] == null ? null : norm(tail[i]) }); });
      if (mismatched.length && typeof saveMismatchedMemos === 'function') {
        // The sealed memo is the only copy of this payment's opening and refund key: persist it before the
        // caller has any chance to drop it.
        try { await saveMismatchedMemos({ txHash, leaves: lockLeaves, memos, memoCheck: { ok: false, mismatched } }); } catch { /* still returned below */ }
      }
      return { ok: mismatched.length === 0, mismatched };
    }
    return { ok: null, mismatched: [], reason: 'this settle carries no matching lock-leaf set — the lock memo was not checked' };
  }

  // The pool's lock set rebuilt from its LockLeavesInserted events (memos from each settle's calldata), read to one
  // pinned head and checked against the pool's own lockNextLeafIndex / lockRoot (storage slots 84 / 85) at that same
  // block. A set the pool does not confirm throws instead of being used: claim and refund proofs are built from
  // these positions. If the pool's state cannot be read (a node that serves no historical storage) the check is
  // skipped and the set is returned unchecked.
  const LOCK_COUNT_SLOT = '0x54';
  const LOCK_ROOT_SLOT = '0x55';
  async function scanLockSet(opts = {}) {
    const requested = opts && opts.toBlock;
    const head = requested == null || requested === 'latest'
      ? await headBlock()
      : (typeof requested === 'number' ? requested : parseInt(String(requested), 16));
    const events = (opts && opts.events) || await fetchEvents({ ...opts, toBlock: head });
    const getTxInput = async (txHash) => { const tx = await rpc('eth_getTransactionByHash', [txHash]); return tx && tx.input; };
    const getLockState = async () => {
      const tag = '0x' + head.toString(16);
      const [count, root] = await Promise.all([
        rpc('eth_getStorageAt', [cfg.pool, LOCK_COUNT_SLOT, tag]),
        rpc('eth_getStorageAt', [cfg.pool, LOCK_ROOT_SLOT, tag]),
      ]);
      return { count, root };
    };
    return _lockScan.scanLockLeaves({ events, getTxInput, getLockState, strict: true });
  }

  // Scan for stealth locks addressed to this wallet. Walks the same event stream balance() fetches (which
  // includes LockLeavesInserted), takes the lock leaves and their positions from it, reads each lock's memo from
  // its settle's calldata (confidential-lock-scan.js), and trial-decrypts every lock memo. Returns
  // `{ mine, lockSetRoot }`: `mine` is claim-ready ({ ...decoded memo fields, oneTimePriv, leaf, lIndex,
  // lPath }), `lockSetRoot` is the reconstructed root as of THIS scan — pass both straight into
  // stealthClaim/stealthRefund. A lock that lands between this scan and the claim makes `lPath` stale;
  // that fails membership at settle time (safe — rescan and retry), same as a stale note witness elsewhere
  // in this module.
  async function scanStealthLocks({ walletPriv, opts } = {}) {
    const set = await scanLockSet(opts);
    // `verified` travels with the result. scanLockLeaves distinguishes "the pool confirmed this set" (true)
    // from "the pool's lock state could not be read, so nothing was checked" (null) — and dropping that here
    // meant no caller could tell, while building claim and refund proofs from the positions either way.
    const mine = await _flagSpentLocks(_openReceivedLocks(walletPriv, set));
    return {
      mine,
      lockSetRoot: set.lockSetRoot,
      verified: set.verified ?? null,
      // A lock whose memo could not be read is not a lock that is not yours: the settle's calldata was
      // unavailable, so nothing was trial-decrypted for that position at all. Counted here so a caller can tell
      // an empty `mine` from a scan that never got to look.
      locksWithoutMemo: set.lockMemos.filter((m) => !m).length,
      ...(set.unverifiedReason ? { unverifiedReason: set.unverifiedReason } : {}),
    };
  }
  // Every memo the scan collected for a lock is tried, not just the one it picked: a memo authenticates itself by
  // recomputing the lock leaf, so a decoy from a third party fails that check instead of hiding the real one.
  const _lockMemosAt = (set, i) => {
    const c = set.lockMemoCandidates && set.lockMemoCandidates[i];
    return (c && c.length ? c : [set.lockMemos[i]]).filter(Boolean);
  };
  function _openReceivedLocks(walletPriv, set) {
    const { tree, lockLeaves } = set;
    const recipientSpendPrivHex = _bytesHex(identity(walletPriv).priv);
    const mine = [];
    for (let i = 0; i < lockLeaves.length; i++) {
      for (const memoHex of _lockMemosAt(set, i)) {
        try {
          const m = _airdrop.openStealthMemo({ recipientSpendPriv: recipientSpendPrivHex, leaf: lockLeaves[i], memoHex });
          if (!m) continue; // not mine, or a sender using a different memo format entirely — see the doc's §5
          const { oneTimePriv } = _stealth.recoverOneTimeKey({ recipientSpendPriv: recipientSpendPrivHex, ephemeralPub: m.ephemeralPub });
          const { path } = tree.rootAndPath(i);
          mine.push({ ...m, oneTimePriv, leaf: lockLeaves[i], lIndex: i, lPath: path });
          break;
        } catch { /* a lock whose memo cannot be processed is skipped; the rest of the scan continues */ }
      }
    }
    return mine;
  }

  // Marks each lock with the pool's lock-nullifier flag: true once a claim or refund landed, null when the read fails.
  // The lock set is append-only, so a claimed lock stays in it; callers list only the ones that are not spent.
  async function _flagSpentLocks(locks) {
    const out = [];
    for (const l of locks) {
      let spent = null;
      try { spent = await _mappingFlag(LOCK_SPENT_SLOT, pool.nullifier(l.leaf)); } catch { spent = null; }
      out.push({ ...l, spent });
    }
    return out;
  }

  // The locks this wallet SENT, from the sender tail every stealthSend appends to the lock memo (sealed to the sender's own
  // key): each entry carries what stealthRefund needs — the lock's fields, its position, and `refundPriv`. `spent` reads the
  // pool's lock-nullifier flag (true once a claim or refund landed), or null when the read fails. A lock the tail does not
  // open (sent by a build without the tail) is not listed.
  async function scanSentLocks({ walletPriv, opts } = {}) {
    const set = await scanLockSet(opts);
    return { sent: await _openSentLocks(walletPriv, set), lockSetRoot: set.lockSetRoot };
  }
  const LOCK_SPENT_SLOT = 119n;
  async function _mappingFlag(slot, key) {
    const k = _hex(keccak256(Uint8Array.from([..._b32b(key), ..._b32b('0x' + slot.toString(16))])));
    const v = await rpc('eth_getStorageAt', [cfg.pool, '0x' + k, 'latest']);
    return BigInt(v || '0x0') !== 0n;
  }
  async function _openSentLocks(walletPriv, { tree, lockLeaves, lockMemos, lockMemoCandidates }) {
    const opened = recovery().openSentLocks({ senderPriv: _bytesHex(identity(walletPriv).priv), lockLeaves, lockMemos, lockMemoCandidates });
    const out = [];
    for (const o of opened) {
      let spent = null;
      try { spent = await _mappingFlag(LOCK_SPENT_SLOT, pool.nullifier(o.leaf)); } catch { spent = null; }
      out.push({ ...o, lPath: tree.rootAndPath(o.lIndex).path, spent });
    }
    return out;
  }

  // Claim a discovered lock into an ordinary note under a FRESH per-note owner (mirroring the recipient
  // output every other op in this module already mints one for) — a single-output op has no "which output
  // gets the fresh key" bookkeeping at all, so there is no reason to fall back to the wallet-constant
  // identity().owner here: doing so would let the relay link every claim a wallet ever makes by that one
  // constant owner. `lockRecord` is one entry from scanStealthLocks' `mine`; `lockSetRoot` must be the SAME
  // scan's root (membership fails if the tree has moved since).
  async function stealthClaim({ walletPriv, lockRecord, lockSetRoot, fee = 0n, selfRelay = false, selfSettle = null, waitOpts } = {}) {
    const id = identity(walletPriv);
    const net = BigInt(lockRecord.amount) - BigInt(fee);
    if (net <= 0n) throw new Error('stealthClaim: fee exceeds the locked amount');
    // The claimed note's keys derive from the wallet key and the lock's nullifier (public once the claim lands).
    const claimKeys = deriveOutput(walletPriv, pool.nullifier(_lockLeafOf(lockRecord)), 'claim', 0);
    const mBlinding = claimKeys.blinding;
    const claimNk = claimKeys.nk;
    const claimOwner = pool.nkToOwner(claimNk);
    const claim = _stealth.buildStealthClaim({
      chainBinding: chainBindingHex(), asset: lockRecord.asset, lCx: lockRecord.lCx, lCy: lockRecord.lCy,
      ownerPub: lockRecord.ownerPub, amount: lockRecord.amount, deadline: lockRecord.deadline,
      locker: lockRecord.refundPub, lBlinding: lockRecord.lBlinding, lockSetRoot,
      lIndex: lockRecord.lIndex, lPath: lockRecord.lPath, oneTimePriv: lockRecord.oneTimePriv,
      mOwner: claimOwner, fee, mBlinding,
    });
    const mLeaf = pool.leaf(lockRecord.asset, claim.mCx, claim.mCy, claimOwner);
    const output = { value: net.toString(), blinding: _scalarHex(mBlinding), secret: claimNk, asset: lockRecord.asset, owner: claimOwner, cx: claim.mCx, cy: claim.mCy, ownerPub: id.pubHex };
    const ephRand = freshEph;
    const memos = guard.sealMemosForOutputs({ outputs: [output], ephRand });
    guard.assertOutputsRecoverable({ leaves: [mLeaf], outputs: [output], memos });
    // mRange is raw bytes (buildStealthClaim's convention, mirroring buildTransfer's rangeProof) — hex it
    // here, at the wire boundary, same as every other op assembler's rangeProof does in this file. Left
    // raw, JSON.stringify silently turns it into a numeric-keyed object the box harness can't parse as a
    // hex string — caught via a real settle on the live mainnet pool, not by any mocked-relay test.
    const op = { ...claim, mRange: _bytesHex(claim.mRange) };
    const r = await _dispatch({ type: 'stealthclaim', spec: { op, leaves: [mLeaf], outputs: [output], ephRand }, sealedMemos: memos, selfRelay, selfSettle, walletPriv, waitOpts });
    return { ...r, net, asset: lockRecord.asset };
  }

  // Reclaim a lock's value after `deadline` if the recipient never claimed. `refundPriv` is the scalar
  // stealthSend's onBuilt exposed — this module does not persist it, so the caller must have kept it (or
  // re-derive it themselves, if they built their own send flow deterministically instead).
  async function stealthRefund({ walletPriv, lockRecord, refundPriv, lockSetRoot, fee = 0n, selfRelay = false, selfSettle = null, waitOpts } = {}) {
    const id = identity(walletPriv);
    const net = BigInt(lockRecord.amount) - BigInt(fee);
    if (net <= 0n) throw new Error('stealthRefund: fee exceeds the locked amount');
    // Per-note owner, same reasoning as stealthClaim above — a refund is also a single-output op, so
    // there is no bookkeeping cost to avoiding the wallet-constant identity().owner here either.
    const refundKeys = deriveOutput(walletPriv, pool.nullifier(_lockLeafOf(lockRecord)), 'refund', 0);
    const oBlinding = refundKeys.blinding;
    const refundNk = refundKeys.nk;
    const refundOwner = pool.nkToOwner(refundNk);
    const refund = _stealth.buildStealthRefund({
      chainBinding: chainBindingHex(), asset: lockRecord.asset, lCx: lockRecord.lCx, lCy: lockRecord.lCy,
      ownerPub: lockRecord.ownerPub, amount: lockRecord.amount, deadline: lockRecord.deadline,
      locker: lockRecord.refundPub, lockerPriv: refundPriv, refundOwner, lockSetRoot,
      lIndex: lockRecord.lIndex, lPath: lockRecord.lPath, lBlinding: lockRecord.lBlinding, fee, oBlinding,
    });
    const oLeaf = pool.leaf(lockRecord.asset, refund.oCx, refund.oCy, refundOwner);
    const output = { value: net.toString(), blinding: _scalarHex(oBlinding), secret: refundNk, asset: lockRecord.asset, owner: refundOwner, cx: refund.oCx, cy: refund.oCy, ownerPub: id.pubHex };
    const ephRand = freshEph;
    const memos = guard.sealMemosForOutputs({ outputs: [output], ephRand });
    guard.assertOutputsRecoverable({ leaves: [oLeaf], outputs: [output], memos });
    // oRange is raw bytes (buildStealthRefund's convention) — hex it here at the wire boundary; see the
    // matching comment in stealthClaim above for why this matters.
    const op = { ...refund, oRange: _bytesHex(refund.oRange) };
    const r = await _dispatch({ type: 'stealthrefund', spec: { op, leaves: [oLeaf], outputs: [output], ephRand }, sealedMemos: memos, selfRelay, selfSettle, walletPriv, waitOpts });
    return { ...r, net, asset: lockRecord.asset };
  }

  // Find a SPECIFIC known lock leaf's position in the current lock-set tree — the sender-side counterpart
  // to scanStealthLocks' recipient-side discovery (which is keyed on decrypting memos, not a known leaf
  // value). Used to refund a lock stealthSend built: onBuilt gives everything about the lock itself, but
  // not its position, since that only exists once it lands on-chain and can shift as later locks append.
  // Returns null if the leaf isn't found (wrong network, not yet mined) — an already-CLAIMED lock is still
  // found here (the append-only tree never removes it); the contract's own lockSpent check is what actually
  // stops a refund on a claimed lock, the same fail-safe as everywhere else in this module.
  async function stealthLockPosition({ lockLeaf, opts } = {}) {
    const { tree, lockLeaves, lockSetRoot } = await scanLockSet(opts);
    const lIndex = lockLeaves.findIndex((l) => String(l).toLowerCase() === String(lockLeaf).toLowerCase());
    if (lIndex < 0) return null;
    const { path } = tree.rootAndPath(lIndex);
    return { lIndex, lPath: path, lockSetRoot };
  }

  // ── ETH→BTC crossOut (OP bridge_burn) ──
  // Burn owned ETH notes → emit crossOut records ({destChain, destCommitment, ν, claimId}); the contract emits
  // CrossOutRecorded, the reflection Mode-B fold (T_CROSSOUT_MINT 0x65) mints the Bitcoin note past finality.
  // All burned value crosses to Bitcoin (no ETH change output): pass notes summing to amount+fee exactly, or
  // the whole selection (amount = Σnotes − fee). `destOwner` = the Bitcoin note owner (self-bridge ⇒ own owner);
  // `destBlinding` (returned) is what the recipient recovers the Bitcoin note with — PERSIST it.
  // Dispatches as a `bridgeburn` op — NOT `transfer`, which routes to exec-prove (op 1) and panics on the
  // missing `outputs` key instead of reaching exec-bridgeburn (op 3). The harness reads `destChain` and
  // `outputs` at the TOP LEVEL (exec-bridgeburn.rs), so both are emitted here alongside `crossOuts`.
  //
  // `destOwner` for a Bitcoin destination is the recipient's x-only TAPROOT key — NOT an owner label. The
  // guest folds it into btc_note_leaf and reflection binds it to the mint tx's vout-0 P2TR program
  // (main.rs OP_BRIDGE_BURN rejects a zero key outright). Passing an nk-hash owner here mints a note nobody
  // can ever spend, so it is required explicitly for every destination chain and never defaulted.
  async function crossOut({ walletPriv, notes, amount, destOwner, destBlinding, destChain = 1, fee = 0n, selfRelay = false, selfSettle = null, waitOpts } = {}) {
    if (!notes || !notes.length) throw new Error('crossOut: no input notes');
    const id = identity(walletPriv);
    const asset = notes[0].asset;
    if (notes.some((n) => n.asset !== asset)) throw new Error('crossOut: all inputs must be one asset');
    const total = notes.reduce((s, n) => s + BigInt(n.value), 0n);
    fee = BigInt(fee);
    amount = amount != null ? BigInt(amount) : total - fee; // default: bridge the whole selection net of fee
    if (amount + fee !== total) throw new Error('crossOut: Σnotes must equal amount+fee (no ETH change in a bridge_burn)');
    if (destChain === 1) {
      const k = String(destOwner || '').replace(/^0x/, '');
      if (!/^[0-9a-fA-F]{64}$/.test(k) || /^0{64}$/.test(k)) {
        throw new Error('crossOut: a Bitcoin destination needs destOwner = the recipient x-only Taproot key (32 non-zero bytes); an owner label would mint an unspendable note');
      }
    }
    if (destOwner == null || /^(0x)?0*$/.test(String(destOwner))) throw new Error('crossOut: destOwner (the destination note owner) is required');
    const owner = destOwner;
    // Default to a recoverable blinding rather than a fresh random scalar: the crossOut's destination is a
    // Bitcoin-homed note with no memo channel (same bearer constraint as cBTC, see cbtc-note-recovery.js's
    // header), so a random blinding here means the note can never be re-opened from the identity key alone —
    // only from whatever off-chain record happened to keep the value this call returned. HMAC-bind it to the
    // nullifier instead (unique per spend, already computed for bindNullifier above), so any wallet holding
    // the same identity key can re-derive the same blinding and recover the note purely from chain + key.
    // Callers that explicitly pass `destBlinding` are unaffected — this only changes the default.
    const rDest = destBlinding != null ? BigInt(destBlinding) : (() => {
      const privBytes = walletPriv instanceof Uint8Array
        ? walletPriv
        : Uint8Array.from((String(walletPriv).replace(/^0x/, '').match(/../g) || []).map((h) => parseInt(h, 16)));
      const domain = new TextEncoder().encode('tacit-crossout-blinding-v1');
      const nullifierBytes = Uint8Array.from((String(notes[0].nullifier).replace(/^0x/, '').match(/../g) || []).map((h) => parseInt(h, 16)));
      const msg = new Uint8Array(domain.length + nullifierBytes.length);
      msg.set(domain); msg.set(nullifierBytes, domain.length);
      const raw = hmac(sha256, privBytes, msg);
      let b = 0n; for (const x of raw) b = (b << 8n) | BigInt(x);
      b %= SECP_N;
      return b === 0n ? 1n : b;
    })();
    const t = _ct.buildBridgeBurn({
      inputs: notes.map((n) => ({ value: BigInt(n.value), blinding: BigInt(n.blinding) })),
      outputs: [{ value: amount, blinding: rDest, owner }],
      assetId: asset, destChain, bindNullifier: notes[0].nullifier, fee,
    });
    const beHex = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
    const ptHex = (P) => '0x' + _hex(P.toRawBytes(true));
    const xy = (P) => { const a = P.toAffine(); return { cx: beHex(a.x), cy: beHex(a.y) }; };
    // A bearer input (owner == 0, e.g. cBTC) has no nk at all -- the guest's native_input still reads a
    // 32-byte nk slot unconditionally for every unauthenticated input, but ignores it on the owner==0
    // branch (control is the blinding, checked by the conservation kernel instead). Any 32-byte value
    // satisfies the read; there is nothing to derive it from, so a fixed zero placeholder is used.
    const ZERO32_NK = '0x' + '00'.repeat(32);
    const inMeta = notes.map((n, i) => { const c = xy(t.inC[i]); const isBearer = String(n.owner || '').replace(/^0x/, '').toLowerCase() === '0'.repeat(64); return { cx: c.cx, cy: c.cy, owner: n.owner || id.owner, nk: isBearer ? ZERO32_NK : n.secret, leafIndex: Number(n.leafIndex), path: n.path, secret: n.secret }; });
    // `outputs` is what exec-bridgeburn reads per destination note (cx, cy, owner=dest auth key); `crossOuts`
    // is kept for the caller/consumer (claimId + destCommitment) but is NOT what the harness streams.
    const op = {
      chainBinding: chainBindingHex(), spendRoot: notes[0].root, asset,
      destChain,
      inputs: inMeta,
      outputs: t.crossOuts.map((c) => ({ cx: c.cx, cy: c.cy, owner: c.owner })),
      crossOuts: t.crossOuts,
      rangeProof: '0x' + _hex(t.rangeProof), kernel: { R: ptHex(t.kernel.R), z: beHex(t.kernel.z) },
      fee: fee.toString(),
    };
    const r = await _dispatch({ type: 'bridgeburn', spec: { op, leaves: [], outputs: null, ephRand: null }, sealedMemos: [], selfRelay, selfSettle, walletPriv, waitOpts });
    // `t.crossOuts[].claimId` above is a CLIENT-SIDE PREDICTION (keccak of the caller's own `bindNullifier`
    // input) -- if that nullifier is ever wrong (e.g. a bearer-vs-owner-bound nullifier-domain mixup), the
    // prediction silently diverges from the claimId the contract actually emits, and a T_CROSSOUT_MINT
    // envelope built from the wrong value can never fold (fold_crossout hashes claim_id into its membership
    // check) -- a permanently stranded mint with no on-chain error anywhere. Verify against the actual
    // CrossOutRecorded event before trusting the prediction; correct it in place if it diverges, matching by
    // destCommitment (unambiguous -- it is the note's own opening, fixed by the caller).
    // ethBlock: the settle's own block number, from the same receipt fetch this verification already makes.
    // A crossOut-mint reveal is checked once, at scan time, against whatever the reflection worker's current
    // eth-state view covers — this is the number to compare against GET /reflection/eth-state/covers before
    // broadcasting one (see completeCrossOutOnBitcoin in crossout-broadcast.js, and BUILD-A-TACIT-DAPP.md §5f).
    //
    // The OUTCOME of that verification is reported, not swallowed. "Corroborated against the event" and
    // "the check threw, or no matching event was found" are different facts with the same silent result
    // today, and the consequence of acting on an unverified claimId is a mint that can never fold, with no
    // on-chain error anywhere. `ethBlock` was also being assigned inside the same try BEFORE the decode
    // loop, so a decodeLog throw left a non-null block number next to an unverified claimId — the exact
    // combination a caller reads as "safe to broadcast".
    let ethBlock = null;
    let claimIdVerified = false;
    let claimIdNote = 'not checked (no settle tx hash)';
    if (r.txHash) {
      try {
        const receipt = await rpc('eth_getTransactionReceipt', [r.txHash]);
        const blockNumber = receipt?.blockNumber ? Number(BigInt(receipt.blockNumber)) : null;
        // Only the pool's own events are read.
        const real = (receipt?.logs || [])
          .filter((l) => !cfg.pool || String(l.address || '').toLowerCase() === String(cfg.pool).toLowerCase())
          .map((l) => evmLog.decodeLog(l))
          .filter((e) => e && e.type === 'CrossOutRecorded');
        let matchedAll = t.crossOuts.length > 0;
        for (const co of t.crossOuts) {
          const match = real.find((e) => String(e.destCommitment).toLowerCase() === String(co.destCommitment).toLowerCase());
          if (!match) { matchedAll = false; continue; }
          if (String(match.claimId).toLowerCase() !== String(co.claimId).toLowerCase()) co.claimId = match.claimId;
        }
        // Only publish the block number once the claimIds it accompanies are corroborated: the two are read
        // together by anything deciding whether to broadcast.
        claimIdVerified = matchedAll;
        claimIdNote = matchedAll ? 'corroborated against CrossOutRecorded' : 'no matching CrossOutRecorded event for every destCommitment';
        if (matchedAll) ethBlock = blockNumber;
      } catch (e) {
        claimIdNote = `verification failed: ${String(e && e.message || e).slice(0, 120)}`;
      }
    }
    return { ...r, crossOuts: t.crossOuts, destOwner: owner, destBlinding: beHex(rDest), amount: amount.toString(), asset, ethBlock, claimIdVerified, claimIdNote };
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
    const tip = await _priorityTip();
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
  const _route = makeConfidentialRoute({ keccak256, pool, kernelSign: (a) => _ct.kernelSign(a), rangeProve: (a) => _ct.rangeProve(a) });
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
  // The pool's live note-tree root. Every membership proof in a batch must reconstruct ONE root, and a
  // freshly-scanned note carries that same value — so reading it here keeps the batch's members consistent
  // without threading a root through the coordinator. A stale path simply fails the guest's membership
  // assert rather than settling wrongly.
  async function poolCurrentRoot() {
    const res = await ethCall(cfg.pool, '0x' + _selector('currentRoot()'));
    const hex = String(res || '').replace(/^0x/, '');
    if (hex.length < 64) throw new Error('pool currentRoot() unavailable');
    return '0x' + hex.slice(0, 64);
  }
  const routePoolId = (a, b, feeBps) => _route.poolId(a, b, feeBps);

  // ── batched OP_SWAP (intent coordinator) ───────────────────────────────────────────────────────────
  // A solo swap is a batch of one: its public reserve delta IS its exact amount, so the size is visible to
  // anyone reading the settle. Buffering intents per pool and clearing N of them at ONE uniform price makes
  // the single delta cover all of them, so individual sizes hide in the aggregate. The guest's OP_SWAP
  // already loops over `intents`, so this is purely off-chain.
  //
  // Availability, not default: `swapBatched` exists so a caller can opt in. Batching only buys privacy when
  // peers are actually trading the same pool inside the window — with no concurrent volume every batch is a
  // batch of one, which is today's privacy plus the wait. Flip the caller, not this, once volume justifies it.
  const _swap = makeConfidentialSwap({ keccak256, pool });
  const _swapCoordinator = makeConfidentialSwapCoordinator({
    swap: _swap,
    pool,
    kernelSign: (x) => _ct.kernelSign(x),
    chainBindingHex,
    ephRand: freshEph,
    // Canonical reserves for the pool the batch clears against, plus the spend root its members prove into.
    reservesFor: async (poolId) => {
      const r = await poolReserves(poolId);
      if (!r) return null;
      return { reserveA: r.reserveA, reserveB: r.reserveB, feeBps: r.feeBps, spendRoot: await poolCurrentRoot() };
    },
    // One settle for the whole batch. Goes through the same relay path a solo op uses.
    submitBatch: async ({ op, leaves, outputs, ephRand }) =>
      relay.settle({ type: 'swap', op, leaves, outputs, ephRand }),
  });
  // Queue one swap intent. Resolves with this trader's own slice once the batch it joined settles.
  const swapBatched = (intent) => _swapCoordinator.addIntent(intent);
  const swapBatchPending = () => _swapCoordinator.pending();
  const swapBatchFlush = (poolId) => _swapCoordinator.flush(poolId);

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
  // PARTIAL ROUTES: `amountIn` may be LESS than the note's value — the remainder returns as a change
  // note in the same settle, in the ROUTE START asset. Passing the note's full value emits no change leaf.
  async function route({ walletPriv, inNote, amountIn, path, minOut, fee = 0n, selfRelay = false, waitOpts } = {}) {
    const q = await quoteRoute({ asset0: inNote.asset, amountIn, path, fee });
    if (!q) throw new Error('route: a hop pool is not initialized');
    const id = identity(walletPriv);
    const spend = BigInt(amountIn);
    const total = BigInt(inNote.value);
    if (spend <= 0n || spend > total) throw new Error('route: amountIn exceeds the note');
    const changeVal = total - spend;
    // Output keys derive from the wallet key and the spent note's nullifier.
    const anchor = _noteAnchor(inNote, id);
    const outKeys = deriveOutput(walletPriv, anchor, 'swapOut', 0);
    const rOut = outKeys.blinding;
    // Per-note owner for the swap output — routeCtx binds op.out.owner as a free choice separate
    // from the spent note's own (unchangeable) owner, as for every other op above.
    const outNk = outKeys.nk;
    const outOwner = pool.nkToOwner(outNk);
    // Change gets its own nk too: a wallet-constant owner would link every partial route, and its nk
    // would reach the relay on the change's next spend.
    const changeKeys = changeVal > 0n ? deriveOutput(walletPriv, anchor, 'change', 0) : null;
    const rChange = changeKeys ? changeKeys.blinding : null;
    const changeNk = changeKeys ? changeKeys.nk : null;
    const changeOwner = changeNk ? pool.nkToOwner(changeNk) : null;
    const change = changeVal > 0n ? [{ value: changeVal, blinding: rChange, owner: changeOwner }] : [];
    const op = _route.buildRoute({
      asset0: inNote.asset, chainBinding: chainBindingHex(), inNote, amountIn: spend,
      rIn: BigInt(inNote.blinding), hops: q.hops, minOut: BigInt(minOut), outOwner, rOut,
      deadline: 0n, fee: BigInt(fee), change,
    });
    op.spendRoot = inNote.root; // membership root the box harness reads (mirrors lpAdd's op.spendRoot = nA.root)
    const beHex = (n) => '0x' + n.toString(16).padStart(64, '0');
    const leaf = pool.leaf(q.assetFinal, op.out.cx, op.out.cy, outOwner);
    const outputs = [{ value: q.amountOut.toString(), blinding: beHex(rOut), secret: outNk, asset: q.assetFinal, owner: outOwner, cx: op.out.cx, cy: op.out.cy, ownerPub: id.pubHex }];
    const leaves = [leaf];
    // Change is a REAL note — seal + register it or the remainder is silently lost. Leaf order matches the
    // guest: the routed output first, then change (in the START asset, never the endpoint asset).
    for (const c of (op.change || [])) {
      leaves.push(pool.leaf(inNote.asset, c.cx, c.cy, changeOwner));
      outputs.push({ value: c.value.toString(), blinding: beHex(c.blinding), secret: changeNk, asset: inNote.asset, owner: changeOwner, cx: c.cx, cy: c.cy, ownerPub: id.pubHex });
    }
    const ephRand = freshEph;
    const sealedMemos = guard.sealMemosForOutputs({ outputs, ephRand });
    return _dispatch({ type: 'route', spec: { op, leaves, outputs, ephRand }, sealedMemos, selfRelay, walletPriv, waitOpts });
  }

  // Self-settle a box-proven op (ConfidentialPool.settle) from the caller's own EVM account. Used by the CDP
  // liquidation keeper: a liquidation has no relay fee, so the keeper box-PROVES (relay prove mode) then
  // submits settle itself (it's gas-funded + the seized-basket recipient). `memos` is [] for a fee-less
  // liquidation (no minted note leaves). publicValues + proof come from the relay prove result.
  async function submitSettle({ settlerPriv, publicValues, proof, memos = [], gasLimit = 1200000n, broadcast = true, pair = null } = {}) {
    const acct = account(settlerPriv);
    const data = settleCalldata({ publicValues, proof, memos, pair });
    const nonce = BigInt(await rpc('eth_getTransactionCount', [acct.address, 'pending']));
    const tip = await _priorityTip();
    const base = BigInt(await rpc('eth_gasPrice', []) || '0x3b9aca00');
    const tx = { chainId: BigInt(cfg.chainId), nonce, maxPriorityFeePerGas: tip, maxFeePerGas: base * 2n + tip, gasLimit: BigInt(gasLimit), to: cfg.pool, value: 0n, data };
    const signed = evmTx.signEip1559(tx, acct.priv);
    const txHash = broadcast ? await rpc('eth_sendRawTransaction', [signed.raw]) : null;
    return { from: acct.address, txHash, signedRaw: signed.raw };
  }

  // Sends a proven op's settle() from this key's own Tacit account, which pays the gas. The node is asked first: the
  // account must cover the fee reserve (the error names the account and what it holds), and a call that would revert is
  // never sent. → { from, txHash }
  async function settleFromAccount({ settlerPriv, publicValues, proof, memos = [], pair = null } = {}) {
    const acct = account(settlerPriv);
    const data = settleCalldata({ publicValues, proof, memos, pair });
    let gasLimit = 1200000n;
    try { gasLimit = (BigInt(await rpc('eth_estimateGas', [{ from: acct.address, to: cfg.pool, data }])) * 13n) / 10n; } catch { /* the pre-send call judges it */ }
    const sent = await _sendEvmTx({ acct, to: cfg.pool, data, gasLimit });
    // The settle counts once it is mined and has not reverted: a bridge is recorded as arrived on this answer.
    await _waitReceipt(sent.txHash);
    return { from: acct.address, txHash: sent.txHash };
  }

  // The pool call that settles a proven op, for any sender to submit: settle(bytes publicValues, bytes proof,
  // bytes[] memos), or createPairAndSettle for a founding LP add. Sent to cfg.pool with no value.
  function settleCalldata({ publicValues, proof, memos = [], pair = null } = {}) {
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
    // A founding LP add must go through createPairAndSettle: a plain settle() reverts PoolNotInit until the slot exists.
    // That entrypoint carries three extra head words (assetA, assetB, feeBps) ahead of the three dynamic offsets.
    const headWords = pair ? 6 : 3;
    const offPv = headWords * 32;
    const offPf = offPv + 32 + a.padded.length / 2;
    const offMemos = offPf + 32 + b.padded.length / 2;
    const memosBlock = memos.length === 0 ? word(0) : (() => { // count + offsets + each (len+data)
      let head = word(memos.length), body = '', cursor = memos.length * 32;
      for (const m of memos) { const e = enc(m); head += word(cursor); body += word(e.len) + e.padded; cursor += 32 + e.padded.length / 2; }
      return head + body;
    })();
    return '0x' + (pair ? _selector('createPairAndSettle(bytes32,bytes32,uint32,bytes,bytes,bytes[])') : _selector('settle(bytes,bytes,bytes[])'))
      + (pair ? word(BigInt(pair.assetA)) + word(BigInt(pair.assetB)) + word(BigInt(pair.feeBps)) : '')
      + word(offPv) + word(offPf) + word(offMemos) + pvBlock + pfBlock + memosBlock;
  }

  // Dispatch a built leaf-bearing op: relay-settle (default) or, when `selfRelay`, box-PROVE (fee-less) and
  // broadcast settle() from the caller's own EOA. Self-relay needs no live relayer (useful when one is down)
  // at the cost of revealing the user's EOA as msg.sender.
  // `sealedMemos` are sealed HERE in the client and passed through to settle() verbatim — nothing server-side
  // re-seals them, which is why the memo ephemeral is fresh randomness per memo.
  async function _dispatch({ type, spec, sealedMemos, selfRelay, selfSettle = null, walletPriv, waitOpts, pair = null }) {
    // Pass the memos THIS caller already sealed (and checked via assertOutputsRecoverable) straight through
    // to submitOp, instead of letting it reseal with a fresh ephRand — otherwise the memo the local recovery
    // check validated is never the one that actually ships (see submitOp's own `outputs`+`memos` branch).
    if (!selfRelay && !selfSettle) return relay.settle({ type, ...spec, memos: sealedMemos }, waitOpts);
    const proven = await relay.prove({ type, ...spec, memos: sealedMemos }, waitOpts);
    if (proven.status === 'settled') return proven;
    // `selfSettle({ jobId, publicValues, proof, memos, pair })` → { txHash }: the caller sends settle() from whichever account
    // it pays with (settleCalldata builds the call), as openCdp's does. The memos are the ones the proof commits to (an
    // older relay client returns none, and its proof is over these).
    const memos = proven.memos || sealedMemos;
    if (selfSettle) return { jobId: proven.jobId, ...(await selfSettle({ jobId: proven.jobId, publicValues: proven.publicValues, proof: proven.proof, memos, pair })) };
    return submitSettle({ settlerPriv: walletPriv, publicValues: proven.publicValues, proof: proven.proof, memos, pair });
  }

  // ── gasless exit (0xbow-style relayed unwrap) ──
  // The user spends a shielded note; the relay box settles ConfidentialPool.settle() on-chain (pays the
  // gas) and is paid `fee` out of the note value as `pv.fees → msg.sender`, so the user RECEIVES
  // value−fee and signs NOTHING on-chain — a true gasless exit. The fee is in the withdrawn asset's
  // in-system units: max(minFee, ceil(feeBps/1e4 · value)). A user holding gas can self-settle (fee = 0
  // and broadcast settle themselves). The guest's OP_UNWRAP splits value → withdrawal(value−fee) +
  // fee, both public legs summing to the proven value (no separate fee proof).
  const RELAY_FEE_BPS = 30n;                                 // 0.30% of the exit
  // TAC holders exit at a lower rate. Tiers are whole TAC held: shielded cTAC notes and the public TAC on the
  // wallet's own Ethereum account (both read by a full balance() scan), plus any public TAC held elsewhere that
  // the caller reports through setPublicTacHeld. The gas-aware floor still applies, so a discounted fee never
  // drops below what the relay needs to settle.
  const HOLDER_FEE_TIERS = [[10000n, 15n], [1000n, 20n], [100n, 25n]]; // [whole TAC, bps], highest first
  let _privateTacWei = 0n;
  let _accountTacWei = 0n;
  let _publicTacWei = 0n;
  function setPublicTacHeld(wei) { _publicTacWei = BigInt(wei || 0); }
  function holderFeeBps() {
    const whole = (_privateTacWei + _accountTacWei + _publicTacWei) / 10n ** 18n;
    for (const [min, bps] of HOLDER_FEE_TIERS) if (whole >= min) return bps;
    return RELAY_FEE_BPS;
  }
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
  // matters: every relayed op carries a cost.
  // POLICY KNOB: a STATIC floor, not an AMM quote, so a thin pool's price cannot move the fee.
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
  const SETTLE_GAS = { unwrap: 450000n, sendunwrap: 680000n, transfer: 620000n, lp: 780000n, lpremove: 720000n, route: 600000n, swap: 600000n, bridgeburn: 600000n };
  // Succinct network prove fee per op, as wei. Measured from a live fulfillment for a shielded transfer:
  // 0.3892 PROVE x ~$0.19 = ~$0.074, ~0.00004 ETH at ~$1900/ETH — and ETH has moved well above that since,
  // so this now overstates the cost in ETH and the fee over-recovers by a few percent. Re-derive it from a
  // live fulfillment rather than scaling this one: the figure depends on the PROVE price as much as on ETH,
  // and correcting only the leg you happen to know makes it less accurate, not more.
  // What a proof costs, in ETH. The PROVE a proof burns is a physical constant — 0.3892, measured from a
  // live fulfillment — but its price is not, and a figure baked in ETH goes stale the moment either PROVE
  // or ETH moves. Both had: the constant below was derived at ~$1900/ETH and now overstates the cost by
  // about a fifth, which is not what scaling by ETH alone would have predicted, because PROVE moved too.
  //
  // So ask the same quoter the relay actually buys PROVE through. The relay's own fee gate already prices
  // every job off this oracle; carrying a constant here only mattered because it sets what the user's op
  // pays, and an op that underpays the gate is refused. Probe with a batch-sized amount so the quote
  // carries the price impact a real top-up would meet, then scale to one proof.
  const PROVE_COST_WEI = 40000000000000n;          // the measured fallback, used when the quote is unavailable
  const PROVE_TOKEN = '0x6BEF15D938d4E72056AC92Ea4bDD0D76B1C4ad29';
  const ZQUOTER = '0x000000bd2DB80567c23E353ca95a251c573cBf9B';
  const PROVE_PROBE_WEI = 100000000000000000000n;  // 100 PROVE (18dp), as the relay probes
  const PROVE_PER_OP_BPS = 3892n;                  // 0.3892 PROVE per proof, in bps of one PROVE
  let _proveCost = { at: 0, v: null };

  async function proveCostWei() {
    if (Date.now() - _proveCost.at < 300000 && _proveCost.v) return _proveCost.v;
    try {
      const w = (x) => BigInt(x).toString(16).padStart(64, '0');
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
      // buildBestSwap(to, exactOut=false, tokenIn=PROVE, tokenOut=ETH(0), amount, slippageBps, deadline).
      // `best` is a static tuple, so best.amountOut is simply word 3 of the return.
      const data = '0xe7798987' + w(ZQUOTER) + w(0) + w(PROVE_TOKEN) + w(0) + w(PROVE_PROBE_WEI) + w(50) + w(deadline);
      const r = await rpc('eth_call', [{ to: ZQUOTER, data }, 'latest']);
      if (!r || r.length < 2 + 256) return _proveCost.v || PROVE_COST_WEI;
      const ethOut = BigInt('0x' + r.slice(2).slice(192, 256));
      if (ethOut <= 0n) return _proveCost.v || PROVE_COST_WEI;
      const perOp = (ethOut * PROVE_PER_OP_BPS) / 10000n / (PROVE_PROBE_WEI / (10n ** 18n));
      // Banded around the measured value: PROVE is a minority of per-op cost, and a broken or pushed
      // quote should never be able to swing the fee far in either direction.
      const lo = PROVE_COST_WEI / 10n, hi = PROVE_COST_WEI * 10n;
      const v = perOp < lo ? lo : perOp > hi ? hi : perOp;
      _proveCost = { at: Date.now(), v };
      return v;
    } catch { return _proveCost.v || PROVE_COST_WEI; }
  }
  // Fee ladder. The relay fee is public, so a continuously-varying fee fingerprints the payer; snapping to a
  // coarse ladder collapses many ops onto the same value. This MIRRORS the guest's fee_is_quantized exactly
  // (at most two significant digits) — the guest asserts it on every fee-bearing op, so a fee off the ladder
  // is not merely un-private, it fails to prove. Scale-free by construction, so it holds for any asset's
  // unitScale; a fixed step would not (a 5000-unit step yields 105000, which is three significant digits).
  // Always rounds UP, so laddering never dips the fee below the cost floor it was derived from.
  const _ladderFee = (v) => {
    let x = BigInt(v);
    if (x <= 0n) return 0n;
    let digits = 0n, t = x;
    while (t > 0n) { t /= 10n; digits += 1n; }
    if (digits <= 2n) return x;
    const scale = 10n ** (digits - 2n);
    return ((x + scale - 1n) / scale) * scale;
  };
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
    // Margin for the gas the settle actually pays, which is not the gas quoted here: minutes pass, and the
    // base fee can climb in that window. A flat multiplier is the wrong shape when gas is cheap — 1.35x of
    // 0.12 gwei is 0.16, and an ordinary drift to 0.4 leaves the relay short — so the quote also carries a
    // fixed absolute headroom. The headroom dominates below ~0.86 gwei and vanishes into the multiplier
    // above it, so ordinary conditions price exactly as they did before.
    // POLICY KNOB: headroom is how far the base fee may climb before the settle lands. Raising it protects
    // the relay and overcharges the calm case. It cannot be recovered afterwards — the fee is committed in
    // the proof, so a quote that turns out short is simply absorbed.
    const DRIFT_HEADROOM_WEI = 300000000n; // 0.3 gwei
    const margin = gwei * 135n / 100n;
    const quoteGwei = margin > gwei + DRIFT_HEADROOM_WEI ? margin : gwei + DRIFT_HEADROOM_WEI;
    const costWei = (SETTLE_GAS[opKind] || 500000n) * quoteGwei + (await proveCostWei()) * 135n / 100n;
    let floor;
    if (pol.usd === 'eth') {
      floor = _ladderFee(costWei / _unitScaleOf(ticker));
    } else if (pol.usd) {
      // Non-native: price the ETH cost in USD, then convert into the asset's own underlying units. Any
      // missing leg falls back to the static floor rather than quoting a wrong (possibly overcharging) fee.
      const ethPx = await ethUsdPrice();
      const assetPx = pol.usd === 'stable' ? 1 : await feedUsdPrice(pol.usd);
      // Decimals are NOT guessed here: assuming 18 for a 6-decimal token would overcharge by 1e12. A missing
      // value falls back to the configured floor instead.
      if (!ethPx || !assetPx || !Number.isFinite(meta.decimals)) return staticFloor;
      const costUsd = (Number(costWei) / 1e18) * ethPx;
      const underlying = BigInt(Math.ceil((costUsd / assetPx) * 10 ** meta.decimals));
      floor = _ladderFee(underlying / _unitScaleOf(ticker));
      // Backstop against a bad feed or a decimals/scale mismatch: a live quote should track the floor, not
      // dwarf it. Cap at 50x so a misconfiguration can never bill a user an absurd fee.
      if (staticFloor > 0n && floor > staticFloor * 50n) floor = _ladderFee(staticFloor * 50n);
    } else {
      return staticFloor; // floor-priced asset (no feed) — the configured floor IS the fee
    }
    return _ladderFee(floor > staticFloor ? floor : staticFloor);
  }

  // Relay fee for a shielded transfer: FLAT (the quantized gas+prove floor), deliberately NOT a percentage.
  // A transfer's amount is hidden, but the fee is published in pv.fees — so charging bps would let anyone
  // divide the fee by the rate and recover the amount, defeating the point of shielding it. The relay's cost
  // is flat per settle anyway (gas and proving don't scale with amount). Exits are different: their payout is already public, so quoteUnwrapFee keeps bps.
  // Unlike an exit the fee is NOT carved out of `amount` — it comes from the change, so the inputs must
  // cover amount + fee.
  async function quoteTransferFee(amount, ticker = 'cETH', { minFee } = {}) {
    const fee = _ladderFee(minFee != null ? BigInt(minFee) : await gasAwareMinFee(ticker, 'transfer'));
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
  function quoteUnwrapFee(value, ticker = 'cETH', { feeBps = holderFeeBps(), minFee } = {}) {
    const v = BigInt(value);
    const floor = minFee != null ? BigInt(minFee) : relayMinFee(ticker);
    const pct = (v * BigInt(feeBps) + 9999n) / 10000n; // ceil
    let fee = _ladderFee(pct > floor ? pct : floor);
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
    const ticker = poolTickerOf(note.asset) || 'cETH';
    let fee, net;
    if (selfSettle) {
      fee = 0n; net = BigInt(note.value);
    } else {
      ({ fee, net } = quoteUnwrapFee(note.value, ticker, feeOpts || {}));
      if (net <= 0n) throw new Error('note too small for a gasless exit (relay fee ≥ value); self-settle instead');
    }
    const to = _evmAddr(recipient || account(walletPriv).address, 'buildUnwrap: recipient');
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
      // `nk` is the field the harness reads (exec-unwrap: f["nk"]) and the guest checks
      // nk_to_owner(nk) == owner against. It is the note's own per-note secret; `secret` is kept as an
      // alias because the recovery memo and older callers still name it that.
      nk: note.secret,
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
    // The chain signal only counts once the note has been SEEN in the scan and is then gone on two consecutive
    // polls. A note the scan never shows (a hand-built note object, a transient scan miss) can't fake a settle;
    // the relay's ack stays the authority for those.
    const sameNote = (n) => { try { return BigInt(n.cx) === BigInt(note.cx) && BigInt(n.cy) === BigInt(note.cy); } catch { return false; } };
    const chainP = new Promise((resolve) => {
      (async () => {
        let seen = false, misses = 0;
        for (let i = 0; i < 80 && !stop; i++) {
          await new Promise((r) => setTimeout(r, 6000));
          if (stop) return;
          try {
            const { byAsset } = await balance(walletPriv);
            const held = byAsset[String(note.asset).toLowerCase()];
            if (held?.notes?.some(sameNote)) { seen = true; misses = 0; continue; }
            if (seen && ++misses >= 2) return resolve({ status: 'settled', txHash: null });
          } catch { /* keep polling; relay is the authority on failure */ }
        }
      })();
    });
    try { return await Promise.race([relayP, chainP]); }
    finally { stop = true; }
  }

  // Submit a gasless exit to the relay (no user tx) and, by default, block until it settles on-chain.
  // The box collects `fee`; the user receives `net`. Returns the build + { jobId, status, txHash }.
  // `selfSettle({ jobId, publicValues, proof, memos })` → { txHash }: an exit with no fee, the whole value to the recipient; the
  // relay only proves it and the caller sends settle() from the account it pays with.
  // The relay re-checks a relayed fee against live gas when the job is submitted, and gas can move between the quote and
  // the submit. A refusal there costs nothing (nothing was proved), so an exit is quoted once more at twice its floor;
  // a floor the caller set is left as it is. Still refused, the user is told in plain words.
  const _floorRefused = (e) => /fee below the current floor/i.test(String((e && e.message) || e));
  async function _withFloorRetry(ticker, opKind, feeOpts, run) {
    const minFee = await gasAwareMinFee(ticker, opKind);
    try { return await run({ ...feeOpts, minFee }); }
    catch (e) {
      if (!_floorRefused(e)) throw e;
      const higher = (minFee > 0n ? minFee : relayMinFee(ticker)) * 2n;
      try { return await run({ ...feeOpts, minFee: higher }); }
      catch (e2) {
        if (_floorRefused(e2)) throw Object.assign(new Error('The network fee rose while this was being sent. Try again in a minute; the fee is worked out again each time.'), { code: 'FEE_MOVED', cause: e2 });
        throw e2;
      }
    }
  }
  async function unwrap(args = {}) {
    if (!args.note || args.selfSettle || (args.feeOpts && args.feeOpts.minFee != null)) return _unwrapOnce(args);
    return _withFloorRetry(poolTickerOf(args.note.asset) || 'cETH', 'unwrap', args.feeOpts, (feeOpts) => _unwrapOnce({ ...args, feeOpts }));
  }
  async function _unwrapOnce({ note, walletPriv, recipient, feeOpts, wait = true, waitOpts, selfSettle = null } = {}) {
    if (selfSettle) {
      const built = buildUnwrap({ note, walletPriv, recipient, selfSettle: true });
      const proven = await relay.prove({ type: 'unwrap', op: built.op, memos: [] }, waitOpts);
      if (proven.status === 'settled') return { ...built, jobId: proven.jobId, status: 'settled', txHash: proven.txHash || null };
      const sent = await selfSettle({ jobId: proven.jobId, publicValues: proven.publicValues, proof: proven.proof, memos: [] });
      return { ...built, jobId: proven.jobId, status: 'settled', txHash: sent && sent.txHash };
    }
    const ticker = poolTickerOf(note.asset) || 'cETH';
    const minFee = (feeOpts && feeOpts.minFee != null) ? feeOpts.minFee : await gasAwareMinFee(ticker, 'unwrap');
    const built = buildUnwrap({ note, walletPriv, recipient, feeOpts: { ...feeOpts, minFee } });
    const sub = await relay.submitOp({ type: 'unwrap', op: built.op, memos: [] }, waitOpts); // no new leaf ⇒ no memo
    if (!wait) return { ...built, jobId: sub.jobId, status: sub.status };
    const st = await waitForExit({ walletPriv, note, jobId: sub.jobId, waitOpts });
    return { ...built, jobId: sub.jobId, status: st.status, txHash: st.txHash };
  }

  // Fungible exit (OP_SEND_AND_UNWRAP): spend ONE note → pay an EXACT `amount` out to `recipient` (public) and
  // keep the remainder as a hidden change note back to self — one proof, relay-settled. `amount` is debited from
  // the note; the recipient receives amount − fee. Falls back to the whole-note unwrap when there's no change.
  // With `selfSettle` (as unwrap's), there is no fee: the recipient receives all of `amount`.
  async function sendUnwrap(args = {}) {
    if (!args.note || args.selfSettle || (args.feeOpts && args.feeOpts.minFee != null)) return _sendUnwrapOnce(args);
    return _withFloorRetry(poolTickerOf(args.note.asset) || 'cETH', 'sendunwrap', args.feeOpts, (feeOpts) => _sendUnwrapOnce({ ...args, feeOpts }));
  }
  async function _sendUnwrapOnce({ note, walletPriv, recipient, amount, feeOpts, wait = true, waitOpts, selfSettle = null } = {}) {
    if (!note) throw new Error('sendUnwrap: note required');
    const ticker = poolTickerOf(note.asset) || 'cETH';
    amount = BigInt(amount);
    const noteValue = BigInt(note.value);
    if (amount > noteValue) throw new Error('sendUnwrap: amount exceeds the note (merge notes first)');
    const fee = selfSettle ? 0n : quoteUnwrapFee(amount, ticker, { ...feeOpts, minFee: (feeOpts && feeOpts.minFee != null) ? feeOpts.minFee : await gasAwareMinFee(ticker, 'sendunwrap') }).fee;
    const payout = amount - fee;
    if (payout <= 0n) throw new Error('sendUnwrap: amount too small for the relay fee');
    const change = noteValue - amount;
    if (change === 0n) return unwrap({ note, walletPriv, recipient, feeOpts, wait, waitOpts, selfSettle }); // exact-size note → whole-note exit
    const id = identity(walletPriv);
    const to = _evmAddr(recipient, 'sendUnwrap: recipient');
    const beHex = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
    // Deterministic change blinding AND owner nk (from note.blinding, which only the owner knows) so a
    // retry rebuilds the IDENTICAL op → relay-deduped. Randomness here would defeat the coarse-deadline
    // dedup — but a fresh nk per output still needs to avoid the wallet-constant id.owner (every send-and-
    // unwrap's change would otherwise share one owner, linkable by the relay), so derive it deterministically
    // instead of reusing id.owner: same inputs → same nk on retry, but distinct from every other op's change.
    const rChange = pool.deriveOpeningNonce(note.blinding, note.cx, 'sendunwrap-change-v1');
    const changeNk = '0x' + pool.deriveOpeningNonce(note.blinding, note.cx, 'sendunwrap-change-nk-v1').toString(16).padStart(64, '0');
    const changeOwner = pool.nkToOwner(changeNk);
    const built = _stealth.buildSendUnwrap({
      chainBinding: chainBindingHex(), asset: note.asset,
      note: { cx: note.cx, cy: note.cy, owner: note.owner, nk: note.secret, blinding: note.blinding, value: noteValue, leafIndex: Number(note.leafIndex), path: note.path, secret: note.secret },
      recipient: to, payout, fee, opDeadline: coarseDeadline(3600),
      change: [{ value: change, blinding: rChange, owner: changeOwner }],
      spendRoot: note.root,
    });
    // The change note goes back to self — ship its recovery descriptor so the relay seals a memo the owner can
    // scan + decode (else the change would be unrecoverable).
    const changeOut = [{ value: change.toString(), blinding: beHex(rChange), secret: changeNk, asset: note.asset, owner: changeOwner, cx: built.change[0].cx, cy: built.change[0].cy, ownerPub: id.pubHex }];
    const changeLeaf = pool.leaf(note.asset, built.change[0].cx, built.change[0].cy, changeOwner);
    const ephRand = freshEph;
    // The harness reads f["kernel"]["R"]/["z"] (nested) — buildSendUnwrap returns them flat, so reshape the op.
    const op = {
      chainBinding: built.chainBinding, spendRoot: built.spendRoot, asset: built.asset,
      input: built.input, recipient: built.recipient, payout: built.payout, fee: built.fee, opDeadline: built.opDeadline,
      pokR: built.pokR, pokZv: built.pokZv, pokZr: built.pokZr, change: built.change,
      rangeProof: built.rangeProof, kernel: { R: built.kernelR, z: built.kernelZ },
    };
    const out = { ...built, fee, payout, change, recipient: to, ticker };
    if (selfSettle) {
      const spec = { type: 'sendunwrap', op, leaves: [changeLeaf], outputs: changeOut };
      const sealed = guard.sealMemosForOutputs({ outputs: changeOut, ephRand });
      const proven = await relay.prove({ ...spec, memos: sealed }, waitOpts);
      if (proven.status === 'settled') return { ...out, jobId: proven.jobId, status: 'settled', txHash: proven.txHash || null };
      const memos = proven.memos || sealed;
      const sent = await selfSettle({ jobId: proven.jobId, publicValues: proven.publicValues, proof: proven.proof, memos });
      const checked = await relay.verifyEmittedMemos({ jobId: proven.jobId, status: 'settled', ...sent }, [changeLeaf], memos);
      return { ...out, jobId: proven.jobId, status: 'settled', txHash: checked.txHash, ...(checked.memoCheck ? { memoCheck: checked.memoCheck } : {}) };
    }
    const sub = await relay.submitOp({ type: 'sendunwrap', op, leaves: [changeLeaf], outputs: changeOut, ephRand }, waitOpts);
    // The memo comparison is the only thing that catches a relay sealing something other than what was handed to
    // it, and the change note is the leaf it would substitute. Not waiting for the settle must not quietly skip
    // that: `verifyMemos()` runs the same check on demand, and until it has run the result says so instead of
    // reading like a clean one. A job the submit already reports settled is checked here, since that costs no wait.
    const verifyMemos = async () => {
      let st = { jobId: sub.jobId, status: sub.status, txHash: sub.txHash || null };
      if (!st.txHash) {
        try { const rs = await relay.status(sub.jobId); if (rs) st = { ...st, status: rs.status || st.status, txHash: rs.txHash || null }; } catch { /* verifyEmittedMemos reports the gap */ }
      }
      return relay.verifyEmittedMemos(st, [changeLeaf], sub.sealedMemos);
    };
    if (!wait) {
      if (sub.status === 'settled') {
        const early = await verifyMemos();
        return { ...out, jobId: sub.jobId, status: early.status, txHash: early.txHash || null, ...(early.memoCheck ? { memoCheck: early.memoCheck } : {}), verifyMemos };
      }
      return { ...out, jobId: sub.jobId, status: sub.status, memoCheck: { ok: null, reason: 'the settle has not landed yet — call verifyMemos() once it has' }, verifyMemos };
    }
    const st = await waitForExit({ walletPriv, note, jobId: sub.jobId, waitOpts });
    // The change note's memo is checked like every other relayed leaf. An exit confirmed from chain state alone
    // carries no tx hash, so the relay's record of the job supplies it when it has one.
    let landed = st;
    if (!landed.txHash && landed.status === 'settled') {
      try { const rs = await relay.status(sub.jobId); if (rs && rs.txHash) landed = { ...landed, txHash: rs.txHash }; } catch { /* unchecked */ }
    }
    const checked = await relay.verifyEmittedMemos(landed, [changeLeaf], sub.sealedMemos);
    return { ...out, jobId: sub.jobId, status: checked.status, txHash: checked.txHash, ...(checked.memoCheck ? { memoCheck: checked.memoCheck } : {}) };
  }

  // ── CDP positions from key + chain ──
  // The position owner key is derived from the wallet key and a per-controller key nonce; the settle that opens a position
  // publishes its owner, so the walk reads each CdpPositionInserted settle's calldata, matches the owner against the derived
  // keys (nonces 0, 1, 2, … until a run of unused ones), and re-checks the position leaf from the published fields. Whether
  // a position is still open is the pool's cdpPositionSpent flag (storage slot 163, keyed by the position nullifier).
  // What the chain does not hold: the debt note's own opening (it is an ordinary memo note, recovered with the rest) and
  // any position opened under a random key by an older build (keep its saved descriptor).
  const CDP_SPENT_SLOT = 163n;
  async function recoverCdpPositions({ walletPriv, events, cdpCfg = {} } = {}) {
    const controller = cfg.collateralEngine;
    if (!controller) return { positions: [], skipped: 'no collateral engine configured' };
    const evs = events || await fetchEvents({ include: ['cdp'] });
    const positionEvents = evs.filter((e) => e && e.type === 'CdpPositionInserted');
    if (!positionEvents.length) return { positions: [], positionEvents: 0 };
    const getTxInput = async (h) => { const t = await rpc('eth_getTransactionByHash', [h]); return t && t.input; };
    const leafOrder = positionEvents.map((e) => lc(e.leaf));
    const r = await recovery().walkCdpPositions({
      priv: identity(walletPriv).priv, controller, positionEvents, getTxInput,
      positionIndexOf: (leaf) => { const i = leafOrder.indexOf(lc(leaf)); return i < 0 ? null : i; }, ...cdpCfg,
    });
    const positions = [];
    for (const p of r.positions) {
      let spent = null;
      try { spent = await _mappingFlag(CDP_SPENT_SLOT, _cdp.positionNullifier(p.positionLeaf)); } catch { spent = null; }
      positions.push({ ...p, spent, live: spent == null ? null : !spent });
    }
    return { positions: positions.filter((p) => p.spent !== true), positionEvents: positionEvents.length, opened: r.allOpened.length, nextKeyNonce: r.nextKeyNonce, allOpened: r.allOpened, skipped: r.skipped || [] };
  }

  // ── one entry point: everything recoverable from the wallet key alone ──
  // Returns { notes, farmPositions, sentLocks, receivedLocks, cbtc, cdpPositions, diagnostics }: `notes` are the unspent
  // notes (each with its membership path and root, ready to spend; `source` tells which channel found it, and
  // `inboundUnverified` marks one known only from a memo somebody else could have sealed), `cbtc` the subset
  // that are cBTC bearer notes, `sentLocks` / `receivedLocks` the stealth locks the wallet sent / can claim, and
  // `diagnostics.coverage` says per category what was scanned and what could not be resolved. Reads chain state only: no
  // transaction is sent. opts: { events, toBlock, deep (default true: also the calldata walks), btcHistory, bridgeAmounts }.
  async function recover({ walletPriv, events, toBlock, deep = true, btcHistory = null, bridgeAmounts = [], cbtc = true, cdp = true, farm = true, locks = true } = {}) {
    if (!walletPriv) throw new Error('recover: walletPriv required');
    const head = events ? null : (toBlock == null || toBlock === 'latest' ? await headBlock() : (typeof toBlock === 'number' ? toBlock : parseInt(String(toBlock), 16)));
    const evs = events || withSavedMemos(await fetchEvents({ toBlock: head, include: ['wraps', 'cdp', 'bonds'] }));
    const st = await _scanNotes({ walletPriv, events: evs, deep, cbtc, btcHistory, bridgeAmounts });
    const d = { errors: { ...st.diag.errors } };
    const notes = [...st.notes];
    const cbtcNotes = notes.filter((n) => n.source === 'cbtc');

    let farmList = [];
    d.farm = { attempted: false };
    if (farm && cfg.farm && cfg.farm.manager) {
      d.farm = { attempted: true };
      try { farmList = await farmPositions({ walletPriv, events: evs, _scan: st, _diag: d.farm }); }
      catch (e) { d.errors.farm = String((e && e.message) || e); }
    }

    let sentLocks = [], receivedLocks = [];
    d.locks = { attempted: false, lockLeaves: 0, sent: 0, received: 0, unspentSent: 0 };
    if (locks) {
      try {
        const set = await scanLockSet({ events: evs, ...(head != null ? { toBlock: head } : {}) });
        d.locks = { attempted: true, lockLeaves: set.lockLeaves.length, verifiedAgainstPool: set.verified, locksWithoutMemo: set.lockMemos.filter((m) => !m).length };
        receivedLocks = await _flagSpentLocks(_openReceivedLocks(walletPriv, set));
        sentLocks = await _openSentLocks(walletPriv, set);
        d.locks.sent = sentLocks.length; d.locks.received = receivedLocks.length;
        d.locks.unspentSent = sentLocks.filter((l) => l.spent === false).length;
        d.locks.sentSpentUnknown = sentLocks.filter((l) => l.spent == null).length;
      } catch (e) { d.errors.locks = String((e && e.message) || e); }
    }

    let cdpPositions = [], cdpOpened = [];
    d.cdp = { attempted: false };
    if (cdp && cfg.collateralEngine) {
      d.cdp = { attempted: true };
      try {
        const r = await recoverCdpPositions({ walletPriv, events: evs });
        cdpPositions = r.positions; cdpOpened = r.allOpened || []; Object.assign(d.cdp, { positionEvents: r.positionEvents || 0, found: r.positions.length, nextKeyNonce: r.nextKeyNonce ?? 0, skipped: r.skipped || [] });
      } catch (e) { d.errors.cdp = String((e && e.message) || e); }
    }

    // Self-owned outputs whose anchor is not a note the wallet holds: a farm receipt (harvest reward, unbond release), a spent
    // stealth lock (claim, refund note) and a closed CDP position (released collateral). Each candidate must match a leaf in the
    // tree; what is found is followed forward through the settles that spent it.
    d.derivedOutputs = { attempted: false, jobs: 0, found: 0 };
    try {
      const R = recovery();
      const known = new Set(st.owned.map((n) => lc(n.leaf)));
      const adopt = (list) => {
        const out = [];
        for (const n of list) {
          const lf = lc(n.leaf), leafIndex = st.slot.get(lf);
          if (leafIndex == null || known.has(lf)) continue;
          known.add(lf);
          const note = { value: BigInt(n.value), blinding: n.blinding, secret: n.secret, asset: n.asset, owner: n.owner, cx: n.cx, cy: n.cy, leaf: n.leaf, leafIndex, nullifier: pool.nativeNu(n.owner, n.secret, n.leaf), source: 'derived', role: n.role, roleIndex: n.index };
          st.owned.push(note); out.push(note);
          if (!st.spent.has(lc(note.nullifier))) notes.push({ ...note, path: st.tree.rootAndPath(leafIndex).path, root: st.root });
        }
        return out;
      };
      const jobs = [];
      if (cfg.farm && Array.isArray(d.farm.receipts)) {
        const bondedBy = new Map(evs.filter((e) => e && e.type === 'Bonded').map((e) => [lc(e.receipt), e]));
        const harvests = new Map();
        for (const e of evs) if (e && e.type === 'Harvested') { const k = lc(e.receipt); if (!harvests.has(k)) harvests.set(k, []); harvests.get(k).push(e); }
        for (const rc of d.farm.receipts) {
          const k = lc(rc.receiptLeaf), b = bondedBy.get(k);
          if (b) jobs.push({ anchor: rc.receiptLeaf, role: 'unbond', index: 0, assets: [rc.lpAsset], values: [BigInt(b.shares)] });
          (harvests.get(k) || []).forEach((e, i) => jobs.push({ anchor: rc.receiptLeaf, role: 'harvest', index: i, assets: [cfg.farm.rewardAsset], values: R.netCandidates(e.reward) }));
        }
      }
      for (const l of receivedLocks) jobs.push({ anchor: pool.nullifier(l.leaf), role: 'claim', index: 0, assets: [l.asset], values: R.netCandidates(l.amount) });
      for (const l of sentLocks) jobs.push({ anchor: pool.nullifier(l.leaf), role: 'refund', index: 0, assets: [l.asset], values: R.netCandidates(l.amount) });
      for (const p of cdpOpened) {
        const anchor = _cdp.positionNullifier(p.positionLeaf);
        const legs = [...p.basket].sort((a, b) => (BigInt(a.asset) < BigInt(b.asset) ? -1 : BigInt(a.asset) > BigInt(b.asset) ? 1 : 0));
        legs.forEach((leg, i) => jobs.push({ anchor, role: 'cdpRelease', index: i, assets: [leg.asset], values: i === 0 ? R.netCandidates(leg.value) : [BigInt(leg.value)] }));
      }
      d.derivedOutputs = { attempted: jobs.length > 0, jobs: jobs.length, found: 0 };
      let frontier = adopt(R.walkDirectOutputs({ priv: identity(walletPriv).priv, jobs, isLeaf: (lf) => st.slot.has(lc(lf)), known }).found);
      d.derivedOutputs.found = frontier.length;
      const getTxInput = async (h) => { const t = await rpc('eth_getTransactionByHash', [h]); return t && t.input; };
      for (let round = 0; deep && frontier.length && round < 4; round++) {
        const w = await R.walkDerivedOutputs({
          priv: identity(walletPriv).priv, parents: frontier, tx: st.tx, knownLeaves: known, getTxInput,
          assets: _knownAssets(st.owned), lpShareOf: (pid) => _lp.lpShareId(pid),
        });
        frontier = adopt(w.found);
        d.derivedOutputs.found += frontier.length;
      }
      notes.sort((a, b) => a.leafIndex - b.leafIndex);
      st.diag.unattributedEmptyLeaves = st.leaves.filter((l) => l && (!l.memo || l.memo === '0x') && !known.has(lc(l.leaf))).map((l) => ({ leafIndex: l.leafIndex, leaf: l.leaf }));
    } catch (e) { d.errors.derivedOutputs = String((e && e.message) || e); }

    const src = (k) => notes.filter((n) => n.source === k).length;
    d.notes = {
      leaves: st.diag.leaves, unspent: notes.length, viaMemo: notes.filter((n) => !n.source).length, viaWrapWalk: src('wrap'), viaChangeWalk: src('change'),
      inboundUnverified: notes.filter((n) => n.inboundUnverified).length,
      viaBridgeMintWalk: src('bridge-mint'), viaCbtcScan: src('cbtc'), viaDerivedOutputs: src('derived'),
      pendingWraps: st.diag.wrap.pending.length,
      derivedAlreadySpent: st.owned.filter((n) => n.source && st.spent.has(lc(n.nullifier))).map((n) => ({ leafIndex: n.leafIndex, source: n.source })),
      emptyMemoLeavesNotAttributed: st.diag.unattributedEmptyLeaves.length,
    };
    d.wrap = st.diag.wrap; d.cbtc = st.diag.cbtc; d.bridge = st.diag.bridge; d.change = st.diag.change; d.derived = st.diag.derived;
    d.coverage = {
      notes: {
        memo: true,
        wrapWalk: !d.errors.wrap && !(d.wrap.truncated || []).length,
        changeWalk: deep && !d.errors.change && !(d.change && d.change.skipped && d.change.skipped.length),
        derivedOutputs: deep && !d.errors.derived && !d.errors.derivedOutputs && !(d.derived && d.derived.skipped && d.derived.skipped.length),
        bridgeMintWalk: !d.errors.bridge,
        cbtcScan: cbtc && d.cbtc.attempted ? !d.errors.cbtc : (cbtc ? 'not needed' : false),
      },
      farmPositions: { derived: d.farm.attempted && !d.errors.farm, needsImportedRecord: 'positions opened under a key not derived from this wallet — importFarmPosition(record)' },
      stealthLocks: { sent: d.locks.attempted && !d.errors.locks, received: d.locks.attempted && !d.errors.locks },
      cdpPositions: { derived: d.cdp.attempted && !d.errors.cdp && !(d.cdp.skipped || []).length, needsSavedRecord: 'positions opened under a key not derived from this wallet' },
      // A walk that SKIPPED transactions did not fail — it returns normally with a `skipped` list — so
      // errors alone do not answer "did we see everything". walkChange and walkDerivedOutputs push a
      // {txHash, reason:'settle calldata unavailable'} entry and carry on whenever a single
      // eth_getTransactionByHash misses, which one flaky RPC pass is enough to cause. Reporting `complete`
      // while a change note's own settle calldata went unread is the worst possible answer to give someone
      // restoring from a seed: they conclude the note is gone, or treat the set as authoritative.
      complete: Object.keys(d.errors).length === 0
        && !(d.change && d.change.skipped && d.change.skipped.length)
        && !(d.derived && d.derived.skipped && d.derived.skipped.length)
        && !(d.cdp && d.cdp.skipped && d.cdp.skipped.length),
      skipped: {
        change: (d.change && d.change.skipped) || [],
        derived: (d.derived && d.derived.skipped) || [],
        cdp: (d.cdp && d.cdp.skipped) || [],
      },
    };
    d.unresolved = {
      notes: 'empty-memo leaves no wallet channel explained (other holders\' seed-derived notes, or notes outside the derivation windows): ' + st.diag.unattributedEmptyLeaves.length,
      pendingWraps: st.diag.wrap.pending, changeSkipped: st.diag.change.skipped,
      farmBondedNotDerived: d.farm.bondedNotDerived ?? null,
    };
    return { notes, farmPositions: farmList, sentLocks, receivedLocks, cbtc: cbtcNotes, cdpPositions, diagnostics: d };
  }

  // The TAC merkle distributor (docs/AIRDROP.md): what an address can claim, the claim calls and the shielded-claim plan.
  // Mainnet only; on any other network its status reads "not deployed". `airdrop` above is the stealth airdrop, a different feature.
  const _tacAirdrop = makeTacAirdrop({
    chainId: cfg.chainId, keccak256, fetchImpl: _fetch,
    call: makeAirdropRpcCall({ rpcs: cfg.rpcs, fetchImpl: _fetch }),
    ux: { cfg, assetByTicker, buildWrap, nextWrapIndex, submitWrapSettle },
  });

  return { cfg, assets: _poolAssets, assetByTicker, account, identity, rpc, ethCall, fetchEvents, balance, poolStatsFromEvents, tickerOf, poolTickerOf,
    deriveOutput, buildWrap, nextWrapIndex, wrap, submitWrapSettle, buildRouterWrap, routerWrap, routerConfigured, buildWrapTransferOp, wrapAndSend, resumeWrapAndSend, sendPreparedTx, buildTransferOp, transfer, stealthSend, scanStealthLocks, stealthClaim, stealthRefund, stealthLockPosition, crossOut, payInvoice, quoteUnwrapFee, holderFeeBps, setPublicTacHeld, quoteTransferFee, quoteOpFee: gasAwareMinFee, feeUsdFor, relayFeeEligible, buildUnwrap, unwrap, sendUnwrap, addBridgeAmountHint, buildAttestMeta, chainBindingHex,
    settleFromAccount, erc2612Nonce: _erc2612Nonce, waitReceipt: _waitReceipt, poolReserves, poolCurrentRoot, sameRoot, routePoolId, quoteRoute, route, swapBatched, swapBatchPending, swapBatchFlush, lpBondPosition, buildLpBondOp, lpBond, farmProgram, farmBond, farmPositions, importFarmPosition, recover, recoverCdpPositions, scanSentLocks, farmHarvest, farmUnbond, farmRedeem, buildFastlaneExitOp, fastlaneExit, lpAdd, lpRemove, quoteLpAdd, wrapLp, wrapSwap, ensureExactNote, mintCbtc, defiActions, cdp: _cdp, cdpPositionTree, submitSettle, settleCalldata,
    cbtcLockState, syncCbtcLockReservations, cbtcBonds,
    relay, indexer, evmLog, evmTx, pool, memo, router: _router, stealth: _stealth, bridgeMint: _bridgeMint, bridgeBurn: _bridgeBurn, bridgeBurnToPool, airdrop: _airdrop, tacAirdrop: _tacAirdrop, lockScan: _lockScan };
}
