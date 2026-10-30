// The private swap made on the swap card, with the Tacit key opened here. A swap paid from the wallet's ETH through one pool is a deposit swapped in
// one proof: proved ahead while the quote stands, one transaction deposits and settles it; else a wrap kept ready makes the ETH private in one
// transaction and the relay swaps that note; else the deposit goes first and the relay proves the swap in one step. Through two pools the ETH is
// made private first (the tETH page's deposit, which the relay settles) and then that note is swapped in the Tacit pool; one paid from the private balance swaps part of the
// smallest note that covers it, the rest coming back as change in the same proof (notes too small singly are combined first). A swap
// out of the pool (to ETH or a token, at an address) routes the note to tETH and then exits that note, through an exit recipe for a token. The
// relay proves and sends each step. Nothing here is loaded until the first private swap, or the first ask for a private balance; the key is
// held in this visit's memory only.
import { makeKeySession, signInSheet, Cancelled } from '/trade/key.js?cb=88028d84';
import { forgetUx } from '/trade/poolux.js?cb=ac4a1175';
import { wrapEth, wrapFirst, wrapCalldata, settle, relayState, relayStopped, relayWords } from '/teth/wrap.js?cb=7fc9e504';
import { wrapQuote, WRAP_TIP } from '/teth/read.js?cb=42b841c9';
import { secp, keccak_256, sha256, bytesToHex } from '/vendor/tacit-deps.min.js';
import { makeRunner } from '/activity.js?cb=5bc9627f';

export { Cancelled, relayWords };

// A Tacit address, a shielded pubkey or a name (name.wei, .gwei, .eth) as the key a private payment is made to. → { pubHex, name? }; throws with a
// sentence for the person when it is none of them (an Ethereum account address is refused: a private payment needs a Tacit address).
let namesP = null;
const names = () => (namesP ||= import('/confidential-names.js').then(({ makeConfidentialNames, makeMainnetCall }) => makeConfidentialNames({ call: makeMainnetCall(), secp, keccak256: keccak_256 })).catch((e) => { namesP = null; throw e; }));
export async function resolveTacit(raw) {
  const n = await names();
  const local = (s) => {
    try { const d = n.decodeTacitAddress(s); return d.key ? { pubHex: d.key } : { error: 'This Tacit address has no Ethereum-lane key, so it cannot receive a private payment. Ask for their pool address (bp1…) instead.' }; }
    catch (e) { return /^0x0[23][0-9a-fA-F]{64}$/.test(s) ? { pubHex: s } : { error: e.message }; }
  };
  return n.resolveRecipient(String(raw || '').trim(), { local });
}
const API = 'https://api.tacit.finance';
const lc = (s) => String(s || '').toLowerCase();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const floorMiss = (e) => /fee below the current floor/i.test(String(e?.message || ''));
// A step the relay may still finish (it timed out here, or is proved and waits for a sender): its note is not offered again for a while.
const pending = (e) => !!e?.open || /settle timed out|status polling for job|prove timed out|waiting for a sender|settle held/i.test(String(e?.message || ''));
const IN_USE_MS = 20 * 60e3;
// A route's relay fee over two pools is the one-pool fee and 40% more, in two figures, as the quote above prices it.
const twoDigits = (v) => { if (v <= 0n) return 0n; const d = BigInt(String(v).length); if (d <= 2n) return v; const m = 10n ** (d - 2n); return ((v + m - 1n) / m) * m; };
// A swap that stopped after its ETH was made private: the ETH is safe as tETH, and the card offers to swap it from there.
const kept = (msg, cause) => Object.assign(new Error(msg), { kept: true, cause });
const ZERO = '0x0000000000000000000000000000000000000000', ZROUTER = '0x000000000000FB114709235f1ccBFfb925F600e4', E10 = 10n ** 10n;
// How long an exit recipe may run before its escrow's ETH can only be sent on to the address.
const EXIT_TTL = 1800;
const nonce = () => BigInt('0x' + Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('')).toString();

