// The Bitcoin side's own position (/vault/#btc): the locks this key made and where each stands, its loans, and the cBTC and cUSD it holds
// privately; and, from here, a lock of BTC sent to the key's deposit address, its bond (from the connected wallet) and its mint, a loan against
// a whole cBTC note and its repayment, the mint and the loans relayed. Paying the deposit address from a wallet in the browser, a note cut to
// size and a relay that will not take it (the front page sends it from the Tacit account) are the front page's: those link there. Nothing here is loaded until the holder asks: this module, the key, the pool and Bitcoin's history come in on that press.
import { sha256, hmac, secp, bytesToHex, hexToBytes } from '/vendor/tacit-deps.min.js';
import { makeKeySession, signInSheet } from '/trade/key.js?cb=88028d84';
import { getUx, forgetUx } from '/trade/poolux.js?cb=ac4a1175';
import { readLocks, readLoans, readHeld, readEngine, lockStep, ENGINE, WSTETH } from '/cbtc/read.js?cb=f2671893';
import { makeLoans, exactNotes, bondGap, bondCall, outpointOf, lockPad, loanHealth, borrowAt, SAFE_RATIOS } from '/btc-borrow.js?cb=13923518';
import { makeRunner } from '/activity.js?cb=5bc9627f';
import { relayRefused, relayWords } from '/relay-outcome.js?cb=26298b8e';
import { esc, short, grp, parseUnits, word, wordAt } from '/trade/util.js?cb=dcf3a4f2';

const API = 'https://api.tacit.finance';
// Bitcoin's explorers, in order: a read that fails at one is asked of the next
const ESPLORA = ['https://mempool.space/api', 'https://blockstream.info/api'];
async function esplora(path, as = 'json') {
  let last;
  for (const b of ESPLORA) {
    try { const r = await fetch(b + path, { cache: 'no-store' }); if (r.ok) return as === 'json' ? r.json() : r.text(); last = new Error(`${b.split('/')[2]} ${r.status}`); }
    catch (e) { last = e; }
  }
  throw last;
}
const SEL = { btcToUsd: 'd5901347', rate: '2c4e722e', requiredEscrow: '034448ed', escrowTotal: 'e06e89c9', stEthPerWst: 'bb2952fc' };
const ethTxt = (wei) => (Number(wei) / 1e18).toLocaleString('en-US', { maximumFractionDigits: 5 });
const btcTxt = (sats) => { const x = Number(sats) / 1e8; return x === 0 ? '0' : x >= 1 ? grp(x, 4) : x >= 0.001 ? x.toFixed(6).replace(/0+$/, '') : x.toFixed(8).replace(/0+$/, ''); };
const cusdTxt = (v) => grp(Number(v) / 1e8, Number(v) / 1e8 >= 100 ? 0 : 2);
const big = (v) => BigInt(v);
// what a lock's next step is, done from here
const NEXT = { 'post its bond': ['Post the bond', 'bond'], 'ready to mint': ['Mint cBTC', 'mint'] };
const FRONT = '<a href="/#borrow">Do it on the front page →</a>';
const mk = (id) => `<svg class="tk xs inl" aria-hidden="true"><use href="#tk-${id}"/></svg>`;
// a note, by what it is and not by where it sits in a list that a read can reorder
const noteId = (x) => String(x.leaf || x.nullifier || `${x.cx}:${x.cy}`).toLowerCase();

