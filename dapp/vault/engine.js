// The TAC vaults' engine, shared by the Borrow page (vault/app.js) and the front page's Borrow tab: it reads the vaults (and the account's own
// position in each), plans an action (deposit, borrow, repay, withdraw: what it does, what it needs, the button's word), and runs it with every
// check the page makes, sending the price records an action needs with it (through the router, or as one bundle where the wallet takes one) or
// recording them first. A host keeps the state object `S` with it, draws what the engine says, and gives it its wallet and its formatters: `ui`
// shapes the few bits of a plan or a line that carry markup (an icon, a ratio's zone, the button that adds TAC), `hooks` is told what changed.
import * as M from '/vault/math.js?cb=ac1ed53e';
import { makeReader, staticCalls, parseStatic, dynamicCalls, parseDynamic, timestampCall, refusal, decString, SEL, wordAt, addrWord,
  encDeposit, encWithdraw, encBorrow, encRepay, encCancel, encApprove, encPermit, encMulticall } from '/vault/chain.js?cb=c20b4576';
import { RECORD_GAS, PER_TX, GAS_ROOM, encBatch, MULTICALL3 } from '/vault/feed.js?cb=5f8dd137';
import { simulateBundle, sendBundle, batchSupport, readMixed } from '/vault/batch.js?cb=7f44b203';
import { ROUTER_SEL, encRouterRecords, encRouterBorrow, encRouterWithdraw, encRouterDeposit, encRouterRepay, encRouterPermitSynth, borrowTyped, withdrawTyped } from '/vault/router.js?cb=21df6509';

export const KIND = { usd: { name: 'TAC Dollar', sym: 'TACD', dp: 2, price: (t) => `$${t}` }, eth: { name: 'TAC Ether', sym: 'TACE', dp: 4, price: (t) => `${t} ETH` } };
export const BATCH_MAX = 12;
export class StopWaiting extends Error { constructor() { super('Stopped waiting. If your wallet still shows the request, reject it there, then try again.'); } }