// `getUx()` gives the page's pool module; `pick(list)` chooses among several Ethereum wallets for the key sheet; `onKey(text)` is told when the key opens or is locked (`text` says why).
// A page that holds a Tacit key of its own (the front page) hands it over instead: `session` (unlocked, key, priv()), `openKey(why)` to ask for it
// (resolves once it is open), and `wait(label, ms)` for the relay's jobs to go into the page's own Activity journal.
export function makePrivate({ getUx, pick, onKey = () => {}, session = null, openKey = null, wait = null } = {}) {
  const key = session || makeKeySession({ moved: (why) => { lock(); onKey(why); } });
  let held = null, heldP = null, runner = null, opening = null;
  const busy = new Map();                                     // leaf -> when a step that spends it was sent and may still land
  const free = (n) => !(Date.now() - (busy.get(lc(n.leaf)) || 0) < IN_USE_MS);
  const run = () => (wait ? { wait } : runner ||= makeRunner({ api: API, base: async () => API, pub: () => key.key?.pubHex || null }));

  // what was read under a key: dropped when it locks, or when the page's own key changes
  function reset() { held = null; heldP = null; busy.clear(); }
  function lock() { if (!session) key.lock(); forgetUx(); reset(); }
  // one sheet at a time: a second press while it is open waits for the same one
  function open(why = 'Open your Tacit wallet to swap privately. This page never stores the key.') {
    if (key.unlocked) return Promise.resolve();
    return (opening ||= (openKey ? openKey(why) : signInSheet(key, { pick, why })).then(() => { held = null; onKey(''); }).finally(() => { opening = null; }));
  }

  // What the key holds, by pool asset id: its unspent notes and their sum. Read again after every swap.
  let readFailed = false;                                                             // the last read threw: the page offers another
  function read(force = false) {
    if (!key.unlocked) return Promise.resolve(null);
    if (held && !force) return Promise.resolve(held);
    const pub = key.key.pubHex;
    return (heldP ||= (async () => {
      const t = await getUx(), r = await t.balance(key.priv(), { bridge: false });
      if (key.key?.pubHex !== pub) return null;
      readFailed = false;
      return (held = { pub, at: Date.now(), byAsset: r.byAsset || {}, pending: r.diag?.wrap?.pending || [] });
    })().catch((e) => { readFailed = true; throw e; }).finally(() => { heldP = null; }));
  }
  // What the key holds of an asset, less the notes a step still in flight may spend.
  const of = (id) => { const g = held?.byAsset?.[lc(id)]; const notes = (g?.notes || []).filter(free); return { value: notes.reduce((a, n) => a + BigInt(n.value), 0n), notes }; };
  const byValue = (a, b) => (BigInt(a.value) < BigInt(b.value) ? -1 : BigInt(a.value) > BigInt(b.value) ? 1 : 0);

  // Swaps proved ahead: the wallet's ETH deposited and swapped through one pool in one proof (the pool module's proveWrapSwap), asked of the
  // relay's prover board with no fee bound in. At the press one transaction deposits and settles it (the router's wrapAndSettleETH, the
  // relay's tip on top) if the pool has not traded since: its proof pins the reserves. Two kinds, each a slot keyed by amount, asset and
  // fee tier: the amount the card's quote stands on (`ahead`), at one wrap index kept for whatever is typed, and the sizes kept ready for a
  // pool (`keep`: 0.01 and 0.1 ETH into TAC, say), each at a wrap index of its own kept in this browser, proved as the card shows the pair and
  // proved again at that index once the pool has traded. An index is spent only by the swap that uses it, so recovery from the key meets no
  // run of unused ones. Only while the relay is proving, one proof at a time, and at most AHEAD_MAX a visit.
  const AHEAD_MAX = 12, SLOTS_KEY = 'tacit-swap-slots-v1:', PROOFS_KEY = 'tacit-swap-proofs-v1:';
  const AH = new Map();
  let aheadAsked = 0, typedIndex = null, typedPub = null, proving = Promise.resolve();
  const aheadKey = (wei, toAsset, feeBps) => `${wei}:${lc(toAsset)}:${feeBps}`;
  const slotIdx = (pub) => { try { return JSON.parse(localStorage.getItem(SLOTS_KEY + pub) || '{}') || {}; } catch { return {}; } };
  const slotIdxPut = (pub, k, i) => { try { const m = slotIdx(pub); if (i == null) delete m[k]; else m[k] = i; localStorage.setItem(SLOTS_KEY + pub, JSON.stringify(m)); } catch { } };
  // A kept size's proof is kept in this browser with its index, so a visit later finds it made: it holds while the pool has not traded (its
  // proof pins the reserves) and its deposit has not been made. It carries nothing secret (the note is the key's at that index, its memo opens it).
  const proofsRead = (pub) => { try { return JSON.parse(localStorage.getItem(PROOFS_KEY + pub) || '{}') || {}; } catch { return {}; } };
  const proofPut = (pub, k, v) => { try { const m = proofsRead(pub); if (v == null) delete m[k]; else m[k] = v; localStorage.setItem(PROOFS_KEY + pub, JSON.stringify(m)); } catch { } };
  const packProof = (r) => ({ at: Date.now(), proven: { publicValues: r.proven.publicValues, proof: r.proven.proof, memos: r.proven.memos, jobId: r.proven.jobId || null },
    built: { amount: r.built.amount, commit: r.built.commit, depositId: r.built.depositId, leaf: r.built.leaf, index: r.built.index, pid: r.built.pid, amountOut: String(r.built.amountOut),
      reserveA: String(r.built.reserveA), reserveB: String(r.built.reserveB), wrapArgs: { assetId: r.built.wrapArgs.assetId } } });
  const unpackProof = (x) => ({ proven: x.proven, built: { ...x.built, amountOut: BigInt(x.built.amountOut), reserveA: BigInt(x.built.reserveA), reserveB: BigInt(x.built.reserveB) } });
  // the slot's proof, asked of the board at its index; one asked at a time, so the board's line keeps the ones people pressed ahead of these
  function proveSlot(slot, { wei, toAsset, feeBps }) {
    aheadAsked++;
    slot.r = null;
    const me = slot.p = proving.then(async () => {
      const t = await getUx();
      return t.proveWrapSwap({ walletPriv: key.priv(), toAsset, amountWei: BigInt(wei), feeBps, index: slot.index, ahead: true, waitOpts: { viaRelay: true, timeoutMs: 6 * 60e3, intervalMs: 3000 } });
    }).then((r) => { if (slot.p === me) { slot.r = r; if (r && !slot.typed) proofPut(slot.pub, slot.k, packProof(r)); } return r; }, () => { if (slot.p === me) slot.failed = Date.now(); return null; });
    proving = me.then(() => {}, () => {});
    return me;
  }
  const stale = async (slot) => {
    const res = slot.r && await (await getUx()).poolReserves(slot.r.built.pid).catch(() => null);
    return !res || BigInt(res.reserveA) !== slot.r.built.reserveA || BigInt(res.reserveB) !== slot.r.built.reserveB;
  };
  async function ahead({ wei, toAsset, feeBps }) {
    if (!key.unlocked || !wei || !toAsset) return null;
    if ((await getUx()).relay.ownProving?.()) return null;         // they chose their own prover: nothing is asked of the relay's
    const k = aheadKey(wei, toAsset, feeBps), pub = key.key.pubHex, have = AH.get(k);
    if (have?.pub === pub && !have.failed) return have.p;
    if (aheadAsked >= AHEAD_MAX || !(await relayState())?.proving) return null;
    const t = await getUx();
    if (typedPub !== pub || typedIndex == null) { typedIndex = await t.nextWrapIndex({ walletPriv: key.priv(), ticker: 'cETH' }); typedPub = pub; }
    // the typed amount's index moves to this amount: a proof for the one before is let go
    for (const [x, s] of AH) if (s.typed) AH.delete(x);
    const slot = { k, pub, index: typedIndex, typed: true, r: null };
    AH.set(k, slot);
    return proveSlot(slot, { wei, toAsset, feeBps });
  }
  // The sizes kept ready for a pool, proved (or proved again, the pool having traded) one after the other.
  let keeping = null;
  function keep({ sizes, toAsset, feeBps, onReady = () => {} }) {
    if (!key.unlocked || !toAsset || keeping) return keeping;
    const pub = key.key.pubHex;
    keeping = (async () => {
      if ((await getUx()).relay.ownProving?.() || !(await relayState())?.proving) return;
      const t = await getUx(), idx = slotIdx(pub);
      for (const wei of sizes) {
        const k = aheadKey(wei, toAsset, feeBps);
        if (aheadAsked >= AHEAD_MAX) return;
        let slot = AH.get(k);
        // a proof kept from an earlier visit: used again if its pool has not traded and its deposit was not made, else let go and proved again
        if (!slot) {
          const kept = proofsRead(pub)[k];
          if (kept) {
            const r = unpackProof(kept), s2 = { k, pub, index: kept.built.index, r, p: Promise.resolve(r) };
            const made = wordOf(await t.ethCall(t.cfg.pool, '0x7da9874f' + String(r.built.depositId).replace(/^0x/, '').padStart(64, '0')).catch(() => '0x'));
            if (made === 0n && !(await stale(s2))) { AH.set(k, s2); onReady(); continue; }
            proofPut(pub, k, null);
          }
        }
        if (slot?.pub === pub && !slot.typed && slot.p && !slot.failed && (!slot.r || !(await stale(slot)))) continue;
        let index = idx[k];
        if (index == null) { index = await t.nextWrapIndex({ walletPriv: key.priv(), ticker: 'cETH' }); slotIdxPut(pub, k, index); }
        slot = { k, pub, index, r: null };
        AH.set(k, slot);
        onReady();
        if (await proveSlot(slot, { wei, toAsset, feeBps })) onReady();
      }
    })().catch(() => {}).finally(() => { keeping = null; });
    return keeping;
  }
  // Where the proof made ahead for this swap is: 'ready', 'proving', or null (none asked, or it failed).
  const aheadOf = ({ wei, toAsset, feeBps }) => { const s = AH.get(aheadKey(wei, toAsset, feeBps)); return s && s.pub === key.key?.pubHex && !s.failed ? (s.r ? 'ready' : 'proving') : null; };
  // The proof made ahead for this swap, if it still holds: waited for while the board finishes it, and only while the pool's reserves are the
  // ones it pins and it pays at least the swap's least.
  async function aheadFor(plan, say) {
    const hop = plan.path[0], slot = AH.get(aheadKey(plan.wei, hop.assetNext, hop.feeBps));
    if (!slot || slot.pub !== key.key.pubHex || slot.failed) return null;
    if (!slot.r) { say('ahead'); await Promise.race([slot.p, sleep(75e3)]); }
    const r = slot.r;
    if (!r || await stale(slot) || r.built.amountOut < BigInt(plan.minOut)) return null;
    return Object.assign(r, { slot });
  }
  // A swap out of the private balance proved ahead too (the pool module's routeAhead): the swap the card shows, proved on the board as its
  // quote stands, and posted at the press for the relay to send, which then only sends it. It spends the smallest note that covers the amount
  // (the rest comes back as change in the same proof), so no note is cut first; it pins that note, the reserves of the pools it crosses and the
  // relay's fee, and holds only while all three do. One at a time, and only while the relay is proving and sending.
  const RAH = new Map();
  const rahKey = ({ asset, units, path, fee }, note) => [lc(note.leaf), lc(asset), String(units), String(fee), path.map((h) => `${lc(h.assetNext)}/${h.feeBps}`).join('>')].join(':');
  const rahNote = (plan) => (held ? of(plan.asset).notes.filter((n) => BigInt(n.value) >= BigInt(plan.units)).sort(byValue)[0] || null : null);
  const routeAheadOf = (plan) => { const note = rahNote(plan), s = note && RAH.get(rahKey(plan, note)); return s && s.pub === key.key?.pubHex && !s.failed ? (s.r ? 'ready' : 'proving') : null; };
  async function routeAhead(plan) {
    if (!key.unlocked || plan.wallet || !plan.path?.length) return null;
    const t = await getUx();
    if (t.relay.ownProving?.()) return null;
    await read();
    const note = rahNote(plan);
    if (!note) return null;
    const k = rahKey(plan, note), pub = key.key.pubHex, have = RAH.get(k);
    if (have?.pub === pub && !have.failed) return have.p;
    const rs = await relayState().catch(() => null);
    if (aheadAsked >= AHEAD_MAX || !rs?.proving || !rs?.settling) return null;
    aheadAsked++;
    RAH.clear();                                                                       // the swap shown now: the one before is let go
    const slot = { k, pub, r: null };
    RAH.set(k, slot);
    const me = slot.p = proving.then(() => t.routeAhead({ walletPriv: key.priv(), inNote: note, amountIn: BigInt(plan.units), path: plan.path, minOut: BigInt(plan.minOut), fee: BigInt(plan.fee),
      waitOpts: { timeoutMs: 6 * 60e3, intervalMs: 3000 } })).then((r) => { if (slot.p === me) slot.r = r; return r; }, () => { if (slot.p === me) slot.failed = Date.now(); return null; });
    proving = me.then(() => {}, () => {});
    return me;
  }
  // The proof made ahead for this route of this note, if it still holds: waited for a little while the board finishes it, and used only while
  // the pools' reserves are the ones it pins, it pays at least the swap's least and its fee still clears the relay's floor.
  const sameHops = (a, b) => a.length === b.length && a.every((h, i) => BigInt(h.reserveAPre) === BigInt(b[i].reserveAPre) && BigInt(h.reserveBPre) === BigInt(b[i].reserveBPre));
  async function routeAheadFor({ note, units, path, fee, minOut, ticker }, say) {
    const slot = RAH.get(rahKey({ asset: note.asset, units, path, fee }, note));
    if (!slot || slot.pub !== key.key.pubHex || slot.failed) return null;
    if (!slot.r) { say('ahead'); await Promise.race([slot.p, sleep(75e3)]); }
    const r = slot.r;
    if (!r || r.out < BigInt(minOut)) return null;
    const t = await getUx(), q = await t.quoteRoute({ asset0: note.asset, amountIn: units, path, fee }).catch(() => null);
    if (!q || !sameHops(q.hops, r.hops)) return null;
    const one = BigInt(await t.quoteOpFee(ticker, 'route')), floor = path.length > 1 ? twoDigits((one * 14n) / 10n) : one;
    return BigInt(fee) >= floor ? Object.assign(r, { slot }) : null;
  }
  // The fee tier of the deepest pool between tETH and `toAsset` (the one a kept size is proved in), read once a visit.
  const TIERS = new Map();
  async function tierOf(toAsset) {
    const k = lc(toAsset);
    if (TIERS.has(k)) return TIERS.get(k);
    const t = await getUx(), eth = lc(t.assetByTicker.cETH.assetId), lo = BigInt(eth) < BigInt(k);
    let best = null;
    for (const f of [30, 5, 100, 1]) {
      const r = await t.poolReserves(t.routePoolId(lo ? eth : k, lo ? k : eth, f)).catch(() => null), d = r ? BigInt(lo ? r.reserveA : r.reserveB) : 0n;
      if (d > 0n && (!best || d > best.d)) best = { f, d };
    }
    TIERS.set(k, best?.f ?? null);
    return best?.f ?? null;
  }
  // A slot whose swap went out: its index is spent, and the next swap of that size takes a new one.
  const spent = (slot) => { AH.delete(slot.k); if (slot.typed) typedIndex = null; else { slotIdxPut(slot.pub, slot.k, null); proofPut(slot.pub, slot.k, null); } };
  const wordOf = (h) => { try { return BigInt(String(h).slice(0, 66)); } catch { return 1n; } };
  // A wallet swap through one pool proved by the holder's own prover before anything is deposited: no ahead flag (the relay's board only), no fee bound in.
  async function ownProveSwap(plan, say) {
    const t = await getUx(), hop = plan.path[0], priv = key.priv();
    say('own');
    const index = await t.nextWrapIndex({ walletPriv: priv, ticker: 'cETH' });
    try { return await t.proveWrapSwap({ walletPriv: priv, toAsset: hop.assetNext, amountWei: plan.wei, feeBps: hop.feeBps, index, waitOpts: { timeoutMs: 6 * 60e3, intervalMs: 3000 } }); }
    catch (e) { try { t.releaseWrapIndex?.({ walletPriv: priv, ticker: 'cETH', index }); } catch { } throw e; }
  }
  // A wallet that declined: nothing more is asked of it.
  const declined = (e) => e?.code === 4001 || !!e?.userStopped || /user (rejected|denied)|rejected the request|denied transaction/i.test(String(e?.shortMessage || e?.message || e || ''));
  // One router transaction for a proof made before anything was deposited (a swap proved ahead, or a wrap kept ready): null when the router
  // would refuse it (a pool traded since, a wrap already sent), with nothing sent.
  async function oneTx(ready, { wei, tip, to, from, wallet, say }) {
    try { const r = await wrapFirst({ priv: () => key.priv(), wei, tip, to, from, wallet, say, ux: await getUx(), ready }); return r.already ? null : r; }
    catch (e) { if (declined(e) || !e?.ready || e.sent) throw e; return null; }
  }
  let vouchP = null;
  const vouchers = () => (vouchP ||= import('/wrap-vouchers.js?cb=44d0de15').then((m) => m.makeVouchers()));

  // A note of exactly `units`: one held, or one cut to size by a send to itself (the smallest note that covers it and the relay's fee, else up
  // to 16 notes combined, largest first). The cut's fee comes out of the notes, so the amount swapped is the amount asked.
  async function exactNote({ asset, units, ticker, say }) {
    await read(true);
    const has = of(asset).notes.find((n) => BigInt(n.value) === units);
    if (has) return has;
    const t = await getUx(), fee = BigInt(await t.quoteOpFee(ticker, 'transfer')), need = units + fee, up = [...of(asset).notes].sort(byValue);
    let picked = up.filter((n) => BigInt(n.value) >= need).slice(0, 1), sum = picked.length ? BigInt(picked[0].value) : 0n;
    for (const n of picked.length ? [] : [...up].reverse()) { if (sum >= need || picked.length === 16) break; picked.push(n); sum += BigInt(n.value); }
    if (sum < need) throw Object.assign(new Error('short'), { code: 'short', most: sum > fee ? sum - fee : 0n, fee });
    say(picked.length > 1 ? 'combine' : 'split');
    const before = new Set(of(asset).notes.map((n) => lc(n.leaf)));
    const cut = (f) => t.transfer({ walletPriv: key.priv(), notes: picked, recipientPubHex: t.identity(key.priv()).pubHex, amount: units, fee: f,
      waitOpts: { ...run().wait(picked.length > 1 ? 'Combine notes' : 'Split a note', 15 * 60e3), intervalMs: 4000, viaRelay: true } });
    try {
      try { await cut(fee); }
      catch (e) { const f2 = t.ladderFee(fee * 2n); if (floorMiss(e) && sum >= units + f2) await cut(f2); else throw e; }
    } catch (e) { if (pending(e)) for (const n of picked) busy.set(lc(n.leaf), Date.now()); throw e; }
    for (const n of picked) busy.set(lc(n.leaf), Date.now());
    for (let i = 0; i < 10; i++) {
      await read(true).catch(() => null);
      const n = of(asset).notes.find((x) => BigInt(x.value) === units && !before.has(lc(x.leaf)));
      if (n) return n;
      await sleep(5000);
    }
    throw Object.assign(new Error('Your note was cut to size, but it is not showing yet. Press again in a minute to swap it.'), { said: true });
  }

  // The note a swap spends: the smallest one that covers the amount. A route spends part of a note and returns the rest as change, in the same
  // proof, so no note is cut to size first (a transfer proof of its own, about 50 s, and its relay fee); notes too small singly are combined as before.
  async function coveringNote({ asset, units, ticker, say }) {
    await read(true);
    const big = of(asset).notes.filter((n) => BigInt(n.value) >= units).sort(byValue)[0];
    return big || exactNote({ asset, units, ticker, say });
  }

  // The relay is asked before anything is sent: a swap is a step that expires, so it cannot wait in line while the relay is held.
  async function relayOpen() {
    const rs = await relayState();
    if (relayStopped(rs) || rs?.state === 'held') throw new Error('The relay isn’t taking private swaps right now, so nothing was sent. Try again in a few minutes.');
  }

  // One relayed route of `note`: priced again first (it may have waited a minute for its note), and sent again once at the relay's new floor.
  const price = async (asset, units, path, fee, minOut) => {
    const q = await (await getUx()).quoteRoute({ asset0: asset, amountIn: units, path, fee });
    if (!q || q.amountOut < minOut) throw Object.assign(new Error('The price moved past what was quoted, so the swap was not sent.'), { moved: true });
    return q;
  };
  async function route({ note, units, path, fee, minOut, ticker, label, say }) {
    const t = await getUx();
    const priced = async (f) => {
      const q = await t.quoteRoute({ asset0: note.asset, amountIn: units, path, fee: f });
      if (!q || q.amountOut < minOut) throw Object.assign(new Error('The price moved past what was quoted, so the swap was not sent.'), { moved: true });
      return q;
    };
    let q = await priced(fee);
    const send = (f) => t.route({ walletPriv: key.priv(), inNote: note, amountIn: units, path, minOut, fee: f,
      waitOpts: { ...run().wait(label, 15 * 60e3), intervalMs: 4000, viaRelay: true } });
    let r = null, ahead = null;
    try { ahead = await routeAheadFor({ note, units, path, fee, minOut, ticker }, say); } catch { ahead = null; }
    if (ahead) {
      say('posted');
      try { r = await t.routeAheadSend(ahead, { waitOpts: { ...run().wait(label, 15 * 60e3), intervalMs: 4000, viaRelay: true } }); RAH.delete(ahead.slot.k); q = { amountOut: ahead.out }; }
      catch (e) {
        if (!e?.notPosted) { if (pending(e)) busy.set(lc(note.leaf), Date.now()); throw e; }
        RAH.delete(ahead.slot.k);                                                      // the relay would not take it now (the pool traded): sent the usual way
      }
    }
    if (!r) say('route');
    try {
      if (!r) try { r = await send(fee); }
      catch (e) {
        if (!floorMiss(e)) throw e;
        const one = BigInt(await t.quoteOpFee(ticker, 'route')), now = path.length > 1 ? twoDigits((one * 14n) / 10n) : one, f2 = now > fee ? now : t.ladderFee(fee * 2n);
        q = await priced(f2);
        r = await send(f2);
      }
    } catch (e) { if (pending(e)) busy.set(lc(note.leaf), Date.now()); throw e; }
    busy.set(lc(note.leaf), Date.now());
    held = null;
    return { txHash: r?.txHash || null, out: q.amountOut };
  }

  // The recipe's escrow, as the router itself computes it: the address the unwrap's proof pays.
  async function escrowOf(t, recipe) {
    const r = String(await t.ethCall(t.cfg.router, t.router.escrowAddressForCalldata(recipe))).replace(/^0x/, '');
    const a = '0x' + r.slice(-40);
    if (r.length < 64 || /^0x0{40}$/.test(a)) throw new Error('The exit’s escrow could not be read, so nothing was sent. Try again in a moment.');
    return lc(a);
  }
  // A new note of `asset` worth at least `min`, not among `before`: what a route just made.
  async function newNote(asset, before, min) {
    for (let i = 0; i < 10; i++) {
      await read(true).catch(() => null);
      const n = of(asset).notes.find((x) => !before.has(lc(x.leaf)) && BigInt(x.value) >= min);
      if (n) return n;
      await sleep(5000);
    }
    return null;
  }

  // A tETH note out of the pool to `out.to`: as ETH (an unwrap to the address), or as `out.token` through an exit recipe: an unwrap to the
  // recipe's escrow, whose one call sells exactly the ETH paid to it on zRouter for the token, paid to the address. The relay runs it once the
  // settle lands; past its deadline anyone can send the escrow's ETH on to the address instead (reclaimExit). `out.quote(wei)` prices the sale;
  // `out.min` is the least the quote shown would pay for the `out.wei` it priced, so the floor follows the ETH this note pays; `out.minFee` is
  // the exit's fee floor as the page priced it.
  async function exitNote({ note, out, label, say }) {
    const t = await getUx(), eth = !out.token;
    // the page's quote priced the fee: the settle's floor, and for a token the relay's activation of the swap as well
    let minFee = BigInt(out.minFee);
    for (let attempt = 0; ; attempt++) {
      const { fee, net } = t.quoteUnwrapFee(note.value, 'cETH', { minFee });
      if (net <= 0n) throw new Error('This is too small to leave the pool: the relay’s fee is more than it.');
      const wei = net * E10;
      let recipe = null, to = lc(out.to), sale = null;
      if (!eth) {
        sale = await out.quote(wei);
        if (!sale || sale.amountLimit < (out.min * wei) / out.wei) throw Object.assign(new Error('The price moved past what was quoted, so it did not leave the pool.'), { moved: true });
        recipe = { exitedAsset: note.asset, feeAsset: ZERO, finalRecipient: lc(out.to), deadline: String(Math.floor(Date.now() / 1000) + EXIT_TTL), nonce: nonce(),
          calls: [{ target: ZROUTER, value: wei.toString(), token: ZERO, amount: '0', push: false, data: sale.callData }], sweepTokens: [ZERO], minOuts: ['0'] };
        to = await escrowOf(t, recipe);
      }
      const built = t.buildUnwrap({ note, walletPriv: key.priv(), recipient: to, feeOpts: { minFee } });
      if (BigInt(built.op.fee) !== fee || lc(built.op.recipient) !== to) throw new Error('The exit did not come out as priced, so nothing was sent.');
      say(eth ? 'exit' : 'exitswap');
      const waitOpts = { ...run().wait(label, 15 * 60e3), intervalMs: 4000, viaRelay: true };
      let st, jobId = null;
      try {
        const sub = await t.relay.submitOp({ type: 'unwrap', op: built.op, memos: [], ...(recipe ? { exit: recipe } : {}) }, waitOpts);
        jobId = sub.jobId;
        st = await t.relay.waitForSettle(jobId, waitOpts);
      } catch (e) {
        if (floorMiss(e) && attempt === 0 && !jobId) { minFee = t.ladderFee(minFee * 2n); continue; }
        if (jobId || pending(e)) busy.set(lc(note.leaf), Date.now());
        if (recipe && jobId) e.stuck = { recipe, escrow: to, jobId };
        throw e;
      }
      busy.set(lc(note.leaf), Date.now()); held = null;
      if (eth) return { txHash: st.txHash || null, out: wei, to };
      // the relay sends activateExit once the settle lands: followed here for up to three minutes
      say('activate', st.txHash);
      for (let i = 0; i < 36; i++) {
        const s = await t.relay.status(jobId).catch(() => null);
        if (s?.activation === 'done' && s.activateTx) return { txHash: s.activateTx, settleTx: st.txHash || null, out: sale.amountOut, to: lc(out.to), recipe };
        if (s?.activation === 'failed') throw Object.assign(new Error('The relay did not run the swap.'), { stuck: { recipe, escrow: to, jobId, why: s.activateError || null } });
        await sleep(5000);
      }
      throw Object.assign(new Error('The swap has not run yet.'), { stuck: { recipe, escrow: to, jobId, slow: true } });
    }
  }

  // A swap out of the pool. `plan`: { asset, units, ticker, fee, path (the route to tETH; none when `asset` is tETH), minOut (its least tETH),
  // eth (tETH's pool id), out: { token (none: ETH), to, quote, min, wei, minFee }, label }. A note that has become tETH stays private if the exit stops.
  async function swapOut(plan, { say = () => {} } = {}) {
    await open();
    await relayOpen();
    if (!plan.path?.length) {
      const note = await exactNote({ asset: plan.eth, units: plan.units, ticker: 'cETH', say });
      return exitNote({ note, out: plan.out, label: plan.label, say });
    }
    await price(plan.asset, plan.units, plan.path, plan.fee, plan.minOut);
    const n = await coveringNote({ asset: plan.asset, units: plan.units, ticker: plan.ticker, say });
    const before = new Set((held?.byAsset?.[lc(plan.eth)]?.notes || []).map((x) => lc(x.leaf)));
    const r = await route({ note: n, ...plan, say });
    say('note');
    const tNote = await newNote(plan.eth, before, plan.minOut);
    if (!tNote) throw kept('Swapped privately to tETH, but its note is not showing yet. Press again in a minute to send it on.');
    try { return { ...(await exitNote({ note: tNote, out: plan.out, label: plan.label, say })), routeTx: r.txHash }; }
    catch (e) {
      if (e.stuck || pending(e)) throw e;
      throw kept(`Swapped privately to tETH, but it did not leave the pool: ${e.moved ? 'the price moved past what was quoted.' : relayWords(e)}`, e);
    }
  }
  // What the page sends from a wallet for an exit whose swap did not run: the swap itself, until the recipe's deadline, or the escrow's ETH on to
  // the address after it.
  async function exitCalls(recipe) {
    const t = await getUx();
    return { router: t.cfg.router, activate: t.router.activateExitCalldata(recipe), reclaim: t.router.reclaimExitCalldata(recipe, []) };
  }

  // `plan`: { wallet: true for a swap paid from the wallet's ETH (`wei`), else the pool asset `asset` paid from a note; `units` the amount in
  // the pool's 8 decimals; `path` the route's hops (none: only make the ETH private); `fee` the route's relay fee in what is paid, `ticker`
  // its pool ticker; `minOut` the least it may give, in 8 decimals; `label` the activity journal's name }.
  // `say(step, hash)`: 'prepare' | 'confirm' | 'sent' | 'proving' (the deposit) | 'note' | 'route'.
  async function swap(plan, { wallet, from, say = () => {} }) {
    await open();
    // The holder's own prover (their Succinct credit; a computer's prover takes only ops that can wait) is the last resort the relay's refusal
    // leaves, and the first choice when they turned it on: a wallet swap through one pool is proved with it before anything is deposited.
    const own = !!(await getUx()).relay.ownProving?.();
    let relayDown = false;
    await relayOpen().catch((e) => { if (!own || !plan.wallet || plan.path?.length !== 1) throw e; relayDown = true; });
    // a payment to the key's own address is refused before anything is sent: it would be a swap into the same balance, by a longer way
    if (plan.sendTo && lc(plan.sendTo.pubHex) === lc(key.key.pubHex)) throw new Error('That is your own address. Leave it empty to keep the swap in your private balance.');
    let note = null, before = new Set();
    if (plan.wallet) {
      // priced before the ETH leaves the wallet, so a price already past the quote stops here and not after the deposit
      if (plan.path?.length) await price(plan.asset, plan.units, plan.path, plan.fee, plan.minOut);
      const tq = await wrapQuote(plan.wei), t = await getUx(), outAsset = plan.path?.length ? plan.path[plan.path.length - 1].assetNext : plan.asset;
      if (plan.path?.length === 1) {
        await read(true).catch(() => null);
        before = new Set((held?.byAsset?.[lc(outAsset)]?.notes || []).map((n) => lc(n.leaf)));
        // 0. the holder's own prover, when on: their proof, so no tip; a prover that takes no such op leaves it to the relay's prove-mode
        let r = null, mine = false;
        if (own) {
          r = await ownProveSwap(plan, say).catch(() => null);
          mine = !!r && /^spn:/.test(String(r.proven?.jobId || ''));
        }
        // 1. proved ahead: one transaction, the wrap's tip and the swap's fee paid on top in ETH as the quote showed them
        if (!r && !relayDown) r = await aheadFor(plan, say);
        const one = r && await oneTx(r, { wei: plan.wei, tip: mine ? 0n : tq.tip + BigInt(plan.fee) * E10, to: mine ? null : tq.to, from, wallet, say });
        if (!one && relayDown) throw new Error('The relay isn’t taking private swaps right now and your own prover could not prove this one, so nothing was sent. Try again in a few minutes.');
        if (one) {
          if (r.slot) spent(r.slot);
          held = null;
          const made = { txHash: one.hash, out: r.built.amountOut, one: true };
          return plan.sendTo ? sendOn({ plan, made, before, say }) : made;
        }
      }
      // 2. a wrap of the amount kept ready: one transaction makes the ETH private, and the relay swaps that note
      const vs = await vouchers(), kept1 = key.key ? vs.pick(key.key.pubHex, 'cETH', plan.wei) : null;
      let hash = null, leaf = null;
      if (kept1?.length === 1) {
        const x = kept1[0], c = vs.call(x), w = await oneTx({ built: { ...c.built, leaf: x.leaf }, proven: c.proven }, { wei: plan.wei, tip: tq.tip, to: tq.to, from, wallet, say });
        vs.drop(key.key.pubHex, x.depositId);
        if (w) { hash = w.hash; leaf = x.leaf; }
      }
      // 3. through one pool: the deposit, then the relay proves and settles the swap in one step (a swap that does not settle, the pool having
      // moved while it was proved, is settled as a plain wrap of the same deposit, so the ETH is private tETH to swap from)
      if (!hash && plan.path?.length === 1 && !plan.sendTo) return depositSwap(plan, { t, tq, from, wallet, say });
      if (!hash) {
        // wrapEth throws with `deposit` once the ETH has left the wallet: the page says where it is and how to finish it
        const w = await wrapEth({ priv: () => key.priv(), wei: plan.wei, tip: tq.tip, to: tq.to, from, wallet, say, ux: t });
        hash = w.hash; leaf = w.built.leaf;
      }
      held = null;
      if (!plan.path?.length && !plan.sendTo) return { made: plan.units, txHash: hash };
      say('note');
      for (let i = 0; i < 10 && !note; i++) {
        const h = await read(true).catch(() => null);
        note = h ? of(plan.asset).notes.find((n) => lc(n.leaf) === lc(leaf)) || null : null;
        if (!note) await sleep(5000);
      }
      if (!note) throw kept('Your ETH is private now as tETH, but its note is not showing yet. Press again in a minute to swap it.');
      if (!plan.path?.length) return sendOn({ plan, made: { made: plan.units, txHash: hash }, before, say, direct: note });
    } else {
      await price(plan.asset, plan.units, plan.path, plan.fee, plan.minOut);
      note = await coveringNote({ asset: plan.asset, units: plan.units, ticker: plan.ticker, say });
    }
    // the notes the swap's own asset has now, so the one the route makes is told from them
    const outAsset = plan.path?.length ? plan.path[plan.path.length - 1].assetNext : plan.asset;
    before = new Set((held?.byAsset?.[lc(outAsset)]?.notes || []).map((n) => lc(n.leaf)));
    let made;
    try { made = await route({ note, ...plan, say }); }
    catch (e) {
      if (pending(e)) throw Object.assign(new Error(`${relayWords(e)} Your swap may still go through: check your private balance in a few minutes before swapping again.`), { pending: true, cause: e });
      if (plan.wallet) throw kept(`Your ETH is private now as tETH, but the swap stopped: ${e.moved ? 'the price moved past what was quoted.' : relayWords(e)}`, e);
      throw e;
    }
    return plan.sendTo ? sendOn({ plan, made, before, say }) : made;
  }

  // The deposit swapped by the relay in one proof (its fee, the route's, bound in; the deposit tips it as a wrap's would): one wait for the
  // relay instead of a wrap's and then a swap's.
  async function depositSwap(plan, { t, tq, from, wallet, say }) {
    const hop = plan.path[0], priv = key.priv();
    say('prepare');
    const index = await t.nextWrapIndex({ walletPriv: priv, ticker: 'cETH' });
    let built;
    try { built = await t.buildWrapSwap({ walletPriv: priv, toAsset: hop.assetNext, amountWei: plan.wei, feeBps: hop.feeBps, fee: plan.fee, minOut: plan.minOut, index }); }
    catch (e) {
      try { t.releaseWrapIndex?.({ walletPriv: priv, ticker: 'cETH', index }); } catch { }
      throw /below minOut/.test(String(e?.message)) ? Object.assign(new Error('The price moved past what was quoted, so the swap was not sent.'), { moved: true }) : e;
    }
    say('confirm');
    let hash;
    try { hash = await wallet.sendTx({ to: WRAP_TIP, data: wrapCalldata({ commit: built.commit, wei: plan.wei, to: tq.to }), value: plan.wei + tq.tip, from }); }
    catch (e) { if (declined(e)) { try { t.releaseWrapIndex?.({ walletPriv: priv, ticker: 'cETH', index }); } catch { } } throw e; }
    say('sent', hash);
    const asWrap = () => t.buildWrap({ walletPriv: priv, amountWei: plan.wei, ticker: 'cETH', index });
    let rc;
    try { rc = await wallet.receipt(hash); } catch (e) { throw Object.assign(e, { deposit: { hash, built: asWrap(), landed: false } }); }
    if (rc.status !== '0x1') throw Object.assign(new Error(`The transaction failed (${hash.slice(0, 10)}…). Nothing was lost but its network fee.`), { reverted: true });
    held = null;
    say('swap', hash);
    try {
      const r = await t.submitWrapSwap({ walletPriv: priv, built, waitOpts: { ...run().wait(plan.label, 15 * 60e3), intervalMs: 4000, viaRelay: true } });
      return { txHash: r?.txHash || null, out: built.amountOut };
    } catch (e) {
      if (pending(e)) throw Object.assign(new Error(`${relayWords(e)} Your swap may still go through: check your private balance in a few minutes before swapping again.`), { pending: true, cause: e });
      // not settled: the same deposit settled as a plain wrap, so the ETH is private tETH and the card offers to swap it from there
      await settle({ t, built: asWrap(), hash, say });
      throw kept(`Your ETH is private now as tETH, but the swap stopped: ${/reserve|amm|state/i.test(String(e?.message)) ? 'the pool’s price moved while it was proved.' : relayWords(e)}`, e);
    }
  }

  // What the swap made, sent on to another Tacit address: the note it paid into the balance, locked for the recipient (a stealth payment they claim
  // in their Tacit wallet, or the sender takes back after ninety days), the lock kept in this browser as the front page keeps it. A stop here leaves
  // the swap done: its note is in the balance.
  async function sendOn({ plan, made, before, say, direct = null }) {
    const outAsset = plan.path?.length ? plan.path[plan.path.length - 1].assetNext : plan.asset;
    say('note');
    const note = direct || await newNote(outAsset, before, plan.minOut);
    const stay = (why) => Object.assign(new Error(`Swapped, and it is in your private balance, but it was not sent on: ${why}`), { stayed: true, made });
    if (!note) throw stay('its note is not showing yet. Press again in a minute to send it.');
    const t = await getUx();
    try {
      say('send');
      let built = null;
      const r = await t.stealthSend({ walletPriv: key.priv(), recipientPubHex: plan.sendTo.pubHex, notes: [note], amount: BigInt(note.value), onBuilt: (b) => { built = b; },
        waitOpts: { ...run().wait(`${plan.label} to ${plan.sendTo.name || 'a Tacit address'}`, 15 * 60e3), intervalMs: 4000, viaRelay: true } });
      busy.set(lc(note.leaf), Date.now()); held = null;
      if (built) {
        try {
          const { makeStealthSendStore } = await import('/confidential-secret-store.js');
          await makeStealthSendStore({ sha256 }).add(key.priv(), { lockLeaf: built.lockLeaf, asset: built.asset, ticker: plan.outTicker || plan.ticker, dec: 8, amount: built.amount, deadline: built.deadline,
            lCx: built.lCx, lCy: built.lCy, ownerPub: built.ownerPub, lBlinding: built.lBlinding, refundPriv: built.refundPriv, refundPub: built.refundPub,
            recipientPubHex: built.recipientPubHex, txHash: r?.txHash, createdAt: Date.now(), recipientName: plan.sendTo.name || undefined });
        } catch { /* the take-back scan finds a lock from the key alone */ }
      }
      return { ...made, sent: { to: plan.sendTo.name || null, txHash: r?.txHash || null } };
    } catch (e) {
      if (pending(e)) { busy.set(lc(note.leaf), Date.now()); throw Object.assign(new Error(`${relayWords(e)} It may still go through: check your private balance in a few minutes before sending it again.`), { pending: true, made }); }
      throw stay(relayWords(e));
    }
  }

  // The most a swap from the private balance can spend: one note whole, or what is held less the fee to cut a note to size.
  async function most(asset, ticker) {
    const h = await read();
    if (!h) return null;
    const g = of(asset);
    if (g.notes.length <= 1) return g.value;
    const fee = BigInt(await (await getUx()).quoteOpFee(ticker, 'transfer'));
    return g.value > fee ? g.value - fee : 0n;
  }

  // The key as hex for the private ETH pool's wallet (swap/later.js), opened first if it is not: one key sheet for both kinds of private swap.
  const keyHex = async () => { await open(); return bytesToHex(key.priv()); };

  // A note of `units` of `asset` (cut to size if none is) sent on to a Tacit address, as a private swap's result is: for a swap made elsewhere on
  // the page whose TAC was just made private. → { sent: { to, txHash } }.
  async function sendPrivate({ asset, units, ticker, sendTo, label, say = () => {} }) {
    await open();
    const note = await exactNote({ asset, units: BigInt(units), ticker, say });
    return sendOn({ plan: { path: [], asset, minOut: BigInt(units), sendTo, label, outTicker: ticker }, made: { made: BigInt(units) }, before: null, say, direct: note });
  }

  return {
    open, lock, reset, read, swap, swapOut, exitCalls, of, most, keyHex, sendPrivate, ahead, aheadOf, routeAhead, routeAheadOf, keep, tierOf,
    // the checks a swap makes before anything leaves a wallet, for a page that first sells a token for the ETH it will make private
    relayOpen, priceOk: (asset, units, path, fee, minOut) => (path?.length ? price(asset, units, path, fee, minOut) : Promise.resolve(null)),
    get unlocked() { return key.unlocked; },
    get held() { return held; },
    get readFailed() { return readFailed; },
  };
}