export function mountMine(root, { pick, wallet = null, W = null, connect = null } = {}) {
  let D = null, seq = 0, histP = null, runner = null;
  let lockedWhy = '';                                                                  // why the key was locked, when the wallet that opened it moved
  const key = makeKeySession({ moved: (why) => { lockedWhy = why || ''; forget(); } });
  const LN = makeLoans({ sha256, hmac, secp, bytesToHex, hexToBytes, pubHex: () => key.key?.pubHex });
  const run = () => (runner ||= makeRunner({ api: API, base: async () => (await import('/confidential-deployments.js')).getConfidentialDeployment('mainnet')?.relayBase || API, pub: () => key.key?.pubHex || null, btcConfirmed: async (txid) => !!(await esplora(`/tx/${txid}/status`))?.confirmed }));
  const history = () => (histP ||= import('/confidential-recovery-btc.js').then(({ makeBtcHistoryProvider }) => makeBtcHistoryProvider({ sha256, hrp: 'bc', fetchImpl: (u, o) => fetch(u, o) })));
  function forget() { key.lock(); forgetUx(); seq++; D = null; paint(); }
  // a call that came back went through: its job is settled in the journal, whatever a slower read of the relay says
  const settled = (r) => { if (r?.jobId) run().journal.put('job:' + r.jobId, { status: 'settled', hash: r.txHash || undefined }); };

  async function read() {
    if (!key.unlocked) return paint();
    lockedWhy = '';
    const pub = key.key.pubHex, my = ++seq, priv = key.priv(), was = D?.pub === pub ? D : null;
    D = { pub, loading: !was, ...(was ? { ...was, reading: true } : {}) }; paint();
    try {
      // a lock this browser just made (in the front page's record for the key) is listed before Bitcoin's history has it
      const ux = await getUx(), h0 = await history(), rec = (() => { try { return JSON.parse(localStorage.getItem(recKeyOf(pub))); } catch { return null; } })();
      const hist = { locks: async (k) => { const all = await h0.locks(k); return rec?.lockTxid && !all.some((l) => l.lockTxid === rec.lockTxid && Number(l.lockVout) === Number(rec.lockVout)) ? [...all, rec] : all; } };
      // each read stands on its own: a failed one is said, the others still show
      const [held, locks, loans, engine, dep] = await Promise.allSettled([readHeld({ ux, priv }), readLocks({ ux, priv, hist }), readLoans({ ux, priv }), readEngine(), readDeposit(ux, priv)]);
      if (my !== seq || key.key?.pubHex !== pub) return;
      const v = (r) => (r.status === 'fulfilled' ? r.value : null), why = (r) => (r.status === 'rejected' ? String(r.reason?.message || r.reason).slice(0, 140) : null);
      const cur = D?.pub === pub ? D : null;                                         // what was typed, said or started while this was read is kept
      D = { pub, held: v(held), locks: v(locks), loans: v(loans), engine: v(engine), dep: v(dep), errs: { held: why(held), locks: why(locks), loans: why(loans), dep: why(dep) }, form: cur?.form || was?.form || {}, said: cur?.said || null, busy: cur?.busy || null };
    } catch (e) { if (my === seq) D = { pub, err: String(e?.message || e).slice(0, 160) }; }
    paint();
  }

  // what the lock record the front page keeps for this key says about its loan
  // (the key it is under is the one the flow started under, not whichever is open when it ends)
  const recKeyOf = (pub) => `tacit-lite-cbtc-v1:${pub}`;
  const markLoan = (pub, value, debtValue) => { try { const rec = JSON.parse(localStorage.getItem(recKeyOf(pub))); if (rec && big(rec.vBtc) === big(value)) localStorage.setItem(recKeyOf(pub), JSON.stringify({ ...rec, borrowed: debtValue.toString(), borrowedAt: Date.now() })); } catch {} };
  const markRepaid = (pub, basket) => { try { const rec = JSON.parse(localStorage.getItem(recKeyOf(pub))); if (rec && basket.some((l) => big(l.value) === big(rec.vBtc))) { const { borrowed, borrowedAt, ...rest } = rec; localStorage.setItem(recKeyOf(pub), JSON.stringify(rest)); } } catch {} };
  // The key a flow starts under. Each step of the flow asks for it again, so a key locked or changed meanwhile stops the flow before its next
  // step, and each step is given its own copy. `.pub` is the key it is under.
  function pinned() {
    const pub = key.key.pubHex;
    const priv = () => {
      if (!key.unlocked || key.key.pubHex !== pub) throw new Error('Your Tacit wallet was locked or changed, so this stopped before its next step. Nothing further was sent.');
      return key.priv();
    };
    priv.pub = pub;
    return priv;
  }

  async function borrow() {
    const notes = D.held?.cbtc.list || [], n = notes.find((x) => noteId(x) === D.form.note) || notes[0], debtValue = parseUnits(D.form.amt || '', 8);
    if (!n) throw new Error('Choose a cBTC note to put up.');
    if (!debtValue) throw new Error('Enter how much cUSD to borrow.');
    const priv = pinned(), raw = priv(), t = await getUx(), c = t.cfg.collateralEngine, sats = big(n.value);       // `raw`: the loan is remembered whatever becomes of the key once it is in
    const ratio = big(Math.round((D.engine?.ratio ?? 0) * 100));
    if (!ratio) throw new Error('The collateral floor could not be read, so the loan cannot be sized yet. Try again in a moment.');
    const usd = wordAt(await t.ethCall(ENGINE, '0x' + SEL.btcToUsd + word(sats)), 0);
    if (debtValue * ratio > usd * 10000n) throw new Error(`That is below the ${Number(ratio) / 100}% floor. Borrow less, or put up a larger note.`);
    say('Finding your next position key…');
    const { ps, keyNonce, positionOwner } = await LN.fresh(t, priv(), c);
    const rate = String(await t.ethCall(c, '0x' + SEL.rate)).toLowerCase();
    const { leg, anchor, args } = LN.openArgs(t, priv(), { note: n, debtValue, controller: c, rate, positionOwner });
    const label = `Borrow ${cusdTxt(debtValue)} cUSD`;
    say('The relay is proving your loan…');
    const r = await t.defiActions(priv()).openCdp({ ...args, waitOpts: run().wait(label) });
    settled(r);
    await LN.opened(ps, raw, { controller: c, debtValue, keyNonce, positionOwner, rate, anchor, basket: [{ asset: leg.asset, value: String(big(leg.value)) }], txHash: r?.txHash || null });
    markLoan(priv.pub, leg.value, debtValue);
    if (D?.pub === priv.pub) D.form = {};
    return `Borrowed ${cusdTxt(debtValue)} cUSD.`;
  }

  async function repay(i) {
    const p = D.loans?.[i]?.pos;
    if (!p) throw new Error('The loan is not visible on chain yet. Try again in a minute.');
    const priv = pinned(), t = await getUx(), debtValue = big(p.debtValue);
    const ps = await LN.positions(), ownerPriv = await ps.ownerPrivFor(priv(), p);
    if (!ownerPriv) throw Object.assign(new Error('This loan’s key could not be re-derived here.'), { front: true });
    const { leaf, basket, debtAsset } = LN.positionLeaf(t, p);
    say('Finding your loan and your cUSD…');
    const [tree, bal] = await Promise.all([t.cdpPositionTree(), t.balance(priv())]);
    const index = tree.indexOf(leaf);
    if (index < 0) throw new Error('The loan is not on chain yet. Try again in a minute.');
    const own = (bal.notes || []).filter((x) => String(x.asset).toLowerCase() === debtAsset), have = own.reduce((a, x) => a + big(x.value), 0n);
    if (have < debtValue) throw new Error(`Repaying needs ${cusdTxt(debtValue)} cUSD held privately; you hold ${cusdTxt(have)}.`);
    const picked = exactNotes(own, debtValue);
    if (!picked) throw Object.assign(new Error(`No cUSD notes add up to exactly ${cusdTxt(debtValue)}: one has to be cut to size first, and what is over would not come back.`), { front: true });
    const label = `Repay ${cusdTxt(debtValue)} cUSD`;
    say('The relay is proving your repayment…');
    settled(await t.defiActions(priv()).closeCdp({ ...LN.repayArgs(t, priv(), { p, ownerPriv, basket, tree, index, picked }), waitOpts: run().wait(label) }));
    LN.repaid(ps, p);
    markRepaid(priv.pub, basket);
    return 'Repaid. Your cBTC is back as a private note.';
  }

  // The key's deposit address (a plain one: any wallet or exchange pays it), what it holds confirmed and on its way, and what a lock needs
  // on top of its amount for fees.
  async function readDeposit(ux, priv) {
    const { lm, dep } = await LN.lockMaker(ux, priv), addr = lm.wallet.address();
    const [all, rec] = await Promise.all([esplora(`/address/${addr}/utxo`), esplora('/v1/fees/recommended').catch(() => null)]);
    const est = rec?.fastestFee ? null : await esplora('/fee-estimates').catch(() => null);
    // what a lock can spend: not dust, and not an output that is a lock already (those are never spent as coins)
    const held = new Set((dep.listProtectedOutpoints() || []).map((k) => String(k).toLowerCase()));
    const utxos = all.filter((u) => Number(u.value) > 546 && !held.has(`${u.txid}:${u.vout}`.toLowerCase()));
    const ok = utxos.filter((u) => u.status?.confirmed), wait = utxos.filter((u) => !u.status?.confirmed);
    return { addr, sats: ok.reduce((a, u) => a + BigInt(u.value), 0n), pending: wait.reduce((a, u) => a + BigInt(u.value), 0n), unconfirmed: wait.map((u) => `${u.txid}:${u.vout}`.toLowerCase()), pad: lockPad(rec, est) };
  }
  // A lock of what the deposit address holds, signed with the key: an output only the key can spend, which the pool records once it is deep
  // enough; then the bond, then the mint.
  async function lockBtc() {
    const sats = parseUnits(D.form.lock || '', 8);
    if (!sats || sats < 10000n) throw new Error('Lock at least 0.0001 BTC.');
    const priv = pinned(), t = await getUx();
    say('Reading the deposit address…');
    const d = await readDeposit(t, priv());                                          // read again: the coins and the fee rate are today's
    if (sats + d.pad > d.sats) throw new Error(d.sats + d.pending >= sats + d.pad ? 'Wait for the deposit to confirm, then lock.' : `Not enough BTC at the deposit address for this lock and its fees, about ${btcTxt(d.pad)} BTC.`);
    let res;
    try { res = await LN.lock(t, priv(), { sats, unconfirmed: d.unconfirmed, say: (x) => say(x) }); }
    catch (e) { if (/insufficient sats/i.test(String(e?.message || ''))) throw new Error('Not enough BTC at the deposit address for this lock and its network fees.'); throw e; }
    try { localStorage.setItem(recKeyOf(priv.pub), JSON.stringify(res.record)); } catch {}
    const J = run().journal, id = 'btc:' + String(res.lockTxid).toLowerCase();
    J.put(id, { kind: 'btc', label: `Lock ${btcTxt(sats)} BTC`, hash: res.lockTxid, status: 'pending' });
    run().follow.btc(id);
    if (D?.pub === priv.pub) D.form.lock = '';
    return 'Locked. Post the bond next.';
  }

  // the lock record the front page keeps for this key, once its lock is minted
  const markMinted = (pub, l, txHash) => { try { const rec = JSON.parse(localStorage.getItem(recKeyOf(pub))); if (rec && rec.lockTxid === l.lockTxid && Number(rec.lockVout) === Number(l.lockVout)) localStorage.setItem(recKeyOf(pub), JSON.stringify({ ...rec, minted: txHash || true })); } catch {} };

  // A lock's bond, posted in ETH from the connected wallet: the bond helper stakes it and holds the wstETH against the lock.
  async function bond(i) {
    const l = D.locks?.[i];
    if (!l) throw new Error('That lock is not listed any more. Read again.');
    if (!wallet || !W) throw Object.assign(new Error('Posting a bond needs a wallet.'), { front: true });
    const t = await getUx(), op = String(outpointOf(t, l)).replace(/^0x/, '');
    say('Sizing the bond…');
    const [need, have] = await Promise.all([t.ethCall(ENGINE, '0x' + SEL.requiredEscrow + word(l.vBtc)), t.ethCall(ENGINE, '0x' + SEL.escrowTotal + op)]).then((r) => r.map((x) => wordAt(x, 0)));
    if (!need) throw new Error('The bond size could not be read. Try again in a few minutes.');                // a read that failed answers 0: that is not a posted bond
    const { gap } = bondGap(need, have);
    if (!gap) return 'The bond is posted. Mint once the lock is proven.';
    const eth = wordAt(await t.ethCall(WSTETH, '0x' + SEL.stEthPerWst + word(gap)), 0);
    if (!eth) throw new Error('The bond size could not be read. Try again in a few minutes.');
    if (!W.account) await connect();
    if (!W.account) throw new Error('Connect a wallet to post the bond.');
    say(`Confirm the ${ethTxt(eth)} ETH bond in your wallet…`);
    const hash = await wallet.sendTx({ ...bondCall(t, l), value: eth, from: W.account });
    const label = `Post the bond for ${btcTxt(l.sats)} BTC`, J = run().journal, id = `tx:1:${String(hash).toLowerCase()}`;
    J.put(id, { kind: 'tx', label, chain: 1, hash, status: 'pending' });
    say('Posting the bond…');
    const rc = await wallet.receipt(hash);
    J.put(id, rc?.status === '0x1' ? { status: 'confirmed' } : { status: 'failed', err: 'The transaction reverted.' });
    if (rc?.status !== '0x1') throw new Error('The bond did not go through.');
    return 'Bond posted. Mint once the lock is proven.';
  }

  // A lock's mint, relayed: one cBTC for each BTC locked, its note found again later from the key alone.
  async function mint(i) {
    const l = D.locks?.[i];
    if (!l) throw new Error('That lock is not listed any more. Read again.');
    const priv = pinned(), t = await getUx(), args = await LN.mintArgs(t, priv(), l), label = `Mint ${btcTxt(l.sats)} cBTC`;
    say('The relay is proving your mint…');
    let r;
    try { r = await t.mintCbtc({ ...args, waitOpts: run().wait(label) }); }
    catch (e) { if (!relayRefused(e) && /CbtcLockMismatch|afff2f20/i.test(String(e?.message || ''))) throw new Error('Not ready yet: the lock is still being proven, or the bond fell short at today’s price. Try again in a few minutes.'); throw e; }
    settled(r);
    markMinted(priv.pub, l, r?.txHash);
    return 'cBTC minted.';
  }

  function say(text, kind = '') { if (D) { D.said = { text, kind }; paint(); } }
  async function act(name, fn) {
    if (!D || D.busy) return;
    const mine = D;
    mine.busy = name; say('');
    try { const text = await fn(); if (D?.pub === mine.pub) say(text, 'ok'); }
    catch (e) {
      if (D?.pub === mine.pub) { const w = relayWords(e); say(w ? w.text : String(e?.message || e).slice(0, 240), w?.front || e?.front ? 'front' : 'err'); }
    }
    // whatever it came to, what is held is read again: a step that went through before a later one failed shows as it is
    finally { if (D?.pub === mine.pub) D.busy = null; if (key.unlocked) read(); }
  }

  // the cBTC note the form is set to put up
  const chosenNote = () => { const notes = D.held?.cbtc.list || []; return notes.find((x) => noteId(x) === D.form.note) || notes[0] || null; };
  // How the loan being typed would stand: its collateral ratio (said in a warning colour under 175% and as an error under the floor) and the price of
  // a bitcoin below which it can be liquidated.
  function healthHtml(n, amtText) {
    const e = D.engine, debt = parseUnits(amtText || '', 8);
    if (!n || !debt || !e?.usdBtc) return '';
    const h = loanHealth({ sats: n.value, debt, usdBtc: e.usdBtc, floor: e.ratio, liq: e.liq });
    if (h.ratio == null) return '';
    return `Collateral ratio <b class="${h.level}">${esc(String(Math.round(h.ratio)))}%</b>${h.liqAt ? `; liquidated below $${esc(Math.round(h.liqAt).toLocaleString('en-US'))} a bitcoin` : ''}.${h.level === 'err' ? ` That is under the ${esc(String(e.ratio))}% floor: borrow less.` : ''}`;
  }
  function updateHealth() { const el = root.querySelector('#bm-health'); if (el && D?.form) el.innerHTML = healthHtml(chosenNote(), D.form.amt); }
  function form() {
    const notes = D.held?.cbtc.list || [];
    if (!notes.length) return '';
    const f = D.form, n = chosenNote(), e = D.engine, sats = n ? big(n.value) : 0n;
    const max = e?.ratio && e?.usdBtc && n ? borrowAt({ sats, usdBtc: e.usdBtc, pct: e.ratio }) : 0;
    const chips = e?.usdBtc && n ? SAFE_RATIOS.map((r) => [r, borrowAt({ sats, usdBtc: e.usdBtc, pct: r })]).filter(([, v]) => v > 0) : [];
    const half = max ? String(Math.floor(max / 2 * 100) / 100) : '0.00';
    return `<div class="bm-form">
      <div class="kv"><span>Put up</span><b><select id="bm-note" aria-label="cBTC note to put up"${D.busy ? ' disabled' : ''}>${notes.map((x) => `<option value="${esc(noteId(x))}"${x === n ? ' selected' : ''}>${esc(btcTxt(x.value))} cBTC</option>`).join('')}</select></b></div>
      <div class="kv"><span>Borrow</span><b><input id="bm-amt" inputmode="decimal" placeholder="${esc(half)}" autocomplete="off" aria-label="cUSD to borrow" value="${esc(f.amt || '')}"${D.busy ? ' disabled' : ''}> cUSD</b></div>
      ${chips.length ? `<div class="seg sub bm-chips" role="group" aria-label="Collateral ratio">${chips.map(([r, v]) => `<button type="button" data-mine="ratio" data-v="${v}" aria-label="Borrow ${v} cUSD, a ${r}% collateral ratio"${D.busy ? ' disabled' : ''}>${r}%</button>`).join('')}</div>` : ''}
      <p class="note bm-health" id="bm-health">${healthHtml(n, f.amt)}</p>
      ${max ? `<p class="note">Up to about ${esc(grp(max, max >= 100 ? 0 : 2))} cUSD at the ${esc(String(e.ratio))}% floor.${e.liq ? ` A loan can be liquidated below ${esc(String(e.liq))}%.` : ''}</p>` : ''}
      <button class="btn" type="button" data-mine="borrow"${D.busy ? ' disabled' : ''}>${D.busy === 'borrow' ? 'Borrowing…' : 'Borrow cUSD'}</button>
    </div>`;
  }

  function lockForm() {
    const d = D.dep;
    if (!d) return D.errs?.dep ? `<p class="note err">Could not read your deposit address: ${esc(D.errs.dep)}</p>` : '';
    return `<details class="bm-lock"${d.sats + d.pending > 0n || D.form.lock ? ' open' : ''}><summary>Lock BTC</summary>
      <div class="kv"><span>Deposit address</span><b class="mono">${esc(short(d.addr, 8))} <button class="linkbtn" type="button" data-mine="copy" data-copy="${esc(d.addr)}">copy</button></b></div>
      <div class="kv"><span>It holds</span><b class="num">${esc(btcTxt(d.sats))} BTC${d.pending > 0n ? `<small>${esc(btcTxt(d.pending))} on its way</small>` : ''}</b></div>
      <div class="kv"><span>Lock</span><b><input id="bm-lock" inputmode="decimal" placeholder="0.00" autocomplete="off" aria-label="BTC to lock" value="${esc(D.form.lock || '')}"${D.busy ? ' disabled' : ''}> BTC</b></div>
      <p class="note">Send BTC to it from any wallet, then lock it, keeping about ${esc(btcTxt(d.pad))} BTC for fees. <a href="/#lock">Send from a wallet in this browser →</a></p>
      <button class="btn ghost" type="button" data-mine="lockbtc"${D.busy ? ' disabled' : ''}>${D.busy === 'lockbtc' ? 'Locking…' : 'Lock BTC'}</button>
    </details>`;
  }

  function paint() {
    let h;
    if (!key.unlocked) h = `${lockedWhy ? `<p class="note err">${esc(lockedWhy)}</p>` : ''}<p class="note">Your locks, loans and cBTC.</p><button class="btn ghost" type="button" data-mine="open">Show mine</button>`;
    else if (!D || D.loading) h = '<p class="note">Reading your locks and loans…</p>';
    else if (D.err) h = `<p class="note err">${esc(D.err)} <button class="linkbtn" type="button" data-mine="again">Try again</button></p>`;
    else {
      const rows = [], { held, locks, loans, errs } = D;
      if (held) {
        rows.push(`<div class="kv"><span>${mk('cbtc')}cBTC, private</span><b class="num">${esc(btcTxt(held.cbtc.value))}</b></div>`);
        if (held.cusd.value > 0n) rows.push(`<div class="kv"><span>${mk('cusd')}cUSD, private</span><b class="num">${esc(cusdTxt(held.cusd.value))}</b></div>`);
      } else rows.push(`<p class="note err">Could not read your balance: ${esc(errs.held)}</p>`);
      if (loans) loans.forEach((l, i) => {
        const e = D.engine, hh = e?.usdBtc ? loanHealth({ sats: l.cbtc, debt: l.debt, usdBtc: e.usdBtc, floor: e.ratio, liq: e.liq }) : null;
        rows.push(`<div class="kv"><span>${mk('cusd')}Loan</span><b class="num">${esc(cusdTxt(l.debt))} cUSD<small>against ${esc(btcTxt(l.cbtc))} cBTC · <button class="linkbtn" type="button" data-mine="repay" data-i="${i}"${D.busy ? ' disabled' : ''}>${D.busy === `repay:${i}` ? 'Repaying…' : 'Repay'}</button></small>${hh?.ratio != null ? `<small class="bm-health">Collateral ratio <b class="${hh.level}">${esc(String(Math.round(hh.ratio)))}%</b>${hh.liqAt ? ` · liquidated below $${esc(Math.round(hh.liqAt).toLocaleString('en-US'))} a bitcoin` : ''}</small>` : ''}</b></div>`);
      });
      else rows.push(`<p class="note err">Could not read your loans: ${esc(errs.loans)}</p>`);
      if (locks) locks.forEach((l, i) => {
        const step = lockStep(l), [a, what] = NEXT[step] || [], busy = D.busy === `${what}:${i}`;
        rows.push(`<div class="kv"><span>${mk('btc')}Lock ${esc(short(l.lockTxid, 4))}:${l.lockVout}</span><b class="num">${esc(btcTxt(l.sats))} BTC<small class="${l.minted ? 'ok' : ''}">${a ? `<button class="linkbtn" type="button" data-mine="${what}" data-i="${i}"${D.busy ? ' disabled' : ''}>${busy ? `${a}…` : a}</button>` : esc(step)}</small></b></div>`);
      });
      else rows.push(`<p class="note err">Could not read your locks: ${esc(errs.locks)}</p>`);
      if (locks && loans && !locks.length && !loans.length && !held?.cbtc.list.length) rows.push('<p class="note">No locks or loans yet.</p>');
      const s = D.said, said = s?.text ? `<p class="note${s.kind === 'ok' ? ' ok' : s.kind ? ' err' : ''}" role="status" id="bm-status">${esc(s.text)}${s.kind === 'front' ? ` ${FRONT}` : ''}</p>` : '<p class="note" role="status" id="bm-status"></p>';
      h = `<div class="rows flat">${rows.join('')}</div>${form()}${lockForm()}${said}<p class="note"><button class="linkbtn" type="button" data-mine="again"${D.busy ? ' disabled' : ''}>Read again</button> · <button class="linkbtn" type="button" data-mine="lock"${D.busy ? ' disabled' : ''}>Lock your key</button></p>`;
    }
    if (root.__h !== h) {
      // the field being typed in keeps its place through a repaint
      const at = document.activeElement, id = at && root.contains(at) ? at.id : '', s0 = at?.selectionStart, s1 = at?.selectionEnd;
      root.__h = h; root.innerHTML = h;
      const el = id && root.querySelector(`#${CSS.escape(id)}`);
      if (el) { el.focus({ preventScroll: true }); try { if (s0 != null) el.setSelectionRange(s0, s1); } catch { /* a field with no selection */ } }
    }
  }

  root.addEventListener('input', (e) => { if (!D?.form) return; if (e.target.id === 'bm-amt') { D.form.amt = e.target.value.trim(); updateHealth(); } if (e.target.id === 'bm-lock') D.form.lock = e.target.value.trim(); });
  root.addEventListener('change', (e) => { if (D?.form && e.target.id === 'bm-note') { D.form.note = e.target.value; paint(); } });
  root.addEventListener('click', (e) => {
    const b = e.target.closest('[data-mine]');
    if (!b || b.disabled) return;
    const what = b.dataset.mine;
    if (what === 'lock') return forget();
    if (what === 'again') return read();
    if (what === 'ratio') { D.form.amt = b.dataset.v; const i = root.querySelector('#bm-amt'); if (i) i.value = D.form.amt; updateHealth(); return; }
    if (what === 'borrow') return act('borrow', borrow);
    if (what === 'repay') { const i = Number(b.dataset.i); return act(`repay:${i}`, () => repay(i)); }
    if (what === 'bond') { const i = Number(b.dataset.i); return act(`bond:${i}`, () => bond(i)); }
    if (what === 'mint') { const i = Number(b.dataset.i); return act(`mint:${i}`, () => mint(i)); }
    if (what === 'lockbtc') return act('lockbtc', lockBtc);
    if (what === 'copy') { navigator.clipboard?.writeText(b.dataset.copy).catch(() => {}); b.textContent = 'copied'; return; }
    signInSheet(key, { pick, why: 'Open your Tacit wallet to see your locks, loans and cBTC. Nothing is stored or sent.' }).then(() => read(), () => {});
  });
  key.onChange(() => { if (key.unlocked && D?.pub !== key.key.pubHex) read(); else paint(); });
  paint();
  return { read, forget };
}
