// TAC's page. index.html imports this when TAC's page opens (its address, /tac/, preloads it) or a link to it is pointed at, and calls
// install() with what this code reads from its module: let and var bindings are read as ctx.X, so their changes there are seen here.
export default function install(ctx) {
const { $, $$, ADDR, BR, BRM, BR_SEEN, BR_TO_ON, BSW, BTC, BTC_TOKENS, CETH_POOL_ASSET_ID, CHAIN_HOP_WAIT, CHAIN_SWEEP, CSEND, E10, FLASH, HELD, HX, HXWB, MEMPOOL, NOTIFY_KEY, P, PERMIT_WAIT, S, TACB, TACSEND, TAC_BOOK, TAC_BTC_ID, TAC_POOL_ASSET_ID, TPG_FLOOR, TPG_KNOWN, TPG_KNOWN_AT, TPX, XA, acctUsed, actBtc, addressId, ago, assetSendForm, brAct, brBridgeNow, brCheckText, brDiscover, brFail, brFirst, brId, brList, brLongReason, brMarkDeep, brMarkEmpty, brOver, brPaid, brPrepSet, brPrepState, brPrepTick, brPreps, brRecords, brRow, brTk, brTransfers, brTry, brUx, bridgeRunAll, bridgeRunMerge, bswHas, bswMod, bswOpen, bswTick, bulkFee, busy, byValue, bytesToHex, calmMotion, chainAhead, chainCap, chainCapLine, chainClient, chainHeld, chainHopRun, chainInRun, chainMark, chainMods, chainNotTo, chainOn, chainOutRun, chainOverCap, chainPayRun, chainQuote, chainRecipient, chainSaid, chainScan, chainSentLine, chainSettle, chainShieldAhead, chainShieldRun, chainSweepFee, chainWarm, chainWayOf, chainWrapWarm, clearField, connect, copy, countAll, dashSoon, decodeTacitAddress, depositCallout, devBal, devOn, errText, ethCall, evm, fastRoute, fmt, freeNotes, gasNow, getUx, hexToBytes, html, hxChainEth, hxLive, hxPreset, hxUsd, hxWalletBal, hxWays, keep, keyRow, load, loadBridge, loadBtc, loadHeld, loadTacHoldings, loadTacPrice, loadTacit, mergeSend, mount, multicall, nameAddrM, needKey, onEdit, openSheet, opsCompared, ownNow, parseUnits, payer, plain, planAll, planMerge, privateOf, qrModule, quoteErr, readPublicTac, render, rerender, resolveTo, resolveToM, satsFmt, say, sayErr, scanPrivate, segSub, setNotify, setPayer, shLookingNote, short, shown, shownAs, sig, sleep, spendable, startNote, stepLi, store, strip, syncLink, tacPageOpen, tacPublicNow, tacWrapNow, tacitIsMine, tacitLanes, takeDraft, tcardQuoteSoon, toSelf, toast, tpgAct, tpgBusy, tpgPrice, viewAddr, vouchers, walletPriv, warn, wireFinish, wireSub, withKey, xoOn, xoOut, xoShown, your } = ctx;
function idMark(a, size = 40) {
  const h = addressId(a).replace(/·/g, ''), hue = Math.round((parseInt(h.slice(0, 2), 16) / 256) * 360);
  let bits = parseInt(h.slice(2, 10), 16), d = '';
  for (let y = 0; y < 5; y++) for (let x = 0; x < 3; x++, bits = Math.floor(bits / 2)) if (bits % 2) d += `M${x} ${y}h1v1h-1z` + (x < 2 ? `M${4 - x} ${y}h1v1h-1z` : '');
  return html`<svg class="idm" viewBox="-1 -1 7 7" width="${size}" height="${size}" aria-hidden="true"><rect x="-1" y="-1" width="7" height="7" rx="1.4" fill="hsl(${hue} 42% 90%)"/><path d="${d}" fill="hsl(${hue} 58% 34%)"/></svg>`;
}
const notifyOffer = () => typeof Notification === 'function' && Notification.permission !== 'denied' && !(store.get(NOTIFY_KEY) && Notification.permission === 'granted');
function loadPrivateAmm() {
  if (TPX.amm !== undefined || TPX.ammP) return TPX.ammP || Promise.resolve();
  TPX.ammErr = false;
  return (TPX.ammP = (async () => {
    const ux = await getUx();
    let failed = false;
    for (const fee of [30, 5, 100, 1]) {
      const r = await ux.poolReserves(ux.routePoolId(CETH_POOL_ASSET_ID, TAC_POOL_ASSET_ID, fee)).catch(() => { failed = true; return null; });
      if (r?.reserveA > 0n && r.reserveB > 0n) { TPX.amm = Number(r.reserveA) / Number(r.reserveB); return; }
    }
    if (failed) throw new Error('private pool unread');
    TPX.amm = null;
  })().catch(() => { TPX.ammErr = true; }).finally(() => { TPX.ammP = null; }));
}
function paintTacPrice() {
  const box = $('#tac-px'), v = TPX.v;
  if (!box) return;
  if (!v?.mid) { box.hidden = true; return; }
  const sats = (eth) => (v.ethBtc ? (eth / v.ethBtc) * 1e8 : null), ethOfSats = (n) => (v.ethBtc ? (n / 1e8) * v.ethBtc : null);
  const usd = v.ethBtc && v.usdBtc ? (v.mid / v.ethBtc) * v.usdBtc : null;
  const gap = (eth) => (eth == null ? '' : `${eth >= v.mid ? '+' : '−'}${Math.abs((eth / v.mid - 1) * 100).toFixed(1)}%`);
  const row = (name, what, eth, satsV, cmp = gap(eth)) => html`<tr><th scope="row">${name}<small>${what}</small></th>
    <td>${eth == null ? '—' : `${sig(eth)} ETH`}<small>${satsV == null ? '' : `${satsFmt(satsV)} sats`}</small></td><td>${cmp}<small>&nbsp;</small></td></tr>`;
  const open = box.open;
  const head = html`<span>TAC</span><b class="num">${sig(v.mid)} ETH</b><span class="mute num">${sats(v.mid) != null ? `${satsFmt(sats(v.mid))} sats` : ''}${usd != null ? ` · $${usd.toFixed(usd < 1 ? 3 : 2)}` : ''}</span><span class="more">Where it trades</span>`;
  const body = html`<table class="num"><thead><tr><th scope="col"><span class="sr">Where</span></th><th scope="col"><span class="sr">Mid price</span></th><th scope="col"><span class="sr">Against the Precision pool</span></th></tr></thead><tbody>
      ${row('Precision pool', 'Ethereum, the deepest', v.mid, sats(v.mid), 'reference')}
      ${row('Tacit AMM', 'Ethereum, public', v.amm, v.amm == null ? null : sats(v.amm))}
      ${row('Private AMM', 'in the Tacit pool', TPX.amm ?? null, TPX.amm ? sats(TPX.amm) : null, TPX.amm === undefined ? (TPX.ammErr ? '—' : '…') : gap(TPX.amm ?? null))}
      ${v.mark ? row('Bitcoin order book', 'recent trades', ethOfSats(v.mark), v.mark) : ''}
      ${v.ask ? row(html`<span class="sr">Bitcoin order book</span>`, 'cheapest ask now', ethOfSats(v.ask), v.ask) : ''}
    </tbody></table>
    <p class="note">Mid prices, against the Precision pool’s. Sats and ETH meet at the collateral engine’s BTC price. <a href="${TAC_BOOK}">The Bitcoin order book →</a></p>`;
  const sum = box.querySelector(':scope > summary');
  if (sum) {
    if (sum.innerHTML !== head.s) mount(sum, head);
    while (sum.nextSibling) sum.nextSibling.remove();
    sum.insertAdjacentHTML('afterend', body.s);
  } else mount(box, html`<summary>${head}</summary>${body}`);
  box.open = open;
  box.hidden = false;
  box.ontoggle = () => { if (!box.open) return; if (TPX.amm === undefined) loadPrivateAmm().then(paintTacPrice); loadTacPrice(false, true).then(paintTacPrice, () => {}); };
}
render.tac = () => {
  tcoPaint();
  tpgTop($('#tpg-top'));
  tcard();
  tpgWhy($('#tpg-earn'));
  renderTacBal($('#tac-bal'));
  paintTacPrice();
  renderBridge($('#bridge-body'));
  tpgNets($('#tpg-nets'));
  tacPoolPlace();
};
load.tac = () => {
  if (chainOn() && !S.key) (window.requestIdleCallback || setTimeout)(() => chainMods().catch(() => {}));
  loadTacPrice(false, !!$('#tac-px')?.open).then(paintTacPrice).catch(() => {});
  if (S.key) loadHeld().then(() => rerender('tac'), () => {});
  tpgWhyRead();
  return Promise.all([BRM.mode === 'out' ? Promise.resolve() : loadBridge(), loadTacHoldings()]);
};
const brArrived = (pub) => {
  const seen = new Set(store.get(BR_SEEN)?.[pub] || []);
  return brList(pub).filter((r) => r.stage === 'minted' && brTk(r) === 'TAC' && !seen.has(r.id) && Date.now() - (r.mintedAt || 0) < 3 * 86400e3)
    .sort((a, b) => (b.mintedAt || 0) - (a.mintedAt || 0));
};
const BR_REASON = { unconfirmed: 'Waiting for its Bitcoin confirmation' };
const brReason = (r) => BR_REASON[r] || (/beta limit/.test(r || '') ? html`Over 1,000 TAC, the most one bridge takes. <a href="/classic.html" target="_blank" rel="noopener">Split it in the classic app</a> first.`
  : /stealth/.test(r || '') ? html`Received privately: <a href="/classic.html" target="_blank" rel="noopener">open it in the classic app</a> first.` : r);
const brNote = (n) => brOver(n) ? html`<div class="brn brsp"><span><b class="num">${fmt(BigInt(n.amount), 8, 4)} TAC</b><small>Over 1,000 TAC, the most one bridge takes. Split some off to your own address, then bridge that.</small></span>
  <div class="amt"><input id="brsp-${n.txid.slice(0, 8)}-${n.vout}" inputmode="decimal" value="1000" autocomplete="off" aria-label="TAC to split off"><span class="u">TAC</span></div>
  <button class="btn ghost" type="button" data-brsplit="${brId(n)}" data-brsplit-in="brsp-${n.txid.slice(0, 8)}-${n.vout}">Split off</button></div>`
  : html`<label class="pick brn${n.eligible ? '' : ' off'}"><input type="radio" name="br-note" value="${brId(n)}" ${n.eligible ? '' : 'disabled'} ${BR.pick === brId(n) ? 'checked' : ''}>
  <span><b class="num">${fmt(BigInt(n.amount), 8, 4)} TAC</b>${!n.eligible ? html`<small>${brReason(n.reason)}</small>` : brFirst(n) ? html`<small>${brFirst(n)}</small>` : ''}</span></label>`;
function brMarkLong(el, n, step) {
  BR.deep.set(brId(n), step);
  const lab = $(`input[name="br-note"][value="${brId(n)}"]`, el)?.closest('label');
  if (!lab) return;
  lab.classList.add('off');
  $('span', lab)?.insertAdjacentHTML('beforeend', html`<small>${brLongReason(step)}</small>`.s);
}
async function bswOffer(box, n) {
  if (!(await bswMod()).DESK) return;
  const s = await bswOpen(), q = s ? await s.quote(n.amount).catch(() => null) : null;
  if (!box.isConnected || !q?.id) return;
  mount(box, html`<p class="note">Or swap it on Bitcoin for ${fmt(BigInt(q.out), 8, 4)} TAC that bridges in one step, in about a day.</p><button class="btn ghost" type="button" id="br-swapgo">Swap it</button>`);
  const go = $('#br-swapgo', box);
  go.onclick = () => busy(go, async () => {
    await s.start({ txid: n.txid, vout: n.vout, value: n.sats, amount: BigInt(n.amount), blinding: BigInt(n.blinding) }, q);
    BSW.recs = await s.records();
    rerender('tac');
  });
}
const bswRow = (r) => html`<li class="brr"><span><b class="num">${fmt(BigInt(r.amount), 8, 4)} TAC</b><small>${BSW.say?.(r) || ''}</small></span></li>`;
const brPrepAdd = (pub, p) => brPrepSet(pub, [...brPreps(pub).filter((x) => x.txid !== p.txid), p]);
const fastTakesAny = () => fastRoute().then((fr) => fr && fr.providers()).then((ps) => !!ps && ps.some((p) => p.terms && p.terms.anyTac)).catch(() => false);
const BR_HOLD = { gone: 'the note is not at this key’s Bitcoin address', check: 'it did not pass its check', untracked: 'Bitcoin’s proof does not track it', sats: 'this key’s Bitcoin address has too few sats free for the fee', fee: 'the Bitcoin fee is now over twice what was quoted' };
function brPrepRow(p) {
  const st = brPrepState(p), amt = `${fmt(BigInt(p.amount), 8, 4)} TAC`, at = { sent: 0, proof: 1, ready: 3 }[st], num = (n) => n.toLocaleString('en-US');
  const proof = Number(BR.refl), gap = st === 'proof' && Number.isInteger(proof) && proof > 0 ? ` The proof is at Bitcoin block ${num(proof)}, ${num(p.height - proof)} block${p.height - proof === 1 ? '' : 's'} to go.` : '';
  const auto = !!p.plan?.auto && !p.autoHold, own = ' It is then bridged for you, while this page is open with your wallet.';
  const text = st === 'sent' ? `Sent to your own address. Waiting for its Bitcoin confirmation, usually within the hour.${p.plan?.auto ? own : ''}`
    : st === 'proof' ? `Confirmed in Bitcoin block ${num(p.height)}. It can be bridged once Bitcoin’s proof on Ethereum reaches that block, usually within a few hours.${gap}${p.plan?.auto ? own : ''}`
    : auto ? 'Ready. It is being bridged for you now: it moves to On the way within a few minutes, while this page is open with your wallet.'
    : p.plan?.auto ? `Ready, but it was not bridged for you: ${BR_HOLD[p.autoHold] || 'it needs a check'}. It is looked at again every few minutes; Bridge it picks it below to go now.`
    : 'Ready. Bridge it picks it below; then check the fee and confirm.';
  const due = st === 'ready' && !auto;
  return html`<li class="actr brr">
    <div class="actr-h"><b class="num">${amt}</b><span>${due ? html`<b class="brdue">Your turn</b> · ` : ''}Sent ${ago(p.at)}</span></div>
    <ol class="stp">${['Sent', 'Confirmed', 'Ready'].map((l, i) => stepLi(l, i < at ? 'done' : i === at ? 'now' : ''))}</ol>
    <div class="actr-f">${text}</div>
    <div class="actr-f brl"><a href="${MEMPOOL}/tx/${p.txid}" target="_blank" rel="noopener">${chainMark('btc')}${short(p.txid, 6)} ↗</a></div>
    ${st === 'ready' ? html`<div class="brr-a"><button class="btn" type="button" data-brprep="${p.txid}">Bridge it</button></div>` : ''}
  </li>`;
}
function renderBridge(el) {
  const pub = S.key?.pubHex;
  if (!pub ? !xoOn(XA.tac) : !xoShown(pub, XA.tac)) BRM.mode = 'in';
  if (!pub || !xoShown(pub, XA.tac)) return renderBridgeIn(el);
  mount(el, html`${segSub('brm', BRM.mode, [['in', 'From Bitcoin'], ['out', 'To Bitcoin']])}<div id="brm-form"></div><div class="status" role="status" id="bt-status"></div>`);
  wireSub(el, 'brm', (m) => { BRM.mode = m; delete FLASH['bt-status']; keep($('#sheet-tac'), render.tac); });
  if (BRM.mode !== 'out') return renderBridgeIn($('#brm-form'));
  if (!P.scan && !P.scanning && !P.err) scanPrivate().then(() => rerender('tac')).catch(() => rerender('tac'));
  xoOut($('#brm-form'), $('#bt-status'), XA.tac);
}
function renderBridgeIn(el) {
  if (!needKey(el, BRM.mode === 'out' ? 'Burn private TAC on Ethereum and it arrives on your own Bitcoin address, usually within a few hours.'
    : 'Bring TAC from your Bitcoin address into your private TAC on Ethereum, usually within a few hours.', 'btc')) return;
  const pub = S.key.pubHex, b = BR.pub === pub ? BR : null;
  if (!b?.notes && !BR.loading && !b?.err) loadBridge().then(() => rerender('tac')).catch(() => {});
  brDiscover(pub, true);
  const recs = brRecords(pub), done = brArrived(pub), notes = (b?.notes || []).filter((n) => n.reason !== 'already bridging').map(brMarkDeep).map(brMarkEmpty), open = notes.filter((n) => n.eligible);
  const preps = brPreps(pub);
  if (preps.some((p) => !p.height || brPrepState(p) !== 'ready')) brPrepTick().catch(() => {});
  const swaps = BSW.pub === pub ? BSW.recs.filter((r) => r.phase !== 'refunded' && !(r.phase === 'done' && Date.now() / 1000 - (r.doneAt || 0) > 86400)) : [];
  if (bswHas(pub) && BSW.pub !== pub) bswTick(true).catch(() => {});
  if (BR.pick && !open.some((n) => brId(n) === BR.pick)) BR.pick = null;
  if (!BR.pick && open.length === 1) BR.pick = brId(open[0]);
  const capRaw = ctx.T ? BigInt(ctx.T.bridgeUx().BURNDEP_BETA_CAP_RAW) : 0n;
  const plans = capRaw && open.length > 1 ? { merge: planMerge(notes, { capRaw }), all: planAll(notes, { capRaw }) } : null;
  const bulk = plans && countAll(plans.all) > 1 ? plans : null;
  if (BR.act && (!bulk || (BR.act === 'merge' && !bulk.merge.groups.length))) BR.act = null;
  if (BR.act) BR.pick = null;
  mount(el, html`
    <p class="lede-s">TAC on your Bitcoin address becomes private TAC on Ethereum. You pay a Bitcoin fee, in sats. It arrives once Bitcoin’s proof on Ethereum records the burn, usually a few hours, up to a day. Tick the receipt’s choice to arrive as public TAC (ERC20), or press Withdraw after. <a href="/bridge/">How the bridge is proven</a></p>
    ${ctx.brLooking === pub ? html`<p class="note">Looking through your Bitcoin history for bridges this browser has no record of…</p>` : ''}
    ${preps.length || swaps.length ? html`<div class="lbl"><span>Getting ready</span></div><ul class="acts brs">${preps.map(brPrepRow)}${swaps.map(bswRow)}</ul>` : ''}
    ${recs.length ? html`<div class="lbl"><span>On the way</span></div><ul class="acts brs">${recs.map(brRow)}</ul>` : ''}
    ${done.length ? html`<div class="lbl"><span>Arrived</span></div><ul class="acts brs">${done.map(brRow)}</ul>` : ''}
    ${recs.length || done.length ? html`<div class="status" role="status" id="br-rstatus"></div>` : ''}
    ${recs.length && notifyOffer() ? html`<div class="actr-f"><button class="link" type="button" id="br-notify">Tell me when a bridge arrives or needs me</button>: a notice from this browser while this tab is in the background.</div>` : ''}
    <div class="lbl"><span>TAC on Bitcoin</span>${b?.notes ? html`<button type="button" id="br-re">refresh</button>` : ''}</div>
    ${!b?.notes ? (b?.err ? html`<p class="note err">${errText(b.err)} <button class="link" type="button" id="br-re">Try again</button></p>` : html`<p class="note">Reading your TAC on Bitcoin…</p>`)
      : !notes.length ? html`<p class="note">No TAC on this key’s Bitcoin address. <a href="#bitcoin/receive" data-link="bitcoin/receive">Receive TAC on Bitcoin</a>${xoShown(pub, XA.tac) ? ' TAC bridged from Ethereum is listed under To Bitcoin.' : ''}</p>`
      : html`<div class="brns" role="radiogroup" aria-label="TAC to bridge">${notes.map(brNote)}</div>${notes.length > 1 ? html`<p class="note">Each amount is one note on Bitcoin and goes whole.</p>` : ''}
        ${bulk ? html`<div class="brr-a brall">${bulk.merge.groups.length ? html`<button class="btn ghost" type="button" id="br-merge" aria-pressed="false">Merge notes</button>` : ''}<button class="btn ghost" type="button" id="br-all" aria-pressed="false">Bridge all</button></div>
        <div class="rcpt" id="br-allp" hidden></div>` : ''}`}
    <div class="rcpt" id="br-rcpt" hidden></div>
    ${BR_TO_ON ? html`<div id="br-towrap" hidden>
      <div class="amt text"><input id="br-to" placeholder="Send it to someone else: their Tacit address or name" autocomplete="off" spellcheck="false" autocapitalize="off" autocorrect="off" aria-label="Send it to someone else"></div>
      <div class="status" role="status" id="br-tos"></div></div>` : ''}
    <label class="pick" id="br-ackrow" hidden><input type="checkbox" id="br-ack"><span id="br-acktext">I understand a bridge can’t be undone once its burn confirms on Bitcoin.</span></label>
    <button class="btn" type="button" id="br-go" disabled>Bridge to Ethereum</button>
    <div class="status" role="status" id="br-status"></div>
    <details class="lockmore"><summary>A bridge you started is not listed</summary>
      <p class="note">One started on another device, or in the classic app, is rebuilt from its burn or move transaction and this key.</p>
      <div class="amt text"><input id="br-txid" placeholder="Burn or move transaction id" autocomplete="off" spellcheck="false" autocapitalize="off" autocorrect="off" aria-label="Burn or move transaction id"></div>
      <div class="amt text" id="br-amtrow" hidden><input id="br-ramt" inputmode="decimal" placeholder="TAC amount" autocomplete="off" aria-label="TAC amount of that bridge"></div>
      ${BR_TO_ON ? html`<div class="amt text"><input id="br-fto" placeholder="Sent to someone else? Their address" autocomplete="off" spellcheck="false" autocapitalize="off" autocorrect="off" aria-label="Address that bridge paid"></div>` : ''}
      <button class="btn ghost" type="button" id="br-find">Find it</button>
      <div class="status" role="status" id="br-fstatus"></div>
    </details>`);
  for (const r of $$('#br-re', el)) r.onclick = () => busy(r, async () => { BR.err = null; BR.rv = null; await Promise.allSettled([loadBridge(true), loadBtc(true)]); rerender('tac'); });
  $$('[data-bract]', el).forEach((x) => x.onclick = () => busy(x, (run) => brAct(run, x.dataset.bract, x.dataset.brid)));
  const nf = $('#br-notify', el);
  if (nf) nf.onclick = () => busy(nf, async () => { const why = await setNotify(true); toast(why || 'Notices are on.', !!why); rerender('tac'); });
  const go = $('#br-go'), rc = $('#br-rcpt'), ackRow = $('#br-ackrow'), ack = $('#br-ack'), status = $('#br-status');
  const toWrap = $('#br-towrap'), toIn = $('#br-to'), toSay = $('#br-tos'), ackText = $('#br-acktext');
  let review = null, seq = 0;
  const gateOk = () => { go.disabled = !review || review.short || !ack.checked; };
  ack.onchange = () => { BR.acked = ack.checked && review ? review.key : null; gateOk(); };
  const paintTo = () => {
    const on = !!toIn && !!toIn.value.trim() && review?.pf.path === 'reflected', kv = $('.kv', rc);
    if (kv && review) {
      $('span', kv).textContent = on ? 'They get' : 'You get';
      $('b', kv).textContent = on ? `${fmt(BigInt(review.note.amount), 8, 4)} TAC, to claim as a private payment` : `${fmt(BigInt(review.note.amount), 8, 4)} private TAC on Ethereum`;
    }
    ackText.textContent = on ? 'I understand this goes to that address and can’t be undone once its burn confirms on Bitcoin. If they do not claim it, I can take it back after about 90 days.'
      : 'I understand a bridge can’t be undone once its burn confirms on Bitcoin.';
  };
  if (toIn) toIn.oninput = () => { say(toSay, ''); paintTo(); };
  const check = async () => {
    const my = ++seq;
    review = null; ackRow.hidden = true; gateOk();
    if (toWrap) toWrap.hidden = true;
    const n = open.find((x) => brId(x) === BR.pick);
    if (!n) { rc.hidden = true; return; }
    const rvKey = `${pub}:${brId(n)}`, kept = BR.rv?.key === rvKey && Date.now() - BR.rv.at < 120e3 ? BR.rv.pf : null;
    const flying = kept ? null : BR.checks.get(rvKey) || null;
    const readingNote = (read) => html`<p class="note">Reading this TAC’s history from Bitcoin: ${brTransfers(read)} so far…</p>`;
    if (!kept) mount(rc, flying?.read ? readingNote(flying.read) : html`<p class="note">Checking this TAC and Bitcoin’s fees…</p>`);
    rc.hidden = false;
    try {
      let pfP = kept ? Promise.resolve(kept) : flying?.p;
      if (!pfP) {
        const run = { key: rvKey, read: 0 };
        const reading = (read) => {
          run.read = read;
          const box = $('#br-rcpt');
          if (box?.isConnected && BR.pick === brId(n) && !box.querySelector('.kv, .err')) mount(box, readingNote(read));
        };
        run.p = brUx().then((ux) => ux.preflight({ note: n, walletPub: hexToBytes(pub), onProgress: reading }))
          .finally(() => { if (BR.checks.get(rvKey) === run) BR.checks.delete(rvKey); });
        BR.checks.set(rvKey, run);
        pfP = run.p;
      }
      const pf = await pfP;
      if (!kept && pf.ok) BR.rv = { key: rvKey, at: Date.now(), pf };
      if (my !== seq || !rc.isConnected) return;
      if (!pf.ok) {
        const bad = pf.steps.find((s) => !s.ok) || { name: '' };
        mount(rc, html``); warn(rc, brCheckText(bad));
        if (bad.tooLong || bad.unprovable) {
          brMarkLong(el, n, bad);
          rc.insertAdjacentHTML('beforeend', html`${bad.tooLong ? html`<a class="btn ghost" href="/fast/">Bridge it with the fast bridge</a>` : ''}<div id="br-swap"></div>`.s);
          if (bad.unprovable) fastTakesAny().then((yes) => { if (yes && my === seq && rc.isConnected && !$('#br-fastlink', rc)) $('#br-swap', rc)?.insertAdjacentHTML('beforebegin', html`<a class="btn ghost" id="br-fastlink" href="/fast/">Bridge it with the fast bridge</a>`.s); });
          bswOffer($('#br-swap', rc), n).catch(() => {});
        }
        if (bad.name === 'reflected' || bad.name === 'old-leaf') {
          const coins = await withKey(async (t) => t.pickSafeCommitSats(await t.getUtxos(t.wallet.address())), pub).catch(() => null);
          if (my !== seq || !rc.isConnected) return;
          const none = !!coins && !coins.some((c) => Number(c?.value) > 0);
          const ux = await brUx(), rate = await ux.quoteRate().catch(() => null);
          if (my !== seq || !rc.isConnected) return;
          const later = rate ? ux.bridgeCost({ path: 'reflected', feeRate: rate, coins: coins || [], noteSats: n.sats }) : null;
          const autoMaxFee = later ? Math.max(3000, Math.ceil(later.fee * 2)) : 6000;
          rc.insertAdjacentHTML('beforeend', html`<p class="note">After it confirms, this tab lists it under Getting ready and says when it can go, usually within a few hours.</p>
            ${none ? '' : brOptsHtml(['prepauto', 'public'])}
            <button class="btn ghost" type="button" id="br-prep" ${none ? 'disabled' : ''}>Send it to my own address</button>`.s);
          brOptsWire(rc);
          const cost = $('#br-prepcost', rc);
          if (cost && later) cost.textContent = `Its Bitcoin fee is about ${Number(later.fee).toLocaleString('en-US')} sats at today’s rates; if it would cost more than ${autoMaxFee.toLocaleString('en-US')}, it waits for me.`;
          if (!none) brPublicFee(n.amount);
          if (none) warn(rc, html`The send pays a small Bitcoin fee, and this key’s Bitcoin address has no BTC free for it. <a href="#bitcoin/receive" data-link="bitcoin/receive">Add bitcoin to it</a>, then pick this note again.`);
          const prep = $('#br-prep', rc);
          if (prep && !none) prep.onclick = () => busy(prep, (run) => brPrep(run, n, brPlanFrom(rc, { autoMaxFee })));
        }
        return;
      }
      const one = pf.path === 'reflected', rate = one ? pf.burnFeeRate : pf.migrateFeeRate;
      const coins = await withKey(async (t) => t.pickSafeCommitSats(await t.getUtxos(t.wallet.address())), pub).catch(() => null);
      const cost = (await brUx()).bridgeCost({ path: pf.path, feeRate: rate, coins: coins || [], noteSats: n.sats, burnRate: pf.burnRate });
      if (my !== seq || !rc.isConnected) return;
      review = { key: rvKey, note: n, pf, cost, short: !!coins && !cost.ok, at: Date.now() };
      const sats = (v) => `${Number(v).toLocaleString('en-US')} sats`;
      mount(rc, html`
        <div class="kv"><span>You get</span><b>${fmt(BigInt(n.amount), 8, 4)} private TAC on Ethereum</b></div>
        <div class="kv"><span>Bitcoin fee</span><b>≈ ${sats(cost.fee)}${one ? '' : `, and about ${sats(cost.later)} for the burn later`}</b></div>
        <div class="kv"><span>Relay fee</span><b>None</b></div>
        <div class="kv"><span>How</span><b>${one ? 'One Bitcoin transaction' : 'A move, then a burn through a miner'}</b></div>
        <div class="kv"><span>Arrives</span><b>${one ? 'Usually within a few hours, once Bitcoin’s proof on Ethereum records the burn' : 'Usually within a day: the move and the burn each wait for Bitcoin’s proof on Ethereum, and this page sends the burn while it is open with your wallet'}</b></div>`);
      rc.insertAdjacentHTML('beforeend', brOptsHtml(one ? ['public'] : ['selfburn', 'public']).s);
      brOptsWire(rc);
      brPublicFee(n.amount);
      if (review.short) {
        const have = BigInt(cost.have || 0), arriving = BTC.pub === pub && BTC.pending > 0n ? html` ${fmt(BTC.pending, 8, 8)} BTC is still arriving; once it confirms, check again.` : '';
        warn(rc, one ? html`This key’s Bitcoin address has ${fmt(have, 8, 8)} BTC free for fees, short of the ${sats(cost.need)} this needs.${arriving} <a href="#bitcoin/receive" data-link="bitcoin/receive">Add bitcoin to it</a>`
          : html`The move spends one coin whole: the largest free coin on this key’s Bitcoin address holds ${fmt(have, 8, 8)} BTC, and this needs one of ${sats(cost.need)}.${arriving} <a href="#bitcoin/receive" data-link="bitcoin/receive">Add bitcoin to it</a>`);
      }
      if (BR.acked !== rvKey) ack.checked = false;
      if (toWrap) toWrap.hidden = pf.path !== 'reflected';
      paintTo();
      ackRow.hidden = false; gateOk();
    } catch (e) { if (my === seq && rc.isConnected) quoteErr(rc, brFail(e)); }
  };
  let paintBulk = null;
  $$('input[name="br-note"]', el).forEach((r) => r.onchange = () => { BR.pick = r.value; BR.act = null; paintBulk?.(); check(); });
  $$('[data-brsplit]', el).forEach((x) => x.onclick = () => busy(x, (run) => {
    const n = notes.find((y) => brId(y) === x.dataset.brsplit), v = parseUnits($(`#${x.dataset.brsplitIn}`).value, 8);
    if (!n) return;
    if (!v || v > BigInt(ctx.T.bridgeUx().BURNDEP_BETA_CAP_RAW)) return say($('#br-status'), html`<span class="err">Enter an amount up to 1,000 TAC.</span>`);
    if (v >= BigInt(n.amount)) return say($('#br-status'), html`<span class="err">Enter less than this note holds.</span>`);
    return brSend(run, n, v, 'Split off');
  }));
  $$('[data-brprep]', el).forEach((x) => x.onclick = () => busy(x, async () => {
    const p = brPreps(pub).find((y) => y.txid === x.dataset.brprep);
    const find = () => (BR.notes || []).filter((n) => n.txid === p?.txid && n.eligible).sort((a, b) => (String(a.amount) === p.amount ? -1 : 0) - (String(b.amount) === p.amount ? -1 : 0))[0];
    if (!find()) await loadBridge(true);
    const n = find();
    if (!n) return say($('#br-rstatus') || $('#br-status'), html`<span class="err">That note is not at this key’s Bitcoin address any more. Refresh, then try again.</span>`);
    BR.pick = brId(n); rerender('tac');
    $('#br-rcpt')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }));
  if (bulk) paintBulk = brBulkWire(el, pub, bulk, () => {
    BR.pick = null; seq++; review = null; rc.hidden = true; ackRow.hidden = true; gateOk();
    $$('input[name="br-note"]', el).forEach((x) => { x.checked = false; });
  });
  if (BR.pick) check();
  go.onclick = () => busy(go, async (run) => {
    const r = review;
    if (!r) return;
    if (Date.now() - r.at > 10 * 60e3) { BR.rv = null; review = null; check(); throw Object.assign(new Error('The fee rate is being read again. Press Bridge once the receipt shows.'), { said: true }); }
    const amt = `${fmt(BigInt(r.note.amount), 8, 4)} TAC`;
    const mara = r.pf.slipstreamRates, base = mara ? Math.max(Number(mara.effective_rate) || 0, Number(mara.submit_fee_rate) || 0, 1) * 1.1 : 10;
    let recipient = null;
    const toRaw = toIn && r.pf.path === 'reflected' ? toIn.value.trim() : '';
    if (toRaw) {
      try { recipient = await resolveTo(toRaw); } catch (e) { say(toSay, html`<span class="err">${errText(e)}</span>`); return; }
    }
    const plan = brPlanFrom(rc, { burnMaxRate: r.pf.path === 'reflected' ? null : Math.ceil(Math.max(10, base * 2)) });
    if (recipient) delete plan.publicTo;
    try {
      await brBridgeNow({ run, pub, r, recipient, plan, amt, status, where: 'under On the way', after: () => rerender('tac') });
      review = null;
    } catch (e) { run.fail(status, brFail(e)); }
  });
  const find = $('#br-find'), txid = $('#br-txid'), amtRow = $('#br-amtrow'), ramt = $('#br-ramt'), fst = $('#br-fstatus');
  find.onclick = () => busy(find, async (run) => {
    const id = txid.value.trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(id)) { say(fst, html`<span class="err">A transaction id is 64 characters, 0-9 and a-f.</span>`); return; }
    const raw = amtRow.hidden ? 0n : parseUnits(ramt.value, 8) || 0n;
    const fto = $('#br-fto'), toRaw = fto ? fto.value.trim() : '';
    try {
      run.say(fst, 'Checking the burn and rebuilding the bridge…');
      const recipient = toRaw ? await resolveTo(toRaw) : null;
      const found = await (await brUx()).recoverFromTxid(id, walletPriv(), { ...(raw > 0n ? { amount: raw } : {}), ...(recipient ? { recipient } : {}) });
      clearField(txid); clearField(ramt); if (fto) clearField(fto); amtRow.hidden = true;
      if (brTk(found) !== 'TAC') say(fst, html`<span class="ok">That is a ${brTk(found)} return, not a TAC bridge: it shows on the tETH sheet’s Bitcoin tab, under Back to Ethereum.</span>`);
      else say(fst, html`<span class="ok">${found?.stage === 'minted' ? (found.stealth ? `That bridge has gone through: it was sent to ${brPaid(found)}.` : 'That bridge has arrived: its TAC is in your private TAC.') : '✓ Found it. It shows under On the way.'}</span>`);
      if (found?.stage === 'minted') scanPrivate(true).catch(() => {});
      BR.at = 0; rerender('tac');
    } catch (e) {
      if (/needs \{ amount \}/.test(String(e?.message))) { amtRow.hidden = false; say(fst, 'This bridge needs its TAC amount as well. Add it above, then press Find it again.'); return; }
      run.fail(fst, brFail(e));
    }
  });
}
const brPublicTo = () => (S.key && S.address ? String(S.address) : null);
function brOptsHtml(kinds, many = false) {
  const o = BR.opts, to = brPublicTo(), it = many ? 'them' : 'it', they = many ? 'they' : 'it', are = many ? 'are' : 'is', arrive = many ? 'arrive' : 'arrives';
  const box = (id, on, body) => html`<label class="pick"><input type="checkbox" id="${id}" data-bropt="${id.slice(3)}" ${on ? 'checked' : ''}><span>${body}</span></label>`;
  return html`${kinds.includes('prepauto') ? box('br-prepauto', o.prepauto, html`Then bridge ${it} for me once ${they} ${are} ready. This page must be open with my wallet. <span id="br-prepcost"></span>`) : ''}${kinds.includes('selfburn') ? box('br-selfburn', o.selfburn, html`Send the burn for me once the move is ready. This page must be open with my wallet; if the miner’s rate more than doubles it waits for me.`) : ''}${kinds.includes('public') && to ? box('br-public', o.public && !BR.noPublic, html`Make ${it} public TAC when ${they} ${arrive}, in ${your()} (${short(to, 6)}). <span id="br-pubfee"></span>The ${many ? 'amounts' : 'amount'} and the address are then public on Ethereum.`) : ''}${kinds.includes('public') && chainOn() ? box('br-chain', o.chain, html`Move ${it} to the Tacit chain when ${they} ${arrive}, for fast private TAC payments. The relay’s fee comes out of ${it}. This page must be open with my wallet.`) : ''}`;
}
const brOptsWire = (root) => $$('[data-bropt]', root).forEach((x) => { x.onchange = () => {
  BR.opts[x.dataset.bropt] = x.checked;
  const other = { public: 'chain', chain: 'public' }[x.dataset.bropt], o = other && $(`#br-${other}`, root);
  if (x.checked && o?.checked) { o.checked = false; BR.opts[other] = false; }
}; });
async function brPublicFee(amount) {
  try {
    const t = await getUx(), minFee = BigInt(await t.quoteOpFee('cTAC', 'sendunwrap')), fee = t.quoteUnwrapFee(BigInt(amount), 'cTAC', { minFee }).fee;
    const el = $('#br-public'), note = $('#br-pubfee');
    if (!el || !note) return;
    BR.noPublic = fee >= BigInt(amount);
    note.textContent = BR.noPublic ? 'This is worth less than the relay’s fee to make public, so it stays private. ' : `A relay fee of ${fmt(fee, 8, 2)} TAC or a little more comes out of it. `;
    if (BR.noPublic) { el.checked = false; el.disabled = true; BR.opts.public = false; }
  } catch { }
}
function brPlanFrom(root, { burnMaxRate = null, autoMaxFee = null } = {}) {
  const on = (id) => { const x = $(id, root); return !!x && x.checked && !x.disabled; };
  const plan = { at: Date.now() };
  if (burnMaxRate != null && on('#br-selfburn')) plan.burn = { maxRate: burnMaxRate };
  if (autoMaxFee != null && on('#br-prepauto')) plan.auto = { maxFee: autoMaxFee };
  if (on('#br-chain') && chainOn()) plan.chain = true;
  else if (on('#br-public') && brPublicTo()) plan.publicTo = brPublicTo();
  return plan;
}
const brPrep = (run, n, plan = null) => brSend(run, n, BigInt(n.amount), 'Send', plan);
async function brSend(run, n, amount, verb, plan = null) {
  const status = $('#br-status'), pub = S.key.pubHex, amt = `${fmt(amount, 8, 4)} TAC`, split = amount < BigInt(n.amount);
  try {
    run.say(status, split ? `Splitting ${amt} off…` : 'Sending it to your own address…');
    const { txid } = await toSelf(pub, TAC_BTC_ID, [n], amount);
    actBtc(txid, `${verb} ${amt}${split ? '' : ' to your own address'}`);
    brPrepAdd(pub, { txid, amount: String(amount), at: Date.now(), ...(plan && (plan.auto || plan.publicTo || plan.chain) ? { plan } : {}) });
    BR.pick = null; BR.rv = null; BR.at = 0;
    say(status, html`<span class="ok">✓ ${split ? `${amt} split off to your own address` : `${amt} sent to your own address`}</span> <a href="${MEMPOOL}/tx/${txid}" target="_blank" rel="noopener">${short(txid, 6)} ↗</a>. ${plan?.auto ? 'It is bridged for you' : 'It can be bridged from here'} once it confirms and Bitcoin’s proof on Ethereum has seen it, usually within a few hours${plan?.auto ? ', while this page is open with your wallet' : ''}. It is listed under Getting ready, which says when it can go.`);
    dashSoon();
    Promise.allSettled([loadBridge(true), loadBtc(true)]).then(() => rerender('tac'));
  } catch (e) { run.fail(status, /insufficient sats|no plain-sats/i.test(String(e?.message)) ? new Error('Not enough BTC for this and its Bitcoin fee.') : brFail(e)); }
}
const brNotes = (n) => `${n} note${n === 1 ? '' : 's'}`;
const brAnd = (xs) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
const brTac = (v) => `${fmt(BigInt(v), 8, 4)} TAC`;
const brMergeSend = (pub, ns, plan) => mergeSend({ withKey: (fn) => withKey(fn, pub), mem: store, pub, notes: ns, plan, label: BTC_TOKENS[TAC_BTC_ID] || 'note' }).then((r) => {
  actBtc(r.txid, r.n > 1 ? `Merged ${brNotes(r.n)} (${brTac(r.amount)})` : `Sent ${brTac(r.amount)} to your own address`);
  return r;
});
const brStartNote = async (pub, n, publicTo) => startNote(await loadTacit(), { withKey: (fn) => withKey(fn, pub), mem: store, pub, walletPub: hexToBytes(pub), priv: () => walletPriv(), note: n, publicTo, errText });
async function brBulkFee(pub, bulk, kind) {
  const coins = await withKey(async (t) => t.pickSafeCommitSats(await t.getUtxos(t.wallet.address())), pub).catch(() => null);
  return bulkFee(await loadTacit(), { bulk, kind, coins });
}
const brRecentNote = (skipped) => { const n = skipped.filter((x) => x.why === 'recent').length; return n ? html`<p class="note">${brNotes(n)} too recent for Bitcoin’s proof to have seen ${n === 1 ? 'stays' : 'stay'} out of this.</p>` : ''; };
function brBulkPanel(kind, bulk) {
  if (kind === 'merge') {
    const g = bulk.merge.groups, count = g.reduce((s, x) => s + x.notes.length, 0);
    return html`
      <div class="kv"><span>Merge</span><b>${brNotes(count)} into ${brNotes(g.length)}: ${brAnd(g.map((x) => brTac(x.total)))}</b></div>
      <div class="kv"><span>Bitcoin fee</span><b id="br-allfee">Checking…</b></div>
      <div class="kv"><span>Then</span><b>Each can be bridged once Bitcoin’s proof on Ethereum has seen it, usually within a few hours</b></div>
      ${brRecentNote(bulk.merge.skipped)}
      ${brOptsHtml(['prepauto', 'public'], true)}
      <button class="btn" type="button" id="br-merge-go">Merge ${brNotes(count)}</button>`;
  }
  const a = bulk.all, sent = a.sends.reduce((s, g) => s + g.notes.length, 0) + a.privates.length, nSends = a.sends.length + a.privates.length;
  const count = countAll(a), ops = opsCompared(bulk.merge, a);
  const total = [...a.burns, ...a.sends.flatMap((g) => g.notes), ...a.privates, ...a.checks].reduce((s, n) => s + BigInt(n.amount), 0n);
  return html`
    <div class="kv"><span>Bridge</span><b>${brTac(total)} from ${brNotes(count)}</b></div>
    ${a.burns.length ? html`<div class="kv"><span>Burned now</span><b>${brNotes(a.burns.length)}, one Bitcoin transaction each</b></div>` : ''}
    ${nSends ? html`<div class="kv"><span>Sent first</span><b>${brNotes(sent)} in ${nSends} send${nSends === 1 ? '' : 's'} to your own address, then bridged for you</b></div>` : ''}
    ${a.checks.length ? html`<div class="kv"><span>Checked one by one</span><b>${brNotes(a.checks.length)}: a move, then a burn through a miner, sent for you</b></div>` : ''}
    <div class="kv"><span>Bitcoin fee</span><b id="br-allfee">Checking…</b></div>
    <div class="kv"><span>Arrives</span><b>Within a few hours of each burn${nSends ? '; the notes sent first take a few hours longer' : ''}</b></div>
    ${ops.merge < ops.all ? html`<p class="note">Merge notes first would take ${ops.merge} Bitcoin transactions in all instead of ${ops.all}, and a few hours longer.</p>` : ''}
    ${brRecentNote(a.skipped)}
    ${brOptsHtml(['public'], true)}
    <label class="pick"><input type="checkbox" id="br-allack"><span>I understand a bridge can’t be undone once its burn confirms on Bitcoin.</span></label>
    <button class="btn" type="button" id="br-all-go" disabled>Bridge ${brNotes(count)}</button>`;
}
function brBulkWire(el, pub, bulk, closeSingle) {
  const panel = $('#br-allp', el), btn = { merge: $('#br-merge', el), all: $('#br-all', el) };
  if (!panel) return;
  let quote = { autoMaxFee: 6000 }, seq = 0;
  const single = $('#br-go', el);
  const paint = () => {
    const kind = BR.act, my = ++seq;
    for (const k of Object.keys(btn)) btn[k]?.setAttribute('aria-pressed', String(kind === k));
    if (single) single.hidden = !!kind;
    if (!kind) { panel.hidden = true; BR.allAck = false; mount(panel, html``); return; }
    mount(panel, brBulkPanel(kind, bulk));
    panel.hidden = false;
    brOptsWire(panel);
    const go = $(kind === 'merge' ? '#br-merge-go' : '#br-all-go', panel), ack = $('#br-allack', panel);
    let short = false;
    const gate = () => { go.disabled = short || (!!ack && !ack.checked); };
    if (ack) { ack.checked = !!BR.allAck; ack.onchange = () => { BR.allAck = ack.checked; gate(); }; }
    brBulkFee(pub, bulk, kind).catch(() => null).then((q) => {
      if (my !== seq || !panel.isConnected) return;
      if (!q) { const f = $('#br-allfee', panel); if (f) f.textContent = 'not quoted right now'; short = true; gate(); return; }
      quote = q; short = q.short;
      const fee = $('#br-allfee', panel);
      if (fee) fee.textContent = `≈ ${q.fee.toLocaleString('en-US')} sats${q.later ? `, and about ${q.later.toLocaleString('en-US')} for the burns after` : ''}`;
      if (short) warn(panel, html`This key’s Bitcoin address has ${q.free.toLocaleString('en-US')} sats free for fees, short of the about ${q.need.toLocaleString('en-US')} this needs. <a href="#bitcoin/receive" data-link="bitcoin/receive">Add bitcoin to it</a>`);
      gate();
    }).catch(() => { const fee = $('#br-allfee', panel); if (fee) fee.textContent = 'not quoted'; });
    go.onclick = () => busy(go, (run) => (kind === 'merge' ? brRunMerge : brRunAll)(run, pub, bulk, brBulkPlan(panel, quote, kind)));
  };
  for (const k of Object.keys(btn)) if (btn[k]) btn[k].onclick = () => { BR.act = BR.act === k ? null : k; if (BR.act) closeSingle(); paint(); };
  paint();
  return paint;
}
const brBulkPlan = (panel, quote, kind) => {
  if (kind === 'merge') return brPlanFrom(panel, { autoMaxFee: quote.autoMaxFee });
  const pubBox = $('#br-public', panel), plan = { at: Date.now(), auto: { maxFee: quote.autoMaxFee } };
  if (pubBox?.checked && !pubBox.disabled && brPublicTo()) plan.publicTo = brPublicTo();
  return plan;
};
async function brRunMerge(run, pub, bulk, plan) {
  const status = $('#br-status'), groups = bulk.merge.groups;
  BR.starting = true;
  let did, left;
  try { ({ did, left } = await bridgeRunMerge({ groups, merge: (ns) => brMergeSend(pub, ns, plan), tryAgain: (fn, sent) => brTry(pub, sent, fn), say: (m) => run.say(status, m), errText })); }
  finally { BR.starting = false; }
  if (did.length) Object.assign(BR, { act: null, allAck: false, pick: null, rv: null, acked: null, at: 0 });
  say(status, html`${did.length ? html`<span class="ok">✓ ${brNotes(did.reduce((s, d) => s + d.n, 0))} merged into ${brNotes(did.length)}: ${brAnd(did.map((d) => brTac(d.amount)))}.</span> ${plan.auto ? 'They are bridged for you' : 'They can be bridged from here'} once they confirm and Bitcoin’s proof on Ethereum has seen them, usually within a few hours${plan.auto ? ', while this page is open with your wallet' : ''}.` : ''}${left.length ? html` <span class="err">${left[0]}${left.length > 1 ? ` (${left.length} failed)` : ''}</span>` : ''}`);
  if (did.length) { toast(`${brNotes(did.reduce((s, d) => s + d.n, 0))} merged`); dashSoon(); }
  Promise.allSettled([loadBridge(true), loadBtc(true)]).then(() => rerender('tac'));
}
async function brRunAll(run, pub, bulk, plan) {
  const status = $('#br-status'), a = bulk.all;
  BR.starting = true;
  let did, left;
  try { ({ did, left } = await bridgeRunAll({ all: a, merge: (ns) => brMergeSend(pub, ns, plan), start: (n) => brStartNote(pub, n, plan.publicTo), tryAgain: (fn, sent) => brTry(pub, sent, fn), say: (m) => run.say(status, m), errText, amountText: (n) => brTac(n.amount) })); }
  finally { BR.starting = false; }
  const parts = [did.burns ? `${brNotes(did.burns)} bridging` : '', did.sends ? `${brNotes(did.sent)} sent to your own address in ${did.sends} send${did.sends === 1 ? '' : 's'}, to be bridged for you once ready` : ''].filter(Boolean);
  if (parts.length) Object.assign(BR, { act: null, allAck: false, pick: null, rv: null, acked: null, at: 0 });
  say(status, html`${parts.length ? html`<span class="ok">✓ ${parts.join('; ')}.</span> They show under On the way and Getting ready, and finish on their own whenever this page is open with your wallet.` : ''}${left.length ? html`<br><span class="err">${left.length === 1 ? left[0] : `${left.length} not done: ${left.join(' · ')}`}</span> They stay in the list above.` : ''}`);
  if (parts.length) { toast(parts.join('; ')); dashSoon(); }
  Promise.allSettled([loadBridge(true), loadBtc(true)]).then(() => rerender('tac'));
}
const TACW = { pub: false, forms: false };
async function loadTacFee() {
  const notes = freeNotes(P.scan?.tac?.notes).sort(byValue).reverse();
  if (!S.key || !notes.length) { TACB.fee = null; return; }
  try {
    const t = await getUx(), minFee = BigInt(await t.quoteOpFee('cTAC', 'sendunwrap'));
    const fees = notes.map((n) => t.quoteUnwrapFee(BigInt(n.value), 'cTAC', { minFee }).fee).map((f, i) => (BigInt(notes[i].value) > f ? f : 0n));
    TACB.fee = fees.reduce((a, f) => a + f, 0n);
  } catch { TACB.fee = null; }
}
const tacFeeText = () => (TACB.fee ? ` A relay fee of about ${fmt(TACB.fee * E10, 18, 0)} TAC comes out of it.` : '');
const tacFeeNote = () => {
  if (TACB.fee === undefined && S.key && P.scan?.tac) { TACB.fee = null; loadTacFee().then(() => { const el = $('#tac-fee-note'); if (el) el.textContent = tacFeeText(); }); }
  return html`<span id="tac-fee-note">${tacFeeText()}</span>`;
};
var TAC_SEEN = 'tacit-tac-seen-v1';
function tacSeen(k) { try { const j = JSON.parse(sessionStorage.getItem(TAC_SEEN) || 'null'); return j && j.pub === k && Date.now() - j.at < 30 * 60e3 ? j.v : null; } catch { return null; } }
function tacSeenKeep(k, places) {
  try {
    const v = { ...(tacSeen(k) || {}) };
    let n = 0;
    for (const p of places) if (p.v != null && !p.seen) { v[p.key] = String(p.v); n++; }
    if (n) sessionStorage.setItem(TAC_SEEN, JSON.stringify({ pub: k, at: Date.now(), v }));
  } catch { }
}
const tacSeenOn = (k, places) => { const seen = k ? tacSeen(k) : null; return seen ? places.map((p) => (p.v == null && seen[p.key] != null ? { ...p, v: BigInt(seen[p.key]), bad: false, seen: true } : p)) : places; };
function tacPlaces(k, who) {
  const ch = chainOn(), way = (sf, w) => hxWays(sf).includes(w), hx = (t, spec) => ({ t, hx: spec });
  const btcTac = k && BTC.pub === k ? BTC.held.find((a) => a.id === TAC_BTC_ID) : null, chainV = ch ? chainHeld() : null, payV = devBal('tac', k);
  const pool = ctx.TPOOL.api?.totals().shielded ?? (HELD.pub === k ? HELD.sats?.find((a) => a.ticker === 'TAC')?.value ?? null : null);
  const forSale = ctx.TPOOL.api?.totals().forSale ?? (HELD.pub === k ? HELD.forSale : null);
  const out = [
    { key: 'wallet', t: 'Wallet', s: 'public', m: 1, core: true, v: TACB.who === who ? TACB.erc : null, bad: !!TACB.err && TACB.who !== who,
      acts: (v) => (v > 0n ? [ch && way('wtac', 'chain') && hx('Tacit chain', 'shield:wtac:chain'), way('wtac', 'defi') && hx('DeFi pool', 'shield:wtac:defi'), hx('Swap', 'swap:tac:ether'), hx('Send', 'send:wtac')] : [hx('Buy', 'swap:ether:tac')]) },
    ...(ch ? [{ key: 'chain', t: 'Tacit chain', s: 'private payments', m: 1, v: chainV == null ? null : chainV * E10, bad: chainV == null && !!ctx.CH.err,
      acts: (v) => (v > 0n ? [hx('Send', 'send:ctac'), hx('To wallet', 'shield:ctac:wallet'), hx('DeFi pool', 'shield:ctac:defi')] : []) }] : []),
    { key: 'defi', t: 'DeFi pool', s: 'private', m: 1, core: true, v: P.scan?.tac ? P.scan.tac.value * E10 : null, bad: !P.scan && !!P.err,
      acts: (v) => (v > 0n ? [hx('Swap', 'swap:tac:ether:private'), hx('Farm', 'earn:tac'), hx('Send', 'send:tac'), hx('To wallet', 'shield:tac:wallet'), ch && way('tac', 'chain') && hx('Tacit chain', 'shield:tac:chain'), xoShown(k, XA.tac) && { t: 'To Bitcoin', th: 'bridge:out' }, spendable('tac') && { t: 'Withdraw all', th: 'pub' }] : []) },
    { key: 'btc', t: 'On Bitcoin', s: 'public', m: 'btc', core: true, v: BTC.pub === k && BTC.got >= 2 ? (btcTac ? btcTac.balance * 10n ** BigInt(18 - btcTac.decimals) : 0n) : null, bad: !!BTC.err && (BTC.pub !== k || BTC.got < 2),
      acts: (v) => (v > 0n ? [{ t: 'Shield', th: 'pool:shield' }, { t: 'To Ethereum', th: 'bridge:in' }, hx('Send', 'send:tacb')] : []) },
    { key: 'pool', t: 'Bitcoin pool', s: 'shielded', m: 'btc', v: pool == null ? null : pool * E10,
      acts: (v) => [...(v > 0n ? [{ t: 'Send', th: 'pool:send' }, { t: 'Withdraw', th: 'pool:withdraw' }] : []), { t: 'Receive', th: 'pool:receive' }] },
    // taken out of the pool to sell: at the wallet's own sale keys, listed or waiting to be, until sold or put back
    ...(forSale > 0n ? [{ key: 'sale', t: 'For sale', s: 'taken out, on Bitcoin', m: 'btc', v: forSale * E10, acts: () => [{ t: 'List or put back', th: 'pool:withdraw:sats' }] }] : []),
  ];
  if (payV > 0n) out.push({ key: 'pay', t: 'Pay pool', s: 'private', m: 1, v: payV, acts: () => [hx('Send', 'send:ptac'), { t: 'Withdraw', link: 'device/tac/withdraw' }] });
  return out;
}
function tacPlacesView(places) {
  const act = (a) => (a.hx ? html`<button class="link" type="button" data-hx="${a.hx}">${a.t}</button>` : a.link ? html`<a class="link" href="#${a.link}" data-link="${a.link}">${a.t}</a>` : html`<button class="link" type="button" data-th="${a.th}">${a.t}</button>`);
  return html`<ul class="th" aria-label="Where your TAC is">${places.map((p) => {
    const acts = p.v == null ? [] : p.acts(p.v).filter(Boolean);
    return html`<li data-place="${p.key}">${chainMark(p.m)}<span class="th-n">${p.t}<small>${p.s}</small></span>
      <b class="th-v">${p.v != null ? fmt(p.v, 18, 2) : p.bad ? html`<span class="err">—</span> <button class="link" type="button" data-tac-retry>retry</button>` : html`<span class="sk" style="--w:4ch"></span>`}</b>
      ${acts.length ? html`<span class="th-a">${acts.map(act)}</span>` : ''}</li>`;
  })}</ul>`;
}
function tacPlaceGo(what) {
  const [kind, arg, sub] = what.split(':');
  if (kind === 'pool') return arg === 'hide' ? tacPoolHide() : tacPoolOpen(arg, sub || null);
  if (kind === 'pub' || kind === 'forms') { TACW[kind] = !TACW[kind]; return rerender('tac'); }
  if (kind !== 'bridge') return;
  BRM.mode = arg === 'out' ? 'out' : 'in';
  tacPageOpen('bridge');
  load.tac().then(() => rerender('tac')).catch(() => {});
}
function tacPool() {
  return (ctx.TPOOL.p ||= import('/tac/pool.js?cb=09946f69').then((m) => {
    const api = m.makeTacPool({
      key: () => (S.key ? { pubHex: S.key.pubHex } : null),
      priv: () => walletPriv(),
      ensureKey: tacKeyNow,
      withKey: (fn) => withKey(fn),
      tacitAddress: () => S.key?.tacit || null,
      toast,
      hold: (btn, fn) => busy(btn, () => fn()),
      changed: (what) => { if (what === 'bitcoin' && S.key && ctx.T) loadBtc(true).catch(() => {}); rerender('tac'); dashSoon(); },
      viewChanged: () => { syncLink(); tcardFoot(); },
      usd: (sats) => hxUsd('sats', sats),
    });
    ctx.TPOOL.host = document.createElement('div');
    ctx.TPOOL.at = Date.now();
    api.mount(ctx.TPOOL.host);
    return (ctx.TPOOL.api = api);
  }).catch((e) => { ctx.TPOOL.p = null; throw e; }));
}
function tacPoolOpen(tab = 'shield', sub = null) {
  ctx.TPOOL.open = true; ctx.TPOOL.want = [tab, ...(sub ? [sub] : [])];
  ctx.TCARD.side = 'btc';
  if (ctx.TACP.on && ctx.TACP.act) tpgAct(null);
  if (!S.key) TACB.signIn = true;
  return tacPool().then((api) => {
    api.show(tab, sub);
    if (!ctx.TPOOL.open) return api;
    if (shown('tac')) rerender('tac'); else openSheet('tac');
    tacPoolPlace();
    if (S.key && Date.now() - ctx.TPOOL.at > 60e3) { ctx.TPOOL.at = Date.now(); api.refresh().catch(() => {}); }
    syncLink();
    requestAnimationFrame(() => $('#tpg-card')?.scrollIntoView({ block: 'nearest', behavior: calmMotion() ? 'auto' : 'smooth' }));
    return api;
  }, (e) => toast(errText(e), true));
}
function tacPoolHide() { ctx.TPOOL.open = false; if (chainOn()) ctx.TCARD.side = 'chain'; tacPoolPlace(); syncLink(); }
function tacPoolPlace() {
  if (!ctx.TPOOL.host || !ctx.TACP.on) return;
  if (ctx.TPOOL.open) ctx.TCARD.side = 'btc';
  tcard();
}
async function tacKeyNow() {
  if (S.key) return;
  TACB.signIn = true;
  openSheet('wallet');
  throw Object.assign(new Error('Open your Tacit wallet first.'), { said: true, quiet: true });
}
function renderTacBal(el) {
  const who = tacWho();
  if (!S.key) { mount(el, html`<p class="note">Sign in to see where your TAC is. <button class="link" type="button" data-signin>Sign in</button></p>`); return; }
  if (!who) { mount(el, html``); return; }
  const k = S.key?.pubHex, places = tacPlaces(k, who);
  mount(el, html`
    ${tacPlacesView(places)}
    ${spendable('tac') && TACW.pub ? html`<div class="callout"><span>${fmt(spendable('tac') * E10, 18, 2)} TAC to ${your()}.${tacFeeNote()}</span><button class="btn ghost" type="button" id="tac-pub">Withdraw all</button></div>
      <div class="lbl"><span>Send it to</span><span>${your()} unless you enter an address</span></div>
      <div class="amt text"><input id="tac-pub-to" placeholder="0x… (optional)" autocomplete="off" spellcheck="false" autocapitalize="off" autocorrect="off" aria-label="Where the public TAC goes"></div>` : ''}
    <p class="tpg-ways"><button class="link" type="button" data-th="forms" aria-expanded="${String(TACW.forms)}">${TACW.forms ? 'Fewer ways' : 'More ways'}</button></p>
    <div id="tac-forms"><div id="tac-shield"></div><div id="tac-send"></div></div>
    <div class="status" role="status" id="tac-bal-status"></div>`);
  $('#tac-forms', el).hidden = !TACW.forms;
  $$('[data-tac-retry]', el).forEach((re) => re.onclick = () => busy(re, async () => {
    TACB.err = null;
    const [h, sc, bt] = await Promise.allSettled([loadTacHoldings(true), S.key ? scanPrivate(true) : null, S.key && ctx.T ? loadBtc(true) : null, S.key && chainOn() ? chainScan(true) : null]);
    const bad = [h, sc, bt].find((x) => x.status === 'rejected');
    if (bad) sayErr($('#tac-bal-status'), bad.reason);
    rerender('tac');
  }));
  tacShield($('#tac-shield'), $('#tac-bal-status'), TACB.who === who ? TACB.acct : null, TACB.who === who ? TACB.erc - (TACB.acct || 0n) : null);
  tacSend($('#tac-send'), $('#tac-bal-status'));
  const pub = $('#tac-pub', el);
  if (pub) pub.onclick = () => busy(pub, (run) => tacPublicNow({ run, raw: ($('#tac-pub-to')?.value || '').trim(), status: $('#tac-bal-status'), line: () => $('#tac-bal-status'), sheet: 'tac', after: () => rerender('tac') }));
  $$('[data-th]', el).forEach((b) => b.onclick = () => tacPlaceGo(b.dataset.th));
}
const tacWho = () => [...new Set([S.wallet, S.acct?.address].filter(Boolean).map((a) => a.toLowerCase()))].join();
function tpgTile(spec, amt = '', title = '') { ctx.TACP.title = title; hxPreset(spec, amt); }
function tpgTab(tab) { return tcardGo(chainOn() ? 'chain' : 'btc', { priv: 'shield', pay: 'send', out: 'withdraw' }[tab] || tab); }

