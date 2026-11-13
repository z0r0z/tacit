import { makeKeySession, signInSheet, Cancelled } from '/trade/key.js?cb=7149c223';
import { forgetUx } from '/trade/poolux.js?cb=a61d0a42';
import { wrapEth, wrapFirst, wrapCalldata, settle, relayState, relayStopped, relayWords } from '/teth/wrap.js?cb=d850efff';
import { wrapQuote, WRAP_TIP } from '/teth/read.js?cb=7aa845b7';
import { secp, keccak_256, sha256, bytesToHex } from '/vendor/tacit-deps.min.js';
import { makeRunner } from '/activity.js?cb=a0384066';

export { Cancelled, relayWords };

let namesP = null;
const names = () => (namesP ||= import('/confidential-names.js?cb=d41cb8bd').then(({ makeConfidentialNames, makeMainnetCall }) => makeConfidentialNames({ call: makeMainnetCall(), secp, keccak256: keccak_256 })).catch((e) => { namesP = null; throw e; }));
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
const pending = (e) => !!e?.open || /settle timed out|status polling for job|prove timed out|waiting for a sender|settle held/i.test(String(e?.message || ''));
const IN_USE_MS = 20 * 60e3;
const mayGoThrough = (words, cause) => Object.assign(new Error(`${words} Your swap may still go through: check your private balance in a few minutes before swapping again.`), { pending: true, cause });
const twoDigits = (v) => { if (v <= 0n) return 0n; const d = BigInt(String(v).length); if (d <= 2n) return v; const m = 10n ** (d - 2n); return ((v + m - 1n) / m) * m; };
const kept = (msg, cause) => Object.assign(new Error(msg), { kept: true, cause });
const ZERO = '0x0000000000000000000000000000000000000000', ZROUTER = '0x000000000000FB114709235f1ccBFfb925F600e4', E10 = 10n ** 10n;
const EXIT_TTL = 1800;
const nonce = () => BigInt('0x' + Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('')).toString();

