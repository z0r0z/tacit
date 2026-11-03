// Bringing TAC from the holder's Bitcoin address to Ethereum: what the front page and the bridge page both do to start one. Listing the notes
// that can go, what a check of one says, the one Bitcoin transaction (or the move) that starts it, and the send to one's own address that an
// older note needs first. Every call takes the opened wallet library (`t`, tacit.js) and, where a key signs, the key itself, so neither page's
// state is read here. Pure apart from those calls, so it is tested without a page.

export const TAC_BTC_ID = 'f0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b';
export const noteId = (n) => `${n.txid}:${n.vout}`;

// ── what a check says ──────────────────────────────────────────────────────────────────────────────────────────────────────
const THROUGH = { pool: 'a pool or farm trade on Bitcoin', shielded: 'a move through Bitcoin’s shielded pool', arrived: 'TAC that came over from Ethereum' };
export const through = (s) => (THROUGH[s.through] ? `${THROUGH[s.through]}, which` : 'a transaction');
export const transfers = (n) => `${n.toLocaleString('en-US')} transfer${n === 1 ? '' : 's'}`;
export const longCount = (s) => (s.hops ? `${s.atLeast ? 'more than ' : ''}${transfers(s.hops)}` : `far more than ${transfers(s.max)}`);
export const longReason = (s) => (s.unprovable ? `Its history includes ${through(s)} the bridge does not follow.`
  : `${longCount(s).replace(/^./, (c) => c.toUpperCase())} in its history; the bridge proves up to ${s.max}.`);

// An error as the holder reads it. `errText` is the page's own way of putting any error into words; the ones a bridge raises that need more are said here.
export function bridgeError(e, errText = (x) => String(x?.message || x || '')) {
  const m = String(e?.message || e || '');
  if (/another tab/i.test(m)) return 'This bridge is being moved on in another tab. Wait for it there, or close that tab and try again.';
  if (/held for your other bridges/i.test(m)) return 'This key’s free bitcoin is held for your other bridges’ burns. This one can go once one of them is sent (its change comes back), or add a little bitcoin to go now: your TAC waits where it is.';
  if (/funding utxo too small|no safe funding utxo|insufficient funds for/i.test(m)) return 'This key’s Bitcoin address has no free bitcoin to pay this step’s fee. Add a little bitcoin to it, then try again: your TAC waits where it is.';
  const s = m.replace(/^burndep-ux:\s*/, '');
  return errText(s === m ? e : new Error(s.charAt(0).toUpperCase() + s.slice(1)));
}

// What one step of a note's check (preflight's `steps`) says when it is the one that failed.
export function checkText(s, errText) {
  const err = (x) => bridgeError(x, errText);
  if (s.name === 'not-tracked') return 'This TAC arrived recently: Bitcoin’s proof on Ethereum has not reached its block yet. Try again in a few hours.';
  if (s.name === 'reflected') return 'This TAC was received privately. One Bitcoin transaction sends it to your own address, and then it can be bridged.';
  if (s.name === 'old-leaf') return 'This TAC is held in an older note form that the bridge does not burn directly. One Bitcoin transaction sends it to your own address in the current form, and then it can be bridged.';
  if (s.name === 'bound') return 'This TAC is held in a note bound to another deployment, which the bridge does not burn.';
  if (s.name === 'source-ownership') return 'This TAC is not at this key’s own Bitcoin address.';
  if (s.name === 'source-confirmed') return 'This TAC is waiting for its Bitcoin confirmation.';
  if (s.name === 'trace' && s.tooLong) return `This TAC has ${longCount(s)} in its history, and the bridge proves up to ${s.max}, so it goes to Ethereum by the fast bridge instead.`;
  if (s.name === 'trace' && s.unprovable) return `This TAC’s history includes ${through(s)} the bridge’s proof does not follow${!THROUGH[s.through] && s.at ? ` (${s.at.slice(0, 8)}…${s.at.slice(-6)})` : ''}, so it goes to Ethereum by the fast bridge instead.`;
  if (s.name === 'trace' && s.reading) return `Reading this TAC’s history from Bitcoin: ${transfers(Number(s.read) || 0)} so far. Pick it again in a few minutes and the reading goes on from there.`;
  if (s.name === 'trace') {
    const wait = /retry in ~(\d+)s/.exec(s.detail || '');
    return wait ? `Bitcoin’s history for this TAC is still being read. Pick it again in about ${wait[1]} seconds.`
      : `Could not read this TAC’s history from Bitcoin (${err(s.detail)}). Pick it again in a moment.`;
  }
  return `Could not check this TAC: ${err(s.detail || s.name)}`;
}

