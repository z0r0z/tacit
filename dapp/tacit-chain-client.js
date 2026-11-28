import { sha256, keccak_256, hmac, concatBytes, secp } from './vendor/tacit-deps.min.js';
import { poseidon2, poseidon3, poseidon4, poseidon5 } from './vendor/tacit-poseidon.min.js';
import { makeChainWallet, hopOp, poolOp, worthOf, sharesFor, sharesToPay, poolShare, VIRTUAL } from './tacit-chain-wallet.js';
import { makeChainMemoWorkers } from './confidential-chain-memo-workers.js';
import { chainSeed, rootSeed, keptRoot, keepRoot } from './tacit-chain-lane.js';

export const UNIT = 10n ** 10n;
const te = new TextEncoder();
const POSEIDON = { 2: poseidon2, 3: poseidon3, 4: poseidon4, 5: poseidon5 };
const poseidon = (xs) => POSEIDON[xs.length](xs);
const hx = (b) => '0x' + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const word = (v) => BigInt(v).toString(16).padStart(64, '0');
const strip = (h) => String(h).replace(/^0x/, '').toLowerCase();
const sel = (sig) => hx(keccak_256(te.encode(sig)).slice(0, 4)).slice(2);
const hexBytes = (h) => Uint8Array.from(strip(h).match(/../g) || [], (x) => parseInt(x, 16));
const big = (h) => BigInt('0x' + (strip(h) || '0'));
const ZERO_LEAF = '0x' + '0'.repeat(64);
const PUBLICS_LEN = 12 * 32, PROOF_LEN = 2080, HINTS_LEN = 20 * 64, MEMO_LEN = 1152;
const KEEP_MS = 30 * 864e5;
const SHIELD_AHEAD_MS = 3 * 60e3;

export const keyMessage = (key, address) => sha256(concatBytes(te.encode('tacit-chain-key-v1'), key, address));
// A dated record (the leader keeps a key's newest, so one the key signed before cannot be posted again over it): ‖ at as 8 bytes big-endian
const be8 = (n) => { const o = new Uint8Array(8); new DataView(o.buffer).setBigUint64(0, BigInt(n)); return o; };
export const keyMessageDated = (key, address, at) => sha256(concatBytes(te.encode('tacit-chain-key-v2'), key, address, be8(at)));

export { chainSeed };

export function sharesWorth(units, rate) {
  let n = sharesFor(units, rate, 0n);
  while (worthOf(n, rate) < BigInt(units)) n += 1n;
  return n;
}

/// Whether a deposit's `amount` no longer buys its `shares` at `rate` (the contract's `_stale`): every later block prices at that rate or a higher one,
/// so no block can take the deposit in (a posted spend is passed over too) and the contract sends it back at once instead of after RECLAIM_AFTER.
export const depositStale = (d, rate) => BigInt(d.amount) * (BigInt(rate.shares) + VIRTUAL) < BigInt(d.shares) * (BigInt(rate.pool) + VIRTUAL);

export function forcedBytes(submission, hints) {
  const publics = hexBytes(submission.publics), proof = hexBytes(submission.proof), data = hexBytes(submission.data), h = hints instanceof Uint8Array ? hints : hexBytes(hints);
  if (publics.length !== PUBLICS_LEN || proof.length !== PROOF_LEN || h.length !== HINTS_LEN) throw new Error('tacit chain: not a spend that can be posted');
  const memos = (submission.memos || []).map(hexBytes);
  const slots = [0, 1, 2].map((i) => {
    if (publics.subarray(32 * (5 + i), 32 * (6 + i)).every((x) => x === 0)) return new Uint8Array(MEMO_LEN);
    const m = memos.shift();
    if (!m || m.length !== MEMO_LEN) throw new Error('tacit chain: a memo for each new note');
    return m;
  });
  return concatBytes(publics, proof, h, ...slots, data.subarray(96), ...(submission.opMemos || []).map(hexBytes));
}

export function leaderTerms(f) {
  const n = (v) => (/^\d+$/.test(String(v ?? '')) ? BigInt(v) : 0n);
  return { fee: n(f?.fee), shieldCap: null, sweepFee: n(f?.sweepFee) };      // no cap on a shield: the contract has none, and the page sets none
}

export const FEE_CEILING = 2n * 10n ** 8n;
export const SWEEP_FEE_CEILING = 2n * FEE_CEILING * 10n ** 10n;

export async function chooseLeader({ cfg, route = null, fetchImpl = (...a) => globalThis.fetch(...a), memo = new Map(), valid = () => true, routeMs = 4000 }) {
  let t = { base: cfg.leader, until: Infinity };
  let timer;
  try { if (route) t = (await Promise.race([route.target(), new Promise((ok) => { timer = setTimeout(() => ok(null), routeMs); })])) || t; } catch { } finally { clearTimeout(timer); }
  const ask = async (base) => {
    try { const r = await fetchImpl(base + '/fee', { signal: AbortSignal.timeout(10e3) }); return r.ok ? await r.json() : null; } catch { return null; }
  };
  if (t.base !== cfg.leader) {
    let hit = memo.get(t.base);
    if (!hit || Date.now() - hit.at > 5e3) { hit = { at: Date.now(), f: await ask(t.base) }; memo.set(t.base, hit); }
    const terms = hit.f ? leaderTerms(hit.f) : null;
    if (terms && terms.fee <= FEE_CEILING && terms.sweepFee <= SWEEP_FEE_CEILING && valid(hit.f)) return { base: t.base, until: t.until, f: hit.f };
  }
  return { base: cfg.leader, until: Infinity, f: await ask(cfg.leader) };
}

