// The holder's own positions in the private farms (/rewards/): what each holds and has earned, and from here a harvest (paid as a wTAC note),
// an unbond, an exit (harvest, unbond and the liquidity taken out), the rewards turned into TAC (the relay unwraps each note to the connected
// wallet, which turns the wTAC into TAC), and a join with both sides (each cut to size by the relay if no note fits, then bonded at the pool's
// ratio). Joining with one side (a swap first) and what only an unwrap sent yourself can do are the front page's: they link there.
// Nothing here is loaded until the holder asks: this module, the key and the pool all come in on that press.
// A page that opens the key for something of its own (the farm page's deposits) passes its `session`, so one sign-in serves both: it
// then calls `forget(why)` when the wallet behind the key has moved. `onRead(list)` is told the positions each time they are read.
// `joinAt` is an element the join with both sides is drawn in instead (the farm page's own card, on the farm `choose` names), with what
// it says as it runs; `onAct(name, ok)` is told when an action ends.
import { makeKeySession, signInSheet } from '/trade/key.js?cb=09f263cb';
import { getUx, forgetUx } from '/trade/poolux.js?cb=59d125e5';
import { makeRunner } from '/activity.js';
import { canHarvest, canUnbond, unharvested, locked, harvest, unbond, rewardNotes, relayable, redeem, wtacWithdrawCall, wtacBalanceCall, worthHarvesting, lpNotes, takeOut, HARVEST_WORTH, UNBOND_DUST, bFor, joinTerms, notesOf, exactOf, cutPick, cutSized, bond } from '/farm-ops.js?cb=28af38e1';
import { relayWords } from '/relay-outcome.js?cb=17e48a9a';
import { esc, wordAt, parseUnits, rpc } from '/trade/util.js?cb=1d2cd8d3';