// ── the notes ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
// A note in an older form, or received privately, goes to the holder's own address once before it can be bridged.
export const needsSend = (n) => n.form === 'old' || n.form === 'private';
export const firstStep = (n) => (n.form === 'old' ? 'Older note form: pick it to send it to your own address once, then bridge it.'
  : n.form === 'private' ? 'Received privately: pick it to send it to your own address once, then bridge it.' : '');
export const overCap = (n) => !n.eligible && /beta limit/.test(n.reason || '');
// A note whose check said its history is too long for the bridge to prove (`deep`: note id → the step that said so), or that holds no TAC, is not offered.
export const marked = (n, deep = new Map()) => (n.eligible && deep.has(noteId(n)) ? { ...n, eligible: false, reason: longReason(deep.get(noteId(n))) }
  : n.eligible && BigInt(n.amount) === 0n ? { ...n, eligible: false, reason: 'Holds no TAC' } : n);

// The TAC at the holder's Bitcoin address, each with whether it can be bridged and why not: the notes that can go first, the larger first among them.
// `esplora(path)` reads Bitcoin's explorer; a note whose confirmation it cannot read is listed as unconfirmed.
export async function listNotes(t, { force = false, esplora, assetId = TAC_BTC_ID } = {}) {
  const h = await t.scanHoldings(force);
  const tac = h instanceof Map ? [...h.entries()].find(([id, x]) => String(x.assetIdHex || id).toLowerCase() === assetId)?.[1] : null;
  const notes = await Promise.all((tac?.utxos || []).map(async (u) => {
    const st = u.utxo.status?.confirmed ? u.utxo.status : await esplora(`/tx/${u.utxo.txid}/status`).catch(() => null);
    return { txid: u.utxo.txid, vout: u.utxo.vout, sats: u.utxo.value, assetId, amount: u.amount, blinding: u.blinding,
      confirmed: !!st?.confirmed, height: st?.block_height,
      stealth: !!u.stealthTweakedSk, stealthTweakedSk: u.stealthTweakedSk || null };
  }));
  const ux = t.bridgeUx();
  const forms = await ux.noteForms(notes).catch(() => null);
  if (forms) for (const n of notes) n.form = forms.get(noteId(n)) ?? null;
  const tracks = await ux.noteTracking(notes).catch(() => null);
  if (tracks) for (const n of notes) n.tracking = tracks.get(noteId(n)) ?? null;
  return ux.eligibleNotes(notes).sort((a, b) => (b.eligible - a.eligible) || (BigInt(b.amount) > BigInt(a.amount) ? 1 : BigInt(b.amount) < BigInt(a.amount) ? -1 : 0));
}

// ── what it costs ──────────────────────────────────────────────────────────────────────────────────────────────────────────
// The check of a note (preflight): its history read from Bitcoin, which can take minutes, and the rates it was read at. Its price against the coins free
// for fees is a separate step (priceNote), taken afresh each time, since the coins change while a long history is being read.
export async function checkNote(t, { note, walletPub, onProgress = null }) {
  const pf = await t.bridgeUx().preflight({ note, walletPub, onProgress });
  return { note, pf, ok: !!pf.ok };
}
// What a checked note costs against the coins the key has free for fees (`coins`: null when they could not be read). `short`: coins were read and fall short.
export function priceNote(t, { note, pf, coins }) {
  const one = pf.path === 'reflected', rate = one ? pf.burnFeeRate : pf.migrateFeeRate;
  const cost = t.bridgeUx().bridgeCost({ path: pf.path, feeRate: rate, coins: coins || [], noteSats: note.sats, burnRate: pf.burnRate });
  return { note, pf, cost, one, ok: true, short: !!coins && !cost.ok };
}
export const freeCoins = (t) => Promise.resolve().then(async () => t.pickSafeCommitSats(await t.getUtxos(t.wallet.address()))).catch(() => null);
// Both together, with the coins read after the check.
export async function review(t, { note, walletPub, onProgress = null, coins: known }) {
  const c = await checkNote(t, { note, walletPub, onProgress });
  if (!c.ok) return c;
  return priceNote(t, { note, pf: c.pf, coins: known !== undefined ? known : await freeCoins(t) });
}