export function makePrivate({ getUx, pick, onKey = () => {}, session = null, openKey = null, wait = null, selfSettle = null, here = null, now = Date.now } = {}) {
  const key = session || makeKeySession({ moved: (why) => { lock(); onKey(why); } });
  let held = null, heldP = null, runner = null, opening = null;
  const busy = new Map();
  const free = (n) => !(Date.now() - (busy.get(lc(n.leaf)) || 0) < IN_USE_MS);
  const run = () => (wait ? { wait } : runner ||= makeRunner({ api: API, base: async () => API, pub: () => key.key?.pubHex || null }));

  function reset() { held = null; heldP = null; busy.clear(); }
  function lock() { if (!session) key.lock(); forgetUx(); reset(); }
  function open(why = 'Open your Tacit wallet to swap privately. It stays open in this tab only, until you close it, lock it, or leave the site idle for 30 minutes.') {
    if (key.unlocked) return Promise.resolve();
    return (opening ||= (openKey ? openKey(why) : signInSheet(key, { pick, why })).then(() => { held = null; onKey(''); }).finally(() => { opening = null; }));
  }

  let readFailed = false;
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
  const of = (id) => { const g = held?.byAsset?.[lc(id)]; const notes = (g?.notes || []).filter(free); return { value: notes.reduce((a, n) => a + BigInt(n.value), 0n), notes }; };
  const byValue = (a, b) => (BigInt(a.value) < BigInt(b.value) ? -1 : BigInt(a.value) > BigInt(b.value) ? 1 : 0);

  const AHEAD_MAX = 12, SLOTS_KEY = 'tacit-swap-slots-v1:', PROOFS_KEY = 'tacit-swap-proofs-v1:';
  const AH = new Map();
  let aheadAsked = 0, typedIndex = null, typedPub = null, proving = Promise.resolve();
  const aheadKey = (wei, toAsset, feeBps) => `${wei}:${lc(toAsset)}:${feeBps}`;
  const slotIdx = (pub) => { try { return JSON.parse(localStorage.getItem(SLOTS_KEY + pub) || '{}') || {}; } catch { return {}; } };
  const slotIdxPut = (pub, k, i) => { try { const m = slotIdx(pub); if (i == null) delete m[k]; else m[k] = i; localStorage.setItem(SLOTS_KEY + pub, JSON.stringify(m)); } catch { } };
  const proofsRead = (pub) => { try { return JSON.parse(localStorage.getItem(PROOFS_KEY + pub) || '{}') || {}; } catch { return {}; } };
  const proofPut = (pub, k, v) => { try { const m = proofsRead(pub); if (v == null) delete m[k]; else m[k] = v; localStorage.setItem(PROOFS_KEY + pub, JSON.stringify(m)); } catch { } };
  const packProof = (r) => ({ at: Date.now(), proven: { publicValues: r.proven.publicValues, proof: r.proven.proof, memos: r.proven.memos, jobId: r.proven.jobId || null },
    built: { amount: r.built.amount, commit: r.built.commit, depositId: r.built.depositId, leaf: r.built.leaf, index: r.built.index, pid: r.built.pid, amountOut: String(r.built.amountOut),
      reserveA: String(r.built.reserveA), reserveB: String(r.built.reserveB), wrapArgs: { assetId: r.built.wrapArgs.assetId } } });
  const unpackProof = (x) => ({ proven: x.proven, built: { ...x.built, amountOut: BigInt(x.built.amountOut), reserveA: BigInt(x.built.reserveA), reserveB: BigInt(x.built.reserveB) } });
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
    if ((await getUx()).relay.ownProving?.()) return null;
    const k = aheadKey(wei, toAsset, feeBps), pub = key.key.pubHex, have = AH.get(k);
    if (have?.pub === pub && !have.failed) return have.p;
    if (aheadAsked >= AHEAD_MAX || !(await relayState())?.proving) return null;
    const t = await getUx();
    if (typedPub !== pub || typedIndex == null) { typedIndex = await t.nextWrapIndex({ walletPriv: key.priv(), ticker: 'cETH' }); typedPub = pub; }
    for (const [x, s] of AH) if (s.typed) AH.delete(x);
    const slot = { k, pub, index: typedIndex, typed: true, r: null };
    AH.set(k, slot);
    return proveSlot(slot, { wei, toAsset, feeBps });
  }
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
        if (!slot) {
          const kept = proofsRead(pub)[k];
          if (kept) {
            const r = unpackProof(kept), s2 = { k, pub, index: kept.built.index, r, p: Promise.resolve(r) };
            const made = await t.ethCall(t.cfg.pool, '0x7da9874f' + String(r.built.depositId).replace(/^0x/, '').padStart(64, '0')).then(wordOf, () => null);
            if (made == null) continue;
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
  const aheadOf = ({ wei, toAsset, feeBps }) => { const s = AH.get(aheadKey(wei, toAsset, feeBps)); return s && s.pub === key.key?.pubHex && !s.failed ? (s.r ? 'ready' : 'proving') : null; };
  async function aheadFor(plan, say) {
    const hop = plan.path[0], slot = AH.get(aheadKey(plan.wei, hop.assetNext, hop.feeBps));
    if (!slot || slot.pub !== key.key.pubHex || slot.failed) return null;
    if (!slot.r) { say('ahead'); await Promise.race([slot.p, sleep(75e3)]); }
    const r = slot.r;
    if (!r || await stale(slot) || r.built.amountOut < BigInt(plan.minOut)) return null;
    return Object.assign(r, { slot });
  }
  const RAH = new Map();
  const rahKey = ({ asset, units, path, fee }, note) => [lc(note.leaf), lc(asset), String(units), String(fee), path.map((h) => `${lc(h.assetNext)}/${h.feeBps}`).join('>')].join(':');
  const rahNote = (plan) => (held ? of(plan.asset).notes.filter((n) => BigInt(n.value) >= BigInt(plan.units)).sort(byValue)[0] || null : null);
  const routeAheadOf = (plan) => { const note = rahNote(plan), s = note && RAH.get(rahKey(plan, note)); return s && s.pub === key.key?.pubHex && !s.failed ? (s.r ? 'ready' : 'proving') : null; };
  async function routeAhead(plan) {
    if (!key.unlocked || plan.wallet || !plan.path?.length) return null;
    const t = await getUx();
    if (t.relay.ownProving?.()) return null;
    if (lc(plan.asset) !== lc(t.assetByTicker.cETH.assetId)) return null;
    const gp = await t.rpc('eth_gasPrice', []).then(BigInt, () => null);
    if (!gp || BigInt(plan.fee) * E10 < (600000n * gp * 12n) / 10n) return null;
    await read();
    const note = rahNote(plan);
    if (!note) return null;
    const k = rahKey(plan, note), pub = key.key.pubHex, have = RAH.get(k);
    if (have?.pub === pub && !have.failed) return have.p;
    const rs = await relayState().catch(() => null);
    if (aheadAsked >= AHEAD_MAX || !rs?.proving || !rs?.settling) return null;
    aheadAsked++;
    RAH.clear();
    const slot = { k, pub, r: null };
    RAH.set(k, slot);
    const me = slot.p = proving.then(() => t.routeAhead({ walletPriv: key.priv(), inNote: note, amountIn: BigInt(plan.units), path: plan.path, minOut: BigInt(plan.minOut), fee: BigInt(plan.fee),
      waitOpts: { timeoutMs: 6 * 60e3, intervalMs: 3000 } })).then((r) => { if (slot.p === me) slot.r = r; return r; }, () => { if (slot.p === me) slot.failed = Date.now(); return null; });
    proving = me.then(() => {}, () => {});
    return me;
  }
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
  const spent = (slot) => { AH.delete(slot.k); if (slot.typed) typedIndex = null; else { slotIdxPut(slot.pub, slot.k, null); proofPut(slot.pub, slot.k, null); } };
  const wordOf = (h) => { try { return BigInt(String(h).slice(0, 66)); } catch { return null; } };
  async function ownProveSwap(plan, say) {
    const t = await getUx(), hop = plan.path[0], priv = key.priv();
    say('own');
    const index = await t.nextWrapIndex({ walletPriv: priv, ticker: 'cETH' });
    try { return await t.proveWrapSwap({ walletPriv: priv, toAsset: hop.assetNext, amountWei: plan.wei, feeBps: hop.feeBps, index, waitOpts: { timeoutMs: (HERE ? 40 : 6) * 60e3, intervalMs: 3000 } }); }
    catch (e) { try { t.releaseWrapIndex?.({ walletPriv: priv, ticker: 'cETH', index }); } catch { } throw e; }
  }
  const declined = (e) => e?.code === 4001 || !!e?.userStopped || /user (rejected|denied)|rejected the request|denied transaction/i.test(String(e?.shortMessage || e?.message || e || ''));
  async function oneTx(ready, { wei, tip, to, from, wallet, say, here = false, unsent = null }) {
    try { const r = await wrapFirst({ priv: () => key.priv(), wei, tip, to, from, wallet, say, ux: await getUx(), ready }); return r.already ? null : r; }
    catch (e) {
      if (e?.ready && !e.sent && (declined(e) || e.reverted || e.unsent)) try { unsent?.(); } catch { }
      if (declined(e) || !e?.ready || e.sent) throw e;
      if (here && !(await stale({ r: ready }).catch(() => true))) throw e;
      return null;
    }
  }
  let vouchP = null;
  const vouchers = () => (vouchP ||= import('/wrap-vouchers.js?cb=adaa5fa2').then((m) => m.makeVouchers()));

  async function exactNote({ asset, units, ticker, say }) {
    await read(true);
    const has = of(asset).notes.find((n) => BigInt(n.value) === units);
    if (has) return has;
    const t = await getUx(), fee = HERE ? 0n : BigInt(await t.quoteOpFee(ticker, 'transfer')), need = units + fee, up = [...of(asset).notes].sort(byValue);
    let picked = up.filter((n) => BigInt(n.value) >= need).slice(0, 1), sum = picked.length ? BigInt(picked[0].value) : 0n;
    for (const n of picked.length ? [] : [...up].reverse()) { if (sum >= need || picked.length === 16) break; picked.push(n); sum += BigInt(n.value); }
    if (sum < need) throw Object.assign(new Error('short'), { code: 'short', most: sum > fee ? sum - fee : 0n, fee });
    say(picked.length > 1 ? 'combine' : 'split');
    const before = new Set(of(asset).notes.map((n) => lc(n.leaf)));
    const cut = (f) => t.transfer({ walletPriv: key.priv(), notes: picked, recipientPubHex: t.identity(key.priv()).pubHex, amount: units, fee: f, selfSettle: selfFor(t, picked.length > 1 ? 'Combine notes' : 'Split a note'),
      waitOpts: { ...run().wait(picked.length > 1 ? 'Combine notes' : 'Split a note', 15 * 60e3), intervalMs: 4000, ...relayOnly() } });
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

  async function coveringNote({ asset, units, ticker, say }) {
    await read(true);
    const big = of(asset).notes.filter((n) => BigInt(n.value) >= units).sort(byValue)[0];
    return big || exactNote({ asset, units, ticker, say });
  }

  let stageP = null;
  const stage = async () => (stageP ||= (async () => { const t = await getUx(); const { makeConfidentialStage } = await import('/confidential-stage.js?cb=8dfd1b9f'); return makeConfidentialStage({ ux: t }); })());
  async function stagedSwap(plan, say) {
    const t = await getUx();
    if (plan.path?.length !== 1 || lc(plan.asset) !== lc(t.assetByTicker.cETH.assetId)) return null;
    const h = await read(true);
    if (!h) return null;
    const st = await stage();
    const d = (await st.splitPending(h.pending || [])).staged.find((x) => BigInt(x.value) === BigInt(plan.units));
    if (!d) return null;
    if (!free({ leaf: d.depositId })) throw mayGoThrough('The relay is still working on the last one.');
    say('swap');
    const hop = plan.path[0];
    let r;
    try {
      r = await st.pressSwap({ walletPriv: key.priv(), deposit: { index: d.index, wei: BigInt(d.value) * E10, depositId: d.depositId }, toAsset: hop.assetNext,
        feeBps: Number(hop.feeBps), fee: BigInt(plan.fee), minOut: BigInt(plan.minOut), waitOpts: { ...run().wait(plan.label || 'Swap privately', 15 * 60e3), intervalMs: 4000, viaRelay: true } });
    } catch (e) {
      if (e?.jobId && !/^settle failed/i.test(String(e.message))) { busy.set(lc(d.depositId), Date.now()); throw mayGoThrough(relayWords(e), e); }
      throw e;
    }
    held = null;
    return { txHash: r.txHash || null, out: r.amountOut, staged: true };
  }
  let stagedAt = null, stagedP = null;
  function stagedSizes(onReady = () => {}) {
    if (!held?.pending) return null;
    if (stagedAt?.held === held) return stagedAt.sizes;
    const h = held;
    stagedP ||= stage().then((st) => st.splitPending(h.pending)).then((s) => { stagedAt = { held: h, sizes: s.staged.map((x) => BigInt(x.value)) }; onReady(); }, () => {}).finally(() => { stagedP = null; });
    return stagedAt?.sizes ?? null;
  }
  const NEED = new Map(), NEED_P = new Map();
  function stageNeed(units, onReady = () => {}) {
    const k = String(units), hit = NEED.get(k);
    if (!hit || Date.now() - hit.at > 5 * 60e3) {
      if (!NEED_P.has(k)) NEED_P.set(k, stage().then((st) => (st.stageNeed ? st.stageNeed(units).then((v) => (v == null ? null : BigInt(v))) : undefined)).then((v) => { NEED.set(k, { at: Date.now(), v }); onReady(); }, () => {}).finally(() => NEED_P.delete(k)));
    }
    return hit?.v;
  }
  let staging = null;
  function stageSizes({ sizes, say = () => {}, onStaged = () => {} }) {
    if (!key.unlocked || staging) return staging;
    return (staging = (async () => {
      const t = await getUx(), st = await stage(), eth = t.assetByTicker.cETH.assetId;
      let n = 0;
      for (const units of sizes) {
        let note = null, have = [];
        const need = st.stageNeed ? await st.stageNeed(units).then((v) => (v == null ? null : BigInt(v)), () => null) : null;
        for (let i = 0; i < (n ? 12 : 1) && !note; i++) {
          if (i) await sleep(5000);
          await read(true);
          have = await st.splitPending(held.pending).then((s) => s.staged.map((x) => BigInt(x.value)), () => []);
          if (have.includes(units)) break;
          note = of(eth).notes.filter((x) => BigInt(x.value) > (need ?? units)).sort(byValue)[0] || null;
        }
        if (have.includes(units)) continue;
        if (!note) break;
        say(units);
        busy.set(lc(note.leaf), Date.now());
        await st.stageNote({ note, walletPriv: key.priv(), amountWei: units * E10, waitOpts: { ...run().wait('Keep tETH ready to swap', 30 * 60e3), intervalMs: 4000, viaRelay: true } });
        n++;
        held = null; stagedAt = null;
        onStaged();
      }
      return n;
    })().finally(() => { staging = null; }));
  }
  const isStaging = () => !!staging;
  const BATCH_MAX = 9;
  let own = null;
  const deviceStaging = () => { getUx().then((t) => { own = !!t.relay.ownProving?.(); }, () => {}); return !!own; };
  function stageWhole({ say = () => {}, onStaged = () => {} } = {}) {
    if (!key.unlocked || staging) return staging;
    return (staging = (async () => {
      const t = await getUx();
      if (!t.relay.ownProving?.()) return 0;
      const st = await stage(), eth = t.assetByTicker.cETH.assetId;
      await read(true);
      const all = of(eth).notes.filter(free), notes = all.filter((n) => n.source !== 'wrap').sort(byValue).reverse().slice(0, BATCH_MAX);
      if (!notes.length) { if (all.length) throw Object.assign(new Error('Nothing to keep ready yet: your tETH is still the note your deposit made, and staging it whole would show which deposit it was. Swap or send some of it first.'), { said: true }); return 0; }
      const { makeDeviceProver } = await import('/device-prover.js?cb=2f554eb1');
      const dev = makeDeviceProver({ keccak256: keccak_256 });
      for (const n of notes) busy.set(lc(n.leaf), Date.now());
      say(notes.length);
      await st.stageBatch({ notes, walletPriv: key.priv(), prove: (items) => dev.proveBatch(items), waitOpts: { ...run().wait('Keep tETH ready to swap', 60 * 60e3), intervalMs: 4000, viaRelay: true } });
      held = null; stagedAt = null;
      onStaged();
      return notes.length;
    })().finally(() => { staging = null; }));
  }

  let SELF = false;
  let HERE = false;
  const relayOnly = () => (HERE ? {} : { viaRelay: true });
  const selfFor = (t, label) => (SELF && selfSettle ? selfSettle(t, { label }) : null);
  async function relayOpen() {
    if (HERE) { SELF = true; return; }
    const rs = await relayState();
    SELF = rs?.state === 'held' && !!selfSettle;
    if (relayStopped(rs) || (rs?.state === 'held' && !selfSettle)) throw notNow();
  }
  const notNow = () => Object.assign(new Error('This private swap can’t start right now, so nothing was sent. Try again in a few minutes.'), { notNow: true });
  const heldNow = (e) => !!selfSettle && !SELF && (e?.code === 'relay_held' || /settle held|relay can.t (take|send)/i.test(String(e?.message || '')));

  const price = async (asset, units, path, fee, minOut) => {
    const q = await (await getUx()).quoteRoute({ asset0: asset, amountIn: units, path, fee });
    if (!q || q.amountOut < minOut) throw Object.assign(new Error('The price moved past what was quoted, so the swap was not sent.'), { moved: true });
    return q;
  };
  async function route({ note, units, path, fee, minOut, ticker, label, say }) {
    const t = await getUx();
    if (HERE) fee = 0n;
    const priced = async (f) => {
      const q = await t.quoteRoute({ asset0: note.asset, amountIn: units, path, fee: f });
      if (!q || q.amountOut < minOut) throw Object.assign(new Error('The price moved past what was quoted, so the swap was not sent.'), { moved: true });
      return q;
    };
    let q = await priced(fee);
    const send0 = (f) => t.route({ walletPriv: key.priv(), inNote: note, amountIn: units, path, minOut, fee: f, selfSettle: selfFor(t, label),
      waitOpts: { ...run().wait(label, 15 * 60e3), intervalMs: 4000, ...relayOnly() } });
    const send = async (f) => {
      for (let left = HERE ? 2 : 0; ; left--) {
        try { return await send0(f); }
        catch (e) { if (!e?.stale || left <= 0) throw e; say('again'); q = await priced(f); }
      }
    };
    let r = null, ahead = null;
    if (!SELF) try { ahead = await routeAheadFor({ note, units, path, fee, minOut, ticker }, say); } catch { ahead = null; }
    if (ahead) {
      say('posted');
      try { r = await t.routeAheadSend(ahead, { waitOpts: { ...run().wait(label, 15 * 60e3), intervalMs: 4000, viaRelay: true } }); RAH.delete(ahead.slot.k); q = { amountOut: ahead.out }; }
      catch (e) {
        if (!e?.notPosted) { if (pending(e)) busy.set(lc(note.leaf), Date.now()); throw e; }
        RAH.delete(ahead.slot.k);
      }
    }
    if (!r) say('route');
    try {
      if (!r) try { r = await send(fee); }
      catch (e) {
        if (heldNow(e)) { SELF = true; r = await send(fee); }
        else {
          if (!floorMiss(e)) throw e;
          const one = BigInt(await t.quoteOpFee(ticker, 'route')), now = path.length > 1 ? twoDigits((one * 14n) / 10n) : one, f2 = now > fee ? now : t.ladderFee(fee * 2n);
          q = await priced(f2);
          r = await send(f2);
        }
      }
    } catch (e) { if (pending(e)) busy.set(lc(note.leaf), Date.now()); throw e; }
    busy.set(lc(note.leaf), Date.now());
    held = null;
    return { txHash: r?.txHash || null, out: q.amountOut };
  }

  async function escrowOf(t, recipe) {
    const r = String(await t.ethCall(t.cfg.router, t.router.escrowAddressForCalldata(recipe))).replace(/^0x/, '');
    const a = '0x' + r.slice(-40);
    if (r.length < 64 || /^0x0{40}$/.test(a)) throw new Error('The exit’s escrow could not be read, so nothing was sent. Try again in a moment.');
    return lc(a);
  }
  async function newNote(asset, before, min) {
    for (let i = 0; i < 10; i++) {
      await read(true).catch(() => null);
      const n = of(asset).notes.find((x) => !before.has(lc(x.leaf)) && BigInt(x.value) >= min);
      if (n) return n;
      await sleep(5000);
    }
    return null;
  }

  async function exitNote({ note, out, label, say }) {
    const t = await getUx(), eth = !out.token;
    let minFee = BigInt(out.minFee);
    for (let attempt = 0; ; attempt++) {
      const { fee, net } = t.quoteUnwrapFee(note.value, 'cETH', { minFee });
      if (net <= 0n) throw new Error('This is too small to leave the pool: the relay’s fee is more than it.');
      const wei = net * E10;
      let recipe = null, to = lc(out.to), sale = null;
      if (!eth) {
        sale = await out.quote(wei);
        if (!sale || sale.amountLimit < (out.min * wei) / out.wei) throw Object.assign(new Error('The price moved past what was quoted, so it did not leave the pool.'), { moved: true });
        recipe = { exitedAsset: note.asset, feeAsset: ZERO, finalRecipient: lc(out.to), deadline: String(Math.floor(now() / 1000) + EXIT_TTL), nonce: nonce(),
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

  async function swapOut(plan, { say = () => {} } = {}) {
    await open();
    await relayOpen();
    if (SELF) throw notNow();
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
  async function exitCalls(recipe) {
    const t = await getUx();
    return { router: t.cfg.router, activate: t.router.activateExitCalldata(recipe), reclaim: t.router.reclaimExitCalldata(recipe, []) };
  }

  async function swap(plan, { wallet, from, say = () => {} }) {
    await open();
    const own = !!(await getUx()).relay.ownProving?.();
    let relayDown = HERE;
    if (HERE && plan.sendTo) throw new Error('On this computer a swap stays in your private balance: leave the address empty, then send it after.');
    await relayOpen().catch((e) => { if (!own || !plan.wallet || plan.path?.length !== 1) throw e; relayDown = true; });
    if (plan.sendTo && lc(plan.sendTo.pubHex) === lc(key.key.pubHex)) throw new Error('That is your own address. Leave it empty to keep the swap in your private balance.');
    let note = null, before = new Set();
    if (plan.wallet) {
      if (plan.path?.length) await price(plan.asset, plan.units, plan.path, plan.fee, plan.minOut);
      const tq = await wrapQuote(plan.wei), t = await getUx(), outAsset = plan.path?.length ? plan.path[plan.path.length - 1].assetNext : plan.asset;
      if (plan.path?.length === 1) {
        await read(true).catch(() => null);
        before = new Set((held?.byAsset?.[lc(outAsset)]?.notes || []).map((n) => lc(n.leaf)));
        let r = null, mine = false, one = null;
        for (let i = 0; i < (HERE ? 3 : 1); i++) {
          if (i) say('again');
          let ownR = null;
          if (own) {
            r = ownR = await ownProveSwap(plan, say).catch(() => null);
            mine = !!r && /^spn:/.test(String(r.proven?.jobId || ''));
          }
          if (!r && !relayDown) r = await aheadFor(plan, say);
          const unsent = ownR && Number.isInteger(ownR.built?.index) ? () => t.releaseWrapIndex?.({ walletPriv: key.priv(), ticker: 'cETH', index: ownR.built.index }) : null;
          one = r && await oneTx(r, { wei: plan.wei, tip: mine ? 0n : tq.tip + BigInt(plan.fee) * E10, to: mine ? null : tq.to, from, wallet, say, here: HERE, unsent });
          if (one || !HERE || !r) break;
        }
        if (!one && relayDown) throw new Error('This private swap can’t start right now and your own prover could not prove it, so nothing was sent. Try again in a few minutes.');
        if (one) {
          if (r.slot) spent(r.slot);
          held = null;
          const made = { txHash: one.hash, out: r.built.amountOut, one: true };
          return plan.sendTo ? sendOn({ plan, made, before, say }) : made;
        }
      }
      const vs = await vouchers(), kept1 = key.key ? vs.pick(key.key.pubHex, 'cETH', plan.wei) : null;
      let hash = null, leaf = null;
      if (kept1?.length === 1) {
        const x = kept1[0], c = vs.call(x), w = await oneTx({ built: { ...c.built, leaf: x.leaf }, proven: c.proven }, { wei: plan.wei, tip: tq.tip, to: tq.to, from, wallet, say });
        vs.drop(key.key.pubHex, x.depositId);
        if (w) { hash = w.hash; leaf = x.leaf; }
      }
      if (!hash && SELF) throw notNow();
      if (!hash && plan.path?.length === 1 && !plan.sendTo) return depositSwap(plan, { t, tq, from, wallet, say });
      if (!hash) {
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
      const fast = !plan.sendTo && !HERE && await stagedSwap(plan, say).catch((e) => { if (e?.pending) throw e; return null; });
      if (fast) return fast;
      note = await coveringNote({ asset: plan.asset, units: plan.units, ticker: plan.ticker, say });
    }
    const outAsset = plan.path?.length ? plan.path[plan.path.length - 1].assetNext : plan.asset;
    before = new Set((held?.byAsset?.[lc(outAsset)]?.notes || []).map((n) => lc(n.leaf)));
    let made;
    try { made = await route({ note, ...plan, say }); }
    catch (e) {
      if (pending(e)) throw mayGoThrough(relayWords(e), e);
      if (plan.wallet) throw kept(`Your ETH is private now as tETH, but the swap stopped: ${e.moved ? 'the price moved past what was quoted.' : relayWords(e)}`, e);
      throw e;
    }
    return plan.sendTo ? sendOn({ plan, made, before, say }) : made;
  }

  async function swapHere(plan, o) {
    if (!here || !selfSettle) throw notNow();
    if (!(await here.on())) throw Object.assign(new Error('No prover runs on this computer yet.'), { noProver: true });
    HERE = true;
    try { return await swap(plan, o); } finally { HERE = false; SELF = false; await here.off(); }
  }

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
      if (pending(e)) throw mayGoThrough(relayWords(e), e);
      await settle({ t, built: asWrap(), hash, say });
      throw kept(`Your ETH is private now as tETH, but the swap stopped: ${/reserve|amm|state/i.test(String(e?.message)) ? 'the pool’s price moved while it was proved.' : relayWords(e)}`, e);
    }
  }

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
        } catch { }
      }
      return { ...made, sent: { to: plan.sendTo.name || null, txHash: r?.txHash || null } };
    } catch (e) {
      if (pending(e)) { busy.set(lc(note.leaf), Date.now()); throw Object.assign(new Error(`${relayWords(e)} It may still go through: check your private balance in a few minutes before sending it again.`), { pending: true, made }); }
      throw stay(relayWords(e));
    }
  }

  async function most(asset, ticker) {
    const h = await read();
    if (!h) return null;
    const g = of(asset);
    if (g.notes.length <= 1) return g.value;
    const fee = BigInt(await (await getUx()).quoteOpFee(ticker, 'transfer'));
    return g.value > fee ? g.value - fee : 0n;
  }

  const keyHex = async () => { await open(); return bytesToHex(key.priv()); };

  async function sendPrivate({ asset, units, ticker, sendTo, label, say = () => {} }) {
    await open();
    const note = await exactNote({ asset, units: BigInt(units), ticker, say });
    return sendOn({ plan: { path: [], asset, minOut: BigInt(units), sendTo, label, outTicker: ticker }, made: { made: BigInt(units) }, before: null, say, direct: note });
  }

  return {
    open, lock, reset, read, swap, swapOut, exitCalls, of, most, keyHex, sendPrivate, ahead, aheadOf, routeAhead, routeAheadOf, keep, tierOf, stagedSizes, stageNeed, stageSizes, stageWhole, deviceStaging, isStaging,
    swapHere, get canHere() { return !!here && !!selfSettle; },
    relayOpen, priceOk: (asset, units, path, fee, minOut) => (path?.length ? price(asset, units, path, fee, minOut) : Promise.resolve(null)),
    get unlocked() { return key.unlocked; },
    get held() { return held; },
    get readFailed() { return readFailed; },
  };
}
