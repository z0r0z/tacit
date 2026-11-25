
import { makeConfidentialAdaptor } from './confidential-adaptor.js';
import * as X from './adaptor-xswap.js';
import { G, SECP_N, signSchnorr } from './bulletproofs.js';

const LOCK_SPENT_SLOT = 119n;
const LOCK_COUNT_SLOT = '0x54';
const POSITION_TTL_MS = 5 * 60 * 1000;
const strip = (h) => String(h).replace(/^0x/, '').toLowerCase();
const lc = (h) => '0x' + strip(h);

const MAINNET_RELAYER = '0x000000009C28617AC88B52Eae5EFaAcdD4aC34c3';
const SETTLE_SELECTOR = '717fd7f2';
const TRACE_PER_LOOK = 24;
const TX_READS_AT_ONCE = 4;                              // findClaim's reads of the window's transactions, at once
const TRACE_RETRY_MS = 15000, TRACE_RETRY_MAX_MS = 10 * 60 * 1000;
const UNREAD_SAY_MS = 30 * 60 * 1000;

// `trace(txHash)` -> the calls a transaction made, [{ to, input }] (makeTxTracer): how a claim settled through another contract is read when its calldata does not show it
// `quorum` (makeNodeQuorum): the nodes that must agree before a read ends a swap (findClaim, spentAgreed, lockAbsent); with none, one node's answer is taken as before
// `onUnread(o)`: told (with the lock and a transaction hash) when a spent lock's claim cannot be read because no node traced a transaction it may be in; a provider
// alerts its operator with it. Default: the log.
export function makeFastBridgeEvm({ ux, secp, keccak256, hmacSha256, walletPriv, seed, asset, poolAddress, relayerAddress = MAINNET_RELAYER, policy = {}, adaptor = null, selfSettle = null, ownAccount = null, openGraceMs = 45000, selfRetryMs = 120000, clock = () => Date.now(), log = () => {}, trace = null, quorum = null, onUnread = null }) {
  if (!onUnread) onUnread = (o) => log(o);
  const te = new TextEncoder();
  const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  const bytes = (h) => Uint8Array.from(strip(h).match(/../g).map((x) => parseInt(x, 16)));
  const cat = (...a) => { const o = new Uint8Array(a.reduce((s, x) => s + x.length, 0)); let p = 0; for (const x of a) { o.set(x, p); p += x.length; } return o; };
  const toBig = (b) => b.reduce((a, x) => (a << 8n) | BigInt(x), 0n);
  const scalarHex = (k) => '0x' + k.toString(16).padStart(64, '0');
  const privBytes = walletPriv instanceof Uint8Array ? walletPriv : bytes(walletPriv);
  const pool = ux.pool;
  const ad = adaptor || makeConfidentialAdaptor({ keccak256, secp, signSchnorr, curveOrder: SECP_N, pool });
  const rpc = ux.rpc;
  const assetId = lc(asset);
  const identity = () => ux.identity(privBytes);

  function derive(tag, id, i = 0) {
    for (let c = i; ; c++) {
      const k = toBig(hmacSha256(privBytes, cat(te.encode('tacit-fastbridge-' + tag), bytes(id), Uint8Array.of(c)))) % SECP_N;
      if (k > 0n) return k;
    }
  }
  const xonlyOf = (k) => G.multiply(k).toRawBytes(true).slice(1);
  const seeded = (seedHex) => { let i = 0; const key = bytes(seedHex); return () => { for (; ; i++) { const k = toBig(hmacSha256(key, Uint8Array.of(i))) % SECP_N; if (k > 0n) { i++; return k; } } }; };
  const affine = (P) => { const u = P.toRawBytes(false); return { tx: '0x' + hex(u.slice(1, 33)), ty: '0x' + hex(u.slice(33, 65)) }; };

  const queue = { p: Promise.resolve() };
  const serial = (fn) => { const run = queue.p.catch(() => {}).then(fn); queue.p = run; return run; };
  const reserved = new Set();

  async function now() {
    const b = await rpc('eth_getBlockByNumber', ['latest', false]);
    return parseInt(b.timestamp, 16);
  }
  const lockNullifier = (leaf) => pool.nullifier(lc(leaf));
  const positions = new Map(), misses = new Map();
  const cap = (map, max) => { while (map.size > max) map.delete(map.keys().next().value); };
  async function lockPosition(leaf) {
    const key = lc(leaf), hit = positions.get(key);
    if (hit && Date.now() - hit.at < POSITION_TTL_MS) return hit.pos;
    const count = BigInt((await rpc('eth_getStorageAt', [poolAddress, LOCK_COUNT_SLOT, 'latest'])) || '0x0');
    if (!hit && misses.get(key) === count) return null;
    const pos = await ux.stealthLockPosition({ lockLeaf: key });
    if (pos) { positions.set(key, { at: Date.now(), pos }); misses.delete(key); } else { positions.delete(key); misses.set(key, count); }
    cap(positions, 1024); cap(misses, 1024);
    return pos;
  }

  const flagSlot = (slot, key) => '0x' + hex(keccak256(cat(bytes(key), bytes('0x' + slot.toString(16).padStart(64, '0')))));
  async function mappingFlag(slot, key, tag = 'latest') {
    return BigInt((await rpc('eth_getStorageAt', [poolAddress, flagSlot(slot, key), tag])) || '0x0') !== 0n;
  }
  const blocks = new Map();
  async function blockTs(n) {
    if (!blocks.has(n)) { blocks.set(n, parseInt((await rpc('eth_getBlockByNumber', ['0x' + n.toString(16), false])).timestamp, 16)); cap(blocks, 4096); }
    return blocks.get(n);
  }
  async function blockAtOrAfter(ts) {
    let lo = 0, hi = parseInt(await rpc('eth_blockNumber', []), 16);
    while (lo < hi) { const mid = Math.floor((lo + hi) / 2); if ((await blockTs(mid)) < ts) lo = mid + 1; else hi = mid; }
    return lo;
  }
  const inputs = new Map();
  async function txOf(h) {
    if (!inputs.has(h)) { const t = await rpc('eth_getTransactionByHash', [h]); inputs.set(h, t && t.input ? { input: t.input, to: String(t.to || '').toLowerCase() } : null); cap(inputs, 256); }
    return inputs.get(h);
  }
  const poolTo = String(poolAddress).toLowerCase(), relayerTo = String(relayerAddress).toLowerCase();
  const RELAYED_TOPIC = '0x' + hex(keccak256(te.encode('Relayed(address,address,uint256,uint256)')));
  const claims = new Map(), traced = new Map(), ran = new Map();
  // What the settle calls among `calls` say of the lock `key`: whether one spends it, and the claim kernel that is its own. A call's lock spends and its kernels are in
  // the order its ops ran, and only a claim carries a kernel: when every spend in the call is a claim, the lock's kernel is the one at its place. A call that also
  // refunds does not say which kernel is whose (`mixed`): each is then only a candidate.
  const naming = (calls, key) => {
    const r = { named: false, s: [], mixed: false };
    for (const call of calls || []) {
      let f; try { f = ux.lockScan.decodePublicValuesAdaptorFields(call.publicValues); } catch { continue; }
      const nus = f.lockNullifiers.map(lc), i = nus.indexOf(key);
      if (i < 0) continue;
      r.named = true;
      if (f.adaptorClaimS.length === nus.length) r.s.push(f.adaptorClaimS[i]);
      else if (f.adaptorClaimS.length) { r.mixed = true; r.s.push(...f.adaptorClaimS); }
    }
    return r;
  };
  // Whether every settle call of a relayer transaction ran: the relayer passes over a call the pool refused, and its Relayed event says how many of how many landed.
  // A receipt that cannot be read yet is asked for again.
  async function allRan(txHash, n) {
    if (!ran.has(txHash)) {
      let r;
      try { r = await rpc('eth_getTransactionReceipt', [txHash]); } catch { return false; }
      if (!r || r.status == null) return false;
      const ev = (r.logs || []).find((l) => String(l.address || '').toLowerCase() === relayerTo && String((l.topics || [])[0] || '').toLowerCase() === RELAYED_TOPIC);
      const d = ev ? strip(ev.data || '') : '';
      ran.set(txHash, Number(r.status) === 1 && d.length >= 128 && BigInt('0x' + d.slice(0, 64)) === BigInt(n) && BigInt('0x' + d.slice(64, 128)) === BigInt(n));
      cap(ran, 4096);
    }
    return ran.get(txHash);
  }
  // the settles the pool itself ran in a transaction, read from its trace (a call that reverted, or sits under one that did, ran nothing)
  const poolSettlesOf = (calls) => calls.filter((c) => String(c.to || '').toLowerCase() === poolTo && strip(c.input || '').startsWith(SETTLE_SELECTOR))
    .map((c) => { try { return ux.lockScan.decodeSettleCalls(c.input); } catch { return null; } }).filter(Boolean).flatMap((d) => d.calls);
  // A transaction no node traced is asked again later, each time a while later than the last (from TRACE_RETRY_MS, doubling, to TRACE_RETRY_MAX_MS)
  const traceMiss = new Map();
  async function pooledSettles(txHash) {
    if (!traced.has(txHash)) {
      const miss = traceMiss.get(txHash);
      if (miss && clock() < miss.next) return null;
      let calls = null;
      try { calls = await trace(txHash); } catch (e) {
        const n = (miss ? miss.n : 0) + 1;
        traceMiss.set(txHash, { n, next: clock() + Math.min(TRACE_RETRY_MAX_MS, TRACE_RETRY_MS * 2 ** Math.min(n - 1, 16)) }); cap(traceMiss, 4096);
        log({ level: 'warn', msg: 'a transaction could not be traced', tx: txHash, tries: n, error: String((e && e.message) || e).slice(0, 160) });
      }
      if (!calls) return null;                           // asked again on a later look
      traceMiss.delete(txHash);
      traced.set(txHash, poolSettlesOf(calls));
      cap(traced, 4096);
    }
    return traced.get(txHash);
  }

  // ── the reads that end a swap, from more than one node ──
  // A swap is called claimed, refunded or lost only on what two nodes or more of separate operators show at one block, all that answer alike: the lock's spent
  // flag, and the receipt and calldata (or the trace) of the transaction that spent it. While too few answer, or they differ, the read is made again later
  // (an error with `quorum` set): nothing ends on it.
  const confirmed = new Set();
  const quorumError = (msg) => Object.assign(new Error(msg), { quorum: true });
  async function agreedSpent(lockNu, final) {
    const at = (await quorum.head()) - (final || 0);
    if (!(at > 0)) throw quorumError('the nodes gave no block to read the lock at');
    return { at, spent: BigInt(await quorum.agree('eth_getStorageAt', [poolAddress, flagSlot(LOCK_SPENT_SLOT, lockNu), '0x' + at.toString(16)], wordOf)) !== 0n };
  }
  // `src`: where a reading came from, { tx, how: 'pool' | 'relayer' | 'trace', input, to, n, r }
  async function confirmSource(src, key, at) {
    const id = `${src.tx}|${key}|${src.how}`;
    if (confirmed.has(id)) return;
    const rc = await quorum.agree('eth_getTransactionReceipt', [src.tx], receiptOf);
    if (Number(rc.status) !== 1) throw quorumError('the nodes show the transaction that spent the lock as failed');
    if (at != null && Number(rc.blockNumber) > at) throw new Error('the lock is spent, and the spend is not deep enough yet');
    if (src.how === 'trace') {
      const all = trace && typeof trace.all === 'function' ? await trace.all(src.tx) : [];
      const views = all.filter(Boolean).map((calls) => JSON.stringify(naming(poolSettlesOf(calls), key)));
      if (views.length < 2) throw quorumError('too few nodes traced the transaction that spent the lock');
      if (new Set(views).size > 1 || views[0] !== JSON.stringify(src.r)) throw quorumError('the nodes trace the transaction that spent the lock differently');
    } else {
      const tx = await quorum.agree('eth_getTransactionByHash', [src.tx], txOfNode);
      if (strip(tx.input || '') !== strip(src.input || '') || String(tx.to || '').toLowerCase() !== src.to) throw quorumError('the nodes show the transaction that spent the lock otherwise');
      if (src.how === 'relayer') {
        const ev = (rc.logs || []).find((l) => String(l.address || '').toLowerCase() === relayerTo && String((l.topics || [])[0] || '').toLowerCase() === RELAYED_TOPIC);
        const d = ev ? strip(ev.data || '') : '';
        if (!(d.length >= 128 && BigInt('0x' + d.slice(0, 64)) === BigInt(src.n) && BigInt('0x' + d.slice(64, 128)) === BigInt(src.n))) throw quorumError('the nodes do not show every call of the relayer transaction landed');
      }
    }
    confirmed.add(id); if (confirmed.size > 4096) confirmed.delete(confirmed.values().next().value);
  }
  // Whether the lock is spent, as the nodes agree at `final` blocks under their head (one node's word without a quorum)
  async function spentAgreed(lockNu, { final = null } = {}) {
    if (!quorum) return mappingFlag(LOCK_SPENT_SLOT, lockNu);
    return (await agreedSpent(lockNu, final)).spent;
  }
  // Whether a lock leaf is not in the pool: the lock set read holds as many leaves as the nodes agree the pool counts, and not this one. A lock set read short is
  // read again, never taken for a lock that is not there.
  async function lockAbsent(leaf) {
    if (await lockPosition(leaf)) return false;
    if (!quorum || typeof ux.scanLockSet !== 'function') return true;
    const set = await ux.scanLockSet();
    if (set.lockLeaves.some((l) => lc(l) === lc(leaf))) return false;
    const count = BigInt(await quorum.agree('eth_getStorageAt', [poolAddress, LOCK_COUNT_SLOT, '0x' + (await quorum.head()).toString(16)], wordOf));
    if (BigInt(set.lockLeaves.length) < count) throw quorumError('the lock set read holds fewer locks than the nodes show: read again');
    return true;
  }
  // The claim kernels of the settle that spent a lock: [] for a refund, null while the lock is unspent; throws while the settle is not found (or, with `final`, a number
  // of blocks, while the spend is not that many blocks deep: read at a block number, which every node keeps the state of for the last 128).
  // The settle is read from the call that ran: a settle sent straight to the pool, or a relayer call whose transaction says all its calls landed. A relayer transaction
  // that says otherwise, and one sent through another contract (a forwarder, a contract wallet), are read from the pool's own call in the transaction's trace (`trace`),
  // or from their input when it carries the settle as it is; a kernel read from an input is taken only when `check(s)` says it opens the swap (it is what someone wrote,
  // not what the pool ran). With `check`, a kernel of the call that ran that does not pass is not taken while another read may still find one that does; it is
  // handed back last, as what the pool shows.
  // With a `quorum`, what is handed back is what the nodes agree on (above): the spend at one block and the transaction that made it. `proves`: the check opens the
  // swap (the kernel gives its secret), so a kernel that passes it stands on its own, read from any node; nothing else is handed back before the nodes agree.
  async function findClaim(lockNu, { sinceSecs = 0, check = null, final = null, proves = false } = {}) {
    if (!(await mappingFlag(LOCK_SPENT_SLOT, lockNu))) return null;
    if (final) {
      const at = parseInt(await rpc('eth_blockNumber', []), 16) - final;
      if (!(at > 0 && (await mappingFlag(LOCK_SPENT_SLOT, lockNu, '0x' + at.toString(16))))) throw new Error('the lock is spent, and the spend is not deep enough yet');
    }
    const key = lc(lockNu);
    const ok = (s) => { try { return !!check(s); } catch { return false; } };
    let held = null, deep = null;
    if (quorum) {
      try { const a = await agreedSpent(lockNu, final); deep = a.at; if (!a.spent) held = quorumError('the nodes do not show the lock spent yet'); } catch (e) { held = e; }
    }
    const out = async (r, src) => {
      if (!quorum) return r;
      if (proves && check) { const good = r.filter(ok); if (good.length) return good; }
      if (held) throw held;
      if (!src) throw quorumError('the transaction that spent the lock is read from one node only so far');
      await confirmSource(src, key, deep);
      return r;
    };
    // what a call that ran says, judged: undefined while it does not settle the question (a kernel that does not pass the check)
    const judge = (r) => {
      if (!r.s.length) return [];
      if (!check) return r.s;
      const good = r.s.filter(ok);
      if (good.length) return good;
      return r.mixed ? [] : undefined;                    // (a call that also refunds, with no kernel that opens this swap, refunded it)
    };
    const known = claims.get(key);
    if (known) { const j = judge(known); if (j !== undefined) return out(j, known.src); }
    const keep = (r, src) => { claims.set(key, { s: r.s, mixed: r.mixed, src }); cap(claims, 1024); };
    const events = await ux.fetchEvents({ fromBlock: sinceSecs ? await blockAtOrAfter(Math.max(0, sinceSecs - 3600)) : undefined, toBlock: 'latest' });
    // The window's transactions are read a few at a time before they are walked in order: a swap found again from the key a day after its lock has a day of the pool's
    // settles to read, one request each, which one at a time took over a minute (2026-11-25). A read that fails here is made again in the walk, as before.
    const hashes = [...new Set(events.filter((e) => e.txHash && (e.type === 'LeavesInserted' || e.type === 'NullifiersSpent')).map((e) => e.txHash))];
    const got = new Map();
    // (in batches first, where the pool module reads them so: what that leaves out is read below as before)
    const unread = hashes.filter((h) => !inputs.has(h));
    if (unread.length > 1 && typeof ux.readTxs === 'function') {
      try { const m = await ux.readTxs(unread); for (const h of unread) { const t = m.get(String(h).toLowerCase()); if (t && t.input) got.set(h, { input: t.input, to: String(t.to || '').toLowerCase() }); } } catch { /* read one by one below */ }
    }
    let next = 0;
    const reader = async () => { while (next < hashes.length) { const h = hashes[next++]; if (got.has(h)) continue; try { got.set(h, await txOf(h)); } catch { /* read again in the walk */ } } };
    await Promise.all(Array.from({ length: TX_READS_AT_ONCE }, reader));
    const seen = new Set();
    const loose = [], others = []; let landed = null, landedSrc = null;
    for (const e of events) {
      if (!e.txHash || seen.has(e.txHash) || (e.type !== 'LeavesInserted' && e.type !== 'NullifiersSpent')) continue;
      seen.add(e.txHash);
      const tx = got.has(e.txHash) ? got.get(e.txHash) : await txOf(e.txHash);
      const decoded = tx && ux.lockScan.decodeSettleCalls(tx.input);
      if (decoded && decoded.direct && (tx.to === poolTo || tx.to === relayerTo)) {
        const r = naming(decoded.calls, key);
        if (!r.named) continue;
        if (tx.to === poolTo || (await allRan(e.txHash, decoded.calls.length))) { if (!landed) { landed = r; landedSrc = { tx: e.txHash, how: tx.to === poolTo ? 'pool' : 'relayer', input: tx.input, to: tx.to, n: decoded.calls.length }; } continue; }
      }
      others.push(e.txHash);
      if (decoded) loose.push(...naming(decoded.calls, key).s);
    }
    if (landed) {
      keep(landed, landedSrc);
      const j = judge(landed);
      if (j !== undefined) return out(j, landedSrc);
    }
    // (a kernel read from an input is what someone wrote: with a quorum it is taken only when it gives the swap's secret)
    if (check && (!quorum || proves)) {
      const hit = loose.find(ok);
      if (hit) return [hit];
    }
    if (trace) {
      // the newest first, a few new traces a look (a trace read once is kept), so a long window is read over several looks
      let fresh = 0;
      for (const h of others.reverse()) {
        if (!traced.has(h)) {
          const m = traceMiss.get(h);
          if (m && clock() < m.next) continue;           // (waiting to be asked again)
          if (fresh++ >= TRACE_PER_LOOK) break;
        }
        const r = naming(await pooledSettles(h), key);
        if (!r.named) continue;
        // (a trace is a node's word: with a check, only a kernel that opens the swap is taken from it)
        const src = { tx: h, how: 'trace', r };
        if (!check) { keep(r, src); return out(judge(r), src); }
        const good = r.s.filter(ok);
        if (good.length) return out(good, src);
      }
    }
    if (landed) return out(landed.s, landedSrc);
    sayUnread(key, others);
    throw new Error('the lock is spent, and the settle that spent it is not found yet');
  }
  // A spent lock whose settle is not found while transactions of its window could not be traced (or nothing traces at all) is said out loud, with the transaction,
  // at most every UNREAD_SAY_MS for one lock: the claim may be in one of them, and only a node that traces it gives the swap's secret.
  const unreadSaid = new Map();
  function sayUnread(key, others) {
    const stuck = trace ? others.filter((h) => !traced.has(h) && traceMiss.has(h)) : others;
    if (!stuck.length) return;
    const last = unreadSaid.get(key);
    if (last != null && clock() - last < UNREAD_SAY_MS) return;
    unreadSaid.set(key, clock()); cap(unreadSaid, 1024);
    const newest = stuck[stuck.length - 1];
    onUnread({
      level: 'alert', lock: key, tx: newest, untraced: stuck.length, tries: (traceMiss.get(newest) || {}).n || 0,
      msg: trace ? 'a pool lock is spent and its claim cannot be read: no trace node traced the transaction that may carry it. Point FB_LP_TRACE_RPCS at a node of your own that traces, and look at the transaction'
        : 'a pool lock is spent and its claim cannot be read: no trace node is set, and the transaction that may carry it does not show the claim in its input',
    });
  }

  const own = new Map();
  let ownBusy = 0;                                       // sends from this account under way, so a backlog does not ask the relay for all their proofs together
  const OWN_AT_ONCE = 2, OWN_RETRY_MAX = Math.min(15 * 60 * 1000, selfRetryMs * 16);
  // The ETH a send from this account must be able to reserve (a settle's gas limit at twice the gas price of the moment), looked at BEFORE a proof is asked
  // for. A proof the account then could not send was thrown away and asked for again each minute: 240 of them in an afternoon, and the rate limit those
  // requests met (631 refusals) spent the relay's proof capacity for everyone (2026-11-14).
  async function ownEthOk() {
    if (!ownAccount) return true;
    try {
      const bal = BigInt(await ux.rpc('eth_getBalance', [ownAccount.address, 'latest'])), gas = BigInt(await ux.rpc('eth_gasPrice', []));
      return bal >= 800000n * (2n * gas + 100000000n);
    } catch { return true; }                             // a node that cannot answer is no reason to hold a settle
  }
  // how long a refusal asks to be waited out ("retry in ~26s")
  const hintMs = (e) => { const m = /retry in ~(\d+)s/i.exec(String((e && e.message) || e)), a = Number(e && (e.retryAfter ?? e.retryAfterSecs)); return m ? Number(m[1]) * 1000 : a > 0 ? a * 1000 : 0; };
  function sendOwn(id, proven, immediate = false) {
    let o = own.get(id);
    if (!o) own.set(id, (o = { seen: immediate ? -Infinity : clock(), retryAt: 0, fails: 0, proof: null, sending: null, done: false }));
    if (o.done) return 'settled';
    if (o.sending || clock() - o.seen < openGraceMs || clock() < o.retryAt || ownBusy >= OWN_AT_ONCE) return 'pending';
    ownBusy++;
    // the first wait is `selfRetryMs`; each failure in a row doubles it, to a cap, and never less than the wait a refusal asks for
    const later = (e) => { o.fails++; o.retryAt = clock() + Math.max(Math.min(OWN_RETRY_MAX, selfRetryMs * 2 ** (o.fails - 1)), hintMs(e) ? hintMs(e) + 1000 : 0); };
    o.sending = (async () => {
      if (!o.proof && !(await ownEthOk())) { later(null); log({ level: 'warn', msg: 'the settle waits: this account has too little ETH to send it, so no proof is asked for', jobId: id }); return; }
      log({ level: 'info', msg: 'the relay holds a settle: sending it from your wallet', jobId: id });
      const x = o.proof || (o.proof = await proven());   // a proof that was made is kept until the settle is sent
      const r = await selfSettle({ jobId: x.jobId || id, publicValues: x.publicValues, proof: x.proof, memos: Array.isArray(x.memos) ? x.memos : [] });
      o.done = true; o.proof = null;
      if (r && r.txHash && ux.relay.landed) for (const j of new Set([id, x.jobId || id])) Promise.resolve(ux.relay.landed(j, r.txHash)).catch(() => {});
    })().catch((e) => {
      const m = String((e && e.message) || e);
      if (/revert|would fail|stale/i.test(m)) o.proof = null;   // the pool would not take it as it is: it is asked for again
      later(e);
      log({ level: 'warn', msg: 'the settle was not sent from your wallet', error: m.slice(0, 160) });
    }).finally(() => { o.sending = null; ownBusy--; });
    return 'pending';
  }
  const relayHeld = async () => { try { const r = ux.relay.state ? await ux.relay.state() : null; return !!(r && r.state === 'held'); } catch { return false; } };
  // A relay calls a claim failed when its own try found nothing left to do: the lock was spent already, by a claim whose answer the relay never
  // heard or one another settler sent. The pool decides: a lock spent by a claim settle is a claim that landed.
  async function claimLanded(again) {
    const nu = again && again.type === 'adaptorclaim' && again.bundle && again.bundle.op && again.bundle.op.lockNullifier;
    if (!nu) return false;
    // the claim that landed is this one: its own kernel (the one the claim was built with), not any kernel the pool shows for the lock
    const ownS = again.bundle.op.kernelS, mine = ownS ? (z) => BigInt(z) === BigInt(ownS) : null;
    // (nodes that do not agree leave the claim as it is: neither landed nor to be sent again; the timelock's refund still comes in its time)
    try { const found = await findClaim(nu, { sinceSecs: again.sinceSecs || 0, ...(mine ? { check: mine } : {}) }); return !!(found && found.length && (!mine || found.some(mine))); } catch (e) { if (e && e.quorum) throw e; return false; }
  }
  async function jobStatus(id, again = null) {
    if (isOwnJob(id)) {
      if (own.get(id) && own.get(id).done) return 'settled';
      if (!selfSettle || !again || !again.bundle) return 'pending';
      return sendOwn(id, () => ux.relay.prove(specOf(again.type, again.bundle)), true);
    }
    const st = await ux.relay.status(id);
    const s = st && st.status;
    if (s === 'settled' || (own.get(id) && own.get(id).done)) return 'settled';
    if (s === 'failed' || s === 'unknown') return (await claimLanded(again)) ? 'settled' : 'failed';
    if (!selfSettle) return 'pending';
    if (s === 'open' && st.publicValues && st.proof) return sendOwn(id, () => st);
    if (again && again.bundle && (own.has(id) || (await relayHeld()))) return sendOwn(id, () => ux.relay.prove(specOf(again.type, again.bundle)));
    return 'pending';
  }
  const specOf = (type, bundle) => ({
    type, op: bundle.op, leaves: bundle.leaves || [], outputs: bundle.outputs || null,
    ephRand: bundle.ephSeed ? seeded(bundle.ephSeed) : undefined, lockMemos: bundle.lockMemos || null,
  });
  const refusalOf = (e) => {
    const m = String((e && e.message) || e), code = e && e.code;
    if (code === 'free_budget' || /free relayed settles for today/i.test(m)) return 'the free settles for today are used up';
    if (code === 'relay_held' || /can.t take this one|catching up on settles/i.test(m)) return 'the relay is not sending settles';
    if (/too many submit requests/i.test(m)) return 'the relay is busy with this address';
    if (/fee below|feegate|marginal cost/i.test(m)) return 'the settle is below the relay’s fee floor';
    return null;
  };
  const refusals = new Map();
  const refusal = (type) => { const r = refusals.get(type); return r && clock() < r.until ? r : null; };
  let readyAt = -Infinity, readyLast = { ok: true }, ownSeq = 0;
  const isOwnJob = (id) => String(id).startsWith('own-');
  async function submit(type, bundle) {
    const proveHere = (r) => { log({ level: 'warn', msg: 'the relay will not send this settle: it is proved and sent from the provider’s own account', type, why: r.why }); return { jobId: `own-${type}-${clock().toString(36)}-${++ownSeq}` }; };
    const held = refusal(type);
    if (held) { if (ownAccount && selfSettle) return proveHere(held); throw held.error; }
    try {
      const r = await ux.relay.submitOp(specOf(type, bundle));
      if (!r || !r.jobId) throw new Error('the relay did not take the job');
      refusals.delete(type); readyAt = -Infinity;
      return { jobId: r.jobId };
    } catch (e) {
      const why = refusalOf(e);
      if (!why) throw e;
      const r = { why, error: e, until: clock() + Math.min(600, Math.max(30, Number(e.retryAfter) || 60)) * 1000 };
      refusals.set(type, r); readyAt = -Infinity;
      if (ownAccount && selfSettle) return proveHere(r);
      throw e;
    }
  }

  async function ready() {
    if (clock() - readyAt < 20000) return readyLast;
    let st = null;
    try { st = ux.relay.state ? await ux.relay.state() : null; } catch { st = null; }
    const state = st && st.state, lock = refusal('adaptorlock');
    let r;
    if (state === 'paused' || state === 'down') r = { ok: false, why: 'the relay is not proving right now' };
    else if (state !== 'held' && !lock) r = { ok: true };
    else {
      const why = state === 'held' ? 'the relay is not sending settles' : lock.why;
      if (!selfSettle) r = { ok: false, why };
      else if (!ownAccount) r = { ok: true };
      else {
        try {
          const bal = BigInt(await ux.rpc('eth_getBalance', [ownAccount.address, 'latest']));
          const gas = BigInt(await ux.rpc('eth_gasPrice', []));
          r = bal >= 800000n * (2n * gas + 100000000n) ? { ok: true } : { ok: false, why: `${why}, and the provider’s own account is low on ETH` };
        } catch { r = { ok: false, why: `${why}, and the provider’s own account cannot be read` }; }
      }
    }
    readyAt = clock(); readyLast = r;
    return r;
  }

  // The key's notes of this asset. Reads asked while one is under way share it: `available` and `heldFree` are asked together (fastbridge-pair.js balances), and each
  // started a whole note scan of its own. For an asset the TAC bridge-mint and cBTC walks never find (they look for TAC, cTAC and cBTC only), those walks are left out:
  // on a browser that had not seen the key they were about 10 s of a first scan's 18 (2026-11-25). An asset the pool module cannot name gets the whole scan.
  const walked = /^(c?TAC|cBTC)$/;
  let heldRun = null;
  async function heldNotes() {
    if (!heldRun) {
      const ticker = typeof ux.poolTickerOf === 'function' ? ux.poolTickerOf(assetId) : null;
      heldRun = Promise.resolve(ux.balance(privBytes, ticker && !walked.test(ticker) ? { bridge: false, cbtc: false } : undefined)).finally(() => { heldRun = null; });
    }
    const { byAsset } = await heldRun;
    return (byAsset[assetId] && byAsset[assetId].notes) || [];
  }

  const cutFee = { at: -Infinity, fee: 0n };
  async function cutReserve(sum) {
    if (clock() - cutFee.at > 600000) { cutFee.fee = await refundFee(sum + 1n); cutFee.at = clock(); }
    return cutFee.fee;
  }
  // what the key holds free, and what of it can be locked: a note is cut to the exact amount of a lock and the cut costs a relay fee, which `available` keeps back
  const heldFree = async () => (await heldNotes()).filter((n) => !reserved.has(lc(n.leaf))).reduce((s, n) => s + BigInt(n.value), 0n);
  const available = async () => {
    const sum = await heldFree();
    const fee = sum > 0n ? await cutReserve(sum) : 0n;
    return sum > fee ? sum - fee : 0n;
  };
  // whether a lock of `amount` can be made from the free notes: a note of exactly that amount is locked as it is (prepare cuts nothing, so nothing is kept back for a
  // cut), else the notes must hold the amount and the fee of cutting it. A note just shielded for a swap is of exactly its amount.
  const covers = async (amount) => {
    const a = BigInt(amount), free = (await heldNotes()).filter((n) => !reserved.has(lc(n.leaf)));
    if (free.some((n) => BigInt(n.value) === a)) return true;
    const sum = free.reduce((s, n) => s + BigInt(n.value), 0n);
    return sum > 0n && sum >= a + (await cutReserve(sum));
  };

  const refundKey = async (id) => ({ xonly: xonlyOf(derive('evm-refund', id)) });
  const prepare = ({ rec }) => serial(async () => {
    const amount = BigInt(rec.offer.evm.amount);
    const free = (await heldNotes()).filter((n) => !reserved.has(lc(n.leaf)));
    if (free.some((n) => BigInt(n.value) === amount)) return;
    const pick = (fee) => {
      const need = amount + fee, sorted = free.slice().sort((x, y) => (BigInt(x.value) > BigInt(y.value) ? 1 : -1));
      const one = sorted.find((n) => BigInt(n.value) >= need);
      if (one) return [one];
      const out = []; let sum = 0n;
      for (const n of sorted.reverse()) { if (sum >= need || out.length >= 16) break; out.push(n); sum += BigInt(n.value); }
      return sum >= need ? out : null;
    };
    const send = async (fee) => {
      const notes = pick(fee);
      if (!notes) throw new Error(`fastbridge: the pool notes hold ${free.reduce((x, n) => x + BigInt(n.value), 0n)}, short of ${amount}${fee ? ` and the fee of cutting it (${fee})` : ''}`);
      const own = selfSettle && (await relayHeld()) ? (x) => { log({ level: 'info', msg: 'the relay is held: sending the cut from your wallet', jobId: x.jobId }); return selfSettle(x); } : null;
      return ux.transfer({ walletPriv: privBytes, notes, recipientPubHex: identity().pubHex, amount, fee, ...(own ? { selfSettle: own } : {}) }).catch((e) => {
        if (!(e && e.open && selfSettle)) throw e;
        log({ level: 'info', msg: 'the relay holds a settle: sending it from your wallet', jobId: e.open.jobId });
        return selfSettle({ jobId: e.open.jobId, publicValues: e.open.publicValues, proof: e.open.proof, memos: e.open.memos || [] });
      });
    };
    try { await send(0n); } catch (e) {
      const m = String((e && e.message) || e);
      if (!/free relayed settles|free_budget|fee below|floor/i.test(m)) throw e;
      await send(await refundFee(amount + 1n));
    }
  });
  const reserve = (rec) => {
    if (!rec || rec.phase === 'aborted') return;
    const op = rec.lock && rec.lock.op && (rec.lock.op.op || rec.lock.op);
    if (op && op.nCx) reserved.add(lc(pool.leaf(assetId, op.nCx, op.nCy, op.locker)));
    if (rec.lockNote) reserved.add(lc(rec.lockNote));
  };
  const release = ({ rec }) => { if (rec && rec.lockNote) reserved.delete(lc(rec.lockNote)); };
  const lockOp = ({ rec, rEvmLock, T, deadline, recipient, refundXonly, prefer = null }) => serial(async () => {
    const amount = BigInt(rec.offer.evm.amount);
    const held = await heldNotes();
    const note = prefer ? held.find((n) => lc(n.leaf) === lc(prefer) && BigInt(n.value) === amount) : held.find((n) => BigInt(n.value) === amount && !reserved.has(lc(n.leaf)));
    if (!note) return null;
    const op = ad.buildAdaptorLock({
      chainBinding: ux.chainBindingHex(), spendRoot: note.root, asset: assetId, amount, lBlinding: scalarHex(rEvmLock), T: affine(T), deadline,
      recipient: lc(recipient), refundPub: '0x' + hex(refundXonly),
      nNote: { cx: note.cx, cy: note.cy, owner: note.owner, blinding: note.blinding, leafIndex: note.leafIndex, path: note.path, secret: note.secret },
    });
    // the lock's memo holds what this key needs to finish the swap with nothing else kept (makeOwnLockFinder)
    // (a record that cannot be sealed still locks: it is only not found again from the key, and that is said)
    let memo = '0x';
    try { memo = sealLockMemo({ hmacSha256, key: lockMemoKey({ hmacSha256, walletPriv: privBytes }), swapId: rec.id, offer: rec.offer, deadline }); } catch (e) { log({ level: 'warn', msg: 'the lock carries no memo: it is not found again from the key alone', error: String((e && e.message) || e).slice(0, 120) }); }
    reserved.add(lc(note.leaf));
    return { op: { op, leaves: [], lockMemos: [memo] }, lockLeaf: op.lockLeaf, noteLeaf: lc(note.leaf) };
  });
  async function refundFee(amount) {
    try {
      const ticker = ux.poolTickerOf(assetId);
      const fee = ticker ? ux.ladderFee(await ux.quoteOpFee(ticker, 'transfer')) : 0n;
      return fee > 0n && fee < amount ? BigInt(fee) : 0n;
    } catch { return 0n; }
  }
  async function refundOp({ rec, position }) {
    const lop = rec.lock.op.op || rec.lock.op;
    const id = rec.id, amount = BigInt(lop.amount);
    const T = secpPoint(rec.offer.T);
    const nk = scalarHex(derive('refund-nk', id)), refundOwner = pool.nkToOwner(nk), oBlinding = scalarHex(derive('refund-out', id));
    const fee = await refundFee(amount);
    const op = ad.buildAdaptorRefund({
      chainBinding: ux.chainBindingHex(), lockSetRoot: position.lockSetRoot, asset: assetId, lCx: lop.lCx, lCy: lop.lCy, T: { tx: lop.tx, ty: lop.ty },
      deadline: lop.deadline, recipient: lop.recipient, locker: lop.refundPub, lockerPriv: scalarHex(derive('evm-refund', id)),
      lIndex: position.lIndex, lPath: position.lPath, amount, lBlinding: scalarHex(X.evmLockBlinding({ seed, swapId: bytes(id), T })), oBlinding, fee, refundOwner,
    });
    const output = { value: (amount - fee).toString(), blinding: oBlinding, secret: nk, asset: assetId, owner: refundOwner, cx: op.oCx, cy: op.oCy, ownerPub: identity().pubHex };
    return { op, leaves: [pool.leaf(assetId, op.oCx, op.oCy, refundOwner)], outputs: [output], ephSeed: scalarHex(derive('refund-eph', id)) };
  }
  const secpPoint = (h) => secp.ProjectivePoint.fromHex(strip(h));

  const recipient = async (id) => { const k = derive('evm-auth', id); return { xonly: xonlyOf(k), priv: k }; };
  async function claimOp({ rec, evmOffer, sec, position }) {
    const id = rec.id, amount = BigInt(evmOffer.amount);
    const kernel = X.completeEvmClaim({ offer: evmOffer, t: sec.t, rOut: sec.rOut, nowSecs: await now(), minClaimSecs: policy.minClaimSecs ?? 3600 });
    const L = secpPoint(evmOffer.L).toRawBytes(false);
    const nk = scalarHex(derive('claim-nk', id)), outOwner = pool.nkToOwner(nk), oBlinding = scalarHex(sec.rOut);
    const op = ad.buildAdaptorClaim({
      chainBinding: ux.chainBindingHex(), lockSetRoot: position.lockSetRoot, asset: assetId, lCx: '0x' + hex(L.slice(1, 33)), lCy: '0x' + hex(L.slice(33, 65)),
      T: affine(sec.T), deadline: evmOffer.deadline, recipient: lc(evmOffer.recipient), locker: lc(evmOffer.locker), lIndex: position.lIndex, lPath: position.lPath,
      amount, oBlinding, kernel, outOwner, recipientPriv: scalarHex(derive('evm-auth', id)),
    });
    const output = { value: amount.toString(), blinding: oBlinding, secret: nk, asset: assetId, owner: outOwner, cx: op.oCx, cy: op.oCy, ownerPub: identity().pubHex };
    return { op, leaves: [op.outLeaf], outputs: [output], ephSeed: scalarHex(derive('claim-eph', id)) };
  }

  // the ETH the account that sends its own settles holds, in wei (null when there is no such account or the node cannot say): the provider tells its
  // operator before it is short, and not only when it has stopped taking bridges for want of it
  async function ownEth() {
    if (!ownAccount) return null;
    try { return BigInt(await ux.rpc('eth_getBalance', [ownAccount.address, 'latest'])); } catch { return null; }
  }

  return { now, lockNullifier, lockPosition, findClaim, spentAgreed, lockAbsent, jobStatus, claimStatus: jobStatus, submit, ready, prepare, lockOp, refundOp, refundKey, reserve, release, available, covers, heldFree, cutReserve, recipient, claimOp, ownEth };
}