// The plans a bridge carries, kept beside the journal in `mem` ({ get(k), set(k, v) } over JSON): what the page does for the holder after the start.
export const PLAN_KEY = 'tacit-lite-bridge-plan-v1';
export function planSet(mem, pub, id, plan) {
  const all = mem.get(PLAN_KEY) || {}, mine = { ...(all[pub] || {}) };
  if (plan) mine[id] = plan; else delete mine[id];
  all[pub] = Object.fromEntries(Object.entries(mine).sort((a, b) => (b[1].at || 0) - (a[1].at || 0)).slice(0, 50));
  mem.set(PLAN_KEY, all);
}
// The highest rate the page sends a move's burn at on its own: twice the miner's rate (a tenth over it), and never under 10.
export const burnMaxRate = (pf) => {
  const m = pf.slipstreamRates, base = m ? Math.max(Number(m.effective_rate) || 0, Number(m.submit_fee_rate) || 0, 1) * 1.1 : 10;
  return Math.ceil(Math.max(10, base * 2));
};

// ── starting it ────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Signs and sends the burn (one Bitcoin transaction, when the note is tracked) or the move to the burn address (when it is not), and goes on with it a step.
// `recipient`: pay the minted TAC to someone else's address. Returns the bridge's record.
export async function begin(t, { review: r, priv, recipient = null }) {
  const ux = t.bridgeUx();
  let made;
  if (r.pf.path === 'reflected') made = await ux.startReflected({ note: r.note, walletPriv: priv, feeRate: r.pf.burnFeeRate, ...(recipient ? { recipient } : {}) });
  else {
    const safe = await t.pickSafeCommitSats(await t.getUtxos(t.wallet.address())), u = ux.pickFunding(safe, Math.ceil(r.cost.need * 1.1));
    if (!u) throw new Error('This key’s Bitcoin address has no sats free to pay the fee. Add some, then try again.');
    made = await ux.start({ note: r.note, walletPriv: priv, fundingUtxo: { txid: u.txid, vout: u.vout, value: u.value }, feeRate: r.pf.migrateFeeRate });
  }
  let after;
  try { after = await ux.advance(made.walletPub, made.id); } catch { after = ux.list(made.walletPub).find((x) => x.id === made.id) || made; }
  if (r.pf.path === 'reflected') ux.armMint(made.walletPub, made.id, { walletPriv: priv }).catch(() => {});
  return after;
}

// Notes sent whole (or `amount` of one, the rest coming back) to this key's own address in one Bitcoin transaction: several make one note (a merge),
// and the new note is what gets bridged. `label` names the kind of note in what is said when one is gone.
export async function toSelf(t, assetId, ns, amount = null, label = 'note') {
  const h = await t.scanHoldings(true), have = h.get(assetId)?.utxos || [];
  const us = ns.map((n) => have.find((x) => x.utxo.txid === n.txid && x.utxo.vout === n.vout));
  if (us.some((u) => !u)) throw new Error(`That ${label} is no longer at this address. Refresh, then try again.`);
  const v = amount ?? us.reduce((x, u) => x + BigInt(u.amount), 0n);
  const r = await t.buildAndBroadcastCXfer({ assetIdHex: assetId, amount: v, recipientPubHex: [...t.wallet.pub].map((b) => b.toString(16).padStart(2, '0')).join(''), forceUtxos: us });
  try { t.invalidateHoldingsCache?.(); } catch { /* the next read is fresh enough */ }
  return { txid: r.revealTxid, amount: v };
}

// ── several notes at once (Merge notes, Bridge all) ────────────────────────────────────────────────────────────────────────
export const NO_SATS = 'Not enough BTC for this and its Bitcoin fee.';
export const CHAIN_FULL = 'Bitcoin allows only so many unconfirmed transactions in a chain. The rest can go once these confirm: press again then.';
export const isShort = (e) => /insufficient (plain )?sats|no plain-sats/i.test(String(e?.message));
export const chainFull = (e) => /ancestor-chain limit|too-long-mempool-chain/i.test(String(e?.message));
// What no later step of a run could do better: a shortage of sats, a full chain of unconfirmed transactions, locks that could not be read.
export const halts = (e) => !!e?.halt || isShort(e) || chainFull(e) || /read your locked coins|Tacit wallet changed|Tacit key was locked/i.test(String(e?.message));
export const haltText = (e, errText) => (isShort(e) ? NO_SATS : chainFull(e) ? CHAIN_FULL : bridgeError(e, errText));

