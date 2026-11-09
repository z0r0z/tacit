// The tacit chain as the app uses it: one wallet from the Tacit key (HMAC-SHA256(key, "tacit-chain-seed-v1"), a seed of its own, so
// nothing on the chain links to the user's other addresses), its notes found from the chain's memos (scanned once, then only what
// is new), and the moves: shield TAC from Ethereum (approved deposit, or an inbox the confidential pool's unwrap pays), pay a chain
// address, withdraw to an Ethereum address, hop into the confidential pool. Every spend is proven here (the pool's Halo2 prover),
// then handed to the chain's leader, with a note paying the leader its fee (GET /fee) when it asks one.
//
//   const c = makeChainClient({ cfg: tacitChain(), rpcCall, priv, system: () => halo2System, storage: localStorage });
//   await c.ready();  c.balance();  await c.scan();
//   const s = await c.shield(units)    → { deposit (for TacitBlocks.deposit), inbox(back) → address, submit({ back? }) }
//   await c.pay(fullAddress, units)    → receipt;   await c.withdraw('0x…', units);   await c.hop(commit, units)
//
// Every spend handed to the leader is kept in `storage` until it lands (`pending()`), so a reload, a leader that refuses it or one that
// is gone loses nothing: `forcePayload(submission)` gets from any node the bytes TacitBlocks.force takes, and `forceCalldata` posts them
// from the user's own Ethereum account; the chain must then take it within FORCE_DELAY. A shield deposit no block took in goes back with
// `reclaimCalldata` (a deposit, after RECLAIM_AFTER) or `giveBackCalldata` (an inbox).
//
// The wallet's TAC comes in through the shield's inbox too: a permit for it (`s.permitValue()`: the amount and the leader's `sweepFee`) that
// the leader sends in with sweepWithPermit, `s.offer({ back, permit })`; or a plain TAC transfer to `s.inbox(back)` and `s.offer({ back })`.
// Private TAC from the confidential pool comes in through an inbox: `s = shield(amount)` for exactly what the pool's unwrap pays,
// `s.offer({ back, meta })` before anything is paid (kept here and held by the leader, which sweeps the inbox once paid), the unwrap
// to `s.inbox(back)`, then `s.submit({ back })`; `inboxState` says whether an inbox is paid or swept, `sweepCalldata` sweeps it from the
// user's own account. A hop that landed is kept until it is sent on into the pool (`hopsWaiting`, `sendHopCalldata`).
//
// Amounts are TAC in units of 1e-8 (1e10 of the token's smallest units). Notes count shares of the chain's pool, worth more as the
// chain's fees stay with its holders: `balance()` is in shares, `worth()` in units at the rate the landing contract holds (read from
// Ethereum, not the leader). A spend takes at most two notes: more is refused with a message to move fewer at once.
import { sha256, keccak_256, hmac, concatBytes, secp } from './vendor/tacit-deps.min.js';
import { poseidon2, poseidon3, poseidon4, poseidon5 } from './vendor/tacit-poseidon.min.js';
import { makeChainWallet, hopOp, poolOp, worthOf, sharesFor, sharesToPay, poolShare } from './tacit-chain-wallet.js';

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
/// The sizes of a posted spend's parts (tacit-block-common `forced_parts`).
const PUBLICS_LEN = 12 * 32, PROOF_LEN = 2080, HINTS_LEN = 20 * 64, MEMO_LEN = 1152;
/// How long a spend kept here is offered again before it is given up on (a deposit goes back after 7 days).
const KEEP_MS = 30 * 864e5;
const SHIELD_AHEAD_MS = 3 * 60e3;                                 // a shield proved ahead is used within three minutes, at the rate it was proved at

/// What a Tacit key signs to name its chain address at a leader's directory: SHA-256("tacit-chain-key-v1" ‖ key ‖ address). A Tacit address
/// from before the chain carries the key but not the chain lane, so a payer finds the chain address under the key and checks this signature.
export const keyMessage = (key, address) => sha256(concatBytes(te.encode('tacit-chain-key-v1'), key, address));

/// The chain seed of a Tacit private key: one-way and domain-separated, like the Ethereum account and the Bitcoin pool seed.
export const chainSeed = (priv) => hmac(sha256, priv, te.encode('tacit-chain-seed-v1'));

/// The fewest shares worth at least `units` at `rate`.
export function sharesWorth(units, rate) {
  let n = sharesFor(units, rate, 0n);
  while (worthOf(n, rate) < BigInt(units)) n += 1n;
  return n;
}

/// The bytes TacitBlocks.force takes for a submission (what POST /spend takes), with the given hints (node/src/serve.rs `forced_payload`):
/// publics ‖ proof ‖ hints ‖ a memo per output slot (zeros for an empty one) ‖ the spend data after its memo hashes ‖ the operation's memos.
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