// ── reads that two nodes or more must agree on ──
// Public nodes of separate operators that the pages' CSP reaches and that serve the pool's state at a recent block number (checked 2026-11-25)
export const AGREE_NODES = Object.freeze(['https://rpc.mevblocker.io', 'https://eth.drpc.org', 'https://eth-mainnet.public.blastapi.io', 'https://1.rpc.thirdweb.com', 'https://ethereum-rpc.publicnode.com']);
const wordOf = (v) => { const s = strip(v || '0'); return BigInt('0x' + (s || '0')).toString(16); };
const txOfNode = (t) => [String(t.to || '').toLowerCase(), strip(t.input || '')];
const receiptOf = (r) => [Number(r.status), Number(r.blockNumber), (r.logs || []).map((l) => [String(l.address || '').toLowerCase(), (l.topics || []).map(strip), strip(l.data || '')])];
// -> { head(), agree(method, params, norm) }: every node is asked; a read stands when at least `min` answer (an error or a null is no answer) and every answer is
// the same once `norm` has reduced it to what the read is for. `head()` is a block a little under the nodes' own heads (the median of the heights they give, less
// `behind`), so nodes that are in step read the same state. Either throws an error with `quorum` set while the nodes do not settle it.
export function makeNodeQuorum({ nodes = AGREE_NODES, fetchImpl = (...a) => fetch(...a), min = 2, timeoutMs = 12000, behind = 2, pinMs = 12000, nowMs = () => Date.now() } = {}) {
  const list = [...new Set((nodes || []).map(String).filter(Boolean))];
  const no = (msg) => Object.assign(new Error(msg), { quorum: true });
  const post = async (url, method, params) => {
    const r = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(timeoutMs) });
    const j = await r.json();
    if (!j || j.error || j.result == null) throw new Error('no answer');
    return j.result;
  };
  const ask = (method, params) => Promise.all(list.map((u) => post(u, method, params).then((v) => ({ u, v }), () => null))).then((xs) => xs.filter(Boolean));
  let pin = null;
  const head = () => {
    if (pin && nowMs() - pin.at < pinMs) return pin.p;
    const p = (async () => {
      const hs = (await ask('eth_blockNumber', [])).map((x) => { try { return Number(BigInt(x.v)); } catch { return null; } }).filter((h) => Number.isSafeInteger(h) && h > 0).sort((a, b) => a - b);
      if (hs.length < min) throw no(`too few Ethereum nodes answered (${hs.length} of ${list.length}): read again`);
      return hs[(hs.length - 1) >> 1] - behind;
    })();
    pin = { at: nowMs(), p };
    p.catch(() => { if (pin && pin.p === p) pin = null; });
    return p;
  };
  async function agree(method, params, norm = (v) => v) {
    const got = (await ask(method, params)).map((x) => { try { return { v: x.v, k: JSON.stringify(norm(x.v)) }; } catch { return null; } }).filter(Boolean);
    if (got.length < min) throw no(`too few Ethereum nodes answered (${got.length} of ${list.length}): read again`);
    if (new Set(got.map((g) => g.k)).size > 1) throw no('the Ethereum nodes do not agree on this read: read again');
    return got[0].v;
  }
  return { head, agree, nodes: list, min };
}