// The sends to the key's own address that are waiting to confirm and be seen by Bitcoin's proof, kept beside the journal for 14 days (the front page lists them
// under Getting ready and, for one that asked for it, bridges the note for the holder once it is ready).
export const PREP_KEY = 'tacit-lite-bridge-prep-v1';
export const PREP_DAYS = 14;
export const preps = (mem, pub, now = Date.now()) => (!pub ? [] : (mem.get(PREP_KEY)?.[pub] || []).filter((p) => p?.txid && now - (p.at || 0) < PREP_DAYS * 86400e3));
// The preps to write back after a pass that read them once, worked on them for a while (a note's check can take minutes) and changed some: `current` is the
// list read again now, `mine` the pass's own copies, `started` the ones it bridged. A prep added meanwhile stays, one swept or started goes, and each that
// remains is the pass's copy of it (its height, its notices).
export function prepsAfterPass(current, mine, started) {
  const own = new Map(mine.map((p) => [p.txid, p]));
  return current.filter((p) => !started.has(own.get(p.txid))).map((p) => own.get(p.txid) || p);
}
export function prepAdd(mem, pub, p) {
  const all = mem.get(PREP_KEY) || {}, list = [...preps(mem, pub).filter((x) => x.txid !== p.txid), p];
  all[pub] = list;
  mem.set(PREP_KEY, all);
}

// Notes sent whole to the key's own address in one transaction: several make one note (a merge), and the new note is what gets bridged.
// `label` names the kind of note in what is said when one is gone. `withKey(fn)` runs fn(t) with the key in the wallet library; `plan` (if it asks for the note to be bridged for the holder or made public) is kept with the send.
export async function mergeSend({ withKey, mem, pub, notes, plan = null, now = Date.now, label = 'note' }) {
  const { txid, amount } = await withKey((t) => toSelf(t, TAC_BTC_ID, notes, null, label));
  prepAdd(mem, pub, { txid, amount: String(amount), at: now(), ...(plan && (plan.auto || plan.publicTo) ? { plan } : {}) });
  return { txid, amount, n: notes.length };
}

// One note bridged as the single-note press does it: its own check, then its burn (or its move, with the burn to follow on its own, planned at twice the
// miner's rate). `walletPub` is the key's public key as bytes, `priv()` its private key (read inside the key's turn), `withKey(fn)` as above.
// → { rec } or { why } (in words) when the note did not pass its check or the coins fall short.
export async function startNote(t, { withKey, mem, pub, walletPub, priv, note, publicTo = null, errText }) {
  const c = await checkNote(t, { note, walletPub });
  if (!c.ok) return { why: checkText(c.pf.steps.find((x) => !x.ok) || { name: '' }, errText) };
  const coins = await withKey((k) => freeCoins(k)), r = priceNote(t, { note, pf: c.pf, coins });
  if (coins && r.short) return { why: NO_SATS };
  const rec = await withKey((k) => begin(k, { review: r, priv: priv() }));
  const plan = { at: Date.now(), ...(r.one ? {} : { burn: { maxRate: burnMaxRate(c.pf) } }), ...(publicTo ? { publicTo } : {}) };
  if (plan.burn || plan.publicTo) planSet(mem, pub, rec.id, plan);
  try { await withKey((k) => { k.invalidateHoldingsCache?.(); }); } catch { /* the next read is fresh enough */ }
  return { rec };
}

// A transaction just sent may not yet show its change among the key's free coins: once something has gone in a run, a shortage is looked at again after a
// pause, with the coin list read afresh, before it is called one.
export async function tryAgain({ fn, sentBefore, fresh, sleep }) {
  try { const r = await fn(); if (!(r && r.why === NO_SATS && sentBefore())) return r; }
  catch (e) { if (!isShort(e) || !sentBefore()) throw e; }
  await fresh(); await sleep(5000); await fresh();
  return fn();
}

// What a send of notes to the key's own address costs (a merge is one of these): a confidential transfer, a commit and a reveal, priced by the wallet's
// own estimate (tacit.js buildAndBroadcastCXfer: two dust outputs, the notes' own sats counted against the commit, a sats change), which weighs far more
// than a burn's reveal and adds an input's weight per note. → { fee, need } against `coins` (the key's free coins; none read, none counted).
export function sendCost(t, { rate, coins, noteSats, k }) {
  const DUST = t.DUST ?? 546, reveal = t.feeFor(t.estCXferRevealVb({ m: 2, numAssetIn: k, hasSatsChange: true }), rate);
  let commitValue = 2 * DUST + reveal - noteSats;
  if (commitValue < DUST) commitValue = DUST + reveal;
  const vals = (coins || []).map((c) => Number(c && c.value)).filter((v) => v > 0).sort((a, b) => b - a);
  let total = 0, n = 0, commitFee = t.feeFor(t.estCommitVb(1), rate);
  for (const v of vals) { if (total >= commitValue + commitFee + DUST) break; total += v; n += 1; commitFee = t.feeFor(t.estCommitVb(n), rate); }
  return { fee: commitFee + reveal, need: commitValue + commitFee };
}

