
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

// `trace(txHash)` -> the calls a transaction made, [{ to, input }] (makeTxTracer): how a claim settled through another contract is read when its calldata does not show it
export function makeFastBridgeEvm({ ux, secp, keccak256, hmacSha256, walletPriv, seed, asset, poolAddress, relayerAddress = MAINNET_RELAYER, policy = {}, adaptor = null, selfSettle = null, ownAccount = null, openGraceMs = 45000, selfRetryMs = 120000, clock = () => Date.now(), log = () => {}, trace = null }) {
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

  async function mappingFlag(slot, key) {
    const k = hex(keccak256(cat(bytes(key), bytes('0x' + slot.toString(16).padStart(64, '0')))));
    return BigInt((await rpc('eth_getStorageAt', [poolAddress, '0x' + k, 'latest'])) || '0x0') !== 0n;
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
  const trustedTo = new Set([poolAddress, relayerAddress].map((a) => String(a).toLowerCase()));
  const poolTo = String(poolAddress).toLowerCase();
  const claims = new Map(), traced = new Map();
  // what the settle calls among `calls` say of the lock `key`: whether one spent it, and the claim kernels they carry
  const naming = (calls, key) => {
    const r = { named: false, s: [] };
    for (const call of calls || []) {
      let f; try { f = ux.lockScan.decodePublicValuesAdaptorFields(call.publicValues); } catch { continue; }
      if (f.lockNullifiers.map(lc).includes(key)) { r.named = true; r.s.push(...f.adaptorClaimS); }
    }
    return r;
  };
  // the settles the pool itself ran in a transaction, read from its trace (a call that reverted, or sits under one that did, ran nothing)
  async function pooledSettles(txHash) {
    if (!traced.has(txHash)) {
      let calls = null;
      try { calls = await trace(txHash); } catch (e) { log({ level: 'warn', msg: 'a transaction could not be traced', tx: txHash, error: String((e && e.message) || e).slice(0, 160) }); }
      if (!calls) return null;                           // asked again on a later look
      traced.set(txHash, calls.filter((c) => String(c.to || '').toLowerCase() === poolTo && strip(c.input || '').startsWith(SETTLE_SELECTOR))
        .map((c) => { try { return ux.lockScan.decodeSettleCalls(c.input); } catch { return null; } }).filter(Boolean).flatMap((d) => d.calls));
      cap(traced, 4096);
    }
    return traced.get(txHash);
  }
  // The claim kernels of the settle that spent a lock: [] for a refund, null while the lock is unspent. A settle sent straight to the pool or through its relayer is read
  // from the transaction's input. One sent through another contract (a forwarder, a contract wallet) is read from that contract's input when it carries the settle as it
  // is, and a kernel found that way is taken only when `check(s)` says it opens the swap (it is what someone wrote, not what the pool ran); else from the pool's own call
  // in the transaction's trace (`trace`), which is what the pool ran.
  async function findClaim(lockNu, { sinceSecs = 0, check = null } = {}) {
    if (!(await mappingFlag(LOCK_SPENT_SLOT, lockNu))) return null;
    const key = lc(lockNu);
    if (claims.has(key)) return claims.get(key);
    const events = await ux.fetchEvents({ fromBlock: sinceSecs ? await blockAtOrAfter(Math.max(0, sinceSecs - 3600)) : undefined, toBlock: 'latest' });
    const seen = new Set();
    const found = [], loose = [], others = []; let named = false;
    for (const e of events) {
      if (!e.txHash || seen.has(e.txHash) || (e.type !== 'LeavesInserted' && e.type !== 'NullifiersSpent')) continue;
      seen.add(e.txHash);
      const tx = await txOf(e.txHash);
      const decoded = tx && ux.lockScan.decodeSettleCalls(tx.input);
      if (decoded && decoded.direct && trustedTo.has(tx.to)) {
        const r = naming(decoded.calls, key);
        if (r.named) { named = true; found.push(...r.s); }
        continue;
      }
      others.push(e.txHash);
      if (decoded) loose.push(...naming(decoded.calls, key).s);
    }
    if (named) { claims.set(key, found); cap(claims, 1024); return found; }
    if (check) {
      const hit = loose.find((s) => { try { return check(s); } catch { return false; } });
      if (hit) { claims.set(key, [hit]); cap(claims, 1024); return [hit]; }
    }
    if (trace) {
      // the newest first, a few new traces a look (a trace read once is kept), so a long window is read over several looks
      let fresh = 0;
      for (const h of others.reverse()) {
        if (!traced.has(h) && fresh++ >= TRACE_PER_LOOK) break;
        const r = naming(await pooledSettles(h), key);
        if (!r.named) continue;
        // (a trace is a node's word: with a check, only a kernel that opens the swap is taken from it)
        const s = check ? r.s.filter((x) => { try { return check(x); } catch { return false; } }) : r.s;
        if (check && !s.length) continue;
        claims.set(key, s); cap(claims, 1024); return s;
      }
    }
    throw new Error('the lock is spent, and the settle that spent it is not found yet');
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
    try { const found = await findClaim(nu, { sinceSecs: again.sinceSecs || 0 }); return !!(found && found.length); } catch { return false; }
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

  async function heldNotes() {
    const { byAsset } = await ux.balance(privBytes);
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

  return { now, lockNullifier, lockPosition, findClaim, jobStatus, claimStatus: jobStatus, submit, ready, prepare, lockOp, refundOp, refundKey, reserve, release, available, covers, heldFree, cutReserve, recipient, claimOp, ownEth };
}

// ── what the pool ran: a transaction's calls, from a node that traces ──
// The public nodes that answered debug_traceTransaction (callTracer) or trace_transaction for a pool settle (2026-11-24). A settle sent through a contract that does not
// carry it as it is (any other forwarder or wallet) is read from here; `nodes` is the operator's to set (an own node first).
export const TRACE_NODES = ['https://eth.drpc.org', 'https://eth-mainnet.nodereal.io/v1/1659dfb40aa24bbb8153a677b98064d7', 'https://ethereum-mainnet.gateway.tatum.io', 'https://ethereum-json-rpc.stakely.io'];
// -> trace(txHash) -> [{ to, input }]: every call that ran (one that reverted, or sits under one that did, is left out), in order
export function makeTxTracer({ nodes = TRACE_NODES, fetchImpl = (...a) => fetch(...a), timeoutMs = 20000 } = {}) {
  const post = async (url, method, params) => {
    const r = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(timeoutMs) });
    const j = await r.json();
    if (!j || j.error || j.result == null) throw new Error(`${method}: ${String((j && j.error && j.error.message) || r.status).slice(0, 80)}`);
    return j.result;
  };
  const fromCallTracer = (root) => {
    const out = [];
    const walk = (f) => { if (!f || f.error) return; out.push({ to: f.to, input: f.input }); for (const c of f.calls || []) walk(c); };
    walk(root);
    return out;
  };
  const fromParity = (list) => {
    const at = (t) => (t.traceAddress || []).join('.');
    const failed = list.filter((t) => t.error).map(at);
    const ran = (a) => !failed.some((b) => b === '' || a === b || a.startsWith(b + '.'));
    return list.filter((t) => t.type === 'call' && t.action && ran(at(t))).map((t) => ({ to: t.action.to, input: t.action.input }));
  };
  return async (txHash) => {
    const why = [];
    for (const url of nodes) {
      try { return fromCallTracer(await post(url, 'debug_traceTransaction', [txHash, { tracer: 'callTracer' }])); } catch (e) { why.push(String((e && e.message) || e)); }
      try { const r = await post(url, 'trace_transaction', [txHash]); if (Array.isArray(r)) return fromParity(r); } catch (e) { why.push(String((e && e.message) || e)); }
    }
    throw new Error('no node traced the transaction: ' + why.join('; ').slice(0, 240));
  };
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
  return async ({ events = null } = {}) => {
    const set = await ux.lockScan.scanLockLeaves({ events: events || (await ux.fetchEvents({ toBlock: 'latest' })), getTxInput });
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