// ── what the pool ran: a transaction's calls, from a node that traces ──
// The public nodes that answered debug_traceTransaction (callTracer) or trace_transaction for a pool settle (2026-11-24). A settle sent through a contract that does not
// carry it as it is (any other forwarder or wallet) is read from here; `nodes` is the operator's to set (an own node first).
//
// The pool keeps no record of a claim's kernel apart from the call that carried it (ConfidentialPool emits none), so a claim sent through a contract of the claimer's,
// in a form of its own, is read only from a trace. A transaction can be made costly to trace (deep, wide call trees, a large output) and a public node may refuse it:
// the reliable reader is a node of the operator's own that keeps state and traces without limits (FB_LP_TRACE_RPCS first). Each node is asked first with a tracer that
// keeps only the calls made to the pool (`pool`), so the answer stays small whatever else the transaction did; then with callTracer; then with trace_transaction.
export const TRACE_NODES = ['https://eth.drpc.org', 'https://eth-mainnet.nodereal.io/v1/1659dfb40aa24bbb8153a677b98064d7', 'https://ethereum-mainnet.gateway.tatum.io', 'https://ethereum-json-rpc.stakely.io'];
// A JavaScript tracer (geth, reth) that keeps only the plain calls (CALL) made to `pool` that ran: a frame that reverted takes the calls under it with it.
export const poolCallsTracer = (pool) => `{ pool: ${JSON.stringify(String(pool).toLowerCase())}, st: [], top: [],
  enter: function (f) { var to = toHex(f.getTo()).toLowerCase(); this.st.push({ me: f.getType() === 'CALL' && to === this.pool ? { to: to, input: toHex(f.getInput()) } : null, calls: [] }); },
  exit: function (r) { var f = this.st.pop(); if (r.getError()) return; var up = this.st.length ? this.st[this.st.length - 1].calls : this.top; if (f.me) up.push(f.me); for (var i = 0; i < f.calls.length; i++) up.push(f.calls[i]); },
  fault: function () {},
  result: function (ctx) { if (ctx.error) return []; var out = [], to = toHex(ctx.to).toLowerCase(); if (ctx.type === 'CALL' && to === this.pool) out.push({ to: to, input: toHex(ctx.input) }); for (var i = 0; i < this.top.length; i++) out.push(this.top[i]); return out; } }`;