// What the transactions of a press cost at today's rate (a burn by the single note's panel's estimate, a merge or a send by sendCost), and whether the key's
// free coins cover them. `bulk`: { merge, all } (bridge-all.js); `coins`: null when they could not be read.
export async function bulkFee(t, { bulk, kind, coins }) {
  const ux = t.bridgeUx(), rate = await ux.quoteRate().catch(() => null);
  if (!rate) return null;
  const sats = (ns) => ns.reduce((s, n) => s + Number(n.sats || 0), 0);
  const burnTx = (ns) => { const c = ux.bridgeCost({ path: 'reflected', feeRate: rate, coins: coins || [], noteSats: sats(ns) }); return { fee: c.fee, need: c.need }; };
  const sendTx = (ns) => sendCost(t, { rate, coins, noteSats: sats(ns), k: ns.length });
  const txs = kind === 'merge' ? bulk.merge.groups.map((g) => sendTx(g.notes))
    : [...bulk.all.burns.map((n) => burnTx([n])), ...bulk.all.sends.map((g) => sendTx(g.notes)), ...bulk.all.privates.map((n) => sendTx([n]))];
  const need = txs.reduce((s, x) => s + x.need, 0), free = (coins || []).reduce((s, c) => s + Math.max(0, Number(c?.value) || 0), 0), burn = burnTx([{ sats: 546 }]).fee;
  // What comes after the first transactions: the burn of each merged or sent note, and for a note the proof does not track its move and its burn.
  let fee = txs.reduce((s, x) => s + x.fee, 0), later = (kind === 'merge' ? bulk.merge.groups.length : bulk.all.sends.length + bulk.all.privates.length) * burn;
  if (kind === 'all') for (const n of bulk.all.checks) { const c = ux.bridgeCost({ path: 'deposit', feeRate: rate, coins: coins || [], noteSats: n.sats, burnRate: rate }); fee += c.fee; later += c.later; }
  return { fee, later, need, free, short: !!coins && free < need, autoMaxFee: Math.max(3000, Math.ceil(burn * 2)) };
}

// Merge notes: each pack of tracked notes is sent to the key's own address in one transaction. → { did: [{ txid, amount, n }], left: [what stopped it, in words] }
export async function runMerge({ groups, merge, tryAgain: again, say = () => {}, errText }) {
  const did = [], left = [];
  for (const [i, g] of groups.entries()) {
    say(`Merging ${g.notes.length} note${g.notes.length === 1 ? '' : 's'} (${i + 1} of ${groups.length})…`);
    try { did.push(await again(() => merge(g.notes), () => did.length > 0)); }
    catch (e) { left.push(halts(e) ? haltText(e, errText) : bridgeError(e, errText)); if (halts(e)) break; }
  }
  return { did, left };
}

// Bridge all (bridge-all.js `all`): the notes that must be sent to the key's own address first (packed, so one send covers many; a note received privately
// on its own), then a burn for each tracked note and a check, one at a time, for each the proof does not track. Stops at what no later step could do better.
// → { did: { burns, sends, sent }, left: [..] }
export async function runAll({ all: a, merge, start, tryAgain: again, say = () => {}, errText, amountText = (n) => String(n.amount) }) {
  const left = [], did = { burns: 0, sends: 0, sent: 0 };
  const sends = [...a.sends, ...a.privates.map((n) => ({ notes: [n] }))], rest = [...a.burns, ...a.checks], total = sends.length + rest.length;
  let at = 0, stop = false;
  for (const g of sends) {
    say(`${g.notes.length > 1 ? `Merging ${g.notes.length} notes` : 'Sending a note to your own address'} (${++at} of ${total})…`);
    try { await again(() => merge(g.notes), () => did.sends + did.burns > 0); did.sends++; did.sent += g.notes.length; }
    catch (e) { left.push(halts(e) ? haltText(e, errText) : bridgeError(e, errText)); if (halts(e)) { stop = true; break; } }
  }
  if (!stop) for (const n of rest) {
    say(`Bridging ${amountText(n)} (${++at} of ${total})…`);
    try {
      const r = await again(() => start(n), () => did.sends + did.burns > 0);
      if (r.rec) did.burns++; else left.push(`${amountText(n)}: ${r.why}`);
    } catch (e) { left.push(`${amountText(n)}: ${halts(e) ? haltText(e, errText) : bridgeError(e, errText)}`); if (halts(e)) break; }
  }
  return { did, left };
}