// The Ethereum transaction that landed a Tacit block: TacitBlocks emits Landed(height indexed, ...), so the block's own height finds it.
// Best effort and quick (a node that refuses the range, or a tx not yet indexed, gives null and never an error): the page links it when there is one.
const LANDED_TOPIC = hx(keccak_256(te.encode('Landed(uint256,bytes32,bytes32,address)')));
export async function landedTxOf({ cfg, rpcCall }, height) {
  if (!Number.isSafeInteger(height) || height < 0) return null;
  try {
    const head = Number(BigInt(await rpcCall('eth_blockNumber', [])));
    for (const span of [300, 9000]) {
      const logs = await rpcCall('eth_getLogs', [{ address: cfg.blocks, topics: [LANDED_TOPIC, '0x' + word(height)], fromBlock: '0x' + Math.max(0, head - span).toString(16), toBlock: 'latest' }]);
      const hash = Array.isArray(logs) && logs.length ? logs[logs.length - 1]?.transactionHash : null;
      if (/^0x[0-9a-fA-F]{64}$/.test(hash || '')) return hash;
    }
  } catch { /* the Landed line just goes without a link */ }
  return null;
}

// The Ethereum transaction that paid an exit out: the leader's withdraw(to) moves the TAC from TacitBlocks to the recipient, so it is the
// first TAC Transfer(TacitBlocks -> to) at or after the landing block. Null until it is there (the page asks again); never throws.
const TAC_TOKEN = '0xa1313eb9f3a445606d9583bcac3ebeb56a858279', TRANSFER_TOPIC = hx(keccak_256(te.encode('Transfer(address,address,uint256)')));
export async function paidOutTxOf({ cfg, rpcCall }, to, landingTx) {
  try {
    if (!/^0x[0-9a-fA-F]{40}$/.test(to || '') || !/^0x[0-9a-fA-F]{64}$/.test(landingTx || '')) return null;
    const rc = await rpcCall('eth_getTransactionReceipt', [landingTx]);
    const from = rc?.blockNumber ? Number(BigInt(rc.blockNumber)) : null;
    if (from == null) return null;
    const pad = (a) => '0x' + String(a).replace(/^0x/, '').toLowerCase().padStart(64, '0');
    const logs = await rpcCall('eth_getLogs', [{ address: TAC_TOKEN, topics: [TRANSFER_TOPIC, pad(cfg.blocks), pad(to)], fromBlock: '0x' + from.toString(16), toBlock: 'latest' }]);
    const hash = Array.isArray(logs) && logs.length ? logs[0]?.transactionHash : null;
    return /^0x[0-9a-fA-F]{64}$/.test(hash || '') ? hash : null;
  } catch { return null; }
}

export async function chainStatus({ cfg, rpcCall, fetchImpl = (...a) => globalThis.fetch(...a), timeoutMs = 10e3 }) {
  if (!cfg) throw new Error('tacit chain: not deployed');
  const read = async (sig) => big(await rpcCall('eth_call', [{ to: cfg.blocks, data: '0x' + sel(sig) }, 'latest']));
  const terms = (async () => {
    try {
      const r = await fetchImpl(cfg.leader + '/fee', { signal: AbortSignal.timeout(timeoutMs) });
      return r.ok ? leaderTerms(await r.json()) : null;
    } catch { return null; }
  })();
  const [height, lastLanded, pool, shares, leader] = await Promise.all([read('height()'), read('lastLanded()'), read('pool()'), read('shares()'), terms]);
  return { height: Number(height), lastLanded: Number(lastLanded), pool, shares, leader };
}

// opens the chain's memos in workers when the page has them (the wallet opens them itself otherwise); one set of workers for the page
const sharedMemoWorkers = makeChainMemoWorkers();