// -> trace(txHash) -> [{ to, input }]: every call that ran (one that reverted, or sits under one that did, is left out), in order; with `pool`, the calls to the pool among them
export function makeTxTracer({ nodes = TRACE_NODES, fetchImpl = (...a) => fetch(...a), timeoutMs = 20000, pool = null, traceTimeout = '60s' } = {}) {
  const post = async (url, method, params) => {
    const r = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(timeoutMs) });
    const j = await r.json();
    if (!j || j.error || j.result == null) throw new Error(`${method}: ${String((j && j.error && j.error.message) || r.status).slice(0, 80)}`);
    return j.result;
  };
  // (a call that is not a plain CALL, such as a delegatecall into the pool's code or a static call, changes nothing of the pool's: it is not what the pool ran)
  const fromCallTracer = (root) => {
    const out = [];
    const walk = (f) => { if (!f || f.error) return; if (!f.type || String(f.type).toUpperCase() === 'CALL') out.push({ to: f.to, input: f.input }); for (const c of f.calls || []) walk(c); };
    walk(root);
    return out;
  };
  const fromParity = (list) => {
    const at = (t) => (t.traceAddress || []).join('.');
    const failed = list.filter((t) => t.error).map(at);
    const ran = (a) => !failed.some((b) => b === '' || a === b || a.startsWith(b + '.'));
    return list.filter((t) => t.type === 'call' && t.action && (!t.action.callType || t.action.callType === 'call') && ran(at(t))).map((t) => ({ to: t.action.to, input: t.action.input }));
  };
  const poolOnly = pool ? poolCallsTracer(pool) : null;
  const one = async (url, txHash) => {
    if (poolOnly) {
      try {
        const r = await post(url, 'debug_traceTransaction', [txHash, { tracer: poolOnly, timeout: traceTimeout }]);
        if (Array.isArray(r) && r.every((c) => c && typeof c.input === 'string' && typeof c.to === 'string')) return r;
      } catch { /* a node without JavaScript tracers: the other forms */ }
    }
    try { return fromCallTracer(await post(url, 'debug_traceTransaction', [txHash, { tracer: 'callTracer', timeout: traceTimeout, tracerConfig: { onlyTopCall: false, withLog: false } }])); } catch { /* the other form */ }
    const r = await post(url, 'trace_transaction', [txHash]);
    if (!Array.isArray(r)) throw new Error('trace_transaction: not a list');
    return fromParity(r);
  };
  const tracer = async (txHash) => {
    const why = [];
    for (const url of nodes) {
      try { return await one(url, txHash); } catch (e) { why.push(String((e && e.message) || e)); }
    }
    throw new Error('no node traced the transaction: ' + why.join('; ').slice(0, 240));
  };
  // every node's trace at once, null for one that gave none: what a reading taken from a trace is checked against
  tracer.all = (txHash) => Promise.all(nodes.map((u) => one(u, txHash).catch(() => null)));
  tracer.nodes = [...nodes];
  return tracer;
}