const API = 'https://api.tacit.finance';
const day = (sec) => new Date(sec * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const tacTxt = (wei) => (Number(wei) / 1e18).toLocaleString('en-US', { maximumFractionDigits: 4 });
const noteTxt = (units) => (Number(units) / 1e8).toLocaleString('en-US', { maximumFractionDigits: 4 });
const tkName = (tk) => (tk === 'cETH' ? 'tETH' : tk);
const units8 = (v) => (Number(v) / 1e8).toLocaleString('en-US', { maximumFractionDigits: 8 });
const noteKey = (n) => String(n.leaf || n.nullifier || `${n.cx}:${n.cy}`).toLowerCase();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const QUOTE_FRESH = 30e3;                                                            // how long a pool's terms are used before they are read again
const MULTICALL3 = '0xca11bde05977b3631167028862be2a173976ca11';
// the chain's clock, read with the positions: whether a bond is over goes by it, not by this device's
const chainNow = async (ux) => ({ at: Date.now(), t: Number(wordAt(await ux.ethCall(MULTICALL3, '0x0f28c97d'), 0)) });

export function mountFarms(root, { pick, names = () => new Map(), pair = () => '', program = () => null, wallet = null, W = null, connect = null, session = null, onRead = () => {}, joinAt = null, onAct = () => {} } = {}) {
  let D = null, seq = 0, runner = null, wanted = null;
  const jr = joinAt || root;                                                           // where the join's form and fields are
  let lockedWhy = '';                                                                  // why the key was locked, when the wallet that opened it moved
  const now = () => (D?.clock ? D.clock.t + (Date.now() - D.clock.at) / 1000 : undefined);   // the chain's time, carried on from its read
  const key = session || makeKeySession({ moved: (why) => forget(why || '') });
  const run = () => (runner ||= makeRunner({ api: API, base: async () => (await import('/confidential-deployments.js')).getConfidentialDeployment('mainnet')?.relayBase || API, pub: () => key.key?.pubHex || null }));
  const settled = (r) => { if (r?.jobId) run().journal.put('job:' + r.jobId, { status: 'settled', hash: r.txHash || undefined }); };
  function forget(why = null) { if (typeof why === 'string') lockedWhy = why; key.lock(); forgetUx(); seq++; D = null; paint(); }

  // The key a flow starts under. Each step of the flow asks for it again, so a key locked or changed meanwhile stops the flow before its next
  // step, and each step is given its own copy.
  function pinned() {
    const pub = key.key.pubHex;
    return () => {
      if (!key.unlocked || key.key.pubHex !== pub) throw new Error('Your Tacit wallet was locked or changed, so this stopped before its next step. Nothing further was sent.');
      return key.priv();
    };
  }

  async function read() {
    if (!key.unlocked) return paint();
    lockedWhy = '';
    const pub = key.key.pubHex, my = ++seq, priv = key.priv(), was = D?.pub === pub ? D : null;
    D = { pub, loading: !was, ...(was ? { ...was } : {}) }; paint();
    try {
      const ux = await getUx(), [list, bal, wt, clock] = await Promise.all([ux.farmPositions({ walletPriv: priv }), ux.balance(priv).catch(() => null), walletWtac(ux), chainNow(ux).catch(() => null)]);
      if (my !== seq || key.key?.pubHex !== pub) return;
      const cur = D?.pub === pub ? D : null;                                         // what was typed, said or started while this was read is kept
      D = { pub, list: Array.isArray(list) ? list : [], notes: bal?.notes || [], notesOk: !!bal, wtac: wt, clock: clock || cur?.clock || null, said: cur?.said || null, sayAt: cur?.sayAt || null, form: cur?.form || wanted || {}, terms: cur?.terms || {}, busy: cur?.busy || null };
      try { onRead(D.list); } catch { /* the page's own note of them */ }
    } catch (e) { if (my === seq) D = { pub, err: String(e?.message || e).slice(0, 160) }; }
    paint();
  }

  function say(text, kind = '') { if (D) { D.said = { text, kind }; paint(); } }
  // what a failure says: the relay's words when it was the relay, else the message (a position that cannot be unbonded yet says what to do)
  function failure(e) {
    const w = relayWords(e), m = String(e?.message || e);
    if (w) return [w.text, w.front ? 'front' : 'err'];
    if (/locked until/.test(m)) return ['The bond is not over yet.', 'err'];
    if (/farm-unbond: \d+ reward units/.test(m)) return ['It has earned a reward that unbonding would give up. Harvest it first, or press Exit, which harvests what is worth it and gives up what it earns while it runs.', 'err'];
    return [m.slice(0, 240), e?.front ? 'front' : 'err'];
  }
  async function act(name, fn) {
    if (!D || D.busy) return;
    const mine = D;
    let done = false;
    mine.busy = name; mine.sayAt = name === 'join' && joinAt ? 'join' : null; say('');
    try { const text = await fn(); done = true; if (D?.pub === mine.pub) say(text, 'ok'); }
    catch (e) { if (D?.pub === mine.pub) { const [text, kind] = failure(e); say(text, kind); } }
    // whatever it came to, the positions are read again: a step that went through before a later one failed shows as it is
    finally { if (D?.pub === mine.pub) D.busy = null; if (key.unlocked) read(); try { onAct(name, done); } catch { /* the page's own */ } }
  }
  const walletWtac = async (ux) => (W?.account ? wordAt(await ux.ethCall(wtacBalanceCall(W.account).to, wtacBalanceCall(W.account).data).catch(() => '0x'), 0) : 0n);
  const name = (pos) => names().get(Number(pos.pid)) || `Farm ${pos.pid}`;

  async function doHarvest(i) {
    const pos = D.list[i];
    if (!pos || !canHarvest(pos)) throw new Error('Nothing to harvest yet.');
    const priv = pinned(), t = await getUx(), label = 'Harvest farm rewards';
    say('The relay is proving your harvest…');
    settled(await harvest(t, priv(), pos, run().wait(label, 15 * 60e3)));
    return 'Harvested to a wTAC note, one for one with TAC.';
  }
  async function doUnbond(i) {
    const pos = D.list[i];
    if (!pos) throw new Error('That position is not listed any more. Read again.');
    if (locked(pos, now())) throw new Error(`The bond is over on ${day(Number(pos.unlockAt))}.`);
    if (unharvested(pos)) throw new Error('Harvest first: unbonding now would give up what it has earned.');
    const priv = pinned(), t = await getUx(), label = 'Unbond from a farm';
    say('The relay is proving your unbond…');
    settled(await unbond(t, priv(), pos, run().wait(label, 15 * 60e3)));
    return 'Unbonded. Your liquidity is a private note again.';
  }

  // The rewards, turned into TAC: each note the relay can unwrap for something goes to the connected wallet as wTAC, and the wallet turns all
  // its wTAC into TAC. A note worth less than the relay's fee is left, for the front page, which can send the unwrap from the Tacit account.
  async function toTac() {
    const prog = program(), rid = prog?.rewardAsset, notes = rewardNotes(D.notes, rid);
    if (!wallet || !W) throw Object.assign(new Error('Turning rewards into TAC needs a wallet.'), { front: true });
    if (!W.account) await connect();
    const to = W.account;
    if (!to) throw new Error('Connect a wallet to receive the TAC.');
    const priv = pinned(), t = await getUx(), mine = notes.filter((n) => relayable(t, n, rid)), small = notes.length - mine.length;
    if (!mine.length && !(D.wtac > 0n)) throw Object.assign(new Error(notes.length ? 'Your rewards are each worth less than the relay charges to unwrap them.' : 'Nothing to turn into TAC yet.'), { front: notes.length > 0 });
    const J = run().journal;
    // a turn into TAC sent before and not confirmed when its wait ran out is looked up first: one a node still holds is waited for, not sent
    // again, and one no node holds is let go only after a quarter of an hour (a node asked may not have seen one still going round)
    const earlier = J.state.items.find((x) => x.kind === 'tx' && x.status === 'pending' && /^tx:1:/.test(x.id) && /^Turn .* into TAC$/.test(x.label || '') && (!x.to || x.to.toLowerCase() === to.toLowerCase()));
    if (earlier) {
      const rc = await rpc('eth_getTransactionReceipt', [earlier.hash]).catch(() => null);
      if (rc) J.put(earlier.id, rc.status === '0x1' ? { status: 'confirmed' } : { status: 'failed', err: 'The transaction reverted.' });
      else if ((await rpc('eth_getTransactionByHash', [earlier.hash]).catch(() => true)) !== null || Date.now() - earlier.at < 15 * 60e3) throw new Error('An earlier turn into TAC is not confirmed yet. Wait for it, or speed it up or cancel it in your wallet, before pressing again.');
      else J.put(earlier.id, { status: 'stale' });
    }
    for (const [i, n] of mine.entries()) {
      say(`The relay is unwrapping your rewards${mine.length > 1 ? ` (${i + 1} of ${mine.length})` : ''}…`);
      settled(await redeem(t, priv(), n, to, run().wait(`Unwrap ${noteTxt(n.value)} wTAC of farm rewards`, 15 * 60e3)));
    }
    const balOf = async () => wordAt(await t.ethCall(wtacBalanceCall(to).to, wtacBalanceCall(to).data), 0);
    let bal = await balOf();
    for (let i = 0; !bal && mine.length && i < 10; i++) { await sleep(3000); bal = await balOf(); }
    if (!bal) throw new Error('The unwrap landed, but the wTAC is not visible yet. Press again in a minute: it picks up from here.');
    if (W.account?.toLowerCase() !== to.toLowerCase()) throw new Error('Your wallet account changed while this ran. Switch back to the account that holds the wTAC and press again.');
    priv();                                                                          // the key is still the one this started under
    say('Confirm turning the wTAC into TAC in your wallet…');
    const hash = await wallet.sendTx({ ...wtacWithdrawCall(bal, to), from: to }), id = `tx:1:${String(hash).toLowerCase()}`;
    J.put(id, { kind: 'tx', label: `Turn ${tacTxt(bal)} wTAC into TAC`, chain: 1, hash, to, status: 'pending' });
    const rc = await wallet.receipt(hash);
    J.put(id, rc?.status === '0x1' ? { status: 'confirmed' } : { status: 'failed', err: 'The transaction reverted.' });
    if (rc?.status !== '0x1') throw new Error('Turning the wTAC into TAC did not go through. The wTAC is in your wallet: press again.');
    return `Turned ${tacTxt(bal)} wTAC into TAC, in your wallet.${small ? ` ${small} smaller reward${small === 1 ? ' is' : 's are'} worth less than the relay’s fee to unwrap: the front page can send ${small === 1 ? 'it' : 'them'} from this key’s address.` : ''}`;
  }

  // Out of a farm: the reward harvested if it is worth it through the relay, the position unbonded (giving up what it earned since the harvest,
  // as the front page's Exit does: the farm pays every second and a harvest takes minutes to prove), and the liquidity it gives back taken out
  // as the pool's two assets. A reward worth having that only an unwrap sent yourself would turn is not given up: that exit is the front page's.
  async function exit(i) {
    const pos = D.list[i], prog = program(), pool = (prog?.pools || []).find((p) => Number(p.pid) === Number(pos?.pid));
    if (!pos) throw new Error('That position is not listed any more. Read again.');
    if (!pool?.reserves) throw new Error('The farm’s pool could not be read. Try again in a moment.');
    if (locked(pos, now())) throw new Error(`The bond is over on ${day(Number(pos.unlockAt))}.`);
    const priv = pinned(), t = await getUx(), rid = prog.rewardAsset, pending = BigInt(pos.pendingUnits || 0);
    const worth = worthHarvesting(t, pending, rid);
    if (pending > HARVEST_WORTH && !worth) throw Object.assign(new Error('Its reward is worth turning into TAC only by sending the unwrap yourself.'), { front: true });
    const n = worth ? 3 : 2;
    let k = 0;
    if (worth) { say(`Step ${++k} of ${n} · the relay is proving your harvest…`); settled(await harvest(t, priv(), pos, run().wait('Harvest farm rewards', 15 * 60e3))); }
    const lpOf = async () => lpNotes((await t.balance(priv())).notes, pool);
    const had = new Set((await lpOf()).map(noteKey));
    say(`Step ${++k} of ${n} · the relay is proving your unbond…`);
    const [cur] = (await t.farmPositions({ walletPriv: priv() })).filter((p) => p.receiptLeaf === pos.receiptLeaf);
    const given = BigInt(cur?.pendingUnits || 0);
    settled(await unbond(t, priv(), cur || pos, run().wait('Unbond from a farm', 15 * 60e3), undefined, { forfeit: true }));
    let fresh = [];
    for (let j = 0; !fresh.length && j < 8; j++) { fresh = (await lpOf()).filter((x) => !had.has(noteKey(x))); if (!fresh.length) await sleep(5000); }
    if (!fresh.length) throw new Error('Unbonded. The liquidity note is not showing yet: Read again in a minute and take it out from the front page.');
    for (const [j, note] of fresh.entries()) {
      say(`Step ${n} of ${n} · the relay is taking your liquidity out${fresh.length > 1 ? ` (${j + 1} of ${fresh.length})` : ''}…`);
      try { settled(await takeOut(t, priv(), pool, note, run().wait(`Take out ${name(pos)} liquidity`, 15 * 60e3))); }
      catch (e) { if (/not covered by this withdrawal/.test(String(e?.message || ''))) throw Object.assign(new Error('Unbonded. This liquidity is worth less than the relay’s fee to take it out.'), { front: true }); throw e; }
    }
    return `Out. Your liquidity is back as private ${name(pos)} notes.${given > UNBOND_DUST ? ` The ${noteTxt(given)} TAC it earned while this ran was given up.` : ''}`;
  }

  // ── joining ──
  // the farms open to join, and the one picked
  const openFarms = () => (program()?.pools || []).filter((p) => p.reserves?.assetA && Number(p.tacPerDayForPool) > 0);
  const chosen = () => { const fs = openFarms(), pid = String(D?.form?.pool ?? fs[0]?.pid); return fs.find((p) => String(p.pid) === pid) || fs[0] || null; };
  // The pool's terms, kept for QUOTE_FRESH while the form is in use: what the form quotes is what a press is held to.
  async function terms(pool, fresh = false) {
    const t = await getUx(), k = String(pool.pid), j = D?.terms?.[k];
    if (!fresh && j && Date.now() - j.at < QUOTE_FRESH) return j;
    const v = { ...(await joinTerms(t, pool)), at: Date.now(), tkA: tkName(t.poolTickerOf(String(pool.reserves.assetA).toLowerCase())), tkB: tkName(t.poolTickerOf(String(pool.reserves.assetB).toLowerCase())) };
    if (D) (D.terms ||= {})[k] = v;
    return v;
  }
  // The join as the notes held and the pool stand: the second side, the notes that fit, the notes to cut and what the cuts cost the relay.
  function plan(pool, tm, a, notes) {
    const { assetA, assetB } = pool.reserves, b = bFor(a, tm.res), nsA = notesOf(notes, assetA), nsB = notesOf(notes, assetB), nA = exactOf(nsA, a), nB = exactOf(nsB, b);
    const fA = nA ? 0n : tm.feeA, fB = nB ? 0n : tm.feeB, pA = nA ? null : cutPick(nsA, a, fA), pB = nB ? null : cutPick(nsB, b, fB);
    const cutFee = fA + (fB ? (fB * BigInt(tm.res.reserveA)) / BigInt(tm.res.reserveB) : 0n);          // in the first side's units
    return { a, b, nA, nB, pA, pB, fA, fB, cutFee, short: !nA && !pA ? 'A' : !nB && !pB ? 'B' : null, dear: cutFee * 20n >= 2n * a, pct: Number((cutFee * 1000n) / (2n * a)) / 10 };
  }
  // what the form shows under the amount: the second side, what splitting notes costs, and what is wrong with it
  function joinInfo(pool, tm, a) {
    if (!tm) return '<p class="more">Reading the pool…</p>';
    if (!a) return '';
    const p = plan(pool, tm, a, D.notes);
    let h = `<dl class="kv"><div><dt>${esc(tm.tkB)}, at the pool’s ratio</dt><dd class="num" id="pf-b">${esc(units8(p.b))}</dd></div>`;
    if (p.fA || p.fB) h += `<div><dt>Relay fee to split your notes</dt><dd class="num">${esc([p.fA ? `${units8(p.fA)} ${tm.tkA}` : '', p.fB ? `${units8(p.fB)} ${tm.tkB}` : ''].filter(Boolean).join(' + '))}</dd></div>`;
    h += '</dl>';
    if (D.notesOk) {
      if (p.short === 'A') h += `<p class="more err">Your private ${esc(tm.tkA)} does not cover ${esc(units8(a))} and the relay’s fee to split a note.</p>`;
      else if (p.short === 'B') h += `<p class="more err">This needs ${esc(units8(p.b))} ${esc(tm.tkB)} at the pool’s ratio, and your private ${esc(tm.tkB)} does not cover it and the relay’s fee to split a note.</p>`;
      else if (p.dear) h += `<p class="more">The relay’s fees to split your notes are ${esc(p.pct.toFixed(1))}% of this deposit: a larger one, or notes that are already this size, spreads them.</p>`;
    }
    return h;
  }
  // a note of exactly `amount` of `asset`, once the cut that makes it shows in the balance
  async function noteShows(t, priv, asset, amount) {
    for (let i = 0; i < 8; i++) { const n = exactOf(notesOf((await t.balance(priv())).notes, asset), amount); if (n) return n; await sleep(5000); }
    throw new Error('The note cut for this is not showing yet. It is in your private balance: press again in a minute.');
  }
  // Into a farm with both sides: `a` of the first and the second at the pool's ratio, each a note of exactly that (the relay cuts one to size
  // when none fits), then both added to the pool and the share bonded in the farm in one proof. What the form quoted is what a press is held to:
  // a pool that moved since adds nothing, and so does one that moves while the notes are cut (the notes are then ready for the next press).
  async function join() {
    const prog = program(), pool = chosen(), a = parseUnits(D.form.a || '', 8);
    if (!pool) throw new Error('Choose a farm.');
    if (!a) throw new Error('Enter how much to put in.');
    const priv = pinned(), t = await getUx(), shown = D.terms?.[String(pool.pid)], shownB = shown ? bFor(a, shown.res) : null;
    const tm = await terms(pool, true);
    if (shownB != null && bFor(a, tm.res) !== shownB) { updateInfo(); throw Object.assign(new Error(`The pool moved since this was quoted: the second side is now ${units8(bFor(a, tm.res))} ${tm.tkB}. Check it and press again; nothing was added.`), { said: true }); }
    const p = plan(pool, tm, a, (await t.balance(priv())).notes), b = p.b, { assetA, assetB } = pool.reserves;
    if (p.short === 'A') throw new Error(`Your private ${tm.tkA} does not cover ${units8(a)} and the relay’s fee to split a note.`);
    if (p.short === 'B') throw new Error(`This needs ${units8(b)} ${tm.tkB} at the pool’s ratio, and your private ${tm.tkB} does not cover it and the relay’s fee to split a note.`);
    let { nA, nB } = p;
    const n = 1 + (nA ? 0 : 1) + (nB ? 0 : 1);
    let k = 0;
    if (!nA) { say(`Step ${++k} of ${n} · the relay is cutting a note of ${units8(a)} ${tm.tkA}…`); settled(await cutSized(t, priv(), p.pA, a, p.fA, () => run().wait(`Split a note to ${units8(a)} ${tm.tkA}`, 15 * 60e3))); nA = await noteShows(t, priv, assetA, a); }
    if (!nB) { say(`Step ${++k} of ${n} · the relay is cutting a note of ${units8(b)} ${tm.tkB}…`); settled(await cutSized(t, priv(), p.pB, b, p.fB, () => run().wait(`Split a note to ${units8(b)} ${tm.tkB}`, 15 * 60e3))); nB = await noteShows(t, priv, assetB, b); }
    const now = await terms(pool, true);
    if (bFor(a, now.res) !== b) { updateInfo(); throw Object.assign(new Error(`The pool’s price moved while your notes were cut to size: the second side is now ${units8(bFor(a, now.res))} ${tm.tkB}. Press again: the notes are ready and nothing was added.`), { said: true }); }
    say(`Step ${n} of ${n} · the relay is proving your farm entry…`);
    settled(await bond(t, priv(), { manager: prog.manager, aNote: nA, bNote: nB, feeBps: now.res.feeBps ?? pool.feeBps, waitOpts: run().wait(`Add ${name(pool)} liquidity and farm it`, 20 * 60e3) }));
    if (D) D.form = joinAt ? { pool: D.form.pool, open: true } : {};
    return prog?.epoch?.active ? 'In the farm: TAC is streaming to your private position.' : 'In the farm. It earns once the next reward period starts.';
  }
  function joinForm() {
    const fs = openFarms();
    if (!fs.length) return '';
    const f = D.form, pool = chosen(), pid = String(pool.pid), tm = D.terms?.[pid], a = parseUnits(f.a || '', 8);
    if (!tm && !D.termsAsked?.[pid]) { (D.termsAsked ||= {})[pid] = true; terms(pool).then(() => paint(), () => {}); }
    const short = tm && a && D.notesOk && plan(pool, tm, a, D.notes).short;
    if (joinAt) {
      // the page's own card: its farm, the first side's amount, the second at the pool's ratio, one press
      const held = tm && D.notesOk ? notesOf(D.notes, pool.reserves.assetA).reduce((s, x) => s + BigInt(x.value), 0n) : null;
      return `<div class="lbl"><span>${esc(tm?.tkA || 'tETH')}, private</span>${held ? `<button class="linkbtn" type="button" data-pf="max">Held ${esc(units8(held))}</button>` : ''}</div>
        <div class="amt"><input id="pf-a" inputmode="decimal" placeholder="0.00" autocomplete="off" aria-label="${esc(tm?.tkA || 'tETH')} to put in" value="${esc(f.a || '')}"${D.busy ? ' disabled' : ''}><span class="u">${esc(tm?.tkA || 'tETH')}</span></div>
        <div class="fm-rcpt" id="pf-info">${joinInfo(pool, tm, a) || '<p class="note">The second side is worked out at the pool’s ratio.</p>'}</div>
        <button class="btn" type="button" data-pf="join"${D.busy || !tm || short ? ' disabled' : ''}>${D.busy === 'join' ? 'Adding…' : `Add both and farm`}</button>`;
    }
    return `<details class="pf-join"${f.open || f.a ? ' open' : ''}><summary>Join a private farm</summary>
      <dl class="kv"><div><dt>Farm</dt><dd><select id="pf-pool" aria-label="Farm to join"${D.busy ? ' disabled' : ''}>${fs.map((p) => `<option value="${esc(String(p.pid))}"${String(p.pid) === pid ? ' selected' : ''}>${esc(name(p))}</option>`).join('')}</select></dd></div>
      <div><dt>${esc(tm?.tkA || 'First side')}</dt><dd><input id="pf-a" inputmode="decimal" placeholder="0.00" autocomplete="off" aria-label="${esc(tm?.tkA || 'First side')} to put in" value="${esc(f.a || '')}"${D.busy ? ' disabled' : ''}></dd></div></dl>
      <div id="pf-info">${joinInfo(pool, tm, a)}</div>
      <div class="acts"><button type="button" data-pf="join"${D.busy || !tm || short ? ' disabled' : ''}>${D.busy === 'join' ? 'Adding…' : 'Add and farm'}</button><a href="/#farm/private-${esc(pid)}">With one side only</a></div>
    </details>`;
  }
  // typing and the clock keep the quote current in place (a repaint would take the field's focus)
  function updateInfo() {
    const pool = D?.form && chosen();
    if (!pool) return;
    const tm = D.terms?.[String(pool.pid)], a = parseUnits(D.form.a || '', 8), el = jr.querySelector('#pf-info'), go = jr.querySelector('[data-pf="join"]');
    if (el) el.innerHTML = joinInfo(pool, tm, a) || (joinAt ? '<p class="note">The second side is worked out at the pool’s ratio.</p>' : '');
    if (go) go.disabled = !!D.busy || !tm || !!(a && D.notesOk && plan(pool, tm, a, D.notes).short);
    if (tm && a && Date.now() - tm.at > QUOTE_FRESH) terms(pool, true).then(updateInfo, () => {});
  }
  setInterval(() => { if (!document.hidden && key.unlocked && D?.form?.a && !D.busy) updateInfo(); }, 15e3);

  // what a press said, as a status line
  const saidLine = (id) => { const s = D?.said; return s?.text ? `<p class="more${s.kind === 'ok' ? ' ok' : s.kind ? ' err' : ''}" role="status" id="${id}">${esc(s.text)}${s.kind === 'front' ? ' <a href="/#farm">Do it on the front page →</a>' : ''}</p>` : `<p class="more" role="status" id="${id}"></p>`; };
  // the join drawn where the page asked: a way in when the key is shut, the form once the notes are read
  function paintJoin() {
    if (!joinAt) return;
    const h = !key.unlocked ? `<p class="note">Open your Tacit wallet to add what you hold privately.</p><button class="btn" type="button" data-pf="open">Open your Tacit wallet</button>`
      : !D || D.loading ? '<p class="note">Reading your private balance…</p>'
      : D.err ? `<p class="note err">${esc(D.err)} <button class="linkbtn" type="button" data-pf="again">Try again</button></p>`
      : `${openFarms().length ? joinForm() : '<p class="note">No private farm is open to join now.</p>'}${D.sayAt === 'join' ? saidLine('pj-said') : ''}`;
    put(joinAt, h);
  }
  function put(el, h) {
    if (el.__h === h) return;
    // the field being typed in keeps its place through a repaint
    const at = document.activeElement, id = at && el.contains(at) ? at.id : '', s0 = at?.selectionStart, s1 = at?.selectionEnd;
    el.__h = h; el.innerHTML = h;
    const f = id && el.querySelector(`#${CSS.escape(id)}`);
    if (f) { f.focus({ preventScroll: true }); try { if (s0 != null) f.setSelectionRange(s0, s1); } catch { /* a field with no selection */ } }
  }
  function paint() {
    paintJoin();
    let h;
    if (!key.unlocked) h = `${lockedWhy ? `<p class="more err">${esc(lockedWhy)}</p>` : ''}<p class="more">Your positions in the private farms.</p><button class="act" type="button" data-pf="open">Show mine</button>`;
    else if (!D || D.loading) h = '<p class="more">Reading your positions…</p>';
    else if (D.err) h = `<p class="more err">${esc(D.err)} <button class="linkbtn" type="button" data-pf="again">Try again</button></p>`;
    else {
      const rows = D.list.map((pos, i) => {
        const b = D.busy, tac = Number(pos.pendingTac || 0), lk = locked(pos, now());
        return `<dl class="kv"><div><dt>${pair(pos.pid)}${esc(name(pos))}</dt><dd class="num">${esc(tac.toLocaleString('en-US', { maximumFractionDigits: 4 }))} TAC earned</dd></div>${lk ? `<div><dt>Bonded until</dt><dd>${esc(day(Number(pos.unlockAt)))}</dd></div>` : ''}</dl>
          <div class="acts">
            <button type="button" data-pf="harvest" data-i="${i}"${b || !canHarvest(pos) ? ' disabled' : ''}>${b === `harvest:${i}` ? 'Harvesting…' : 'Harvest'}</button>
            <button type="button" data-pf="unbond" data-i="${i}"${b || !canUnbond(pos, now()) ? ' disabled' : ''}>${b === `unbond:${i}` ? 'Unbonding…' : 'Unbond'}</button>
            <button type="button" data-pf="exit" data-i="${i}"${b || lk ? ' disabled' : ''}>${b === `exit:${i}` ? 'Exiting…' : 'Exit'}</button>
          </div>`;
      }).join('');
      const said = D.sayAt === 'join' ? '' : saidLine('pf-said');
      const rn = rewardNotes(D.notes, program()?.rewardAsset), rsum = rn.reduce((a, x) => a + BigInt(x.value), 0n);
      const rewards = rn.length || D.wtac > 0n ? `<dl class="kv"><div><dt>Rewards to turn into TAC</dt><dd class="num">${rn.length ? `${esc(noteTxt(rsum))} wTAC private` : ''}${rn.length && D.wtac > 0n ? ' · ' : ''}${D.wtac > 0n ? `${esc(tacTxt(D.wtac))} wTAC in your wallet` : ''}</dd></div></dl>
        <div class="acts"><button type="button" data-pf="totac"${D.busy ? ' disabled' : ''}>${D.busy === 'totac' ? 'Turning…' : 'Turn into TAC'}</button></div>` : '';
      h = `${rows || '<p class="more">No private farm positions yet.</p>'}${rewards}${joinAt ? '' : joinForm()}${said}<div class="acts"><button type="button" data-pf="again"${D.busy ? ' disabled' : ''}>Read again</button><button type="button" data-pf="lock"${D.busy ? ' disabled' : ''}>Lock your key</button></div>`;
    }
    put(root, h);
  }

  const hosts = joinAt ? [root, joinAt] : [root];
  for (const el of hosts) {
    el.addEventListener('toggle', (e) => { if (D?.form && e.target.classList?.contains('pf-join')) D.form.open = e.target.open; }, true);
    el.addEventListener('input', (e) => {
      if (!D?.form || e.target.id !== 'pf-a') return;
      D.form.a = e.target.value.trim();
      updateInfo();
    });
    el.addEventListener('change', (e) => { if (D?.form && e.target.id === 'pf-pool') { D.form.pool = e.target.value; paint(); } });
    el.addEventListener('click', onClick);
  }
  function onClick(e) {
    const b = e.target.closest('[data-pf]');
    if (!b || b.disabled) return;
    const what = b.dataset.pf, i = Number(b.dataset.i);
    if (what === 'max') {                                                              // every note of the first side held
      const pool = chosen(), held = pool ? notesOf(D.notes, pool.reserves.assetA).reduce((s, x) => s + BigInt(x.value), 0n) : 0n;
      if (held > 0n) { D.form.a = units8(held).replace(/,/g, ''); paint(); updateInfo(); }
      return;
    }
    if (what === 'lock') return forget();
    if (what === 'again') return read();
    if (what === 'harvest') return act(`harvest:${i}`, () => doHarvest(i));
    if (what === 'unbond') return act(`unbond:${i}`, () => doUnbond(i));
    if (what === 'exit') return act(`exit:${i}`, () => exit(i));
    if (what === 'totac') return act('totac', toTac);
    if (what === 'join') return act('join', join);
    signInSheet(key, { pick, why: 'Open your Tacit wallet to see your private farm positions. Nothing is stored or sent.' }).then(() => read(), () => {});
  }
  key.onChange(() => { if (key.unlocked && D?.pub !== key.key.pubHex) read(); else paint(); });
  if (key.unlocked) read(); else paint();
  // a farm picked elsewhere on the page: the join form opened on it, now or once the positions are read
  function choose(pid) {
    wanted = { pool: String(pid), open: true };
    if (D?.form) { D.form = { ...wanted, a: D.form.pool === wanted.pool ? D.form.a : undefined }; paint(); }
  }

  return { read, forget, choose };
}