// root: the key's PQ ID root (32 bytes, tacit-chain-lane.js rootSeed), or null for none; left out, the one this device keeps for the key is used.
export function makeChainClient({ cfg, rpcCall, priv, system, root = undefined, route = null, routeMs = 4000, storage = globalThis.localStorage, fetchImpl = (...a) => globalThis.fetch(...a), memoWorkers = sharedMemoWorkers }) {
  if (!cfg) throw new Error('tacit chain: not deployed');
  const call = async (sig, args = '') => strip(await rpcCall('eth_call', [{ to: cfg.blocks, data: '0x' + sel(sig) + args }, 'latest']));
  const api = async (method, path, body, base = cfg.leader) => {
    const r = await fetchImpl(base + path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, ...j };
  };
  const leader = {
    path: (i) => api('GET', `/path/${i}`),
    state: () => api('GET', '/state'),
    notes: (from, limit) => api('GET', `/notes?from=${from}&limit=${limit}`),
    nullifiers: (from, limit) => api('GET', `/nullifiers?from=${from}&limit=${limit}`),
    spent: async (nf) => (await api('GET', `/spent/${nf}`)).spent,
    address: async (h) => (await api('GET', `/address/${h}`)).address,
    // (signed both ways: the dated signature orders the key's records, and the undated one is what clients from before it check; dated after the
    // key's record now, so one made in the same second, or on a device whose clock is behind, still comes after it)
    publish: async (a) => {
      const key = secp.getPublicKey(priv, true), ab = hexBytes(a), now = Math.floor(Date.now() / 1000);
      const cur = await api('GET', `/address/key/${hx(key).slice(2)}`).catch(() => null);
      const at = Math.max(now, Math.min(Number.isSafeInteger(cur?.at) ? cur.at + 1 : 0, now + 86_000));
      const sig = (await secp.signAsync(keyMessage(key, ab), priv)).toCompactRawBytes(), sig2 = (await secp.signAsync(keyMessageDated(key, ab, at), priv)).toCompactRawBytes();
      const r = await api('POST', '/address', { address: a, key: hx(key), sig: hx(sig), at, sig2: hx(sig2) });
      if (!r.ok) throw new Error(r.error || `the leader did not take the address (${r.status})`);
      return r.hash;
    },
  };
  // The chain address a key's own record names, checked against the key, or null. A key's record is its latest chain address (its PQ ID's, once it
  // has one), so a Tacit address stays the same while the keys behind it change. A dated record's date is checked too.
  async function keyRecord(k) {
    const r = await api('GET', `/address/key/${strip(k)}`).catch(() => null);
    if (!r?.ok || !r.address || !r.sig) return null;
    let good = false;
    try {
      const kb = hexBytes(k), ab = hexBytes(r.address);
      good = secp.verify(hexBytes(r.sig), keyMessage(kb, ab), kb)
        && (r.sig2 == null || (Number.isSafeInteger(r.at) && r.at > 0 && secp.verify(hexBytes(r.sig2), keyMessageDated(kb, ab, r.at), kb)));
    } catch { }
    return good ? 'tc1' + strip(r.address) : null;
  }
  // A payer asks for the key's record first (it is signed by the key the Tacit address carries), and the address's chain lane is the fallback.
  async function recipientOf(lanes) {
    await ready();
    const keys = [lanes?.evm?.ownerPub, lanes?.btc?.spendPub].filter(Boolean).map(hx);
    for (const k of [...new Set(keys)]) {
      const a = await keyRecord(k);
      if (a) { try { return w.decodeAddress(a); } catch { } }
    }
    if (lanes?.chain?.hash) return w.resolve(lanes.chain.hash, leader);
    throw new Error('tacit chain: this Tacit address has not opened the Tacit chain yet');
  }
  let w = null, prover = null, assetHex = null, rootNow = root;
  // me: the keys new notes go to. old: the keys from before the PQ ID (made from the Tacit key), still read and spent; null with no PQ ID.
  // Each is { k, lane, st: { next, notes } }. elsewhere: the key's record names a PQ ID this device does not hold.
  let me = null, old = null, elsewhere = false;
  const sets = () => (old ? [me, old] : [me]);
  const allNotes = () => sets().flatMap((K) => K.st.notes);
  const keyset = (k) => ({ k, lane: hx(w.chainAddressHash(w.address(k))).slice(2, 18), st: { next: 0, notes: [] } });
  // (the keys from before a PQ ID name the spends and hops kept here, so those stay where they were)
  const lane = () => (old || me).lane;
  const notesKey = (K) => `tacit-chain-notes-v1:${cfg.blocks.toLowerCase()}:${K.lane}`;
  const leavesKey = () => `tacit-chain-leaves-v1:${cfg.blocks.toLowerCase()}`;
  const nullifiersKey = () => `tacit-chain-nullifiers-v1:${cfg.blocks.toLowerCase()}`;
  const save = () => {
    for (const K of sets()) { try { storage?.setItem(notesKey(K), JSON.stringify({ next: K.st.next, notes: K.st.notes.map((n) => ({ ...n, value: String(n.value), leaf: String(n.leaf) })) })); } catch {} }
    try { storage?.setItem(leavesKey(), w.leavesKept()); } catch {}
    try { storage?.setItem(nullifiersKey(), w.nullifiersKept()); } catch {}
  };
  const loadSet = (K) => {
    try {
      const j = JSON.parse(storage?.getItem(notesKey(K)) || 'null');
      if (j) { K.st.notes = j.notes.map((n) => ({ ...n, value: BigInt(n.value), leaf: BigInt(n.leaf) })); K.st.next = j.next; }
    } catch {}
  };
  const load = () => {
    for (const K of sets()) loadSet(K);
    try { w.leavesKeep(storage?.getItem(leavesKey()) || ''); } catch {}
    try { w.nullifiersKeep(storage?.getItem(nullifiersKey()) || ''); } catch {}
  };
  const proverP = () => (prover ||= Promise.resolve(system()).then((s) => ({ prove: (input, o) => s.prove(input, o) })));

  async function ready() {
    if (w) return;
    const [chain, asset] = await Promise.all([call('CHAIN()'), call('TAC_ASSET()')]);
    w = makeChainWallet({ poseidon, prover: { prove: async (i, o) => (await proverP()).prove(i, o) }, chain: '0x' + chain, asset: BigInt('0x' + asset), openMany: memoWorkers });
    const before = keyset(w.keys(chainSeed(priv)));
    if (rootNow === undefined) rootNow = keptRoot(priv, storage)?.root ?? null;
    if (rootNow) { me = keyset(w.keys(rootSeed(rootNow))); old = before; } else me = before;
    assetHex = asset.padStart(64, '0');
    load();
  }

  async function scan() {
    await ready();
    for (const K of sets()) {
      const r = await w.scan(K.k, leader, { from: K.st.next, known: K.st.notes.map((n) => ({ ...n, s: hexBytes(n.s) })) });
      K.st.next = Math.max(K.st.next, r.next);
      K.st.notes = r.notes.map((n) => ({ index: n.index, value: n.value, s: hx(n.s), leaf: n.leaf, nullifier: n.nullifier }));
    }
    save();
    return balance();
  }
  const myKey = () => hx(secp.getPublicKey(priv, true));
  // The key's record names the PQ ID's address once it has one; keys without it (a device that does not hold the root) must not replace it.
  async function publishMine() {
    await ready();
    if (!old) {
      const a = await keyRecord(myKey()).catch(() => null);
      if (a && a !== w.encodeAddress(w.address(me.k))) { elsewhere = true; return null; }
    }
    return w.publish(me.k, leader);
  }
  const held = () => kept().filter((e) => e.queued && !e.refused && (e.nullifiers || []).length);
  const taken = () => new Set(held().flatMap((e) => e.nullifiers.map(strip)));
  const leafKey = (l) => BigInt(l).toString(16).padStart(64, '0');
  const settling = () => { const have = new Set(allNotes().map((n) => leafKey(n.leaf))); return held().flatMap((e) => e.own || []).filter((o) => !have.has(leafKey(o.leaf))).reduce((t, o) => t + BigInt(o.value), 0n); };
  const balance = () => { const t = taken(); return allNotes().filter((n) => !t.has(strip(n.nullifier))).reduce((a, n) => a + BigInt(n.value), 0n) + settling(); };
  async function rate() {
    const [pool, shares] = await Promise.all([call('pool()'), call('shares()')]);
    return { pool: big(pool), shares: big(shares) };
  }
  // The leader asked for incoming payments, kept for a minute (or to the end of its slot) so the poll does not ask for its fee each time.
  let lastBase = null;
  async function incomingBase() {
    const now = Date.now();
    if (lastBase && now - lastBase.at < 60e3 && now < lastBase.until) return lastBase.base;
    const p = await pick().catch(() => null);
    lastBase = p ? { base: p.base, until: p.until ?? Infinity, at: now } : null;
    return p?.base ?? null;
  }
  async function incomingNotes() {
    await ready();
    const bases = [...new Set([cfg.leader, await incomingBase()].filter(Boolean))];
    const rs = (await Promise.all(bases.map((b) => api('GET', '/pending-notes', undefined, b).catch(() => null))))
      .filter((x) => x?.ok && Array.isArray(x.leaves) && x.leaves.length && x.memos?.length === x.leaves.length);
    const seen = new Set(), r = { ok: true, leaves: [], memos: [] };
    for (const x of rs) x.leaves.forEach((l, i) => { const k = leafKey(l); if (!seen.has(k)) { seen.add(k); r.leaves.push(l); r.memos.push(x.memos[i]); } });
    if (!r.leaves.length) return [];
    const skip = new Set([...held().flatMap((e) => e.own || []).map((x) => leafKey(x.leaf)), ...allNotes().map((x) => leafKey(x.leaf))]);
    const page = { leaves: r.leaves, memos: r.memos, next: r.leaves.length, total: r.leaves.length };
    const got = [];
    for (const K of sets()) got.push(...(await w.scan(K.k, { notes: async () => page, spent: async () => false }, { from: 0, known: [], keep: false })).notes.filter((x) => !skip.has(leafKey(x.leaf))));
    if (!got.length) return [];
    const at = await rate();
    return got.map((x) => ({ key: leafKey(x.leaf), units: worthOf(BigInt(x.value), at) }));
  }
  // (a note under the keys from before the PQ ID names them, k, and is spent under them)
  const owned = () => { const t = taken(); return sets().flatMap((K) => K.st.notes.filter((n) => !t.has(strip(n.nullifier))).map((n) => ({ ...n, s: hexBytes(n.s), ...(K === old ? { k: old.k } : {}) }))); };
  const olderHeld = () => owned().filter((n) => n.k).reduce((a, n) => a + BigInt(n.value), 0n);

  async function feeAt(base = cfg.leader) {
    await ready();
    const f = await api('GET', '/fee', undefined, base);
    if (!f.ok) throw new Error('the Tacit chain’s leader did not answer');
    return termsOf(f);
  }
  const quoted = new Map();
  const termsOf = (f) => {
    const t = leaderTerms(f);
    if (t.fee === 0n) return { units: 0n, to: null, shieldCap: t.shieldCap, sweepFee: t.sweepFee };
    if (typeof f.address !== 'string') throw new Error('the leader asks a fee but names no address for it');
    return { units: t.fee, to: w.decodeAddress(f.address), shieldCap: t.shieldCap, sweepFee: t.sweepFee };
  };
  async function pick() {
    await ready();
    const c = await chooseLeader({ cfg, route, routeMs, fetchImpl, memo: quoted, valid: (f) => { try { termsOf(f); return true; } catch { return false; } } });
    let t = null;
    try { t = c.f ? termsOf(c.f) : null; } catch { }
    return { ...(t || { units: 0n, to: null, shieldCap: null, sweepFee: 0n }), base: c.base, until: c.until };
  }
  const feeNow = pick;
  const overCap = (cap) => {
    const whole = (cap / 10n ** 8n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ','), frac = (cap % 10n ** 8n).toString().padStart(8, '0').replace(/0+$/, '');
    return Object.assign(new Error(`For now the Tacit chain takes up to ${whole}${frac ? '.' + frac : ''} TAC a shield.`), { overCap: true, cap });
  };
  const feeOut = (f, r) => (f.units > 0n ? [{ to: f.to, value: sharesWorth(f.units, r) }] : []);

  // Two notes at most. Notes under the keys from before the PQ ID go first, and one rides in a slot a spend leaves free (it proves two inputs either
  // way), its value coming back as change under the PQ ID: what the old keys hold moves over with the next spends, at no cost. A note rides only
  // when it is not one of the two largest left free, so a payment straight after this one can spend as much as it could without the ride.
  function inputs(need) {
    const ns = owned().sort((a, b) => (BigInt(b.value) > BigInt(a.value) ? 1 : -1));
    const cover = (xs) => {
      if (xs[0] && BigInt(xs[0].value) >= need) return [xs.filter((n) => BigInt(n.value) >= need).pop()];
      if (xs.length >= 2 && BigInt(xs[0].value) + BigInt(xs[1].value) >= need) return xs.slice(0, 2);
      return null;
    };
    const ins = cover(ns.filter((n) => n.k)) || cover(ns);
    if (ins) {
      const ride = ins.length === 1 && ns.filter((n) => n !== ins[0]).slice(2).reverse().find((n) => n.k);
      return ride ? [...ins, ride] : ins;
    }
    if (settling() > 0n && balance() >= need) throw Object.assign(new Error('your last payment is settling: this one can go once it lands, in about a minute'), { settling: true });
    throw new Error(balance() >= need ? 'that amount spans more than two of your chain notes: move part of it first' : 'more than you hold on the tacit chain, with its fees');
  }
  const topTwo = () => owned().map((n) => BigInt(n.value)).sort((a, b) => (b > a ? 1 : -1)).slice(0, 2).reduce((a, b) => a + b, 0n);

  const pkey = () => `tacit-chain-pending-v1:${cfg.blocks.toLowerCase()}:${lane()}`;
  const kept = () => { try { return JSON.parse(storage?.getItem(pkey()) || '[]'); } catch { return []; } };
  const keepAll = (list) => { try { if (list.length || !storage?.removeItem) storage?.setItem(pkey(), JSON.stringify(list)); else storage.removeItem(pkey()); } catch {} };
  const idOf = (submission) => strip(hx(sha256(concatBytes(hexBytes(submission.publics), hexBytes(submission.data)))));
  function remember(spent, meta) {
    const id = idOf(spent.submission);
    const list = kept().filter((e) => e.id !== id);
    const old = kept().find((e) => e.id === id);
    const leaves = [5, 6, 7].map((i) => '0x' + strip(spent.submission.publics).slice(64 * i, 64 * i + 64)).filter((l) => l !== ZERO_LEAF);
    for (const l of leaves) madeKeys.add(leafKey(l));
    const own = (spent.created || []).filter((c) => c.self && BigInt(c.value) > 0n).map((c) => ({ leaf: '0x' + BigInt(c.leaf).toString(16).padStart(64, '0'), value: String(c.value) }));
    const e = { ...old, ...meta, id, submission: spent.submission, nullifiers: spent.nullifiers || [], leaves, ...(own.length || !old?.own ? { own } : {}), at: old?.at ?? Date.now() };
    if (spent.deposit) e.deposit = { shares: String(spent.deposit.shares), amount: String(spent.deposit.amount), cx: spent.deposit.cx, cy: spent.deposit.cy, body: spent.deposit.body };
    list.push(e);
    keepAll(list);
    return e;
  }
  const forget = (id) => { const e = kept().find((x) => x.id === id); if (e) noteMade(e); keepAll(kept().filter((x) => x.id !== id)); };
  const mark = (id, meta) => keepAll(kept().map((e) => (e.id === id ? { ...e, ...meta } : e)));
  // Every leaf and nullifier is asked at once; a landed leaf counts first, and a probe that fails counts as not yet.
  async function settled(e) {
    const [ls, ns] = await Promise.all([
      Promise.all((e.leaves || []).map((l) => api('GET', `/leaf/${l}`).then((r) => !!r.ok, () => false))),
      Promise.all((e.nullifiers || []).map((nf) => leader.spent(nf).then((x) => !!x, () => false))),
    ]);
    return ls.includes(true) ? 'landed' : ns.includes(true) ? 'spent' : null;
  }
  const madeKeys = new Set();
  const noteMade = (e) => { for (const l of e.leaves || []) madeKeys.add(leafKey(l)); };
  const keptErr = (err, e) => Object.assign(err, { kept: e });

  async function submit(spent, extra = {}, { onStatus, timeoutMs = 30 * 60e3, slowMs = 10 * 60e3, kind = 'spend', units = null, meta = {}, base = cfg.leader } = {}) {
    const e = remember(spent, { kind, units: units == null ? null : String(units), extra, ...(base !== cfg.leader ? { lead: base } : { lead: null }), ...meta });
    let r;
    try { r = await api('POST', '/spend', { ...spent.submission, ...extra }, base); } catch { throw keptErr(new Error('the Tacit chain’s leader did not answer'), e); }
    if (!r.ok) {
      if (r.status >= 400 && r.status < 500 && r.status !== 429 && r.status !== 408) mark(e.id, { refused: true });
      throw keptErr(new Error(r.error || `the leader refused the spend (${r.status})`), e);
    }
    mark(e.id, { queued: true, refused: false });
    onStatus?.({ id: r.id, status: 'queued', kept: e });
    const t0 = Date.now();
    let slow = false, looked = t0, height = null;
    for (;;) {
      const rc = await api('GET', `/receipt/${r.id}`, undefined, base).catch(() => null);
      if (rc?.ok && rc.status === 'landed') { height = Number.isSafeInteger(rc.height) ? rc.height : null; break; }
      if (rc?.ok && rc.status === 'refused') { mark(e.id, { refused: true }); throw keptErr(new Error(rc.error || 'the leader refused the spend'), e); }
      if (rc && !rc.ok && rc.status === 404) {
        if (await settled(e).catch(() => null)) break;
        throw keptErr(new Error('the leader no longer has this spend'), e);
      }
      if (Date.now() - looked > 30e3) { looked = Date.now(); if (await settled(e).catch(() => null)) break; }
      if (!slow && Date.now() - t0 > slowMs) { slow = true; onStatus?.({ id: r.id, status: 'slow', kept: e }); }
      if (Date.now() - t0 > timeoutMs) throw keptErr(new Error('not landed yet: it stays with the leader, and lands when a block takes it'), e);
      await new Promise((ok) => setTimeout(ok, 4000));
    }
    await scan().catch(() => {});
    hopNote(e);
    forget(e.id);
    const gone = new Set((spent.nullifiers || []).map(strip));
    for (const K of sets()) K.st.notes = K.st.notes.filter((n) => !gone.has(strip(n.nullifier)));
    save();
    onStatus?.({ id: r.id, status: 'landed', height });
    return { id: r.id, height, tx: await landedTxOf({ cfg, rpcCall }, height) };
  }

  async function offer(spent, extra = {}, { kind = 'spend', units = null, meta = {}, base = cfg.leader } = {}) {
    const e = remember(spent, { kind, units: units == null ? null : String(units), extra, ...(base !== cfg.leader ? { lead: base } : { lead: null }), ...meta });
    let r;
    try { r = await api('POST', '/spend', { ...spent.submission, ...extra }, base); } catch { throw keptErr(new Error('the Tacit chain’s leader did not answer'), e); }
    if (!r.ok) throw keptErr(new Error(r.error || `the leader refused the spend (${r.status})`), e);
    return { id: r.id, kept: e };
  }

  const hkey = () => `tacit-chain-hops-v1:${cfg.blocks.toLowerCase()}:${lane()}`;
  const hopsKept = () => { try { return JSON.parse(storage?.getItem(hkey()) || '[]'); } catch { return []; } };
  const hopsKeep = (list) => { try { list.length ? storage?.setItem(hkey(), JSON.stringify(list)) : storage?.removeItem?.(hkey()); } catch {} };
  const hopNote = (e) => { if (e.kind === 'hop' && e.commit && e.units) hopsKeep([...hopsKept().filter((h) => strip(h.commit) !== strip(e.commit)), { units: String(e.units), commit: '0x' + strip(e.commit), at: Date.now() }]); };
  const hopsHeld = async (units, commit) => big(await call('hops(bytes32)', strip(hx(keccak_256(hexBytes(word(units) + strip(commit)))))));

  async function spend(opts) {
    await ready();
    const made = await w.spend(me.k, { ...opts, leader });
    save();
    return made;
  }
  const AHEAD_MS = 8 * 60e3;
  async function preparePay(to, amount, o = {}) {
    await ready();
    const [r, f] = await Promise.all([rate(), feeNow()]);
    const shares = sharesWorth(amount, r), pool = poolShare(r), out = feeOut(f, r);
    const ins = inputs(shares + pool + (out[0]?.value ?? 0n));
    return { kind: 'pay', units: amount, at: Date.now(), base: f.base, until: f.until, spent: await spend({ inputs: ins, outputs: [{ to, value: shares }, ...out], exit: { v: pool, amount: 0n, op: poolOp() }, onProgress: o.onProgress }) };
  }
  async function prepareWithdraw(to, amount, o = {}) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(to)) throw new Error('an Ethereum address');
    await ready();
    const [r, f] = await Promise.all([rate(), feeNow()]);
    const shares = sharesToPay(amount, r), out = feeOut(f, r);
    return { kind: 'withdraw', units: amount, meta: { to }, at: Date.now(), base: f.base, until: f.until, spent: await spend({ inputs: inputs(shares + (out[0]?.value ?? 0n)), outputs: out, exit: { v: shares, amount: BigInt(amount), to }, onProgress: o.onProgress }) };
  }
  const fresh = (p) => !!p?.spent && Date.now() - p.at < AHEAD_MS && Date.now() < (p.until ?? Infinity) && (p.spent.nullifiers || []).every((nf) => owned().some((n) => strip(n.nullifier) === strip(nf)));
  const send = (p, o = {}) => submit(p.spent, {}, { ...o, kind: p.kind, units: p.units, base: p.base || cfg.leader, ...(p.meta ? { meta: p.meta } : {}) });

  async function forcePayload(submission) {
    let last = new Error('no node could make the posting');
    for (const base of [cfg.leader, ...(cfg.nodes || [])].filter(Boolean)) {
      try {
        const r = await api('POST', '/forced', submission, base);
        if (!r.ok || typeof r.payload !== 'string') { last = new Error(r.error || `the node refused (${r.status})`); continue; }
        const p = hexBytes(r.payload), at = PUBLICS_LEN + PROOF_LEN;
        if (p.length < at + HINTS_LEN || hx(forcedBytes(submission, p.subarray(at, at + HINTS_LEN))) !== hx(p)) { last = new Error('a node answered with another spend'); continue; }
        return r.payload;
      } catch (err) { last = err; }
    }
    throw last;
  }
  const depWords = (d) => word(d.shares) + word(d.amount) + strip(d.cx) + strip(d.cy) + strip(d.body);

  return {
    ready, scan, balance, rate, fee: feeAt,
    paidOutTx: (to, landingTx) => paidOutTxOf({ cfg, rpcCall }, to, landingTx),
    shieldCap: async () => (await feeNow()).shieldCap,
    leaderNow: async () => { const f = await pick(); return { base: f.base, routed: f.base !== cfg.leader }; },
    address: async () => { await ready(); return w.address(me.k); },
    lane: async () => { await ready(); return w.chainAddressHash(w.address(me.k)); },
    publish: publishMine,
    // PQ ID: chain keys from a root no published key leads to (a passkey's own output). → { on, elsewhere, older (shares still under the keys from
    // before it), olderUnits (what they are worth), credentialId }
    async pqState() {
      await ready();
      if (!old && !elsewhere) { const a = await keyRecord(myKey()).catch(() => null); elsewhere = !!a && a !== w.encodeAddress(w.address(me.k)); }
      const older = olderHeld();
      return { on: !!old, elsewhere: !old && elsewhere, older, olderUnits: older > 0n ? worthOf(older, await rate()) : 0n, credentialId: old ? keptRoot(priv, storage)?.credentialId ?? null : null };
    },
    // Takes a PQ ID's root: kept on this device (sealed under the Tacit key), its keys made the ones new notes go to, and its address named in the
    // key's record so payers of the same Tacit address reach it. A root that does not make the PQ ID the key's record names is refused.
    async harden(r, credentialId = null) {
      await ready();
      if (!(r instanceof Uint8Array) || r.length !== 32) throw new Error('tacit chain: a root is 32 bytes');
      const next = keyset(w.keys(rootSeed(r)));
      if (old) {
        if (next.lane === me.lane) return w.address(me.k);
        throw new Error('This wallet already has a PQ ID, made with another passkey.');
      }
      const a = await keyRecord(myKey()).catch(() => null);
      if (a && a !== w.encodeAddress(w.address(me.k)) && a !== w.encodeAddress(w.address(next.k))) throw new Error('That is not the passkey this wallet’s PQ ID was made with. Choose the other one.');
      keepRoot(priv, r, credentialId, storage);
      rootNow = Uint8Array.from(r); old = me; me = next; elsewhere = false;
      loadSet(me);
      await w.publish(me.k, leader);
      await scan().catch(() => {});
      return w.address(me.k);
    },
    // Moves up to two notes from the keys from before the PQ ID to it now, as a payment to itself (the next spends move them anyway).
    async moveOlder(o = {}) {
      await ready();
      const ns = owned().filter((n) => n.k).sort((a, b) => (BigInt(b.value) > BigInt(a.value) ? 1 : -1)).slice(0, 2);
      if (!ns.length) return null;
      const [r, f] = await Promise.all([rate(), feeNow()]);
      const pool = poolShare(r), out = feeOut(f, r), total = ns.reduce((a, n) => a + BigInt(n.value), 0n);
      if (total <= pool + (out[0]?.value ?? 0n)) throw new Error('Too little is under the older keys to pay for moving it. It moves with your next payment.');
      const units = worthOf(total - pool - (out[0]?.value ?? 0n), r);
      return submit(await spend({ inputs: ns, outputs: out, exit: { v: pool, amount: 0n, op: poolOp() }, onProgress: o.onProgress }), {}, { ...o, kind: 'pay', units, base: f.base, meta: { self: true } });
    },
    resolve: async (hash) => { await ready(); return w.resolve(hash, leader); },
    recipientOf,
    resubmit: (e, o = {}) => submit({ submission: e.submission, nullifiers: e.nullifiers }, e.extra || {}, { kind: e.kind, units: e.units, base: e.lead || cfg.leader, ...o }),
    worth: async () => worthOf(balance(), await rate()),
    settling: () => settling() > 0n || held().length > 0,
    async incoming() {
      return (await incomingNotes()).reduce((t, x) => t + x.units, 0n);
    },
    incomingNotes,
    async noteList() {
      await ready();
      const r = await rate();
      return allNotes().map((n) => ({ key: leafKey(n.leaf), units: worthOf(BigInt(n.value), r) }));
    },
    has: (key) => allNotes().some((x) => leafKey(x.leaf) === key),
    ownLeaf: (key) => madeKeys.has(key) || kept().some((e) => (e.leaves || []).some((l) => leafKey(l) === key)),
    async pending() {
      await ready();
      const gone = new Set(), list = kept();
      let i = 0;
      // up to four kept spends are checked at a time
      const work = async () => {
        while (i < list.length) {
          const e = list[i++];
          if (!e.deposit && Date.now() - e.at > KEEP_MS) { gone.add(e.id); noteMade(e); continue; }
          if (await settled(e).catch(() => null)) { gone.add(e.id); noteMade(e); hopNote(e); }
        }
      };
      await Promise.all(Array.from({ length: Math.min(4, list.length) }, work));
      const left = kept().filter((e) => !gone.has(e.id));
      if (gone.size) keepAll(left);
      return left;
    },
    forget: async (id) => { await ready(); forget(id); },
    forcePayload,
    forceCalldata: (payload) => {
      const b = strip(payload);
      return '0x' + sel('force(bytes)') + word(32) + word(b.length / 2) + b.padEnd(Math.ceil(b.length / 64) * 64, '0');
    },
    posted: async (id, tx) => { await ready(); mark(id, { forced: { tx, at: Date.now() } }); },
    forceDelay: async () => Number(big(await call('FORCE_DELAY()'))),
    async depositState(d) {
      await ready();
      const k = hx(keccak_256(hexBytes(assetHex + word(d.shares) + strip(d.cx) + strip(d.cy) + strip(d.body) + word(d.amount))));
      const [r, rt, done] = await Promise.all([call('pending(bytes32)', strip(k)), rate().catch(() => null), call('queueDone()').then(big, () => null)]);
      return { from: '0x' + r.slice(24, 64), at: Number(big(r.slice(64, 128))), forced: Number(big(r.slice(128, 192))), stale: !!rt && depositStale(d, rt), done: done == null ? null : Number(done) };
    },
    reclaimAfter: async () => Number(big(await call('RECLAIM_AFTER()'))),
    reclaimCalldata: (d) => '0x' + sel('reclaim(uint256,uint256,bytes32,bytes32,bytes32)') + depWords(d),
    giveBackCalldata: (d, back) => '0x' + sel('giveBack(uint256,uint256,bytes32,bytes32,bytes32,bytes32)') + depWords(d) + strip(back),
    async quote(kind, units = 0n) {
      await ready();
      const [r, f] = await Promise.all([rate(), feeNow()]);
      const feeSh = f.units > 0n ? sharesWorth(f.units, r) : 0n;
      const u = BigInt(units || 0n);
      if (kind === 'shield') {
        const sh = sharesFor(u, r);
        const arrives = sh > feeSh ? worthOf(sh - feeSh, r) : 0n;
        return { fee: f.units, holders: u > arrives + f.units ? u - arrives - f.units : 0n, arrives, most: null, cap: f.shieldCap, sweepFee: f.sweepFee };
      }
      const avail = topTwo() - feeSh - (kind === 'pay' ? poolShare(r) : 0n), first = worthOf(owned().reduce((m, n) => (BigInt(n.value) > m ? BigInt(n.value) : m), 0n), r);
      if (kind === 'pay') return { fee: f.units, holders: worthOf(poolShare(r), r), most: avail > 0n ? worthOf(avail, r) : 0n, first };
      let lo = 0n, hi = avail > 0n ? worthOf(avail, r) : 0n;
      while (lo < hi) { const mid = (lo + hi + 1n) / 2n; if (sharesToPay(mid, r) <= avail) lo = mid; else hi = mid - 1n; }
      return { fee: f.units, holders: u > 0n ? worthOf(sharesToPay(u, r), r) - u : 0n, most: lo, first };
    },
    async shield(amount, { onProgress } = {}) {
      await ready();
      const [r, f] = await Promise.all([rate(), feeNow()]);
      if (f.shieldCap != null && BigInt(amount) > f.shieldCap) throw overCap(f.shieldCap);
      const shares = sharesFor(amount, r);
      const out = feeOut(f, r);
      if (shares <= (out[0]?.value ?? 0n)) throw new Error(out.length ? 'too little to cover the leader’s fee' : 'too little to buy a share');
      const s = await spend({ dep: { v: shares, amount: BigInt(amount) }, outputs: out, onProgress });
      const d = s.deposit;
      const args = depWords(d);
      return {
        deposit: d,
        fee: f.units,
        rate: r, at: Date.now(), units: BigInt(amount), base: f.base, until: f.until,
        sweepFee: f.sweepFee,
        permitValue: (sweepFee = f.sweepFee) => BigInt(amount) * UNIT + BigInt(sweepFee),
        submission: s.submission,
        depositCalldata: '0x' + sel('deposit(uint256,uint256,bytes32,bytes32,bytes32)') + args,
        inbox: async (back) => '0x' + (await call('inbox(uint256,uint256,bytes32,bytes32,bytes32,bytes32)', args + strip(back))).slice(24),
        submit: (o = {}) => submit(s, { ...(o.back ? { back: o.back } : {}), ...(o.permit ? { permit: o.permit } : {}) }, { ...o, kind: 'shield', units: amount, base: f.base, meta: { from: o.from, tx: o.tx, back: o.back || o.permit?.back } }),
        offer: (o = {}) => offer(s, { ...(o.back ? { back: o.back } : {}), ...(o.permit ? { permit: o.permit } : {}) }, { kind: 'shield', units: amount, base: f.base, meta: { back: o.back || o.permit?.back, ...(o.meta || {}) } }),
      };
    },
    async shieldFresh(sh, amount) {
      await ready();
      const [r, f] = await Promise.all([rate(), feeNow()]);
      if (!sh?.rate || sh.units !== BigInt(amount) || r.pool !== sh.rate.pool || r.shares !== sh.rate.shares || Date.now() - sh.at > SHIELD_AHEAD_MS) return false;
      if (f.base !== (sh.base || cfg.leader) || Date.now() >= (sh.until ?? Infinity)) return false;
      sh.sweepFee = f.sweepFee;
      return true;
    },
    async inboxState(addr) {
      if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) throw new Error('an inbox address');
      const [tac, code] = await Promise.all([call('TAC()'), rpcCall('eth_getCode', [addr, 'latest'])]);
      const held = big(await rpcCall('eth_call', [{ to: '0x' + tac.slice(24), data: '0x70a08231' + strip(addr).padStart(64, '0') }, 'latest']));
      return { held, swept: strip(code).length > 0 };
    },
    sweepCalldata: (d, back) => '0x' + sel('sweep(uint256,uint256,bytes32,bytes32,bytes32,bytes32)') + depWords(d) + strip(back),
    sweepWithPermitCalldata: (d, p) => '0x' + sel('sweepWithPermit(uint256,uint256,bytes32,bytes32,bytes32,bytes32,address,uint256,uint256,uint8,bytes32,bytes32)') + depWords(d)
      + strip(p.back).padStart(64, '0') + strip(p.owner).padStart(64, '0') + word(p.fee) + word(p.deadline) + word(p.v) + strip(p.r).padStart(64, '0') + strip(p.s).padStart(64, '0'),
    pay: async (to, amount, o = {}) => send(await preparePay(to, amount, o), o),
    withdraw: async (to, amount, o = {}) => send(await prepareWithdraw(to, amount, o), o),
    preparePay, prepareWithdraw, fresh, send,
    warm: async () => { await ready(); const s = await Promise.resolve(system()); await s.ready?.(); },
    async hop(commit, amount, o = {}) {
      await ready();
      const [r, f] = await Promise.all([rate(), feeNow()]);
      const shares = sharesToPay(amount, r), out = feeOut(f, r);
      const done = await submit(await spend({ inputs: inputs(shares + (out[0]?.value ?? 0n)), outputs: out, exit: { v: shares, amount: BigInt(amount), op: hopOp(commit) }, onProgress: o.onProgress }), {}, { ...o, kind: 'hop', units: amount, base: f.base, meta: { commit } });
      hopsKeep([...hopsKept().filter((h) => strip(h.commit) !== strip(commit)), { units: String(amount), commit: '0x' + strip(commit), at: Date.now() }]);
      return done;
    },
    async hopsWaiting() {
      await ready();
      const gone = new Set();
      for (const h of hopsKept()) {
        const n = await hopsHeld(h.units, h.commit).catch(() => null);
        if (n === 0n) gone.add(strip(h.commit) + ':' + h.units);
      }
      const left = hopsKept().filter((h) => !gone.has(strip(h.commit) + ':' + h.units));
      if (gone.size) hopsKeep(left);
      return left;
    },
    sendHopCalldata: (units, commit) => '0x' + sel('sendHop(uint256,bytes32)') + word(units) + strip(commit),
    owed: async (addr) => BigInt('0x' + (await call('owed(address)', strip(addr).padStart(64, '0')))),
    withdrawCalldata: (addr) => '0x' + sel('withdraw(address)') + strip(addr).padStart(64, '0'),
  };
}