/// What a leader's GET /fee names, as numbers: { fee (units of 1e-8 TAC a spend), shieldCap (units, null for none), sweepFee (TAC's own wei,
/// for sending a permitted shield in) }.
export function leaderTerms(f) {
  const n = (v) => (/^\d+$/.test(String(v ?? '')) ? BigInt(v) : 0n);
  const cap = n(f?.shieldCap);
  return { fee: n(f?.fee), shieldCap: cap > 0n ? cap : null, sweepFee: n(f?.sweepFee) };
}

/// The chain as anyone sees it, with no key: what the landing contract holds on Ethereum (blocks landed, when the last did, the pool and its
/// shares) and the leader's terms (null when it does not answer).
///   → { height, lastLanded (seconds), pool, shares, leader: { fee, shieldCap, sweepFee } | null }
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

export function makeChainClient({ cfg, rpcCall, priv, system, storage = globalThis.localStorage, fetchImpl = (...a) => globalThis.fetch(...a) }) {
  if (!cfg) throw new Error('tacit chain: not deployed');
  const call = async (sig, args = '') => strip(await rpcCall('eth_call', [{ to: cfg.blocks, data: '0x' + sel(sig) + args }, 'latest']));
  const api = async (method, path, body, base = cfg.leader) => {
    const r = await fetchImpl(base + path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, ...j };
  };
  const leader = {
    path: (i) => api('GET', `/path/${i}`),
    notes: (from, limit) => api('GET', `/notes?from=${from}&limit=${limit}`),
    spent: async (nf) => (await api('GET', `/spent/${nf}`)).spent,
    address: async (h) => (await api('GET', `/address/${h}`)).address,
    // the full address, and the same address signed for under this wallet's Tacit key
    publish: async (a) => {
      const key = secp.getPublicKey(priv, true), sig = (await secp.signAsync(keyMessage(key, hexBytes(a)), priv)).toCompactRawBytes();
      const r = await api('POST', '/address', { address: a, key: hx(key), sig: hx(sig) });
      if (!r.ok) throw new Error(r.error || `the leader did not take the address (${r.status})`);
      return r.hash;
    },
  };
  /// Where a decoded Tacit address (its `lanes`) is paid on the chain: its chain lane, else the chain address its key signed for (an address
  /// from before the chain), the signature checked here as well as at the leader.
  async function recipientOf(lanes) {
    await ready();
    if (lanes?.chain?.hash) return w.resolve(lanes.chain.hash, leader);
    const keys = [lanes?.evm?.ownerPub, lanes?.btc?.spendPub].filter(Boolean).map(hx);
    for (const k of [...new Set(keys)]) {
      const r = await api('GET', `/address/key/${k.slice(2)}`).catch(() => null);
      if (!r?.ok || !r.address || !r.sig) continue;
      const ab = hexBytes(r.address);
      let good = false;
      try { good = secp.verify(hexBytes(r.sig), keyMessage(hexBytes(k), ab), hexBytes(k)); } catch { }
      if (!good) continue;
      return w.decodeAddress('tc1' + strip(r.address));
    }
    throw new Error('tacit chain: this Tacit address has not opened the Tacit chain yet');
  }
  let w = null, me = null, prover = null, assetHex = null;
  const st = { next: 0, notes: [] };   // notes: { index, value, s (hex), leaf, nullifier }
  const lane = () => hx(w.chainAddressHash(w.address(me))).slice(2, 18);
  const key = () => `tacit-chain-notes-v1:${cfg.blocks.toLowerCase()}:${lane()}`;
  const save = () => { try { storage?.setItem(key(), JSON.stringify({ next: st.next, notes: st.notes.map((n) => ({ ...n, value: String(n.value), leaf: String(n.leaf) })) })); } catch {} };
  const load = () => {
    try {
      const j = JSON.parse(storage?.getItem(key()) || 'null');
      if (j) { const notes = j.notes.map((n) => ({ ...n, value: BigInt(n.value), leaf: BigInt(n.leaf) })); st.notes = notes; st.next = j.next; }
    } catch {}
  };
  const proverP = () => (prover ||= Promise.resolve(system()).then((s) => ({ prove: (input, o) => s.prove(input, o) })));

  async function ready() {
    if (w) return;
    const [chain, asset] = await Promise.all([call('CHAIN()'), call('TAC_ASSET()')]);
    w = makeChainWallet({ poseidon, prover: { prove: async (i, o) => (await proverP()).prove(i, o) }, chain: '0x' + chain, asset: BigInt('0x' + asset) });
    me = w.keys(chainSeed(priv));
    assetHex = asset.padStart(64, '0');
    load();
  }

  /// New notes since the last scan, then which of this wallet's are spent.
  async function scan() {
    await ready();
    const r = await w.scan(me, leader, { from: st.next, known: st.notes.map((n) => ({ ...n, s: hexBytes(n.s) })) });
    st.next = Math.max(st.next, r.next);                // (a leader replaying after a restart reports a smaller total: never go back)
    st.notes = r.notes.map((n) => ({ index: n.index, value: n.value, s: hx(n.s), leaf: n.leaf, nullifier: n.nullifier }));
    save();
    return balance();
  }
  // What the wallet holds once the spends the leader holds land: its notes less those they spend, and the change they make to this wallet
  // (counted until the note itself is read). A spend the leader refused, or one never handed over, takes nothing.
  const held = () => kept().filter((e) => e.queued && !e.refused && (e.nullifiers || []).length);
  const taken = () => new Set(held().flatMap((e) => e.nullifiers.map(strip)));
  const leafKey = (l) => BigInt(l).toString(16).padStart(64, '0');
  const settling = () => { const have = new Set(st.notes.map((n) => leafKey(n.leaf))); return held().flatMap((e) => e.own || []).filter((o) => !have.has(leafKey(o.leaf))).reduce((t, o) => t + BigInt(o.value), 0n); };
  const balance = () => { const t = taken(); return st.notes.filter((n) => !t.has(strip(n.nullifier))).reduce((a, n) => a + BigInt(n.value), 0n) + settling(); };
  /// The pool and shares the landing contract holds on Ethereum (a share is worth pool / shares units, with the program's virtual units):
  /// read from Ethereum, so a leader cannot make a spend pay out or buy at another rate than the chain's.
  async function rate() {
    const [pool, shares] = await Promise.all([call('pool()'), call('shares()')]);
    return { pool: big(pool), shares: big(shares) };
  }
  // the payments the leader holds that open with this wallet's key, each with its worth (its own change is not among them)
  async function incomingNotes() {
    await ready();
    const r = await api('GET', '/pending-notes').catch(() => null);
    if (!r?.ok || !Array.isArray(r.leaves) || !r.leaves.length || r.memos?.length !== r.leaves.length) return [];
    const skip = new Set([...held().flatMap((e) => e.own || []).map((x) => leafKey(x.leaf)), ...st.notes.map((x) => leafKey(x.leaf))]);
    const page = { leaves: r.leaves, memos: r.memos, next: r.leaves.length, total: r.leaves.length };
    const got = (await w.scan(me, { notes: async () => page, spent: async () => false }, { from: 0, known: [] })).notes.filter((x) => !skip.has(leafKey(x.leaf)));
    if (!got.length) return [];
    const at = await rate();
    return got.map((x) => ({ key: leafKey(x.leaf), units: worthOf(BigInt(x.value), at) }));
  }
  const owned = () => { const t = taken(); return st.notes.filter((n) => !t.has(strip(n.nullifier))).map((n) => ({ ...n, s: hexBytes(n.s) })); };

  /// The leader's fee: { units, to (its chain address), shieldCap, sweepFee }, units 0 when it asks none. `shieldCap`: the most units one
  /// shield may deposit through this leader for now (its launch cap; a shield over it is dropped), null when it names none. `sweepFee`: what
  /// it takes, in TAC's own wei (18 decimals), to send a holder's permitted shield in (TacitBlocks.sweepWithPermit), 0 when it names none.
  async function fee() {
    await ready();
    const f = await api('GET', '/fee');
    if (!f.ok) throw new Error('the Tacit chain’s leader did not answer');
    const t = leaderTerms(f);
    if (t.fee === 0n) return { units: 0n, to: null, shieldCap: t.shieldCap, sweepFee: t.sweepFee };
    if (typeof f.address !== 'string') throw new Error('the leader asks a fee but names no address for it');
    return { units: t.fee, to: w.decodeAddress(f.address), shieldCap: t.shieldCap, sweepFee: t.sweepFee };
  }
  /// The fee for a spend about to be proved: none when the leader cannot be reached (such a spend can be posted to Ethereum instead).
  const feeNow = () => fee().catch(() => ({ units: 0n, to: null, shieldCap: null, sweepFee: 0n }));
  /// The plain line for a shield over the leader's cap.
  const overCap = (cap) => {
    const whole = (cap / 10n ** 8n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ','), frac = (cap % 10n ** 8n).toString().padStart(8, '0').replace(/0+$/, '');
    return Object.assign(new Error(`For now the Tacit chain takes up to ${whole}${frac ? '.' + frac : ''} TAC a shield.`), { overCap: true, cap });
  };
  const feeOut = (f, r) => (f.units > 0n ? [{ to: f.to, value: sharesWorth(f.units, r) }] : []);

  /// Up to two notes covering `need`: the fewest, largest first.
  function inputs(need) {
    const ns = owned().sort((a, b) => (BigInt(b.value) > BigInt(a.value) ? 1 : -1));
    if (ns[0] && BigInt(ns[0].value) >= need) return [ns.filter((n) => BigInt(n.value) >= need).pop()];
    if (ns.length >= 2 && BigInt(ns[0].value) + BigInt(ns[1].value) >= need) return ns.slice(0, 2);
    // what is short only waits on a spend the leader holds: its change is spendable once it lands
    if (settling() > 0n && balance() >= need) throw Object.assign(new Error('your last payment is settling: this one can go once it lands, in about a minute'), { settling: true });
    throw new Error(balance() >= need ? 'that amount spans more than two of your chain notes: move part of it first' : 'more than you hold on the tacit chain, with its fees');
  }
  /// The most two notes hold (a spend takes at most two).
  const topTwo = () => owned().map((n) => BigInt(n.value)).sort((a, b) => (b > a ? 1 : -1)).slice(0, 2).reduce((a, b) => a + b, 0n);

  // ── spends kept until they land: { id, kind, units, submission, extra, nullifiers, leaves, deposit?, from?, tx?, forced?, at }
  const pkey = () => `tacit-chain-pending-v1:${cfg.blocks.toLowerCase()}:${lane()}`;
  const kept = () => { try { return JSON.parse(storage?.getItem(pkey()) || '[]'); } catch { return []; } };
  // (an empty list is written as one where a storage has no removeItem, so a spend let go is never read back)
  const keepAll = (list) => { try { if (list.length || !storage?.removeItem) storage?.setItem(pkey(), JSON.stringify(list)); else storage.removeItem(pkey()); } catch {} };
  const idOf = (submission) => strip(hx(sha256(concatBytes(hexBytes(submission.publics), hexBytes(submission.data)))));
  function remember(spent, meta) {
    const id = idOf(spent.submission);
    const list = kept().filter((e) => e.id !== id);
    const old = kept().find((e) => e.id === id);
    const leaves = [5, 6, 7].map((i) => '0x' + strip(spent.submission.publics).slice(64 * i, 64 * i + 64)).filter((l) => l !== ZERO_LEAF);
    const own = (spent.created || []).filter((c) => c.self && BigInt(c.value) > 0n).map((c) => ({ leaf: '0x' + BigInt(c.leaf).toString(16).padStart(64, '0'), value: String(c.value) }));
    const e = { ...old, ...meta, id, submission: spent.submission, nullifiers: spent.nullifiers || [], leaves, ...(own.length || !old?.own ? { own } : {}), at: old?.at ?? Date.now() };
    if (spent.deposit) e.deposit = { shares: String(spent.deposit.shares), amount: String(spent.deposit.amount), cx: spent.deposit.cx, cy: spent.deposit.cy, body: spent.deposit.body };
    list.push(e);
    keepAll(list);
    return e;
  }
  const forget = (id) => keepAll(kept().filter((e) => e.id !== id));
  const mark = (id, meta) => keepAll(kept().map((e) => (e.id === id ? { ...e, ...meta } : e)));
  /// Whether a kept spend is done with: its notes are in the tree (it landed), or a note it spends was spent another way.
  async function settled(e) {
    for (const l of e.leaves || []) if ((await api('GET', `/leaf/${l}`)).ok) return 'landed';
    for (const nf of e.nullifiers || []) if (await leader.spent(nf)) return 'spent';
    return null;
  }
  const keptErr = (err, e) => Object.assign(err, { kept: e });

  /// Hands a spend to the leader and waits for it to land; drops the notes it spends from the wallet's list. The spend is kept until it
  /// lands. onStatus: { status: 'queued' | 'slow' (not landed after `slowMs`: it can be posted to Ethereum) | 'landed', id, kept }. A
  /// refusal, a leader that does not answer or no longer has it, or the timeout throws with `err.kept`.
  async function submit(spent, extra = {}, { onStatus, timeoutMs = 30 * 60e3, slowMs = 10 * 60e3, kind = 'spend', units = null, meta = {} } = {}) {
    const e = remember(spent, { kind, units: units == null ? null : String(units), extra, ...meta });
    let r;
    try { r = await api('POST', '/spend', { ...spent.submission, ...extra }); } catch { throw keptErr(new Error('the Tacit chain’s leader did not answer'), e); }
    if (!r.ok) {
      // a refusal (not a busy or failing leader) frees the notes: a spend kept as queued and refused on being handed over again would hold them
      if (r.status >= 400 && r.status < 500 && r.status !== 429 && r.status !== 408) mark(e.id, { refused: true });
      throw keptErr(new Error(r.error || `the leader refused the spend (${r.status})`), e);
    }
    mark(e.id, { queued: true, refused: false });
    onStatus?.({ id: r.id, status: 'queued', kept: e });
    const t0 = Date.now();
    let slow = false, looked = t0, height = null;
    for (;;) {
      const rc = await api('GET', `/receipt/${r.id}`).catch(() => null);
      if (rc?.ok && rc.status === 'landed') { height = Number.isSafeInteger(rc.height) ? rc.height : null; break; }
      if (rc?.ok && rc.status === 'refused') { mark(e.id, { refused: true }); throw keptErr(new Error(rc.error || 'the leader refused the spend'), e); }
      if (rc && !rc.ok && rc.status === 404) {
        if (await settled(e).catch(() => null)) break;
        throw keptErr(new Error('the leader no longer has this spend'), e);
      }
      // a spend posted to Ethereum meanwhile lands without a receipt from the leader
      if (Date.now() - looked > 30e3) { looked = Date.now(); if (await settled(e).catch(() => null)) break; }
      if (!slow && Date.now() - t0 > slowMs) { slow = true; onStatus?.({ id: r.id, status: 'slow', kept: e }); }
      if (Date.now() - t0 > timeoutMs) throw keptErr(new Error('not landed yet: it stays with the leader, and lands when a block takes it'), e);
      await new Promise((ok) => setTimeout(ok, 4000));
    }
    await scan().catch(() => {});                                   // (its change is read before the spend that makes it is let go)
    if (e.kind === 'hop' && e.commit && e.units) hopsKeep([...hopsKept().filter((h) => strip(h.commit) !== strip(e.commit)), { units: String(e.units), commit: '0x' + strip(e.commit), at: Date.now() }]);
    forget(e.id);
    const gone = new Set((spent.nullifiers || []).map(strip));
    st.notes = st.notes.filter((n) => !gone.has(strip(n.nullifier)));
    save();
    onStatus?.({ id: r.id, status: 'landed', height });
    return { id: r.id, height };
  }

  /// Hands a spend to the leader without waiting for it to land, kept here first: a shield whose deposit is not paid yet is held by the
  /// leader until it is (an inbox it sweeps once paid, with the way back named in `extra.back`). → { id, kept }; a refusal throws with `err.kept`.
  async function offer(spent, extra = {}, { kind = 'spend', units = null, meta = {} } = {}) {
    const e = remember(spent, { kind, units: units == null ? null : String(units), extra, ...meta });
    let r;
    try { r = await api('POST', '/spend', { ...spent.submission, ...extra }); } catch { throw keptErr(new Error('the Tacit chain’s leader did not answer'), e); }
    if (!r.ok) throw keptErr(new Error(r.error || `the leader refused the spend (${r.status})`), e);
    return { id: r.id, kept: e };
  }

  // ── hops that landed and are not yet sent on into the confidential pool (the leader sends them as it lands; anyone may): { units, commit, at }
  const hkey = () => `tacit-chain-hops-v1:${cfg.blocks.toLowerCase()}:${lane()}`;
  const hopsKept = () => { try { return JSON.parse(storage?.getItem(hkey()) || '[]'); } catch { return []; } };
  const hopsKeep = (list) => { try { list.length ? storage?.setItem(hkey(), JSON.stringify(list)) : storage?.removeItem?.(hkey()); } catch {} };
  /// How many landed hops of `units` for `commit` the landing contract holds unsent (TacitBlocks.hops).
  const hopsHeld = async (units, commit) => big(await call('hops(bytes32)', strip(hx(keccak_256(hexBytes(word(units) + strip(commit)))))));

  async function spend(opts) {
    await ready();
    return w.spend(me, { ...opts, leader });
  }
  // ── spends proved and not handed over: { kind, units, meta?, at, spent }. One is good while the notes it spends are this wallet's and free (no other
  // spend took them) and the leader still takes the fee it pays: a leader takes the lowest fee it quoted in its last ten minutes, so eight here.
  // The rate it was priced at only rises, so what it pays the pool and the leader is worth no less when it lands.
  const AHEAD_MS = 8 * 60e3;
  async function preparePay(to, amount, o = {}) {
    await ready();
    const [r, f] = await Promise.all([rate(), feeNow()]);
    const shares = sharesWorth(amount, r), pool = poolShare(r), out = feeOut(f, r);
    const ins = inputs(shares + pool + (out[0]?.value ?? 0n));
    return { kind: 'pay', units: amount, at: Date.now(), spent: await spend({ inputs: ins, outputs: [{ to, value: shares }, ...out], exit: { v: pool, amount: 0n, op: poolOp() }, onProgress: o.onProgress }) };
  }
  async function prepareWithdraw(to, amount, o = {}) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(to)) throw new Error('an Ethereum address');
    await ready();
    const [r, f] = await Promise.all([rate(), feeNow()]);
    const shares = sharesToPay(amount, r), out = feeOut(f, r);
    return { kind: 'withdraw', units: amount, meta: { to }, at: Date.now(), spent: await spend({ inputs: inputs(shares + (out[0]?.value ?? 0n)), outputs: out, exit: { v: shares, amount: BigInt(amount), to }, onProgress: o.onProgress }) };
  }
  const fresh = (p) => !!p?.spent && Date.now() - p.at < AHEAD_MS && (p.spent.nullifiers || []).every((nf) => owned().some((n) => strip(n.nullifier) === strip(nf)));
  const send = (p, o = {}) => submit(p.spent, {}, { ...o, kind: p.kind, units: p.units, ...(p.meta ? { meta: p.meta } : {}) });

  /// The bytes TacitBlocks.force takes for a kept spend's submission, from the leader or another node (`cfg.nodes`): every byte but the
  /// hints is checked to be this spend's (hints a node got wrong only make a block pass the entry over).
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
    ready, scan, balance, rate, fee,
    /// The leader's launch cap on one shield's deposit, in units (null: none, or the leader could not be reached).
    shieldCap: async () => (await feeNow()).shieldCap,
    address: async () => { await ready(); return w.address(me); },
    /// The 32-byte hash a Tacit address's chain lane carries.
    lane: async () => { await ready(); return w.chainAddressHash(w.address(me)); },
    publish: async () => { await ready(); return w.publish(me, leader); },
    resolve: async (hash) => { await ready(); return w.resolve(hash, leader); },
    recipientOf,
    /// Hands a kept spend (from `pending()`) to the leader again, and waits for it to land.
    resubmit: (e, o = {}) => submit({ submission: e.submission, nullifiers: e.nullifiers }, e.extra || {}, { kind: e.kind, units: e.units, ...o }),
    /// What this wallet's notes are worth now, in units: as it will be once the spends the leader holds land.
    worth: async () => worthOf(balance(), await rate()),
    /// Whether a spend the leader holds is still to land (its change not spendable yet).
    settling: () => settling() > 0n || held().length > 0,
    /// What is coming to this wallet in payments the leader holds, before their blocks land (spendable once they do), in units: the notes
    /// GET /pending-notes lists that open with this wallet's key, at the chain's rate. Its own change is not among them (balance counts it);
    /// 0 when nothing comes, or the leader lists none.
    async incoming() {
      return (await incomingNotes()).reduce((t, x) => t + x.units, 0n);
    },
    /// The same, each payment on its own: [{ key, units }], `key` the note's leaf (the same key `has` takes once its block landed and it was
    /// scanned), oldest first. [] when nothing comes, or the leader lists none.
    incomingNotes,
    /// The notes of the wallet's last scan: [{ key (as `incomingNotes` keys them), units (each one's worth at the chain's rate now) }].
    async noteList() {
      await ready();
      const r = await rate();
      return st.notes.map((n) => ({ key: leafKey(n.leaf), units: worthOf(BigInt(n.value), r) }));
    },
    /// Whether the wallet's last scan holds the note of this key (an `incomingNotes` key): its block landed.
    has: (key) => st.notes.some((x) => leafKey(x.leaf) === key),
    /// The spends handed over and not landed, oldest first (those that landed or whose notes went another way are dropped here).
    async pending() {
      await ready();
      const gone = new Set();
      for (const e of kept()) {
        if (!e.deposit && Date.now() - e.at > KEEP_MS) { gone.add(e.id); continue; }
        if (await settled(e).catch(() => null)) gone.add(e.id);
      }
      // (read again: a spend kept, or a mark made, while this was asking is not overwritten)
      const left = kept().filter((e) => !gone.has(e.id));
      if (gone.size) keepAll(left);
      return left;
    },
    forget: async (id) => { await ready(); forget(id); },
    forcePayload,
    /// TacitBlocks.force(payload): from the user's Ethereum account (a shield's from the account that made its deposit).
    forceCalldata: (payload) => {
      const b = strip(payload);
      return '0x' + sel('force(bytes)') + word(32) + word(b.length / 2) + b.padEnd(Math.ceil(b.length / 64) * 64, '0');
    },
    /// Records that a kept spend was posted to Ethereum (its transaction), so it is not offered again.
    posted: async (id, tx) => { await ready(); mark(id, { forced: { tx, at: Date.now() } }); },
    /// How long the chain has to take a posted spend in, in seconds.
    forceDelay: async () => Number(big(await call('FORCE_DELAY()'))),
    /// A shield deposit as the landing contract holds it: { from, at (seconds), forced } (from zero: none, taken in or sent back).
    async depositState(d) {
      await ready();
      const k = hx(keccak_256(hexBytes(assetHex + word(d.shares) + strip(d.cx) + strip(d.cy) + strip(d.body) + word(d.amount))));
      const r = await call('pending(bytes32)', strip(k));
      return { from: '0x' + r.slice(24, 64), at: Number(big(r.slice(64, 128))), forced: Number(big(r.slice(128, 192))) };
    },
    reclaimAfter: async () => Number(big(await call('RECLAIM_AFTER()'))),
    /// TacitBlocks.reclaim: a deposit no block took in, back to whoever made it, from RECLAIM_AFTER on (anyone may send it).
    reclaimCalldata: (d) => '0x' + sel('reclaim(uint256,uint256,bytes32,bytes32,bytes32)') + depWords(d),
    /// TacitBlocks.giveBack: an inbox's deposit no block took in, into the confidential pool for `back`, from RECLAIM_AFTER on.
    giveBackCalldata: (d, back) => '0x' + sel('giveBack(uint256,uint256,bytes32,bytes32,bytes32,bytes32)') + depWords(d) + strip(back),
    /// What a move of `units` costs now and whether the notes cover it: { fee (the leader's, units), holders (units the chain's holders
    /// keep: a payment's pool share, an exit's fee, a shield's margin), arrives (a shield's: what its shares are worth), most (the most
    /// that can move now, in units), first (a payment's or exit's: what the largest note is worth, so what a shield must add for one that
    /// does not fit: a spend takes up to two notes, and a new note pairs with the largest), cap (a shield's: the leader's launch cap on its
    /// deposit, null for none), sweepFee (a shield's: the leader's for sending a permit in, TAC wei) }.
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
    /// A shield of `amount` units: the shares it buys at the chain's rate (with a little margin, which stays with the holders), less the
    /// leader's fee, proven; then pay its deposit (`depositCalldata` after approving TAC, TAC to `inbox(back)`, or a holder's permit for
    /// that inbox), then `submit` ({ back?, permit?, from?, tx? }: from and tx, the deposit's account and transaction, are kept with it).
    async shield(amount, { onProgress } = {}) {
      await ready();
      const [r, f] = await Promise.all([rate(), feeNow()]);
      // the leader drops a shield over its launch cap: refused here, before anything is proved
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
        // what it was proved at: the pool's rate and when, for `shieldFresh` (a shield proved while its form is filled, handed over later)
        rate: r, at: Date.now(), units: BigInt(amount),
        // what the leader takes to send a holder's permit for the inbox in (TAC wei, on top of the deposit): the permit's value is
        // `permitValue`, its `fee` this
        sweepFee: f.sweepFee,
        permitValue: (sweepFee = f.sweepFee) => BigInt(amount) * UNIT + BigInt(sweepFee),
        // what the leader takes, kept until it lands so a hand-over a reload cut off can be made again (`resubmit`)
        submission: s.submission,
        depositCalldata: '0x' + sel('deposit(uint256,uint256,bytes32,bytes32,bytes32)') + args,
        inbox: async (back) => '0x' + (await call('inbox(uint256,uint256,bytes32,bytes32,bytes32,bytes32)', args + strip(back))).slice(24),
        // o.back: a shield paid to its inbox; o.permit: { owner, fee, deadline, v, r, s, back }, a holder's permit for that inbox
        submit: (o = {}) => submit(s, { ...(o.back ? { back: o.back } : {}), ...(o.permit ? { permit: o.permit } : {}) }, { ...o, kind: 'shield', units: amount, meta: { from: o.from, tx: o.tx, back: o.back || o.permit?.back } }),
        // a shield its inbox is to be paid for: kept and handed to the leader before anything is paid, so whatever pays the inbox, the
        // leader can sweep it in and a reload can finish it (o.meta: what goes with it, such as the inbox and what pays it). o.permit: a
        // holder's permit for the inbox ({ owner, fee, deadline, v, r, s, back }), which the leader sends in with sweepWithPermit; it is
        // kept with the spend, so a reload hands it over again.
        offer: (o = {}) => offer(s, { ...(o.back ? { back: o.back } : {}), ...(o.permit ? { permit: o.permit } : {}) }, { kind: 'shield', units: amount, meta: { back: o.back || o.permit?.back, ...(o.meta || {}) } }),
      };
    },
    /// Whether a shield proved ahead can still go for `amount`: the pool's rate is the one it was proved at (a block landing moves it, and a shield
    /// is proved for a share count the deposit must still buy) and it is young; the leader's sweep fee is read again and kept on it.
    async shieldFresh(sh, amount) {
      await ready();
      const [r, f] = await Promise.all([rate(), feeNow()]);
      if (!sh?.rate || sh.units !== BigInt(amount) || r.pool !== sh.rate.pool || r.shares !== sh.rate.shares || Date.now() - sh.at > SHIELD_AHEAD_MS) return false;
      sh.sweepFee = f.sweepFee;
      return true;
    },
    /// An inbox's TAC (in the token's smallest units) and whether it was swept (its sweep leaves code at the address).
    async inboxState(addr) {
      if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) throw new Error('an inbox address');
      const [tac, code] = await Promise.all([call('TAC()'), rpcCall('eth_getCode', [addr, 'latest'])]);
      const held = big(await rpcCall('eth_call', [{ to: '0x' + tac.slice(24), data: '0x70a08231' + strip(addr).padStart(64, '0') }, 'latest']));
      return { held, swept: strip(code).length > 0 };
    },
    /// TacitBlocks.sweep: a paid inbox's TAC taken in as its shield's deposit (anyone may send it; the leader does).
    sweepCalldata: (d, back) => '0x' + sel('sweep(uint256,uint256,bytes32,bytes32,bytes32,bytes32)') + depWords(d) + strip(back),
    /// TacitBlocks.sweepWithPermit: a holder's permit for the inbox sent in (anyone may; the sender takes the permit's fee).
    sweepWithPermitCalldata: (d, p) => '0x' + sel('sweepWithPermit(uint256,uint256,bytes32,bytes32,bytes32,bytes32,address,uint256,uint256,uint8,bytes32,bytes32)') + depWords(d)
      + strip(p.back).padStart(64, '0') + strip(p.owner).padStart(64, '0') + word(p.fee) + word(p.deadline) + word(p.v) + strip(p.r).padStart(64, '0') + strip(p.s).padStart(64, '0'),
    /// Pays `to` notes worth `amount` units, giving the chain's holders their pool share and the leader its fee.
    pay: async (to, amount, o = {}) => send(await preparePay(to, amount, o), o),
    /// Withdraws exactly `amount` units to an Ethereum address (the exit fee and the leader's on top, in shares).
    withdraw: async (to, amount, o = {}) => send(await prepareWithdraw(to, amount, o), o),
    // A payment or withdrawal proved ahead (while its form is filled) and handed over later: `preparePay` / `prepareWithdraw` take what pay and
    // withdraw take and prove it; `fresh(p)` says it can still go; `send(p, o)` hands it over as pay or withdraw would.
    preparePay, prepareWithdraw, fresh, send,
    /// Loads the prover (its wasm and keys, in its worker) ahead of the first proof, so that one waits for nothing but itself.
    warm: async () => { await ready(); const s = await Promise.resolve(system()); await s.ready?.(); },
    /// Exactly `amount` units into the confidential pool as its deposit for `commit` (a fresh one, which the pool's wrap then takes in).
    /// Once it lands it is kept until it is sent on (`hopsWaiting`).
    async hop(commit, amount, o = {}) {
      await ready();
      const [r, f] = await Promise.all([rate(), feeNow()]);
      const shares = sharesToPay(amount, r), out = feeOut(f, r);
      const done = await submit(await spend({ inputs: inputs(shares + (out[0]?.value ?? 0n)), outputs: out, exit: { v: shares, amount: BigInt(amount), op: hopOp(commit) }, onProgress: o.onProgress }), {}, { ...o, kind: 'hop', units: amount, meta: { commit } });
      hopsKeep([...hopsKept().filter((h) => strip(h.commit) !== strip(commit)), { units: String(amount), commit: '0x' + strip(commit), at: Date.now() }]);
      return done;
    },
    /// The hops that landed and the landing contract still holds (not yet sent on into the confidential pool), oldest first; those sent are dropped.
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
    /// TacitBlocks.sendHop: a landed hop sent on into the confidential pool (anyone may send it).
    sendHopCalldata: (units, commit) => '0x' + sel('sendHop(uint256,bytes32)') + word(units) + strip(commit),
    /// What `withdraw` credits an address and has not sent yet, in the token's smallest units; anyone may send it (TacitBlocks.withdraw).
    owed: async (addr) => BigInt('0x' + (await call('owed(address)', strip(addr).padStart(64, '0')))),
    withdrawCalldata: (addr) => '0x' + sel('withdraw(address)') + strip(addr).padStart(64, '0'),
  };
}