function tpgHave() {
  const by = Object.fromEntries(tacPlaces(S.key?.pubHex, tacWho()).map((p) => [p.key, p.v == null ? null : p.v / E10]));
  return { chain: by.chain ?? (chainOn() ? null : 0n), pool: by.pool ?? null, defi: by.defi ?? null, wallet: by.wallet ?? null, btc: by.btc ?? null, pay: by.pay ?? 0n };
}
const TPG_ROWS = [['chain', 'Tacit chain', 'var(--c-chain)'], ['pool', 'Bitcoin pool', 'var(--c-pool)'], ['defi', 'DeFi pool', 'var(--c-defi)'], ['pay', 'Pay pool', 'var(--c-pay)'],
  ['wallet', 'Wallet', 'var(--c-wallet)'], ['btc', 'Bitcoin address', 'var(--c-btc)'], ['sale', 'For sale', 'var(--c-btc)']];
function tpgTop(el) {
  const who = tacWho(), k = S.key?.pubHex;
  el.hidden = !k && !who;
  if (el.hidden) return;
  if (chainOn() && !CHAIN_SWEEP.at && !CHAIN_SWEEP.p && Date.now() - CHAIN_SWEEP.failAt > 15e3) chainSweepFee().then(() => rerender('tac'), () => {});
  const read = k ? tacPlaces(k, who) : tacPlaces(null, who).filter((p) => p.key === 'wallet');
  if (k) tacSeenKeep(k, read);
  const places = k ? tacSeenOn(k, read) : read, by = Object.fromEntries(places.map((p) => [p.key, p])), stale = places.some((p) => p.seen);
  const total = places.reduce((s, p) => s + (p.v || 0n), 0n), known = places.filter((p) => p.core).every((p) => p.v != null), failed = places.some((p) => p.bad);
  const pub = (by.wallet?.v || 0n) + (by.btc?.v || 0n), usd = hxUsd('tac', Number(total) / 1e18);
  const note = { chain: `private, for payments${k && ctx.CH.pub === k && (ctx.CH.incoming ?? 0n) > 0n ? ` · ${fmt(ctx.CH.incoming, 8, 2)} incoming` : ''}`, pool: 'private on Bitcoin', defi: 'trade · farm · borrow', pay: 'from before the Tacit chain', wallet: 'public on Ethereum', btc: 'amounts hidden, address seen', sale: 'taken out of the pool to sell' };
  const rows = TPG_ROWS.filter(([key]) => by[key] && ((by[key].v || 0n) > 0n || (key === 'chain' && chainOn())));
  const seg = rows.filter(([key]) => (by[key].v || 0n) > 0n);
  const nudge = chainOn() && (by.defi?.v || 0n) > 0n && hxWays('tac').includes('chain');
  const kept = k && chainOn() && ctx.CH.pub === k ? [...ctx.CH.kept, ...ctx.CH.hops.filter((x) => Date.now() - x.at > CHAIN_HOP_WAIT).map((x) => ({ kind: 'hop', ...x }))] : [];
  mount(el, html`
    <h2 class="tpg-h" id="tpg-top-h">All your TAC</h2>
    <p class="tpg-tot num">${known || total || failed ? fmt(total, 18, 2) : html`<span class="sk" style="--w:8ch"></span>`}<small>TAC${known ? (stale ? ' · updating' : '') : failed ? ', some places unread' : ''}</small></p>
    <p class="tpg-usd num">${usd ? `≈ ${usd}` : ''}</p>
    ${seg.length ? html`<div class="tpg-bar" role="img" aria-label="${seg.map(([key, t]) => `${t} ${fmt(by[key].v, 18, 2)} TAC`).join(', ')}">${seg.map(([key, , c]) => html`<i style="flex:${Math.max(0.01, Number(by[key].v / 10n ** 14n) / 1e4)};background:${c}"></i>`)}</div>` : ''}
    <ul class="tpg-leg">${rows.map(([key, t, c]) => html`<li><i style="background:${c}"></i><span>${t}<small>${note[key]}</small></span><b>${by[key].v == null ? (by[key].bad ? '—' : html`<span class="sk" style="--w:4ch"></span>`) : fmt(by[key].v, 18, 2)}</b>
      ${key === 'defi' && nudge ? html`<span class="nudge"><button class="link" type="button" data-hx="shield:tac:chain">Move to the Tacit chain to earn from payments</button></span>` : ''}</li>`)}</ul>
    ${k ? shLookingNote(k) : ''}
    ${k ? depositCallout('tac', 'tac-finish') : ''}
    ${kept.length ? html`<p class="note">${kept.length === 1 ? 'One of your Tacit chain moves has' : `${kept.length} of your Tacit chain moves have`} not landed yet. <button class="link" type="button" data-hx="${tpgKeptWay(kept[0])}">See ${kept.length === 1 ? 'it' : 'them'}</button></p>` : ''}
    <div class="status" role="status" id="tpg-top-st"></div>`);
  if (k) wireFinish(el, 'tac', 'tac-finish', 'tpg-top-st');
  ctx.TACP.tot = { k, total, known, pub };
  if (k && chainOn() && ctx.CH.bal != null) chainClient().then((c) => { const v = c.balance(); if (S.key?.pubHex === k && ctx.TACP.sh?.v !== v) { ctx.TACP.sh = { pub: k, v }; rerender('tac'); } }).catch(() => {});
}
const tpgKeptWay = (e) => (e.kind === 'shield' && (!e.inbox || e.src === 'wallet') ? 'shield:wtac:chain' : e.inbox ? 'shield:tac:chain' : e.kind === 'hop' ? 'shield:ctac:defi' : 'shield:ctac:wallet');
async function tpgPrivGo(from) {
  if (from === 'btc') return tacPoolOpen('shield');
  if (!chainOn()) return tpgTile('shield:wtac:defi', '', 'Make it private');
  if (!tcardGo('chain', 'shield')) return;
  const held = hxWalletBal('wtac') ?? TACB.erc ?? 0n, fee = tcardWay() === 'permit' ? await chainSweepFee(true).catch(() => 0n) : 0n, room = fee + fee / 10n, cap = CHAIN_SWEEP.cap ?? await chainCap().catch(() => null);
  let wei = held > room ? held - room : 0n; wei -= wei % E10;
  if (cap != null && wei > cap * E10) wei = cap * E10;
  const a = $('#tcd-amt');
  if (a && wei > 0n) { a.value = plain(wei / E10, 8); tcardQuote(); }
  requestAnimationFrame(() => { $('#tpg-card')?.scrollIntoView({ block: 'nearest', behavior: calmMotion() ? 'auto' : 'smooth' }); a?.focus({ preventScroll: true }); });
}
function tpgMount(el, view, wire) {
  if (el.__h === view.s) return false;
  el.__h = view.s; mount(el, view); wire?.(el);
  return true;
}
const TCD_TABS = [['shield', 'Shield'], ['send', 'Send'], ['withdraw', 'Withdraw'], ['receive', 'Receive']];
const TCD_DEST = [['wallet', 'Your wallet'], ['pool', 'Private pool'], ['btc', 'Bitcoin']];
const TCD_LINE = { receive: 'One address for payments on the Tacit chain and in the Bitcoin pool.' };
const TCD_FOOT = {
  chain: {
    shield: 'Your wallet and the amount show; who holds the shares stays hidden.',
    send: 'Who and how much stay hidden.',
    sendEth: 'Arrives as public TAC; the sender stays hidden.',
    wallet: 'Your wallet and the amount show; who holds the shares stays hidden.',
    pool: 'The amount shows; who holds it stays hidden.',
    btc: 'The amount shows; who holds it stays hidden. Then bridged to your Bitcoin address.',
    receive: 'Payments are found with your key; the recipient stays hidden.',
  },
  btc: {
    shield: 'Your Bitcoin address shows; the amount stays hidden.',
    send: 'Who and how much stay hidden.',
    withdraw: 'Your Bitcoin address shows; the amount stays hidden.',
    receive: 'Payments are found with your key; the recipient stays hidden.',
  },
};
const tcdErr = (m) => html`<span class="err">${m}</span>`;
function tpgPayLink(p) {
  const to = linkText(p.get('to'), 400), amt = (p.get('amt') || '').trim();
  if (!to) return;
  const note = linkText(p.get('for'), 80);
  ctx.TCARD.link = { to, amt: /^\d{1,12}(\.\d{1,8})?$/.test(amt) && Number(amt) > 0 ? amt : '', note };
  Object.assign(ctx.TCO, { full: false, paid: null, rc: null, rcKey: null, q: null, qKey: null, sh: null, shKey: null, flow: null, mv: null, mvKey: null });
  tcardGo('chain', 'send');
  chainWarm();
  requestAnimationFrame(() => { tcardFillLink(); tcoPaint(); window.scrollTo(0, 0); });
}
function tcardFillLink() {
  const l = ctx.TCARD.link, t = $('#tcd-to'), a = $('#tcd-amt');
  if (!l || ctx.TCARD.tab !== 'send') return;
  if (t && !t.value) t.value = l.to;
  if (a && !a.value && l.amt) a.value = l.amt;
  tcardQuoteSoon();
}
const TCL_FEE = 30_000_000n;
function tcardSteps() {
  const el = $('#tcd-steps'), l = ctx.TCARD.link;
  if (!el) return;
  el.hidden = !l;
  if (!l) { if (el.__h) { el.__h = null; mount(el, html``); } return; }
  const k = !!S.key, units = l.amt ? parseUnits(l.amt, 8) : null, held = k ? chainHeld() : null;
  const eth = ctx.TCO.rc?.raw === l.to ? !!ctx.TCO.rc.eth : !!l.to && /^0x[0-9a-fA-F]{40}$/.test(l.to), sk = k && units != null && held != null ? `${eth}|${units}|${held}` : null;
  if (sk && ctx.TCARD.size?.key !== sk) {
    ctx.TCARD.size = { key: sk, v: null };
    chainQuote(eth ? 'withdraw' : 'pay', units)
      .then((q) => (q.most != null && units <= q.most ? { x: 0n, ok: true } : q.first != null ? tcoShieldSize(units, { fee: q.holders + q.fee, first: q.first }) : null))
      .then((v) => { if (ctx.TCARD.size?.key === sk) { ctx.TCARD.size.v = v; tcardSteps(); } }, () => {});
  }
  const sz = sk && ctx.TCARD.size?.key === sk && ctx.TCARD.size.v?.ok ? ctx.TCARD.size.v : null;
  const need = units != null ? units + TCL_FEE : 1n, enough = sz ? sz.x === 0n : held != null && held >= need, gap = held != null && units != null && !enough ? (sz ? sz.x : need - held) : null;
  const wal = k ? (hxWalletBal('wtac') ?? (TACB.who === tacWho() ? TACB.erc : null)) : null;
  ctx.TCARD.linkGap = gap != null ? plain(gap, 8) : '';
  const step = (n, done, title, act = null) => html`<li class="${done ? 'done' : ''}"><span class="n">${done ? '✓' : n}</span><span>${title}</span>${!done && act ? html`<span class="act">${act}</span>` : ''}</li>`;
  const two = !k ? 'TAC on the Tacit chain to pay with' : held == null ? 'TAC on the Tacit chain: reading yours…' : html`TAC on the Tacit chain: you hold <span class="num">${fmt(held, 8, 4)}</span>`;
  const make = wal != null && wal > 0n ? html`<button class="link" type="button" data-tcd-step="shield">${gap != null ? `Make ${fmt(gap, 8, 4)} TAC private` : 'Make TAC private'}</button>`
    : html`<button class="link" type="button" data-hx="swap:ether:tac">Get TAC</button>`;
  const v = html`<p class="tcd-steps-h">Pay <b class="mono">${/^tacit1|^0x/i.test(l.to) ? viewAddr(l.to, 10) : l.to}</b>${l.amt ? html` <b class="num">${l.amt} TAC</b>` : ''}</p><ol>
    ${step(1, k, k ? 'Signed in' : html`<button class="link" type="button" data-signin>Sign in</button> or make a Tacit ID`)}
    ${step(2, k && enough, two, k && held != null ? make : null)}
    ${step(3, false, 'Pay', html`<button class="link" type="button" data-tco-back>Back to the payment</button>`)}
  </ol>`;
  if (el.__h !== v.s) { el.__h = v.s; mount(el, v); }
}
const TCL = { amt: '', note: '', name: '', ok: false, err: '', seq: 0, pub: null };
const tclWho = () => (TCL.ok && TCL.pub === S.key?.pubHex ? TCL.name : S.key?.tacit || '');
const tcardLinkUrl = () => `https://tacit.finance/to/${encodeURIComponent(tclWho())}${TCL.amt ? `/${TCL.amt}` : ''}${TCL.note ? `?for=${encodeURIComponent(TCL.note)}` : ''}`;
const tclQrText = () => (!TCL.note && /^[a-z0-9.-]+$/.test(tclWho()) ? `HTTPS://TACIT.FINANCE/TO/${tclWho().toUpperCase()}${TCL.amt ? `/${TCL.amt}` : ''}` : tcardLinkUrl());
function tcardLinkPaint() {
  const el = $('#tcd-linkrow');
  if (!el || !S.key?.tacit) return;
  const v = html`${keyRow('Your pay link', tcardLinkUrl(), 'Pay link', TCL.err ? html`<span class="err">${TCL.err}</span>` : TCL.ok ? `${TCL.name} points to your Tacit address.` : 'Anyone who opens it can pay you on the Tacit chain; someone new is walked through it.', { fold: 44, qr: true })}`;
  if (el.__h !== v.s) { el.__h = v.s; mount(el, v); }
}
async function tcardLinkName(raw) {
  const my = ++TCL.seq, name = raw.trim().toLowerCase();
  TCL.name = name; TCL.ok = false; TCL.err = '';
  if (!name) return tcardLinkPaint();
  if (!/\.(wei|eth|gwei)$/.test(name)) { TCL.err = 'A name ends in .wei or .eth.'; return tcardLinkPaint(); }
  const r = await resolveToM(name, null, true).catch(() => null);
  if (my !== TCL.seq) return;
  if (r?.address && tacitIsMine(tacitLanes(r.address))) { TCL.ok = true; TCL.pub = S.key.pubHex; }
  else TCL.err = r?.address ? `${name} points to another address.` : `${name} has no Tacit address.`;
  tcardLinkPaint();
}
const tcoQk = (rc, units) => `${rc?.eth ? 'w' : 'p'}|${units}|${ctx.CH.bal ?? ''}|${S.key?.pubHex || ''}`;
const linkText = (v, n) => Array.from(String(v ?? '').replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '').replace(/[\u0000-\u001f\u007f-\u009f\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180e\u200b-\u200f\u202a-\u202e\u2060-\u206f\u3164\ufe00-\ufe0f\ufeff\uffa0]/g, '')).slice(0, n).join('').trim();
const tcoOn = () => ctx.TACP.on && !ctx.TCO.full && !!(ctx.TCARD.link || ctx.TCO.paid);
const tcoName = () => (/\.(eth|wei|gwei)$/i.test(ctx.TCARD.link?.to || '') ? ctx.TCARD.link.to : null);
function tcoUnits() {
  const l = ctx.TCARD.link;
  if (!l) return null;
  const v = l.amt || ($('#tco-amt')?.value || '').trim();
  return /^\d{1,12}(\.\d{1,8})?$/.test(v) && Number(v) > 0 ? parseUnits(v, 8) : null;
}
function tcoShow() {
  const on = tcoOn(), el = $('#tpg-co');
  $('#sheet-tac')?.classList.toggle('co', on);
  if (el) el.hidden = !on;
}
const tcoPut = (el, v) => { if (el && el.__h !== v.s) { el.__h = v.s; mount(el, v); } };
function tcoPaint() {
  tcoShow();
  if (!tcoOn()) return;
  const pay = $('#tco-pay'), done = $('#tco-done');
  pay.hidden = !!ctx.TCO.paid; done.hidden = !ctx.TCO.paid;
  if (ctx.TCO.paid) return tcoPaidPaint();
  const l = ctx.TCARD.link, rc = ctx.TCO.rc, name = tcoName(), k = !!S.key, t4 = (v) => fmt(v, 8, 4);
  const addr = rc?.to || (/^(tac(it|tt|rt)1|0x)/i.test(l.to) ? l.to : null), sure = !!rc && !rc.bad && !rc.pre, units = tcoUnits(), usd = units ? hxUsd('tac', Number(units) / 1e8) : '';
  tcoPut($('#tco-top'), html`<p class="tco-k" id="tco-h">${l.amt ? 'Payment request' : 'Pay'}</p>
    <div class="tco-who">${addr ? idMark(addr, 44) : html`<span class="idm sk"></span>`}<div class="tco-who-t">
      <b class="${name ? '' : 'mono'}">${name || viewAddr(addr || l.to, 10)}</b>
      <span>${name && addr ? html`<span class="mono">${viewAddr(addr, 8)}</span>${/^0x/i.test(addr) ? '' : ' · '}` : ''}${addr && !/^0x/i.test(addr) ? html`ID <b class="num">${addressId(addr)}</b>` : addr && !name ? 'an Ethereum address' : ''}</span>
      ${sure ? html`<span class="tco-ok">${rc.eth ? 'Paid there as public TAC, out of the Tacit chain' : 'Can be paid privately on the Tacit chain'}</span>` : ''}</div></div>
    ${l.note ? html`<p class="tco-note"><span>Their note</span>“${l.note}”</p>` : ''}
    ${l.amt ? html`<p class="tco-amt num">${fmt(units, 8, 8)}<small>TAC</small></p><p class="tco-usd">${usd ? `≈ ${usd}` : html`&nbsp;`}</p>` : ''}`);
  const inEl = $('#tco-in');
  if (!l.amt && !$('#tco-amt')) { inEl.__h = null; mount(inEl, html`<div class="amt tco-amtin"><input id="tco-amt" inputmode="decimal" placeholder="0.00" autocomplete="off" aria-label="How much to pay, in TAC"><span class="u"><svg class="tk sm" aria-hidden="true"><use href="#tk-tac"/></svg>TAC</span></div><p class="tco-usd" id="tco-usd"></p>`); $('#tco-amt').oninput = () => tcoPaint(); }
  else if (l.amt && inEl.firstChild) mount(inEl, html``);
  if ($('#tco-usd')) $('#tco-usd').textContent = usd ? `≈ ${usd}` : '';
  const held = k && chainOn() ? chainHeld() : null, q = ctx.TCO.q && ctx.TCO.qKey === tcoQk(rc, units) ? ctx.TCO.q : null;
  const payKnown = k && (!!S.wallet || !!S.pay || !evm.available() || acctUsed() !== null), via = payKnown ? payer() : null;
  const wal = payKnown && S.address ? hxWalletBal('wtac') : null, needWallet = payKnown && !S.address;
  const most = q?.most ?? (held != null ? held - TCL_FEE : null), waits = ctx.CH.settling && held != null && units != null && units < held;
  const enough = units != null && most != null && (units <= most || waits);
  const gap = units != null && most != null && !enough ? units - most + 1_000_000n : null;
  ctx.TCO.gap = gap != null ? plain(gap, 8) : '';
  const moveNeed = gap != null && units != null ? units + (q?.fee ?? TCL_FEE) - (q?.first ?? held ?? 0n) + 1_000_000n : null;
  ctx.TCO.move = moveNeed != null ? plain(moveNeed, 8) : '';
  const priv = k ? tcardPrivate(S.key.pubHex) : null;
  const sh = !enough && ctx.TCO.sh?.key === tcoQk(rc, units) ? ctx.TCO.sh : null, fits = !!sh && wal != null && wal >= sh.wei;
  let go = ['Pay', null];
  if (rc?.bad) go = ['This link can’t be paid', null];
  else if (!k) go = ['Sign in to pay', 'signin'];
  else if (!chainOn()) go = ['The Tacit chain is not open here', null];
  else if (!rc || rc.pre) go = [name ? `Finding ${name}…` : 'Checking the address…', null];
  else if (!units) go = ['Enter an amount', null];
  else if (held == null) go = ['Reading your TAC…', null];
  else if (enough) go = [`Pay ${fmt(units, 8, 8)} TAC`, 'pay'];
  else if (moveNeed != null && (priv?.defi ?? 0n) >= moveNeed && chainOn() && !ctx.TCO.mv?.err) go = !ctx.TCO.mv ? ['Working out the relay’s fee…', null] : (priv.defi >= ctx.TCO.mv.move ? [`Pay ${fmt(units, 8, 8)} TAC from your DeFi pool`, 'movepay'] : [`Not enough in the DeFi pool: needs ${t4(ctx.TCO.mv.move)} with the relay’s fee`, null]);
  else if (gap != null && (priv?.pool ?? 0n) >= units && !rc?.eth) go = ['Pay from your Bitcoin pool', 'pool'];
  else if (needWallet) go = ['Connect your wallet to pay from it', 'connect'];
  else if (wal == null || (wal > 0n && !sh && !ctx.TCO.shErr)) go = ['Reading your TAC…', null];
  else if (fits) go = [`Pay ${fmt(units, 8, 8)} TAC from ${via === 'tacit' ? 'your key’s address' : 'your wallet'}`, 'walletpay'];
  else if (ctx.TCO.shErr && wal > 0n) go = [`Make ${t4(gap)} TAC private first`, 'shield'];
  else go = ['Get TAC to pay with', 'get'];
  const b = $('#tco-go');
  if (b && b.getAttribute('aria-busy') !== 'true') { if (b.textContent !== go[0]) b.textContent = go[0]; b.dataset.act = go[1] || ''; b.disabled = !go[1]; b.classList.toggle('ghost', go[1] === 'get'); }
  const row = (t, v) => html`<div><dt>${t}</dt><dd>${v}</dd></div>`;
  const elsewhere = !enough && priv ? [['defi', 'in the DeFi pool'], ['pool', 'in the Bitcoin pool']].filter(([key]) => priv[key] > 0n) : [];
  const mvRow = go[1] === 'movepay' && ctx.TCO.mv?.fee != null ? row('Moving it', html`<span class="num">${t4(ctx.TCO.mv.fee)}</span> TAC relay fee, a few minutes`) : '';
  tcoPut($('#tco-rows'), html`${row('Fee', q?.fee != null ? html`<span class="num">${t4(q.fee)}</span> TAC` : units && sure && k ? html`<span class="sk" style="--w:7ch"></span>` : 'shown once you sign in')}
    ${mvRow}${row('Arrives', rc?.eth ? 'in their wallet, about a minute' : html`in seconds, <b>private</b>`)}
    ${row('You hold', !k ? 'sign in to see' : held == null ? html`<span class="sk" style="--w:9ch"></span>` : html`<span class="num">${t4(held)}</span> TAC on the Tacit chain${!enough && wal != null && wal > 0n ? html`<br><span class="num">${fmt(wal, 18, 4)}</span> in ${your(via)}, public` : ''}${elsewhere.map(([key, w]) => html`<br><span class="num">${fmt(priv[key], 8, 4)}</span> ${w}, private`)}`)}`);
  const st = $('#tco-st'), line = rc?.bad ? tcdErr(rc.bad) : ctx.TCO.flow || !k || enough || !units || held == null ? null
    : moveNeed != null && (priv?.defi ?? 0n) >= moveNeed && chainOn() && ctx.TCO.mv?.fee != null ? html`<span class="mute">Your private TAC is in the DeFi pool. The relay moves it to the Tacit chain for <b class="num">${fmt(ctx.TCO.mv.fee, 8, 4)}</b> TAC (<span class="num">${fmt(ctx.TCO.mv.move, 8, 4)}</span> leave the pool in all), then the payment goes: about five minutes.</span>`
    : gap != null && (priv?.pool ?? 0n) >= units && !rc?.eth ? html`<span class="mute">Your private TAC is in the Bitcoin pool: pay from there. It takes about 10 minutes.</span>`
    : needWallet ? html`<span class="mute">Connect the wallet that holds your TAC: one signature makes it private, then the payment goes.</span>`
    : wal == null ? null
    : fits ? html`<span class="mute">${sh.sf || via === 'tacit' ? 'One signature makes' : 'One signature and one transaction make'} <b class="num">${fmt(sh.units, 8, 4)}</b> TAC from ${your(via)} private${sh.sf ? `, ${fmt(sh.sf, 18, 4)} TAC of it to the leader that sends it in (no ETH)` : ''}; the payment goes once it lands, in about a minute.</span>`
    : wal > 0n && sh ? html`<span class="mute">${via === 'tacit' ? 'This key’s address holds' : 'Your wallet holds'} ${fmt(wal, 18, 4)} TAC; this needs ${fmt(sh.wei, 18, 4)} with the fees. Get more with ETH, then pay.</span>`
    : wal === 0n ? html`<span class="mute">${via === 'tacit' ? 'This key’s address has' : 'Your wallet has'} no TAC yet. Get some with ETH, then pay.</span>` : null;
  if (st && b?.getAttribute('aria-busy') !== 'true' && (line || st.dataset.hint)) { if (line) { if (st.dataset.hint !== line.s) { st.dataset.hint = line.s; say(st, line); } } else { delete st.dataset.hint; say(st, ''); } }
  tcoFlowPaint();
  tcoRead();
}
function tcoFlowPaint() {
  const el = $('#tco-flow'), f = ctx.TCO.flow, units = tcoUnits();
  if (!el) return;
  el.hidden = !f;
  if (!f) return;
  const li = (n, t) => html`<li class="${f.step > n ? 'done' : f.step === n ? 'now' : ''}">${t}</li>`;
  tcoPut(el, html`${li(1, f.kind === 'move' ? 'The relay moves it out of the DeFi pool, a few minutes' : f.via === 'tacit' ? 'Signed with your key' : f.way === 'own' ? 'One signature, then one transaction in your wallet' : f.way === 'tx' ? 'One transaction in your wallet' : 'One signature in your wallet')}${li(2, 'Made private on the Tacit chain, in about a minute')}${li(3, html`Paid, <span class="num">${units ? fmt(units, 8, 8) : ''}</span> TAC, private`)}`);
}
async function tcoShieldSize(units, q) {
  const want = units + q.fee - q.first + 100_000n, up = (x) => ((x + 9_999n) / 10_000n) * 10_000n;
  let x = up(want), sq = null;
  for (let i = 0; i < 5; i++) { sq = await chainQuote('shield', x).catch(() => null); if (!sq || sq.arrives >= want) break; x = up(x + want - sq.arrives); }
  return { x, ok: !!sq && sq.arrives >= want && !(sq.cap != null && x > sq.cap) };
}
async function tcoRead() {
  const l = ctx.TCARD.link;
  if (!l || ctx.TCO.paid || !ctx.TACP.on) return;
  const raw = l.to, key = `${S.key?.pubHex || ''}|${raw}`;
  if (ctx.TCO.rcKey !== key) {
    ctx.TCO.rcKey = key; ctx.TCO.rc = null;
    let rc;
    if (/\.(eth|wei|gwei)$/i.test(raw)) rc = S.key && chainOn() ? await tcardName(raw) : await resolveToM(raw).then((r) => ({ raw, to: r?.address || null, pre: true }), () => ({ raw, pre: true }));
    else if (/^0x[0-9a-fA-F]{40}$/.test(raw)) { try { chainNotTo(raw); rc = { raw, to: raw, eth: true }; } catch (e) { rc = { raw, to: raw, bad: errText(e) }; } }
    else if (/^tac(it|tt|rt)1/i.test(raw)) {
      const lanes = tacitLanes(raw);
      if (!lanes) rc = { raw, bad: 'The address in this link does not read. Ask them for the link again.' };
      else if (tacitIsMine(lanes)) rc = { raw, to: raw, bad: 'This is your own pay link: send it to whoever pays you.' };
      else if (!S.key || !chainOn()) rc = { raw, to: raw, pre: true };
      else rc = await chainRecipient(lanes).then(() => ({ raw, to: raw }), () => ({ raw, to: raw, bad: 'This Tacit address has not opened the Tacit chain yet. They open their Tacit wallet once, then it can be paid.' }));
    } else rc = { raw, other: true };
    if (ctx.TCO.rcKey !== key) return;
    ctx.TCO.rc = rc;
    if (rc.bad && /has not opened|has no Tacit address/.test(rc.bad)) setTimeout(() => { if (ctx.TCO.rcKey === key && ctx.TCO.rc === rc) { ctx.TCO.rcKey = null; tcoPaint(); } }, 20e3);
    if (rc.other) { ctx.TCO.full = true; tcoShow(); return; }
    return tcoPaint();
  }
  const rc = ctx.TCO.rc, units = tcoUnits();
  if (!rc || rc.bad || rc.pre || rc.other || !S.key || !units) return;
  const qk = tcoQk(rc, units);
  if (ctx.TCO.qKey !== qk) {
    ctx.TCO.qKey = qk; ctx.TCO.q = null;
    const q = await chainQuote(rc.eth ? 'withdraw' : 'pay', units).catch(() => null);
    if (ctx.TCO.qKey !== qk) return;
    ctx.TCO.q = { fee: q ? q.holders + q.fee : null, most: q?.most ?? null, first: q?.first ?? null };
    tcoPaint();
  }
  const q = ctx.TCO.q;
  if (q?.most != null && units > q.most && q.first != null && q.fee != null) {
    const key = tcoQk(rc, units);
    if (ctx.TCO.shKey !== key) {
      ctx.TCO.shKey = key; ctx.TCO.sh = null; ctx.TCO.shErr = false;
      const { x, ok } = await tcoShieldSize(units, q);
      const sf = tcardWay() === 'permit' ? await chainSweepFee().catch(() => 0n) : 0n;
      if (ctx.TCO.shKey !== key) return;
      if (ok) { ctx.TCO.sh = { key, units: x, sf, wei: x * E10 + sf + sf / 10n }; chainWrapWarm(); }
      else ctx.TCO.shErr = true;
      tcoPaint();
    }
  }
  if (!ctx.CH.settling && units <= (q?.most ?? 0n)) chainAhead(rc.to, units);
  const pool = tcardPrivate(S.key.pubHex)?.defi ?? 0n;
  if (q?.most != null && units > q.most && pool > 0n && chainOn()) {
    const key = `${rc.eth ? 'w' : 'p'}|${units}|${ctx.CH.bal ?? 0n}`;
    if (ctx.TCO.mvKey !== key) {
      ctx.TCO.mvKey = key; ctx.TCO.mv = null;
      const mv = await tcoMoveSize(units, rc).catch(() => null);
      if (ctx.TCO.mvKey !== key) return;
      ctx.TCO.mv = mv ? { ...mv, key } : { err: true, key };
      tcoPaint();
    }
  }
}
async function tcoPress(go) {
  const act = go.dataset.act, st = $('#tco-st');
  if (act === 'signin') return openSheet('wallet');
  if (act === 'shield') {
    const gap = ctx.TCO.gap;
    ctx.TCO.full = true; tcoShow(); tcardGo('chain', 'shield');
    requestAnimationFrame(() => { const a = $('#tcd-amt'); if (a && gap) { a.value = gap; tcardQuote(); } $('#tcd-steps')?.scrollIntoView({ block: 'start' }); });
    return;
  }
  if (act === 'get') { ctx.TCO.full = true; tcoShow(); tpgTile('swap:ether:tac', '', 'Get TAC'); return; }
  if (act === 'walletpay') return tcoWalletPay(go);
  if (act === 'movepay') return tcoMovePay(go);
  if (act === 'pool') { ctx.TCO.full = true; tcoShow(); tcardGo('btc', 'send'); return; }
  if (act === 'connect') return connect().then(() => rerender('tac'), () => {});
  const l = ctx.TCARD.link, units = tcoUnits(), rc = ctx.TCO.rc;
  if (act !== 'pay' || !l || !units || !rc || rc.bad || rc.pre) return;
  delete st.dataset.hint; say(st, '');
  const t0 = performance.now(), who = tcoName() || short(rc.to, 8);
  const opts = { after: tcoAfter, sent: (s, lead, landing) => { say(s, ''); tcoPaid(units, who, rc.to, landing, t0); } };
  if (tcoName()) {
    return busy(go, async (run) => {
      say(st, 'Checking where it points…');
      const now = await tcardName(l.to, true);
      if (now.bad || now.to !== rc.to) { ctx.TCO.rcKey = null; tcoPaint(); return say(st, tcdErr(`${l.to} points somewhere else now. Check it and press again.`)); }
      say(st, '');
      await chainPayRun(run, st, units, now.to, opts);
    });
  }
  return busy(go, (run) => chainPayRun(run, st, units, rc.to, opts));
}
async function tcoWalletPay(go) {
  const l = ctx.TCARD.link, units = tcoUnits(), rc = ctx.TCO.rc, sh = ctx.TCO.sh, st = $('#tco-st'), from = S.address;
  if (!l || !units || !rc || rc.bad || rc.pre || !sh || !from) return;
  delete st.dataset.hint; say(st, '');
  const t0 = performance.now(), who = tcoName() || short(rc.to, 8), flow = ctx.TCO.flow = { step: 1, via: payer(), way: tcardWay() };
  tcoFlowPaint();
  const stop = () => { if (ctx.TCO.flow === flow) ctx.TCO.flow = null; tcoFlowPaint(); };
  return busy(go, async (run) => {
    let failed = false;
    const fail = run.fail, was = ctx.CH.bal ?? 0n;
    run.fail = (el, e) => { failed = true; stop(); return fail(el, e); };
    if (S.address !== from) { stop(); return say(st, tcdErr('The account that pays changed. Check the amounts and press again.')); }
    await chainShieldRun(run, st, sh.units, { held: hxWalletBal('wtac'), way: flow.way, after: null, phase: (p) => { if (p === 'handed') { flow.step = 2; tcoFlowPaint(); } } });
    if (failed) return;
    flow.step = 2; tcoFlowPaint();
    try {
      for (let i = 0; i < 6 && (ctx.CH.bal ?? 0n) <= was; i++) await chainSettle((b) => b > was);
      run.check();
      flow.step = 3; tcoFlowPaint();
      say(st, '');
      if (tcoName()) {
        const now = await tcardName(l.to, true);
        if (now.bad || now.to !== rc.to) { stop(); ctx.TCO.rcKey = null; return say(st, tcdErr(`${l.to} points somewhere else now. Your TAC is private on the Tacit chain: check the name and press again.`)); }
      }
      await chainPayRun(run, st, units, rc.to, { after: tcoAfter, sent: (s, lead, landing) => { say(s, ''); stop(); tcoPaid(units, who, rc.to, landing, t0, flow.via !== 'tacit' && flow.way !== 'permit' ? 'sent' : 'signed'); } });
    } catch (e) { run.fail(st, e); }
  });
}
async function tcoMoveSize(units, rc, fresh = false) {
  const [c, t] = await Promise.all([chainClient(), getUx()]);
  if (fresh) await chainScan(true).catch(() => null);
  const q = await c.quote(rc.eth ? 'withdraw' : 'pay', units), up = (x) => ((x + 9_999n) / 10_000n) * 10_000n;
  const want = units + q.fee + q.holders - q.first + 1_000_000n;
  let x = up(want);
  for (let i = 0; i < 5; i++) { const sq = await c.quote('shield', x); if (sq.arrives >= want) break; x = up(x + want - sq.arrives); }
  const feeOf = async (n) => t.quoteUnwrapFee(n, 'cTAC', { minFee: BigInt(await t.quoteOpFee('cTAC', freeNotes(P.scan?.tac?.notes).some((y) => BigInt(y.value) === n) ? 'unwrap' : 'sendunwrap')) }).fee;
  const f1 = await feeOf(x), f2 = await feeOf(x + f1), fee = f2 > f1 ? f2 : f1;
  return { move: x + fee, fee };
}
async function tcoMovePay(go) {
  const l = ctx.TCARD.link, units = tcoUnits(), rc = ctx.TCO.rc, st = $('#tco-st');
  if (!l || !units || !rc || rc.bad || rc.pre) return;
  delete st.dataset.hint; say(st, '');
  const t0 = performance.now(), who = tcoName() || short(rc.to, 8), flow = ctx.TCO.flow = { step: 1, kind: 'move' };
  tcoFlowPaint();
  const stop = () => { if (ctx.TCO.flow === flow) ctx.TCO.flow = null; tcoFlowPaint(); };
  return busy(go, async (run) => {
    let failed = false;
    const fail = run.fail, was = ctx.CH.bal ?? 0n;
    run.fail = (el, e) => { failed = true; stop(); return fail(el, e); };
    try {
      const c = await chainClient(), { move, fee } = await tcoMoveSize(units, rc, true), pool = tcardPrivate(S.key.pubHex)?.defi ?? 0n;
      if (move > pool) throw chainSaid(`With the relay’s fee of ${fmt(fee, 8, 4)} TAC this needs ${fmt(move, 8, 4)} TAC from the DeFi pool, which holds ${fmt(pool, 8, 4)}.`);
      await chainInRun(run, st, move, null, null, () => { flow.step = 2; tcoFlowPaint(); });
    } catch (e) { if (!failed) { failed = true; stop(); run.fail(st, e); } }
    if (failed) return;
    flow.step = 2; tcoFlowPaint();
    try {
      for (let i = 0; i < 6 && (ctx.CH.bal ?? 0n) <= was; i++) await chainSettle((b) => b > was);
      run.check();
      flow.step = 3; tcoFlowPaint();
      say(st, '');
      if (tcoName()) {
        const now = await tcardName(l.to, true);
        if (now.bad || now.to !== rc.to) { stop(); ctx.TCO.rcKey = null; return say(st, tcdErr(`${l.to} points somewhere else now. Your TAC is private on the Tacit chain: check the name and press again.`)); }
      }
      await chainPayRun(run, st, units, rc.to, { after: tcoAfter, sent: (s, lead, landing) => { say(s, ''); stop(); tcoPaid(units, who, rc.to, landing, t0, 'moved'); } });
    } catch (e) { run.fail(st, e); }
  });
}
const tcoAfter = () => {
  ctx.TCARD.link = null;
  for (const i of [$('#tcd-to'), $('#tcd-amt')]) if (i) clearField(i);
  if (/^#to=/.test(location.hash)) history.replaceState(null, '', location.pathname + location.search);
};
function tcoPaid(units, who, to, landing, t0, how = null) {
  const p = ctx.TCO.paid = { units, who, to, secs: (performance.now() - t0) / 1000, landed: false, height: null, err: false, n: Date.now(), how };
  tcoPaint();
  landing.then((r) => { if (ctx.TCO.paid !== p) return; p.landed = true; p.height = r?.height ?? null; tcoPaidPaint(); },
    () => { if (ctx.TCO.paid !== p) return; p.err = true; tcoPaidPaint(); toast('A Tacit chain payment has not landed yet. It is kept here and goes on by itself.', true); });
}
function tcoPaidPaint() {
  const p = ctx.TCO.paid, el = $('#tco-done');
  if (!p || !el) return;
  if (el.dataset.n !== String(p.n)) {
    el.dataset.n = String(p.n);
    mount(el, html`<div class="tco-paid">${tickSvg()}
      <p class="tco-k" id="tco-h">Paid</p>
      <p class="tco-amt num">${fmt(p.units, 8, 8)}<small>TAC</small></p>
      <p class="tco-to">to <b>${p.who}</b>${p.secs <= 20 ? html` · in <span class="num">${p.secs.toFixed(1)}</span> seconds` : ''}</p>
      <ol class="tco-tl">${p.how === 'signed' ? html`<li class="done">Made private with one signature</li>` : p.how === 'sent' ? html`<li class="done">Made private from your wallet</li>` : p.how === 'moved' ? html`<li class="done">Moved from the DeFi pool</li>` : ''}<li class="done">Proved on this device</li><li class="done">With the Tacit chain, private</li><li id="tco-land"></li></ol>
      <button class="btn ghost tco-go" type="button" data-tco-done>Done</button></div>`);
  }
  const li = $('#tco-land');
  li.className = p.landed ? 'done' : p.err ? 'err' : 'now';
  mount(li, p.landed ? html`Settled on Ethereum${p.height != null ? html`, in block <b class="num">${p.height}</b>` : ''}` : p.err ? 'Not settled yet: it is kept here and goes on by itself' : 'Settling on Ethereum, about a minute…');
}
const tickSvg = () => html`<svg class="tick" viewBox="0 0 52 52" aria-hidden="true"><circle cx="26" cy="26" r="24"/><path d="M15 27.5l7.5 7.5L38 19"/></svg>`;
function treqOpen() {
  const d = $('#tac-req');
  if (!d || !S.key?.tacit || !chainOn()) return;
  Object.assign(ctx.TREQ, { open: true, n: ctx.TREQ.n + 1, units: TCL.amt ? parseUnits(TCL.amt, 8) : null, seen: null, paid: null, less: 0n, landed: false, pub: S.key.pubHex });
  $('#treq-b').__h = null;
  treqPaint();
  if (!d.open) d.showModal();
  try { navigator.wakeLock?.request('screen').then((l) => { if (ctx.TREQ.open) ctx.TREQ.lock = l; else l.release?.(); }, () => {}); } catch { }
  treqWatch(ctx.TREQ.n);
}
function treqClose() {
  ctx.TREQ.open = false; ctx.TREQ.n++;
  try { ctx.TREQ.lock?.release(); } catch { }
  ctx.TREQ.lock = null;
  const d = $('#tac-req');
  if (d?.open) d.close();
}
function treqPaint() {
  const el = $('#treq-b');
  if (!el || !S.key?.tacit) return;
  const units = ctx.TREQ.units, usd = units ? hxUsd('tac', Number(units) / 1e8) : '', who = TCL.ok && TCL.pub === S.key?.pubHex ? TCL.name : null;
  const head = html`<div class="treq-id">${idMark(S.key.tacit, 30)}<span>${who ? html`<b>${who}</b> · ` : ''}ID <b class="num">${addressId(S.key.tacit)}</b></span></div>`;
  if (ctx.TREQ.paid) {
    const got = units && ctx.TREQ.paid.units + 10n >= units && ctx.TREQ.paid.units <= units + units / 1000n + 10n ? units : ctx.TREQ.paid.units, gotUsd = hxUsd('tac', Number(got) / 1e8);
    const v = html`<div class="treq-paid">${tickSvg()}<p class="treq-k" id="treq-h">Paid</p>
      <p class="treq-amt num">${fmt(got, 8, 8)}<small>TAC</small></p>
      <p class="treq-usd">${gotUsd ? `≈ ${gotUsd} · ` : ''}private, on the Tacit chain</p>
      <p class="treq-land ${ctx.TREQ.landed ? 'ok' : ''}" id="treq-land">${ctx.TREQ.landed ? 'Settled on Ethereum ✓' : 'Settling on Ethereum, about a minute…'}</p>
      ${head}
      <div class="treq-acts"><button class="btn" type="button" data-treq-new>New request</button><button class="btn ghost" type="button" data-treq-close>Done</button></div></div>`;
    if (el.__h !== v.s) { el.__h = v.s; mount(el, v); }
    return;
  }
  const v = html`<p class="treq-k" id="treq-h">${who ? html`Pay <b>${who}</b>` : 'Pay me in TAC'}</p>
    ${units ? html`<p class="treq-amt num">${fmt(units, 8, 8)}<small>TAC</small></p><p class="treq-usd">${usd ? `≈ ${usd}` : html`&nbsp;`}</p>` : html`<p class="treq-amt any">Any amount</p>`}
    ${TCL.note ? html`<p class="treq-note">“${TCL.note}”</p>` : ''}
    <div class="treq-qr" id="treq-qr"></div>
    <p class="treq-st" role="status"><span class="dot live" aria-hidden="true"></span>${ctx.TREQ.less > 0n ? html`Got <span class="num">${fmt(ctx.TREQ.less, 8, 4)}</span> TAC so far, less than asked. Still waiting…` : 'Waiting for the payment'}</p>
    ${head}
    <p class="treq-hint">Scan it with a phone’s camera: tacit.finance opens with this payment ready. It arrives in seconds, private.</p>
    <div class="treq-acts"><button class="btn ghost" type="button" data-treq-copy>Copy link</button>${navigator.share ? html`<button class="btn ghost" type="button" data-treq-share>Share</button>` : ''}</div>`;
  if (el.__h === v.s) return;
  el.__h = v.s; mount(el, v);
  const box = $('#treq-qr'), w = Math.min(320, innerWidth - 80);
  qrModule().then((m) => { if (box.isConnected) box.innerHTML = m.qrSvg(tclQrText(), w, 'QR code of your pay link', { mark: 'tac' }); }, () => { box.textContent = tcardLinkUrl(); });
}
async function treqWatch(my) {
  const c = await chainClient().catch(() => null);
  if (!c || my !== ctx.TREQ.n) return;
  ctx.TREQ.seen = new Set((await c.incomingNotes().catch(() => [])).map((x) => x.key));
  await chainScan(true).catch(() => {});
  ctx.TREQ.had = new Set((await c.noteList().catch(() => [])).map((x) => x.key)); ctx.TREQ.handed = ctx.CH.handed || 0;
  for (let i = 1; ctx.TREQ.open && my === ctx.TREQ.n && !ctx.TREQ.paid; i++) {
    await sleep(2000);
    if (S.key?.pubHex !== ctx.TREQ.pub) { if (my === ctx.TREQ.n) treqClose(); return; }
    if (document.hidden || my !== ctx.TREQ.n) continue;
    if (i % 5 === 0 && ctx.TREQ.had && (ctx.CH.handed || 0) === ctx.TREQ.handed) {
      await chainScan(true).catch(() => {});
      if (my !== ctx.TREQ.n || !ctx.TREQ.open) continue;
      for (const x of (await c.noteList().catch(() => [])).filter((y) => !ctx.TREQ.had.has(y.key) && !ctx.TREQ.seen.has(y.key) && !c.ownLeaf?.(y.key))) {
        ctx.TREQ.had.add(x.key);
        if (!ctx.TREQ.units || x.units + 10n >= ctx.TREQ.units) { ctx.TREQ.paid = x; ctx.TREQ.landed = true; break; }
      }
      if (ctx.TREQ.paid) break;
    }
    const got = await c.incomingNotes().catch(() => null);
    if (!got || my !== ctx.TREQ.n || !ctx.TREQ.open) continue;
    for (const x of got.filter((y) => !ctx.TREQ.seen.has(y.key))) {
      ctx.TREQ.seen.add(x.key);
      if (ctx.TREQ.paid) continue;
      if (!ctx.TREQ.units || x.units + 10n >= ctx.TREQ.units) ctx.TREQ.paid = x;
      else ctx.TREQ.less += x.units;
    }
    treqPaint();
  }
  if (!ctx.TREQ.paid || my !== ctx.TREQ.n) return;
  try { navigator.vibrate?.([24, 60, 24]); } catch { }
  treqPaint();
  chainScan(true).catch(() => {});
  for (let i = 0; i < 180 && my === ctx.TREQ.n && !ctx.TREQ.landed; i++) {
    await sleep(5000);
    if (my !== ctx.TREQ.n) return;
    await chainScan(true).catch(() => {});
    if (c.has(ctx.TREQ.paid.key)) { ctx.TREQ.landed = true; const l = $('#treq-land'); if (l) { l.classList.add('ok'); l.textContent = 'Settled on Ethereum ✓'; } rerender('tac'); }
  }
}
document.addEventListener('click', (e) => {
  const b = e.target.closest?.('[data-treq-close], [data-treq-new], [data-treq-copy], [data-treq-share], [data-tco-full], [data-tco-back], [data-tco-done], #tco-go');
  if (!b) return;
  const d = b.dataset;
  if (b.id === 'tco-go') return tcoPress(b);
  if (d.treqClose != null) return treqClose();
  if (d.treqNew != null) { treqClose(); requestAnimationFrame(() => { const a = $('#tcd-link-amt'); if (a) { a.value = ''; a.dispatchEvent(new Event('input')); a.focus(); } }); return; }
  if (d.treqCopy != null) return copy(tcardLinkUrl(), 'Pay link copied');
  if (d.treqShare != null) return navigator.share?.({ title: TCL.amt ? `Pay ${TCL.amt} TAC` : 'Pay me in TAC', url: tcardLinkUrl() }).catch(() => {});
  if (d.tcoFull != null) { ctx.TCO.full = true; tcoShow(); rerender('tac'); return; }
  if (d.tcoBack != null) { ctx.TCO.full = false; tcardGo('chain', 'send'); tcoPaint(); window.scrollTo(0, 0); return; }
  if (d.tcoDone != null) { ctx.TCO.paid = null; ctx.TCO.full = false; tcoShow(); rerender('tac'); window.scrollTo(0, 0); }
});
$('#tac-req')?.addEventListener('close', () => { if (ctx.TREQ.open) treqClose(); });
$('#tac-req')?.addEventListener('click', (e) => { if (e.target === e.currentTarget) treqClose(); });
function tcardSide() {
  if (!chainOn()) return 'btc';
  if (ctx.TCARD.side) return ctx.TCARD.side;
  const h = tpgHave(), some = (v) => v != null && v > 0n;
  return !some(h.chain) && !some(h.wallet) && !some(h.defi) && (some(h.pool) || some(h.btc)) ? 'btc' : 'chain';
}
const tcardWay = () => chainWayOf(ctx.TCARD.way);
function tcardGo(side, tab = null) {
  if (tpgBusy('#tpg-card')) return false;
  if (ctx.TACP.act) tpgAct(null);
  if (side === 'btc') { tacPoolOpen(tab || ctx.TPOOL.api?.view()[0] || 'shield'); return true; }
  ctx.TCARD.side = 'chain'; ctx.TPOOL.open = false;
  if (tab) ctx.TCARD.tab = tab;
  tcard(); syncLink();
  return true;
}
function tcardHead(side) {
  const k = S.key?.pubHex, chain = side !== 'btc', h = k ? tpgHave() : null, sk = html`<span class="sk" style="--w:10ch"></span>`;
  const seenV = (p) => { const w = k ? tacSeen(k)?.[p] : null; return w == null ? null : BigInt(w) / E10; };
  const v = !k ? null : chain ? (ctx.CH.pub === k && ctx.CH.bal != null ? ctx.CH.bal : seenV('chain')) : h.pool ?? seenV('pool'), usd = v != null && v > 0n ? hxUsd('tac', Number(v) / 1e8) : '';
  const shares = chain && k && ctx.TACP.sh?.pub === k ? ctx.TACP.sh.v : null;
  const cs = TPGW.cs, up = cs ? (tpgPrice(cs.pool, cs.shares) - 1) * 100 : null;
  const pubU = !k ? null : chain ? h.wallet : h.btc, capU = chain && CHAIN_SWEEP.cap != null ? CHAIN_SWEEP.cap : null, over = pubU != null && capU != null && pubU > capU;
  return html`<h2 class="tcd-k" id="tcd-name"><svg class="tk sm" aria-hidden="true"><use href="#tk-tac"/></svg><b>Private TAC</b><span>${chain ? 'on the Tacit chain' : 'on Bitcoin, in the shielded pool'}</span></h2>
    ${!k ? '' : html`<p class="tcd-v num">${v == null ? (chain && ctx.CH.err ? '—' : sk) : fmt(v, 8, 4)}<small>TAC</small></p>
    <p class="tcd-sub">${[usd && `≈ ${usd}`, shares != null && shares > 0n && `${fmt(shares, 8, 4)} shares`, shares != null && shares > 0n && up != null && up > 0 && html`<span class="tcd-up">each +${up.toFixed(2)}% since the chain began</span>`, chain && ctx.CH.pub === k && (ctx.CH.incoming ?? 0n) > 0n && `+${fmt(ctx.CH.incoming, 8, 4)} TAC incoming`].filter(Boolean).flatMap((x, i) => (i ? [' · ', x] : [x]))}</p>`}
    ${tcardAll(k, side)}
    ${pubU != null && pubU > 0n ? html`<p class="tcd-nudge">${fmt(pubU, 8, 2)} TAC is public ${chain ? (payer() === 'tacit' && !S.wallet ? 'at this key’s address' : 'in your wallet') : 'at your Bitcoin address'}. <button class="link" type="button" id="tpg-priv">${over ? `Shield ${fmt(capU, 8, 0)} of it` : 'Shield it'}</button></p>` : ''}`;
}
function tcardPrivate(k) {
  if (!k) return null;
  const pl = Object.fromEntries(tacSeenOn(k, tacPlaces(k, tacWho())).map((p) => [p.key, p.v == null ? null : p.v / E10]));
  return { chain: pl.chain ?? 0n, pool: pl.pool ?? 0n, defi: pl.defi ?? 0n, pay: pl.pay ?? 0n };
}
function tcardAll(k, side) {
  const p = tcardPrivate(k);
  if (!p) return '';
  const here = side === 'btc' ? 'pool' : 'chain', t = (v) => fmt(v, 8, 2);
  const rest = [['chain', 'on the Tacit chain', html`<button class="link" type="button" data-tcd-side="chain">Show</button>`],
    ['pool', 'in the Bitcoin pool', html`<button class="link" type="button" data-tcd-side="btc">Show</button>`],
    ['defi', 'in the DeFi pool', chainOn() ? html`<button class="link" type="button" data-hx="shield:tac:chain" data-amt="${plain(p.defi, 8)}">Move to the Tacit chain</button>` : ''],
    ['pay', 'in the pay pool', '']].filter(([key]) => key !== here && p[key] > 0n);
  if (!rest.length) return '';
  const all = p.chain + p.pool + p.defi + p.pay;
  return html`<p class="tcd-all"><b class="num">${t(all)}</b> private in all: ${rest.map(([key, what, go], i) => html`${i ? ' · ' : ''}<span class="num">${t(p[key])}</span> ${what}${go ? html` ${go}` : ''}`)}</p>`;
}
const tcdAmt = () => html`<div class="lbl"><label for="tcd-amt">Amount</label><span class="tcd-have num" id="tcd-have"></span><button type="button" id="tcd-max">Max</button></div>
  <div class="amt"><input id="tcd-amt" inputmode="decimal" placeholder="0.00" autocomplete="off"><span class="u"><svg class="tk sm" aria-hidden="true"><use href="#tk-tac"/></svg>TAC</span></div>`;
const tcdRow = (k, v) => html`<div><dt>${k}</dt><dd>${v}</dd></div>`;
const tcdRows = (...rows) => html`<dl class="tcd-rows">${rows.filter(Boolean)}</dl>`;
const tcdHave = (text) => { const el = $('#tcd-have'); if (el && el.textContent !== text) el.textContent = text; };
function tcdGas(way, sf, units) {
  if (S.address && (HXWB.who !== S.address || !HXWB.at)) return tcdRow('Gas', html`<span class="sk" style="--w:11ch"></span>`);
  const pick = !!S.key && way !== 'tx' && hxChainEth(), wei = units ? units * E10 : 0n;
  const dear = way === 'permit' && sf && wei && sf * 10n > wei ? html`<span class="warn">${Math.round(Number(sf * 100n / wei))}% of this shield</span>` : '';
  return tcdRow(pick ? html`Gas in<span class="tcd-gas" role="group" aria-label="What the gas is paid in">${[['permit', 'TAC'], ['own', 'ETH']].map(([k, t]) => html`<button type="button" aria-pressed="${String(way === k)}" data-tcd-way="${k}">${t}</button>`)}</span>` : 'Gas',
    way === 'permit' ? html`<span><span class="num">${fmt(sf, 18, 4)}</span> TAC${pick ? '' : ', no ETH needed'}</span>${dear}` : html`<span>your ETH, no fee</span>`);
}
const tcdTakes = (way) => (payer() === 'tacit' && S.key ? 'Signed by this key' : way === 'permit' ? 'One signature' : way === 'own' ? 'One signature, one transaction' : 'One transaction');
const TCD_FLOW = { permit: ['prove', 'sign', 'block', 'land'], own: ['prove', 'sign', 'send', 'block', 'land'], tx: ['prove', 'send', 'block', 'land'], spend: ['prove', 'block', 'land'] };
const TCD_STEP = { prove: ['Prove', 'Proved'], sign: ['Sign', 'Signed'], send: ['Send', 'Sent'], block: ['Block', 'In a block'], land: ['Ethereum', 'On Ethereum'] };
function tcdFlowPaint() {
  const el = $('#tcd-flow'), f = ctx.TCARD.flow?.tab === ctx.TCARD.tab ? ctx.TCARD.flow : null;
  if (!el) return;
  el.hidden = !f;
  if (!f) { if (el.__h) { el.__h = null; mount(el, html``); } return; }
  const keys = TCD_FLOW[f.way], at = f.done >= keys.length ? -1 : f.done;
  const v = html`${keys.map((k, i) => html`<li class="${i < f.done ? 'done' : i === at ? 'now' : ''}" aria-current="${i === at ? 'step' : 'false'}">${TCD_STEP[k][i < f.done ? 1 : 0]}</li>`)}`;
  if (el.__h !== v.s) { el.__h = v.s; mount(el, v); }
}
function tcdFlow(way) {
  const f = ctx.TCARD.flow = { way, done: 0, tab: ctx.TCARD.tab };
  const upTo = (k) => { const i = TCD_FLOW[f.way].indexOf(k) + 1; if (ctx.TCARD.flow === f && i > f.done) { f.done = i; tcdFlowPaint(); } };
  tcdFlowPaint();
  return {
    phase: (p) => { if (p === 'transfer') f.way = 'tx'; else upTo({ proved: 'prove', signed: 'sign', sent: 'send', handed: TCD_FLOW[f.way][TCD_FLOW[f.way].indexOf('block') - 1], landed: 'land' }[p]); },
    stop: () => { if (ctx.TCARD.flow === f) { ctx.TCARD.flow = null; tcdFlowPaint(); } },
    wrap: (run) => { const fail = run.fail; run.fail = (el, e) => { if (ctx.TCARD.flow === f) { ctx.TCARD.flow = null; tcdFlowPaint(); } return fail(el, e); }; },
  };
}
function tcardForm() {
  const tab = ctx.TCARD.tab, key = !!S.key, line = TCD_LINE[tab] ? html`<p class="tcd-line">${TCD_LINE[tab]}</p>` : '';
  if (tab === 'receive') {
    if (!key) return html`${line}<button class="btn tcd-go" type="button" data-signin>Sign in to see your address</button>`;
    return html`${line}<div class="lbl"><label for="tcd-link-amt">Ask for</label><span>or leave it to them</span></div>
      <div class="amt"><input id="tcd-link-amt" inputmode="decimal" placeholder="Any amount" autocomplete="off"><span class="u"><svg class="tk sm" aria-hidden="true"><use href="#tk-tac"/></svg>TAC</span></div>
      <div class="tcd-linkin"><input id="tcd-link-for" maxlength="80" placeholder="What for (optional)" aria-label="What it is for, optional: the payer sees it" autocomplete="off"><input id="tcd-link-name" placeholder="your name (.wei), optional" aria-label="A name of yours for the link, optional" autocomplete="off" spellcheck="false" autocapitalize="off"></div>
      <button class="btn tcd-go" type="button" id="tcd-req-go">Show the code to pay</button>
      <div id="tcd-linkrow"></div>
      ${navigator.share ? html`<button class="btn ghost tcd-go" type="button" id="tcd-share">Share your pay link</button>` : ''}
      ${keyRow('Your Tacit address', S.key.tacit || '', 'Tacit address', '', { fold: 44, qr: true })}
      <button class="btn ghost tcd-go" type="button" id="tcd-scan">Scan for payments</button><div class="status" role="status" id="tcd-st"></div>`;
  }
  const go = !key ? 'Sign in' : { shield: 'Shield TAC', send: 'Send privately', withdraw: { wallet: 'Withdraw to your wallet', pool: 'Move to the private pool', btc: 'Move toward Bitcoin' }[ctx.TCARD.dest] }[tab];
  return html`${line}
    ${tab === 'withdraw' ? html`<div class="tcd-dest" role="radiogroup" aria-label="Where it goes">${TCD_DEST.map(([k, t]) => html`<button type="button" role="radio" aria-checked="${String(ctx.TCARD.dest === k)}" tabindex="${ctx.TCARD.dest === k ? 0 : -1}" data-tcd-dest="${k}">${t}</button>`)}</div>` : ''}
    ${tcdAmt()}
    ${tab === 'send' ? html`<div class="lbl"><label for="tcd-to">To</label><span>tacit1…, 0x… or a name</span></div>
      <div class="amt text"><input id="tcd-to" placeholder="Their name.wei or tacit1… address" autocomplete="off" spellcheck="false" autocapitalize="off" autocorrect="off"></div>` : ''}
    <div class="note tcd-q" id="tcd-q" data-tab="${tab}" aria-live="polite"></div>
    <button class="btn tcd-go" type="button" id="tcd-go">${go}</button>
    ${tab === 'withdraw' && ctx.TCARD.dest === 'wallet' && key ? html`<p class="tcd-way"><button class="link" type="button" data-tcd-tab="send">Another address? Send it there</button></p>` : ''}
    <ol class="tcd-flow" id="tcd-flow" aria-label="How far it is" hidden></ol>
    <div class="status" role="status" id="tcd-st"></div>
    ${tab === 'send' ? html`<p class="note">No wallet on their side? <button class="link" type="button" id="tcd-claim">Send a claim link</button> from the Bitcoin pool.</p>` : ''}`;
}
function tcardWire(el) {
  const amt = $('#tcd-amt', el), to = $('#tcd-to', el);
  if (amt) amt.oninput = () => { ctx.TCARD.side ||= 'chain'; if (ctx.TCARD.flow && ctx.TCARD.flow.done >= TCD_FLOW[ctx.TCARD.flow.way].length) { ctx.TCARD.flow = null; tcdFlowPaint(); } tcardQuoteSoon(); };
  if (to) to.oninput = () => { ctx.TCARD.side ||= 'chain'; tcardQuoteSoon(); };
  const max = $('#tcd-max', el);
  if (max) max.onclick = () => tcardMax().catch(() => {});
  const go = $('#tcd-go', el);
  if (go) go.onclick = () => tcardPress(go);
  const claim = $('#tcd-claim', el);
  if (claim) claim.onclick = () => tacPoolOpen('send').then(() => requestAnimationFrame(() => $('#tp-claim-amt')?.scrollIntoView({ block: 'center' })));
  const la = $('#tcd-link-amt', el), ln = $('#tcd-link-name', el), share = $('#tcd-share', el), lf = $('#tcd-link-for', el), rq = $('#tcd-req-go', el);
  if (la) { la.value = TCL.amt; la.oninput = () => { const v = la.value.trim(); TCL.amt = /^\d{1,12}(\.\d{1,8})?$/.test(v) && Number(v) > 0 ? v : ''; tcardLinkPaint(); }; }
  if (lf) { lf.value = TCL.note; lf.oninput = () => { TCL.note = lf.value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 80); tcardLinkPaint(); }; }
  if (rq) rq.onclick = () => treqOpen();
  if (ln) { ln.value = TCL.name; let t = 0; ln.oninput = () => { clearTimeout(t); t = setTimeout(() => tcardLinkName(ln.value), 500); }; }
  if (share) share.onclick = () => navigator.share({ title: 'Pay me in TAC', url: tcardLinkUrl() }).catch(() => {});
  if ($('#tcd-linkrow', el)) { $('#tcd-linkrow', el).__h = null; tcardLinkPaint(); }
  const scan = $('#tcd-scan', el);
  if (scan) scan.onclick = () => busy(scan, async () => {
    const st = $('#tcd-st'), api = await tacPool();
    await Promise.allSettled([api.scan((m) => say(st, m)), chainScan(true)]);
    rerender('tac');
  });
}
function tcard() {
  if (!$('#tpg-card') || !ctx.TACP.on) return;
  const side = tcardSide(), chain = side === 'chain';
  tpgMount($('#tcd-seg'), chainOn() ? html`<div class="tcd-seg" role="group" aria-label="Where the private TAC is">${[['chain', 'Tacit chain'], ['btc', 'Bitcoin']].map(([k, t]) => html`<button type="button" aria-pressed="${String(side === k)}" data-tcd-side="${k}">${t}</button>`)}</div>` : html``);
  tcardNet(side);
  tpgMount($('#tcd-head'), tcardHead(side), (el) => { const go = $('#tpg-priv', el); if (go) go.onclick = () => tpgPrivGo(chain ? 'wallet' : 'btc'); });
  const tabs = $('#tcd-tabs'), p = $('#tpg-p'), pool = $('#tcd-pool');
  tabs.hidden = p.hidden = !chain; pool.hidden = chain;
  if (chain) {
    tpgMount(tabs, html`<div class="tcd-tabs" role="tablist" aria-label="Private TAC on the Tacit chain">${TCD_TABS.map(([k, t]) => html`<button type="button" role="tab" id="tcd-t-${k}" aria-controls="tpg-p" aria-selected="${String(ctx.TCARD.tab === k)}" tabindex="${ctx.TCARD.tab === k ? 0 : -1}" data-tcd-tab="${k}">${t}</button>`)}</div>`);
    p.setAttribute('aria-labelledby', `tcd-t-${ctx.TCARD.tab}`);
    const was = $('#tcd-amt')?.value || '';
    if (tpgMount(p, tcardForm(), tcardWire) && was && $('#tcd-amt')) $('#tcd-amt').value = was;
    if (ctx.TCARD.link) tcardFillLink();
    tcdFlowPaint();
    tcardQuoteSoon();
  } else if (ctx.TPOOL.host) { if (ctx.TPOOL.host.parentElement !== pool) { pool.__h = null; pool.replaceChildren(ctx.TPOOL.host); } }
  else { tpgMount(pool, html`<p class="note">Opening the Bitcoin pool…</p>`); tacPool().then(() => tcard(), (e) => toast(errText(e), true)); }
  tcardFoot();
  tcardSteps();
}
function tcardFoot() {
  const el = $('#tcd-foot');
  if (!el) return;
  const side = tcardSide(), tab = side === 'btc' ? ctx.TPOOL.api?.view()[0] || 'shield' : ctx.TCARD.tab === 'withdraw' ? ctx.TCARD.dest : ctx.TCARD.tab === 'send' && ctx.TCARD.eth ? 'sendEth' : ctx.TCARD.tab;
  el.textContent = TCD_FOOT[side][tab] || '';
}
function tpgShieldEst(units) {
  const cs = TPGW.cs, w = TPGW.w;
  if (!cs?.leader || !w) return null;
  const r = { pool: cs.pool, shares: cs.shares }, sh = w.sharesFor(units, r);
  let feeSh = cs.leader.fee > 0n ? w.sharesFor(cs.leader.fee, r, 0n) : 0n;
  while (cs.leader.fee > 0n && w.worthOf(feeSh, r) < cs.leader.fee) feeSh += 1n;
  return { arrives: sh > feeSh ? w.worthOf(sh - feeSh, r) : 0n, cap: cs.leader.shieldCap };
}
async function tcardName(raw, fresh = false) {
  const r = await resolveToM(raw, null, fresh).catch(() => null), lanes = r?.address ? tacitLanes(r.address) : null;
  if (lanes && tacitIsMine(lanes)) return { raw, to: r.address, bad: `${raw} points to your own Tacit address.` };
  if (lanes && await chainRecipient(lanes).then(() => true, () => false)) return { raw, to: r.address, eth: false };
  const a = await nameAddrM(raw, null, fresh).catch(() => null);
  if (!a?.address) return { raw, bad: `${raw} has no Tacit address on the Tacit chain and no Ethereum address.` };
  try { chainNotTo(a.address); } catch (e) { return { raw, bad: `${raw} points to a contract: ${errText(e)}` }; }
  return { raw, to: a.address, eth: true, name: a.name || raw };
}
async function tcardQuote() {
  const el = $('#tcd-q'), go = $('#tcd-go');
  if (!el || tcardSide() !== 'chain') return;
  const my = ++ctx.TCARD.seq, tab = ctx.TCARD.tab, a = ($('#tcd-amt')?.value || '').trim(), units = a ? parseUnits(a, 8) : null;
  const put = ([v, ok]) => {
    if (my !== ctx.TCARD.seq) return;
    if (el.__h !== v.s) { el.__h = v.s; mount(el, v); }
    if (go && S.key && go.getAttribute('aria-busy') !== 'true') go.disabled = !ok;
    tcardFoot();
  };
  if (tab !== 'shield') tcdHave('');
  if (!S.key && tab !== 'shield') return put([html``, true]);
  if (a && !units) return put([tcdErr('Enter an amount above zero, up to 8 decimals.'), false]);
  try { put(await (tab === 'shield' ? tcardShieldSay(units) : tab === 'send' ? tcardSendSay(units, my) : tcardOutSay(units))); }
  catch { put([html``, true]); }
}
async function tcardShieldSay(units) {
  gasNow();
  const key = !!S.key, held = key ? hxWalletBal('wtac') ?? (TACB.who === tacWho() ? TACB.erc : null) : null, way = key ? tcardWay() : 'permit', t4 = (v) => fmt(v, 18, 4);
  const sf = way === 'permit' ? await chainSweepFee().catch(() => 0n) : 0n, cap = CHAIN_SWEEP.cap ?? ctx.CH.cap ?? null;
  tcdHave(held != null ? `${fmt(held, 18, 2)} in ${payer() === 'tacit' ? 'this key’s address' : 'your wallet'}` : '');
  if (held === 0n) return [html`No TAC in ${your()}. <button class="link" type="button" data-hx="swap:ether:tac">Buy with ETH</button> · <a class="link" href="/trade/tac/#btc=buy">Buy with sats</a> · <a class="link" href="/rewards/">Claim your airdrop</a>`, false];
  const rows = (arrives) => tcdRows(tcdRow('Arrives', arrives), tcdRow('Earns', html`<span class="mute">a share of every fee, no lock</span>`), key ? tcdGas(way, sf, units) : tcdRow('Gas', html`<span><span class="num">${t4(sf)}</span> TAC, or your own ETH</span>`), tcdRow('Takes', html`${key ? tcdTakes(way) : 'One signature'} · about a minute`));
  if (!units) return [html`${rows(html`<span class="mute">private, on the Tacit chain</span>`)}${cap != null && held != null && held > cap * E10 ? html`<p class="tcd-cap">Up to ${fmt(cap, 8, 0)} TAC a shield for now.</p>` : ''}`, true];
  if (cap != null && units > cap) return [tcdErr(chainCapLine(cap)), false];
  const total = units * E10 + sf;
  if (held != null && total > held) {
    const fits = sf && held > sf ? held - sf : 0n;
    const fill = fits ? plain((fits - sf / 10n) / E10, 8) : '';
    return [fits ? html`<span class="err">With the leader’s fee of ${t4(sf)} TAC, up to ${t4(fits)} TAC fits.</span> <button class="link" type="button" data-tcd-fill="${fill}">Shield ${fill} TAC</button>${hxChainEth() ? html` or <button class="link" type="button" data-tcd-way="own">pay the gas in ETH</button>: no fee.` : ''}`
      : tcdErr(`More than the ${t4(held)} TAC in ${your()}.`), false];
  }
  const q = key ? await chainQuote('shield', units).catch(() => null) : tpgShieldEst(units);
  if (chainOverCap(q, units)) return [tcdErr(chainCapLine(q.cap)), false];
  if (key && q) chainShieldAhead(units);
  return [rows(q ? html`<span><b class="num">≈ ${fmt(q.arrives, 8, 4)} TAC</b>, private</span>` : 'a little less, private'), true];
}
function tcardMove(need) {
  const h = tpgHave(), t = (v) => fmt(v * E10, 18, 2), has = (v) => (v || 0n) >= need;
  if (has(h.wallet)) return html`<br>${t(h.wallet)} TAC in your wallet is public. <button class="link" type="button" data-tcd-tab="shield">Shield it first</button>`;
  if (has(h.defi)) return html`<br>Your private TAC is in the DeFi pool. <button class="link" type="button" data-hx="shield:tac:chain" data-amt="${plain(need, 8)}">Move it to the Tacit chain</button>`;
  if ((h.pool || 0n) > 0n) return html`<br>Your private TAC is in the Bitcoin pool. <button class="link" type="button" data-tcd-side="btc">Pay from Bitcoin</button>`;
  return '';
}
async function tcardChainCost(units, eth, head, to = null) {
  const held = chainHeld(), t4 = (v) => fmt(v, 8, 4);
  if (!units) return [head, true];
  const q = await chainQuote(eth ? 'withdraw' : 'pay', units).catch(() => null), most = q?.most ?? held;
  if (most != null && units > most && ctx.CH.settling && held != null && units < held) return [html`${head}<br>Your last payment is settling: this one goes once it lands, in about a minute.`, true];
  if (most != null && units > most) return [html`${head}<br>${tcdErr(held != null && units <= held && most > 0n ? `With its fees, up to ${t4(most)} TAC.` : `You hold ${t4(held ?? 0n)} TAC on the Tacit chain.`)}${tcardMove(units)}`, false];
  if (to && !ctx.CH.settling) chainAhead(to, units);
  return [html`<p class="tcd-say">${head}</p>${tcdRows(tcdRow('Fee', q ? html`<span><span class="num">${t4(q.holders + q.fee)}</span> TAC</span><span class="mute"><span class="num">${t4(q.holders)}</span> of it to holders</span>` : 'a small fee'),
    tcdRow('Arrives', eth ? 'in their wallet, in about a minute' : html`<span>in seconds, <b>private</b></span>`))}`, true];
}
async function tcardSendSay(units, my) {
  chainWarm();
  const raw = ($('#tcd-to')?.value || '').trim(), held = chainHeld(), t4 = (v) => fmt(v, 8, 4);
  ctx.TCARD.eth = /^0x[0-9a-fA-F]{40}$/.test(raw);
  if (!raw) return [html`${held != null ? `You hold ${t4(held)} TAC on the Tacit chain.` : ''}`, true];
  if (/^tac(it|tt|rt)1/i.test(raw) && raw.length < 100 && !tacitLanes(raw)) return [html``, false];
  if (/\.(eth|wei|gwei)$/i.test(raw)) {
    if (ctx.TCARD.rc?.raw !== raw || (ctx.TCARD.rc.bad && Date.now() - (ctx.TCARD.rc.at || 0) > 20e3)) {
      if (my === ctx.TCARD.seq && ctx.TCARD.rc?.raw !== raw) mount($('#tcd-q'), html`Looking up ${raw}…`);
      const r = await tcardName(raw);
      if (($('#tcd-to')?.value || '').trim() === raw) ctx.TCARD.rc = { ...r, at: Date.now() };
    }
    const r = ctx.TCARD.rc?.raw === raw ? ctx.TCARD.rc : null;
    if (!r) return [html``, false];
    if (r.bad) return [tcdErr(r.bad), false];
    ctx.TCARD.eth = r.eth;
    return tcardChainCost(units, r.eth, r.eth ? html`${r.name} → <span class="mono">${viewAddr(r.to, 8)}</span> · leaves the Tacit chain there as public TAC; the leader pays it out`
      : html`${raw} → <span class="mono">${viewAddr(r.to, 10)}</span> · <b>private, on the Tacit chain</b>`, r.to);
  }
  const r = tpgRoute(raw, units);
  if (r.bad) return [tcdErr(r.bad), false];
  if (r.side === 'chain') {
    if (r.eth) return tcardChainCost(units, true, html`Leaves the Tacit chain as public TAC at that address; the leader pays it out`, raw);
    const lanes = tacitLanes(raw);
    if (tacitIsMine(lanes)) return [tcdErr('That is your own Tacit address.'), false];
    if (tpgKnown(lanes) === false) return [tcdErr('This Tacit address has not opened the Tacit chain yet. They open their Tacit wallet once, then it can be paid.'), false];
    return tcardChainCost(units, false, html`<span class="mono">${viewAddr(raw, 10)}</span> · ID <b class="num">${addressId(raw)}</b> · <b>private, on the Tacit chain</b>`, raw);
  }
  if (r.side === 'pool') {
    const rf = ctx.TACP.relay?.relay;
    if (ctx.TACP.relay === undefined) { ctx.TACP.relay = null; tacPool().then((api) => api.fees()).then((x) => { ctx.TACP.relay = x; tcardQuoteSoon(); }, () => { ctx.TACP.relay = undefined; }); }
    return [html`<b>Private, on Bitcoin</b>, from the Bitcoin pool · ${rf != null ? `a relay fee of about ${t4(rf)} TAC` : 'a Bitcoin fee in sats'} · about 10 minutes${r.unknown ? '. The Tacit chain does not know this address yet' : ''}`, true];
  }
  return [html`From your Bitcoin address · the amount stays hidden, both addresses are seen · about 10 minutes`, true];
}
async function tcardOutSay(units) {
  const dest = ctx.TCARD.dest, held = chainHeld(), t4 = (v) => fmt(v, 8, 4);
  const where = { wallet: 'The leader pays it out to your wallet on Ethereum, so you need no ETH.', pool: 'Into the private pool on Ethereum, to swap, farm or borrow with.', btc: 'Two steps: into the private pool here, then the bridge to your Bitcoin address.' }[dest];
  if (held === 0n) return [html`No TAC on the Tacit chain yet. <button class="link" type="button" data-tcd-tab="shield">Shield some</button>`, false];
  if (!units) return [html`${where}${held != null ? ` You hold ${t4(held)} TAC there.` : ''}`, true];
  const q = await chainQuote(dest === 'wallet' ? 'withdraw' : 'hop', units).catch(() => null), most = q?.most ?? held;
  if (most != null && units > most) return [tcdErr(held != null && units <= held && most > 0n ? `With its fees, up to ${t4(most)} TAC.` : `You hold ${t4(held ?? 0n)} TAC on the Tacit chain.`), false];
  if (dest === 'wallet' && S.address && !ctx.CH.settling) chainAhead(S.address, units);
  return [html`<p class="tcd-say">${where}</p>${tcdRows(tcdRow('Arrives', html`<span><b class="num">${t4(units)} TAC</b>${dest === 'wallet' ? ` in ${your()}` : ', private'}</span>`),
    tcdRow('Fee', q ? html`<span><span class="num">${t4(q.holders + q.fee)}</span> TAC on top</span>` : 'a small fee, on top'), tcdRow('Takes', dest === 'btc' ? 'Two steps, about 10 minutes' : 'About a minute'))}`, true];
}
async function tcardMax() {
  const a = $('#tcd-amt');
  if (!a) return;
  let v = null;
  if (ctx.TCARD.tab === 'shield') {
    const held = hxWalletBal('wtac') ?? (TACB.who === tacWho() ? TACB.erc : null);
    if (held == null) return;
    const fee = tcardWay() === 'permit' ? await chainSweepFee(true).catch(() => 0n) : 0n, room = fee + fee / 10n, cap = CHAIN_SWEEP.cap ?? ctx.CH.cap ?? null;
    v = held > room ? (held - room) / E10 : 0n;
    if (cap != null && v > cap) v = cap;
  } else {
    const held = await chainScan().catch(() => null) ?? chainHeld();
    if (held == null) return;
    const kind = ctx.TCARD.tab === 'withdraw' ? (ctx.TCARD.dest === 'wallet' ? 'withdraw' : 'hop') : ctx.TCARD.eth ? 'withdraw' : 'pay';
    v = (await chainQuote(kind, held).catch(() => null))?.most ?? held;
  }
  if (v > 0n) { a.value = plain(v, 8); tcardQuote(); }
}
const tcardClear = () => { const a = $('#tcd-amt'); if (a) clearField(a); };
const tcardAfter = () => {
  if (ctx.TCARD.link && ctx.TCARD.tab === 'send') { ctx.TCARD.link = null; if (/^#to=/.test(location.hash)) history.replaceState(null, '', location.pathname + location.search); }
  rerender('tac'); tcardQuoteSoon();
};
async function tcardPress(go) {
  if (!S.key) return openSheet('wallet');
  if (go.getAttribute('aria-busy') === 'true') return;
  const st = $('#tcd-st'), a = ($('#tcd-amt')?.value || '').trim(), units = parseUnits(a, 8), tab = ctx.TCARD.tab, opts = { clear: tcardClear, after: tcardAfter };
  ctx.TCARD.side = 'chain';
  say(st, '');
  if (!units) return say(st, tcdErr('Enter an amount above zero, up to 8 decimals.'));
  if (tab === 'shield') {
    const held = hxWalletBal('wtac'), way = tcardWay();
    if (held != null && units * E10 > held) return say(st, tcdErr(`More than the ${fmt(held, 18, 4)} TAC in ${your()}.`));
    return busy(go, (run) => { const f = tcdFlow(way); f.wrap(run); return chainShieldRun(run, st, units, { held, way, ...opts, phase: f.phase }); });
  }
  if (tab === 'withdraw' && ctx.TCARD.dest !== 'wallet') return busy(go, (run) => chainHopRun(run, st, units, opts));
  const spend = (run) => { const f = tcdFlow('spend'); f.wrap(run); return { ...opts, phase: f.phase, sent: (s, lead, landing) => { chainSentLine(s, lead, landing); f.phase('handed'); landing.then(() => f.phase('landed'), () => {}); } }; };
  if (tab === 'withdraw') return busy(go, (run) => { const { sent, ...o } = spend(run); return chainOutRun(run, st, units, o); });
  const raw = ($('#tcd-to')?.value || '').trim();
  if (!raw) return say(st, tcdErr('Enter who you are paying.'));
  if (/\.(eth|wei|gwei)$/i.test(raw)) {
    const was = ctx.TCARD.rc?.raw === raw ? ctx.TCARD.rc : null;
    if (!was) return say(st, 'Still reading that name. Press again in a moment.');
    if (was.bad) return say(st, tcdErr(was.bad));
    return busy(go, async (run) => {
      say(st, 'Checking where it points…');
      const now = await tcardName(raw, true);
      if (now.bad || now.to !== was.to) { ctx.TCARD.rc = null; tcardQuoteSoon(); return say(st, tcdErr(`${raw} points somewhere else now. Check it and press again.`)); }
      say(st, '');
      const { phase, ...o } = spend(run);
      await chainPayRun(run, st, units, now.to, o);
    });
  }
  const r = tpgRoute(raw, units);
  if (!r || r.bad) return say(st, tcdErr(r?.bad || 'Enter who you are paying.'));
  if (r.side === 'chain') return busy(go, (run) => { const { phase, ...o } = spend(run); return chainPayRun(run, st, units, raw, o); });
  if (r.side === 'pool') { const api = await tacPoolOpen('send'); api?.pay(raw, a); return; }
  HX.rcpt = raw;
  tpgTile('send:tacb', a, 'Send on Bitcoin');
}
document.addEventListener('click', (e) => {
  const b = e.target.closest?.('[data-tpg], [data-tcd-side], [data-tcd-tab], [data-tcd-dest], [data-tcd-way], [data-tcd-fill], [data-tcd-step]');
  if (!b || !ctx.TACP.on) return;
  e.preventDefault();
  const d = b.dataset;
  if (d.tcdFill != null) { const a = $('#tcd-amt'); if (a) { a.value = d.tcdFill; tcardQuote(); a.focus(); } return; }
  if (d.tcdStep === 'shield') { const gap = ctx.TCARD.linkGap; tcardGo('chain', 'shield'); requestAnimationFrame(() => { const a = $('#tcd-amt'); if (a && gap) { a.value = gap; tcardQuote(); } }); return; }
  if (d.tpg) {
    tpgTab(d.tpg);
    requestAnimationFrame(() => { $('#tpg-card')?.scrollIntoView({ block: 'nearest', behavior: calmMotion() ? 'auto' : 'smooth' }); $(d.tpg === 'pay' ? '#tcd-to' : '#tcd-amt')?.focus({ preventScroll: true }); });
    return;
  }
  if (d.tcdSide) { tcardGo(d.tcdSide); if (e.detail === 0) $(`[data-tcd-side="${d.tcdSide}"]`)?.focus(); return; }
  if (d.tcdTab) { tcardGo('chain', d.tcdTab); if (e.detail === 0) $(`#tcd-t-${d.tcdTab}`)?.focus(); return; }
  if (d.tcdDest) { if (tpgBusy('#tpg-card')) return; ctx.TCARD.dest = d.tcdDest; tcard(); $(`[data-tcd-dest="${ctx.TCARD.dest}"]`)?.focus(); return; }
  const busyNow = $('#tcd-go')?.getAttribute('aria-busy') === 'true';
  if (busyNow && !PERMIT_WAIT.cancel) return;
  if (busyNow) PERMIT_WAIT.cancel();
  ctx.TCARD.way = d.tcdWay; tcardQuote().then(() => { if (e.detail === 0) $(`#tcd-q [data-tcd-way="${d.tcdWay}"]`)?.focus(); }, () => {});
  if (busyNow) toast(d.tcdWay === 'own' ? 'Switched to gas in ETH. Press Shield again.' : 'Switched to gas in TAC. Press Shield again.');
});
const tpgStick = () => { for (const el of [$('#tpg-card'), $('#tpg-act')]) if (el && !el.hidden) el.style.setProperty('--stick', `${Math.min(20, innerHeight - el.offsetHeight - 20)}px`); };
if (typeof ResizeObserver === 'function') { const ro = new ResizeObserver(tpgStick); for (const el of [$('#tpg-card'), $('#tpg-act')]) if (el) ro.observe(el); }
window.addEventListener('resize', tpgStick);
document.addEventListener('keydown', (e) => {
  const b = e.target.closest?.('#tcd-tabs [role="tab"], .tcd-dest [role="radio"]'), list = b ? $$(b.matches('[role="tab"]') ? '#tcd-tabs [role="tab"]' : '.tcd-dest [role="radio"]') : [], i = list.indexOf(b);
  const j = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: list.length - 1 }[e.key];
  if (!b || j === undefined) return;
  e.preventDefault();
  const n = list[(j + list.length) % list.length];
  if (n.dataset.tcdTab) { tcardGo('chain', n.dataset.tcdTab); $(`#tcd-t-${n.dataset.tcdTab}`)?.focus(); }
  else { if (tpgBusy('#tpg-card')) return; ctx.TCARD.dest = n.dataset.tcdDest; tcard(); $(`[data-tcd-dest="${ctx.TCARD.dest}"]`)?.focus(); }
});
function tpgKnown(lanes) {
  if (!lanes || !S.key || !chainOn()) return null;
  const k = `${S.key.pubHex}:${bytesToHex(lanes.btc.spendPub)}:${lanes.chain ? bytesToHex(lanes.chain.hash) : ''}`;
  const old = TPG_KNOWN.get(k);
  if (!TPG_KNOWN.has(k) || (old === false && Date.now() - (TPG_KNOWN_AT.get(k) || 0) > 20e3)) {
    TPG_KNOWN.set(k, old ?? null); TPG_KNOWN_AT.set(k, Date.now());
    chainRecipient(lanes).then(() => true, () => false).then((ok) => {
      TPG_KNOWN.set(k, ok); TPG_KNOWN_AT.set(k, Date.now()); tcardQuoteSoon();
      if (!ok) setTimeout(tcardQuoteSoon, 21e3);
    });
  }
  return TPG_KNOWN.get(k);
}
function tpgRoute(raw, units) {
  const s = String(raw || '').trim();
  if (!s) return null;
  const isEth = /^0x[0-9a-fA-F]{40}$/.test(s), isBp = /^t?bp1/i.test(s), isBtc = /^(bc1|tb1|sp1)[a-z0-9]{20,}$/i.test(s) || /^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$/.test(s);
  let lanes = null;
  if (/^tac(it|tt|rt)1/i.test(s)) { try { lanes = decodeTacitAddress(s.toLowerCase()).lanes; } catch { return { bad: 'That Tacit address does not read. Copy it again, whole.' }; } }
  else if (!isEth && !isBp && !isBtc) return { bad: 'Enter a Tacit address (tacit1…), an Ethereum address (0x…) or a pool address (bp1…).' };
  if (isBtc) return { side: 'btc' };
  const h = tpgHave(), need = units || 0n, fits = (v) => v != null && v > 0n && v >= need;
  let ch = chainOn() && (isEth || !!lanes), pl = isBp || !!lanes?.pool, unknown = false;
  if (ch && lanes && pl && tpgKnown(lanes) === false) { ch = false; unknown = true; }
  if (!ch && !pl) return { bad: isEth ? 'An Ethereum address is paid from the Tacit chain, which is not live yet.' : 'This Tacit address has no way to be paid privately yet. Ask them for a newer one.' };
  const side = ch && pl ? (fits(h.chain) || !fits(h.pool) ? 'chain' : 'pool') : ch ? 'chain' : 'pool';
  return { side, eth: isEth, unknown, h, need };
}
const TPGW = { at: 0, p: null, cs: null, roll: null, ui: null, w: null };
const tpgLeader = () => TPGW.cs?.leader?.fee ?? null;
function tpgWhyRead(force = false) {
  if (!chainOn() || (!force && (TPGW.p || Date.now() - TPGW.at < 60e3))) return TPGW.p || Promise.resolve();
  TPGW.at = Date.now();
  return (TPGW.p = Promise.all([
    Promise.all([import('/tacit-chain-config.js?cb=74171404'), import('/chain/ui.js?cb=345c9adc'), import('/tacit-chain-wallet.js')])
      .then(([cf, ui, w]) => { TPGW.ui = ui; TPGW.w = w; return tpgStatus(cf.tacitChain()); }).then((s) => { TPGW.cs = s; }, () => {}),
  ]).finally(() => { TPGW.p = null; tpgActionsSoft(); rerender('tac'); }));
}
async function tpgStatus(cfg) {
  if (!cfg) throw new Error('tacit chain: not deployed');
  const sels = ['0ef26743', '2fb9bbfd', '16f0115b', '03314efa'], n = (v) => (/^\d+$/.test(String(v ?? '')) ? BigInt(v) : 0n);
  const terms = (async () => {
    try {
      const r = await fetch(cfg.leader + '/fee', { signal: AbortSignal.timeout(10e3) });
      if (!r.ok) return null;
      const f = await r.json(), cap = n(f?.shieldCap);
      return { fee: n(f?.fee), shieldCap: cap > 0n ? cap : null, sweepFee: n(f?.sweepFee) };
    } catch { return null; }
  })();
  let v = await multicall(sels.map((x) => ({ to: cfg.blocks, data: x }))).catch(() => null);
  if (!v?.every(Boolean)) v = await Promise.all(sels.map((x) => ethCall(cfg.blocks, x)));
  const [height, last, pool, shares] = v.map((h) => BigInt('0x' + (strip(h) || '0')));
  return { height: Number(height), lastLanded: Number(last), pool, shares, leader: await terms };
}
const tpgActionsSoft = () => { if (ctx.TACP.on) tcardQuoteSoon(); };
const tpgPx = (pool, shares) => (TPGW.ui ? TPGW.ui.sharePrice(pool, shares, 5) : tpgPrice(pool, shares).toFixed(5));
function tpgWhy(el) {
  el.hidden = !chainOn();
  if (!chainOn()) return;
  const top = $('#tpg-why'), fees = $('#tpg-fees');
  const cs = TPGW.cs, roll = TPGW.roll || [], last = roll.length ? [...roll].sort((a, b) => b.height - a.height)[0] : null;
  const price = cs ? tpgPx(cs.pool, cs.shares) : last ? tpgPx(last.pool, last.shares) : null;
  const mb = cs && TPGW.w ? TPGW.w.shieldMargin({ pool: cs.pool, shares: cs.shares }) : null, margin = mb == null ? 'a small margin' : `${(Number(mb) / 100).toFixed(2).replace(/0$/, '')}%`;
  const k = S.key?.pubHex, shares = k && ctx.TACP.sh?.pub === k ? ctx.TACP.sh.v : null, worth = k && ctx.CH.pub === k ? ctx.CH.bal : null;
  const lf = tpgLeader(), sweep = cs?.leader?.sweepFee ?? null, t4 = (v) => fmt(v, 8, 4), blocks = cs?.height ?? roll.length;
  tpgMount(top, html`${shares != null && shares > 0n && worth != null ? html`<p class="tpg-mine">Your ${fmt(shares, 8, 4)} shares are worth ${fmt(worth, 8, 4)} TAC.</p>` : ''}
    <p class="tpg-feeline">Shielded TAC is staked: held as shares of one pool. Every payment and withdrawal leaves a fee in it, so each share is worth more. No lock.</p>`);
  tpgMount(fees, html`<details class="tpg-more"><summary>Where the fees go</summary>
    <ul class="tpg-fees">
      <li><b>Send</b><div class="cost">${lf != null ? `about ${t4(lf + TPG_FLOOR)} TAC` : 'a small fee'}</div>
        <p class="h"><span>0.002 TAC<small>to holders</small></span></p><p><span>${lf != null ? `${t4(lf)} TAC` : 'the rest'}<small>to the leader, for Ethereum gas</small></span></p></li>
      <li><b>Shield</b><div class="cost">${margin} and ${lf != null ? `about ${t4(lf + (sweep ? sweep / E10 : 0n))} TAC` : 'a small fee'}</div>
        <p class="h"><span>${margin} of it<small>to holders</small></span></p><p><span>${lf != null ? `${t4(lf)} TAC${sweep ? ` + ${fmt(sweep, 18, 4)} TAC` : ''}` : 'the rest'}<small>to the leader, for Ethereum gas${sweep ? ', and for sending it in when you sign once' : ''}</small></span></p></li>
      <li><b>Withdraw</b><div class="cost">${lf != null ? `0.1% and ${t4(lf)} TAC` : '0.1% and a small fee'}</div>
        <p class="h"><span>0.1%, at least 0.002 TAC<small>to holders</small></span></p><p><span>${lf != null ? `${t4(lf)} TAC` : 'the rest'}<small>to the leader, for Ethereum gas</small></span></p></li>
    </ul>
    <p class="tpg-foot">Provers are paid in points.</p></details>`);
}
const TPGN = { pool: null, at: 0, t: 0 };
function tpgPoolRead() {
  if (Date.now() - TPGN.at < 60e3) return;
  TPGN.at = Date.now();
  tacPool().then((api) => api.stats()).then((s) => { TPGN.pool = s; }, () => { if (!TPGN.pool || TPGN.pool.err) TPGN.pool = { err: true }; }).then(() => {
    rerender('tac');
    clearTimeout(TPGN.t);
    TPGN.t = setTimeout(() => { if (ctx.TACP.on && !document.hidden && (tcardSide() === 'btc' || $('#tpg-how').open)) rerender('tac'); }, 61e3);
  });
}
const tpgAgo = (d) => (d <= 0 ? 'just now' : d < 9 ? `about ${d * 10} min ago` : d < 216 ? `about ${Math.max(1, Math.round(d / 6))} h ago` : `about ${Math.round(d / 144)} d ago`);
function tcardNet(side) {
  const el = $('#tcd-net');
  if (!el) return;
  el.hidden = side !== 'btc';
  if (el.hidden) return;
  tpgPoolRead();
  const p = TPGN.pool, n = (v) => (v == null ? (p?.err ? '—' : '…') : Number(v).toLocaleString('en-US'));
  const lag = p?.tip && p.height ? Math.max(0, p.tip - p.height) : 0;
  const v = !p ? { s: '', t: 'Reading…' } : p.err || !p.height ? { s: 'bad', t: 'Not reachable' } : !p.well ? { s: 'bad', t: 'Stopped' } : lag > 6 ? { s: 'busy', t: 'Catching up' } : { s: 'ok', t: 'Working' };
  const last = !p ? '…' : p.err ? '—' : p.last && p.tip ? tpgAgo(p.tip - p.last) : p.last ? `block ${n(p.last)}` : 'none yet';
  const cell = (val, k) => html`<div><span class="v">${val}</span><span class="k">${k}</span></div>`;
  tpgMount(el, html`<div class="cl-h"><h2 class="cl-name">bitcoin <em>pool</em></h2><span class="cl-v" data-s="${v.s}"><span class="dot ${v.s}"></span><span>${v.t}</span></span><span class="cl-sub">${p?.height ? `block ${n(p.height)}` : ''}</span></div>
    <div class="cl-stats">${cell(n(p?.set), 'notes')}${cell(n(p?.txs), 'transactions')}${cell(last, 'last activity')}${cell(p?.proof || (p?.err ? '—' : '…'), 'proof system')}</div>
    <p class="cl-note">Amounts stay hidden, so the pool shows activity, not a total.</p>`);
}
function tpgNets(el) {
  if (!$('#tpg-how').open) return;
  if (Date.now() - TPGN.at >= 60e3) tpgWhyRead();
  tpgPoolRead();
  const p = TPGN.pool, cs = TPGW.cs, ui = TPGW.ui, n = (v) => (v == null ? (p?.err ? '—' : '…') : Number(v).toLocaleString('en-US')), L = cs?.leader;
  const cell = (v, k) => html`<div><span class="v num">${v}</span><span class="k">${k}</span></div>`;
  mount(el, html`<h3 class="tpg-h">Bitcoin pool</h3>
    <div class="tpg-strip">${cell(n(p?.set), 'Notes')}${cell(n(p?.txs), 'Transactions')}${cell(n(p?.height), 'Indexed block')}${cell(p?.proof || (p?.err ? '—' : '…'), 'Proof system')}</div>
    ${chainOn() ? html`<h3 class="tpg-h">Tacit chain</h3>
    <div class="tpg-strip">${cell(cs ? n(cs.height) : '…', 'Blocks')}${cell(cs && ui ? (cs.height > 0 && cs.lastLanded > 0 ? ui.ago(Date.now() / 1000 - cs.lastLanded) : 'none yet') : '…', 'Last block')}
      ${cell(cs ? tpgPx(cs.pool, cs.shares) : '…', 'Share price')}${cell(cs && ui ? ui.fmtTac(cs.pool, 2) : '…', 'Pool, TAC')}
      ${cell(L ? (L.fee > 0n ? ui.fmtTac(L.fee) : 'none') : cs ? '—' : '…', 'Leader fee, TAC')}${cell(L ? (L.shieldCap != null ? ui.fmtTac(L.shieldCap, 0) : 'none') : cs ? '—' : '…', 'Shield cap, TAC')}</div>` : ''}`);
}
$('#tpg-how').addEventListener('toggle', () => { if ($('#tpg-how').open) { TPGN.at = 0; tpgNets($('#tpg-nets')); } });
function tacShield(el, status, acctBal, walletBal) {
  if (!el) return;
  const via = payer(), src = acctBal > 0n && (via === 'tacit' || !(walletBal > 0n)) ? 'tacit' : via === 'wallet' && walletBal > 0n ? 'wallet' : null;
  const alt = src === 'wallet' ? (acctBal > 0n ? 'tacit' : null) : (via === 'tacit' && walletBal > 0n ? 'wallet' : null);
  const balance = src === 'wallet' ? walletBal : acctBal, from = src === 'wallet' ? 'your wallet' : 'this key’s address';
  const swap = alt ? html`<p class="note">${fmt(alt === 'wallet' ? walletBal : acctBal, 18, 2)} TAC is ${src ? 'also ' : ''}in ${alt === 'wallet' ? 'your connected wallet' : 'this key’s address'}. <button class="link" type="button" id="tsh-switch">Shield it from there</button></p>` : '';
  const wireSwap = () => { const sw = $('#tsh-switch', el); if (sw) sw.onclick = () => busy(sw, async () => { try { setPayer(alt); } catch (e) { toast(errText(e), true); } }); };
  if (!src) { mount(el, html`${swap}`); wireSwap(); return; }
  mount(el, html`
    <div class="lbl"><span>Shield TAC</span><button type="button" id="tsh-max">TAC in ${from} ${fmt(balance, 18, 2)}</button></div>
    <div class="amt"><input id="tsh-amt" inputmode="decimal" placeholder="0.00" autocomplete="off" aria-label="TAC to make private"><span class="u"><svg class="tk sm" aria-hidden="true"><use href="#tk-tac"/></svg>TAC</span></div>
    <div class="rcpt" id="tsh-rcpt" hidden></div>
    <button class="btn" type="button" id="tsh-go" disabled>Shield</button>
    <p class="note">One transaction from ${from}${src === 'wallet' ? ', with a signed permit' : ''}; ${ownNow(['wrap']) ? `it is proved ${devOn() ? 'on this computer' : 'with your own credit'} first, so nothing waits in the pool` : 'Tacit’s relay does the privacy work after'}. It stays private until you send it or make it public again.</p>${swap}`);
  wireSwap();
  const amt = $('#tsh-amt'), go = $('#tsh-go'), rc = $('#tsh-rcpt');
  let q = null;
  $('#tsh-max').onclick = () => { if (balance) { amt.value = plain(balance - balance % E10, 18); amt.dispatchEvent(new Event('input')); } };
  onEdit([amt], go, (e) => {
    const wei = parseUnits(amt.value);
    q = null; go.disabled = true; if (e?.isTrusted) say(status, '');
    if (!wei) { rc.hidden = true; return; }
    if (wei % E10 !== 0n) { mount(rc, html``); warn(rc, 'Up to 8 decimals.'); rc.hidden = false; return; }
    q = { wei };
    mount(rc, html`<div class="kv"><span>You get</span><b>${fmt(wei, 18, 8)} TAC, private</b></div>`);
    rc.hidden = false;
    if (S.key) vouchers().then((v) => { if (q?.wei === wei && v.pick(S.key.pubHex, 'TAC', wei)?.length === 1) rc.insertAdjacentHTML('beforeend', html`<div class="kv"><span>Proof</span><b>ready now</b></div>`.s); }).catch(() => {});
    const over = wei > balance;
    go.disabled = over;
    if (over) warn(rc, `More than the ${fmt(balance, 18, 4)} TAC in ${from}.`);
  });
  if (hxLive('tacwrap')) { takeDraft('tacwrap', amt); setTimeout(() => document.getElementById('tac-shield')?.scrollIntoView({ block: 'center' }), 400); }
  go.onclick = () => busy(go, async (run) => {
    if (!q) return;
    await tacWrapNow({ run, wei: q.wei, src, status, line: () => $('#tac-bal-status'), sheet: 'tac', clear: () => { clearField(amt); amt.dispatchEvent(new Event('input')); }, after: () => rerender('tac') });
  });
}
const TAC_ASSET = { tk: 'cTAC', out: 'TAC', icon: 'tac', pubIcon: 'tac', token: ADDR.tac, dp: 2 };
function tacSend(el, status) {
  if (!el) return;
  const who = payer() === 'tacit' ? S.acct?.address : S.address, had = CSEND.pubFor === who ? CSEND.pub?.tac : undefined;
  if (who && (CSEND.pubFor !== who || Date.now() - CSEND.pubAt > 30e3)) readPublicTac().then((p) => { if (p && (p.tac ?? 0n) !== (had ?? 0n)) rerender('tac'); }).catch(() => {});
  const sources = [
    { id: 'tac', k: 'tac', a: TAC_ASSET, pub: false, held: privateOf('tac'), unit: shownAs(TAC_ASSET.tk), dec: 8, label: 'Private' },
    { id: 'pub-tac', k: 'tac', a: TAC_ASSET, pub: true, held: CSEND.pubFor === who ? CSEND.pub?.tac ?? 0n : 0n, unit: TAC_ASSET.out, dec: 18, dp: 6, label: 'Public' },
  ].filter((x) => x.held > 0n);
  assetSendForm(el, status, { prefix: 'ts', sheet: 'tac', statusId: 'tac-bal-status', sources, pick: TACSEND });
}
return { tpgPayLink, tpgTab, tacPoolOpen, tacPool, tcardQuote };
}