// S: the host's state (busy, the batch and router facts, the chain's clock); VS: the vaults ({ key, addr, hint }); ROUTER: the vault router or null;
// feed: vault/feed.js's makeFeed; UserStopped: the error a host's wallet throws when its holder says no
export function makeVaultEngine({ S, VS, ROUTER, rpc, feed, wallet, W, who, canAct, UserStopped, ui, hooks }) {
  const { ethCall, batch } = makeReader(rpc);
  const { esc, mk, synMk, zone, txLink } = ui;
  const say = (t, kind) => hooks.say(t, kind);
  const now = () => Math.floor(Date.now() / 1000);
  const BOOT = now();
  const chainNow = () => (S.chainT ? S.chainT + (now() - S.chainAt) : now());
  const chainDeadline = (s) => BigInt(chainNow() + s);
  const KINDS = KIND;
  async function load() {
    if (!VS.length) return;
    const my = ++S.seq, who0 = who();
    for (const v of VS) if (!v.s && v.hint && !v.hinted) { Object.assign(v, v.hint); v.hinted = true; }
    const fresh = VS.filter((v) => !v.s && !v.hinted);
    if (fresh.length) {
      const n = staticCalls('0x').length, res = await batch(fresh.flatMap((v) => staticCalls(v.addr)));
      if (my !== S.seq) return;
      fresh.forEach((v, i) => { v.s = parseStatic(res.slice(i * n, (i + 1) * n)); });
    }
    const live = VS.filter((v) => v.s || v.hinted);
    for (const v of live) if (v.s) { v.tac = v.s.tac; v.synth = v.s.synth; v.oracle = v.s.oracle; v.feed = v.s.feed; }
    const nS = staticCalls('0x').length;
    const calls = [timestampCall(), ...live.flatMap((v) => staticCalls(v.addr)), ...live.flatMap((v) => dynamicCalls(v, who0))];
    const res = await batch(calls);
    if (my !== S.seq || who0 !== who()) return;
    const ts = res[0] ? Number(wordAt(res[0], 0)) : 0;
    if (ts) { S.chainT = ts; S.chainAt = now(); }
    let stale = false;
    live.forEach((v, k) => {
      const s = parseStatic(res.slice(1 + k * nS, 1 + (k + 1) * nS));
      if (v.hinted) {
        v.hinted = false;
        if (s && s.tac === v.tac && s.synth === v.synth && s.oracle === v.oracle && s.feed === v.feed) { v.s = s; return; }
        v.hint = null; v.tac = v.synth = v.oracle = v.feed = undefined; stale = true;
        return;
      }
      if (s && s.tac === v.tac && s.synth === v.synth) { v.s = s; v.oracle = s.oracle; v.feed = s.feed; }
    });
    if (stale) return load();
    let i = 1 + live.length * nS;
    for (const v of live) { const n = dynamicCalls(v, who0).length; v.d = parseDynamic(v, who0, res.slice(i, i + n)); v.d.who = who0; i += n; }
    S.loaded = VS.some((v) => v.d); S.failed = !S.loaded;
    if (S.loaded) S.readAt = now();
  }

  // an auction that has run its course needs its records with the cancel: what the records alone would make of the vault
  const lapsedCure = (x) => { const p = canAct() && lapsed(x) ? postOf(x.V) : null; return p && p.d.recovered ? p.n : 0; };
  const readable = (d) => d.pB != null && d.feeBps != null && d.debtCeiling != null && d.depthCeiling != null && d.totalDebt != null;
  const postOf = (V) => (V.post && V.d && (!readable(V.d) || V.d.pL == null || V.d.recovered == null) && V.post.who === (who() || '').toLowerCase() && now() - V.post.at < POST_TTL ? V.post : null);
  const lapsed = (x) => x.auction && x.d.recovered == null;
  const needs = (x, t) => (t === 'borrow' && x.paused && !x.auction) || (t === 'withdraw' && x.wpaused && !x.auction) || ((t === 'deposit' || t === 'repay') && lapsed(x));
  function derive(V, post = false) {
    const s = V.s;
    if (!s || !V.d) return null;
    const pre = post ? postOf(V) : null, D = pre ? pre.d : V.d;
    const mine = (D.who || '').toLowerCase() === (who() || '').toLowerCase();
    const d = mine ? D : { ...D, me: null, recovered: null, onOffer: null, tacBal: null, tacAllow: null, synBal: null, synAllow: null };
    const k = KINDS[V.key], me = d.me || { collateral: 0n, debt: 0n, auctionStart: 0 };
    const room = d.depthCeiling != null && d.debtCeiling != null && d.totalDebt != null ? M.sharedRoom({ debtCeiling: d.debtCeiling, depthCeiling: d.depthCeiling, totalDebt: d.totalDebt }) : null;
    const x = { V, s, d, k, me, room, post: !!pre, sym: /^[A-Za-z0-9]{2,12}$/.test(d.symbol || '') ? d.symbol : k.sym, safe: 2n * s.liq };
    x.paused = d.pB == null || room == null || d.feeBps == null;
    x.auction = me.auctionStart !== 0;
    x.pauseEnd = d.pausedUntil != null ? Number(d.pausedUntil) : 0;
    x.auctionsPaused = x.pauseEnd > chainNow();
    x.value = d.pL != null ? M.valueOf(me.collateral, d.pL) : null;
    x.zone = d.pL != null ? M.zoneOf({ collateral: me.collateral, debt: me.debt, price: d.pL, liq: s.liq }) : null;
    x.ratio = x.value != null && me.debt > 0n ? M.ratioBps(x.value, me.debt) : null;
    x.borrow = x.paused ? null : M.borrowLimit({ collateral: me.collateral, debt: me.debt, pB: d.pB, mint: s.mint, feeBps: d.feeBps, room, minDebt: s.minDebt });
    x.borrowAll = x.paused ? null : M.borrowLimit({ collateral: me.collateral + (d.tacBal ?? 0n), debt: me.debt, pB: d.pB, mint: s.mint, feeBps: d.feeBps, room, minDebt: s.minDebt });
    x.wpaused = me.debt > 0n && d.pB == null;
    x.wmax = x.wpaused ? 0n : M.withdrawLimit({ collateral: me.collateral, debt: me.debt, pB: d.pB, mint: s.mint });
    x.rep = M.repayLimit({ debt: me.debt, balance: d.synBal ?? 0n, minDebt: s.minDebt });
    x.top = d.pL != null && me.debt > 0n ? M.topUp({ collateral: me.collateral, debt: me.debt, price: d.pL, bps: x.safe }) : 0n;
    x.liqPrice = M.liquidationPriceOf(me.collateral, me.debt, s.liq);
    x.line = Number(M.borrowLineBps({ mint: s.mint, pL: d.pL, pB: d.pB }));
    x.px = d.spot != null && d.feed && d.feed.answer > 0n ? d.spot * d.feed.answer / 10n ** BigInt(d.feed.decimals) : null;
    x.feedAge = V.key === 'usd' && d.feed ? Math.max(0, chainNow() - d.feed.updatedAt) : null;
    x.stale = x.feedAge != null && x.feedAge > s.staleness;
    x.cap = d.debtCeiling != null && d.depthCeiling != null ? (d.debtCeiling < d.depthCeiling ? d.debtCeiling : d.depthCeiling) : null;
    x.ownerCap = x.cap != null && d.debtCeiling < d.depthCeiling;
    x.backing = d.held != null && d.pL != null && d.totalDebt > 0n ? M.ratioBps(M.valueOf(d.held, d.pL), d.totalDebt) : null;
    return x;
  }

  const tac = (v) => M.fmtAmount(v, 2);
  const syn = (x, v) => M.fmtAmount(v, x.k.dp);
  const pctOf = (bps) => `${Math.floor(Number(bps) / 100).toLocaleString('en-US')}%`;
  const feeText = (bps) => `${Number(bps) / 100}%`;
  const gasEth = (n) => (F.gas != null ? (Number(BigInt(n * RECORD_GAS) * F.gas) / 1e18).toFixed(4) : null);
  // How many confirmations recording `n` prices takes, when the last `leave` of them go with the person's own transaction (`what`, as "your borrow")
  const recordHint = (n, leave = 0, what = '') => {
    const ride = leave && what && n > leave ? leave : 0, c = Math.ceil((n - ride) / PER_TX), eth = gasEth(n - ride);
    return `Takes ${c} wallet confirmation${c === 1 ? '' : 's'}${eth ? `, about ${eth} ETH` : ''}.${ride ? ` The last ${ride} then go with ${what}.` : ''}`;
  };
  const priceText = (x, p, dir) => x.k.price(M.fmtUnits(M.sigTo(p, 3, dir), 18, 18));

  function planOf(V, t, amtText) {
    const P = planCore(V, t, amtText);
    if (P.ok && P.x?.post && needs(derive(P.x.V), P.kind)) { P.catchUp = P.x.V.post.n; P.via = viaOf(P.x.V); P.rows = [...P.rows, ['Price records', `${P.catchUp} included`]]; }
    return P;
  }
  function planCore(V, t, amtText) {
    const x = V && derive(V, true);
    if (!x) return { ok: false, cta: 'Reading the vault…', rows: [], hint: '' };
    const amt = M.parseUnits(amtText, 18), m = x.me, d = x.d, sym = x.sym, mint = pctOf(x.s.mint);
    const P = { kind: t, x, amt, ok: false, cta: '', rows: [], hint: '', err: false, max: 0n, maxText: '' };
    const after = (collateral, debt) => (d.pL != null && debt > 0n ? M.ratioBps(M.valueOf(collateral, d.pL), debt) : null);
    const ratioRow = (collateral, debt) => { const r = after(collateral, debt), z = d.pL != null ? M.zoneOf({ collateral, debt, price: d.pL, liq: x.s.liq }) : null; P.after = r != null ? { ratio: r, zone: z } : null; return r != null ? [['Ratio after', zone(z, esc(pctOf(r)))]] : []; };
    const fill = (n) => ui.fill(M.plain(n), `Add ${tac(n)} TAC`);
    const typed = amtText.trim() !== '';
    if (typed && amt == null) { P.hint = 'Could not read that amount. Write 1500 or 0.05.'; P.err = true; P.cta = 'Enter an amount'; return P; }
    const none = !amt;

    if (t === 'deposit') {
      const bal = d.tacBal ?? 0n; P.max = bal; P.maxText = who() ? `Balance ${tac(bal)} · Max` : '';
      if (who() && d.tacBal === 0n) P.hint = `This wallet holds no TAC. ${ui.buy}`;
      if (none) { P.cta = 'Enter an amount'; return P; }
      if (amt > bal) { P.cta = 'Not enough TAC'; return P; }
      P.ok = true; P.cta = 'Deposit TAC'; P.amount = amt;
      P.rows = [['Collateral after', `${mk('tac')}${esc(tac(m.collateral + amt))} TAC`], ...ratioRow(m.collateral + amt, m.debt)];
      return P;
    }
    if (t === 'borrow') {
      P.max = x.borrowAll?.amount ?? 0n; P.maxText = x.borrowAll && who() ? `Up to ${syn(x, P.max)} · Max` : '';
      if (x.auction) { P.cta = 'In an auction'; P.hint = 'Borrowing waits until the auction ends. Repay, or add TAC, to end it.'; return P; }
      if (x.paused) {
        const f = feedOf(x.V);
        if (!x.stale && ((!f && !F.tried) || (f && !f.ready && f.missing > 0 && f.missing <= BATCH_MAX && !viaOf(x.V) && viaPending(x.V)))) { P.cta = 'Checking prices…'; return P; }
        if (!x.stale && f && !f.ready && f.missing && viaOf(x.V) && PREP.busy && PREP.vkey === x.V.key) { P.cta = 'Preparing the prices…'; return P; }
        if (!x.stale && f && !f.ready && f.missing) { P.record = f.missing; P.cta = `Record ${f.missing} price${f.missing === 1 ? '' : 's'} to open borrowing`; P.hint = recordHint(f.missing, viaOf(x.V) ? BATCH_MAX : 0, 'your borrow'); return P; }
        P.cta = 'Borrowing is paused'; P.hint = 'Borrowing waits until prices are recorded.'; return P;
      }
      if (none) { P.cta = 'Enter an amount'; return P; }
      const held = d.tacBal ?? 0n, check = (collateral) => M.checkBorrow({ amount: amt, collateral, debt: m.debt, pB: d.pB, mint: x.s.mint, feeBps: d.feeBps, room: x.room, minDebt: x.s.minDebt });
      let c = check(m.collateral), add = 0n;
      P.cta = `Borrow ${sym}`;
      if (!c.ok && c.why === 'own') {
        const need = M.collateralFor(c.owe, d.pB, x.s.mint), exact = need > m.collateral ? need - m.collateral : 0n, least = M.ceilTo(exact, 2);
        const safeAdd = d.pL != null ? M.topUp({ collateral: m.collateral, debt: c.owe, price: d.pL, bps: x.safe }) : 0n, want = safeAdd > least ? safeAdd : least;
        add = held >= want ? want : held >= least ? least : held >= exact ? held : 0n;
        if (!(add > 0n)) { P.err = true; P.hint = `Borrowing this takes ${tac(least)} TAC in the vault. You hold ${tac(held)}.${held === 0n ? ` ${ui.buy}` : ''}`; return P; }
        c = check(m.collateral + add);
      }
      if (!c.ok) {
        P.err = true;
        if (c.why === 'min') P.hint = `Smallest debt is ${syn(x, x.s.minDebt)} ${sym}: borrow at least ${syn(x, M.ceilTo(c.least, x.k.dp))}.`;
        else if (c.why === 'own') P.hint = `You can borrow up to ${syn(x, c.limit)} ${sym} now.`;
        else P.hint = `Only ${syn(x, c.limit)} ${sym} is left to borrow.`;
        return P;
      }
      P.ok = true; P.amount = amt; P.feeBps = d.feeBps; P.add = add;
      const owe = c.owe, r = after(m.collateral + add, owe);
      P.rows = [...(add > 0n ? [['TAC added to your vault', `${mk('tac')}${esc(tac(add))} TAC`]] : []), [`Fee (${feeText(d.feeBps)})`, `${synMk(x)}${esc(syn(x, c.fee))} ${esc(sym)}`], ['You receive', `${synMk(x)}${esc(syn(x, amt))} ${esc(sym)}`], ['You owe after', `${synMk(x)}${esc(syn(x, owe))} ${esc(sym)}`], ...ratioRow(m.collateral + add, owe)];
      if (add > 0n) P.cta = `Deposit ${tac(add)} TAC and borrow`;
      if (r != null && d.pL != null && M.zoneOf({ collateral: m.collateral + add, debt: owe, price: d.pL, liq: x.s.liq }) !== 'safe') {
        const more = M.topUp({ collateral: m.collateral + add, debt: owe, price: d.pL, bps: x.safe });
        P.hint = `That leaves the vault at ${pctOf(r)}, open to redemption. ${add > 0n ? `Deposit ${tac(more)} TAC more first` : fill(more)} to stay at ${pctOf(x.safe)} or more.`;
      }
      return P;
    }
    if (t === 'repay') {
      const bal = d.synBal ?? 0n; P.max = x.rep.max; P.maxText = who() ? `You hold ${syn(x, bal)} · Max` : '';
      if (m.debt === 0n) { P.cta = 'Nothing to repay'; return P; }
      if (bal < m.debt) P.hint = `You hold ${syn(x, bal)} of the ${syn(x, m.debt)} ${sym} you owe.`;
      if (none) { P.cta = 'Enter an amount'; return P; }
      const c = M.checkRepay({ amount: amt, debt: m.debt, balance: bal, minDebt: x.s.minDebt });
      P.cta = c.all ? `Repay all ${sym}` : `Repay ${sym}`;
      if (!c.ok) {
        P.err = true;
        if (c.why === 'balance') P.hint = bal < m.debt ? `You hold ${syn(x, bal)} of the ${syn(x, m.debt)} ${sym} you owe.${x.rep.max > 0n ? ` You can repay up to ${syn(x, x.rep.max)}.` : ''}` : `You hold ${syn(x, bal)} ${sym}.`;
        else P.hint = `Debt left must be zero or at least ${syn(x, x.s.minDebt)} ${sym}. Repay ${m.debt > x.s.minDebt ? `up to ${syn(x, M.floorTo(m.debt - x.s.minDebt, x.k.dp))}, or ` : ''}all ${syn(x, m.debt)}.`;
        if (c.why === 'balance') P.cta = 'Not enough ' + sym;
        return P;
      }
      P.ok = true; P.all = c.all; P.paid = c.paid; P.amount = c.all ? M.MAX_UINT : amt;
      P.rows = [['You owe', `${synMk(x)}${esc(syn(x, m.debt))} ${esc(sym)}`], ['Owed after', `${synMk(x)}${esc(syn(x, c.left))} ${esc(sym)}`], ...(c.left > 0n ? ratioRow(m.collateral, c.left) : [])];
      return P;
    }
    P.max = x.wmax; P.maxText = who() ? `Up to ${tac(x.wmax)} · Max` : '';
    if (x.auction) { P.cta = 'In an auction'; P.hint = 'Withdrawing waits until the auction ends. Repay, or add TAC, to end it.'; return P; }
    if (x.wpaused) {
      const f = feedOf(x.V);
      if (!x.stale && f && !f.ready && f.missing > 0 && f.missing <= BATCH_MAX && !viaOf(x.V) && viaPending(x.V)) { P.cta = 'Checking prices…'; return P; }
      if (!x.stale && f && !f.ready && f.missing && viaOf(x.V) && PREP.busy && PREP.vkey === x.V.key) { P.cta = 'Preparing the prices…'; return P; }
      if (!x.stale && f && !f.ready && f.missing) { P.record = f.missing; P.cta = `Record ${f.missing} price${f.missing === 1 ? '' : 's'} to withdraw`; P.hint = recordHint(f.missing, viaOf(x.V) ? BATCH_MAX : 0, 'your withdrawal'); return P; }
      P.cta = 'Withdrawing is paused'; P.hint = 'With a debt, withdrawing waits until prices are recorded.'; return P;
    }
    if (m.collateral === 0n) { P.cta = 'Nothing to withdraw'; return P; }
    if (none) { P.cta = 'Enter an amount'; return P; }
    P.cta = 'Withdraw TAC';
    if (amt > x.wmax) {
      P.err = true;
      P.hint = m.debt === 0n ? `You have ${tac(m.collateral)} TAC in the vault.` : x.wmax > 0n ? `You can withdraw up to ${tac(x.wmax)} TAC and stay at ${mint}.` : `Every TAC here is needed to keep the vault at ${mint}. Repay some ${sym} first.`;
      return P;
    }
    P.ok = true; P.all = m.debt === 0n && amt >= m.collateral; P.amount = P.all ? M.MAX_UINT : amt;
    P.rows = [['Collateral after', `${mk('tac')}${esc(tac(m.collateral - amt))} TAC`], ...ratioRow(m.collateral - amt, m.debt)];
    return P;
  }


  async function simulate(to, data, from) {
    try { await ethCall(to, data, { from }); return { ok: true }; } catch (e) { return { ok: false, e }; }
  }
  const WHY = {
    limit: (x) => `That would take the vault under ${pctOf(x.s.mint)}.`, room: () => 'There is less room to borrow than that.', auction: () => 'This vault is in an auction.',
    amount: (x) => `That amount is not accepted: a vault’s debt is zero or at least ${syn(x, x.s.minDebt)} ${x.sym}.`, fee: () => 'The borrow fee changed.', paused: () => 'Borrowing waits until prices are recorded.',
    noauction: () => 'There is no auction on this vault.', unhealthy: () => 'The vault has not recovered yet.', healthy: () => 'The vault is healthy.', ownerwindow: () => 'Only the vault’s owner can bid for now.',
    access: (x, kind) => `The ${kind === 'repay' ? x.sym : 'TAC'} was not available to the vault.`, balance: (x, kind) => `Not enough ${kind === 'repay' ? x.sym : 'TAC'}.`,
  };
  const failText = (x, kind, e) => { const w = refusal(e); return `${w && WHY[w] ? WHY[w](x, kind) : 'This would fail.'} Nothing was sent; the figures above are current.`; };
  const errText = (e) => esc(e instanceof UserStopped ? e.message : String(e?.message || e).slice(0, 220));

  async function withAccess({ V, token, amount, allowance, from, make, spender = V.addr, batched = false, check = (data) => simulate(V.addr, data, from) }) {
    if (allowance >= amount) return { data: make(null) };
    if (batched) return { data: make(null), approve: { to: token, data: encApprove(spender, amount) } };
    try {
      say('Sign the permit in your wallet. The signature costs nothing.');
      const [name, nonce] = await Promise.all([ethCall(token, SEL.name), ethCall(token, SEL.nonces + addrWord(from))]);
      const dl = chainDeadline(1200);
      const sig = await askTicket(() => wallet.signPermit({ token, name: decString(name), spender, value: amount, deadline: dl, nonce: wordAt(nonce, 0), owner: from }));
      const data = make({ value: amount, deadline: dl, ...sig });
      say('Checking it first…');
      const sim = await check(data);
      if (sim.ok || sim.ok === null) return { data };
      const why = refusal(sim.e);
      if (why && why !== 'access') throw Object.assign(new Error(why), { sim: sim.e });
    } catch (e) { if (e instanceof UserStopped || e instanceof StopWaiting || e.sim) throw e; }
    say(`Approve in your wallet. It lets the ${spender === V.addr ? 'vault' : 'router'} take exactly this amount.`);
    const h = await askTicket(() => wallet.sendTx({ to: token, data: encApprove(spender, amount), from }));
    say(`Waiting for the approval ${txLink(h)}`);
    if ((await wallet.receipt(h)).status !== '0x1') throw new Error('The approval did not go through.');
    return { data: make(null), approved: true };
  }

  // `kind` is the action shown, `amtText` the amount typed for it and `amtNow()` what is typed by the time the wallet is asked: a change sends nothing
  async function run(V, kind, amtText, amtNow, kindOverride) {
    if (S.busy) return;
    if (!W.account) { hooks.connect(); return; }
    if (!V || !canAct()) return;
    const from = W.account;
    const cancel = kindOverride === 'cancel';
    const typed = amtText, shown = cancel ? null : planOf(V, kind, amtText);
    // the older prices first, from here: the last ones (as many as one transaction carries with the person's own) are left to go with it
    if (shown?.record) { pokeFeed(V, viaOf(V) && shown.record > BATCH_MAX ? BATCH_MAX : 0, shown.kind === 'withdraw' ? 'your withdrawal' : 'your borrow'); return; }
    if (!cancel && !shown.ok) return;
    S.busy = true; hooks.busy(true);
    try {
      say(shown?.catchUp ? 'Reading the vault and the missing prices again…' : 'Reading the vault again…');
      await load();
      if (shown?.catchUp) {
        for (let i = 0; i < 200 && PREP.busy; i++) await new Promise((r) => setTimeout(r, 300));
        await prepare(V);
      }
      const P = cancel ? { kind: 'cancel', x: derive(V) } : planOf(V, kind, amtText);
      if (amtNow() !== typed) throw new Error('The amount changed. Nothing was sent.');
      if (!cancel && !P.ok) { say(`<span class="err">${esc(P.record ? 'The prices changed while this was prepared.' : P.hint || 'That is no longer possible.')} Nothing was sent; the figures above are current.</span>`); return; }
      const x = P.x, owner = from;
      if (P.kind === 'borrow' && P.feeBps > shown.feeBps) { say(`<span class="err">The borrow fee is now ${esc(feeText(P.feeBps))}. Nothing was sent; the figures above are current.</span>`); return; }
      if (P.kind === 'borrow' && (P.add ?? 0n) > (shown.add ?? 0n)) { say(`<span class="err">The TAC to deposit is now ${esc(tac(P.add))}. Nothing was sent; the figures above are current.</span>`); return; }
      const allow = P.kind === 'deposit' ? [P.amount, x.d.tacAllow] : P.kind === 'borrow' && P.add > 0n ? [P.add, x.d.tacAllow] : P.kind === 'repay' ? [P.paid, x.d.synAllow] : null;
      const via = P.catchUp ? viaOf(V) : S.batchOk && allow && (allow[1] ?? 0n) < allow[0] ? 'bundle' : null, post = P.catchUp ? V.post : null;
      let extra = [];
      const bundle = (d) => [...(post ? [{ to: MULTICALL3, data: post.data }] : []), ...extra, { to: V.addr, data: d }];
      const check = via === 'bundle' ? (d) => simulateBundle(rpc, from, bundle(d)) : via === 'router' ? (d) => simulate(ROUTER, d, from) : undefined;
      let target = via === 'router' ? ROUTER : V.addr, carried = 0;
      let data, acc = {};
      if (cancel) {
        const rec = lapsedCure(x) ? postOf(V) : null;
        if (rec) { data = encBatch([...rec.recs.map((r) => ({ to: r.to, data: r.data })), { to: V.addr, data: encCancel(owner) }]); target = MULTICALL3; carried = rec.n; }
        else data = encCancel(owner);
      }
      else if (via === 'router') {
        const records = [encRouterRecords(V.addr, post.recs)];
        const deadline = chainDeadline(300), nonce = wordAt(await ethCall(V.addr, SEL.nonces + addrWord(from)), 0);
        if (P.kind === 'withdraw') {
          say('Sign the withdrawal in your wallet. The signature costs nothing.');
          const sig = await askTicket(() => signTyped(from, withdrawTyped(V.addr, from, { amount: P.amount, nonce, deadline })));
          acc = { data: encMulticall([...records, encRouterWithdraw(V.addr, { amount: P.amount, deadline }, sig)]) };
        } else if (P.kind === 'deposit') {
          const make = (p) => encMulticall([...records, ...(p ? [encPermit('permitTac', p)] : []), encRouterDeposit(V.addr, P.amount)]);
          const allowance = wordAt(await ethCall(x.s.tac, SEL.allowance + addrWord(from) + addrWord(ROUTER)), 0);
          acc = await withAccess({ V, token: x.s.tac, amount: P.amount, allowance, from, spender: ROUTER, check, make });
        } else if (P.kind === 'repay') {
          const make = (p) => encMulticall([...records, ...(p ? [encRouterPermitSynth(V.addr, p)] : []), encRouterRepay(V.addr, P.paid)]);
          const allowance = wordAt(await ethCall(x.s.synth, SEL.allowance + addrWord(from) + addrWord(ROUTER)), 0);
          acc = await withAccess({ V, token: x.s.synth, amount: P.paid, allowance, from, spender: ROUTER, check, make });
        } else {
          const args = { tacIn: P.add ?? 0n, amount: P.amount, maxFeeBps: shown.feeBps, minCollateral: x.me.collateral + (P.add ?? 0n), deadline };
          say('Sign the borrow in your wallet. The signature costs nothing.');
          const sig = await askTicket(() => signTyped(from, borrowTyped(V.addr, from, { ...args, nonce })));
          const make = (p) => encMulticall([...records, ...(p ? [encPermit('permitTac', p)] : []), encRouterBorrow(V.addr, args, sig)]);
          if (args.tacIn > 0n) {
            const allowance = wordAt(await ethCall(x.s.tac, SEL.allowance + addrWord(from) + addrWord(ROUTER)), 0);
            acc = await withAccess({ V, token: x.s.tac, amount: args.tacIn, allowance, from, spender: ROUTER, check, make });
          } else acc = { data: make(null) };
        }
      }
      else if (P.kind === 'deposit') {
        acc = await withAccess({ V, token: x.s.tac, amount: P.amount, allowance: x.d.tacAllow ?? 0n, from, check, batched: via === 'bundle', make: (p) => (p ? encMulticall([encPermit('permitTac', p), encDeposit(P.amount)]) : encDeposit(P.amount)) });
      } else if (P.kind === 'borrow' && P.add > 0n) {
        acc = await withAccess({ V, token: x.s.tac, amount: P.add, allowance: x.d.tacAllow ?? 0n, from, check, batched: via === 'bundle', make: (p) => encMulticall([...(p ? [encPermit('permitTac', p)] : []), encDeposit(P.add), encBorrow(P.amount, shown.feeBps)]) });
      } else if (P.kind === 'borrow') acc = { data: encBorrow(P.amount, shown.feeBps) };
      else if (P.kind === 'repay') {
        acc = await withAccess({ V, token: x.s.synth, amount: P.paid, allowance: x.d.synAllow ?? 0n, from, check, batched: via === 'bundle', make: (p) => { const call = encRepay(owner, P.amount); return p ? encMulticall([encPermit('permitSynth', p), call]) : call; } });
      } else acc = { data: encWithdraw(P.amount) };
      if (acc.approve) extra = [acc.approve];
      data ||= acc.data;
      say('Checking it first…');
      const trial = () => (via === 'bundle' ? simulateBundle(rpc, from, bundle(data)) : simulate(target, data, from));
      let sim = await trial();
      for (let i = 0; i < 3 && sim.ok === false && acc.approved && refusal(sim.e) === 'access'; i++) { await new Promise((r) => setTimeout(r, 1500)); sim = await trial(); }
      if (sim.ok === false) { say(`<span class="err">${esc(failText(x, P.kind, sim.e))}</span>`); load().then(hooks.all).catch(() => {}); return; }
      say(P.catchUp ? `Confirm in your wallet. It records the prices${extra.length ? ', approves the TAC' : ''} and then does this, as one transaction.` : extra.length ? 'Confirm in your wallet. It approves the amount and then does this, as one transaction.' : 'Confirm the transaction in your wallet.');
      const hash = via === 'bundle' ? await askTicket(() => sendAsBundle(from, bundle(data))) : await askTicket(() => wallet.sendTx({ to: target, data, from }));
      say(`Sent ${txLink(hash)}. Waiting for it to land…`);
      const rc = await wallet.receipt(hash);
      if (rc.status !== '0x1') throw new Error(`The transaction failed (${hash.slice(0, 10)}…). Nothing was lost but its network fee.`);
      hooks.sent();
      if (P.catchUp || carried) { for (const v of VS) v.post = null; loadFeed(); }
      await load().catch(() => {});
      const x2 = derive(V), said = { deposit: `Deposited ${tac(P.amount ?? 0n)} TAC.`, borrow: `${P.add > 0n ? `Deposited ${tac(P.add)} TAC and borrowed` : 'Borrowed'} ${P.amount != null ? syn(x2, P.amount) : ''} ${x2.sym}. You owe ${syn(x2, x2.me.debt)}.`, repay: x2.me.debt === 0n ? `Repaid. Nothing owed now.` : `Repaid. You owe ${syn(x2, x2.me.debt)} ${x2.sym}.`, withdraw: 'Withdrawn.', cancel: 'The auction has ended.' }[P.kind];
      const recs = P.catchUp || carried;
      say(`<span class="ok">${esc(said + (recs ? ` Recorded ${recs} price${recs === 1 ? '' : 's'} with it.` : ''))}</span> ${txLink(hash)}${P.kind === 'borrow' ? ` <button class="linkbtn" type="button" data-watch="${esc(V.key)}">Add ${esc(x2.sym)} to your wallet</button>` : ''}`);
      setTimeout(() => { if (!S.busy) load().then(hooks.all).catch(() => {}); }, 5000);
    } catch (e) {
      const x = derive(V);
      say(e instanceof StopWaiting ? esc(e.message) : `<span class="err">${e.sim ? esc(failText(x, kind, e.sim)) : errText(e)}</span>`);
    } finally { S.busy = false; hooks.busy(false); }
  }

  const busyNote = (ms) => { if (F.busy) setFeed(`The public nodes are busy. Trying again in ${Math.ceil(ms / 1000)} s…`); };
  // `ticket`: the recording under way was started from the ticket, which shows its progress too
  const F = { by: {}, busy: false, note: '', bad: false, gas: null, at: 0, stop: null, ticket: false };
  const ALREADY = '0x103b4afe';
  const WALLET_HINT_MS = 20e3;
  const feedOf = (V) => (V ? F.by[V.key] || null : null);
  const oracleOf = (V) => V.oracle || V.addr;
  const keepFeed = (V, st) => { for (const m of VS) if (oracleOf(m) === oracleOf(V)) F.by[m.key] = st; };
  const VENUE = ['Precision pool', 'Tacit pool'];
  const setFeed = (note, bad = false) => {
    F.note = note; F.bad = bad;
    hooks.feedNote(note, bad);
    if (F.ticket) say(bad ? `<span class="err">${note}</span>` : note);
  };

  async function loadFeed() {
    if (!VS.length || F.busy) return;
    const firsts = [...new Map(VS.map((v) => [oracleOf(v), v])).values()];
    await Promise.all(firsts.map(async (V) => { try { keepFeed(V, await feed.read(V.addr)); F.at = now(); } catch (e) { console.warn('price feed read:', e?.message || e); } }));
    try { F.gas = BigInt(await rpc('eth_gasPrice', [])); } catch { }
    F.tried = true;
    hooks.feed();
  }

  function waitWallet(send, onHint, hold) {
    const hint = setTimeout(onHint, WALLET_HINT_MS);
    const stopped = new Promise((_, no) => { hold.stop = () => no(new StopWaiting()); });
    return Promise.race([send(), stopped]).finally(() => { clearTimeout(hint); hold.stop = null; });
  }
  const askWallet = (send, round) => waitWallet(send, () => setFeed(`Waiting for your wallet to confirm batch ${round}. Open it to answer, or <button class="linkbtn" type="button" data-feed-stop>stop waiting</button>.`), F);
  const askTicket = (send) => waitWallet(send, () => say(`Waiting for your wallet. Open it to answer, or ${ui.stop}.`), S);
  async function verifiedRecords(part, recs, note) {
    const pack = () => encBatch(recs.map((r) => ({ to: r.to, data: r.data })));
    let data = pack(), sim = await simulate(MULTICALL3, data, W.account);
    for (let again = 1; !sim.ok && again <= 2; again++) {
      const each = await Promise.all(recs.map((r) => simulate(r.to, r.data, W.account)));
      const bad = each.flatMap((r, i) => (!r.ok && !String(r.e?.data || '').startsWith(ALREADY) ? [i] : []));
      if (!bad.length) break;
      note(`Building ${bad.length} record${bad.length === 1 ? '' : 's'} again…`);
      const fresh = await Promise.all(bad.map((i) => feed.buildRecord(...part[i], undefined, again)));
      bad.forEach((i, j) => { recs[i] = fresh[j]; });
      data = pack(); sim = await simulate(MULTICALL3, data, W.account);
    }
    if (!sim.ok) {
      const each = await Promise.all(recs.map((r) => simulate(r.to, r.data, W.account)));
      const bad = each.find((r) => !r.ok && !String(r.e?.data || '').startsWith(ALREADY));
      if (bad) throw new Error(`A record would fail (${String(bad.e?.message || 'refused').slice(0, 120)}). Nothing was sent.`);
      return null;
    }
    return { data };
  }

  const POST_TTL = 10 * 60;
  const PREP = { busy: false, vkey: null, failedAt: 0, last: null };
  const viaOf = (V) => (S.batchOk ? 'bundle' : ROUTER && !S.routerOff && S.routerFor?.has(V.addr.toLowerCase()) ? 'router' : null);
  const viaPending = () => now() - BOOT < 12 && ((ROUTER && !S.routerSettled) || S.batchBusy);
  async function checkRouter() {
    if (!ROUTER) return;
    try {
      const [a, b] = await Promise.all([ethCall(ROUTER, ROUTER_SEL.vaultA), ethCall(ROUTER, ROUTER_SEL.vaultB)]);
      S.routerFor = new Set([addrAt(a), addrAt(b)].map((x) => x.toLowerCase()));
      hooks.all();
    } catch { } finally { S.routerSettled = true; hooks.all(); }
  }
  const addrAt = (hex) => `0x${String(hex).replace(/^0x/, '').slice(24, 64)}`;
  const missingKey = (st) => st.venues.map((v) => v.missing.join()).join('|');
  async function detectBatch() {
    const a = W.account ? W.account.toLowerCase() : null;
    if (a === S.batchFor) return;
    S.batchFor = a; S.batchOk = false;
    if (!a) { S.batchBusy = false; hooks.all(); return; }
    S.batchBusy = true;
    const ok = await batchSupport(W.prov, W.account).catch(() => false);
    if (S.batchFor !== a) return;
    S.batchBusy = false; S.batchOk = ok;
    hooks.all();
  }
  // the price records a vault's next action (`t`) would carry, built ahead while the holder looks at it
  function maybePrepare(V, t) {
    if (!V || !canAct() || S.busy || F.busy || PREP.busy || now() - PREP.failedAt < 60) return;
    const x = derive(V), st = feedOf(V);
    if (!x || !st || st.ready || x.stale || !st.missing || st.missing > BATCH_MAX) return;
    if (!(viaOf(V) && needs(x, t)) && !lapsed(x)) return;
    const have = postOf(V), key = missingKey(st);
    if (have && have.key === key) return;
    if (PREP.last && PREP.last.key === key && now() - PREP.last.at < 60) return;
    prepare(V).then(hooks.all);
  }
  async function prepare(V) {
    const from = W.account, who0 = (from || '').toLowerCase();
    if (!who0 || PREP.busy) return false;
    PREP.busy = true; PREP.vkey = V.key; hooks.ticket();
    try {
      const st = await feed.read(V.addr);
      keepFeed(V, st);
      if ((who() || '').toLowerCase() !== who0) return false;
      PREP.last = { key: missingKey(st), at: now() };
      if (!st.missing || st.missing > BATCH_MAX) { V.post = null; return false; }
      const part = feed.nextBatch(st, BATCH_MAX), keyOf = (v, k) => `${v.oracle}:${k}`;
      const kept = new Map((V.post?.recs || []).map((r) => [`${r.to}:${r.k}`, r]));
      const fresh = part.filter(([v, k]) => !kept.has(keyOf(v, k)));
      (fresh.length ? await feed.build(fresh) : []).forEach((r) => kept.set(`${r.to}:${r.k}`, r));
      const recs = part.map(([v, k]) => kept.get(keyOf(v, k)));
      const checked = await verifiedRecords(part, recs, () => {});
      if (!checked) { console.warn('price records: others recorded some while this was built'); return false; }
      const vs = VS.filter((m) => m.s && oracleOf(m) === oracleOf(V));
      const reads = vs.map((m) => dynamicCalls(m, from).map(([, to, data]) => ({ to, data })));
      const res = await readMixed(ethCall, [...recs.map((r) => ({ to: r.to, data: r.data, allowFailure: false })), ...reads.flat()]);
      let at = recs.length;
      const ds = vs.map((m, i) => { const d = parseDynamic(m, from, res.slice(at, at + reads[i].length)); d.who = from; at += reads[i].length; return [m, d]; });
      const d = ds.find(([m]) => m === V)[1];
      if (!(readable(d) || d.recovered != null)) { console.warn('price records: the records alone would not open the vault'); for (const m of vs) m.post = null; return false; }
      for (const [m, dm] of ds) m.post = { who: who0, key: missingKey(st), recs, data: checked.data, d: dm, n: recs.length, at: now() };
      return true;
    } catch (e) {
      PREP.failedAt = now(); for (const m of VS) if (oracleOf(m) === oracleOf(V)) m.post = null;
      console.warn('price records:', e?.message || e);
      return false;
    } finally { PREP.busy = false; }
  }
  const NO_BATCH = new Set([4200, 5700, 5710, 5740, 5750, 5760, -32601]);
  const stopped = (e) => (e?.code === 4001 || /user (rejected|denied)|rejected the request|request rejected|denied (transaction|message)/i.test(e?.message || '') ? new UserStopped() : e);
  async function signTyped(from, typed) {
    if (String(W.account || '').toLowerCase() !== from.toLowerCase()) throw new Error('The wallet’s account changed. Nothing was sent; review it again.');
    await wallet.ensureMainnet();
    try { return String(await W.prov.request({ method: 'eth_signTypedData_v4', params: [from, JSON.stringify(typed)] })); } catch (e) {
      const s = stopped(e);
      if (s instanceof UserStopped) throw s;
      S.routerOff = true; for (const v of VS) v.post = null;
      throw new Error('Your wallet could not sign this. Nothing was sent: record the prices first, then try again.');
    }
  }
  async function sendAsBundle(from, calls) {
    if (String(W.account || '').toLowerCase() !== from.toLowerCase()) throw new Error('The wallet’s account changed. Nothing was sent; review it again.');
    await wallet.ensureMainnet();
    try { return await sendBundle(W.prov, from, calls); } catch (e) {
      if (stopped(e) instanceof UserStopped) throw new UserStopped();
      if (NO_BATCH.has(e?.code)) { S.batchOk = false; for (const v of VS) v.post = null; throw new Error('Your wallet could not send these together. Nothing was sent: record the prices first, then try again.'); }
      throw e;
    }
  }

  // A batch whose estimate is over GAS_ROOM keeps its newest records and leaves the rest for the next round (a node that does not estimate leaves it as it is).
  async function fitBatch(recs, data) {
    const gas = await rpc('eth_estimateGas', [{ from: W.account, to: MULTICALL3, data }]).then((g) => Number(BigInt(g)), () => null);
    if (gas == null || gas <= GAS_ROOM || recs.length < 2) return { recs, data };
    const keep = Math.max(1, Math.floor(recs.length * GAS_ROOM / gas));
    return { recs: recs.slice(0, keep), data: encBatch(recs.slice(0, keep).map((r) => ({ to: r.to, data: r.data }))) };
  }
  // Records the missing prices, a batch to a confirmation, until at most `leave` are missing. Started from the ticket (`what`: "your borrow"), its progress shows there
  // too, and once the rest can go with the person's own transaction the ticket takes over.
  async function pokeFeed(V0, leave = 0, what = '') {
    if (F.busy) return;
    if (!W.account) { await hooks.connect(); return; }
    F.busy = true; F.ticket = !!what; hooks.feed();
    try {
      for (let round = 1; round <= 12; round++) {
        const V = V0, st = await feed.read(V.addr);
        keepFeed(V, st);
        hooks.feed();
        if (st.missing <= leave) break;
        const part = feed.nextBatch(st, Math.min(PER_TX, st.missing - leave));
        setFeed(`Building ${part.length} record${part.length === 1 ? '' : 's'} (batch ${round})…`);
        const recs = await feed.build(part);
        const checked = await verifiedRecords(part, recs, setFeed);
        if (!checked) { setFeed('Someone else is recording too; reading again…'); continue; }
        const fit = await fitBatch(recs, checked.data), data = fit.data;
        setFeed(`Confirm batch ${round} of ${round - 1 + Math.ceil((st.missing - leave) / PER_TX)} in your wallet (${fit.recs.length} record${fit.recs.length === 1 ? '' : 's'}).`);
        const hash = await askWallet(() => wallet.sendTx({ to: MULTICALL3, data, from: W.account }), round);
        setFeed(`Sent ${txLink(hash)}. Waiting for it to land…`);
        const rc = await wallet.receipt(hash);
        if (rc.status !== '0x1') throw new Error(`The transaction failed (${hash.slice(0, 10)}…). Nothing more was sent.`);
        setFeed(`Batch ${round} recorded ${txLink(hash)}.`);
      }
      F.busy = false; await loadFeed();
      const left = feedOf(V0)?.missing;
      if (feedOf(V0)?.ready) { setFeed('The price feed is up to date.'); if (what) { F.ticket = false; say(`The prices are recorded: check the amount for ${what}, then press the button.`); hooks.focusAmount(); } }
      else if (leave && left <= leave) {
        setFeed(`The older prices are recorded. The last ${left} go with ${what || 'your transaction'}.`);
        // the ticket takes over: its button now does the person's own transaction, with the last records in it
        if (what) { F.ticket = false; say(`The older prices are recorded. The last ${left} go with ${what}: check the amount, then press the button.`); hooks.focusAmount(); }
      } else setFeed('Recorded what could be. Some newer prices still need adding: record again.');
    } catch (e) {
      F.busy = false;
      setFeed(errText(e), !(e instanceof UserStopped || e instanceof StopWaiting));
    } finally { F.busy = false; F.ticket = false; await loadFeed(); hooks.refresh(); }
  }
  return {
    load, derive, readable, setFeed, busyNote, lapsedCure, postOf, lapsed, needs, planOf, run, loadFeed, pokeFeed, prepare, maybePrepare, checkRouter, detectBatch,
    feedOf, oracleOf, viaOf, viaPending, F, PREP, VENUE, recordHint, gasEth, tac, syn, pctOf, feeText, priceText, chainNow, chainDeadline, now,
    get ethCall() { return ethCall; }, get batch() { return batch; },
  };
}