// ── the lock's memo ──
// A pool lock made here carries a memo sealed to the key: the swap id, the Bitcoin lock it answers (outpoint, timelock, value, refund key, and a note's blinding), the
// adaptor point, the deadline, the amount, and the recipient and output blinding the other side asked for. That is all of a swap the key does not derive, so the swap is
// built again from the key and the chain alone (dapp/fastbridge-el.js recordFromLockMemo). 322 bytes (the size of a stealth lock's memo with its sender's tail): a point,
// the sealed fields, and 16 bytes that authenticate them under the key.
const LOCK_MEMO_PLAIN = 273, LOCK_MEMO_BYTES = 33 + LOCK_MEMO_PLAIN + 16;
const memoTe = new TextEncoder();
const hexOf = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
const bytesOf = (h) => Uint8Array.from((strip(h).match(/../g) || []).map((x) => parseInt(x, 16)));
const catOf = (...a) => { const o = new Uint8Array(a.reduce((s, x) => s + x.length, 0)); let p = 0; for (const x of a) { o.set(x, p); p += x.length; } return o; };
const beOf = (v, n) => { let x = BigInt(v); if (x < 0n || x >> BigInt(8 * n)) throw new Error('lock memo: a field does not fit'); const o = new Uint8Array(n); for (let i = n - 1; i >= 0; i--) { o[i] = Number(x & 0xffn); x >>= 8n; } return o; };
const fromBeOf = (b) => b.reduce((a, x) => (a << 8n) | BigInt(x), 0n);
const fixed = (h, n, what) => { const b = bytesOf(h); if (b.length !== n) throw new Error(`lock memo: ${what} is not ${n} bytes`); return b; };
export const lockMemoKey = ({ hmacSha256, walletPriv }) => hmacSha256(walletPriv instanceof Uint8Array ? walletPriv : bytesOf(walletPriv), memoTe.encode('tacit-fastbridge-lock-memo-v1'));
const memoStream = (hmacSha256, key, P) => { const out = []; for (let i = 0; out.length < LOCK_MEMO_PLAIN; i++) out.push(...hmacSha256(key, catOf(memoTe.encode('stream'), P, Uint8Array.of(i)))); return out.slice(0, LOCK_MEMO_PLAIN); };
const memoMac = (hmacSha256, key, P, ct) => hmacSha256(key, catOf(memoTe.encode('mac'), P, ct)).slice(0, 16);
export function sealLockMemo({ hmacSha256, key, swapId, offer, deadline }) {
  const b = offer.btc, e = offer.evm, sid = fixed(swapId, 36, 'the swap id');
  const body = catOf(Uint8Array.of(1), sid, fixed(b.txid, 32, 'the lock txid'), beOf(b.vout, 2), beOf(b.csvBlocks, 2), beOf(b.value, 8), fixed(b.lockerXonly, 32, 'the refund key'),
    fixed(offer.T, 33, 'T'), beOf(deadline, 8), beOf(e.amount, 8), fixed(e.recipient, 32, 'the recipient'), fixed(e.rOut, 32, 'the output blinding'), b.rLock ? fixed(b.rLock, 32, 'the lock blinding') : new Uint8Array(32));
  const plain = new Uint8Array(LOCK_MEMO_PLAIN); plain.set(body);
  let k = 0n;
  for (let i = 0; !k; i++) k = fromBeOf(hmacSha256(key, catOf(memoTe.encode('point'), sid, Uint8Array.of(i)))) % SECP_N;
  const P = G.multiply(k).toRawBytes(true), s = memoStream(hmacSha256, key, P);
  const ct = plain.map((x, i) => x ^ s[i]);
  return '0x' + hexOf(catOf(P, ct, memoMac(hmacSha256, key, P, ct)));
}
// -> the fields sealLockMemo sealed, or null for a memo that is not this key's
export function openLockMemo({ hmacSha256, key, memo }) {
  try {
    const m = bytesOf(memo || '');
    if (m.length !== LOCK_MEMO_BYTES) return null;
    const P = m.slice(0, 33), ct = m.slice(33, 33 + LOCK_MEMO_PLAIN);
    if (hexOf(memoMac(hmacSha256, key, P, ct)) !== hexOf(m.slice(33 + LOCK_MEMO_PLAIN))) return null;
    const s = memoStream(hmacSha256, key, P), p = ct.map((x, i) => x ^ s[i]);
    if (p[0] !== 1) return null;
    let o = 1;
    const take = (n) => { const x = p.slice(o, o + n); o += n; return x; };
    const swapId = hexOf(take(36)), txid = hexOf(take(32)), vout = Number(fromBeOf(take(2))), csvBlocks = Number(fromBeOf(take(2))), value = fromBeOf(take(8)).toString();
    const lockerXonly = hexOf(take(32)), T = hexOf(take(33)), deadline = Number(fromBeOf(take(8))), amount = fromBeOf(take(8)).toString(), recipient = hexOf(take(32)), rOut = hexOf(take(32)), rLock = hexOf(take(32));
    return { swapId, btc: { txid, vout, csvBlocks, value, lockerXonly, rLock: /^0+$/.test(rLock) ? null : rLock }, T, deadline, evm: { amount, recipient, rOut } };
  } catch { return null; }
}
// -> find() -> [{ ...opened memo, lockLeaf }]: every pool lock whose memo this key sealed, read from the pool's lock set (its events and the settles' calldata)
export function makeOwnLockFinder({ ux, hmacSha256, walletPriv }) {
  const key = lockMemoKey({ hmacSha256, walletPriv });
  const inputs = new Map();
  const getTxInput = async (h) => {
    if (inputs.has(h)) return inputs.get(h);
    const t = await ux.rpc('eth_getTransactionByHash', [h]);
    if (t && t.input) inputs.set(h, t.input);
    return t && t.input;
  };
  // The pool module's own lock set is read first (ux.scanLockSet): one read the page shares with the lock positions, its inputs taken from the pool snapshot once a
  // node has vouched for a few and the rest read in batches, and checked against the lock tree's count and root on chain. A module without it, or a set that does not
  // check out, is read here as before.
  const shared = async () => { try { return typeof ux.scanLockSet === 'function' ? await ux.scanLockSet() : null; } catch { return null; } };
  return async ({ events = null } = {}) => {
    const set = (!events && (await shared())) || await (async () => {
      const evs = events || (await ux.fetchEvents({ toBlock: 'latest' }));
      const need = [...new Set(evs.filter((e) => e && e.type === 'LockLeavesInserted' && e.txHash).map((e) => e.txHash))].filter((h) => !inputs.has(h));
      if (need.length > 1 && typeof ux.readTxs === 'function') {
        try { const m = await ux.readTxs(need); for (const h of need) { const t = m.get(String(h).toLowerCase()); if (t && t.input) inputs.set(h, t.input); } } catch { /* one by one in the scan */ }
      }
      return ux.lockScan.scanLockLeaves({ events: evs, getTxInput });
    })();
    const out = [];
    set.lockLeaves.forEach((leaf, i) => {
      const c = set.lockMemoCandidates && set.lockMemoCandidates[i];
      for (const m of c && c.length ? c : [set.lockMemos[i]]) {
        const f = m ? openLockMemo({ hmacSha256, key, memo: m }) : null;
        if (f) { out.push({ ...f, lockLeaf: lc(leaf) }); break; }
      }
    });
    return out;
  };
}
