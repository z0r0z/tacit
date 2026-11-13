// The front page's sheets. index.html imports this when one first opens, or once the page is idle, and calls install() with
// what this code reads from its module: let and var bindings are read as ctx.X, so their changes there are seen here.
export default function install(ctx) {
const { $, $$, ACT, ADDR, ASSET_SEND_SATS, BASE_NODES, BF, BR_DONE, BTC, BTC_NOTE_ASSETS, BTC_TOKENS, BWB, BWX, CETH_ID, CHAIN_ASSETS, CHAIN_META, CSEND, CS_ASSETS, DEV, DEVICE_CHAINS, DEV_JOB, DEV_PREF, DISTRIBUTOR, E10, ETHERSCAN, ETH_DP, ETH_LOG_NODES, EVM_POOL, EVM_ROUTER, EXIT_AHEAD, FARM, FLASH, HARVEST_WORTH, HOLD, HOLD_CONSENT, HX, HX_FLIGHT, JOBS, JOIN, KEEP_READY, KEPT, L2BAL, LK, LOCAL, LOCK, LOGO, LP_KEEP_ETH, MEMPOOL, NOTIFY_KEY, OFFERED, OPENISH, OPEN_OFFERED, OUT, P, PGM, POOL_TK, PTS, PTS_BOARD, REDEEM, RETRY, REVERTS, REWARD_PAID, RS, RUNS, Raw, S, SATS_DUST, SEALED, SEL, SELF, SELFDO, SP, SP_PREF, SP_SEAL, SWAP_ASSETS, TAB, TAC_BTC_ID, TAC_DP, TK, TOKEN_POOLS, US, V1, VOUCH, WAIT_WHY, WAL, WNS, WTAC, XA, XA_REDEEM, XO_AT, XO_STEPS, ZAP_SETTLE_GAS, ZROUTER, ZSWAP, aFor, aboutEth, acked, actBridge, actBtc, actDone, actGet, actSave, addrFlat, addrWord, addressFor, addressId, ago, alts, aprLong, aprOf, aprShort, assetById, assetSendForm, bFor, badStatus, big, bondAck, bondDue, bondElsewhere, bondFunds, bondNoWallet, bondNotes, bondVia, bondsNow, brJournal, btcQr, btcRouteM, btcSendNow, busy, bwCanWst, byValue, bytesToHex, chainFull, chainMark, chainMarks, chainNow, chainRpc, chainTag, clearField, clock, concatBytes, connect, copy, cutAhead, dashGo, dashSoon, dayFmt, dayShort, deadline, debounce, depositCallout, devBal, devDepositSend, devNow, devOn, devOutSend, devProver, devResolve, devSaid, deviceSync, deviceWallet, dfmt, earnRows, earnedNow, ended, errText, etaWords, ethBalance, ethBase, ethCall, ethKeep, ethOfTac, evm, exitAheadFor, exitGo, exitKind, exitPosition, failText, feeRoom, feesLine, fmt, freeNotes, getDeviceMods, getUx, heldLabel, hexToBytes, hmac, holdBehind, holdConsented, holdPayTo, holderTier, holdingRound, html, hxBwInflight, hxDraft, hxLive, hxPts, hxWarmWrap, idRow, inUse, joinAhead, joinMax, joinNow, joinOnePlan, joinPairPlan, joinSides, joinTerms, kLock, kNote, kOfAsset, kPos, keccak_256, keep, keepKey, keepReady, keepSizes, keeperDown, keeperRead, keeperTrouble, keeperTx, keyRow, knownWallet, lastEnd, lastSeen, leftWords, linkNote, linked, listed, loadBonds, loadBorrow, loadBtc, loadFarms, loadHeld, loadLocks, loadPoints, loadPositions, loadUnified, loadUsdtBal, lockAhead, lockId, lockLine, lockList, lockNext, lossGate, lossOk, lpCost, lpKeep, lpPoolFor, lpSays, lpSendNow, lpShare, lpTicker, lsKv, maxAria, midAction, mine, mount, multicall, needKey, nfmt, noRelayFee, noteFor, noteKeep, now, offerMore, offerSelf, okStatus, onEdit, onTheWay, opParts, openLink, openOf, openProve, openSheet, openerOn, otherKey, otherSelf, otherWallet, overBalance, ownAccount, ownJob, ownNow, ownOn, ownWord, paceOf, paintAct, paintProve, paintSp, paintWallet, paintWalletBal, pairName, parseUnits, payFrom, payFromTok, payer, payingAccount, pct, pctFmt, pendingFor, pendingSent, perProof, permitSig, plain, pointsWho, poolLine, poolMaking, poolVsMarket, poolWorth, potTac, precisionApr, privateOf, proofsBusy, proofsFor, proveAhead, proveFmt, proveFor, proveOr, proveOwn, prover, provingNote, ptChain, ptsDays, ptsEnd, ptsFmt, ptsWhy, pubExitSend, pubOutData, pubPreview, pubSend, quoteErr, rankRows, rateStr, reProve, readOutlook, readPublicTac, readRow, readWrapTip, recipientOf, redeemBuild, redeemOn, redeemRefresh, redeemSend, redeemSent, redeemStep, refreshAll, refreshFarm, refreshWalletBal, relayDeposit, relayProving, relayWhy, render, rerender, resetPrivate, resolveToM, revertText, rewardPop, rewardWorth, rpc, running, samePos, say, sayErr, sayLive, scanIfNew, scanPrivate, scanShielded, scheduled, sealOn, secp, segSub, selfDo, selfOffer, selfWork, sendTx, setDeviceChain, setNotify, setPayer, settleBorrow, shLookingNote, sha256, sharePct, sharesEth, sheetOf, shieldedApr, short, shown, shownAs, sig, signIn, sizesNow, sleep, spApply, spMod, spOn, spRead, spSaid, spendable, stealthSendNow, stepBond, stepHarvest, stepLi, stepOf, stepRedeem, stepTakeOut, stepUnbond, store, strip, swapAsset, syncAccount, syncLink, tacOf, tacShort, tacitShort, takeBond, takeDraft, takenByOther, tickerOf, tkPin, toSelf, toast, tokDepositSend, tokRecipient, tokenSync, tokenWallet, tooFine, txFail, txLink, txMark, txSite, txUrl, unharvested, unitOf, unwrapNow, usdtExitFee, usdtOwner, usdtWrapNow, utcDay, viaText, viewAddr, vouchers, waitRanOut, waitTx, walletBalances, walletPriv, warn, wireAck, wireFinish, wireSignIn, wireSub, withKey, word, wordAt, wrapMax, wrapNow, wtacHere, xaOf, xbHeld, xbOf, xoCovered, xoDue, xoErr, xoFundRow, xoJournal, xoKeyOpen, xoLink, xoNoteText, xoOut, xoRecords, xoShown, your, zapAhead, zapNow, zapQuote, zapUnit, zapsFinish, zapsMine, zapsRead } = ctx;
const flatAddr = (a, n = 4) => new Raw(addrFlat(a, n));
const chainTab = (id, name) => html`${chainMark(id)}<span class="cn">${name}</span>`;
const sayRetry = (el, e, name) => say(el, html`<span class="err">${errText(e)}</span> <button class="link" type="button" data-retry="${name}">Try again</button>`);
const lossLine = (pct) => !(pct >= 0.5) ? html`` : html`<div class="kv"><span>Price impact</span><b class="${pct >= 5 ? 'err' : ''}">${pctFmt(pct)}</b></div>`;
const OBOX = { pub: null, box: null, min: null };
const RAMPS = [['MoonPay', 'https://www.moonpay.com/buy/eth'], ['Ramp', 'https://rampnetwork.com/buy'], ['Transak', 'https://transak.com/buy/eth']];
const maxNotes = async (k) => { const v = spendable(k), keep = await noteKeep(k); return v > keep ? v - keep : 0n; };
const LANE_SAID = { board: ', proved on Tacit’s own machine', 'network-private': ', proved on the prover network (private input)', 'network-public': ', proved on the prover network (public input)' };
function jobSteps(j) {
  const s = j.status, st = stepLi;
  if (s === 'failed' || s === 'unknown') return [st('Queued', 'done'), st('Proving', j.prov ? 'done' : ''), st(s === 'failed' ? 'Failed' : 'No record', 'bad')];
  if (OPENISH.includes(s)) return [st('Queued', 'done'), st('Proved', 'done'), st(s === 'sending' ? 'Sending' : 'Ready to send', 'now')];
  if (ownJob(j.id)) {
    const dev = DEV_JOB.test(j.id), at = s === 'settled' ? 4 : s === 'proven' ? 3 : j.stage === 'proved' ? 2 : j.stage === 'assigned' || j.stage === 'device' ? 1 : 0;
    return [dev ? 'This computer' : 'Asked Succinct', 'Proving', 'Proved', 'Sent'].map((l, i) => st(l, i < at ? 'done' : i === at ? 'now' : ''));
  }
  const at = { pending: 0, proving: 1 }[s] ?? 3;
  return ['Queued', 'Proving', s === 'proven' ? 'Proved' : 'Done'].map((l, i) => st(l, i < at ? 'done' : i === at ? 'now' : ''));
}
function actSteps(it) {
  const st = stepLi, s = it.status;
  if (it.kind === 'job') return jobSteps(it);
  if (it.kind === 'op') {
    const parts = opParts(it), main = parts.find((x) => x.main);
    const pre = parts.filter((x) => !x.main).map((x) => st(x.step, okStatus(x.it?.status) ? 'done' : !x.it || badStatus(x.it.status) ? 'bad' : 'now'));
    if (main?.it) return [...pre, ...jobSteps(main.it)];
    if (badStatus(s)) return parts.some((x) => !x.it || badStatus(x.it.status)) ? pre : [...pre, st('Stopped', 'bad')];
    return [...pre, st('Queued', parts.every((x) => okStatus(x.it?.status)) ? 'now' : ''), st('Proving'), st('Done')];
  }
  if (it.kind === 'chain') return [st('Sent', 'done'), st('Landed', s === 'settled' ? 'done' : s === 'failed' ? 'bad' : s === 'unknown' ? '' : 'now')];
  const first = it.kind === 'btc' ? 'Broadcast' : it.via === 'keeper' ? 'Relayed' : 'Sent';
  if (s === 'failed') return [st(first, 'done'), st('Reverted', 'bad')];
  if (s === 'stale') return [st(first, 'done'), st('Not confirmed yet')];
  return [st(first, s === 'pending' ? 'now' : 'done'), st('Confirmed', s === 'confirmed' ? 'done' : '')];
}
const byTime = (ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const byLine = (j) => (!j.by ? '' : j.by > Date.now() ? ` It has until ${byTime(j.by)} to go through: past that it expires, nothing is spent, and you send it again.`
  : ' Its time has run out: it will show as expired, nothing is spent, and you send it again.');
const WAIT_BY = { held: 'In line.', paused: 'In line.', down: 'In line.', busy: 'In line behind another request.' };
const jobWhere = (j) => {
  if (ownJob(j.id)) return j.status === 'proven' ? (JOBS.get(j.id.slice(4))?.run.live ? `Proved with your own credit. Sending it from ${your()}…`
    : SEALED.has(j.id.slice(4)) ? 'Proved with your own credit, but its settle was not sent.' : 'Proved, but the page that asked for it closed before sending it. Start it again.') : DEV_JOB.test(j.id) && devNow(j) ? devSaid(devNow(j)) : spSaid(j.stage, j.status, !!j.inPub);
  if (j.status === 'proving') return j.proveOnly ? 'The relay is proving it first. Nothing has left your wallet yet.' : `The relay is proving it, then settling it on Ethereum.${byLine(j)}`;
  if (j.status === 'open') return `Proved, and waiting for a relay to send it.${byLine(j)}`;
  if (j.status === 'sending') return `Proved. A relay is sending it.${byLine(j)}`;
  if (j.status === 'proven') return 'Proved.';
  const why = Date.now() - j.at > 60e3 ? relayWhy() : null;
  const fees = (j.ahead > 0 ? ` ${j.ahead} ahead of it.` : j.ahead === 0 ? ' It is next.' : '') + (Date.now() - j.at > 60e3 ? feesLine() : '');
  return j.by ? `${WAIT_BY[why] || 'Waiting for the relay to pick it up.'}${fees}${byLine(j)}` : `${(why && WAIT_WHY[why]) || 'Waiting for the relay to pick it up.'}${fees}`;
};
function opWhere(it) {
  const parts = opParts(it), cur = parts.at(-1);
  if (!cur?.it) return 'Getting it ready…';
  if (cur.main) return jobWhere(cur.it);
  if (okStatus(cur.it.status)) return 'Done with that. Queuing the rest…';
  if (cur.it.kind === 'tx') return html`${cur.doing || cur.step}: waiting for it to land · <a href="${txUrl(cur.it)}" target="_blank" rel="noopener">${txMark(cur.it)}${txSite(cur.it)} ↗</a>`;
  return `${cur.doing || cur.step}. ${jobWhere(cur.it)}`;
}
function actFoot(it) {
  if (it.kind === 'chain') {
    return it.status === 'settled' ? html`<div class="actr-f">Landed on Ethereum${it.end ? html` in ${clock(it.end - it.at)}` : ''}${it.height ? html`, block <span class="num">${it.height}</span>` : ''}</div>`
      : it.status === 'pending' ? html`<div class="actr-f">The leader has it. It lands in the next block, usually within a minute.</div>`
      : html`<div class="actr-f${it.status === 'failed' && !actStale(it) ? ' err' : ''}">${it.err || 'This page was closed before it landed. If it did not, it is kept and goes on by itself.'}</div>`;
  }
  const link = it.hash ? html`<a href="${txUrl(it)}" target="_blank" rel="noopener">${txMark(it)}${txSite(it)} ↗</a>` : '';
  if (it.status === 'failed' || it.status === 'unknown') return html`<div class="actr-f${actStale(it) ? '' : ' err'}">${linked(failText(it))}</div>${selfDoLine(it)}${proofHelp(it)}${SELF.has(it.id) || actStale(it) ? '' : againLine(it)}`;
  const took = it.end ? clock(it.end - it.at) : '';
  if (it.kind === 'op' && !ended(it)) return html`<div class="actr-f">${opWhere(it)}</div>${selfLine(it)}${openLine(it)}`;
  const say_ = {
    pending: () => (it.kind === 'job' ? jobWhere(it)
      : it.kind === 'btc' ? html`Waiting for its first Bitcoin confirmation · ${link}` : html`Waiting for it to land · ${link}`),
    proving: () => jobWhere(it),
    open: () => jobWhere(it),
    sending: () => jobWhere(it),
    settled: () => html`${it.flip ? 'Went through after all' : `Done in ${took}`}${ownJob(it.id) || it.own ? `, ${ownWord(it)}${it.inPub ? ' (public input)' : ''}` : it.sealed ? ', sealed to Tacit’s prover machine and proved there' : LANE_SAID[it.lane] || ''}${link ? ' · ' : ''}${link}`,
    proven: () => (ownJob(it.id) ? jobWhere(it) : JOBS.get(it.id.slice(4))?.run.live ? 'Proved. It lands with the transaction sent from this page.'
      : `Proved, but the page that asked for it stopped waiting, so it was never sent.${openOf(it) ? '' : ' Start it again.'}`),
    confirmed: () => html`${it.flip ? 'Confirmed' : `Confirmed in ${took}`} · ${link}`,
    stale: () => html`${it.kind === 'btc' ? 'Not confirmed after three days.' : 'Not seen after half an hour; it may have been dropped or replaced.'} ${link}`,
  }[it.status];
  return html`<div class="actr-f">${say_ ? say_() : ''}</div>${it.warn ? html`<div class="actr-f err">${it.warn}</div>` : ''}${selfLine(it)}${openLine(it)}`;
}
function selfLine(it) {
  if (SELF.has(it.id)) return html`<div class="actr-f">${SELF.get(it.id)}</div>`;
  const err = it.selfErr && !ended(it) ? html`<div class="actr-f err">${it.selfErr}${it.selfProve && !ownOn() ? html` <button class="link" type="button" data-prove-open>Prove it yourself</button>` : ''}</div>` : '';
  if (!selfWork(it)) { OFFERED.delete(it.id); return err; }
  OFFERED.add(it.id);
  if ((RS.why === 'paused' || RS.why === 'down') && !ownOn()) {
    return html`${err}<div class="actr-f"><button class="link" type="button" data-prove-open="device">Prove on this computer</button> to send it sooner, then ${it.self.exit ? 'send it' : 'finish it'} from ${your()} here.</div>`;
  }
  return html`${err}<div class="actr-f"><button class="link" type="button" data-self="${it.id}">${it.self.exit ? 'Send it' : 'Finish it'} from ${your()}</button>
    instead: ${it.self.exit ? `no relay fee; ${your()} pays the network fee, and its address shows on the withdrawal.` : `${your()} pays the network fee, and its address shows as the sender.`}</div>`;
}
function openLine(it) {
  const j = openOf(it);
  if (!j) { OPEN_OFFERED.delete(it.id); return ''; }
  OPEN_OFFERED.add(it.id);
  if (SELF.has(it.id)) return html`<div class="actr-f">${SELF.get(it.id)}</div>`;
  const err = it.selfErr ? html`<div class="actr-f err">${it.selfErr}</div>` : '';
  return html`${err}<div class="actr-f selfopt"><span class="why">Proved and ready.</span><button class="link go" type="button" data-sendopen="${it.id}">Send it now from ${your()}</button>
    <span class="why">${j.status === 'proven' ? `${your()} pays the network fee, and its address shows as the sender.` : `${your()} pays the network fee and its address shows as the sender; its relay fee comes back to you. Or leave it: it goes through when a relay sends it.`}</span>${alts(otherSelf('open', it.id))}</div>`;
}
function selfDoLine(it) {
  const spec = it.selfdo && SELFDO[it.selfdo];
  if (!spec || otherKey(it)) return '';
  if (SELF.has(it.id)) return html`<div class="actr-f">${SELF.get(it.id)}</div>`;
  return html`${it.selfErr ? html`<div class="actr-f err">${it.selfErr}</div>` : ''}${selfOffer(spec)}`;
}
function proofHelp(it) {
  const errs = it.kind === 'op' ? opParts(it).map((x) => x.it?.err) : [it.err];
  return errs.some((x) => /^prove failed/i.test(String(x || '')) && proofsBusy(x)) ? html`<div class="actr-f"><a href="/relay/#prove">Help pay for proofs</a></div>` : '';
}
const DEVICE_GET = 'https://github.com/src-company/tacit/tree/main/contracts/sp1/confidential/device-prover';
function actBridgeBody(it, b) {
  const fund = b.stage === 'covered' && !!b.lastError?.fundWait, failing = !!b.lastError && !fund, rejected = b.stage === 'mint-rejected';
  const at = b.stage === 'minted' ? 4 : XO_AT[b.stage] ?? 1;
  const due = b.stage !== 'minted' && xoDue(b), locked = (b.stage === 'covered' || (b.stage === 'settled' && xoCovered(b))) && !xoKeyOpen(b);
  return html`<ol class="stp">${XO_STEPS.map((l, i) => stepLi(l, i < at ? 'done' : i === at ? (failing || rejected ? 'bad' : 'now') : ''))}</ol>
    <div class="actr-f">${b.stage === 'minted' ? html`On your Bitcoin address.` : fund ? xoFundRow(b) : xoNoteText(b)}${it.hash ? html` · <a href="${txUrl(it)}" target="_blank" rel="noopener">${txMark(it)}${txSite(it)} ↗</a>` : ''}</div>
    ${failing ? html`<div class="actr-f err">${xoErr(b.lastError.message)}</div>` : ''}
    ${locked ? html`<div class="brr-a"><button class="btn ghost" type="button" data-act-key>Open your Tacit wallet</button></div>`
      : due ? html`<div class="brr-a"><a class="btn ghost" href="#${xoLink(xaOf(b))}" data-link="${xoLink(xaOf(b))}">${due}</a></div>` : ''}`;
}
const paceView = (id, pc) => html`<div class="pace" data-pace="${id}"><div class="actr-bar" role="progressbar" aria-label="How far along" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pc.pct}"><i style="width:${pc.pct}%"></i></div><span>${leftWords(pc.left)}</span></div>`;
const devBar = (row) => { const pc = paceOf(row); return pc ? paceView(row.id, pc) : html``; };
const actRow = (it) => {
  const b = actBridge(it), open = !!b && b.stage !== 'minted', done = ended(it) && !open;
  const good = done && (it.status === 'settled' || it.status === 'confirmed'), bad = done && !good && !actStale(it) && !['unknown', 'stale', 'proven'].includes(it.status);
  const mark = good ? html`<i class="actr-m ok" aria-label="Done">✓</i>` : bad ? html`<i class="actr-m err" aria-label="Did not go through">✕</i>` : '';
  return html`<li class="actr${done ? ' fin' : ''}" data-act="${it.id}">
  <div class="actr-h"><b>${mark}${it.label}</b>${done ? html`<span>${ago(b?.mintedAt || it.end || it.up || it.at)}</span>` : html`<span class="num"><i class="dot live" aria-hidden="true"></i><span data-since="${it.at}">${clock(Date.now() - it.at)}</span></span>`}</div>
  ${b ? actBridgeBody(it, b) : html`${good ? '' : html`<ol class="stp">${actSteps(it)}</ol>`}${devBar(it)}${actFoot(it)}`}${otherKey(it) ? html`<div class="actr-f">Made in another Tacit wallet. Open it to act on it.</div>` : ''}</li>`;
};
let ACT_VIEW = '';
const actStale = (it) => Date.now() - (it.end || it.up || it.at) > 86400e3;
const actRedone = (it, all) => (it.status === 'failed' || it.status === 'unknown') && !String(it.id).includes('~') && all.some((x) => x !== it && x.label === it.label && x.at > it.at && x.at - (it.end || it.at) < 86400e3 && (x.status === 'settled' || x.status === 'confirmed'));
function actGroups(items) {
  const on = items.filter((x) => !actDone(x)), off = items.filter(actDone);
  const head = (t, n) => html`<h3 class="acts-h">${t}${n ? html` <span class="num">${n}</span>` : ''}</h3>`;
  return html`${on.length ? html`${off.length ? head('In progress', on.length) : ''}<ol class="acts">${on.map(actRow)}</ol>` : ''}${off.length ? html`${on.length ? head('Earlier') : ''}<ol class="acts">${off.map(actRow)}</ol>` : ''}`;
}
function renderAct() {
  const el = $('#act-body'), items = listed().filter((it, _, all) => !actRedone(it, all)), can = typeof Notification === 'function';
  const on = can && !!store.get(NOTIFY_KEY) && Notification.permission === 'granted';
  const view = html`
    ${items.length ? actGroups(items) : html`<p class="gate-p">Nothing yet. What you send from this page, and what the relay proves for you, shows up here as it happens.</p>`}
    ${can ? html`<label class="pick"><input type="checkbox" id="act-notify" ${on ? 'checked' : ''}><span>Notify me when something finishes while this tab is in the background.</span></label>` : ''}
    <div class="status" role="status" id="act-note"></div>
    <div class="act-foot"><span>Kept in this browser only. Your balances never depend on it.</span>${items.some(actDone) ? html`<button class="link" type="button" id="act-clear">Clear finished</button>` : ''}</div>`;
  const sig = view.s.replace(/(data-since="\d+">)[^<]*/g, '$1');
  if (sig === ACT_VIEW && el.firstChild) return;
  ACT_VIEW = sig;
  keep(el, () => mount(el, view));
  const nb = $('#act-notify', el), setNote = (t) => { const n = $('#act-note'); if (n) n.textContent = t; };
  if (nb) nb.onchange = async () => {
    const why = await setNotify(nb.checked);
    if (why) nb.checked = false;
    setNote(why);
  };
  const cl = $('#act-clear', el);
  if (cl) cl.onclick = () => {
    const kept = new Set(listed().filter((x) => !actDone(x)).map((x) => x.id));
    ACT.cleared = Date.now(); RUNS.forEach(lastEnd);
    ACT.items = ACT.items.filter((x) => kept.has(x.in || x.id)); actSave(); paintAct();
  };
}
const LEGACY_SHEET = [[/^(Make .* TAC public|Withdraw [\d.,]+ TAC)$/, 'tac'], [/^Withdraw .* ETH to /, 'eth'], [/^Withdraw .* cUSD as tacUSD$/, 'borrow']];
function againLine(it) {
  if (it.status !== 'failed' || (it.kind !== 'job' && it.kind !== 'op') || otherKey(it)) return '';
  const s = String(it.err || '');
  if (/possibly still pending|already spent|already (gone|went) through|b115d857|deposit is safe|first part went through|already settled/i.test(s)) return '';
  const own = it.sheet || LEGACY_SHEET.find(([re]) => re.test(String(it.label || '')))?.[1];
  const sheet = own && $(`#sheet-${own}`) ? own : null;
  return html`${/nothing was spent/i.test(failText(it)) ? '' : html`<div class="actr-f">Nothing was spent: it is still in your private balance.</div>`}
    <div class="brr-a"><button class="btn ghost" type="button" data-act-again="${sheet || ''}">${sheet ? 'Try again' : 'Read my balance again'}</button></div>`;
}
const ethLine = (named = false) => (S.wallet && S.provider ? html`<div class="kv eth-line"><span>${S.provider.isWalletConnect ? 'WalletConnect' : chainTag(1)}</span><b>${named ? '' : html`<span class="num">${viewAddr(S.wallet, 4)}</span>`}<button class="link" type="button" data-wc-change>Change account</button><button class="link" type="button" data-wc-off>Disconnect</button></b></div>` : '');
const payName = () => (payer() === 'tacit' ? 'Key address' : 'Wallet');
function l2Balances(who) {
  if (L2BAL.who !== who || Date.now() - L2BAL.at > 60e3) {
    Object.assign(L2BAL, { who, at: Date.now() });
    L2BAL.p = Promise.all(DEVICE_CHAINS.filter((c) => c.chainId !== 1).map((c) => rpc('eth_getBalance', [who, 'latest'], c.rpc).then((b) => [c, BigInt(b)], () => [c, null])));
  }
  return L2BAL.p;
}
function wbClick(e) {
  if (e.target.closest('#wbal-re')) return refreshWalletBal();
  const b = e.target.closest('[data-dash-open]');
  if (!b) return;
  e.preventDefault(); e.stopPropagation();
  $('#sheet-wallet').close();
  dashGo(b);
}
const walletKeys = (open = false) => html`<details class="w-acc"${open ? ' open' : ''}><summary>Addresses and public key</summary>
  ${keyRow('Bitcoin address', plainAddr(), 'Bitcoin address', 'Sats from any wallet or exchange.', { qr: true })}
  ${keyRow('Ethereum address', S.acct.address, 'Ethereum address', 'This key’s own. ETH sent here can pay instead of a wallet.')}
  ${keyRow('Public key', S.key.pubHex, 'Public key', 'For a Send box that asks for a key.')}</details>`;
render.wallet = () => {
  const el = $('#wallet-body');
  if (!S.key) {
    const known = knownWallet(), other = otherWallet();
    mount(el, html`${known || other ? '' : html`<p class="lede-s">Your Tacit wallet holds your private balances. Signing in is free and sends nothing, and the same wallet or passkey opens it every time.</p>`}${signIn('ws')}
      ${S.wallet && S.provider ? html`<div class="wl-foot"><div class="lbl"><span>Connected</span></div>${ethLine(openerOn(known) || openerOn(other))}</div>` : ''}`);
    return wireSignIn(el, 'ws', () => $('#sheet-wallet').close());
  }
  const k = S.key, kept = k.mode === 'ext' || k.mode === 'local', a = S.acct, pays = payer(), btcAddr = ctx.T?.extWallet?.state?.address || (k.mode === 'btc' || k.mode === 'ext' ? k.address : null);
  const btcOther = btcAddr && btcAddr !== k.address;
  const eth = html`<svg class="tk sm" aria-hidden="true"><use href="#tk-eth"/></svg>`;
  mount(el, html`
    <div id="wbal-box">${walletBalances()}</div>
    <div class="who keyrow" id="w-tacit">
      <div class="kv"><span>Your Tacit address</span><span class="keyacts"><button class="link" type="button" id="w-copy" ${k.tacit ? '' : 'disabled'}>Copy</button><button class="link" type="button" data-fold aria-expanded="false" ${k.tacit ? '' : 'disabled'}>Show all</button></span></div>
      ${k.tacit ? html`<div class="addr num ends">${short(k.tacit, 12)}</div><div class="full"><code>${k.tacit}</code></div>` : html`<div class="addr num">…</div>`}
      <div class="u">Paid privately on ${chainMarks(['btc', 1])}</div>
      ${k.tacit ? html`<div class="u">ID <b class="num">${addressId(k.tacit)}</b> · a payer sees it too</div>` : ''}
      <div class="u by">Opened with ${viaText(k)} · <button class="link" type="button" id="w-lock">Lock</button></div></div>
    <div id="w-keys">${walletKeys()}</div>
    <div class="lbl sep" id="pay-h"><span>Public ETH comes from</span></div>
    <div class="opts" role="radiogroup" aria-labelledby="pay-h">
      <button class="opt${pays === 'wallet' ? ' main' : ''}" type="button" role="radio" aria-checked="${String(pays === 'wallet')}" data-pay="wallet"><span class="opt-t">${eth}Your wallet${pays === 'wallet' ? html`<span class="tag">pays</span>` : ''}<span class="num w-bal" id="ac-wbal">${S.wallet ? html`<span class="sk" style="--w:5ch"></span>` : ''}</span></span><span class="opt-m">${S.wallet ? short(S.wallet, 8) : evm.available() ? 'Connects when you press' : 'Connect one to pay from it'}</span></button>
      <button class="opt${pays === 'tacit' ? ' main' : ''}" type="button" role="radio" aria-checked="${String(pays === 'tacit')}" data-pay="tacit"><span class="opt-t">${eth}This key’s address${pays === 'tacit' ? html`<span class="tag">pays</span>` : ''}<span class="num w-bal" id="ac-abal"><span class="sk" style="--w:5ch"></span></span></span><span class="opt-m">No popups: send ETH to it first</span></button>
    </div>
    <p class="note" id="ac-l2" hidden></p>
    <div class="kv pf"><span>Proofs</span><b>${devOn() ? 'This computer' : spOn() ? 'Your own prover credit' : 'Tacit’s relay'}</b><button class="link" type="button" data-prove-open>${ownOn() ? 'manage' : 'prove them yourself'}</button></div>
    ${segSub('wal', WAL.mode, [['add', 'Add ETH'], ['out', 'Send out']])}
    <div id="ac-form"></div>
    <div class="status" role="status" id="ac-status"></div>
    ${btcOther || (S.wallet && S.provider) ? html`<div class="lbl sep"><span>Connected</span></div>` : ''}
    ${btcOther ? html`<div class="kv"><span>${chainTag('btc')}</span><b>${viewAddr(btcAddr, 8)}</b></div>` : ''}
    ${ethLine()}
    <div class="lbl sep"><span>Your key</span>${kept ? html`<button type="button" id="w-backup">Copy key to back up</button>` : ''}</div>
    <p class="note">${kept ? 'Kept in this browser only: clearing its data loses it.' : k.mode === 'key' ? 'Pasted and not saved: closing the tab forgets it.' : 'Your wallet or passkey opens it again: keep that safe.'} Anyone who has the key holds these funds and the address that goes with it.</p>`);
  $('#w-copy').onclick = () => k.tacit && copy(k.tacit, 'Tacit address copied');
  if (!plainAddr()) loadPlain().then(() => { const w = $('#w-keys'); if (w?.isConnected && S.key?.pubHex === k.pubHex) mount(w, walletKeys(!!w.querySelector('details')?.open)); }).catch(() => {});
  loadBtc().then(paintWalletBal, paintWalletBal);
  $('#wbal-box').onclick = wbClick;
  $('#w-backup')?.addEventListener('click', () => navigator.clipboard.writeText(k.priv).then(() => toast('Key copied. Keep it somewhere private.'), () => toast('Could not copy the key: the browser refused clipboard access.', true)));
  $('#w-lock').onclick = () => { if (midAction()) return; evm.deselectProvider(); S.key = null; syncAccount(); resetPrivate(); paintWallet(); refreshAll(); rerender('wallet'); };
  const bal = (id, who) => { const e = $('#' + id); if (who && e) rpc('eth_getBalance', [who, 'latest']).then((b) => `${fmt(BigInt(b), 18, 4)} ETH`, () => '—').then((t) => { e.textContent = t; }); };
  bal('ac-abal', a.address); bal('ac-wbal', S.wallet);
  const l2 = $('#ac-l2');
  l2Balances(a.address)
    .then((rows) => {
      const has = rows.filter(([, b]) => b != null && b >= 10n ** 14n);
      if (!l2.isConnected || !has.length) return;
      mount(l2, html`Also ${has.map(([c, b], i) => html`${i ? ' and ' : ''}${fmt(b, 18, 4)} ETH ${chainTag(c.chainId)}`)}, which pays for the private pool there.`); l2.hidden = false;
    });
  $$('[data-pay]', el).forEach((b) => b.onclick = () => !midAction() && busy(b, async () => {
    try { if (b.dataset.pay === 'wallet' && !S.wallet) await connect(); setPayer(b.dataset.pay); } catch (e) { toast(errText(e), true); }
  }));
  wireSub(el, 'wal', (m) => { WAL.mode = m; keep($('#sheet-wallet'), render.wallet); });
  const f = $('#ac-form'), status = $('#ac-status');
  const amountField = (extra = '') => html`<div class="lbl"><span>Amount</span>${extra}</div>
    <div class="amt"><input id="ac-mv" inputmode="decimal" placeholder="0.00" autocomplete="off" aria-label="ETH"><span class="u">${eth}ETH</span></div>`;
  if (WAL.mode === 'add') {
    mount(f, html`
      <div class="kv"><span>Address</span><b class="mono">${viewAddr(a.address, 10)}</b><button class="link" type="button" data-copy="${a.address}">copy</button></div>
      <p class="note">Send ETH to it from any wallet or exchange. On Ethereum it pays for everything here; on <span class="nw">${chainMarks([8453, 4663])},</span> for the private pool there.${S.wallet ? ' Or add some from your wallet here; that links the two on chain.' : html` Or <button class="link" type="button" id="ac-connect">connect a wallet</button> to add from it.`}</p>
      ${S.wallet ? html`${amountField()}<button class="btn" type="button" id="ac-go">Add from wallet</button>` : ''}`);
    const cn = $('#ac-connect');
    if (cn) cn.onclick = () => busy(cn, async () => { try { await connect(); setPayer('tacit'); } catch (e) { sayErr(status, e); } });
  } else {
    const tac = WAL.asset === 'tac', chain = tac ? 1 : WAL.chain;
    mount(f, html`
      ${segSub('wala', WAL.asset, [['eth', 'ETH'], ['tac', 'TAC']])}
      ${tac ? '' : segSub('walc', String(chain), DEVICE_CHAINS.map((x) => [String(x.chainId), chainTab(x.chainId, x.name)]))}
      <div class="lbl"><span>To</span>${S.wallet ? html`<button type="button" id="ac-me">My wallet</button>` : ''}</div>
      <div class="amt text"><input id="ac-to" placeholder="0x…" autocomplete="off" spellcheck="false" autocapitalize="off" autocorrect="off" aria-label="Recipient address"></div>
      ${tac ? html`<div class="lbl"><span>Amount</span><button type="button" id="ac-max">Max</button></div>
        <div class="amt"><input id="ac-mv" inputmode="decimal" placeholder="0.00" autocomplete="off" aria-label="TAC"><span class="u"><svg class="tk sm" aria-hidden="true"><use href="#tk-tac"/></svg>TAC</span></div>`
        : amountField(html`<button type="button" id="ac-max">Max</button>`)}
      <button class="btn" type="button" id="ac-go">Send from key address</button>`);
    wireSub(f, 'wala', (v) => { WAL.asset = v; WAL.all = false; keep($('#sheet-wallet'), render.wallet); });
    wireSub(f, 'walc', (v) => { WAL.chain = Number(v); WAL.all = false; keep($('#sheet-wallet'), render.wallet); });
    $('#ac-mv').addEventListener('input', (e) => { if (e.isTrusted) WAL.all = false; });
    $('#ac-me')?.addEventListener('click', () => { $('#ac-to').value = S.wallet; });
    $('#ac-max').onclick = () => busy($('#ac-max'), async () => {
      try {
        if (tac) { const v = wordAt(await ethCall(ADDR.tac, SEL.balanceOf + addrWord(a.address)), 0); $('#ac-mv').value = v ? plain(v, 18) : ''; return; }
        const call = await chainRpc(chain);
        const [b, blk] = await Promise.all([call('eth_getBalance', [a.address, 'latest']), call('eth_getBlockByNumber', ['latest', false])]);
        const fee = 25200n * (2n * BigInt(blk.baseFeePerGas) + 15n * 10n ** 8n), v = BigInt(b) > fee ? BigInt(b) - fee : 0n;
        $('#ac-mv').value = v ? plain(v, 18) : '';
        WAL.all = !!v;
      } catch (e) { sayErr(status, e); }
    });
  }
  $$('[data-copy]', f).forEach((b) => b.onclick = () => copy(b.dataset.copy));
  const go = $('#ac-go');
  if (go) go.onclick = () => busy(go, async (run) => {
    let hash, base;
    try {
      const value = parseUnits($('#ac-mv').value), to = WAL.mode === 'add' ? a.address : recipientOf($('#ac-to').value);
      if (!value) throw new Error('Enter an amount.');
      const out = WAL.mode === 'out', tac = out && WAL.asset === 'tac', chainId = out && !tac ? WAL.chain : 1;
      const c = DEVICE_CHAINS.find((x) => x.chainId === chainId);
      const label = tac ? `Send ${fmt(value, 18, 6)} TAC out` : out ? `Send ${fmt(value, 18, 6)} ETH out${chainId === 1 ? '' : ` on ${chainFull(c.chainId)}`}` : `Add ${fmt(value, 18, 6)} ETH to this key’s address`;
      base = c.explorer;
      const all = out && !tac && WAL.all;
      hash = await sendTx(tac ? { to: ADDR.tac, data: SEL.transfer + addrWord(to) + word(value), via: 'tacit', label } : { to, data: '0x', value, via: out ? 'tacit' : 'wallet', chainId, label, sweep: all });
      say(status, html`Sending… ${txLink(hash, c.explorer)}`);
      await waitTx(hash, { chainId });
      clearField($('#ac-mv')); WAL.all = false;
      say(status, html`<span class="ok">${WAL.mode === 'add' ? 'Added.' : 'Sent.'}</span> ${txLink(hash, c.explorer)}`);
      rerender('wallet');
    } catch (e) { if (pendingSent(status, e, hash, base)) { clearField($('#ac-mv')); WAL.all = false; run.release(true); } else sayErr(status, e); }
  });
};
const proofsWord = (n) => `${n} proof${n === 1 ? '' : 's'}`;
function devWatch() {
  clearInterval(SP.devTick);
  if (!devOn()) return;
  SP.devTick = setInterval(async () => {
    if (!$('#sheet-prove')?.open || !devOn()) { clearInterval(SP.devTick); return; }
    const had = !!LOCAL.found;
    await devProver({ fresh: true });
    if (!!LOCAL.found !== had) { spApply(); paintSp(); reProve(); return; }
    const n = $('#sp-dev-note');
    if (n) mount(n, html`${devNote()}`);
  }, 4000);
}
function devNote() {
  if (LOCAL.looking && !LOCAL.found) return 'Looking for tacit-prover on this computer…';
  if (!LOCAL.found) return 'Not answering yet: start tacit-prover with the command below. Until it answers, Tacit’s relay proves your actions.';
  const run = listed().find((it) => DEV_JOB.test(it.id) && !ended(it) && it.status !== 'proven'), at = run && devNow(run), q = Number(LOCAL.found.queued) || 0;
  const now = at ? ` Proving now: step ${at.step} of 4, ${etaWords(at.left)}.` : LOCAL.found.busy ? ' Proving now.' : '';
  return html`On: ${LOCAL.found.gpu ? `this computer (${LOCAL.found.gpu})` : 'this computer'} proves your sends, wraps, claims and farm joins, sent from ${your()}.${now}${q ? ` ${q} more waiting.` : ''}`;
}
const PROVER_CMD = 'curl -fsSL https://tacit.finance/prove.sh | sh';
function sizeRow() {
  const sizes = sizesNow();
  return sizes.length ? html`<p class="sp-size" data-sizes="${sizes.join(',')}">Add enough for ${sizes.map((n, i) => html`${i ? ' · ' : ''}<button class="link" type="button" data-sp-size="${n}">${proofsWord(n)}</button>`)}</p>` : '';
}
function renderProve() {
  const el = $('#prove-body');
  if (!S.key) {
    mount(el, html`<p class="gate-p">Open your Tacit wallet first: its Ethereum address is your prover account, and its credit pays for your proofs.</p>${signIn(el.id)}`);
    return wireSignIn(el, el.id, () => openProve());
  }
  const a = S.acct, on = spOn(), dev = devOn(), seal = sealOn(), src = SP.src === 'acct' && !(SP.held > 0n) ? 'prove' : SP.src;
  SP.src = src;
  const credit = SP.credit, short_ = credit != null && proofsFor(credit) === 0;
  const unit = src === 'eth' ? 'ETH' : 'PROVE';
  const way = dev ? 'device' : on ? 'credit' : 'relay';
  const wayOpt = (k, id, title, sub) => html`<label class="spw-o"><input type="radio" name="spw" id="${id}" ${way === k ? 'checked' : ''}><span><b>${title}</b><small>${sub}</small></span></label>`;
  const panel = way === 'device' ? html`<div class="spw-p">
      <p class="note sp-live" id="sp-dev-note" aria-live="polite">${devNote()}</p>
      ${LOCAL.found ? '' : html`<div class="sp-get"><div class="sp-cmd"><span>macOS (Apple silicon) or Linux (x86-64)</span><code>${PROVER_CMD}</code><button class="link" type="button" data-copy="${PROVER_CMD}">copy</button></div>
        <p class="note">Paste it in a terminal: it checks the download, starts with your computer, and idles at no CPU. The first proof also downloads SP1’s 6.2 GB circuit, once. Windows and Intel Macs: <a href="${DEVICE_GET}" target="_blank" rel="noopener">build it from source</a>.</p></div>`}
    </div>`
    : way === 'credit' ? html`<ol class="steps">
      <li class="step done"><span class="n">1</span><div><h3>Your prover account</h3>
        <div class="kv"><span>Key address</span><b class="mono">${viewAddr(a.address, 8)}</b><button class="link" type="button" data-copy="${a.address}">copy</button></div>
        <div class="kv"><span>Prover credit</span><b class="num" id="sp-credit"><span class="sk" style="--w:7ch"></span></b></div>
        <div class="kv"><span>Enough for</span><b id="sp-proofs"><span class="sk" style="--w:9ch"></span></b></div>
        <div class="kv"><span>ETH for network fees</span><b class="num" id="sp-eth"><span class="sk" style="--w:6ch"></span></b><button class="link" type="button" data-fund>Add ETH</button></div>
        <p class="note">PROVE you add shows here a few minutes after it lands.</p></div></li>
      <li class="${credit == null || short_ ? 'step now' : 'step done'}"><span class="n">2</span><div><h3>Add PROVE</h3>
        ${segSub('sps', src, [['prove', 'PROVE from wallet'], ['eth', 'ETH from wallet'], ...(SP.held > 0n ? [['acct', 'PROVE in key address']] : [])])}
        <div class="lbl"><span>${src === 'eth' ? 'ETH to pay' : 'PROVE to add'}</span><button type="button" id="sp-max"><span id="sp-hold"></span></button></div>
        <div class="amt"><input id="sp-amt" inputmode="decimal" placeholder="0.00" autocomplete="off" aria-label="${unit} to ${src === 'eth' ? 'pay' : 'add'}"><span class="u">${unit}</span></div>
        ${src === 'eth' ? sizeRow() : ''}
        <div class="rcpt" id="sp-rcpt" hidden></div>
        <button class="btn" type="button" id="sp-go" ${src !== 'acct' && !S.wallet ? '' : 'disabled'}>${src !== 'acct' && !S.wallet ? 'Connect wallet' : 'Add PROVE'}</button>
        <div class="status" role="status" id="sp-status"></div></div></li>
    </ol>
    <p class="note">Each private action is proved with your credit (about ${perProof()} PROVE) and sent from ${your()}. One it can’t prove from here goes through Tacit’s relay, and says so.</p>`
    : html`<div class="spw-p">
      <label class="pick"><input type="checkbox" id="sp-seal" ${seal ? 'checked' : ''}><span>Seal my actions to Tacit’s prover machine</span></label>
      <p class="note">${seal ? 'On: each action is encrypted here to the machine that proves it, so Tacit’s relay and API hold only ciphertext. While that machine is away, an action waits for you to try again.'
        : 'Off: the relay reads each action to prove it. Turn this on and only the machine that proves it can read your sends, swaps and pool moves.'}</p>
    </div>`;
  mount(el, html`
    <p class="lede-s">Who proves your private actions.</p>
    <div class="spw" role="radiogroup" aria-label="Who proves your private actions">
      ${wayOpt('relay', 'sp-relay', 'Tacit’s relay', 'about a minute, nothing to set up')}
      ${wayOpt('device', 'sp-dev', 'This computer', 'free and private, a few minutes')}
      ${on || SP.more ? wayOpt('credit', 'sp-on', 'Your own credit', 'about a minute, paid in PROVE on Succinct’s network') : ''}
    </div>
    ${on || SP.more ? '' : html`<p class="note"><button class="link" type="button" id="sp-more">Prove with PROVE credit instead</button></p>`}
    ${panel}
    ${S.key ? html`<p class="note" id="sp-keep">Keep wraps ready to send at once${dev ? ' (proved here while it is idle)' : ' (proved free by the community)'}: ${Object.entries(KEEP_READY).map(([tk, k], i) => html`${i ? ' ·' : ''}${k.sizes.map((w) => html` <button class="link" type="button" data-keep="${tk}:${w}" aria-pressed="${String(keepSizes(tk).includes(w))}">${keepSizes(tk).includes(w) ? '✓ ' : ''}${fmt(w, 18, k.dp)} ${k.sym}</button>`)}`)}</p>` : ''}
    ${SP.then ? html`<div class="callout"><span>Waiting to go on: ${SP.then.label}.</span><button class="btn ghost" type="button" id="sp-then" ${on || dev ? '' : 'disabled'}>Go on</button></div>` : ''}</div></li>`);
  $$('[data-copy]', el).forEach((b) => b.onclick = () => copy(b.dataset.copy));
  wireSub(el, 'sps', (v) => { SP.src = v; SP.srcChosen = true; SP.q = null; reProve(); });
  const amt = $('#sp-amt'), go = $('#sp-go'), rc = $('#sp-rcpt'), status = $('#sp-status');
  if (amt) {
    let seq = 0;
    $$('[data-sp-size]', el).forEach((b) => b.onclick = () => busy(b, async () => {
      try {
        const short = proveFor(Number(b.dataset.spSize)) - (SP.credit ?? 0n), least = SP.mod?.MIN_DEPOSIT_WEI ?? 10n ** 16n;
        if (short <= 0n) return;
        const add = short < least ? least : short;
        mount(rc, html`<div class="kv"><span>You get</span><b><span class="sk" style="--w:7ch"></span></b></div>`); rc.hidden = false;
        const q = await (await spAbi()).ethForProve({ call: spCall, to: S.acct.address, want: add, now: chainNow() });
        amt.value = plain(q.wei, 18); amt.dispatchEvent(new Event('input'));
      } catch (e) { quoteErr(rc, e); }
    }));
    $('#sp-max').onclick = () => {
      const v = src === 'acct' ? SP.held : src === 'prove' ? SP.wProve : SP.wEth != null ? (SP.wEth > 3n * 10n ** 15n ? SP.wEth - 3n * 10n ** 15n : 0n) : null;
      if (v != null) { amt.value = v ? plain(v, 18) : ''; amt.dispatchEvent(new Event('input')); }
    };
    onEdit([amt], go, async () => {
      const my = ++seq, wei = parseUnits(amt.value);
      SP.q = null; go.disabled = !(src !== 'acct' && !S.wallet);
      if (!wei) { rc.hidden = true; return; }
      if (src !== 'eth' && wei < (SP.mod?.MIN_DEPOSIT_WEI ?? 10n ** 16n)) { mount(rc, html``); warn(rc, 'Add at least 0.01 PROVE.'); return; }
      if (src === 'eth') {
        mount(rc, html`<div class="kv"><span>You get</span><b><span class="sk" style="--w:7ch"></span></b></div>`); rc.hidden = false;
        try {
          const q = await spQuote(wei);
          if (my !== seq || !amt.isConnected) return;
          if (q.amountLimit < (SP.mod?.MIN_DEPOSIT_WEI ?? 10n ** 16n)) { mount(rc, html``); warn(rc, 'Pay enough to buy at least 0.01 PROVE: less than that cannot be added.'); return; }
          SP.q = q;
          mount(rc, html`<div class="kv"><span>You get about</span><b>${proveFmt(q.amountOut)} PROVE</b></div><div class="kv"><span>At least</span><b>${proveFmt(q.amountLimit)} PROVE · 1% slippage guard</b></div>
            <div class="kv"><span>Your credit then covers</span><b>about ${proofsWord(proofsFor((SP.credit ?? 0n) + q.amountLimit))}</b></div>`);
          go.disabled = false;
        } catch (e) { if (my === seq) quoteErr(rc, e); }
        return;
      }
      mount(rc, html`<div class="kv"><span>Your credit then covers</span><b>about ${proofsWord(proofsFor((SP.credit ?? 0n) + wei))}</b></div>
        <div class="kv"><span>${src === 'acct' ? 'From' : 'Paid by'}</span><b>${src === 'acct' ? 'this key’s address, two transactions' : 'your wallet; this key’s address signs the deposit here'}</b></div>`);
      rc.hidden = false;
      go.disabled = false;
    });
    go.onclick = () => busy(go, async () => {
      try {
        if (src !== 'acct' && !S.wallet) { await connect(); reProve(); spRead(true).catch(() => {}); return; }
        const wei = parseUnits(amt.value);
        if (!wei) throw new Error('Enter an amount.');
        const added = await spFund(src, wei, (v) => say(status, v));
        clearField(amt); rc.hidden = true;
        say(status, html`<span class="ok">Added ${proveFmt(added, 4)} PROVE.</span> It shows in your prover credit a few minutes after it lands.`);
        toast('PROVE added to your prover credit');
        spRead(true).catch(() => {});
      } catch (e) { if (!pendingSent(status, e)) sayErr(status, e); }
    });
  }
  const choose = (w) => {
    if (midAction()) { reProve(); return; }
    store.set(SP_PREF + S.key.pubHex, w === 'credit' ? true : null);
    store.set(DEV_PREF + S.key.pubHex, w === 'device' ? true : null);
    spApply(); paintSp(); reProve();
    if (w !== 'device') return toast(w === 'credit' ? 'Your private actions are proved with your own credit now.' : 'Tacit’s relay proves your actions again.');
    devProver({ fresh: true }).then((x) => {
      if (!devOn()) return;
      spApply(); paintSp(); reProve();
      toast(x ? 'Your sends, wraps and claims are proved on this computer now.' : 'The prover on this computer isn’t answering yet, so Tacit’s relay proves your actions until it does.');
    });
  };
  $('#sp-relay').onchange = () => choose('relay');
  $('#sp-dev').onchange = () => choose('device');
  if ($('#sp-on')) $('#sp-on').onchange = () => choose('credit');
  if ($('#sp-more')) $('#sp-more').onclick = () => { SP.more = true; reProve(); };
  devWatch();
  $$('[data-keep]', el).forEach((b) => b.onclick = () => {
    const [tk, ws] = b.dataset.keep.split(':'), k = KEEP_READY[tk], w = BigInt(ws), now = keepSizes(tk), next = now.includes(w) ? now.filter((x) => x !== w) : [...now, w];
    store.set(keepKey(tk), next.map(String));
    reProve();
    if (next.includes(w)) { toast(`A ${fmt(w, 18, k.dp)} ${k.sym} wrap is ${devOn() ? 'proved on this computer while it is idle' : 'asked of the community proof pool'}, ready to send at once.`); keepReady().catch(() => {}); }
  });
  if ($('#sp-seal')) $('#sp-seal').onchange = (e) => {
    if (midAction()) { e.target.checked = !e.target.checked; return; }
    store.set(SP_SEAL + S.key.pubHex, e.target.checked ? true : null);
    spApply(); paintSp();
    toast(e.target.checked ? 'Your actions are sealed to Tacit’s prover machine now; only it can read them.' : 'Tacit’s relay reads your actions again to prove them.');
  };
  const then = $('#sp-then');
  if (then) then.onclick = () => {
    const spec = SP.then;
    if (!spec || !ownOn()) return;
    SP.then = null;
    $('#sheet-prove').close();
    if (spec.resume) { spec.resume(); return; }
    if (spec.sheet && $(`#sheet-${spec.sheet}`) && !shown(spec.sheet)) openSheet(spec.sheet);
    busy(then, (run) => selfDo(run, { ...spec, own: true }));
  };
  paintProve();
}
const spAbi = () => import('/relay/abi.js');
const spCall = ({ to, data, gas }) => rpc('eth_call', [{ to, data, gas }, 'latest']);
async function spQuote(wei) {
  const abi = await spAbi();
  return abi.quoteEthToProve({ call: spCall, to: S.acct.address, wei, now: chainNow() });
}
async function spSend(tx) {
  const from = tx.via === 'tacit' ? S.acct.address : S.wallet;
  try { await rpc('eth_call', [{ from, to: tx.to, data: tx.data, ...(tx.value ? { value: '0x' + BigInt(tx.value).toString(16) } : {}) }, 'latest']); }
  catch (e) { if (e?.revert) throw Object.assign(new Error('It would not go through, so nothing was sent.'), { said: true }); }
  return sendTx(tx);
}
async function spFund(src, wei, tell) {
  const m = await spMod(), a = S.acct, prove = m.PROVE_TOKEN;
  const heldNow = () => ethCall(prove, m.BALANCE_OF_SELECTOR + addrWord(a.address)).then((x) => wordAt(x, 0));
  if (src === 'acct') {
    tell('Approving the deposit from this key’s address…');
    const h1 = await spSend({ to: prove, data: m.approveData(wei), via: 'tacit', label: `Approve ${proveFmt(wei, 4)} PROVE for the prover network` });
    await waitTx(h1);
    tell(html`Depositing it… ${txLink(h1)}`);
    const h2 = await spSend({ to: m.VAPP, data: m.depositData(wei), via: 'tacit', label: `Add ${proveFmt(wei, 4)} PROVE to your prover credit` });
    tell(html`Depositing it… ${txLink(h2)}`);
    await waitTx(h2);
    return wei;
  }
  let amount = wei;
  const bought = async (x) => {
    await waitTx(x.hash).catch((e) => { if (!e?.pending) SP.landed = null; throw e; });
    let got = 0n;
    for (let i = 0; i < 4 && got < m.MIN_DEPOSIT_WEI; i++) { if (i) await sleep(4000); got = (await heldNow()) - x.before; }
    if (got < m.MIN_DEPOSIT_WEI) throw Object.assign(new Error('The swap landed, but the PROVE it bought has not shown in this key’s address yet. Press again in a minute to add it.'), { said: true });
    return (x.amount = got);
  };
  const landed = src === 'eth' && SP.landed && SP.landed.wei === wei && SP.landed.who === a.address && Date.now() - SP.landed.at < 30 * 60e3 ? SP.landed : null;
  if (landed) {
    tell('The swap was sent already. Adding the PROVE it bought…');
    amount = landed.amount ?? await bought(landed);
  } else if (src === 'eth') {
    const q = SP.q && SP.q.wei === wei && Date.now() - SP.q.at < 60e3 ? SP.q : await spQuote(wei);
    const before = await heldNow();
    tell('Confirm the swap in your wallet: ETH to PROVE, for this key’s address…');
    const h = await spSend({ to: q.router, data: q.callData, value: q.msgValue, via: 'wallet', label: `Swap ${fmt(wei, 18, 6)} ETH to PROVE for this key’s address` });
    SP.landed = { wei, who: a.address, hash: h, before, amount: null, at: Date.now() };
    tell(html`Swapping… ${txLink(h)}`);
    amount = await bought(SP.landed);
  } else {
    const held = await heldNow();
    if (held < wei) {
      tell(`Confirm in your wallet: ${proveFmt(wei - held, 4)} PROVE to this key’s address…`);
      const h = await spSend({ to: prove, data: '0x' + SEL.transfer + addrWord(a.address) + word(wei - held), via: 'wallet', label: `Send ${proveFmt(wei - held, 4)} PROVE to this key’s address` });
      tell(html`Sending PROVE to this key’s address… ${txLink(h)}`);
      await waitTx(h);
    }
  }
  const [nonce, dom] = await Promise.all([ethCall(prove, m.NONCES_SELECTOR + addrWord(a.address)).then((x) => wordAt(x, 0)), ethCall(prove, m.DOMAIN_SEPARATOR_SELECTOR)]);
  const deadline = BigInt(chainNow() + 3600);
  const sig = m.signPermit({ secp, keccak256: keccak_256, privHex: S.acct.priv, owner: a.address, amountWei: amount, nonce, deadline, domainSeparator: '0x' + strip(dom).slice(0, 64) });
  tell('Confirm the deposit in your wallet…');
  const h2 = await spSend({ to: m.VAPP, data: m.permitAndDepositData({ from: a.address, amountWei: amount, deadline, ...sig }), via: 'wallet', label: `Add ${proveFmt(amount, 4)} PROVE to your prover credit` });
  tell(html`Depositing… ${txLink(h2)}`);
  await waitTx(h2);
  SP.landed = null;
  return amount;
}
const toWalletBtn = () => (evm.available() ? html` <button class="link" type="button" data-paywallet>Pay from your wallet</button>` : html``);
const lowEth = () => (payer() === 'tacit' ? html`More than this key’s address holds.${toWalletBtn()} <button class="link" type="button" data-fund>Add ETH</button>` : 'More than your wallet holds.');
function noEthYet(el, wei, chain, then) {
  if (!el?.isConnected || wei !== 0n || payer() !== 'tacit') return;
  const has = evm.available();
  mount(el, html`<div class="callout"><span>${has ? 'This key’s address' : 'Your Ethereum address for Tacit'}, <code class="addr">${viewAddr(S.acct?.address || '', 6)}</code>, has no ETH${chain ? ` on ${chain}` : ''} yet. ${has ? html`Pay from your wallet instead, or send ETH to it, then ${then} here.` : `Send some to it from any wallet or exchange, then ${then} here.`}</span>${has ? html`<button class="btn" type="button" data-paywallet>Pay from wallet</button>` : html`<button class="btn ghost" type="button" data-fund>Add ETH</button>`}</div>`);
}
const gate = (text, label, id, alt = '') => html`<div class="gate"><p>${text}</p><button class="btn" type="button" id="${id}">${label}</button>${alt ? html`<p class="alt">${alt}</p>` : ''}</div>`;
function wireConnect(id, after) {
  const b = document.getElementById(id);
  if (b) b.onclick = () => busy(b, async () => { try { await connect(); after?.(); } catch (e) { toast(errText(e), true); } });
}
const tethComing = () => pendingFor('eth').length > 0 || listed().some((x) => !ended(x) && /^(Shield [\d.,]+ ETH|Wrap [\d.,]+ ETH into tETH)$/.test(x.label || ''));
const COMING_TETH = 'Your tETH is on its way: the relay settles it, usually within a few minutes.';
let comingT = 0;
function comingPoll(sheet) {
  if (comingT) return;
  comingT = setTimeout(() => { comingT = 0; if (!$(`#sheet-${sheet}`)?.open || !tethComing()) return; scanIfNew().then(() => rerender(sheet), () => {}).finally(() => comingPoll(sheet)); }, 15e3);
}
render.eth = () => {
  const tk = TAB.eth === 'dev' && DEV.tok, h = $('#eth-h'), ic = $$('#sheet-eth .sheet-head .pair use');
  if (h) h.textContent = tk ? `Private ${tk.sym}` : 'Private ETH';
  if (ic.length === 2) { ic[0].setAttribute('href', tk ? `#${tk.icon}` : '#tk-eth'); ic[1].parentNode.style.display = tk ? 'none' : ''; }
  $('#eth-v1').hidden = TAB.eth !== 'v1';
  $('#eth-dev').hidden = TAB.eth !== 'dev';
  if (TAB.eth === 'v1') renderV1($('#eth-v1')); else renderDevice($('#eth-dev'));
};
async function settleLocks(run, kind, status) {
  const t = await getUx(), priv = walletPriv(), tried = new Set(), mine = lockList(kind), sid = status.id;
  if (!mine.length) return { ok: 0, offered: false };
  run.take(...mine.map(kLock));
  const verb = kind === 'claim' ? 'Claim' : 'Take back';
  run.go({ label: mine.length > 1 ? `${kind === 'claim' ? 'Claiming' : 'Taking back'} ${mine.length} payments` : `${kind === 'claim' ? 'Claiming' : 'Taking back'} a payment`, one: false, status: () => $('#' + sid) });
  let ok = 0, err = null, offered = false;
  for (;;) {
    if (run.switched()) { const e = new Error('Another Tacit wallet was opened, so the rest stopped.'); if (run.away) run.fail(status, e); else err ||= e; break; }
    try { await loadLocks(true); } catch (e) { err ||= e; break; }
    const due = (kind === 'claim' ? LK.mine : LK.back).find((l) => run.keys.has(kLock(l)) && !tried.has(l.leaf));
    if (!due) break;
    tried.add(due.leaf);
    const root = kind === 'claim' ? LK.root : LK.sentRoot;
    try {
      const tk = tickerOf(t, due.asset), lpP = tk ? null : await lpPoolFor(due.asset), types = [kind === 'claim' ? 'stealthclaim' : 'stealthrefund'], self = await proveOwn(types);
      const fee = self || lpP ? 0n : BigInt(await t.quoteOpFee(tk, 'stealthclaim'));
      const says = lpP ? lpSays(lpP, due.amount) : `${fmt(BigInt(due.amount), 8, 6)} ${unitOf(t, due.asset)}`;
      if (!self && fee >= BigInt(due.amount)) throw new Error(`A ${fmt(BigInt(due.amount), 8, 8)} ${unitOf(t, due.asset)} payment is smaller than the relay fee to ${kind === 'claim' ? 'claim it' : 'take it back'}.`);
      run.say(status, `${kind === 'claim' ? 'Claiming' : 'Taking back'} ${says}${self || lpP ? '' : ', less the relay fee'}: the relay is proving it…`);
      const what = `${verb} ${says}`;
      const call = (f, o) => (kind === 'claim'
        ? t.stealthClaim({ walletPriv: priv, lockRecord: due, lockSetRoot: root, fee: f, ...o })
        : t.stealthRefund({ walletPriv: priv, lockRecord: due, refundPriv: due.refundPriv, lockSetRoot: root, fee: f, ...o }));
      await proveOr({ run, self, types, label: what, sheet: run.sheet, after: () => loadLocks(true), status: () => $('#' + sid), wait: () => run.wait(what, 15 * 60e3),
        go: (x) => call(0n, { selfSettle: x.selfSettle, waitOpts: x.waitOpts }),
        relayed: async () => {
          try { await call(fee, { waitOpts: run.wait(what, 15 * 60e3) }); }
          catch (e0) { if (!lpP && /fee below the current floor/i.test(e0?.message || '') && fee * 2n < BigInt(due.amount)) await call(fee * 2n, { waitOpts: run.wait(what, 15 * 60e3) }); else throw e0; }
        } });
      ok++;
    } catch (e) {
      if (e?.offered) { offered = true; break; }
      if (run.away) run.fail(status, e); else err ||= e;
    }
  }
  await scanPrivate(true).catch(() => {});
  if (offered) return { ok, offered };
  if (err && run.away) toast(html`${run.to.label}: one did not start: ${errText(err)}`, true, 9000);
  else if (err) throw ok ? new Error(`${ok} went through; another did not: ${errText(err)}`) : err;
  return { ok, offered };
}

function renderV1(el) {
  if (!needKey(el, V1.mode === 'swap' ? 'Swap tETH, TAC, cUSD and cBTC inside the pool. What you hold and whose swap it is stay private.'
    : 'Make your ETH private as tETH, then send it without anyone seeing how much or to whom.')) return;
  if (V1.mode === 'btc' && !xoShown(S.key.pubHex)) V1.mode = 'wrap';
  const s = P.scan, last = s || P.err ? null : lastSeen('teth');
  const bal = s ? html`${fmt(s.eth.value + P.coming, 8, 6)}` : P.coming > 0n ? html`${fmt((last ?? 0n) + P.coming, 8, 6)}` : P.err ? html`<span class="err">—</span>` : last != null ? html`<span class="stale">${fmt(last, 8, 6)}</span>` : html`<span class="sk" style="--w:8ch"></span>`;
  mount(el, html`
    <div class="bal">
      <svg class="tk md" aria-hidden="true"><use href="#tk-teth"/></svg>
      <div><div class="v num">${bal}</div><div class="u">tETH, private${s?.reading ? ' · reading older notes…' : ''}</div>${xoBtcLine(S.key.pubHex)}</div>
      <div class="side">${s?.partial ? html`<span class="err">part not read</span> <button class="link" type="button" id="v1-rescan">retry</button>` : P.err ? html`<button class="link" type="button" id="v1-rescan">retry</button>` : s ? html`<button class="link" type="button" id="v1-rescan">refresh</button>` : 'updating…'}</div>
    </div>
    ${depositCallout('eth', 'v1-finish')}
    ${LK.pub === S.key.pubHex && lockList('claim').length ? html`<div class="callout"><span>${lockLine(lockList('claim'), 'claim')}</span><button class="btn ghost" type="button" id="v1-claim">Claim</button></div>` : ''}
    ${LK.pub === S.key.pubHex && lockList('refund').length ? html`<div class="callout"><span>${lockLine(lockList('refund'), 'refund')}</span><button class="btn ghost" type="button" id="v1-back">Take back</button></div>` : ''}
    ${LK.failed?.pub === S.key.pubHex && LK.pub !== S.key.pubHex && !LK.scanning ? html`<div class="callout"><span>Could not check for payments sent to you.</span><button class="btn ghost" type="button" id="v1-locks">Try again</button></div>` : ''}
    ${segSub('v1', V1.mode, [['wrap', 'Shield'], ['send', 'Send'], ['swap', 'Swap'], ['out', 'Withdraw'], ...(xoShown(S.key.pubHex) ? [['btc', xoJournal(S.key.pubHex, XA.teth).length || brJournal(S.key.pubHex, 'tETH').some((r) => !BR_DONE.includes(r.stage) && r.stage !== 'recovered') ? html`Bitcoin<i class="dot live" aria-hidden="true"></i><span class="sr">, under way</span>` : 'Bitcoin']] : [])])}
    <div id="v1-form"></div>
    <div class="status" role="status" id="v1-status"></div>`);
  wireSub(el, 'v1', (m) => { V1.mode = m; keep($('#sheet-eth'), render.eth); });
  const re = $('#v1-rescan'); if (re) re.onclick = () => busy(re, async () => { try { await scanPrivate(true); } catch (e) { sayErr($('#v1-status'), e); } rerender('eth'); });
  wireFinish(document, 'eth', 'v1-finish', 'v1-status');
  for (const [id, kind, done] of [['v1-claim', 'claim', 'Claimed'], ['v1-back', 'refund', 'Taken back']]) {
    const b = $('#' + id);
    if (b) b.onclick = () => busy(b, async (run) => { try { const r = await settleLocks(run, kind, $('#v1-status')); if (!run.away && r?.ok && !r.offered) toast(done); rerender('eth'); } catch (e) { run.fail($('#v1-status'), e); } });
  }
  if (!s && !P.scanning && !P.err) scanPrivate().then(() => rerender('eth')).catch((e) => { sayErr($('#v1-status'), e); rerender('eth'); });
  if (LK.pub !== S.key.pubHex && !LK.scanning && !(LK.failed?.pub === S.key.pubHex && Date.now() - LK.failed.at < 60e3)) loadLocks().then(() => rerender('eth'), () => rerender('eth'));
  const rl = $('#v1-locks'); if (rl) rl.onclick = () => busy(rl, async () => { await loadLocks(true).catch(() => {}); rerender('eth'); });
  ({ wrap: v1Wrap, send: v1Send, swap: v1Swap, out: v1Out, btc: v1Btc })[V1.mode]($('#v1-form'), $('#v1-status'));
}
function pointsRow(wei, kind, chain) {
  readOutlook();
  const v1 = kind === 'v1', dev = Object.values(OUT.dev);
  const known = v1 ? !!OUT.v1 : dev.length === DEVICE_CHAINS.length, n = v1 ? OUT.v1?.deposits ?? 0 : dev.reduce((a, x) => a + x.deposits, 0);
  const early = known ? 1 + (PGM.early.max - 1) / (1 + n / PGM.early.half) : 1, tier = holderTier(S.address), hold = tier.held;
  const why = [known ? `${early.toFixed(1)}× early` : '', v1 ? `${PGM.wrapBoost}× tETH` : '', hold > 1 ? `${hold}× TAC holder` : '', tier.now > hold ? `${tier.now}× once your TAC is held a day` : ''].filter(Boolean).join(' · ');
  const pts = Math.round((Number(wei) / 1e18) * (v1 ? PGM.rates.wrap ?? ethBase() * PGM.wrapBoost : ethBase()) * early * hold).toLocaleString('en-US');
  return html`<div class="kv" data-pts><span class="pts-line"><svg class="tk" aria-hidden="true"><use href="#tk-tac"/></svg>TAC points <button class="link" type="button" data-ptsinfo aria-expanded="${ctx.PTSINFO}">how?</button></span><b class="num">${known ? '≈ ' : 'at least '}${pts}${why ? html` <small class="mute">${why}</small>` : ''}</b></div>
    <p class="note mute" data-ptsnote ${ctx.PTSINFO ? '' : 'hidden'}>${ptsWhy(!v1)}</p>`;
}
function v1Wrap(el, status) {
  mount(el, html`
    <div id="w-fund"></div>
    <div class="lbl"><span>Amount</span><button type="button" id="w-max">${payName()} <span id="w-bal"><span class="sk" style="--w:5ch"></span></span> ETH</button></div>
    <div class="amt"><input id="w-amt" inputmode="decimal" placeholder="0.00" autocomplete="off" aria-label="ETH to wrap"><span class="u"><svg class="tk sm" aria-hidden="true"><use href="#tk-eth"/></svg>ETH</span></div>
    <div class="rcpt" id="w-rcpt" aria-live="polite" hidden></div>
    <button class="btn" type="button" id="w-go" disabled>Shield ETH</button>
    <p class="note">${ownNow(['wrap']) ? html`One transaction from ${your()} once it is proved ${devOn() ? 'on this computer' : 'with your own credit'}, so nothing waits in the pool meanwhile and there is no relay tip.` : html`One transaction from ${your()}. A small fee in it pays Tacit’s relay to do the privacy work.`}</p>
    <p class="note mute" data-pool="v1">${poolLine('v1')}</p>`);
  const input = $('#w-amt'), go = $('#w-go'), rc = $('#w-rcpt');
  let bal = null, q = null, seq = 0;
  ethBalance().then((b) => { bal = b; const e = $('#w-bal'); if (e) e.textContent = b == null ? '—' : fmt(b, 18, 4); if (b != null) $('#w-max')?.setAttribute('aria-label', `${payName()} ${fmt(b, 18, 4)} ETH, use the most`); noEthYet($('#w-fund'), b, '', 'make it private'); if (b != null && input.isConnected && hxLive('wrap')?.all) { HX.draft = null; $('#w-max').click(); } });
  hxWarmWrap();
  $('#w-max').onclick = async () => {
    if (bal == null) return;
    const keep = await ethKeep(ownNow(['wrap'])), v = await wrapMax(bal, keep);
    input.value = v ? plain(v, 18) : ''; input.dispatchEvent(new Event('input'));
    if (!v) { mount(rc, html``); warn(rc, `${payName()} holds ${fmt(bal, 18, 4)} ETH: the network fee and the relay’s tip need about ${fmt(keep, 18, 4)} ETH on top of what you make private.`); }
  };
  const readTip = readWrapTip;
  onEdit([input], go, async (e) => {
    const my = ++seq;
    const wei = parseUnits(input.value);
    q = null; go.disabled = true; if (e?.isTrusted) say(status, '');
    if (tooFine(rc, input.value, wei, 8)) return;
    if (!wei) { rc.hidden = true; return; }
    if (wei % E10 !== 0n) { mount(rc, html``); warn(rc, 'Up to 8 decimals.'); return; }
    try {
      const { j, own, tip, to } = await readTip(wei);
      if (my !== seq || !input.isConnected) return;
      q = { wei, tip, to, at: Date.now() };
      const ready = S.key ? (await vouchers()).pick(S.key.pubHex, 'cETH', wei) : null;
      if (my !== seq || !input.isConnected) return;
      clearTimeout(VOUCH.typing);
      if (!own && !ready && S.key) getUx().then((t) => t.relay.hold()).catch(() => {});
      const still = () => input.isConnected && parseUnits(input.value) === wei;
      if (!own && !ready && S.key) VOUCH.typing = setTimeout(async () => { if (still() && !(await poolMaking(S.key.pubHex, 'cETH', wei)) && (await relayProving())) proveAhead('cETH', wei, { relay: true })?.then(async () => { if (still() && go.getAttribute('aria-busy') !== 'true' && (await vouchers()).pick(S.key.pubHex, 'cETH', wei)) input.dispatchEvent(new Event('input')); }, () => {}); }, 1500);
      mount(rc, html`
        <div class="kv"><span>You get</span><b>${fmt(wei, 18, 8)} tETH</b></div>
        <div class="kv"><span>Proof fee</span><b>${own ? `none: ${devOn() ? 'proved on this computer' : 'you prove it with your own credit'}` : `${fmt(tip, 18, 6)} ETH`}</b></div>
        ${ready ? html`<div class="kv"><span>Proof</span><b>ready now${own ? ', made here earlier' : ''}${ready.length > 1 ? ` (${ready.length} wraps, one confirmation where your wallet batches)` : ''}</b></div>` : ''}
        <div class="kv"><span>${payName()} sends</span><b>${fmt(wei + tip, 18, 6)} ETH</b></div>
        ${pointsRow(wei, 'v1')}`);
      rc.hidden = false;
      const over = bal != null && wei + tip > bal;
      go.disabled = over;
      if (over) warn(rc, lowEth());
      const floor = BigInt(j.gasAwareFloorUnits || j.staticFloorUnits || 0) * E10;
      if (!over && floor && wei < 3n * floor) rc.insertAdjacentHTML('beforeend', html`<p class="note">Sending or unwrapping a note this small later costs about ${fmt(floor, 18, 6)} ETH in relay fees.</p>`.s);
    } catch (e) { if (my === seq) quoteErr(rc, e); }
  });
  takeDraft('wrap', input, (d) => !d.all);
  go.onclick = () => busy(go, async (run) => {
    if (!q) return;
    await wrapNow({ run, x: q, status, line: () => $('#v1-status') || status, anchor: go, sheet: 'eth', clear: () => { clearField(input); input.dispatchEvent(new Event('input')); },
      moved: () => { q = null; input.dispatchEvent(new Event('input')); }, after: () => rerender('eth') });
  });
}
function v1Send(el, status) {
  const held = spendable('eth');
  mount(el, html`
    <div class="lbl"><span>To</span></div>
    <div class="amt text"><input id="s-to" placeholder="tacit1… or name.wei" autocomplete="off" spellcheck="false" autocapitalize="off" autocorrect="off" aria-label="Recipient"></div>
    <div class="lbl"><span>Amount</span><button type="button" id="s-max"${maxAria(`Private ${fmt(spendable('eth'), 8, 6)} tETH, use all`)}>${heldLabel('eth', 8, 6, 'tETH')}</button></div>
    <div class="amt"><input id="s-amt" inputmode="decimal" placeholder="0.00" autocomplete="off" aria-label="tETH to send"><span class="u"><svg class="tk sm" aria-hidden="true"><use href="#tk-teth"/></svg>tETH</span></div>
    <div class="rcpt" id="s-rcpt" aria-live="polite" hidden></div>
    <button class="btn" type="button" id="s-go" disabled>Send privately</button>
    <p class="note">The recipient claims it in their Tacit wallet; the claim’s relay fee comes out of the payment. If nobody claims it within 90 days, you can take it back.</p>`);
  const to = $('#s-to'), amt = $('#s-amt'), go = $('#s-go'), rc = $('#s-rcpt');
  let who = null, seq = 0;
  $('#s-max').onclick = async () => { const v = await maxNotes('eth'); amt.value = v ? plain(v, 8) : ''; amt.dispatchEvent(new Event('input')); };
  const check = async (e) => {
    const my = ++seq;
    const units = parseUnits(amt.value, 8);
    go.disabled = true; who = null; if (e?.isTrusted) say(status, '');
    const raw = to.value.trim();
    if (tooFine(rc, amt.value, units, 8)) return;
    if (!raw) { rc.hidden = true; return; }
    try {
      const exact = freeNotes(P.scan?.eth.notes).some((n) => BigInt(n.value) === units);
      const feesP = getUx().then((t) => Promise.all([units && !exact && !ownNow(['transfer', 'stealthlock']) ? t.quoteOpFee('cETH', 'transfer').then(BigInt) : 0n, t.quoteOpFee('cETH', 'stealthclaim').then(BigInt)]));
      feesP.catch(() => {});
      const r = await resolveToM(raw);
      if (my !== seq || !amt.isConnected) return;
      if (String(r.pubHex).replace(/^0x/, '').toLowerCase() === S.key.pubHex) throw new Error('That is your own Tacit address.');
      const [split, claim] = await feesP;
      if (my !== seq || !amt.isConnected) return;
      who = r;
      if (split && units + split <= held) cutAhead('eth', units, split);
      else if (!split && units) lockAhead('eth', units, r);
      mount(rc, html`
        ${r.name ? html`<div class="kv"><span>${r.name}</span><b>${viewAddr(r.address || '', 10)}</b></div>` : html`<div class="kv"><span>Recipient</span><b>${viewAddr(raw, 10)}</b></div>`}${idRow(r.address || raw)}
        ${split && units + split <= held ? html`<div class="kv"><span>Relay fee to ${freeNotes(P.scan?.eth.notes).some((n) => BigInt(n.value) >= units + split) ? 'split a note' : 'combine notes'}</span><b>${fmt(split, 8, 8)} tETH</b></div>` : ''}
        ${units ? html`<div class="kv"><span>They get about</span><b>${fmt(units > claim ? units - claim : 0n, 8, 8)} tETH</b></div>` : ''}`);
      rc.hidden = false;
      const small = units && units <= claim * 2n;
      go.disabled = !units || units + split > held || small;
      if (units && units + split > held) warn(rc, feeRoom(units, split, held, P.scan?.eth.notes, (v) => `${fmt(v, 8, 6)} tETH`) || overBalance());
      else if (small) warn(rc, `Send more than ${fmt(claim * 2n, 8, 6)} tETH: the recipient’s claim costs a relay fee of about ${fmt(claim, 8, 6)}.`);
    } catch (e) { if (my === seq) quoteErr(rc, e); }
  };
  onEdit([to, amt], go, check);
  const dr = hxLive('send'); if (dr) { to.value = dr.to || ''; amt.value = dr.amt || ''; HX.draft = null; if (to.value || amt.value) check({}); }
  go.onclick = () => busy(go, async (run) => {
    const w = who, units = parseUnits(amt.value, 8), raw = to.value.trim();
    if (!w || !units) return;
    try {
      await stealthSendNow({ run, k: 'eth', label: `Send ${fmt(units, 8, 6)} tETH privately to ${w.name || short(raw, 8)}`, w, raw, units, field: to, status, line: () => $('#v1-status'), sheet: 'eth',
        clear: () => { clearField(to); clearField(amt); }, after: () => rerender('eth') });
    } catch (e) { run.fail(status, e); }
  });
}
const SW = { from: 'eth', to: 'tac' };
const swapStops = (from, to) => (from === 'eth' || to === 'eth' ? [to] : ['eth', to]);
const twoDigits = (v) => { if (v <= 0n) return 0n; const d = BigInt(String(v).length); if (d <= 2n) return v; const m = 10n ** (d - 2n); return ((v + m - 1n) / m) * m; };
async function swapFee(t, from, to) {
  const f = BigInt(await t.quoteOpFee(POOL_TK[from], 'route'));
  return swapStops(from, to).length > 1 ? twoDigits((f * 14n) / 10n) : f;
}
async function swapPlan(t, from, to, units, fee, id = (k) => P.scan[k].id) {
  let cur = id(from), amt = units - fee, mid = Number(amt);
  const path = [];
  for (const k of swapStops(from, to)) {
    const next = id(k);
    const tiers = await Promise.all([30, 5, 100, 1].map((feeBps) => t.quoteRoute({ asset0: cur, amountIn: amt, path: [{ assetNext: next, feeBps }] }).then((r) => r && r.amountOut > 0n ? { feeBps, out: r.amountOut, hop: r.hops[0] } : null, () => null)));
    const best = tiers.filter(Boolean).sort((x, y) => (x.out < y.out ? 1 : x.out > y.out ? -1 : 0))[0];
    if (!best) return null;
    const lo = BigInt(cur) <= BigInt(next);
    mid = (mid * Number(lo ? best.hop.reserveBPre : best.hop.reserveAPre)) / Number(lo ? best.hop.reserveAPre : best.hop.reserveBPre) * (1 - best.feeBps / 1e4);
    path.push({ assetNext: next, feeBps: best.feeBps });
    cur = next; amt = best.out;
  }
  return { path, amountOut: amt, impact: mid > 0 ? Math.max(0, (1 - Number(amt) / mid) * 100) : 0 };
}
function v1Swap(el, status) {
  if (SW.to === SW.from) SW.to = SW.from === 'eth' ? 'tac' : 'eth';
  const from = SW.from, to = SW.to, [, unit, icon, dp] = swapAsset(from), [, unitTo, iconTo, dpTo] = swapAsset(to), held = spendable(from);
  const again = () => keep($('#sheet-eth'), render.eth);
  const chip = ([k, u, ic]) => [k, html`<svg class="tk" aria-hidden="true"><use href="#tk-${ic}"/></svg>${u}`];
  mount(el, html`
    <div class="swp">
      <div class="lbl"><span>You pay</span><button type="button" id="sw-max">${heldLabel(from, 8, dp, unit)}</button></div>
      ${segSub('swf', from, SWAP_ASSETS.map(chip))}
      <div class="amt"><input id="sw-amt" inputmode="decimal" placeholder="0.00" autocomplete="off" aria-label="${unit} to swap"><span class="u"><svg class="tk sm" aria-hidden="true"><use href="#tk-${icon}"/></svg>${unit}</span></div>
      ${P.scan && !held && from === 'eth' && tethComing() ? (comingPoll('eth'), html`<div class="callout" data-coming><span>${COMING_TETH} The swap is ready once it lands.</span></div>`) : P.scan && !held ? html`<p class="note">No private ${unit} yet. ${from === 'eth' ? html`<button type="button" class="link" id="sw-first">Shield ETH first</button>` : html`<button type="button" class="link" id="sw-first">Pay with tETH</button>`}</p>` : ''}
      <button type="button" class="flip" id="sw-flip" aria-label="Pay with ${unitTo} instead"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3v17m0 0-4-4m4 4 4-4M16 21V4m0 0-4 4m4-4 4 4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
      <div class="lbl"><span>You get</span><span>${heldLabel(to, 8, dpTo, unitTo)}</span></div>
      ${segSub('swt', to, SWAP_ASSETS.filter(([k]) => k !== from).map(chip))}
      <div class="amt out" id="sw-out"><output id="sw-outv" class="ph" for="sw-amt">0.00</output><span class="u"><svg class="tk sm" aria-hidden="true"><use href="#tk-${iconTo}"/></svg>${unitTo}</span></div>
    </div>
    <div class="rcpt" id="sw-rcpt" hidden></div>
    <div id="sw-ack"></div>
    <button class="btn" type="button" id="sw-go" disabled>Swap privately</button>
    <p class="note">What you hold stays private. The swap itself is public: it moves the pool’s balances by its size, though nothing says whose it is.</p>`);
  const amt = $('#sw-amt'), go = $('#sw-go'), rc = $('#sw-rcpt'), ackBox = $('#sw-ack');
  wireSub(el, 'swf', (k) => { SW.from = k; clearField(amt); again(); });
  wireSub(el, 'swt', (k) => { SW.to = k; again(); });
  $('#sw-flip').onclick = () => { if (running('eth')) return; [SW.from, SW.to] = [to, from]; clearField(amt); again(); syncLink(); };
  const first = $('#sw-first');
  if (first) first.onclick = () => { if (from === 'eth') $('#sheet-eth [data-v1="wrap"]')?.click(); else { SW.from = 'eth'; if (SW.to === 'eth') SW.to = from; clearField(amt); again(); } };
  const outV = $('#sw-outv'), setOut = (v) => { outV.textContent = v == null ? '0.00' : v === '' ? '…' : fmt(v, 8, dpTo); outV.classList.toggle('ph', v == null || v === ''); };
  let q = null, seq = 0;
  const show = (v, d = dp, u = unit) => `${fmt(v, 8, d)} ${u}`;
  const gateOk = () => { go.disabled = !q || !lossOk(ackBox, q.impact); };
  $('#sw-max').onclick = async () => { const v = await maxNotes(from); amt.value = v ? plain(v, 8) : ''; amt.dispatchEvent(new Event('input')); };
  const check = async (e) => {
    const my = ++seq;
    const units = parseUnits(amt.value, 8);
    q = null; go.disabled = true; if (e?.isTrusted) say(status, ''); mount(ackBox, html``); setOut(null);
    if (tooFine(rc, amt.value, units, 8)) return;
    if (!units) { rc.hidden = true; return; }
    if (!P.scan) { quoteErr(rc, new Error(overBalance())); return; }
    setOut('');
    try {
      const t = await getUx();
      const exact = freeNotes(P.scan[from].notes).some((n) => BigInt(n.value) >= units), own = ownNow(['route', 'transfer']);
      const [fee, split] = own ? [0n, 0n] : await Promise.all([swapFee(t, from, to), exact ? 0n : t.quoteOpFee(POOL_TK[from], 'transfer').then(BigInt)]);
      if (my !== seq || !amt.isConnected) return;
      mount(rc, html``);
      if (units + split > held) { setOut(null); warn(rc, feeRoom(units, split, held, P.scan[from].notes, (v) => show(v), dp) || overBalance()); return; }
      if (units <= fee * 2n) { setOut(null); warn(rc, `Swap more than ${show(fee * 2n)}: the relay fee is ${show(fee, 8)} for this swap.`); return; }
      const plan = await swapPlan(t, from, to, units, fee);
      if (my !== seq || !amt.isConnected) return;
      if (!plan) throw new Error('There is no pool to swap these in yet.');
      const minOut = (plan.amountOut * 99n) / 100n;
      q = { from, to, units, fee, split, ...plan, minOut, at: Date.now() };
      setOut(plan.amountOut);
      mount(rc, html`
        <div class="kv"><span>Price</span><b>1 ${unit} ≈ ${sig(Number(plan.amountOut) / Number(units - fee))} ${unitTo}</b></div>
        ${lossLine(plan.impact)}
        <div class="kv"><span>At least</span><b>${show(minOut, dpTo, unitTo)}</b></div>
        <div class="kv"><span>Relay fee</span><b>${own ? noRelayFee() : show(fee, 8)}</b></div>
        ${split ? html`<div class="kv"><span>Relay fee to ${freeNotes(P.scan[from].notes).some((n) => BigInt(n.value) >= units + split) ? 'split a note' : 'combine notes'}</span><b>${show(split, 8)}</b></div>` : ''}
        ${swapStops(from, to).length > 1 ? html`<div class="kv"><span>Through</span><b>tETH, two pools in one settle</b></div>` : ''}`);
      rc.hidden = false;
      mount(ackBox, lossGate('sw-ackv', plan.impact, 'swap'));
      wireAck(ackBox, 'sw-ackv', plan.impact, gateOk);
      if (fee * 20n >= units) warn(rc, `The relay fee is ${pctFmt(Number((fee * 1000n) / units) / 10)} of this swap: a larger swap spreads it.`);
      else if (plan.impact >= 5) warn(rc, 'This pool is thin: smaller amounts move the price less.');
      gateOk();
    } catch (x) { if (my === seq) { setOut(null); quoteErr(rc, x); } }
  };
  onEdit([amt], go, check);
  const dr = hxLive('swap'); if (dr) { amt.value = dr.amt || ''; HX.draft = null; if (amt.value) check({}); }
  go.onclick = () => busy(go, async (run) => {
    const x = q;
    if (!x || !lossOk(ackBox, x.impact)) return;
    if (Date.now() - x.at > 60e3) { say(status, 'The price had gone stale. It is being read again; check it and press once more.'); check({}); return; }
    const label = `Swap ${show(x.units)} for ${unitTo}`;
    run.go({ label, status: () => $('#v1-status'), clear: () => clearField(amt) });
    try {
      const t = await getUx(), priv = walletPriv();
      const note = await noteFor(run, t, priv, x.units, (n) => BigInt(n.value) >= x.units, status, x.from);
      const now = await swapPlan(t, x.from, x.to, x.units, x.fee);
      if (!now || now.amountOut < x.minOut) throw new Error('The price moved while your note was made. Your note is ready: check the new price and press again.');
      run.say(status, 'The relay is proving your swap…');
      const args = { inNote: note, amountIn: x.units, path: now.path, minOut: x.minOut };
      await proveOr({ run, types: ['route'], label, sheet: 'eth', status: () => $('#v1-status'),
        go: (y) => y.t.route({ walletPriv: y.priv, ...args, fee: 0n, selfSettle: y.selfSettle, waitOpts: y.waitOpts }),
        relayed: async () => {
          try { await t.route({ walletPriv: priv, ...args, fee: x.fee, waitOpts: run.wait(null, 15 * 60e3) }); }
          catch (e0) {
            if (!/fee below the current floor/i.test(e0?.message || '')) throw e0;
            const fee2 = await swapFee(t, x.from, x.to), again = fee2 < x.units ? await swapPlan(t, x.from, x.to, x.units, fee2) : null;
            if (!again || again.amountOut < x.minOut) throw e0;
            await t.route({ walletPriv: priv, ...args, path: again.path, fee: fee2, waitOpts: run.wait(null, 15 * 60e3) });
          }
        } });
      await scanPrivate(true).catch(() => {});
      rerender('eth');
    } catch (e) { run.fail(status, e); }
  });
}
function v1Out(el, status) {
  const held = spendable('eth');
  mount(el, html`
    <div class="lbl"><span>To</span><span><button type="button" id="o-dev">On this device</button> · <button type="button" id="o-me">${mine()}</button></span></div>
    <div class="amt text"><input id="o-to" placeholder="0x… (a fresh address keeps it unlinked)" autocomplete="off" spellcheck="false" autocapitalize="off" autocorrect="off" aria-label="Recipient address"></div>
    <div class="lbl"><span>Amount</span><button type="button" id="o-max"${maxAria(`Private ${fmt(spendable('eth'), 8, 6)} tETH, use all`)}>${heldLabel('eth', 8, 6, 'tETH')}</button></div>
    <div class="amt"><input id="o-amt" inputmode="decimal" placeholder="0.00" autocomplete="off" aria-label="tETH to withdraw"><span class="u"><svg class="tk sm" aria-hidden="true"><use href="#tk-teth"/></svg>tETH</span></div>
    <div class="rcpt" id="o-rcpt" aria-live="polite" hidden></div>
    <button class="btn" type="button" id="o-go" disabled>Withdraw ETH</button>`);
  const to = $('#o-to'), amt = $('#o-amt'), go = $('#o-go'), rc = $('#o-rcpt');
  let q = null, seq = 0;
  $('#o-me').onclick = () => busy($('#o-me'), async () => { try { to.value = await payingAccount(); to.dispatchEvent(new Event('input')); } catch (e) { sayErr(status, e); } });
  const boxNow = () => (OBOX.pub === S.key?.pubHex ? OBOX.box : null);
  $('#o-dev').onclick = () => busy($('#o-dev'), async () => {
    try {
      const w = await devWalletOn(1); w.watchReceive().catch(() => {});
      const quoted = await w.quote().catch(() => null);
      Object.assign(OBOX, { pub: S.key.pubHex, box: w.receiveBox, min: quoted && /^\d+$/.test(String(quoted.receiveMin)) ? BigInt(quoted.receiveMin) : null });
      to.value = w.receiveBox; to.dispatchEvent(new Event('input'));
    } catch (e) { sayErr(status, e); }
  });
  $('#o-max').onclick = async () => { const v = await maxNotes('eth'); amt.value = v ? plain(v, 8) : ''; amt.dispatchEvent(new Event('input')); };
  const check = async (e) => {
    const my = ++seq;
    const units = parseUnits(amt.value, 8);
    q = null; go.disabled = true; if (e?.isTrusted) say(status, '');
    if (tooFine(rc, amt.value, units, 8)) return;
    if (!units) { rc.hidden = true; return; }
    try {
      const t = await getUx();
      const own = ownNow(['sendunwrap', 'unwrap']), minFee = own ? 0n : await t.quoteOpFee('cETH', exitKind('eth', units));
      const fee = own ? 0n : t.quoteUnwrapFee(units, 'cETH', { minFee }).fee;
      const size = own || freeNotes(P.scan?.eth.notes).some((n) => BigInt(n.value) >= units) ? 0n : BigInt(await t.quoteOpFee('cETH', 'transfer'));
      if (my !== seq || !amt.isConnected) return;
      const raw = to.value.trim();
      let bad = null;
      try { if (raw) recipientOf(raw); } catch (x) { bad = x; }
      q = { units, fee, minFee, own };
      const box = boxNow(), dev = box && raw.toLowerCase() === box.toLowerCase();
      mount(rc, html`<div class="kv"><span>Relay fee</span><b>${own ? noRelayFee() : `${fmt(fee, 8, 8)} ETH`}</b></div>${size && units + size <= held ? html`<div class="kv"><span>Relay fee to ${freeNotes(P.scan?.eth.notes).some((n) => BigInt(n.value) >= units + size) ? 'split a note' : 'combine notes'}</span><b>${fmt(size, 8, 8)} ETH</b></div>` : ''}<div class="kv"><span>Arrives</span><b>${fmt(units - fee > 0n ? units - fee : 0n, 8, 8)} ETH</b></div>
        ${dev ? html`<div class="kv"><span>Lands in</span><b>private ETH on this device, on Ethereum, less at most 0.25%</b></div>${(() => { const min = OBOX.min ?? (DEV.chain?.chainId === 1 && DEV.quote?.receiveMin ? BigInt(DEV.quote.receiveMin) : null); return min == null ? html`<p class="note">Below the relay’s floor, which moves with network fees, it waits at your deposit address on Ethereum until you sweep it in from Receive.</p>` : (own ? units : units - fee) * E10 >= min ? '' : html`<p class="note">What arrives is below the relay’s floor of ${fmt(min, 18, 4)} ETH, so it waits at your deposit address on Ethereum until you sweep it in from Receive.</p>`; })()}` : ''}`);
      rc.hidden = false;
      go.disabled = units + size > held || units <= fee || !raw || !!bad;
      if (units + size > held) warn(rc, feeRoom(units, size, held, P.scan?.eth.notes, (v) => `${fmt(v, 8, 6)} tETH`) || overBalance());
      else if (units <= fee) warn(rc, `Withdraw more than ${fmt(fee, 8, 6)} tETH: the relay fee comes out of it.`);
      else if (bad && !/^0(x[0-9a-fA-F]{0,39})?$/.test(raw)) warn(rc, bad.message);
      else if (!raw) rc.insertAdjacentHTML('beforeend', html`<p class="note">Enter the address to send it to.</p>`.s);
      else if (bad) rc.insertAdjacentHTML('beforeend', html`<p class="note">An address is 0x and 40 letters or digits.</p>`.s);
      else if (!bad && !dev && ownAccount(raw)) rc.insertAdjacentHTML('beforeend', linkNote());
      clearTimeout(EXIT_AHEAD.typing);
      if (!own && !bad && raw && !dev && !sealOn() && units + size <= held && units > fee) EXIT_AHEAD.typing = setTimeout(() => { if (q?.units === units && to.value.trim() === raw) exitAheadFor(units, raw, minFee); }, 1500);
      if (!own && !bad && raw && units + size <= held && units > fee) {
        const fit = freeNotes(P.scan?.eth.notes).map((n) => BigInt(n.value)).filter((v) => v >= units).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))[0];
        const left = fit != null ? fit - units : 0n;
        if (left > 0n && t.quoteUnwrapFee(left, 'cETH', { minFee }).fee >= left) rc.insertAdjacentHTML('beforeend', html`<p class="note">That leaves ${fmt(left, 8, 6)} tETH in your note, less than the relay fee to withdraw it later. Withdrawing the whole ${fmt(fit, 8, 6)} tETH avoids that.</p>`.s);
      }
    } catch (e) { if (my === seq) quoteErr(rc, e); }
  };
  onEdit([to, amt], go, check);
  const od = hxLive('out'); if (od?.to) to.value = od.to;
  takeDraft('out', amt);
  go.onclick = () => busy(go, async (run) => {
    if (!q) return;
    await unwrapNow({ run, x: q, raw: to.value.trim(), status, line: () => $('#v1-status'), sheet: 'eth', clear: () => clearField(amt), moved: () => amt.dispatchEvent(new Event('input')), after: () => rerender('eth') });
  });
}
function xoBtcLine(pub) {
  if (!pub || !xoShown(pub)) return '';
  const XB = xbOf(XA.teth), h = xbHeld(pub, XA.teth);
  const way = onTheWay(xoRecords(pub, XA.teth), XB.pub === pub ? XB.notes : null).reduce((t, r) => t + BigInt(r.source.amount ?? r.source.value), 0n);
  if (!(h?.v > 0n) && !(way > 0n)) return '';
  return html`<a class="xb-line" href="#private/bitcoin/back" data-link="private/bitcoin/back">${h?.v > 0n ? html`<b class="num">${fmt(h.v, 8, 6)}</b> on Bitcoin` : ''}${h?.v > 0n && way > 0n ? ' · ' : ''}${way > 0n ? html`<b class="num">${fmt(way, 8, 6)}</b> on the way` : ''}</a>`;
}
function v1Btc(el, status) { return xoOut(el, status, XA.teth); }
async function usdtWithdrawNow({ run, status, line, sheet = 'usdt', after }) {
  try {
    const t = await getUx(), priv = walletPriv(), to = await payingAccount(), dest = `${your()} (${short(to, 6)})`;
    const minFee = BigInt(await t.quoteOpFee('cUSDT', 'unwrap')), types = ['unwrap', 'sendunwrap'], self = await proveOwn(types);
    const notes = freeNotes(P.scan?.cusdt?.notes).sort(byValue).reverse();
    const worth = notes.filter((n) => self || BigInt(n.value) > t.quoteUnwrapFee(BigInt(n.value), 'cUSDT', { minFee }).fee);
    if (!worth.length) {
      const small = new Error(`Each private USDT note is worth less than the relay fee to move it (about ${fmt(minFee, 6, 2)} USDT).`);
      if (!notes[0]) throw new Error('You hold no private USDT.');
      offerSelf({ exit: true, go: exitGo(notes[0], to, notes[0].value), label: `Withdraw ${fmt(BigInt(notes[0].value), 6, 2)} USDT`, sheet, after: () => loadUsdtBal(true), status: line }, small);
      return;
    }
    run.take(...worth.map(kNote));
    const sum = worth.reduce((a, n) => a + BigInt(n.value), 0n);
    run.go({ label: `Withdrawing ${fmt(sum, 6, 2)} USDT`, one: false, dest, status: line });
    let offered = false, moved = 0;
    for (const [i, n] of worth.entries()) {
      if (run.switched()) { run.fail(status, new Error('Another Tacit wallet was opened, so the rest stopped.')); return; }
      run.say(status, `The relay is moving your USDT${worth.length > 1 ? ` (${i + 1} of ${worth.length})` : ''}…`);
      const label = `Withdraw ${fmt(BigInt(n.value), 6, 2)} USDT`;
      try {
        await proveOr({ run, self, types, exit: true, quiet: true, go: exitGo(n, to, n.value), label, sheet, after: () => loadUsdtBal(true), status: line, wait: () => run.wait(label, 15 * 60e3),
          relayed: () => t.unwrap({ note: n, walletPriv: priv, recipient: to, wait: true, waitOpts: run.wait(label, 15 * 60e3, { exit: { to, units: String(n.value), note: kNote(n), from: 'cusdt', sheet } }) }) });
        moved++;
      } catch (e) {
        if (e?.offered) { offered = true; break; }
        if (!run.away) {
          if (moved) { await Promise.allSettled([scanPrivate(true), loadUsdtBal(true)]); after(); throw Object.assign(new Error(`${moved} of ${worth.length} notes are out; the rest did not go. ${errText(e)}`), { said: true }); }
          throw e;
        }
        run.fail(status, e);
        break;
      }
    }
    if (offered) return;
    if (!run.away) { toast('Private USDT withdrawn'); say(status, html`<span class="ok">USDT in ${your()}.</span>`); }
    await Promise.allSettled([scanPrivate(true), loadUsdtBal(true)]); after();
  } catch (e) { run.fail(status, e); }
}
render.usdt = () => {
  const el = $('#usdt-body');
  if (!needKey(el, 'Keep USDT private in the Tacit pool, bridge it to Bitcoin and back, and take it out to your wallet.')) return;
  const held = spendable('cusdt'), owner = usdtOwner();
  if (owner && (US.who !== owner || (US.bal == null && !US.loading))) loadUsdtBal().then(() => rerender('usdt')).catch(() => {});
  if (!P.scan && !P.err) scanPrivate().then(() => rerender('usdt')).catch(() => {});
  mount(el, html`
    <div class="bal">
      <svg class="tk md" aria-hidden="true"><use href="#tk-usdt"/></svg>
      <div><div class="v num">${P.scan ? fmt(held, 6, 2) : P.err ? html`<span class="err">—</span>` : html`<span class="sk" style="--w:8ch"></span>`}</div><div class="u">USDT, private</div></div>
      <div class="side">${US.bal != null ? html`${fmt(US.bal, 6, 2)} in ${your()}` : ''}</div>
    </div>
    ${depositCallout('usdt', 'us-finish')}
    ${segSub('us', US.mode, [['wrap', 'Shield'], ['out', 'Withdraw'], ['btc', 'Bitcoin']])}
    <div id="us-form"></div>
    <div class="status" role="status" id="us-status"></div>`);
  wireFinish(el, 'usdt', 'us-finish', 'us-status');
  const status = $('#us-status'), f = $('#us-form');
  if (P.err && !P.scan) sayErr(status, P.err);
  wireSub(el, 'us', (m) => { US.mode = m; keep($('#sheet-usdt'), render.usdt); });
  if (US.mode === 'btc') return void xoOut(f, status, XA.cusdt);
  if (US.mode === 'out') {
    const small = BigInt(0);
    mount(f, html`
      <p class="lede-s">Take your private USDT out to ${your()}. The relay moves each note and keeps a small fee out of it; the USDT arrives as ordinary USDT.</p>
      <div class="kv"><span>Private USDT</span><b class="num">${P.scan ? fmt(held, 6, 2) : '…'}</b></div>
      <p class="note" id="us-exit"></p>
      <button class="btn" type="button" id="us-out" ${P.scan && held > small ? '' : 'disabled'}>Withdraw to ${your()}</button>`);
    if (P.scan && held > small) {
      const big = freeNotes(P.scan.cusdt.notes).sort(byValue).reverse()[0];
      getUx().then((t) => usdtExitFee(t, big.value)).then((ex) => {
        const n = $('#us-exit', f); if (!n) return;
        n.textContent = ex.net > 0n ? `The relay takes ${fmt(ex.fee, 6, 2)} USDT to move your biggest note (${fmt(BigInt(big.value), 6, 2)}) out, at today’s gas, so ${fmt(ex.net, 6, 2)} arrives.`
          : `The relay takes ${fmt(ex.floor, 6, 2)} USDT to move a note out at today’s gas, more than your biggest note holds (${fmt(BigInt(big.value), 6, 2)}). It stays private until gas is lower; Withdraw offers to send it from your own account for the network fee instead.`;
      }).catch(() => {});
    }
    $('#us-out', f).onclick = (e) => busy(e.currentTarget, (run) => usdtWithdrawNow({ run, status, line: () => $('#us-status'), after: () => rerender('usdt') }));
    return;
  }
  const bal = US.bal, from = your();
  mount(f, html`
    <div class="lbl"><span>Shield USDT</span><button type="button" id="us-max">USDT in ${from} ${bal != null ? fmt(bal, 6, 2) : '…'}</button></div>
    <div class="amt"><input id="us-amt" inputmode="decimal" placeholder="0.00" autocomplete="off" aria-label="USDT to make private"><span class="u"><svg class="tk sm" aria-hidden="true"><use href="#tk-usdt"/></svg>USDT</span></div>
    <div class="rcpt" id="us-rcpt" hidden></div>
    <button class="btn" type="button" id="us-go" disabled>Shield</button>
    <p class="note">From ${from}, through Permit2: you approve exactly this amount and sign once. ${ownNow(['wrap']) ? `It is proved ${devOn() ? 'on this computer' : 'with your own credit'} first, so nothing waits in the pool.` : 'Tacit’s relay does the privacy work after.'} Private USDT can then be sent, swapped, bridged to Bitcoin or withdrawn.</p>`);
  const amt = $('#us-amt', f), go = $('#us-go', f), rc = $('#us-rcpt', f);
  let q = null;
  $('#us-max', f).onclick = () => { if (bal) { amt.value = plain(bal, 6); amt.dispatchEvent(new Event('input')); } };
  onEdit([amt], go, (e) => {
    const units = parseUnits(amt.value, 6);
    q = null; go.disabled = true; if (e?.isTrusted) say(status, '');
    if (tooFine(rc, amt.value, units, 6)) { rc.hidden = false; return; }
    if (!units) { rc.hidden = true; return; }
    q = { units };
    mount(rc, html`<div class="kv"><span>You get</span><b>${fmt(units, 6, 6)} USDT, private</b></div>`);
    rc.hidden = false;
    if (S.key) vouchers().then((v) => { if (q?.units === units && v.pick(S.key.pubHex, 'cUSDT', units)?.length === 1) rc.insertAdjacentHTML('beforeend', html`<div class="kv"><span>Proof</span><b>ready now</b></div>`.s); }).catch(() => {});
    const over = bal != null && units > bal;
    go.disabled = over || bal == null;
    if (over) warn(rc, `More than the ${fmt(bal, 6, 4)} USDT in ${from}.`);
  });
  takeDraft('xus', amt);
  go.onclick = () => busy(go, async (run) => {
    if (!q) return;
    await usdtWrapNow({ run, units: q.units, src: payer(), status, line: () => $('#us-status'), clear: () => { clearField(amt); amt.dispatchEvent(new Event('input')); }, after: () => rerender('usdt') });
  });
};
async function devWalletOn(chainId) {
  const m = await getDeviceMods(), c = DEVICE_CHAINS.find((x) => x.chainId === chainId);
  return m.makeEvmPoolWallet({ zk: m.zk, keys: m.evmPoolKeys(m.zk, walletPriv()), keeper: c.keeper, prove: null,
    chain: { chainId: c.chainId, pool: EVM_POOL, router: EVM_ROUTER, rpc: m.jsonRpc(c.rpc), deployBlock: c.deployBlock, confirmations: c.confirmations, logChunk: c.logChunk } });
}
async function holdingProveNow() {
  lsKv.set(HOLD_CONSENT, '1');
  HOLD.err = ''; HOLD.step = 'Reading your pool balance…'; rerender('pts');
  try { await loadHeld(true); } catch {}
  for (let i = 0; i < 900 && HOLD.running; i++) await sleep(1000);
  HOLD.step = '';
  const r = await holdingRound({ manual: true });
  const ws = Object.values(HOLD.byKey[S.key?.pubHex]?.w || {});
  if (!r && !HOLD.err && ws.length && ws.every(holdBehind)) HOLD.err = 'Your older pool history is still being read. What it holds is proved once that is done.';
  if (!r && !HOLD.err) HOLD.err = S.key ? 'Nothing to prove right now.' : 'Open your Tacit wallet to prove what it holds.';
  else if (r && !r.sent.length && !r.errors?.length && !HOLD.err) HOLD.err = 'Nothing new to prove right now.';
  rerender('pts');
}

const T_TRANSACT = '0x' + bytesToHex(keccak_256(new TextEncoder().encode('Transact(bytes32,bytes32,bytes32,bytes32,uint256,bytes32,address,int256,address,uint256,bytes,bytes)')));
const LOG_RPC = { 1: ETH_LOG_NODES, 8453: BASE_NODES };
const POOLQ = {};
function poolStats(c) {
  const key = `tacit-pay-pool-v1:${c.chainId}:${EVM_POOL.toLowerCase()}`, part = `${key}:part`, q = POOLQ[c.chainId] ||= { v: store.get(key), p: null, at: 0, failAt: 0 };
  if (q.p) return q.p;
  if (q.v && Date.now() - q.at < 60e3) return Promise.resolve(q.v);
  q.p = (async () => {
    const m = await getDeviceMods(), rpc = m.jsonRpc(LOG_RPC[c.chainId] || c.rpc), tip = Number(BigInt(await rpc('eth_blockNumber')));
    const from = [q.v, store.get(part)].filter((x) => x?.through >= c.deployBlock - 1).sort((a, b) => b.through - a.through)[0];
    const v = from ? { through: from.through, ins: from.ins.slice(), outs: from.outs.slice() } : { through: c.deployBlock - 1, ins: [], outs: [] };
    let step = 2_000_000, busyTries = 0;
    for (let a = v.through + 1; a <= tip;) {
      const b = Math.min(tip, a + step - 1);
      try {
        for (const l of await rpc('eth_getLogs', [{ address: EVM_POOL, topics: [T_TRANSACT], fromBlock: '0x' + a.toString(16), toBlock: '0x' + b.toString(16) }])) {
          const ext = BigInt.asIntN(256, wordAt(l.data, 5)), at = Number(BigInt(l.blockNumber));
          if (ext > 0n) v.ins.push([at, ext.toString()]); else if (ext < 0n) v.outs.push([at, (-ext).toString()]);
        }
        v.through = b; a = b + 1; busyTries = 0;
        store.set(part, v);
      } catch (e) {
        const f = m.logFailure(e, step);
        if (f?.step) { step = f.step; continue; }
        if (f?.busy && ++busyTries <= 6) { await sleep(1500 * busyTries); continue; }
        throw e;
      }
    }
    store.set(key, v); store.set(part, null);
    q.v = v; q.at = Date.now();
    return v;
  })().catch((e) => { q.failAt = Date.now(); throw e; }).finally(() => { q.p = null; });
  return q.p;
}
function poolWait(c) {
  const q = POOLQ[c.chainId];
  if (q?.p || Date.now() - (q?.failAt || 0) < 30e3) return;
  poolStats(c).catch(() => {}).finally(() => { const i = $('#d-amt'); if (i?.value && DEV.chain === c && !running('eth')) i.dispatchEvent(new Event('input')); });
}
const ROUND = [1n, 25n, 5n].flatMap((m) => Array.from({ length: 22 }, (_, k) => m * 10n ** BigInt(k))).sort((a, b) => (a < b ? -1 : 1));
function privacyCheck(c, amount, to, self) {
  const v = POOLQ[c.chainId]?.v, W = DEV.W && DEV.key === S.key.pubHex + c.chainId && DEV.bal != null ? DEV.W : null;
  if (Date.now() - (POOLQ[c.chainId]?.at || 0) > 60e3) poolWait(c);
  if (!v || !W) return null;
  const notes = [];
  let level = 'part';
  const fair = (t) => { notes.push(t); if (level === 'part') level = 'fair'; };
  const is = (a) => !!to && !!a && to.toLowerCase() === a.toLowerCase();
  if (is(S.wallet) || is(S.acct?.address)) { level = 'weak'; notes.push(`This is your ${is(S.wallet) ? 'connected wallet' : 'key’s own address'}: withdrawing to it links it to the pool. A fresh address keeps them apart.`); }
  const mine = [];
  for (const n of W.notes()) {
    const nv = BigInt(n.v), xs = v.ins.filter(([b, x]) => b === n.block && (BigInt(x) === nv || (n.kind === 'receive' && BigInt(x) > nv && (BigInt(x) - nv) * 400n <= BigInt(x)))).map(([, x]) => BigInt(x));
    if (xs.length || n.kind === 'receive') mine.push({ vs: [nv, ...xs], block: n.block });
  }
  const near = (x) => x === amount || (x > amount ? x - amount : amount - x) * 1000n <= amount;
  const same = mine.find((r) => r.vs.some(near));
  if (same) fair('Close to the amount that came in earlier, so the two can be paired. A different amount, or withdrawing it in parts, blends in better.');
  const odd = amount.toString().replace(/0+$/, '').length > 2, round = ROUND.filter((r) => r <= amount).pop();
  if (!same && odd && round) notes.push('Round amounts blend in with more withdrawals.');
  const last = mine.reduce((a, r) => (r.block > (a?.block ?? -1) ? r : a), null);
  if (last) {
    const since = v.ins.filter(([b]) => b > last.block).length;
    if (since < 5) fair(`${since ? `Only ${since} deposit${since === 1 ? '' : 's'} by others since yours` : 'No one else has deposited since yours'}. Waiting a day, and for a few more, makes this much harder to link.`);
  }
  const large = v.ins.filter(([, x]) => BigInt(x) >= amount).length;
  if (large < 5) {
    notes.push(`${large ? `Only ${large} deposit${large === 1 ? '' : 's'}` : 'No deposit'} on ${chainFull(c.chainId)} ${large === 1 || !large ? 'was' : 'were'} this large. Smaller parts blend in better.`);
    if (large < 2) level = 'weak'; else if (level === 'part') level = 'fair';
  }
  if (self) fair('Your wallet shows as the one sending it.');
  if (v.ins.length < 25) fair(`The pool on ${chainFull(c.chainId)} is still young: ${v.ins.length} deposit${v.ins.length === 1 ? '' : 's'} so far. Every new deposit makes yours harder to single out.`);
  const crowd = `Your ETH hides among ${W.summary().leaves} notes from ${v.ins.length} deposits in the pool on ${chainFull(c.chainId)}.`;
  return { level, notes, crowd, round: (same || odd) && round && round !== amount ? round : null };
}
function privacyView(c, amount, to, self) {
  const p = privacyCheck(c, amount, to, self);
  const full = html`<p class="note"><a href="/pay/eth/#withdraw&chain=${c.chainId}">Check how private this withdrawal is in tacit pay ↗</a> It weighs every deposit you made, and when.</p>`;
  if (!p) return html`<div class="pv"><p class="note">${POOLQ[c.chainId]?.p || !POOLQ[c.chainId]?.failAt ? 'Checking how well this blends in…' : 'The pool’s deposits could not be read.'}</p>${full}</div>`;
  const label = { part: 'Blends in by address and size', fair: 'Could blend in better', weak: 'Easy to link to you' }[p.level];
  return html`<div class="pv pv-${p.level}"><div class="pv-h"><i></i>${label}</div>
    ${p.notes.map((t) => html`<p class="note">${t}</p>`)}
    ${p.round ? html`<p class="note"><button class="link" type="button" id="pv-round" data-v="${p.round}">Withdraw ${fmt(p.round, 18, 6)} ETH instead</button></p>` : ''}
    <p class="note">${p.crowd}</p>${full}</div>`;
}
function renderDevice(el) {
  if (DEV.tok) return renderTokenPool(el);
  if (!needKey(el, html`Keep ETH private on ${chainMarks([1, 8453, 4663])}, proved in your browser.`)) return;
  const c = DEV.chain, W = DEV.W && DEV.key === S.key.pubHex + c.chainId ? DEV.W : null;
  const last = DEV.bal == null ? devBal(c.chainId, S.key.pubHex) : null;
  mount(el, html`
    ${segSub('chain', String(c.chainId), devPools())}
    <div class="bal">
      <span class="pair"><svg class="tk md" aria-hidden="true"><use href="#tk-eth"/></svg><svg class="tk md" aria-hidden="true"><use href="#tk-peth"/></svg></span>
      <div><div class="v num">${DEV.bal != null ? fmt(DEV.bal, 18, 6) : DEV.err ? html`<span class="err">—</span>` : last != null ? html`<span class="stale">${fmt(last, 18, 6)}</span>` : html`<span class="sk" style="--w:8ch"></span>`}</div><div class="u">ETH, private on ${chainTag(c.chainId)}${DEV.bal != null && DEV.behind ? ' · reading older history' : ''}</div></div>
      <div class="side">${DEV.err ? html`<button class="link" type="button" id="d-rescan">retry</button>` : DEV.bal != null ? html`<button class="link" type="button" id="d-rescan">refresh</button>` : 'updating…'}</div>
    </div>
    ${segSub('dev', DEV.mode, [['deposit', 'Deposit'], ['send', 'Send'], ['out', 'Withdraw'], ['receive', 'Receive']])}
    <div id="d-form"></div>
    <div class="status" role="status" id="d-status"></div>`);
  const syncFailed = (e) => { DEV.err = e; rerender('eth'); sayErr($('#d-status'), e); };
  wireSub(el, 'chain', pickPool);
  wireSub(el, 'dev', (m) => { DEV.mode = m; keep($('#sheet-eth'), render.eth); });
  if ((!W || DEV.bal == null) && !DEV.err) deviceSync().then(() => rerender('eth')).catch(syncFailed);
  if (!DEV.self && c?.keeper) keeperRead(c.keeper).then(() => { if (!DEV.self && keeperDown(c.keeper) && !(DEV.mode === 'out' && c.chainId === 1 && DEV.dest !== 'addr' && DEV.dest !== 'v1')) { DEV.self = true; rerender('eth'); } });
  const re = $('#d-rescan'); if (re) re.onclick = () => busy(re, async () => { try { await deviceSync(true); DEV.err = null; rerender('eth'); } catch (e) { syncFailed(e); } });
  const f = $('#d-form'), status = $('#d-status');
  f.addEventListener('input', (e) => { if (e.isTrusted && !running('eth')) say(status, ''); });
  const step = (m) => { m = String(m).replace(/relayer/gi, 'relay'); say(status, m[0].toUpperCase() + m.slice(1) + '…'); };
  const afterAction = (done) => { say(status, done); deviceSync(true).then(() => rerender('eth')).catch(() => rerender('eth')); };
  const explorer = (h) => txLink(h, c.explorer);
  const warm = () => prover(provingNote).then(() => { if (!running('eth') && /^Getting the proving key/.test(status.textContent)) say(status, ''); }).catch(() => {});
  const amountField = (id, label, extra = '') => html`
    <div class="lbl"><span>${label}</span>${extra}</div>
    <div class="amt"><input id="${id}" inputmode="decimal" placeholder="0.00" autocomplete="off" aria-label="${label}"><span class="u"><svg class="tk sm" aria-hidden="true"><use href="#tk-eth"/></svg>ETH</span></div>`;
  const walletRoute = () => DEV.self && !(DEV.mode === 'out' && c.chainId === 1 && DEV.dest !== 'addr' && DEV.dest !== 'v1');
  const destGas = () => (DEV.mode === 'out' && c.chainId === 1 && DEV.dest !== 'addr' ? (DEV.dest === 'v1' ? 700_000 : DEV.dest === '8453' ? 1_300_000 : 700_000) : null);
  const quoteNow = () => (walletRoute() ? null : destGas() ? DEV.gq[destGas()] : DEV.quote);
  const relayFeeNow = () => BigInt(quoteNow()?.fee || 0);
  const feeUnread = () => {
    if (walletRoute() || quoteNow()) return false;
    const g = destGas(), W0 = DEV.W, tag = `${c.chainId}:${g || 0}`;
    if (W0 && !(DEV.qBusy?.[tag]) && Date.now() - (DEV.qFail?.[tag] || 0) > 15e3) {
      DEV.qBusy = { ...DEV.qBusy, [tag]: true };
      W0.quote(g || undefined).then((q) => { if (DEV.W !== W0) return; if (g) DEV.gq[g] = q; else DEV.quote = q; rerender('eth'); })
        .catch(() => { DEV.qFail = { ...DEV.qFail, [tag]: Date.now() }; rerender('eth'); setTimeout(() => { if (DEV.W === W0) rerender('eth'); }, 15e3); })
        .finally(() => { if (DEV.qBusy) delete DEV.qBusy[tag]; });
    }
    return true;
  };
  const capOf = (fee) => (fee ? (fee * 5n) / 4n : null);
  const upEth = (v) => fmt(((v + 10n ** 12n - 1n) / 10n ** 12n) * 10n ** 12n, 18, 6);
  const feeMoved = async (e) => {
    const g = destGas(), q = (await DEV.W?.quote(g || undefined).catch(() => null)) || { ...quoteNow(), fee: String(e.feeMoved) };
    if (g) DEV.gq[g] = q; else DEV.quote = q;
    rerender('eth');
    say($('#d-status'), html`<span class="err">The relay fee changed to ${fmt(e.feeMoved, 18, 6)} ETH. Check it and press again.</span>`);
  };
  const selfNote = () => (DEV.self ? html`<p class="note">From ${your()}: no relay fee; it pays the network fee, and its address shows as the sender. <button class="link" type="button" id="d-relay">Use the relay</button></p>` : '');
  const wireRoute = () => $('#d-relay')?.addEventListener('click', () => { DEV.self = false; rerender('eth'); });
  const failed = (e) => {
    if (DEV.self || !keeperTrouble(e)) return sayErr(status, e);
    RETRY['d-self'] = () => { DEV.self = true; rerender('eth'); say($('#d-status'), `Press it again: ${your()} sends it, with no relay fee.`); };
    say(status, html`<span class="err">${errText(e)}</span> <button class="link" type="button" data-retry="d-self">Send it from ${your()} instead</button>`);
  };
  const feeNote = () => {
    const g = destGas();
    if (!DEV.qFail?.[`${c.chainId}:${g || 0}`]) return html`<p class="note">Reading the relay fee…</p>`;
    const canSelf = !(DEV.mode === 'out' && c.chainId === 1 && DEV.dest !== 'addr' && DEV.dest !== 'v1');
    if (canSelf) RETRY['d-self'] = () => { DEV.self = true; rerender('eth'); };
    return html`<p class="note err">The relay’s fee could not be read; trying again.${canSelf ? html` <button class="link" type="button" data-retry="d-self">Send it from ${your()} instead</button>` : ''}</p>`;
  };
  if (W && !DEV.plan && DEV.mode === 'out') getDeviceMods().then((m) => { DEV.plan = m.mergePlan; rerender('eth'); }).catch(() => {});
  const merges = (amount, fee) => (W && DEV.plan ? DEV.plan(W.notes().map((n) => n.v), amount + fee, fee) : DEV.bal != null && amount + fee <= DEV.bal ? 0 : null);
  const combineRow = (m, fee) => (m && fee ? html`<div class="kv"><span>Relay fee to combine notes${m > 1 ? ` (${m}×)` : ''}</span><b>at most ${upEth(capOf(fee) * BigInt(m))} ETH</b></div>` : '');
  const overText = (amount, fee) => (DEV.bal == null || amount + fee > DEV.bal ? (fee ? 'More than your private balance, once the relay fee is counted.' : 'More than your private balance.') + (DEV.behind ? ' Your older history is still being read.' : '')
    : fee ? 'More than your private balance, once the relay fees to combine its notes are counted.' : 'More than one withdrawal can take: your private balance is spread over too many notes.');
  const maxOut = (fee) => { let lo = 0n, hi = DEV.bal ?? 0n; while (lo < hi) { const mid = (lo + hi + 1n) / 2n; if (merges(mid, fee) != null) lo = mid; else hi = mid - 1n; } return lo; };
  const maxPriv = DEV.bal != null ? html`<button type="button" id="d-maxp" aria-label="Use all: ${fmt(DEV.bal, 18, 4)} ETH private">Private ${fmt(DEV.bal, 18, 4)} ETH</button>` : '';
  const wireMax = () => { wireRoute(); $('#d-maxp')?.addEventListener('click', () => { const left = maxOut(relayFeeNow()), v = DEV.mode === 'out' && c.chainId === 1 && DEV.dest === 'v1' ? left - left % E10 : left, amt = $('#d-amt'); amt.value = v ? plain(v, 18) : ''; amt.dispatchEvent(new Event('input')); }); };
  if (DEV.mode === 'deposit') {
    mount(f, html`<div id="d-fund"></div>${amountField('d-amt', 'Amount', html`<button type="button" id="d-max">${payName()} <span id="d-wb"><span class="sk" style="--w:5ch"></span></span> ETH</button>`)}
      <div class="lbl"><span>To</span><span>yourself, unless you name someone</span></div>
      <div class="amt text"><input id="d-dto" placeholder="Yourself · or bp1…, tacit1… or name.wei" autocomplete="off" spellcheck="false" autocapitalize="off" autocorrect="off" aria-label="Deposit to"></div>
      <div class="rcpt" id="d-rcpt" hidden></div>
      <button class="btn" type="button" id="d-go" disabled>Deposit privately</button>
      <p class="note">Proved on this device, then sent from ${your()}: you pay the network fee and no relay fee. The deposit shows on chain; whose private balance it lands in does not.</p>
      <p class="note mute" data-pool="${c.chainId}">${poolLine(c.chainId)}</p>`);
    let wb = null;
    const amt = $('#d-amt'), go = $('#d-go'), rc = $('#d-rcpt'), toEl = $('#d-dto'), dsv = { raw: '', r: null };
    const rpcOf = async () => (await getDeviceMods()).jsonRpc(c.rpc);
    const wbEl = $('#d-wb');
    rpc('eth_getBalance', [S.address, 'latest'], c.rpc).then((b) => { if (!wbEl.isConnected) return; wb = BigInt(b); wbEl.textContent = fmt(wb, 18, 4); $('#d-max')?.setAttribute('aria-label', `Use all but the network fee: ${fmt(wb, 18, 4)} ETH in ${payName()}`); noEthYet($('#d-fund'), wb, c.chainId === 1 ? '' : CHAIN_META[c.chainId]?.chainName || c.name, 'deposit it'); check(); }).catch(() => { if (wbEl.isConnected) wbEl.textContent = '—'; });
    let bpKeys = null;
    const bpCheck = (raw) => getDeviceMods().then((m) => {
      try { m.recipientOf(bpKeys ||= m.evmPoolKeys(m.zk, walletPriv()), raw); return { bp: raw }; }
      catch { return { error: 'That is not a valid pool address (bp1…). Check it for a typo.' }; }
    }, (e) => ({ error: errText(e) }));
    const check = () => {
      const amount = parseUnits(amt.value), raw = toEl.value.trim();
      if (raw && dsv.raw !== raw) {
        dsv.raw = raw; dsv.r = null;
        (/^bp1/i.test(raw) ? bpCheck(raw) : /^tacit1/i.test(raw) || /\.(g?wei|eth)$/i.test(raw) ? devResolve(raw) : Promise.resolve({ error: 'Enter a pool address (bp1…), a Tacit address or a name, or leave it empty for yourself.' }))
          .then((r) => { if (dsv.raw === raw) { dsv.r = r; check(); } });
      }
      go.disabled = true; rc.hidden = true; mount(rc, html``);
      go.textContent = raw && dsv.r?.bp ? 'Deposit to them privately' : 'Deposit privately';
      if (raw && !dsv.r) { mount(rc, html`<p class="note">Looking it up…</p>`); rc.hidden = false; return; }
      if (raw && dsv.r.error) { warn(rc, dsv.r.error); return; }
      if (!amount) return;
      const over = wb != null && amount > wb;
      go.disabled = over;
      if (over) warn(rc, 'More than your wallet balance.');
      else { mount(rc, html`${raw ? html`<div class="kv"><span>To</span><b>${dsv.r.label ? html`${dsv.r.label} → ` : ''}${viewAddr(dsv.r.bp, 8)}</b></div>${idRow(dsv.r.id || dsv.r.bp)}` : ''}${pointsRow(amount, 'dev', c)}`); rc.hidden = false; }
    };
    toEl.addEventListener('input', check);
    $('#d-max').onclick = () => { if (wb != null) { const keep_ = c.chainId === 1 ? 3n * 10n ** 15n : 2n * 10n ** 14n, v = wb > keep_ ? wb - keep_ : 0n; amt.value = v ? plain(v, 18) : ''; amt.dispatchEvent(new Event('input')); } };
    amt.addEventListener('input', check); check();
    { const d = hxLive('dep'); if (d && d.chain === c.chainId && !d.tac && !d.slug && d.to != null) { toEl.value = d.to; delete KEPT['d-dto']; toEl.dispatchEvent(new Event('input')); } }
    takeDraft('dep', amt, (d) => d.chain === c.chainId && !d.tac && !d.slug);
    amt.addEventListener('focus', warm, { once: true });
    go.onclick = () => busy(go, async (run) => {
      try {
        const amount = parseUnits(amt.value);
        if (!amount) throw new Error('Enter an amount.');
        const raw = toEl.value.trim();
        let to = null;
        if (raw) {
          const r = /^bp1/i.test(raw) ? { bp: raw } : await devResolve(raw);
          if (r.error) throw new Error(r.error);
          if (r.bp !== dsv.r?.bp) throw new Error('Where that address or name points changed. Check it and deposit again.');
          to = r.bp;
        }
        const h = await devDepositSend({ c, amount, to, step });
        rewardPop(go, { pts: hxPts('dev', Number(amount) / 1e18)?.pts });
        await waitTx(h, { timeoutMs: 20e3, chainId: c.chainId });
        clearField(amt); rc.hidden = true;
        afterAction(html`<span class="ok">${to ? 'Deposited into their private balance.' : 'Deposited.'}</span> ${explorer(h)}`);
      } catch (e) { if (e?.pending) { clearField(amt); rc.hidden = true; } txFail(run, status, e); }
    });
  } else if (DEV.mode === 'send') {
    const at = (h) => `/pay/eth/#${h}&chain=${c.chainId}`;
    mount(f, html`<div class="hl">
      <div class="hl-h"><b>Pay from this balance in tacit pay</b><a class="btn sm" href="${at('send')}">Pay privately</a></div>
      <ul>
        <li>To a pool or Tacit address, a name, or an 0x address, held until it blends in</li>
        <li>Someone with no wallet yet: <a href="${at('link')}">send a link</a> they take to any wallet, with no network fee</li>
        <li>Saved recipients, and proof of any payment later, from your key alone</li>
      </ul>
      <p class="note">The same key, pool and balance as here, on ${chainFull(c.chainId)}. You open your wallet there once more, the same way as here.</p>
    </div>`);
  } else if (DEV.mode === 'out') {
    const dest = c.chainId === 1 ? DEV.dest : 'addr', l2 = DEVICE_CHAINS.find((x) => String(x.chainId) === dest);
    mount(f, html`${c.chainId === 1 ? segSub('dest', dest, [['addr', 'Address'], ['v1', 'Tacit pool'], ...DEVICE_CHAINS.filter((x) => x.chainId !== 1).map((x) => [String(x.chainId), chainTab(x.chainId, x.name)])]) : ''}
      ${dest === 'addr' ? html`<div class="lbl"><span>To</span><button type="button" id="d-me">${mine()}</button></div>
        <div class="amt text"><input id="d-to" placeholder="0x… (a fresh address keeps it unlinked)" autocomplete="off" spellcheck="false" autocapitalize="off" autocorrect="off" aria-label="Recipient address"></div>` : ''}
      ${amountField('d-amt', 'Amount', maxPriv)}
      <div class="rcpt" id="d-rcpt" hidden></div>
      <button class="btn" type="button" id="d-go" disabled>${dest === 'addr' ? 'Withdraw' : dest === 'v1' ? 'Move to the Tacit pool' : `Move to ${chainFull(l2.chainId)}`}</button>
      ${dest === 'addr' ? '' : html`<p class="note">${dest === 'v1' ? 'Arrives as tETH in the Tacit pool in the same transaction, with no address in between. The amount shows on Ethereum; which note paid does not.'
        : `Arrives in your private balance on ${chainFull(l2.chainId)} within minutes. The amount shows on Ethereum; which note paid does not.`}${DEV.self && dest === 'v1' ? '' : ' The relay fee comes out of your private balance.'}</p>`}${dest === 'addr' || dest === 'v1' ? selfNote() : ''}`);
    wireMax();
    wireSub(f, 'dest', (d) => { DEV.dest = d; keep($('#sheet-eth'), render.eth); });
    const toEl = $('#d-to'), amt = $('#d-amt'), go = $('#d-go'), rc = $('#d-rcpt');
    let shown = 0n;
    rc.addEventListener('click', (e) => { const b = e.target.closest('#pv-round'); if (b) { amt.value = plain(BigInt(b.dataset.v), 18); amt.dispatchEvent(new Event('input')); } });
    $('#d-me')?.addEventListener('click', () => busy($('#d-me'), async () => { try { toEl.value = await payingAccount(); toEl.dispatchEvent(new Event('input')); } catch (e) { sayErr(status, e); } }));
    for (const id of ['d-to', 'd-amt']) $('#' + id)?.addEventListener('focus', warm, { once: true });
    const check = () => {
      const amount = parseUnits(amt.value);
      go.disabled = true; mount(rc, html``); rc.hidden = true;
      if (!amount) return;
      if (dest === 'addr') {
        const raw = toEl.value.trim();
        let bad = null;
        if (raw) { try { recipientOf(raw); } catch (x) { bad = x; } }
        if (feeUnread()) { mount(rc, feeNote()); rc.hidden = false; return; }
        const relayFee = relayFeeNow(), m = DEV.bal == null ? 0 : merges(amount, relayFee);
        shown = relayFee;
        const over = m == null, pv = raw && !bad && !over ? privacyView(c, amount, raw, walletRoute()) : '';
        mount(rc, html`${relayFee ? html`<div class="kv"><span>Relay fee, from your private balance</span><b>at most ${upEth(capOf(relayFee))} ETH</b></div>${combineRow(m, relayFee)}<div class="kv"><span>Arrives</span><b>${fmt(amount, 18, 6)} ETH</b></div>` : ''}${pv}`);
        go.disabled = !raw || !!bad || over;
        if (!raw) {}
        else if (bad && !/^0(x[0-9a-fA-F]{0,39})?$/i.test(raw)) warn(rc, bad.message);
        else if (over) warn(rc, overText(amount, relayFee));
        else rc.hidden = !relayFee && !pv;
      } else {
        if (feeUnread()) { mount(rc, feeNote()); rc.hidden = false; return; }
        const relayFee = relayFeeNow(), m = DEV.bal == null ? 0 : merges(amount, relayFee);
        shown = relayFee;
        const over = m == null, coarse = dest === 'v1' && amount % E10 !== 0n, pv = !over && !coarse ? privacyView(c, amount, null, walletRoute()) : '';
        mount(rc, html`${relayFee ? html`<div class="kv"><span>Relay fee, from your private balance</span><b>at most ${upEth(capOf(relayFee))} ETH</b></div>${combineRow(m, relayFee)}<div class="kv"><span>Arrives</span><b>${fmt(amount, 18, 6)} ${dest === 'v1' ? 'tETH' : `ETH${l2 ? ', less at most 0.25%' : ''}`}</b></div>` : ''}${pv}`);
        go.disabled = over || coarse;
        if (over) warn(rc, overText(amount, relayFee));
        else if (coarse) warn(rc, 'The Tacit pool takes up to 8 decimals.');
        else rc.hidden = !relayFee && !pv;
      }
    };
    for (const el of dest === 'addr' ? [toEl, amt] : [amt]) el.addEventListener('input', check);
    check();
    { const od = hxLive('dout'); if (od?.to && toEl && od.chain === c.chainId) toEl.value = od.to; }
    takeDraft('dout', amt, (d) => d.chain === DEV.chain?.chainId && (!d.all || (DEV.bal != null && !feeUnread())),
      () => { const left = maxOut(relayFeeNow()), v = c.chainId === 1 && dest === 'v1' ? left - left % E10 : left; return v > 0n ? plain(v, 18) : ''; });
    go.onclick = () => busy(go, async (run) => {
      try {
        const amount = parseUnits(amt.value), maxFee = capOf(shown);
        if (!amount) throw new Error('Enter an amount.');
        let h, done;
        if (dest === 'addr' || dest === 'v1') ({ h, done } = await devOutSend({ run, c, amount, dest, to: toEl?.value, self: walletRoute(), maxFee, step }));
        else {
          const W2 = await deviceWallet();
          h = keeperTx(await W2.bridgeOut({ toChainId: l2.chainId, amount, maxFee, now: chainNow(), l2Rpc: (await getDeviceMods()).jsonRpc(l2.rpc), onStep: step }), 1, `Move ${fmt(amount, 18, 6)} ETH to ${chainFull(l2.chainId)}`);
          devWalletOn(l2.chainId).then((w) => w.watchReceive()).catch(() => {});
          done = `On its way to ${chainFull(l2.chainId)}.`;
        }
        if (dest !== 'v1') await waitTx(h, { timeoutMs: 20e3, chainId: dest === 'addr' ? c.chainId : 1 });
        clearField(amt); rc.hidden = true;
        afterAction(html`<span class="ok">${done}</span> ${explorer(h)}`);
      } catch (e) {
        if (e?.pending) { clearField(amt); rc.hidden = true; txFail(run, status, e); }
        else if (e?.said || waitRanOut(e)) { clearField(amt); rc.hidden = true; afterAction(html`<span class="err">${errText(e)}</span>`); }
        else if (e?.feeMoved != null) await feeMoved(e);
        else if (dest === 'addr' || dest === 'v1') failed(e);
        else if (l2 && l2.chainId !== 8453 && /^not enough in the pool/.test(e?.message || '')) sayErr(status, new Error(`More than your private balance, once ${chainFull(l2.chainId)}’s bridge fee is counted as well: its ticket is priced as the move is sent. Try a little less.`));
        else sayErr(status, e);
      }
    });
  } else {
    const min = DEV.quote?.receiveMin ? BigInt(DEV.quote.receiveMin) : null;
    const uni = ctx.UNI && S.key.tacit;
    mount(f, W ? html`
      ${uni ? html`<div class="blk"><div class="kv"><span>Your Tacit address</span><b class="mono">${tacitShort(S.key.tacit)}</b><button class="link" type="button" data-copy="${S.key.tacit}">copy</button></div>
        ${idRow(S.key.tacit)}
        <p class="note">Paid at your tacit1 address, it lands in your private balance on any chain. Anyone using Tacit can pay you privately with it, in any pool, and it never appears on chain.</p></div>` : ''}
      <div class="blk"><div class="kv"><span>Pool address</span><b class="mono">${viewAddr(W.address, 10)}</b><button class="link" type="button" data-copy="${W.address}">copy</button></div>
        ${idRow(W.address)}
        <p class="note">For private sends within this pool, from another Tacit user’s device. Nothing on chain links a payment to it.</p></div>
      <div class="blk"><div class="kv"><span>Deposit address</span><b class="mono">${viewAddr(W.receiveBox, 8)}</b><button class="link" type="button" data-copy="${W.receiveBox}">copy</button></div>
        <p class="note">Send ETH here from any wallet or exchange, choosing ${chainTag(c.chainId)} as the network. It moves into your private balance within minutes, less at most 0.25%.${min ? html` The relay takes it in from ${fmt(min, 18, 4)} ETH, a floor that moves with network fees${c.chainId === 1 ? '; for less, pick Base' : ''}. Less waits there for more, or you sweep it in yourself.` : ''}</p>
        <p class="note">Send only ETH, and only on ${chainMarks([1, 8453, 4663])}: anything else can’t be collected.</p>
        <p class="note">No ETH yet? Buy it with a card or bank transfer at ${RAMPS.map(([n, u], i) => html`${i ? (i < RAMPS.length - 1 ? ', ' : ' or ') : ''}<a href="${u}" target="_blank" rel="noopener noreferrer">${n}</a>`)} and give them this address. They may ask for ID.</p></div>
      <div id="d-wait"></div>
      <p class="note">To ask for an amount, <a href="/pay/eth/#receive&chain=${c.chainId}">get paid by link or QR</a> in tacit pay: each link has a deposit address of its own.</p>` : html`<p class="note">Reading your addresses…</p>`);
    $$('[data-copy]', f).forEach((b) => b.onclick = () => copy(b.dataset.copy));
    if (W) W.waiting().then((w) => {
      const box = $('#d-wait');
      if (!w || !box?.isConnected) return;
      mount(box, html`<div class="callout"><span>${fmt(w, 18, 6)} ETH is waiting there. Sweep it in yourself: proved here, no fee.</span><button class="btn ghost" type="button" id="d-sweep">Sweep in</button></div>`);
      const b = $('#d-sweep');
      b.onclick = () => busy(b, async (run) => {
        try {
          await payingAccount(); W.connect(payFrom(c.chainId, `Sweep ${fmt(w, 18, 6)} ETH in on this device${c.chainId === 1 ? '' : `, on ${chainFull(c.chainId)}`}`));
          const h = await W.sweep({ onStep: step });
          await waitTx(h, { timeoutMs: 20e3, chainId: c.chainId });
          afterAction(html`<span class="ok">Swept in.</span> ${explorer(h)}`);
        } catch (e) { txFail(run, status, e); }
      });
    }).catch(() => {});
  }
}
const devPools = () => [...DEVICE_CHAINS.map((x) => [String(x.chainId), chainTab(x.chainId, x.name)]), ...TOKEN_POOLS.map((p) => [p.slug, p.name])];
function pickPool(id) {
  const p = TOKEN_POOLS.find((x) => x.slug === id), was = DEV.tok;
  if (p) DEV.tok = p; else setDeviceChain(DEVICE_CHAINS.find((x) => String(x.chainId) === id));
  if ((was?.slug || '') !== (p?.slug || '')) for (const i of $$('#d-form input')) i.value = '';
  keep($('#sheet-eth'), render.eth);
}

function renderTokenPool(el) {
  const t = DEV.tok, D = t.dec ?? 18;
  if (!needKey(el, `Keep ${t.sym} private on Ethereum, proved in your browser.`)) return;
  tkPin(t);
  const W = TK.W && TK.key === S.key.pubHex + t.slug ? TK.W : null;
  const last = TK.bal == null ? devBal(t.slug, S.key.pubHex) : null;
  mount(el, html`
    ${segSub('chain', t.slug, devPools())}
    <div class="bal">
      <span class="pair"><svg class="tk md" aria-hidden="true"><use href="#${t.icon}"/></svg></span>
      <div><div class="v num">${TK.bal != null ? fmt(TK.bal, D, 6) : TK.err ? html`<span class="err">—</span>` : last != null ? html`<span class="stale">${fmt(last, D, 6)}</span>` : html`<span class="sk" style="--w:8ch"></span>`}</div><div class="u">${t.sym}, private on this device</div></div>
      <div class="side">${TK.err ? html`<button class="link" type="button" id="d-rescan">retry</button>` : TK.bal != null ? html`<button class="link" type="button" id="d-rescan">refresh</button>` : 'updating…'}</div>
    </div>
    ${segSub('dev', DEV.mode, [['deposit', 'Deposit'], ['send', 'Send'], ['out', 'Withdraw'], ['receive', 'Receive']])}
    <div id="d-form"></div>
    <div class="status" role="status" id="d-status"></div>`);
  const syncFailed = (e) => { TK.err = e; rerender('eth'); sayErr($('#d-status'), e); };
  wireSub(el, 'chain', pickPool);
  wireSub(el, 'dev', (m) => { DEV.mode = m; keep($('#sheet-eth'), render.eth); });
  if ((!W || TK.bal == null) && !TK.err) tokenSync().then(() => rerender('eth')).catch(syncFailed);
  if (!TK.self && t?.keeper) keeperRead(t.keeper).then(() => { if (!TK.self && keeperDown(t.keeper)) { TK.self = true; rerender('eth'); } });
  const re = $('#d-rescan'); if (re) re.onclick = () => busy(re, async () => { try { await tokenSync(true); TK.err = null; rerender('eth'); } catch (e) { syncFailed(e); } });
  const f = $('#d-form'), status = $('#d-status');
  f.addEventListener('input', (e) => { if (e.isTrusted && !running('eth')) say(status, ''); });
  const step = (m) => { m = String(m); say(status, m[0].toUpperCase() + m.slice(1) + '…'); };
  const afterAction = (done) => { say(status, done); tokenSync(true, t).then(() => rerender('eth')).catch(() => rerender('eth')); };
  const explorer = (h) => txLink(h, t.explorer);
  const warm = () => prover(provingNote).then(() => { if (!running('eth') && /^Getting the proving key/.test(status.textContent)) say(status, ''); }).catch(() => {});
  const amountField = (id, label, extra = '') => html`
    <div class="lbl"><span>${label}</span>${extra}</div>
    <div class="amt"><input id="${id}" inputmode="decimal" placeholder="0.00" autocomplete="off" aria-label="${label}"><span class="u"><svg class="tk sm" aria-hidden="true"><use href="#${t.icon}"/></svg>${t.sym}</span></div>`;
  const viaRelay = () => !!t.keeper && !TK.self;
  const quoteNow = () => (viaRelay() ? TK.quote : null);
  const relayFee = () => BigInt(quoteNow()?.fee || 0);
  const feeUnread = () => {
    if (!viaRelay() || (TK.quote && Date.now() - TK.qAt < 120e3)) return false;
    if (W && !TK.qBusy && Date.now() - TK.qFail > 15e3) {
      TK.qBusy = true;
      W.quote().then((q) => { if (TK.W === W) { TK.quote = q; TK.qAt = Date.now(); rerender('eth'); } })
        .catch(() => { TK.qFail = Date.now(); rerender('eth'); setTimeout(() => { if (TK.W === W) rerender('eth'); }, 15e3); })
        .finally(() => { TK.qBusy = false; });
    }
    return !TK.quote;
  };
  const capOf = (fee) => (fee ? (fee * 5n) / 4n : null);
  const selfNote = (out) => (viaRelay()
    ? html`<p class="note">Sent by the relay: ${out ? 'the withdrawal shows its amount and the address it goes to, not who sent it' : 'nothing of yours shows'}. Its fee is paid in ${t.sym} out of your private balance.</p>`
    : html`<p class="note">From ${your()}: no relay fee, the network fee instead. ${out ? `The withdrawal shows its amount, the address it goes to and ${your()} as the sender; which deposit it spends is not shown.` : `${your()} shows as the sender; how much and to whom stay hidden.`}${t.keeper ? html` <button class="link" type="button" id="d-relay">Use the relay</button>` : ''}</p>`);
  const wireRoute = () => $('#d-relay')?.addEventListener('click', () => { TK.self = false; rerender('eth'); });
  const feeNote = () => {
    if (!TK.qFail) return html`<p class="note">Reading the relay fee…</p>`;
    RETRY['d-self'] = () => { TK.self = true; rerender('eth'); };
    return html`<p class="note err">The relay’s fee could not be read; trying again. <button class="link" type="button" data-retry="d-self">Send it from ${your()} instead</button></p>`;
  };
  if (W && !TK.plan && DEV.mode !== 'deposit' && DEV.mode !== 'receive') getDeviceMods().then((m) => { TK.plan = m.mergePlan; rerender('eth'); }).catch(() => {});
  const merges = (amount, fee = relayFee()) => (W && TK.plan ? TK.plan(W.notes().map((n) => n.v), amount + fee, fee) : TK.bal != null && amount + fee <= TK.bal ? 0 : null);
  const maxOut = (fee = relayFee()) => { let lo = 0n, hi = TK.bal ?? 0n; while (lo < hi) { const mid = (lo + hi + 1n) / 2n; if (merges(mid, fee) != null) lo = mid; else hi = mid - 1n; } return lo; };
  const maxPriv = TK.bal != null ? html`<button type="button" id="d-maxp" aria-label="Use all: ${fmt(TK.bal, D, 4)} ${t.sym} private">Private ${fmt(TK.bal, D, 4)} ${t.sym}</button>` : '';
  const overText = () => (relayFee() ? 'More than your private balance, once the relay fee is counted.' : 'More than your private balance.');
  const over = (rc, amount) => {
    if (!(viaRelay() && merges(amount, 0n) != null)) return warn(rc, overText());
    RETRY['d-self'] = () => { TK.self = true; rerender('eth'); };
    mount(rc, html`<p class="note err">${overText()} <button class="link" type="button" data-retry="d-self">Send it from ${your()} instead</button></p>`); rc.hidden = false;
  };
  const combine = (m) => (!m ? '' : viaRelay() ? html`<div class="kv"><span>Relay fee to combine notes${m > 1 ? ` (${m}×)` : ''}</span><b>at most ${fmt(capOf(relayFee()) * BigInt(m), D, 4)} ${t.sym}</b></div>`
    : html`<div class="kv"><span>Combines your notes first</span><b>${m} more transaction${m > 1 ? 's' : ''} from ${your()}</b></div>`);
  const feeRow = () => (viaRelay() && quoteNow() ? html`<div class="kv"><span>Relay fee</span><b>${fmt(relayFee(), D, 4)} ${t.sym}</b></div>` : '');
  const wireMax = () => $('#d-maxp')?.addEventListener('click', () => { const v = maxOut(), amt = $('#d-amt'); amt.value = v ? plain(v, D) : ''; amt.dispatchEvent(new Event('input')); });
  const fail = (run, amt, rc, e) => {
    if (e?.feeMoved != null) { TK.quote = null; TK.qAt = 0; rerender('eth'); say($('#d-status'), html`<span class="err">The relay fee changed to ${fmt(e.feeMoved, D, 4)} ${t.sym}. Check it and press again.</span>`); return; }
    if (viaRelay() && keeperTrouble(e)) {
      RETRY['d-self'] = () => { TK.self = true; rerender('eth'); say($('#d-status'), `Press it again: ${your()} sends it, with no relay fee.`); };
      say(status, html`<span class="err">${errText(e)}</span> <button class="link" type="button" data-retry="d-self">Send it from ${your()} instead</button>`);
      return;
    }
    if (e?.pending) { clearField(amt); rc.hidden = true; txFail(run, status, e); }
    else if (e?.said || waitRanOut(e)) { clearField(amt); rc.hidden = true; afterAction(html`<span class="err">${errText(e)}</span>`); }
    else txFail(run, status, e);
  };

  if (DEV.mode === 'deposit') {
    mount(f, html`<div id="d-fund"></div>${amountField('d-amt', 'Amount', html`<button type="button" id="d-max">${payName()} <span id="d-wb"><span class="sk" style="--w:5ch"></span></span> ${t.sym}</button>`)}
      <div class="lbl"><span>To</span><span>yourself, unless you name someone</span></div>
      <div class="amt text"><input id="d-dto" placeholder="Yourself · or tacit1…, name.wei or bp1…" autocomplete="off" spellcheck="false" autocapitalize="off" autocorrect="off" aria-label="Deposit to"></div>
      <div class="rcpt" id="d-rcpt" hidden></div>
      <button class="btn" type="button" id="d-go" disabled>Deposit privately</button>
      <p class="note">Proved on this device and sent from ${your()}, which pays the network fee. A signature approves the ${t.sym} where it can, so no separate approval is sent. The deposit shows on chain; whose private balance it lands in does not.</p>`);
    let wb = null;
    const amt = $('#d-amt'), go = $('#d-go'), rc = $('#d-rcpt'), wbEl = $('#d-wb'), toEl = $('#d-dto'), dsv = { raw: '', r: null };
    const lookUp = (raw) => tokRecipient(raw).then((r) => (/your own address/i.test(r.error || '') ? { self: true } : r), (e) => ({ error: errText(e) }));
    const check = () => {
      const amount = parseUnits(amt.value, D), raw = toEl.value.trim();
      if (raw && dsv.raw !== raw) { dsv.raw = raw; dsv.r = null; lookUp(raw).then((r) => { if (dsv.raw === raw) { dsv.r = r; check(); } }); }
      go.disabled = true; rc.hidden = true; mount(rc, html``);
      go.textContent = raw && dsv.r?.bp ? 'Deposit to them privately' : 'Deposit privately';
      if (raw && !dsv.r) { mount(rc, html`<p class="note">Looking it up…</p>`); rc.hidden = false; return; }
      if (raw && dsv.r.error) { warn(rc, dsv.r.error); return; }
      if (!amount) return;
      const over = wb != null && amount > wb;
      go.disabled = over;
      if (over) warn(rc, `More than ${your()} holds.`);
      else if (raw && dsv.r.bp) { mount(rc, html`<div class="kv"><span>To</span><b>${dsv.r.label ? html`${dsv.r.label} → ` : ''}${viewAddr(dsv.r.bp, 8)}</b></div>${idRow(dsv.r.id || dsv.r.bp)}`); rc.hidden = false; }
    };
    toEl.addEventListener('input', check);
    if (S.address) ethCall(t.token, SEL.balanceOf + addrWord(S.address)).then((b) => {
      if (!wbEl.isConnected) return;
      wb = BigInt(b); wbEl.textContent = fmt(wb, D, 4); $('#d-max')?.setAttribute('aria-label', `Use all: ${fmt(wb, D, 4)} ${t.sym} in ${payName()}`); check();
    }).catch(() => { if (wbEl.isConnected) wbEl.textContent = '—'; });
    else wbEl.textContent = '—';
    let rplan = null;
    const showPlan = (pl) => {
      rplan = pl;
      const fund = $('#d-fund');
      if (pl && fund?.isConnected) mount(fund, html`<p class="note">No ETH in ${your()}: the relay sends this deposit and takes about ${fmt(pl.fee, D, 3)} ${t.sym} for the gas. You sign once, and nothing leaves unless the deposit lands.</p>`);
      else if (payer() === 'tacit') ethBalance().then((b) => { if (b === 0n) noEthYet($('#d-fund'), b, '', 'deposit it'); });
    };
    relayDeposit(t).then(showPlan, () => { if (payer() === 'tacit') ethBalance().then((b) => { if (b === 0n) noEthYet($('#d-fund'), b, '', 'deposit it'); }); });
    $('#d-max').onclick = () => { if (wb != null) { const m = rplan && wb > rplan.fee ? wb - rplan.fee : wb; amt.value = m ? plain(m, D) : ''; amt.dispatchEvent(new Event('input')); } };
    amt.addEventListener('input', check); check();
    const mine = (d) => d.slug === t.slug || (d.tac === true && t.slug === 'tac');
    { const d = hxLive('dep'); if (d && mine(d) && d.to != null) { toEl.value = d.to; delete KEPT['d-dto']; toEl.dispatchEvent(new Event('input')); } }
    takeDraft('dep', amt, mine);
    amt.addEventListener('focus', warm, { once: true });
    go.onclick = () => busy(go, async (run) => {
      try {
        const amount = parseUnits(amt.value, D);
        if (!amount) throw new Error('Enter an amount.');
        const raw = toEl.value.trim();
        let to = null;
        if (raw) {
          const r = await lookUp(raw);
          if (r.error) throw new Error(r.error);
          if (!r.self && r.bp !== dsv.r?.bp) throw new Error('Where that address or name points changed. Check it and deposit again.');
          to = r.self ? null : r.bp;
        }
        const h = await tokDepositSend({ t, amount, to, rplan, step, status });
        await waitTx(h, { timeoutMs: 20e3, chainId: 1 });
        clearField(amt); rc.hidden = true;
        afterAction(html`<span class="ok">${to ? 'Deposited into their private balance.' : 'Deposited.'}</span> ${explorer(h)}`);
      } catch (e) { if (e?.relayPlan) showPlan(e.relayPlan); fail(run, amt, rc, e); }
    });
  } else if (DEV.mode === 'send') {
    mount(f, html`<div class="lbl"><span>To</span></div>
      <div class="amt text"><input id="d-to" placeholder="tacit1…, name.wei or bp1…" autocomplete="off" spellcheck="false" autocapitalize="off" autocorrect="off" aria-label="Recipient"></div>
      ${amountField('d-amt', 'Amount', maxPriv)}
      <div class="rcpt" id="d-rcpt" hidden></div>
      <button class="btn" type="button" id="d-go" disabled>Send privately</button>
      ${selfNote()}`);
    wireMax(); wireRoute();
    const toEl = $('#d-to'), amt = $('#d-amt'), go = $('#d-go'), rc = $('#d-rcpt'), dsv = { raw: '', r: null };
    for (const x of [toEl, amt]) x.addEventListener('focus', warm, { once: true });
    const check = () => {
      const amount = parseUnits(amt.value, D), raw = toEl.value.trim();
      go.disabled = true; rc.hidden = true; mount(rc, html``);
      if (raw && dsv.raw !== raw) { dsv.raw = raw; dsv.r = null; tokRecipient(raw).then((r) => { if (dsv.raw === raw) { dsv.r = r; check(); } }, (e) => { if (dsv.raw === raw) { dsv.r = { error: errText(e) }; check(); } }); }
      if (raw && !dsv.r) { mount(rc, html`<p class="note">Looking it up…</p>`); rc.hidden = false; return; }
      if (raw && dsv.r.error) { warn(rc, dsv.r.error); return; }
      if (!raw || !amount) return;
      if (feeUnread()) { mount(rc, feeNote()); rc.hidden = false; return; }
      const m = TK.bal == null ? 0 : merges(amount), tooMuch = m == null;
      go.disabled = tooMuch;
      if (tooMuch) over(rc, amount);
      else { mount(rc, html`<div class="kv"><span>To</span><b>${dsv.r.label ? html`${dsv.r.label} → ` : ''}${viewAddr(dsv.r.bp, 8)}</b></div>${idRow(dsv.r.id || dsv.r.bp)}${feeRow()}${combine(m)}`); rc.hidden = false; }
    };
    toEl.addEventListener('input', check); amt.addEventListener('input', check); check();
    { const dr = hxLive('tsend'); if (dr?.slug === t.slug) { toEl.value = dr.to || ''; amt.value = dr.amt || ''; HX.draft = null; if (toEl.value || amt.value) check(); } }
    go.onclick = () => busy(go, async (run) => {
      try {
        const amount = parseUnits(amt.value, D), raw = toEl.value.trim();
        if (!amount) throw new Error('Enter an amount.');
        const r = await tokRecipient(raw);
        if (r.error) throw new Error(r.error);
        if (r.bp !== dsv.r?.bp) throw new Error('Where that address or name points changed. Check it and send again.');
        const W2 = await tokenWallet(t);
        await payingAccount(); W2.connect(payFromTok(`Send ${fmt(amount, D, 6)} ${t.sym} privately from this device`));
        const relay = viaRelay(), h = await W2.send({ to: r.bp, amount, via: relay ? 'relay' : 'self', maxFee: relay ? capOf(relayFee()) : null, onStep: step });
        await waitTx(h, { timeoutMs: 20e3, chainId: 1 });
        clearField(amt); clearField(toEl); rc.hidden = true;
        afterAction(html`<span class="ok">Sent.</span> ${explorer(h)}`);
      } catch (e) { fail(run, amt, rc, e); }
    });
  } else if (DEV.mode === 'out') {
    mount(f, html`<div class="lbl"><span>To</span><button type="button" id="d-me">${mine()}</button></div>
      <div class="amt text"><input id="d-to" placeholder="0x…" autocomplete="off" spellcheck="false" autocapitalize="off" autocorrect="off" aria-label="Recipient address"></div>
      ${amountField('d-amt', 'Amount', maxPriv)}
      <div class="rcpt" id="d-rcpt" hidden></div>
      <button class="btn" type="button" id="d-go" disabled>Withdraw</button>
      ${selfNote(true)}`);
    wireMax(); wireRoute();
    const toEl = $('#d-to'), amt = $('#d-amt'), go = $('#d-go'), rc = $('#d-rcpt');
    $('#d-me').addEventListener('click', () => busy($('#d-me'), async () => { try { toEl.value = await payingAccount(); toEl.dispatchEvent(new Event('input')); } catch (e) { sayErr(status, e); } }));
    for (const x of [toEl, amt]) x.addEventListener('focus', warm, { once: true });
    const check = () => {
      const amount = parseUnits(amt.value, D), raw = toEl.value.trim();
      go.disabled = true; rc.hidden = true; mount(rc, html``);
      if (!amount) return;
      let bad = null;
      if (raw) { try { recipientOf(raw); } catch (x) { bad = x; } }
      if (raw && !bad && feeUnread()) { mount(rc, feeNote()); rc.hidden = false; return; }
      const m = TK.bal == null ? 0 : merges(amount), tooMuch = m == null;
      go.disabled = !raw || !!bad || tooMuch;
      if (!raw) return;
      if (bad && !/^0(x[0-9a-fA-F]{0,39})?$/i.test(raw)) warn(rc, bad.message);
      else if (tooMuch) over(rc, amount);
      else if (!bad) { mount(rc, html`${feeRow()}${combine(m)}`); rc.hidden = !m && !feeRow(); }
    };
    toEl.addEventListener('input', check); amt.addEventListener('input', check); check();
    { const dr = hxLive('tsend'); if (dr?.slug === t.slug) { toEl.value = dr.to || ''; amt.value = dr.amt || ''; HX.draft = null; if (toEl.value || amt.value) check(); } }
    go.onclick = () => busy(go, async (run) => {
      try {
        const amount = parseUnits(amt.value, D);
        if (!amount) throw new Error('Enter an amount.');
        const to = recipientOf(toEl.value), W2 = await tokenWallet(t);
        await payingAccount(); W2.connect(payFromTok(`Withdraw ${fmt(amount, D, 6)} ${t.sym} from this device`));
        const relay = viaRelay(), h = await W2.withdraw({ to, amount, via: relay ? 'relay' : 'self', maxFee: relay ? capOf(relayFee()) : null, onStep: step });
        await waitTx(h, { timeoutMs: 20e3, chainId: 1 });
        clearField(amt); rc.hidden = true;
        afterAction(html`<span class="ok">Withdrawn.</span> ${explorer(h)}`);
      } catch (e) { fail(run, amt, rc, e); }
    });
  } else {
    const uni = ctx.UNI && S.key.tacit;
    mount(f, W ? html`
      ${uni ? html`<div class="blk"><div class="kv"><span>Your Tacit address</span><b class="mono">${tacitShort(S.key.tacit)}</b><button class="link" type="button" data-copy="${S.key.tacit}">copy</button></div>
        ${idRow(S.key.tacit)}
        <p class="note">A private ${t.sym} send from another person’s ${t.sym} pool to this address lands in your balance here once this page reads the pool. ${t.sym} sent from the Tacit pool arrives in the Tacit pool instead.</p></div>` : ''}
      <div class="blk"><div class="kv"><span>Pool address</span><b class="mono">${viewAddr(W.address, 10)}</b><button class="link" type="button" data-copy="${W.address}">copy</button></div>
        ${idRow(W.address)}
        <p class="note">For private sends within this pool, from another Tacit user’s device.</p></div>` : html`<p class="note">Reading your addresses…</p>`);
    $$('[data-copy]', f).forEach((b) => b.onclick = () => copy(b.dataset.copy));
  }
}

const PLAIN = { pub: null, addr: null };
const plainAddr = () => (S.key && PLAIN.pub === S.key.pubHex ? PLAIN.addr : null);
function loadPlain() {
  const pub = S.key?.pubHex;
  if (!pub || PLAIN.pub === pub) return Promise.resolve(PLAIN.addr);
  return withKey((t) => t.wallet.address(), pub).then((a) => { if (S.key?.pubHex === pub) Object.assign(PLAIN, { pub, addr: a }); return a; });
}
let MOVE_SATS = 5000n;
const NOTES_MAX = 10;
async function lookForShielded(status) {
  try {
    const { found, failed } = await scanShielded(status);
    say(status, html`${found ? html`<span class="ok">Found ${found} shielded payment${found === 1 ? '' : 's'}.</span>` : 'None for you among the latest shielded transfers.'}${failed ? ` ${failed.toLocaleString('en-US')} could not be read; refresh to try them again.` : ''} A payment from further back is found from its payment link or transaction id, pasted under Receive.`);
  } catch (e) { sayErr(status, e); }
}
render.btc = () => {
  const el = $('#btc-body');
  if (!needKey(el, 'Your key’s own Bitcoin wallet: hold BTC and TAC, send them to anyone, and get paid privately at your tacit1 address.', 'btc')) return;
  const b = BTC.pub === S.key.pubHex ? BTC : null, last = b || BTC.err ? null : lastSeen('btc');
  if (!b && !BTC.loading && !BTC.err) loadBtc().then(() => rerender('btc')).catch(() => {});
  mount(el, html`
    <div class="bal">
      <svg class="tk md" aria-hidden="true"><use href="#tk-btc"/></svg>
      <div><div class="v num">${b ? fmt(b.sats + b.silent, 8, 8) : BTC.err ? html`<span class="err">—</span>` : last != null ? html`<span class="stale">${fmt(last, 8, 8)}</span>` : html`<span class="sk" style="--w:10ch"></span>`}</div>
        <div class="u">BTC${b?.pending ? ` · ${fmt(b.pending, 8, 8)} arriving` : ''}${!b || b.got === 3 ? '' : b.part ? ' · checking silent payments…' : ' · could not check silent payments'}</div></div>
      <div class="side">${b || BTC.err ? html`<button class="link" type="button" id="btc-re">${BTC.err || !b ? 'retry' : 'refresh'}</button>` : 'updating…'}</div>
    </div>
    ${(b?.held || []).map((a) => html`<div class="kv"><span>${a.ticker} on Bitcoin${a.id === TAC_BTC_ID ? html` · <a href="#bridge" data-link="bridge">Bridge to Ethereum</a>` : ''}</span><b class="num">${fmt(a.balance, a.decimals, assetById(a.id)?.dp ?? 4)}</b></div>`)}
    ${shLookingNote(S.key.pubHex)}
    ${segSub('btcm', BTC.mode, [['send', 'Send'], ['receive', 'Receive'], ['notes', 'Notes']])}
    <div id="btc-form"></div>
    <div class="status" role="status" id="btc-status"></div>`);
  const status = $('#btc-status');
  if (BTC.err) sayErr(status, BTC.err);
  wireSub(el, 'btcm', (m) => { BTC.mode = m; keep($('#sheet-btc'), render.btc); });
  const re = $('#btc-re');
  if (re) re.onclick = () => busy(re, async () => {
    const retry = !!(BTC.err || !b);
    BTC.err = null; await loadBtc(true);
    if (!retry && !BTC.err) await lookForShielded(status);
    rerender('btc');
  });
  (BTC.mode === 'send' ? btcSendForm : BTC.mode === 'notes' ? btcNotes : btcReceive)($('#btc-form'), status, b);
};
function btcSendForm(f, status, b) {
  const held = (b?.held || []).filter((a) => a.known);
  if (BTC.asset !== 'btc' && b?.got >= 2 && !held.some((a) => a.id === BTC.asset)) BTC.asset = 'btc';
  const token = held.find((a) => a.id === BTC.asset) || null, dec = token ? token.decimals : 8, unit = token ? token.ticker : 'BTC';
  mount(f, html`
    ${held.length ? segSub('btca', BTC.asset, [['btc', 'BTC'], ...held.map((a) => [a.id, a.ticker])]) : ''}
    <div class="lbl"><span>To</span></div>
    <div class="amt text"><input id="bt-to" placeholder="${token ? 'tacit1…, tcs1… or a name' : 'tacit1…, sp1…, bc1… or a name'}" autocomplete="off" spellcheck="false" autocapitalize="off" autocorrect="off" aria-label="Recipient"></div>
    <div class="lbl"><span>Amount</span>${token ? html`<button type="button" id="bt-max">${fmt(token.balance, dec, 8)} ${unit}</button>` : b ? html`<span>${fmt(b.sats + b.silent, 8, 8)} BTC</span>` : ''}</div>
    <div class="amt"><input id="bt-amt" inputmode="decimal" placeholder="0.00" autocomplete="off" aria-label="Amount"><span class="u">${token ? unit : html`<svg class="tk sm" aria-hidden="true"><use href="#tk-btc"/></svg>BTC`}</span></div>
    <div class="rcpt" id="bt-rcpt" hidden></div>
    <button class="btn" type="button" id="bt-go" disabled>Send ${unit}</button>
    ${BTC.share ? html`<div class="callout"><span>${BTC.share.kind === 'st' ? 'A shielded payment hides who received it.' : 'A silent payment leaves no reusable address on chain.'} Send them this link so their wallet finds it.</span><button class="btn ghost" type="button" data-copy="${BTC.share.url}">Copy link</button></div>` : ''}`);
  wireSub(f, 'btca', (a) => { BTC.asset = a; keep($('#sheet-btc'), render.btc); });
  $$('[data-copy]', f).forEach((x) => x.onclick = () => copy(x.dataset.copy, 'Link copied'));
  const to = $('#bt-to'), amt = $('#bt-amt'), go = $('#bt-go'), rc = $('#bt-rcpt');
  $('#bt-max')?.addEventListener('click', () => { amt.value = plain(token.balance, dec); amt.dispatchEvent(new Event('input')); });
  let route = null, seq = 0;
  onEdit([to, amt], go, async (e) => {
    const my = ++seq;
    route = null; go.disabled = true; if (e?.isTrusted) say(status, '');
    const raw = to.value.trim(), v = parseUnits(amt.value, dec);
    if (!raw) { rc.hidden = true; return; }
    try {
      const r = await btcRouteM(raw, token);
      if (my !== seq || !to.isConnected) return;
      if (tooFine(rc, amt.value, v, dec)) return;
      route = r;
      const how = { sp: 'Silent payment · to a one-time address only they can find', addr: 'Plain payment · public on chain', stealth: 'Shielded · the recipient stays hidden', pubkey: 'Private amount · their key is visible' }[r.kind];
      mount(rc, html`<div class="kv"><span>${r.name || 'To'}</span><b>${r.shown}</b></div>${idRow(r.address)}<div class="kv"><span>How</span><b>${how}</b></div>`);
      rc.hidden = false;
      const avail = token ? (b?.got >= 2 ? token.balance : null) : b?.got === 3 ? b.sats + b.silent : null, noFeeSats = !!token && !!b && b.got === 3 && b.sats < ASSET_SEND_SATS;
      go.disabled = !v || (avail != null && v > avail) || (!token && v <= SATS_DUST) || noFeeSats;
      if (avail != null && v > avail) warn(rc, 'More than you hold.');
      else if (!token && v && v <= SATS_DUST) warn(rc, 'Send more than 546 sats.');
      else if (noFeeSats) warn(rc, `A ${unit} send needs about 3,000 sats at your Bitcoin address for its fees. Add some from Receive.`);
    } catch (err) { if (my === seq) quoteErr(rc, err); }
  });
  go.onclick = () => busy(go, async () => {
    const r = route, v = parseUnits(amt.value, dec), pub = S.key?.pubHex;
    if (!r || !v || !pub) return;
    try {
      const txid = await btcSendNow({ r, raw: to.value, v, token, dec, unit, pub, field: to, status });
      clearField(amt);
      toast(`Sent ${fmt(v, dec, 8)} ${unit}`);
      await loadBtc(true).catch(() => {});
      rerender('btc'); say($('#btc-status'), html`<span class="ok">Sent.</span> <a href="${MEMPOOL}/tx/${txid}" target="_blank" rel="noopener">${short(txid, 6)} ↗</a>`);
    } catch (e) { sayErr(status, /insufficient sats|no plain-sats/i.test(e?.message || '') ? new Error('Not enough BTC for this and its Bitcoin fee.') : e); }
  });
}
const BNOTES = { pub: null, at: 0, loading: null, bridged: null, err: null, pick: {} };
function loadBridgedHere(force = false) {
  const pub = S.key?.pubHex;
  if (!pub) return Promise.resolve();
  if (BNOTES.loading) return BNOTES.loading;
  if (!force && BNOTES.pub === pub && Date.now() - BNOTES.at < 60e3) return Promise.resolve();
  return (BNOTES.loading = withKey(async (t) => {
    const read = await Promise.all(BTC_NOTE_ASSETS.filter((a) => a === CHAIN_ASSETS.tac || a === CHAIN_ASSETS.teth).map((a) => t.bridgedNotes(a.id).then((r) => r.notes.map((n) => ({ ...n, aid: a.id })))));
    try { MOVE_SATS = BigInt(await (await import('/btc-book.js?cb=3a43da09')).moveSatsNeeded(() => t.getFeeRate())); } catch {}
    return read.flat();
  }, pub).then((v) => { if (S.key?.pubHex === pub) Object.assign(BNOTES, { pub, at: Date.now(), bridged: v, err: null }); },
    (e) => { if (S.key?.pubHex === pub) Object.assign(BNOTES, { pub, at: Date.now(), err: e }); }).finally(() => { BNOTES.loading = null; }));
}
const noteKey = (n) => `${n.txid}:${n.vout}`;
const satsShort = (e) => /insufficient (plain )?sats|no plain-sats/i.test(String(e?.message || ''));
function btcNotes(f, status, b) {
  const pub = S.key.pubHex, mine = BNOTES.pub === pub;
  if (!mine || (!BNOTES.bridged && !BNOTES.loading && !BNOTES.err)) loadBridgedHere().then(() => { if (f.isConnected) rerender('btc'); });
  const toks = (b?.held || []).filter((a) => BTC_TOKENS[a.id] && a.notes?.length);
  const bridged = mine ? BNOTES.bridged || [] : [];
  const satsFor = (need) => !b || b.got < 1 || b.sats >= need;
  const noteLi = (a, n) => html`<label class="pick"><input type="radio" name="bn-${a.id.slice(0, 8)}" value="${noteKey(n)}" data-bnpick="${a.id}" ${BNOTES.pick[a.id] === noteKey(n) ? 'checked' : ''}><span><b class="num">${fmt(n.amount, a.decimals, 8)} ${a.ticker}</b> · <a href="${MEMPOOL}/tx/${n.txid}" target="_blank" rel="noopener">${short(n.txid, 6)} ↗</a>${n.confirmed ? '' : ' · waiting for its confirmation'}</span></label>`;
  mount(f, html`
    ${toks.length ? toks.map((a) => {
      const ready = a.notes.filter((n) => n.confirmed), pick = a.notes.find((n) => noteKey(n) === BNOTES.pick[a.id]);
      return html`<div class="blk" data-bnasset="${a.id}">
        <div class="lbl"><span>${a.ticker}</span><span>${fmt(a.balance, a.decimals, 8)} in ${a.notes.length} note${a.notes.length === 1 ? '' : 's'}</span></div>
        ${a.notes.map((n) => noteLi(a, n))}
        <div class="amt"><input id="bn-amt-${a.id}" data-bnamt="${a.id}" inputmode="decimal" placeholder="Amount to split off" autocomplete="off" aria-label="Amount to split off from the picked ${a.ticker} note"><span class="u">${a.ticker}</span></div>
        <div class="brr-a"><button class="btn ghost" type="button" data-bnsplit="${a.id}" ${pick ? '' : 'disabled'}>Split</button>${ready.length > 1 ? html`<button class="btn ghost" type="button" data-bncombine="${a.id}">Combine ${Math.min(ready.length, NOTES_MAX)} notes</button>` : ''}</div>
      </div>`;
    }) : html`<p class="note">${b?.got >= 2 ? 'No TAC or tETH notes at this key’s Bitcoin address yet.' : 'Reading your notes…'}</p>`}
    ${bridged.length ? html`<div class="blk"><div class="lbl sep"><span>Bridged to Bitcoin</span></div>
      <p class="note">These sit at your Taproot address. Move one to your Bitcoin address to send, split, combine or swap it.${satsFor(MOVE_SATS) ? '' : ` A move needs about ${Number(MOVE_SATS).toLocaleString('en-US')} sats there for its fees.`}</p>
      ${bridged.map((n) => { const tk = BTC_TOKENS[n.aid]; return html`<div class="kv"><span>${n.amount == null ? `${tk}, amount not readable yet` : `${fmt(BigInt(n.amount), 8, 8)} ${tk}`}${n.confirmed ? '' : ' · waiting for its confirmation'}</span><button class="btn ghost" type="button" data-bnmove="${n.txid}" data-bnaid="${n.aid}" ${n.confirmed && n.amount != null ? '' : 'disabled'}>Move</button></div>`; })}</div>`
      : mine && BNOTES.err ? html`<p class="note">Could not read the notes bridged to Bitcoin. <button class="link" type="button" id="bn-re">Try again</button></p>` : ''}
    ${toks.length && !satsFor(ASSET_SEND_SATS) ? html`<p class="note warn">Splitting or combining needs about ${Number(ASSET_SEND_SATS).toLocaleString('en-US')} sats at your Bitcoin address for its fees. Add some from Receive.</p>` : ''}`);
  $$('[data-bnpick]', f).forEach((x) => x.onchange = () => { BNOTES.pick[x.dataset.bnpick] = x.value; rerender('btc'); });
  const re = $('#bn-re', f);
  if (re) re.onclick = () => busy(re, () => loadBridgedHere(true).then(() => rerender('btc')));
  const self = (a, ns, amount, label) => { say(status, `${label}…`); return toSelf(pub, a.id, ns, amount).then((r) => r.txid); };
  const done = async (txid, label) => {
    actBtc(txid, label); BNOTES.pick = {};
    say(status, html`<span class="ok">✓ ${label}.</span> ${txid ? html`<a href="${MEMPOOL}/tx/${txid}" target="_blank" rel="noopener">${short(txid, 6)} ↗</a> ` : ''}It shows here once Bitcoin confirms it.`);
    await loadBtc(true).catch(() => {}); rerender('btc');
  };
  const fail = (e) => sayErr(status, satsShort(e) ? new Error('Not enough BTC at your Bitcoin address for this and its fee. Add some from Receive.') : e);
  $$('[data-bnsplit]', f).forEach((x) => x.onclick = () => busy(x, async () => {
    const a = toks.find((t) => t.id === x.dataset.bnsplit), n = a?.notes.find((m) => noteKey(m) === BNOTES.pick[a.id]);
    const v = a && parseUnits($(`[data-bnamt="${a.id}"]`, f)?.value || '', a.decimals);
    if (!n) return sayErr(status, new Error('Pick the note to split first.'));
    if (!n.confirmed) return sayErr(status, new Error('That note is waiting for its Bitcoin confirmation. Split it once it has one.'));
    if (!v || v >= n.amount) return sayErr(status, new Error(`Split off less than the note holds (${fmt(n.amount, a.decimals, 8)} ${a.ticker}).`));
    try { await done(await self(a, [n], v, `Splitting ${fmt(v, a.decimals, 8)} ${a.ticker} off`), `Split ${fmt(v, a.decimals, 8)} ${a.ticker} off a note`); } catch (e) { fail(e); }
  }));
  $$('[data-bncombine]', f).forEach((x) => x.onclick = () => busy(x, async () => {
    const a = toks.find((t) => t.id === x.dataset.bncombine), ns = (a?.notes || []).filter((n) => n.confirmed).sort((p, q) => (q.amount > p.amount ? 1 : -1)).slice(0, NOTES_MAX);
    if (ns.length < 2) return;
    const sum = ns.reduce((s, n) => s + n.amount, 0n);
    try { await done(await self(a, ns, null, `Combining ${ns.length} ${a.ticker} notes`), `Combined ${ns.length} notes into ${fmt(sum, a.decimals, 8)} ${a.ticker}`); } catch (e) { fail(e); }
  }));
  $$('[data-bnmove]', f).forEach((x) => x.onclick = () => busy(x, async () => {
    const aid = x.dataset.bnaid, tk = BTC_TOKENS[aid], n = bridged.find((m) => m.txid === x.dataset.bnmove && m.aid === aid);
    try {
      const r = await withKey((t) => t.moveBridgedNote({ txid: n.txid, assetIdHex: aid, onProgress: (st) => say(status, st === 'reveal-start' ? 'Sending the second transaction…' : 'Sending the first transaction…') }), pub);
      BNOTES.at = 0;
      await done(r?.revealTxid || r?.txid || null, `Moved ${n.amount == null ? tk : `${fmt(BigInt(n.amount), 8, 8)} ${tk}`} to your Bitcoin address`);
      loadBridgedHere(true).then(() => rerender('btc'));
    } catch (e) { fail(e); }
  }));
}
function btcReceive(f, status, b) {
  const plain = plainAddr() || b?.addr || null;
  if (!plain) loadPlain().then(() => { if (f.isConnected) rerender('btc'); }).catch(() => {});
  mount(f, html`
    ${keyRow('Bitcoin address', plain, 'Bitcoin address', 'From any wallet or exchange. What arrives here is public. This is the address that pays the fees of a bridge to Bitcoin.', { id: true, qr: true })}
    ${keyRow('Tacit address', S.key.tacit, 'Tacit address', 'From other Tacit wallets only: BTC arrives as a silent payment, and TAC with its amount hidden. An ordinary wallet or an exchange cannot send to it.', { fold: 90, id: true })}
    ${keyRow('Public key', S.key.pubHex, 'Public key', 'The key both addresses are made from, for a Send box that asks for a key.')}
    ${keyRow('Silent payments', BTC.sp, 'Silent payment address', 'From any wallet that sends silent payments (BIP‑352).', { fold: 90, id: true })}
    <div class="lbl sep"><span>Got a payment link?</span></div>
    <div class="amt text"><input id="bt-chk" placeholder="Payment link or transaction id" autocomplete="off" spellcheck="false" autocapitalize="off" autocorrect="off" aria-label="Payment link"><button class="link" type="button" id="bt-chk-go">Check</button></div>
    <p class="note">Silent and shielded payments are found from the link their sender shares. Shielded TAC is also found by a scan. <button class="link" type="button" id="bt-scan">Scan now</button></p>`);
  const pub = S.key.pubHex;
  if (!BTC.sp) withKey((t) => t.walletSilentPaymentAddress()).then((sp) => { if (S.key?.pubHex !== pub) return; BTC.sp = sp; if (f.isConnected) rerender('btc'); }).catch(() => {});
  const go = $('#bt-chk-go'), scan = $('#bt-scan');
  const run = (raw) => busy(go, async () => { try { await checkBtcPayment(raw, status); rerender('btc'); } catch (e) { sayErr(status, e); } });
  go.onclick = () => run($('#bt-chk').value);
  scan.onclick = () => busy(scan, async () => { await lookForShielded(status); rerender('btc'); });
  if (BTC.check) { const c = BTC.check; BTC.check = null; run(`#${c.kind}=${c.txid}`); }
}
async function checkBtcPayment(raw, status) {
  const s = String(raw || '').trim(), m = s.match(/[#&?](sp|st)=([0-9a-fA-F]{64})/) || s.match(/^()([0-9a-fA-F]{64})$/);
  if (!m) throw new Error('Paste a payment link or a 64-character transaction id.');
  const txid = m[2].toLowerCase(), kind = m[1] || null;
  say(status, `Checking ${short(txid, 8)}…`);
  const { sats, tokens } = await withKey(async (t) => {
    let sats = 0n, tokens = [];
    if (kind !== 'st') {
      try { for (const x of await t.discoverSilentPaymentFromTxid(txid)) sats += BigInt(x.sats || 0); }
      catch (e) {
        if (/missing or malformed/.test(e?.message || '')) throw new Error('That transaction was not found on Bitcoin.');
        if (/not fully indexed/.test(e?.message || '')) throw new Error('That transaction is not indexed yet. Try again in a minute.');
        if (kind === 'sp') throw e;
      }
    }
    if (!sats && kind !== 'sp') tokens = await t.discoverStealthFromTxid(txid, { merge: true }).catch((e) => {
      if (!/missing or malformed/.test(e?.message || '')) throw e;
      if (kind === 'st') throw new Error('That transaction was not found on Bitcoin yet, or is not a shielded transfer. Try again in a minute.');
      return [];
    });
    try { t.invalidateHoldingsCache?.(); } catch {}
    return { sats, tokens };
  });
  await loadBtc(true).catch(() => {});
  if (sats) say(status, html`<span class="ok">Found ${fmt(sats, 8, 8)} BTC for you.</span>`);
  else if (tokens.length) say(status, html`<span class="ok">Found ${tokens.map((x) => { const id = String(x.assetIdHex).toLowerCase(), a = BTC.held.find((h) => h.id === id), tac = id === TAC_BTC_ID; return `${fmt(BigInt(x.amount), a?.decimals ?? (tac ? 8 : 0), 4)} ${a?.ticker || (tac ? 'TAC' : 'units')}`; }).join(' + ')} for you.</span>`);
  else say(status, 'That payment is not addressed to this wallet.');
}
const listOr = (xs) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} or ${xs.at(-1)}`);
function capText(day) {
  const eff = [...PGM.rateCap].reverse().find((e) => e.fromDay <= day), next = PGM.rateCap.find((e) => e.fromDay > day);
  const lim = (e) => (e.wei ? `${nfmt({ maximumFractionDigits: 4 }).format(Number(e.wei / 10n ** 12n) / 1e6)} TAC per point` : null);
  const now = eff && lim(eff), later = next && `${lim(next) || 'no limit'} from ${dayShort(next.fromDay)}`;
  return now ? (later ? `${now}, ${later}` : now) : later && lim(next) ? later : null;
}
const ACT_NAME = { wrap: 'Tacit-pool wrap', evmpooldeposit: 'ETH-pool deposit', zswapeth: 'ETH swap', weiname: '.wei name', cbtcmint: 'cBTC bond', cusdmint: 'cUSD loan', pmbet: 'bet', pmcreate: 'market', holding: 'ETH held in the private pools', cbtchold: 'a bond kept posted' };
const PT_ACTS = { wrap: ['Wrapped ETH into the Tacit pool', 'ETH'], evmpooldeposit: ['Deposited ETH', 'ETH'], zswapeth: ['Swapped ETH', 'ETH'],
  weiname: ['Registered a .wei name', 'ETH'], cbtcmint: ['Posted a bond toward cBTC', 'wstETH'], cbtchold: ['Kept a cBTC bond posted'], cusdmint: ['Borrowed cUSD'], pmbet: ['Bet with ETH', 'ETH'], pmcreate: ['Opened a market'] };
const dayLeft = () => { const s = 86400 - (now() % 86400), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60); return h ? `${h} h ${m} min` : `${Math.max(1, m)} min`; };
const dayName = (d) => { const t = utcDay(now()); return d === t ? 'Today' : d === t - 1 ? 'Yesterday' : dfmt(new Date(d * 864e5), { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }); };
async function lookPoints(text) {
  const raw = String(text || '').trim(), addr = raw.toLowerCase();
  PTS.draft = raw;
  if (!/^0x[0-9a-f]{40}$/.test(addr)) { PTS.look = { addr: raw, err: raw ? 'That is not an address: it is 0x and 40 letters or digits.' : 'Paste an address.' }; rerender('pts'); return; }
  PTS.look = { addr, busy: true }; rerender('pts');
  try {
    if (!PTS.board) await loadPoints().catch(() => {});
    const row = await readRow(addr, 'Looked up');
    if (PTS.look?.addr !== addr) return;
    rankRows([row], PTS.board, PTS.day);
    PTS.look = row.read ? { addr, row } : { addr, err: 'Could not read that address. Try again.' };
  } catch { if (PTS.look?.addr === addr) PTS.look = { addr, err: 'Could not read that address. Try again.' }; }
  rerender('pts');
}
async function claimPoints(r) {
  const p = r.claim.proof, data = '2f52ebb7' + word(BigInt(r.claim.cumulativeAmount)) + word(64) + word(p.length) + p.map((h) => strip(h).padStart(64, '0')).join('');
  await ethCall(DISTRIBUTOR, data, { from: r.addr });
  return sendTx({ to: DISTRIBUTOR, data, via: r.addr === S.acct?.address.toLowerCase() ? 'tacit' : 'wallet', label: `Claim ${tacShort(r.owed)} TAC from points` });
}
function pulse() {
  const p = PTS.pulse;
  if (!p) return '';
  const per = p.total > 0 ? Number(p.pot / 10n ** 12n) / 1e6 / p.total * 1000 : null;
  const rates = (p.groups || []).filter((g) => Number(g.points) > 0 && /^\d+$/.test(String(g.paidWei))).map((g) => Number(BigInt(g.paidWei) / 10n ** 12n) / 1e6 / Number(g.points) * 1000);
  const tacN = (x) => nfmt({ maximumFractionDigits: x < 10 ? 2 : 1 }).format(x);
  const range = rates.length > 1 && Math.max(...rates) / Math.min(...rates) > 1.2 ? `${tacN(Math.min(...rates))} to ${tacN(Math.max(...rates))} TAC` : null;
  return html`<div class="pulse">
    <div class="kv"><span>Today’s pot</span><b>${fmt(p.pot, 18, p.pot >= 100n * 10n ** 18n ? 0 : 2)} TAC · day ${p.day} of ${ptsDays()}${p.pot + 10n ** 15n < PGM.dayWei ? html` <small class="mute">at the limit per point</small>` : ''}</b></div>
    <div class="kv"><span>Points so far today</span><b>${ptsFmt(p.total)}${p.n ? ` · ${p.n.toLocaleString('en-US')} taking part` : ''}</b></div>
    <div class="kv"><span>So far, each 1,000 points earn</span><b${range ? html` title="A day’s pot is split between kinds of activity, so a point earns more or less by what earned it"` : ''}>${range || (per == null ? 'nothing yet' : `${tacN(per)} TAC`)}</b></div></div>`;
}
function leaderboard(connected) {
  if (PTS.rows == null) return '';
  const day = PTS.view === 'day' && PTS.day ? PTS.day : null, lb = day ? day.rows : PTS.board;
  if (!lb) return html`<div class="lbl" id="pts-lb"><span>Leaderboard</span></div><p class="note err">The leaderboard could not be read. <button class="link" type="button" data-retry="points">Try again</button></p>`;
  const mine = new Set(connected ? pointsWho().map(([a]) => a) : []), whole = !day && lb.length < PTS_BOARD ? lb.reduce((s, e) => s + e.points, 0) : 0;
  const line = (e, i) => {
    const a = String(e.address).toLowerCase(), me = mine.has(a);
    const sub = day ? `${fmt(e.tacWei != null && /^\d+$/.test(String(e.tacWei)) ? BigInt(e.tacWei) : tacOf(PTS.pulse?.pot || 0n, e.points, day.totalPoints), 18, 2)} TAC` : whole ? sharePct(e.points / whole) : '';
    return html`<li class="${me ? 'me' : ''}" data-a="${a}"><span class="ptl-w"><span class="rk num">${i + 1}</span><a href="${ETHERSCAN(a)}" target="_blank" rel="noopener">${flatAddr(a)}</a>${me ? ' · you' : ''}</span><span class="ptl-r"><b class="num">${ptsFmt(e.points)}</b>${sub ? html`<small class="mute">${sub}</small>` : ''}</span></li>`;
  };
  const at = new Set([0, 1, 2, 3, 4].filter((i) => i < lb.length));
  lb.forEach((e, i) => { if (mine.has(String(e.address).toLowerCase())) for (const j of [i - 1, i, i + 1]) if (j >= 0 && j < lb.length) at.add(j); });
  const idx = [...at].sort((a, b) => a - b);
  const taking = day ? (typeof day.taking === 'number' ? day.taking : null) : lb.length >= PTS_BOARD ? `${PTS_BOARD}+` : lb.length;
  return html`
    <div class="lbl" id="pts-lb"><span>Leaderboard</span><span>${taking == null ? '' : `${typeof taking === 'number' ? taking.toLocaleString('en-US') : taking} `}${day ? 'taking part today' : 'taking part'}</span></div>
    ${PTS.day ? segSub('plv', day ? 'day' : 'all', [['all', 'All time'], ['day', 'Today']]) : ''}
    ${lb.length ? html`<ol class="ptl lb">${idx.map((i, k) => html`${k && i - idx[k - 1] > 1 ? html`<li class="gap" aria-hidden="true">⋯</li>` : ''}${line(lb[i], i)}`)}</ol>
    ${lb.length > idx.length ? html`<details class="lockmore ptlog"><summary>The whole board</summary>
      <div class="amt text"><input id="pl-q" placeholder="Find an address" autocomplete="off" spellcheck="false" autocapitalize="off" autocorrect="off" aria-label="Find an address in the board"></div>
      <ol class="ptl lb" id="pl-all">${lb.map(line)}</ol><p class="note" id="pl-none" hidden>No address on the board matches.</p></details>` : ''}`
      : html`<p class="note">Nobody has points ${day ? 'yet today' : 'yet'}.</p>`}
    <p class="note">${day ? 'Each address’s share of today’s pot, as it stands. ' : ''}Read ${ago(PTS.at)}. <button class="link" type="button" data-retry="points">Refresh</button></p>`;
}
function dayStrip(r) {
  if (!r.read || (!r.hist && (!r.recent.length || r.count > r.recent.length))) return '';
  const today = utcDay(now()), from = Math.max(today - 13, PGM.startDay);
  let by = r.hist;
  if (!by) {
    by = new Map();
    for (const d of r.recent) { const k = utcDay(d.block_time), e = by.get(k) || { p: 0, wei: null, settled: true }; e.p += Number(d.points || 0); by.set(k, e); }
  }
  const days = Array.from({ length: today - from + 1 }, (_, i) => ({ d: from + i, ...(by.get(from + i) || { p: 0 }) })), max = Math.max(...days.map((x) => x.p), 1);
  if (days.length < 2 || !days.some((x) => x.p > 0)) return '';
  const best = days.reduce((a, x) => (x.p > a.p ? x : a));
  const said = (x) => `${dayName(x.d)} · ${ptsFmt(x.p)} points${x.wei ? ` · ${x.settled ? '' : 'about '}${fmt(x.wei, 18, 2)} TAC` : ''}`;
  return html`<div class="ptd" role="group" aria-label="Points on each of the last ${days.length} days">
    <div class="ptd-bars">${days.map((x) => html`<button type="button" class="ptd-b${x.d === today ? ' now' : ''}" data-ptd="${said(x)}" aria-label="${said(x)}"><i style="--h:${x.p / max}"></i></button>`)}</div>
    <div class="ptd-x"><span>${dayShort(days[0].d)}</span><output class="ptd-r" data-d="Best day ${dayShort(best.d)} · ${ptsFmt(best.p)}">Best day ${dayShort(best.d)} · ${ptsFmt(best.p)}</output><span>Today</span></div></div>`;
}
function terms() {
  const last = PGM.startDay + PGM.days - 1, today = utcDay(now()), cap = capText(today);
  const w = scheduled(PGM.weights, today), names = w && Object.entries(w.e.weights).filter(([, x]) => x !== 1).map(([a, x]) => `${ACT_NAME[a] || a} ${x === 0 ? 'not counted' : `${x}×`}`);
  const cp = scheduled(PGM.caps, today), limits = cp && Object.keys(cp.e.caps).length ? `${Object.entries(cp.e.caps).map(([a, c]) => `${ACT_NAME[a] || a} counts up to ${c} ETH a day`).join(', ')}, all chains together${cp.from ? ` from ${dayShort(cp.from)}` : ''}` : null;
  const sc = scheduled(PGM.shareCaps, today), shares = sc && Object.keys(sc.e.caps).length ? `${Object.entries(sc.e.caps).map(([a, c]) => `${ACT_NAME[a] || a} points together take at most ${pct(c)} of a day’s ${potTac()} TAC`).join(', ')}; the rest is split as before${sc.from ? ` (from ${dayShort(sc.from)})` : ''}` : null;
  const bdNow = [...PGM.budgets].reverse().find((e) => e.fromDay <= today), bdNext = PGM.budgets.find((e) => e.fromDay > today);
  const perPoint = (x) => `${nfmt({ maximumFractionDigits: 4 }).format(Number(x / 10n ** 12n) / 1e6)} TAC per point`;
  const WORDS = { holding: 'holding ETH in the private pools', cbtchold: 'keeping bonds posted', zswapeth: 'buying TAC', cusdmint: 'borrowing', cbtcmint: 'posting bonds', weiname: '.wei names', pmbet: 'bets', pmcreate: 'markets', wrap: 'wrapping ETH', evmpooldeposit: 'pool deposits', btcpool: 'the Bitcoin pool' };
  const andList = (xs) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);
  const reserved = [bdNow, bdNext].filter((e) => e?.groups?.length).map((e) => `${e.fromDay > today ? `From ${dayShort(e.fromDay)}: ` : ''}${e.groups.map((g) => `${pct(g.share)}${g.capped ? ' at most' : ''} of a day’s ${potTac()} TAC for ${andList(g.activities.map((a) => WORDS[a] || a))}${g.wei ? ` (up to ${perPoint(g.wei)}${g.top ? `, and ${perPoint(g.top).replace(' TAC per point', '')} when the day has TAC left over` : ''})` : ''}`).join(' and ')}. ${e.groups.some((g) => g.capped) ? 'A share that is not used is not paid out.' : 'A share that is not used goes back to everyone else.'}`).join(' ') || null;
  const mix = names?.length ? `${names.join(', ')}${w.from ? ` from ${dayShort(w.from)}` : ''}` : null;
  const g = scheduled(PGM.engagement, today), sp = g?.e.spec;
  const week = sp ? `${pct(sp.kindStep)} more for each other kind of activity in the past 7 days${sp.maxKinds ? ` (up to ${pct(sp.kindStep * sp.maxKinds)}${sp.minPoints ? `; a kind counts once it has earned ${rateStr(sp.minPoints)} points that week` : ''})` : ''}, and ${pct(sp.returnStep)} more for activity on more than one day${g.from ? `, from ${dayShort(g.from)}` : ''}` : null;
  const counting = names?.length || sp ? 'each activity at its weight, times the week’s multiplier. A day’s pot is split by these counted points; the all-time total is points as scored' : null;
  const bonds = [
    PGM.bondHoldFromDay && w?.e.weights.cbtcmint !== 0 ? `a cBTC bond counts if cBTC has been minted against it and it is still posted when its day is finished, shortly after midnight UTC${PGM.bondHoldFromDay > today ? `, from ${dayShort(PGM.bondHoldFromDay)}` : ''}` : null,
    PGM.rates.cbtchold ? `a bond on a Bitcoin lock earns a flat ${rateStr(PGM.rates.cbtchold)} points per wstETH for each further day it stays posted, credited when the day is finished and counted as activity for the week${PGM.cbtcHoldFromDay > today ? `, from ${dayShort(PGM.cbtcHoldFromDay)}` : ''}` : null,
  ].filter(Boolean).join('; ') || null;
  const kv = (k, v) => html`<div class="kv"><span>${k}</span><b>${v}</b></div>`;
  return html`<details class="lockmore ptlog"><summary>Terms</summary>
    ${kv('Runs', `${dayShort(PGM.startDay)} to ${dayShort(last)} (UTC), ${PGM.days} days`)}
    ${kv('Each day’s pot', `up to ${potTac()} TAC, of ${fmt(PGM.totalWei, 18, 0)} in all`)}
    ${cap ? kv('Limit', cap) : ''}
    ${counting ? kv('Counting', counting) : ''}
    ${mix ? kv('Weights', mix) : ''}
    ${limits ? kv('Per address', limits) : ''}
    ${shares ? kv('Share limit', shares) : ''}
    ${reserved ? kv('Reserved', reserved) : ''}
    ${week ? kv('Each week', week) : ''}
    ${bonds ? kv('Bonds', bonds) : ''}
    ${kv('Points go to', 'the address that sent the transaction')}
    ${kv('Claim', 'any time after a day is finished, shortly after midnight UTC')}</details>`;
}
function retention() {
  try {
    const st = HOLD.status, to = holdPayTo();
    if (!st?.enabled || !to) return '';
    const rows = HOLD.logRows, on = holdConsented(), size = (b) => fmt(b, 18, 2);
    return html`<div class="lbl"><span>Retention</span></div>
    <p class="note">ETH you leave in the private pools earns ${st.rate ? `${st.rate.toLocaleString('en-US')} points per ETH` : 'points'} for each day: at a random moment of the day, the size of each note you hold is proven on this device, and the points go to ${viewAddr(to)}.${st.buckets.length ? ` Sizes: ${listOr(st.buckets.map(size))} ETH.` : ''}</p>
    <p class="note">The points service learns which of your accounts holds how many private notes of which sizes each day, and when that stops; it does not learn which notes. The first time, about 31 MB of proving files are downloaded.</p>
    ${rows?.length ? html`<ul class="ptl">${rows.map((x) => html`<li><span class="ptl-w">${x.credited ? `${size(BigInt(x.bucketWei))} ETH held` : x.error ? `Not counted: ${x.error}` : `${size(BigInt(x.bucketWei))} ETH held, already counted`}<span class="ptl-m">${ptChain(x.chainId) ? chainTag(x.chainId || 1) : 'chain'} · ${dayShort(Number(x.epoch) || 0)}</span></span><b class="num">${x.credited || x.points ? `+${ptsFmt(Number(x.points) || 0)}` : ''}</b></li>`)}</ul>` : rows && on ? html`<p class="note">Nothing proven yet. The page does this once a day while your pool balance is read, or press below.</p>` : ''}
    ${S.key ? html`<button class="btn" type="button" id="hold-now" ${HOLD.running ? 'disabled' : ''}>${HOLD.running ? 'Proving…' : on ? 'Prove what I hold now' : 'Count my private ETH'}</button>
      ${on ? html`<p class="note">This browser does it by itself once a day. <button class="link" type="button" id="hold-off">Turn that off</button></p>` : ''}` : html`<p class="note">Open your Tacit wallet to count what it holds in the private pools.</p>`}
    <div class="status" role="status" id="hold-status">${HOLD.step || HOLD.err}</div>`;
  } catch { return ''; }
}
render.pts = () => {
  const el = $('#pts-body'), connected = !!(S.wallet || S.key), on = now() < ptsEnd();
  const rows = PTS.rows && PTS.key === pointsWho().map(([a]) => a).join() ? PTS.rows : null;
  if (!rows) loadPoints().then(() => rerender('pts')).catch(() => {});
  const nextTier = (r) => {
    const n = r.held == null ? null : PGM.tiers.find(([min]) => r.held < BigInt(min) * 10n ** 18n);
    return !n ? '' : html`<p class="note">${r.held > 0n ? `${fmt(r.held, 18, 2)} public TAC here. ` : ''}Hold ${n[0].toLocaleString('en-US')} public TAC here through a day and what it does next earns ${n[1]}×. <button class="link" type="button" data-earn="buy">Buy TAC</button></p>`;
  };
  const standing = (r) => {
    const lb = PTS.board, i = r.rank - 1, out = [];
    if (r.rank > 0 && lb && lb[i]) {
      if (i === 0 && lb[1]) out.push(html`<div class="kv"><span>Ahead of #2 by</span><b>${ptsFmt(r.points - lb[1].points)} points</b></div>`);
      else if (i > 0) out.push(html`<div class="kv"><span>To reach #${r.rank - 1}</span><b>${ptsFmt(Math.max(1, Math.ceil(lb[i - 1].points - r.points)))} points</b></div>`);
    }
    const s = r.since;
    if (s) {
      const dp = r.points - s.p, dk = s.k > 0 && r.rank > 0 ? s.k - r.rank : 0;
      if (dp >= 0.5 || dk) out.push(html`<div class="kv"><span>Since ${dayShort(s.d)}</span><b>${dp >= 0.5 ? `+${ptsFmt(dp)} points` : 'no new points'}${dk ? ` · ${dk > 0 ? 'up' : 'down'} ${Math.abs(dk)} place${Math.abs(dk) === 1 ? '' : 's'}` : ''}</b></div>`);
    }
    return out;
  };
  const history = (r) => {
    if (!r.recent.length) return '';
    const days = new Map();
    for (const d of r.recent) { const k = utcDay(d.block_time); if (!days.has(k)) days.set(k, []); days.get(k).push(d); }
    return html`<details class="lockmore ptlog"><summary>Points by day</summary><ul class="ptl">${[...days].map(([k, list]) => html`
      <li class="day"><span>${dayName(k)}</span><b class="num">+${ptsFmt(r.hist ? (r.hist.get(k)?.p ?? 0) : list.reduce((s, d) => s + Number(d.points || 0), 0))}${r.hist && !(r.hist.get(k)?.p > 0) ? html` <small class="mute">not counted</small>` : ''}${r.hist?.get(k)?.raw > 0 && r.hist.get(k).p / r.hist.get(k).raw > 1.005 ? html` <small class="mute">${Math.round(r.hist.get(k).p / r.hist.get(k).raw * 100) / 100}×</small>` : ''}${r.hist?.get(k)?.wei ? html` <small class="mute">${r.hist.get(k).settled ? '' : 'about '}${fmt(r.hist.get(k).wei, 18, 2)} TAC</small>` : ''}</b></li>${list.map((d) => {
        const [what, unit] = PT_ACTS[d.activity] || ['Activity'], c = ptChain(d.chain_id), amt = unit && big(d.amount_wei);
        return html`<li><span class="ptl-w">${what}${c && c.chainId && c.chainId !== 1 ? html` ${chainMark(c.chainId)}` : ''}<span class="ptl-m">${amt ? `${fmt(amt, 18, 4)} ${unit} · ` : ''}${ago(Number(d.block_time) * 1000)}${d.tac_boost > 1 ? ` · ${d.tac_boost}× holder` : ''}${c && d.tx_hash && d.activity !== 'cbtchold' ? html` · ${txLink(d.tx_hash, c.explorer)}` : ''}</span></span><b class="num">+${ptsFmt(d.points)}</b></li>`;
      })}`)}</ul>${r.count > r.recent.length ? html`<p class="note">The latest ${r.recent.length} of ${r.count.toLocaleString('en-US')} are listed.</p>` : ''}</details>`;
  };
  const card = (r, i, watch = false) => html`
      <div class="pt">
        <div class="bal"><div><div class="v num">${ptsFmt(r.points)}</div><div class="u">points · ${r.label} ${viewAddr(r.addr)}</div></div>
          <div class="side">${!r.read ? html`<span class="err">unavailable</span><br><button class="link" type="button" data-retry="points">Try again</button>`
            : r.rank ? html`rank<br><b class="num">#${r.rank.toLocaleString('en-US')}</b>${r.dayRank ? html`<br>#${r.dayRank} today` : ''}` : r.rank === 0 && r.points > 0 ? html`outside the<br>top ${PTS_BOARD}` : r.points ? '' : 'none yet'}</div></div>
        ${r.owed > 0n ? (watch ? html`<div class="kv"><span>To claim</span><b>${tacShort(r.owed)} TAC</b></div><p class="note">Connect this address to claim it.</p>`
          : html`<button class="btn" type="button" data-claim="${i}">Claim ${tacShort(r.owed)} TAC</button>`) : r.owedUnread && !watch ? html`<p class="note err">What this address can claim could not be read. <button class="link" type="button" data-retry="points">Try again</button></p>` : ''}
        ${dayStrip(r)}
        ${r.read && on ? html`<div class="kv"><span>Today</span><b>${r.todayPts > 0 ? `${ptsFmt(r.todayPts)} points · ${sharePct(r.share)} · about ${fmt(r.today, 18, 2)} TAC` : 'nothing yet'}</b></div>` : ''}
        ${r.read ? standing(r) : ''}
        ${r.boost > 1 ? html`<div class="kv"><span>Holder boost at last activity</span><b>${r.boost}×</b></div>` : ''}
        ${r.read && on && r.tod?.factor > 1 ? html`<div class="kv"><span>This week</span><b>${r.tod.factor}× · ${r.tod.kinds} kind${r.tod.kinds === 1 ? '' : 's'} of activity · ${r.tod.activeDays} day${r.tod.activeDays === 1 ? '' : 's'}</b></div>` : ''}
        ${r.settled > 0n ? html`<div class="kv"><span>Earned from finished days</span><b>${fmt(r.settled, 18, 2)} TAC</b></div>` : ''}
        ${r.claimed > 0n ? html`<div class="kv"><span>Claimed so far</span><b>${fmt(r.claimed, 18, 2)} TAC</b></div>` : ''}
        ${r.read && on && !watch ? nextTier(r) : ''}
        ${history(r)}
      </div>`;
  const look = () => {
    const L = PTS.look;
    return html`<div class="lbl"><span>Look up an address</span></div>
      <form class="amt text" id="pl-look-f"><input id="pl-look" placeholder="0x…" value="${PTS.draft ?? L?.addr ?? ''}" autocomplete="off" spellcheck="false" autocapitalize="off" autocorrect="off" aria-label="An address to look up" aria-invalid="${L?.err ? 'true' : 'false'}"><span class="u"><button class="link" type="submit" ${L?.busy ? 'disabled' : ''}>${L?.busy ? 'Reading…' : 'Look up'}</button></span></form>
      ${L?.err ? html`<p class="note err" role="alert">${L.err}</p>` : L?.busy ? html`<div class="pt"><div class="bal"><div><div class="v"><span class="sk" style="--w:5ch"></span></div><div class="u">points · ${viewAddr(L.addr)}</div></div></div></div>` : L?.row ? card(L.row, -1, true) : ''}`;
  };
  mount(el, html`
    <p class="lede-s">Every day through ${dayShort(PGM.startDay + PGM.days - 1)} (UTC), up to ${potTac()} TAC is split by that day’s points${capText(utcDay(now())) ? `, at most ${capText(utcDay(now()))}` : ''}.${on ? ` Today’s split closes in ${dayLeft()}; its TAC is yours to claim once the day is finished.` : ' Claim any time.'}</p>
    ${on ? pulse() : ''}
    ${!connected ? gate('Points go to the address that made each transaction. Connect it to see yours, or open your Tacit wallet.', 'Connect wallet', 'pts-connect')
      : rows ? rows.map((r, i) => card(r, i)) : pointsWho().map(([, label]) => html`
      <div class="pt"><div class="bal"><div><div class="v"><span class="sk" style="--w:5ch"></span></div><div class="u">points · ${label}</div></div>
        <div class="side"><span class="sk" style="--w:8ch"></span><br><span class="sk" style="--w:11ch"></span></div></div></div>`)}
    ${connected ? retention() : ''}
    ${look()}
    ${leaderboard(connected)}
    <div class="lbl"><span>Earn more</span></div>
    <div class="opts">${earnRows().map(([go, ic, t, m]) => html`<button class="opt" type="button" data-earn="${go}"><span class="opt-t"><svg class="tk sm" aria-hidden="true"><use href="#tk-${ic}"/></svg>${t}</span><span class="opt-m">${m}</span></button>`)}
      <a class="opt" href="${ZSWAP}" target="_blank" rel="noopener"><span class="opt-t"><svg class="tk sm" aria-hidden="true"><use href="#tk-eth"/></svg>Swap or bet with ETH on zSwap ↗</span><span class="opt-m">${PGM.rates.zswapeth ? `${rateStr(PGM.rates.zswapeth)} per ETH` : ''}</span></a></div>
    ${connected ? html`<div class="lbl"><span>Get a .wei name</span></div>
    <div id="wei-form"></div>` : ''}
    ${terms()}
    <p class="note"><a href="/rewards/">Farms, the airdrop and every other way to earn TAC →</a></p>
    <p class="note">Early activity counts up to ${PGM.early.max}×. ${PGM.tiers.length ? `Holding ${listOr(PGM.tiers.map(([m]) => m.toLocaleString('en-US')))} public TAC at the same address through ${PGM.windowHours === 24 ? 'the past day' : `the past ${PGM.windowHours} hours`} multiplies its points by ${listOr(PGM.tiers.map(([, x]) => x))}. ` : ''}<a href="https://github.com/src-company/tacit#points-and-farms" target="_blank" rel="noopener">The program ↗</a></p>
    <div class="status" role="status" id="pts-status"></div>`);
  const status = $('#pts-status');
  if (PTS.jump && $('#pts-lb', el)) { PTS.jump = false; $('#pts-lb', el).scrollIntoView({ block: 'start' }); }
  wireConnect('pts-connect', () => rerender('pts'));
  { const f = $('#pl-look-f', el), inp = $('#pl-look', el); if (f) { inp.oninput = () => { PTS.draft = inp.value; }; f.onsubmit = (ev) => { ev.preventDefault(); lookPoints(inp.value); }; } }
  { const b = $('#hold-now', el); if (b) b.onclick = () => holdingProveNow(); const o = $('#hold-off', el); if (o) o.onclick = () => { lsKv.set(HOLD_CONSENT, '0'); rerender('pts'); }; }
  wireSub(el, 'plv', (v) => { PTS.view = v; rerender('pts'); });
  $$('[data-earn]', el).forEach((b) => b.onclick = () => openLink(b.dataset.earn));
  const q = $('#pl-q', el);
  if (q) q.oninput = () => {
    const t = q.value.trim().toLowerCase();
    let n = 0;
    for (const li of $$('#pl-all li', el)) { const hit = !t || li.dataset.a.includes(t); li.hidden = !hit; n += hit; }
    $('#pl-none', el).hidden = n > 0;
  };
  for (const box of $$('.ptd', el)) {
    const out = $('.ptd-r', box), reset = () => { out.textContent = out.dataset.d; };
    for (const b of $$('.ptd-b', box)) {
      const set = () => { out.textContent = b.dataset.ptd; };
      b.addEventListener('focus', set); b.addEventListener('click', set); b.addEventListener('blur', reset);
      b.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse') set(); });
      b.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse' && document.activeElement !== b) reset(); });
    }
  }
  $$('[data-claim]', el).forEach((b) => b.onclick = () => busy(b, async (run) => {
    try {
      let row = rows[Number(b.dataset.claim)], hash;
      try { hash = await claimPoints(row); }
      catch (e) {
        const why = revertText(e);
        if (why !== REVERTS['7ca55c77'] && why !== REVERTS['797dba54']) throw e;
        await loadPoints(true);
        row = PTS.rows?.find((x) => x.addr === row.addr);
        if (!row?.claim || !(row.owed > 0n)) { rerender('pts'); say($('#pts-status'), 'There is nothing left to claim here.'); return; }
        hash = await claimPoints(row);
      }
      say(status, html`Claiming… ${txLink(hash)}`);
      await waitTx(hash);
      await loadPoints(true); rerender('pts'); say($('#pts-status'), html`<span class="ok">Claimed.</span> ${txLink(hash)}`); toast('TAC claimed');
    } catch (e) { txFail(run, status, e); }
  }));
  if (connected) weiForm($('#wei-form'), status);
};

const WEI = { label: '' };
const utf8 = (s) => new TextEncoder().encode(s);
const kec = (hex) => bytesToHex(keccak_256(hexToBytes(hex)));
const abiStr = (s) => { const b = bytesToHex(utf8(s)); return word(b.length / 2) + b.padEnd(Math.ceil(b.length / 64) * 64, '0'); };
const weiNode = (label) => ['wei', label].reduce((n, l) => kec(n + bytesToHex(keccak_256(utf8(l)))), '0'.repeat(64));
const weiOk = (l) => l.length <= 255 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(l);
function weiCommit(label, to) {
  const secret = bytesToHex(hmac(sha256, walletPriv(), concatBytes(utf8('tacit-lite-wei-commit-v1'), utf8(label), hexToBytes(strip(to)))));
  const inner = kec(secret + addrWord(to));
  return { secret, commitment: kec(word(96) + addrWord(ZROUTER) + inner + abiStr(label)) };
}
async function weiPrice(label) {
  const id = weiNode(label);
  const [avail, fee, prem, owner] = await multicall([
    { to: WNS, data: '8f8dc386' + word(64) + word(0) + abiStr(label) },
    { to: WNS, data: 'fcee45f4' + word(utf8(label).length) },
    { to: WNS, data: '1bf1fffb' + id },
    { to: WNS, data: '6352211e' + id },
  ]);
  return { id, available: !!avail && wordAt(avail, 0) === 1n, price: (fee ? wordAt(fee, 0) : 0n) + (prem ? wordAt(prem, 0) : 0n), owner: owner ? '0x' + strip(owner).slice(24, 64) : null };
}
function weiForm(f, status) {
  if (!S.key) { mount(f, html`<p class="note">Open your Tacit wallet to register a name people can pay privately.</p>`); return; }
  mount(f, html`
    <div class="amt text"><input id="wei-name" placeholder="yourname" autocomplete="off" spellcheck="false" autocapitalize="off" autocorrect="off" aria-label="Name" value="${WEI.label}"><span class="u">.wei</span></div>
    <div class="rcpt" id="wei-rcpt" hidden></div>
    <button class="btn" type="button" id="wei-go" disabled>Register</button>
    <p class="note">The name, the account that registers it and the Tacit address it publishes are all public, and linked to each other.</p>`);
  const input = $('#wei-name'), go = $('#wei-go'), rc = $('#wei-rcpt');
  let q = null, seq = 0;
  const check = async (e) => {
    const my = ++seq;
    q = null; go.disabled = true; if (e?.isTrusted) say(status, '');
    const label = input.value.trim().toLowerCase(); WEI.label = label;
    if (!label) { rc.hidden = true; return; }
    if (!weiOk(label)) { mount(rc, html``); warn(rc, 'Letters, digits and inner hyphens only.'); return; }
    try {
      const p = await weiPrice(label);
      if (my !== seq || !input.isConnected) return;
      const mine = p.owner && S.address && p.owner.toLowerCase() === S.address.toLowerCase();
      q = { label, ...p, mine };
      mount(rc, html`<div class="kv"><span>${label}.wei</span><b>${p.available ? `${fmt(p.price, 18, 4)} ETH for a year` : mine ? 'yours' : 'taken'}</b></div>
        ${p.available || mine ? html`<div class="kv"><span>Then</span><b>anyone can pay you privately by typing ${label}.wei</b></div>` : ''}`);
      rc.hidden = false;
      go.textContent = mine ? `Publish your Tacit address on ${label}.wei` : `Register ${label}.wei`;
      go.disabled = !(p.available || mine);
      if (p.available && !mine) {
        const bal = await ethBalance();
        if (my !== seq || !input.isConnected) return;
        if (bal != null && bal < p.price) { warn(rc, lowEth()); go.disabled = true; }
      }
    } catch (err) { if (my === seq) quoteErr(rc, err); }
  };
  onEdit([input], go, check);
  if (WEI.label) check();
  go.onclick = () => busy(go, async (run) => {
    const x = q;
    if (!x) return;
    try {
      if (S.key && !ctx.UNI) await loadUnified().catch(() => {});
      const tacit = ctx.UNI && S.key ? addressFor(S.key.priv) : null, { label } = x;
      if (!tacit) throw new Error(S.key ? 'Your Tacit address did not load. Reload the page and try again.' : 'Open your Tacit wallet first.');
      const to = await payingAccount(), via = payer();
      if (!x.mine) {
        const { secret, commitment } = weiCommit(label, to);
        const chainTime = async () => Math.max(Number(wordAt(await ethCall(ADDR.multicall, SEL.timestamp).catch(() => '0x'), 0)), chainNow() - 15);
        let at = wordAt(await ethCall(WNS, '839df945' + commitment), 0);
        if (!at || BigInt(await chainTime()) > at + 86400n) {
          say(status, 'Step 1 of 2: reserving the name…');
          run.check(); await waitTx(await sendTx({ to: WNS, data: 'f14fcbc8' + commitment, via, label: `Reserve ${label}.wei` }));
          for (let i = 0; !(at = wordAt(await ethCall(WNS, '839df945' + commitment), 0)) && i < 20; i++) await sleep(3000);
          if (!at) throw new Error('The reservation landed but is not visible yet. Press Register again in a minute; it picks up from here.');
        }
        for (;;) {
          const left = Number(at) + 61 - await chainTime();
          if (left <= 0) break;
          sayLive(status, html`Step 2 of 2 in <span data-tick aria-hidden="true">${left} seconds</span><span class="sr">about a minute</span>: the wait keeps anyone from taking the name in between.`);
          await sleep(Math.min(left, 5) * 1000);
        }
        const { price, available, owner } = await weiPrice(label);
        const ours = !available && !!owner && owner.toLowerCase() === to.toLowerCase();
        if (!available && !ours) throw new Error('Someone registered that name first.');
        if (!ours) {
          say(status, 'Step 2 of 2: registering…');
          const calls = ['2cb9f974' + word(96) + secret + addrWord(to) + abiStr(label), 'cb019b84' + addrWord('0x' + '0'.repeat(40)) + word(0) + word(0) + addrWord(to)];
          let off = calls.length * 32, heads = '', tails = '';
          for (const c of calls) { heads += word(off); const t = word(c.length / 2) + c.padEnd(Math.ceil(c.length / 64) * 64, '0'); tails += t; off += t.length / 2; }
          run.check();
          await waitTx(await sendTx({ to: ZROUTER, data: 'ac9650d8' + word(32) + word(calls.length) + heads + tails, value: price, via, label: `Register ${label}.wei` }));
          toast(`${label}.wei is yours`);
        }
      }
      say(status, `Publishing your Tacit address on ${label}.wei…`);
      const key = 'finance.tacit', rec = abiStr(key);
      run.check();
      await waitTx(await sendTx({ to: WNS, data: '3fb24782' + weiNode(label) + word(96) + word(96 + rec.length / 2) + rec + abiStr(tacit), via, label: `Publish your Tacit address on ${label}.wei` }));
      say(status, html`<span class="ok">${label}.wei now pays you privately.</span>`);
      WEI.label = ''; q = null; clearField(input); rc.hidden = true; run.release(true);
      loadPoints(true).then(() => rerender('pts')).catch(() => {});
    } catch (e) { txFail(run, status, e); check().catch(() => {}); }
  });
}
const logoPair = (a, b, cls = 'md') => html`<span class="pair"><svg class="tk ${cls}" aria-hidden="true"><use href="#${LOGO[a]}"/></svg><svg class="tk ${cls}" aria-hidden="true"><use href="#${LOGO[b]}"/></svg></span>`;
const poolDepthEth = (p) => { const w = poolWorth(p); return w > 0 ? BigInt(Math.round(w * 1e18)) : null; };
const depthText = (wei) => (wei == null ? '' : ` · ${wei < 10n ** 16n ? 'under 0.01' : fmt(wei, 18, 2)} ETH deep`);
const lpWorth = (p, shares) => {
  const r = p?.reserves || {}, total = big(r.lpTotalShares), n = big(shares), other = String(p?.pair || '').split('/').find((k) => k !== 'cETH') || '';
  if (!total || n == null || String(r.assetA).toLowerCase() !== CETH_ID) return null;
  return `${fmt(n * BigInt(r.reserveA) / total, 8, 5)} tETH + ${fmt(n * BigInt(r.reserveB) / total, 8, /BTC/.test(other) ? 6 : 2)} ${shownAs(other)}`;
};
const priceFmt = (v) => (v >= 100 ? Math.round(v).toLocaleString('en-US') : sig(v, 4));
const aprRow = (a) => (a == null ? '' : html`<div class="kv"><span>APR now</span><b>${aprLong(a)}</b></div>
  <p class="note">At today’s TAC price and stake. It falls as more liquidity joins, so the earliest deposits earn the most.</p>`);
render.farm = () => {
  const x = FARM.precision, prog = FARM.program, list = $('#farm-list');
  const mine = (pid) => (FARM.positions || []).filter((p) => Number(p.pid) === pid);
  const live = !!prog?.epoch?.active;
  if (prog?.pools && FARM.open?.startsWith('pid') && !prog.pools.some((p) => 'pid' + p.pid === FARM.open)) FARM.open = 'precision';
  if (!FARM.touched && FARM.open === 'precision' && x && !(x.staked > 0n) && FARM.positions?.length && !KEPT['pf-amt'] && !KEPT['pf-tac']) FARM.open = 'pid' + FARM.positions[0].pid;
  const rows = [html`
    <li class="farm${FARM.open === 'precision' ? ' open' : ''}" data-farm="precision">
      <button type="button" aria-controls="farm-precision" aria-expanded="${FARM.open === 'precision'}">
        ${logoPair('TAC', 'ETH')}
        <span><span class="name">TAC / ETH</span><span class="kind">Public pool${x?.value > 0 ? depthText(BigInt(Math.round(x.value))) : ''}${x?.staked > 0n ? html`<span class="tag">yours</span>` : ''}</span></span>
        <span class="rate">${x ? html`<b>${fmt(x.perDay, 18, 0)} TAC</b><span>a day${x.live && precisionApr(x) != null ? ` · ${aprShort(precisionApr(x))}` : ''}</span>` : FARM.errs?.precision ? html`<b>—</b>` : html`<b><span class="sk" style="--w:7ch"></span></b><span class="sk" style="--w:11ch"></span>`}</span>
      </button>
      <div class="body" id="farm-precision"></div>
    </li>`];
  if (!prog && FARM.errs?.program) rows.push(html`<li class="farm"><p class="note err">The private farms could not be read. <button class="link" type="button" data-retry="farm">Try again</button></p></li>`);
  else if (!prog) rows.push(html`<li class="farm"><button type="button" disabled>${logoPair('TAC', 'cETH')}<span><span class="name"><span class="sk" style="--w:10ch"></span></span><span class="kind"><svg class="gs" aria-hidden="true"><use href="#g-shield"/></svg>Private pool</span></span><span class="rate"><b><span class="sk" style="--w:7ch"></span></b><span class="sk" style="--w:11ch"></span></span></button></li>`);
  for (const p of prog?.pools || []) {
    const [a, b] = p.pair.split('/');
    rows.push(html`
      <li class="farm${FARM.open === 'pid' + p.pid ? ' open' : ''}" data-farm="pid${p.pid}">
        <button type="button" aria-controls="farm-pid${p.pid}" aria-expanded="${FARM.open === 'pid' + p.pid}">
          ${logoPair(a === 'cETH' ? b : a, 'cETH')}
          <span><span class="name">${pairName(p.pair)}</span><span class="kind"><svg class="gs" aria-hidden="true"><use href="#g-shield"/></svg>Private pool${depthText(poolDepthEth(p))}${mine(p.pid).length ? html`<span class="tag">yours</span>` : ''}</span></span>
          <span class="rate"><b>${live ? Math.round(Number(p.tacPerDayForPool)).toLocaleString('en-US') : 0} TAC</b><span>a day${live && shieldedApr(p) != null ? ` · ${aprShort(shieldedApr(p))}` : ''}</span></span>
        </button>
        <div class="body" id="farm-pid${p.pid}"></div>
      </li>`);
  }
  mount(list, html`${rows}`);
  $$('.farm > button', list).forEach((b) => b.onclick = () => {
    if (running('farm')) return;
    const key = b.parentElement.dataset.farm;
    FARM.open = FARM.open === key ? null : key; FARM.touched = true;
    keep($('#sheet-farm'), render.farm);
    syncLink();
  });
  if (FARM.open === 'precision') renderPrecision($('#farm-precision'));
  else if (FARM.open?.startsWith('pid')) renderShielded($(`#farm-${FARM.open}`), (prog?.pools || []).find((p) => 'pid' + p.pid === FARM.open));
  renderFarmNotes($('#farm-notes'));
};
function farmTotals(wtacNotes) {
  const prog = FARM.program, live = !!prog?.epoch?.active, scale = big(prog?.unitScale) || E10;
  let n = 0, worth = 0n, perDay = 0, pending = 0n;
  for (const pos of FARM.positions || []) {
    const p = (prog?.pools || []).find((q) => Number(q.pid) === Number(pos.pid));
    if (!p) continue;
    n++;
    worth += sharesEth(p, pos.shares) || 0n;
    if (live && Number(p.totalShares)) perDay += Number(p.tacPerDayForPool) * Number(pos.shares) / Number(p.totalShares);
    pending += (big(pos.pendingUnits) || 0n) * scale;
  }
  const harvested = wtacNotes.reduce((a, x) => a + BigInt(x.value), 0n) * E10 + wtacHere();
  return { n, worth, perDay, pending, harvested };
}
async function claimRewards(run, tell, status) {
  const t = await getUx(), earned = (FARM.positions || []).filter(unharvested).filter((pos) => !takenByOther(run, kPos(pos))), owed = [];
  FARM.left = null;
  for (const pos of earned) if (await rewardWorth(pos.pendingUnits, t)) owed.push(pos);
  run.left = earned.length - owed.length;
  if (run.left) FARM.left = { n: run.left, at: Date.now() };
  const rid = String(FARM.program?.rewardAsset || '').toLowerCase();
  const have = () => freeNotes(P.scan?.notes).some((x) => rid && String(x.asset).toLowerCase() === rid) || wtacHere() > 0n;
  if (!owed.length && !have()) throw new Error(earned.length ? 'What your positions have earned is not yet worth turning into TAC: the unwrap costs more than it returns. It keeps growing; Claim rewards takes it once it is.' : 'Nothing to claim yet.');
  const n = owed.length + 1;
  for (const [i, pos] of owed.entries()) await stepHarvest(run, samePos(pos), stepOf(tell, i + 1, n), status);
  const seen = () => freeNotes(P.scan?.notes).some((x) => rid && String(x.asset).toLowerCase() === rid);
  for (let i = 0; owed.length && !seen() && !(wtacHere() > 0n) && i < 6; i++) { await sleep(5000); await scanIfNew().catch(() => {}); }
  if (owed.length && !seen() && !(wtacHere() > 0n)) throw new Error('Harvested. The rewards are not showing yet: press Turn into TAC in a minute.');
  return stepRedeem(run, stepOf(tell, n, n), status);
}
const LPS = { pid: null, to: '', part: 'all' };
const RWD_ASSET = { tk: 'cTAC', out: 'wTAC', shown: 'wTAC', icon: 'tac', pubIcon: 'tac', token: WTAC, dp: 2, noMe: true,
  note: 'To a Tacit address it stays private: they claim it in their Tacit wallet, the claim’s relay fee coming out of it. To an Ethereum address the relay sends it as wTAC, which turns into TAC one for one.' };
const RSEND = { pick: 'rtac', open: false };
function lpSendForm(box, x) {
  const { p, notes } = x, big = notes.map((n) => BigInt(n.value)).sort((a, b) => (a < b ? 1 : -1))[0] || 0n, status = () => $('#fn-status');
  if (LPS.pid !== p.pid) Object.assign(LPS, { pid: p.pid, to: '', part: 'all' });
  let who = null, part = LPS.part, seq = 0;
  mount(box, html`
    <div class="amt text"><input class="lps-to" placeholder="tacit1… or name.wei" autocomplete="off" spellcheck="false" autocapitalize="off" autocorrect="off" aria-label="Recipient"></div>
    <div class="seg sub lps-part" role="radiogroup" aria-label="How much">${[['q', 'A quarter'], ['h', 'Half'], ['all', 'All']].map(([k, t]) => html`<button type="button" role="radio" data-lpp="${k}" aria-checked="${String(k === part)}">${t}</button>`)}</div>
    <div class="rcpt lps-rc" hidden></div>
    <button class="btn" type="button" disabled>Send privately</button>`);
  const to = $('.lps-to', box), rc = $('.lps-rc', box), go = $('.btn', box);
  to.value = LPS.to;
  const shares = () => lpShare(big, part);
  const check = async () => {
    const my = ++seq, raw = to.value.trim(), n = shares();
    who = null; go.disabled = true;
    mount(rc, html`<div class="kv"><span>Sends</span><b>${lpSays(p, n)}</b></div>`); rc.hidden = false;
    if (!raw) return;
    try {
      const r = await resolveToM(raw);
      if (my !== seq) return;
      if (String(r.pubHex).replace(/^0x/, '').toLowerCase() === S.key.pubHex) throw new Error('That is your own Tacit address.');
      who = r;
      mount(rc, html`<div class="kv"><span>Sends</span><b>${lpSays(p, n)}</b></div>
        ${r.name ? html`<div class="kv"><span>${r.name}</span><b>${viewAddr(r.address || '', 10)}</b></div>` : html`<div class="kv"><span>To</span><b>${viewAddr(raw, 10)}</b></div>`}
        <div class="kv"><span>Relay fee</span><b>none</b></div>
        <div class="kv"><span>They see</span><b>a private payment to claim</b></div>`);
      go.disabled = !(n > 0n);
    } catch (e) { if (my === seq) quoteErr(rc, e); }
  };
  const checkSoon = debounce(check, 300);
  to.oninput = () => { who = null; go.disabled = true; LPS.to = to.value; checkSoon(); };
  $$('[data-lpp]', box).forEach((b) => b.onclick = () => { part = LPS.part = b.dataset.lpp; $$('[data-lpp]', box).forEach((y) => y.setAttribute('aria-checked', String(y === b))); check(); });
  check();
  go.onclick = () => busy(go, async (run) => {
    const w = who, raw = to.value.trim(), n = shares();
    if (!w || !(n > 0n)) return;
    const label = `Send ${lpSays(p, n)} privately to ${w.name || short(raw, 8)}`;
    try {
      await lpSendNow({ run, p, n, w, raw, field: to, label, line: status, clear: () => { LPS.pid = null; box.hidden = true; }, after: async () => {
        LPS.pid = null;
        say(status(), html`<span class="ok">Sent.</span> They claim it from their Tacit wallet, with no fee.`); toast(`${label}: done`);
        await Promise.allSettled([scanPrivate(true)]); rerender('farm');
      } });
    } catch (e) { run.fail(status(), e); }
  });
}
function renderFarmNotes(el) {
  const prog = FARM.program, notes = S.key ? freeNotes(P.scan?.notes) : null;
  const rid = String(prog?.rewardAsset || '').toLowerCase();
  const wtac = (notes || []).filter((n) => rid && String(n.asset).toLowerCase() === rid);
  const lps = (prog?.pools || []).map((p) => ({ p, notes: (notes || []).filter((n) => String(n.asset).toLowerCase() === String(p.lpAsset).toLowerCase()) })).filter((x) => x.notes.length);
  const inNotes = wtac.reduce((a, n) => a + BigInt(n.value), 0n), inAccount = wtacHere();
  const tot = farmTotals(wtac), waiting = tot.pending + tot.harvested, owed = (FARM.positions || []).some(unharvested);
  if (!tot.n && !inNotes && !inAccount && !lps.length) { mount(el, html``); return; }
  const day = (v) => (v >= 10 ? Math.round(v).toLocaleString('en-US') : v.toFixed(2));
  mount(el, html`
    <div class="blk">
      <div class="lbl"><span>Your private farming</span></div>
      ${tot.n ? html`<div class="kv"><span>In the farms</span><b>${tot.worth > 0n ? `${aboutEth(tot.worth)} · ` : ''}${tot.n} position${tot.n === 1 ? '' : 's'}</b></div>` : ''}
      ${tot.perDay ? html`<div class="kv"><span>Earning</span><b>about ${day(tot.perDay)} TAC a day</b></div>` : ''}
      ${waiting > 0n ? html`<div class="kv"><span>Rewards</span><b>${fmt(waiting, 18, 2)} TAC${tot.harvested > 0n && tot.pending > 0n ? ` · ${fmt(tot.harvested, 18, 2)} harvested` : ''}</b></div>` : ''}
      ${inNotes ? html`<div class="kv"><span>Harvested rewards</span><b>${fmt(inNotes, 8, 2)} wTAC</b></div>` : ''}
      ${inAccount ? html`<div class="kv"><span>wTAC in ${your()}</span><b>${fmt(inAccount, 18, 2)}</b></div>` : ''}
      ${inNotes || inAccount || owed ? html`<button class="btn ghost" type="button" id="fn-redeem">${owed ? 'Claim rewards' : 'Turn into TAC'}</button>
        ${owed && (inNotes || inAccount) ? html`<button class="btn ghost" type="button" id="fn-turn">Turn harvested into TAC</button>` : ''}
        ${inNotes ? html`<button class="btn ghost" type="button" id="fn-rsend" aria-expanded="${String(RSEND.open)}">Send wTAC</button><div class="lps" id="rsend" hidden></div>` : ''}
        ${owed ? html`<p class="note">Claim rewards harvests every position whose reward is worth turning into TAC (the relay charges at least 2 TAC to unwrap each note), then turns it all into TAC in ${your()}. The rest keeps growing. Each step takes a few minutes; if you close the page, press again to carry on.</p>` : ''}` : ''}
      ${FARM.left && Date.now() - FARM.left.at < 10 * 60e3 ? html`<p class="note" id="fn-left">${FARM.left.n} earned reward${FARM.left.n === 1 ? ' is' : 's are'} not yet worth turning into TAC (the unwrap costs more than ${FARM.left.n === 1 ? 'it returns' : 'they return'}): ${FARM.left.n === 1 ? 'it keeps' : 'they keep'} growing, and Claim rewards takes ${FARM.left.n === 1 ? 'it' : 'them'} once worth it.</p>` : ''}
      ${lps.map(({ p, notes: ns }) => { const n = ns.reduce((a, x) => a + BigInt(x.value), 0n); return html`<div class="kv"><span>${pairName(p.pair)} liquidity, not bonded</span><b>${lpWorth(p, n) || `${n.toLocaleString('en-US')} shares`}</b></div>
        <button class="btn ghost" type="button" data-lpbond="${p.pid}">Farm it</button>
        <button class="btn ghost" type="button" data-lprm="${p.pid}">Take it out as ${pairName(p.pair)}</button>
        <button class="btn ghost" type="button" data-lpsend="${p.pid}" aria-expanded="false">Send privately</button>
        <div class="lps" id="lps-${p.pid}" hidden></div>`; })}
      ${inNotes || inAccount || lps.length ? html`<p class="note">wTAC is the farms’ reward token, one for one with TAC: it becomes TAC in ${your()}. Liquidity that is not bonded earns only the pool’s swap fees: farm it for TAC too, or take it out as both assets in private notes.</p>` : ''}
      <div class="status" role="status" id="fn-status"></div>
    </div>`);
  const status = $('#fn-status', el), done = async (msg) => { say(status, html`<span class="ok">${msg}</span>`); await Promise.allSettled([scanPrivate(true), loadFarms(true, { private: true })]); rerender('farm'); };
  if (hxLive('asend')?.k === 'rtac') RSEND.open = true;
  if (!inNotes) RSEND.open = false;
  const rs = $('#rsend', el), openRs = () => assetSendForm(rs, status, { prefix: 'rs', sheet: 'farm', statusId: 'fn-status', pick: RSEND, after: () => loadFarms(true, { private: true }),
    sources: [{ id: 'rtac', k: 'rtac', a: RWD_ASSET, pub: false, held: privateOf('rtac'), unit: 'wTAC', dec: 8 }] });
  if (rs && RSEND.open && P.scan) openRs();
  if (rs) $('#fn-rsend', el).onclick = (e) => { RSEND.open = rs.hidden; e.currentTarget.setAttribute('aria-expanded', String(RSEND.open)); if (RSEND.open && P.scan) openRs(); else rs.hidden = true; };
  const openLps = (x) => { const box = $(`#lps-${x.p.pid}`); box.hidden = false; $(`[data-lpsend="${x.p.pid}"]`, el).setAttribute('aria-expanded', 'true'); lpSendForm(box, x); };
  $$('[data-lpsend]', el).forEach((b) => b.onclick = () => {
    const x = lps.find((y) => String(y.p.pid) === b.dataset.lpsend), box = $(`#lps-${b.dataset.lpsend}`);
    if (box.hidden) openLps(x); else { box.hidden = true; b.setAttribute('aria-expanded', 'false'); LPS.pid = null; }
  });
  { const d = hxLive('lpsend'); const x = d && lps.find((y) => String(y.p.pid) === String(d.pid)); if (x) { HX.draft = null; Object.assign(LPS, { pid: x.p.pid, to: d.to || '', part: d.part || 'all' }); } }
  { const x = LPS.pid != null && lps.find((y) => y.p.pid === LPS.pid); if (x) openLps(x); }
  for (const [id, harvest] of [['#fn-redeem', true], ['#fn-turn', false]]) {
    const rd = $(id, el);
    if (rd) rd.onclick = () => busy(rd, async (run) => {
      try {
        say(status, 'Starting…'); status.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        const got = await (harvest ? claimRewards(run, (m) => say(status, m), status) : stepRedeem(run, (m) => say(status, m), status));
        toast('Rewards turned into TAC');
        const left = [run.skipped ? `${run.skipped} small reward note${run.skipped === 1 ? ' is' : 's are'} worth less than the network fee to unwrap, so ${run.skipped === 1 ? 'it stays' : 'they stay'}.` : ''].filter(Boolean).join(' ');
        const msg = html`Your rewards are TAC in ${your()}.${left ? ` ${left}` : ''}${got > 0n && S.address ? html` <button class="link" type="button" data-fn-farm="${got}">Farm them in the public pool</button>` : ''}`;
        await done(msg);
        if (run.small?.length) offerMore(run.smallSpec, html`<span class="ok">${msg}</span> ${run.small.length} smaller reward note${run.small.length === 1 ? ' is' : 's are'} under the relay’s unwrap fee: `);
      } catch (e) {
        sayErr(status, e);
        await Promise.allSettled([scanPrivate(true), loadFarms()]); rerender('farm');
      }
    });
  }
  $$('[data-lpbond]', el).forEach((b) => b.onclick = () => busy(b, async (run) => {
    const x = lps.find((l) => String(l.p.pid) === b.dataset.lpbond);
    try {
      await stepBond(run, x.p, x.notes, (m) => say(status, m), status);
      toast('In the farm');
      await Promise.allSettled([loadPositions()]);
      await done('In the farm: TAC streams to your private position.');
    } catch (e) { sayErr(status, e); await Promise.allSettled([scanPrivate(true), loadFarms()]); rerender('farm'); }
  }));
  $$('[data-lprm]', el).forEach((b) => b.onclick = () => busy(b, async (run) => {
    const x = lps.find((l) => String(l.p.pid) === b.dataset.lprm);
    try {
      if (!(await stepTakeOut(run, x.p, x.notes, (m) => say(status, m), status))) return;
      toast('Liquidity taken out');
      await done('Taken out: both assets are private notes again.');
    } catch (e) {
      sayErr(status, /not covered by this withdrawal/.test(e?.message || '') ? new Error('This liquidity is worth less than the relay fee to take it out.') : e);
      await Promise.allSettled([scanPrivate(true), loadFarms()]); rerender('farm');
    }
  }));
}
const ethText = (e) => `${e < 10n ** 13n ? '< 0.00001' : fmt(e, 18, 5)} ETH`;
const cutTo = (v, dp) => v - v % 10n ** BigInt(18 - dp);
const upTo = (v, dp) => { const u = 10n ** BigInt(18 - dp); return (v + u - 1n) / u * u; };

function renderPrecision(el) {
  const x = FARM.precision;
  const reading = html`<div class="kv"><span>Stream ends</span><b><span class="sk" style="--w:10ch"></span></b></div><div class="kv"><span>APR now</span><b><span class="sk" style="--w:9ch"></span></b></div>`;
  if (!x || (x.who !== S.address && FARM.errs?.precision)) { mount(el, FARM.errs?.precision ? html`<p class="note err">The farm could not be read. <button class="link" type="button" data-retry="farm">Try again</button></p>` : reading); return; }
  if (S.address) FARM.signIn = false;
  if (!S.address) {
    if (FARM.signIn && !S.key) {
      needKey(el, 'Farm from this key’s address. Add ETH to it, and TAC to farm with both.');
      el.insertAdjacentHTML('beforeend', html`<p class="note"><button class="link" type="button" id="pf-back">Connect a browser wallet instead</button></p>`.s);
      $('#pf-back').onclick = () => { FARM.signIn = false; rerender('farm'); };
      return;
    }
    mount(el, gate('Deposit ETH, TAC or both. TAC streams to you every second.', 'Connect wallet', 'pf-connect',
      html`No browser wallet? <button class="link" type="button" id="pf-tacit">Open your Tacit wallet</button> instead.`));
    $('#pf-tacit').onclick = () => { FARM.signIn = true; rerender('farm'); };
    return wireConnect('pf-connect', () => rerender('farm'));
  }
  if (x.who !== S.address) { mount(el, reading); loadFarms().then(() => rerender('farm')).catch(() => {}); return; }
  if (!FARM.mode) FARM.mode = x.tac >= 10n ** 18n ? 'pair' : 'eth';
  if (hxLive('farm')?.tac) FARM.mode = 'tac';
  const has = x.staked > 0n, mode = FARM.mode, withEth = mode !== 'tac', withTac = mode !== 'eth';
  const myDay = has && x.totalStaked ? x.perDay * x.staked / x.totalStaked : 0n;
  const ethOf = (tac, p = x) => ethOfTac(tac, p);
  const paid = FARM.paid?.who === x.who ? FARM.paid.v : null, e0 = earnedNow(x);
  const facts = html`
    <div class="kv"><span>${x.live ? 'Stream ends' : 'Stream'}</span><b>${x.live ? dayFmt(x.finish) : 'between reward periods'}</b></div>
    <div class="kv"><span>In the pool</span><b>${fmt(x.r0, 18, 4)} ETH + ${fmt(x.r1, 18, 0)} TAC${x.supply ? ` · ${pctFmt(Number(x.totalStaked * 10000n / x.supply) / 100)} staked` : ''}</b></div>
    ${x.live ? aprRow(precisionApr(x)) : ''}`;
  const how = mode === 'pair' ? (x.tac > 0n ? 'Both go in at the pool’s ratio, with nothing swapped.'
    : html`You hold no TAC in ${your()}, and ETH + TAC takes both. <button class="link" type="button" data-go="buy">Buy TAC</button>, <a href="/rewards/">claim the airdrop</a>, or <button class="link" type="button" data-go="eth">farm with ETH alone</button>.`)
    : `About half is swapped to ${mode === 'eth' ? 'TAC' : 'ETH'} inside the pool, then both go into the farm.`;
  mount(el, html`
    ${has ? '' : facts}
    ${has ? html`
      <div class="kv"><span>Your stake</span><b>${fmt(x.mine.eth, 18, 4)} ETH + ${fmt(x.mine.tac, 18, 2)} TAC</b></div>
      <p class="note">Swap fees stay in the pool, so they are already counted in this value.</p>
      <div class="kv"><span>Earning</span><b>${fmt(myDay, 18, 2)} TAC a day${ethOf(myDay) > 0n ? ` (${aboutEth(ethOf(myDay))})` : ''}</b></div>
      <div class="kv"><span>Your share</span><b>${pctFmt(Number(x.staked * 10000n / x.totalStaked) / 100)} of the farm</b></div>
      <div class="kv"><span>Earned</span><b class="num" id="pf-earned">${fmt(e0, 18, 4)} TAC</b></div>
      <div class="kv"${ethOf(e0) > 0n ? '' : ' hidden'}><span>Worth about</span><b class="num" id="pf-earned-eth">${ethText(ethOf(e0))}</b></div>
      ${paid > 0n ? html`<div class="kv"><span>Claimed so far</span><b>${fmt(paid, 18, 2)} TAC${ethOf(paid) > 0n ? ` (${aboutEth(ethOf(paid))})` : ''}</b></div>` : ''}
      <button class="btn ghost" type="button" id="pf-claim" ${e0 === 0n ? 'disabled' : ''}>Claim ${tacShort(e0)} TAC</button>
      <button class="link" type="button" id="pf-reinvest" ${e0 === 0n ? 'disabled' : ''}>Claim and add to the farm</button>
      <div class="status" role="status" id="pf-pos-status"></div>` : ''}
    ${x.lp > 0n ? html`
      <div class="kv"><span>LP shares not staked</span><b>${fmt(x.lp, 18, 6)}</b></div>
      <p class="note">Shares that are not staked earn swap fees but no TAC.</p>
      <button class="btn ghost" type="button" id="pf-stake">Stake them</button>
      <div class="status" role="status" id="pf-lp-status"></div>` : ''}
    ${has ? html`
      <div class="lbl"><span>Withdraw</span></div>
      ${segSub('pfp', FARM.outPct, [['25', '25%'], ['50', '50%'], ['100', 'All']])}
      ${segSub('pfr', FARM.outAs, [['both', 'ETH + TAC'], ['eth', 'As ETH'], ['tac', 'As TAC']])}
      <div class="rcpt" id="pf-out-rcpt" hidden></div>
      <div id="pf-out-ack"></div>
      <button class="btn ghost" type="button" id="pf-exit" disabled>Withdraw</button>
      <div class="status" role="status" id="pf-out-status"></div>` : ''}
    <div class="lbl"><span>${has ? 'Add more' : 'Farm with'}</span></div>
    ${segSub('pfm', mode, [['eth', 'ETH'], ['tac', 'TAC'], ['pair', 'ETH + TAC']])}
    <p class="note how">${how}</p>
    <div id="pf-fund"></div>
    ${withEth ? html`
      <div class="lbl"><span>ETH</span><button type="button" id="pf-max">${payName()} ${x.bal == null ? '—' : fmt(x.bal, 18, 4)} ETH</button></div>
      <div class="amt"><input id="pf-amt" inputmode="decimal" placeholder="0.00" autocomplete="off" aria-label="ETH to deposit"><span class="u"><svg class="tk sm" aria-hidden="true"><use href="#tk-eth"/></svg>ETH</span></div>` : ''}
    ${withTac ? html`
      <div class="lbl"><span>TAC</span><button type="button" id="pf-tmax">${payName()} ${fmt(x.tac, 18, 2)} TAC</button></div>
      <div class="amt"><input id="pf-tac" inputmode="decimal" placeholder="0.00" autocomplete="off" aria-label="TAC to deposit"><span class="u"><svg class="tk sm" aria-hidden="true"><use href="#tk-tac"/></svg>TAC</span></div>` : ''}
    <div class="rcpt" id="pf-rcpt" hidden></div>
    <div id="pf-ack"></div>
    <button class="btn" type="button" id="pf-go" disabled>${{ eth: 'Farm with ETH', tac: 'Farm with TAC', pair: 'Farm with ETH + TAC' }[mode]}</button>
    <div class="status" role="status" id="pf-status"></div>
    ${has ? html`<div class="lbl sep"><span>The farm</span></div>${facts}` : ''}`);
  noEthYet($('#pf-fund'), x.bal, '', 'farm with it');
  const status = $('#pf-status'), posStatus = $('#pf-pos-status'), lpStatus = $('#pf-lp-status'), outStatus = $('#pf-out-status');
  const only = (at) => { for (const s of [status, posStatus, lpStatus, outStatus]) if (s && s !== at) say(s, ''); };
  const done = async (hash, what, note, at = status) => {
    only(at);
    say(at, html`${what}… ${txLink(hash)}`);
    await waitTx(hash);
    say(at, html`<span class="ok">${note}</span> ${txLink(hash)}`);
    await loadFarms(true); rerender('farm');
  };
  $$('[data-go="buy"]', el).forEach((b) => b.addEventListener('click', () => { $('#sheet-farm').close(); openSheet('buy'); }));
  $$('[data-go="eth"]', el).forEach((b) => b.addEventListener('click', () => { if (running(sheetOf(b))) return; FARM.mode = 'eth'; keep($('#sheet-farm'), render.farm); }));
  wireSub(el, 'pfm', (m) => { FARM.mode = m; keep($('#sheet-farm'), render.farm); });
  clearInterval(FARM.tick);
  if (has && x.live) {
    const tick = () => {
      const e = $('#pf-earned'), w = $('#pf-earned-eth'), b = $('#pf-claim'), r = $('#pf-reinvest'), y = FARM.precision;
      if (!e?.isConnected || !$('#sheet-farm').open || y?.who !== x.who || !(y.staked > 0n)) { clearInterval(FARM.tick); return; }
      const v = earnedNow(y);
      e.textContent = `${fmt(v, 18, 4)} TAC`;
      if (w) { const eth = ethOf(v, y); w.textContent = ethText(eth); w.parentElement.hidden = eth === 0n; }
      if (b && b.getAttribute('aria-busy') !== 'true') { b.textContent = `Claim ${tacShort(v)} TAC`; b.disabled = v === 0n; }
      if (r && r.getAttribute('aria-busy') !== 'true') r.disabled = v === 0n;
    };
    FARM.tick = setInterval(tick, 1000);
  }

  const ethIn = $('#pf-amt'), tacIn = $('#pf-tac'), go = $('#pf-go'), rc = $('#pf-rcpt'), ackBox = $('#pf-ack');
  const GAS = 2n * 500000n * (x.gp ?? 3n * 10n ** 9n), spendable = x.bal != null && x.bal > GAS ? x.bal - GAS : 0n;
  const tacFor = (wei) => (x.r0 > 0n ? (wei * x.r1 + x.r0 - 1n) / x.r0 : 0n);
  const ethFor = (tac) => (x.r1 > 0n ? (tac * x.r0 + x.r1 - 1n) / x.r1 : 0n);
  let q = null, seq = 0;
  const gateOk = () => { go.disabled = !q || q.over || !lossOk(ackBox, q.loss); };
  const requote = async (e) => {
    const my = ++seq;
    const typedIn = (i) => e?.target === i && (e.isTrusted || e.fill);
    if (mode === 'pair' && typedIn(ethIn)) { const v = parseUnits(ethIn.value); if (!ethIn.value) tacIn.value = ''; else if (v != null) tacIn.value = plain(upTo(tacFor(v), TAC_DP), 18); }
    if (mode === 'pair' && typedIn(tacIn)) { const v = parseUnits(tacIn.value); if (!tacIn.value) ethIn.value = ''; else if (v != null) ethIn.value = plain(upTo(ethFor(v), ETH_DP), 18); }
    if (mode === 'pair' && !typedIn(ethIn) && !typedIn(tacIn)) {
      const ev = parseUnits(ethIn.value), tv = parseUnits(tacIn.value);
      if (ev && !tv) tacIn.value = plain(upTo(tacFor(ev), TAC_DP), 18); else if (tv && !ev) ethIn.value = plain(upTo(ethFor(tv), ETH_DP), 18);
    }
    const wei = withEth ? parseUnits(ethIn.value) || 0n : 0n, tac = withTac ? parseUnits(tacIn.value) || 0n : 0n;
    if (!go.isConnected) return;
    q = null; go.disabled = true; mount(ackBox, html``); if (e?.isTrusted) say(status, '');
    if (!wei && !tac) { rc.hidden = true; return; }
    try {
      const pq = await pubPreview(x, mode, wei, tac);
      if (my !== seq || !go.isConnected) return;
      const { lp, loss, share, day, myApr } = pq;
      q = pq;
      mount(rc, html`
        ${mode === 'pair' ? html`<div class="kv"><span>Deposit</span><b>${fmt(wei, 18, 5)} ETH + ${fmt(tac, 18, 2)} TAC</b></div>` : ''}
        ${lossLine(loss)}
        <div class="kv"><span>Share of the farm</span><b>${(Number(share) / 100).toFixed(2)}%</b></div>
        <div class="kv"><span>Earns about</span><b>${fmt(day, 18, 2)} TAC a day${ethOfTac(day, x) > 0n ? ` (${aboutEth(ethOfTac(day, x))})` : ''}</b></div>
        ${myApr != null ? html`<div class="kv"><span>APR on this deposit</span><b>${aprLong(myApr)}</b></div>
          <p class="note">At today’s TAC price, while the stream runs to ${dayFmt(x.finish)}. Swap fees come on top.</p>` : ''}`);
      rc.hidden = false;
      mount(ackBox, lossGate('pf-ackv', loss, 'deposit'));
      wireAck(ackBox, 'pf-ackv', loss, gateOk);
      if (wei > (x.bal ?? wei)) warn(rc, lowEth());
      else if (tac > x.tac) warn(rc, html`Not enough TAC. <button class="link" type="button" data-go="buy">Buy TAC</button> or <a href="/rewards/">claim the airdrop</a>${mode === 'pair' ? html`, or <button class="link" type="button" data-go="eth">farm with ETH alone</button>` : ''}.`);
      else if (loss >= 5) {
        const other = mode === 'eth' ? x.tac > 0n : spendable > 0n;
        warn(rc, html`The swap inside the pool costs a lot at this size. A smaller deposit costs less${other ? html`, and so does <button class="link" type="button" data-go="pair">adding ${mode === 'eth' ? 'TAC' : 'ETH'} too</button>` : ''}.`);
      }
      rc.querySelector('[data-go="buy"]')?.addEventListener('click', () => { $('#sheet-farm').close(); openSheet('buy'); });
      rc.querySelector('[data-go="eth"]')?.addEventListener('click', (e) => { if (running(sheetOf(e.currentTarget))) return; FARM.mode = 'eth'; keep($('#sheet-farm'), render.farm); });
      rc.querySelector('[data-go="pair"]')?.addEventListener('click', (e) => { if (running(sheetOf(e.currentTarget))) return; FARM.mode = 'pair'; keep($('#sheet-farm'), render.farm); });
      gateOk();
    } catch (e2) {
      if (my !== seq) return;
      if (wei > (x.bal ?? wei)) { mount(rc, html``); warn(rc, lowEth()); }
      else if (tac > x.tac) { mount(rc, html``); warn(rc, `Not enough TAC in ${your()}.`); }
      else quoteErr(rc, e2);
    }
  };
  const edit = onEdit([ethIn, tacIn].filter(Boolean), go, requote);
  const fill = (input, v) => { edit.cancel(); input.value = v > 0n ? plain(v, 18) : ''; requote({ target: input, fill: true }); };
  const pairMax = () => {
    edit.cancel();
    let wei = cutTo(spendable, ETH_DP), tac = upTo(tacFor(wei), TAC_DP);
    if (tac > x.tac) { tac = cutTo(x.tac, TAC_DP); wei = upTo(ethFor(tac), ETH_DP); }
    ethIn.value = wei > 0n ? plain(wei, 18) : ''; tacIn.value = tac > 0n ? plain(tac, 18) : '';
    requote({});
  };
  const noRoom = () => say(status, x.bal == null ? html`<span class="err">Your ETH balance could not be read. Try again in a moment.</span>`
    : html`<span class="err">${payName()} holds ${fmt(x.bal, 18, 4)} ETH, and Max keeps ${fmt(GAS, 18, 3)} ETH of it for the network fee. Add some ETH, or type a smaller amount.</span>`);
  $('#pf-max')?.addEventListener('click', () => {
    if (x.bal == null || (!(spendable > 0n) && (mode !== 'pair' || x.tac > 0n))) return noRoom();
    mode === 'pair' ? x.tac > 0n && pairMax() : fill(ethIn, cutTo(spendable, ETH_DP));
  });
  $('#pf-tmax')?.addEventListener('click', () => (mode === 'pair' ? (x.tac > 0n && (spendable > 0n ? pairMax() : noRoom())) : fill(tacIn, cutTo(x.tac, TAC_DP))));
  if (FARM.fill === 'tac' && tacIn) { FARM.fill = null; $('#pf-tmax').click(); }
  takeDraft('farm', mode === 'tac' ? tacIn : ethIn, (d) => !!d.tac === (mode === 'tac'));
  if (FARM.reinvest && tacIn) {
    const v = FARM.reinvest; FARM.reinvest = null;
    fill(tacIn, cutTo(v < x.tac ? v : x.tac, TAC_DP));
    say(status, html`<span class="ok">Claimed ${fmt(v, 18, 2)} TAC. It is ready to farm below.</span>`);
    go.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
  go.onclick = () => busy(go, async (run) => {
    const z = q;
    if (!z || !lossOk(ackBox, z.loss)) return;
    let sent = false;
    try {
      const hash = await pubSend(x, z, mode, status);
      sent = true;
      [ethIn, tacIn].forEach((i) => i && clearField(i)); delete acked['pf-ackv'];
      await done(hash, 'Staking', 'Staked.');
      toast(x.live ? 'Staked. TAC is streaming to you.' : 'Staked. It earns once the next reward period starts.');
    } catch (e) {
      txFail(run, status, e);
      if (sent) { q = null; run.release(true); }
    }
  });

  const st = $('#pf-stake');
  if (st) st.onclick = () => busy(st, async (run) => {
    try {
      const dl = deadline();
      let data = SEL.stake + word(x.lp);
      if (x.lpAllow < x.lp) { const sig = await permitSig({ token: ADDR.precisionPool, name: 'Precision LP', spender: ADDR.precisionFarm, value: x.lp, deadline: dl, status: lpStatus }); data = SEL.stakeWithPermit + word(x.lp) + word(dl) + word(sig.v) + strip(sig.r) + strip(sig.s); }
      await done(await sendTx({ to: ADDR.precisionFarm, data, label: 'Stake LP shares in the farm' }), 'Staking', 'Staked.', lpStatus);
      toast(x.live ? 'Staked. TAC is streaming to you.' : 'Staked. It earns once the next reward period starts.');
    } catch (e) { txFail(run, lpStatus, e); }
  });

  const c = $('#pf-claim');
  if (c) c.onclick = () => busy(c, async (run) => {
    try { await done(await sendTx({ to: ADDR.precisionFarm, data: SEL.claim, label: 'Claim TAC from the farm' }), 'Claiming', `Claimed to ${your()}.`, posStatus); toast('TAC claimed'); }
    catch (e) { txFail(run, posStatus, e); }
  });
  const ri = $('#pf-reinvest');
  if (ri) ri.onclick = () => busy(ri, async (run) => {
    try {
      const hash = await sendTx({ to: ADDR.precisionFarm, data: SEL.claim, label: 'Claim TAC from the farm' });
      only(posStatus);
      say(posStatus, html`Claiming… ${txLink(hash)}`);
      const r = await waitTx(hash);
      const got = (r.logs || []).filter((l) => l.address.toLowerCase() === ADDR.precisionFarm.toLowerCase() && l.topics[0] === REWARD_PAID).reduce((t, l) => t + BigInt(l.data), 0n);
      await loadFarms(true);
      say(posStatus, html`<span class="ok">Claimed.</span> ${txLink(hash)}`);
      if (got > 0n) Object.assign(FARM, { mode: 'tac', reinvest: got });
      rerender('farm');
      toast(`Claimed ${fmt(got, 18, 2)} TAC`);
    } catch (e) { txFail(run, posStatus, e); }
  });
  const ex = $('#pf-exit');
  if (!ex) return;
  const outRc = $('#pf-out-rcpt'), outAck = $('#pf-out-ack');
  const outData = pubOutData;
  let w = null, wseq = 0;
  const outGateOk = () => { ex.disabled = !w || !lossOk(outAck, w.loss); };
  const preview = async () => {
    const my = ++wseq, all = FARM.outPct === '100', as = FARM.outAs, shares = all ? x.staked : x.staked * BigInt(FARM.outPct) / 100n;
    w = null; ex.disabled = true; mount(outAck, html``);
    try {
      const r = strip(await ethCall(ADDR.precisionFarm, outData(all, as, shares, 0n, 0n, deadline()), { from: S.address }));
      if (my !== wseq || !ex.isConnected) return;
      const worth = x.value * Number(shares) / Number(x.supply);
      const got = as === 'both' ? null : wordAt(r, 0);
      const loss = got == null ? 0 : Math.max(0, (1 - Number(got) / (as === 'eth' ? worth : worth / x.tacEth)) * 100);
      w = { all, as, shares, loss };
      mount(outRc, html`
        <div class="kv"><span>You get about</span><b>${as === 'both' ? `${fmt(wordAt(r, 0), 18, 5)} ETH + ${fmt(wordAt(r, 1), 18, 2)} TAC` : `${fmt(got, 18, as === 'eth' ? 5 : 2)} ${as === 'eth' ? 'ETH' : 'TAC'}`}</b></div>
        ${all && x.earned > 0n ? html`<div class="kv"><span>Plus earned</span><b>${fmt(x.earned, 18, 2)} TAC</b></div>` : ''}
        ${lossLine(loss)}
        ${as === 'both' ? '' : html`<p class="note">The ${as === 'eth' ? 'TAC' : 'ETH'} half is swapped inside the pool.</p>`}
        ${!all && x.earned > 0n ? html`<p class="note">What you have earned stays in the farm until you claim it.</p>` : ''}`);
      outRc.hidden = false;
      mount(outAck, lossGate('pf-outv', loss, 'withdrawal'));
      wireAck(outAck, 'pf-outv', loss, outGateOk);
      ex.textContent = all ? 'Withdraw all' : `Withdraw ${FARM.outPct}%`;
      outGateOk();
    } catch (e) { if (my === wseq) quoteErr(outRc, e); }
  };
  wireSub(el, 'pfp', (v) => { FARM.outPct = v; keep($('#sheet-farm'), render.farm); });
  wireSub(el, 'pfr', (v) => { FARM.outAs = v; keep($('#sheet-farm'), render.farm); });
  preview();
  ex.onclick = () => busy(ex, async (run) => {
    const z = w;
    if (!z || !lossOk(outAck, z.loss)) return;
    try {
      const hash = await pubExitSend({ all: z.all, as: z.as, shares: z.shares, label: `Withdraw ${z.all ? 'all' : `${FARM.outPct}%`} from the farm${z.as === 'both' ? '' : ` as ${z.as === 'eth' ? 'ETH' : 'TAC'}`}` });
      delete acked['pf-outv'];
      await done(hash, 'Withdrawing', `Withdrawn to ${your()}.`, outStatus);
      toast(`Withdrawn to ${your()}`);
    } catch (e) { txFail(run, outStatus, e); }
  });
}

const pendingEth = (pos) => ethOfTac((big(pos.pendingUnits) || 0n) * (big(FARM.program?.unitScale) || E10), FARM.precision);
function renderShielded(el, p) {
  if (!p) return;
  const r = p.reserves || {};
  const mine = (FARM.positions || []).filter((x) => Number(x.pid) === Number(p.pid));
  const pm = poolVsMarket(p), off = pm && Math.abs(pm.ratio - 1) >= 0.05;
  const facts = html`
    <div class="kv"><span>In the pool</span><b>${lpWorth(p, r.lpTotalShares) || ''}${lpWorth(p, r.lpTotalShares) ? ' · ' : ''}${pctFmt(Number(p.totalShares) * 100 / Math.max(1, Number(r.lpTotalShares || 1)))} bonded</b></div>
    ${off ? html`<div class="kv"><span>Price in the pool</span><b>1 ETH = ${priceFmt(1 / pm.pool)} ${pm.unit} · market ${priceFmt(1 / pm.market)}</b></div>` : ''}
    <div class="kv"><span>${FARM.program.epoch?.active ? 'Stream ends' : 'Stream'}</span><b>${FARM.program.epoch?.active ? dayFmt(FARM.program.epoch.periodFinish) : 'between reward periods'}</b></div>
    ${FARM.program.epoch?.active ? aprRow(shieldedApr(p)) : ''}`;
  mount(el, html`
    <div id="sf-${p.pid}"></div>
    <div class="status" role="status" id="sf-status-${p.pid}"></div>
    <div class="lbl sep"><span>The farm</span></div>${facts}`);
  const box = $(`#sf-${p.pid}`), status = $(`#sf-status-${p.pid}`);
  if (!needKey(box, 'Open your Tacit wallet to farm privately.')) return;
  if (FARM.positions == null) { mount(box, html`<div class="kv"><span><span class="sk" style="--w:11ch"></span></span><b><span class="sk" style="--w:12ch"></span></b></div>`); loadPositions().then(() => rerender('farm')).catch((e) => sayErr($(`#sf-status-${p.pid}`) || status, e)); return; }
  mount(box, html`
    ${mine.map((pos, i) => { const locked = Number(pos.unlockAt || 0) > chainNow(), day = FARM.program.epoch?.active && Number(p.totalShares) ? Number(p.tacPerDayForPool) * Number(pos.shares) / Number(p.totalShares) : 0; return html`
      ${mine.length > 1 ? html`<div class="lbl"><span>Position ${i + 1}</span></div>` : ''}
      <div class="kv"><span>Your position</span><b>${lpWorth(p, pos.shares) || `${Number(pos.shares).toLocaleString('en-US')} shares`}</b></div>
      ${pos.imported ? html`<p class="note err">An older version of this page opened this position under a random key, not your Tacit key. Its key is kept only as a saved record in this browser: exit it from this browser, and do not clear the browser’s data first.</p>` : ''}
      ${sharesEth(p, pos.shares) != null ? html`<div class="kv"><span>Worth</span><b>${aboutEth(sharesEth(p, pos.shares))}${Number(p.totalShares) ? ` · ${sharePct(Number(pos.shares) / Number(p.totalShares))} of the farm` : ''}</b></div>` : ''}
      <div class="kv"><span>Earned</span><b>${pos.pendingTac} TAC${pendingEth(pos) > 0n ? ` (${aboutEth(pendingEth(pos))})` : ''}</b></div>
      ${day ? html`<div class="kv"><span>Earning</span><b>about ${day >= 10 ? Math.round(day).toLocaleString('en-US') : day.toFixed(2)} TAC a day</b></div>` : ''}
      <div class="row2"><button class="btn ghost" type="button" data-harvest="${i}" ${BigInt(pos.pendingUnits || 0) > 0n ? '' : 'disabled'}>Harvest</button><button class="btn" type="button" data-exit="${i}" ${locked ? 'disabled' : ''}>${locked ? `Exit from ${dayFmt(Number(pos.unlockAt))}` : 'Exit'}</button></div>
      <p class="note">Exit takes everything out: it harvests what you have earned when that is worth the relay’s fee (Harvest first to be sure of it), ends the position and returns the liquidity as private notes. What the position earns while those steps run${day ? ` (about ${day >= 1440 ? Math.round(day / 1440).toLocaleString('en-US') : (day / 1440).toFixed(3)} TAC a minute)` : ''} is given up.</p>
      <details class="lockmore"><summary>One step at a time</summary>
        <div class="row2"><button class="btn ghost" type="button" data-unbond="${i}" ${locked || unharvested(pos) ? 'disabled' : ''}>${locked ? `Unbond from ${dayFmt(Number(pos.unlockAt))}` : 'Unbond'}</button></div>
        ${unharvested(pos) && !locked ? html`<p class="note">Harvest first: unbonding now would give up the ${pos.pendingTac} TAC this position has earned. A farm pays out every second, so a position soon holds a little more after a harvest; Exit gives that up knowingly.</p>` : ''}
      </details>`; })}
    ${mine.length ? html`<p class="note">Harvest pays what is earned as a wTAC note, which turns into TAC one for one. The relay charges a fee to unwrap each note (at least 2 TAC today), or you can send the unwrap from ${your()} and pay only the network fee, so a harvest suits a reward worth more than that. A harvest pays what was earned when it started: what the position earns in the minutes it takes to prove and settle is not paid.</p>
      <div class="status" role="status" id="sf-act-${p.pid}"></div>` : ''}
    <div id="sj-${p.pid}"></div>`);
  farmJoin($(`#sj-${p.pid}`, box), p, status, mine.length > 0);
  const act = $(`#sf-act-${p.pid}`, box);
  $$('[data-harvest]', box).forEach((b) => b.onclick = () => busy(b, async (run) => {
    try { await stepHarvest(run, mine[Number(b.dataset.harvest)], (m) => say(act, m), act); say(act, html`<span class="ok">Harvested to a wTAC note,</span> the farm’s reward token, one for one with TAC. <button class="link" type="button" data-fn-go="redeem">Turn it into TAC</button>`); toast('Harvested'); rerender('farm'); }
    catch (e) { sayErr(act, e); }
  }));
  $$('[data-unbond]', box).forEach((b) => b.onclick = () => busy(b, async (run) => {
    try {
      const pos = mine[Number(b.dataset.unbond)], tell = (m) => say(act, m);
      try { await stepUnbond(run, pos, tell, false, act); }
      catch (e0) {
        const u = /farm-unbond: (\d+) reward units/.exec(e0?.message || '');
        if (!u || BigInt(u[1]) > HARVEST_WORTH) throw e0;
        await stepUnbond(run, samePos(pos), tell, true, act);
      }
      say(act, html`<span class="ok">Unbonded. Your liquidity is a private note again.</span> <button class="link" type="button" data-fn-go="lp${p.pid}">Take it out as ${pairName(p.pair)}</button>`); toast('Unbonded'); rerender('farm');
    }
    catch (e) { sayErr(act, /forfeit/i.test(e?.message || '') ? new Error('Harvest first, or press Exit, which harvests and takes the liquidity out in one go; unbonding now would give up the TAC it has earned.') : /locked until/.test(e?.message || '') ? new Error('This device’s clock says the bond is not over yet. Try again in a few minutes, or set the clock right.') : e); }
  }));
  $$('[data-exit]', box).forEach((b) => b.onclick = () => busy(b, async (run) => {
    const pos = mine[Number(b.dataset.exit)];
    try {
      say(act, 'Starting…'); act.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      const out = await exitPosition(run, p, pos, (m) => say(act, m), act);
      if (out === 'out') {
        toast('Out of the farm');
        say(act, run.harvested
          ? html`<span class="ok">Out. Your liquidity is back as private ${pairName(p.pair)} notes, and the rewards are in your wTAC notes.</span> <button class="link" type="button" data-fn-go="redeem">Turn them into TAC</button>`
          : html`<span class="ok">Out. Your liquidity is back as private ${pairName(p.pair)} notes.</span> ${run.left > HARVEST_WORTH ? `Its reward (${fmt(run.left * E10, 18, 4)} TAC) was worth less than it costs to turn into TAC, so it was left.` : 'Its reward was under 0.01 TAC, so it was left.'}`);
      }
      else if (out === 'unseen') say(act, html`<span class="ok">Unbonded.</span> The liquidity note has not shown up yet. <button class="link" type="button" data-fn-go="lp${p.pid}">Take it out</button> once it does.`);
      await refreshFarm(); rerender('farm');
    } catch (e) {
      sayErr(act, /locked until/.test(e?.message || '') ? new Error('This device’s clock says the bond is not over yet. Try again in a few minutes, or set the clock right.') : e);
      await refreshFarm(); rerender('farm');
    }
  }));
}
function joinYield(p, shares, a) {
  const bonded = BigInt(p.totalShares || 0), day = FARM.program?.epoch?.active ? Number(p.tacPerDayForPool) * Number(shares) / Number(bonded + shares) : 0;
  const dayWei = BigInt(Math.round(day * 1e18)), apr = day ? aprOf(day, 2 * Number(a) / 1e8) : null;
  return html`
    <div class="kv"><span>Share of the farm</span><b>${sharePct(Number(shares) / Number(bonded + shares))}</b></div>
    ${day ? html`<div class="kv"><span>Earns about</span><b>${day >= 10 ? Math.round(day).toLocaleString('en-US') : day.toFixed(2)} TAC a day${ethOfTac(dayWei, FARM.precision) > 0n ? ` (${aboutEth(ethOfTac(dayWei, FARM.precision))})` : ''}</b></div>` : ''}
    ${apr != null ? html`<div class="kv"><span>APR on this deposit</span><b>${aprLong(apr)}</b></div>
      <p class="note">At today’s TAC price${FARM.program?.epoch?.periodFinish ? `, while the stream runs to ${dayFmt(FARM.program.epoch.periodFinish)}` : ''}. Swap fees come on top.</p>` : ''}`;
}
const zapCallout = (pid) => (zapsMine(pid).length ? html`<div class="callout" data-zap-kept><span>A zap of yours waits for its share to be made private and farmed.</span> <button class="link" type="button" id="sz-finish-${pid}">Finish it</button></div>` : '');
function wireZapFinish(p, status) {
  $(`#sz-finish-${p.pid}`)?.addEventListener('click', (e) => busy(e.currentTarget, (run) => zapsFinish(run, p, status)));
}
function farmZap(el, p, status, has, top) {
  const pid = p.pid, other = top.other, dpB = top.dpB, label = pairName(p.pair);
  mount(el, html`${top.coming}
    <div class="lbl"><span>${has ? 'Add more' : 'Add and farm'}</span><button type="button" id="sz-max-${pid}">Max</button></div>
    ${top.seg}
    <p class="note how">One transaction from ${your()}: about half is swapped to ${other}, both go in, and your share is farmed privately. <button class="link" type="button" data-join-get="private">Shield ETH first instead</button></p>
    <div id="sz-fund-${pid}"></div>
    <div class="lbl"><span>ETH</span><span id="sz-bal-${pid}"></span></div>
    <div class="amt"><input id="sz-a-${pid}" inputmode="decimal" placeholder="0.00" autocomplete="off" aria-label="ETH to zap into the farm"><span class="u"><svg class="tk sm" aria-hidden="true"><use href="#tk-eth"/></svg>ETH</span></div>
    ${S.key ? html`<div class="seg" id="sz-sizes-${pid}" role="group" aria-label="Sizes kept ready"></div>` : ''}
    <div class="rcpt" id="sz-rcpt-${pid}" hidden></div>
    <div id="sz-ack-${pid}"></div>
    <div class="stick"><button class="btn" type="button" id="sz-go-${pid}" disabled>Zap into the farm</button></div>
    <p class="note">The chain sees your ETH go into ${label}: the swap and what is added. From there it is private: the farm, its rewards and your exit.</p>`);
  const aIn = $(`#sz-a-${pid}`), go = $(`#sz-go-${pid}`), rc = $(`#sz-rcpt-${pid}`), ackBox = $(`#sz-ack-${pid}`), balEl = $(`#sz-bal-${pid}`);
  let q = null, seq = 0, bal = null;
  if (S.key) lpKeep(p.poolId);
  const sizesEl = $(`#sz-sizes-${pid}`);
  const paintSizes = async () => {
    const t = await getUx(), res = await t.poolReserves(p.poolId).catch(() => null), mine = (await vouchers()).list(S.key.pubHex, lpTicker(p.poolId));
    if (!sizesEl?.isConnected) return;
    mount(sizesEl, html`${LP_KEEP_ETH.map((z) => {
      const x = mine.find((v) => v.size === String(z)), c = x?.status === 'ready' && res ? lpCost(x, res) : null;
      return html`<button type="button" data-size="${c ?? z}">${fmt(z, 18, 3)} ETH<small>${c ? 'ready now' : x ? 'being proved' : ''}</small></button>`;
    })}`);
    sizesEl.querySelectorAll('[data-size]').forEach((b) => { b.onclick = () => { aIn.value = plain(BigInt(b.dataset.size) / zapUnit * zapUnit, 18); aIn.dispatchEvent(new Event('input')); }; });
  };
  if (sizesEl) { paintSizes().catch(() => {}); const tick = setInterval(() => { if (!sizesEl.isConnected) clearInterval(tick); else paintSizes().catch(() => {}); }, 30e3); }
  const gateOk = () => { go.disabled = !q || q.over || !lossOk(ackBox, q.impact || 0); };
  ethBalance().then((b) => { bal = b; if (balEl.isConnected) balEl.textContent = b == null ? '' : `${payName()} ${fmt(b, 18, 4)}`; noEthYet($(`#sz-fund-${pid}`), b, '', 'zap it into the farm'); });
  const requote = debounce(async () => {
    const my = ++seq, wei = (parseUnits(aIn.value, 18) || 0n) / zapUnit * zapUnit;
    q = null; gateOk();
    if (!wei) { if (!tooFine(rc, aIn.value, null, 18)) rc.hidden = true; return; }
    mount(rc, html`<p class="note">Reading the pool…</p>`); rc.hidden = false;
    try {
      const z = await zapQuote(p, wei, { splitting: () => { if (my === seq && go.isConnected) mount(rc, html`<p class="note">Pricing the swap in this pool and the Precision pool…</p>`); } });
      if (my !== seq || !go.isConnected) return;
      if (!z.plan) { mount(rc, html``); warn(rc, 'Enter a larger amount: this one is too small to make a share of the pool.'); return; }
      const { plan, sp, gas, gp, loss: impact, mkt, paid, back, ready, have } = z;
      q = z;
      mount(rc, html`
        <div class="kv"><span>Swaps</span><b>${fmt(plan.swapIn, 18, 6)} ETH for about ${fmt(paid, 18, dpB)} ${other}</b></div>
        ${sp ? html`<div class="kv"><span>Where</span><b>${Math.round(Number(plan.ammIn) * 100 / Number(plan.swapIn))}% in this pool, the rest in the Precision pool</b></div>` : ''}
        <div class="kv"><span>Then adds</span><b>${fmt(plan.ethLeg, 18, 6)} ETH + ${fmt(plan.bLeg, 18, dpB)} ${other}</b></div>
        ${lossLine(impact)}
        ${mkt >= 1 ? html`<div class="kv"><span>Against the market</span><b class="${mkt >= 5 ? 'err' : ''}">${pctFmt(mkt)} of this deposit</b></div>` : ''}
        ${joinYield(p, plan.shares, plan.ethLeg / zapUnit)}
        ${back >= 10n ** BigInt(18 - dpB) ? html`<div class="kv"><span>Back to ${your()}</span><b>about ${fmt(back, 18, dpB)} ${other}</b></div>` : ''}
        <div class="kv"><span>Network fee, from ${your()}</span><b>about ${fmt(ready ? ZAP_SETTLE_GAS * gp * 3n / 2n : gas, 18, 5)} ETH</b></div>
        <div class="kv"><span>Then</span><b>${ownNow(['farmbond']) && devOn() ? 'the relay makes your share private, then this computer puts it in the farm' : 'the relay makes your share private and farms it, a few minutes'}</b></div>`);
      mount(ackBox, lossGate(`sz-ackv-${pid}`, q.impact, 'deposit'));
      wireAck(ackBox, `sz-ackv-${pid}`, q.impact, gateOk);
      if (ready) rc.insertAdjacentHTML('beforeend', html`<div class="kv"><span>Proof</span><b>ready now: one transaction, ${fmt(ready.plan.value, 18, 6)} ETH and about ${fmt(ZAP_SETTLE_GAS * gp * 3n / 2n, 18, 5)} ETH in network fees</b></div>`.s);
      zapAhead(p, z, () => q?.wei === wei && aIn.isConnected);
      if (q.over) warn(rc, have != null && (have === 0n || plan.value <= have) ? lowEth() : 'More ETH than you hold, with the network fee. Try Max.');
    } catch (e) { if (my === seq) quoteErr(rc, e); }
    gateOk();
  }, 250);
  aIn.oninput = () => { seq++; q = null; gateOk(); requote(); };
  $(`#sz-max-${pid}`).onclick = async () => {
    const b = bal ?? await ethBalance(), keep = await ethKeep().catch(() => 3n * 10n ** 15n);
    aIn.value = b != null && b > keep ? plain((b - keep) / zapUnit * zapUnit, 18) : '';
    aIn.dispatchEvent(new Event('input'));
  };
  takeDraft('zap', aIn, (x) => x.pid === pid);
  go.onclick = () => busy(go, async (run) => {
    const z = q;
    if (!z || z.over || !lossOk(ackBox, z.impact || 0)) return;
    await zapNow({ run, p, z, status, clear: () => clearField(aIn), moved: requote, again: async () => {
      const now = () => $(`#sz-go-${pid}`);
      for (let i = 0; i < 120 && (!now() || now().disabled || now().getAttribute('aria-busy') === 'true'); i++) await sleep(1000);
      if (now() && !now().disabled) now().click(); else toast('Open the farm again and press the zap.', true);
    } });
  });
}
function farmJoin(el, p, status, has) {
  const r = p.reserves || {}, kA = kOfAsset(r.assetA), kB = kOfAsset(r.assetB), pid = p.pid;
  const tkB = String(p.pair).split('/').find((x) => x !== 'cETH'), other = shownAs(tkB), dpB = /BTC/.test(tkB) ? 6 : 2;
  if (!P.scan) {
    if (P.err && !P.scanning) mount(el, html`<p class="note err">Your private balance could not be read. <button class="link" type="button" data-retry="farm">Try again</button></p>`);
    else mount(el, html`<div class="kv"><span><span class="sk" style="--w:10ch"></span></span><b><span class="sk" style="--w:14ch"></span></b></div>`);
    return;
  }
  if (!kA || !kB) { mount(el, html``); return; }
  const bA = spendable(kA), bB = spendable(kB);
  if (!bA && tethComing()) comingPoll('farm');
  zapsRead();
  const comingNote = html`${zapCallout(pid)}${!bA && tethComing() ? html`<div class="callout" data-coming><span>${COMING_TETH} The farm opens with your amount once it lands.</span></div>` : ''}${P.scan.partial ? html`<p class="note err">Part of your private balance could not be read, so a side may show as none. <button class="link" type="button" data-retry="farm">Read it again</button></p>` : ''}`;
  const getB = { tac: ['tac', 'Shield TAC'], cusd: ['borrow', 'Borrow cUSD'], cbtc: ['borrow', 'Mint cBTC'] }[kB] || ['tac', `Get private ${other}`];
  const goGet = (b) => { if (running('farm')) return; const wrap = b.dataset.joinGet === 'private', label = pairName(p.pair); FARM.back = wrap ? { link: `farm/private-${pid}`, label: `farm it in ${label}`, at: Date.now() } : { pid, label, at: Date.now() }; if (wrap) hxDraft({ mode: 'wrap', all: true }); $('#sheet-farm').close(); openLink(b.dataset.joinGet); };
  FARM.jm ||= {};
  const mode = FARM.jm[pid] || (bA && bB ? 'pair' : bA ? 'a' : bB ? 'b' : 'eth');
  if (mode !== 'eth') FARM.jm[pid] = mode;
  const seg = segSub('sjm', mode, [['eth', 'ETH'], ['a', 'tETH'], ['b', other], ['pair', 'Both']]);
  const wireSeg = () => { wireSub(el, 'sjm', (m) => { FARM.jm[pid] = m; [`sj-a-${pid}`, `sj-b-${pid}`, `sz-a-${pid}`].forEach((id) => delete KEPT[id]); keep($('#sheet-farm'), render.farm); }); $$('[data-join-get]', el).forEach((b) => b.onclick = () => goGet(b)); wireZapFinish(p, status); };
  if (mode === 'eth') { farmZap(el, p, status, has, { seg, coming: comingNote, other, dpB, tkB }); wireSeg(); return; }
  const sd = joinSides(p, mode === 'b' ? 'b' : 'a'), { kS, kO, unit, dp, icon } = sd;
  const single = mode !== 'pair', both = mode === 'pair' && bA > 0n && bB > 0n;
  const how = mode === 'pair'
    ? (both ? 'Both go in at the pool’s ratio, with nothing swapped.'
      : html`You hold no private ${bA ? other : 'tETH'}, and tETH + ${other} takes both. <button class="link" type="button" data-join-get="${bA ? getB[0] : 'private'}">${bA ? getB[1] : 'Shield ETH'}</button>, or <button class="link" type="button" data-join-one="${bA ? 'a' : 'b'}">farm with ${bA ? 'tETH' : other} alone</button>.`)
    : !(spendable(kS) > 0n) ? html`You hold no private ${unit[kS]}. <button class="link" type="button" data-join-get="${kS === kA ? 'private' : getB[0]}">${kS === kA ? 'Shield ETH' : getB[1]}</button>, or <button class="link" type="button" data-join-one="${kS === kA ? 'b' : 'a'}">farm with ${unit[kO]} alone</button>.`
    : `About half is swapped to ${unit[kO]} inside the pool, then both go into the farm: two steps when one note covers it, about a minute.`;
  const field = (k, id) => html`
    <div class="lbl"><span>${unit[k]}</span><span>Private ${fmt(spendable(k), 8, dp[k])} ${unit[k]}${inUse(k, 8, dp[k], unit[k])}</span></div>
    <div class="amt"><input id="${id}" inputmode="decimal" placeholder="0.00" autocomplete="off" aria-label="${unit[k]} to add"><span class="u"><svg class="tk sm" aria-hidden="true"><use href="#${icon[k]}"/></svg>${unit[k]}</span></div>`;
  mount(el, html`${comingNote}
    <div class="lbl"><span>${has ? 'Add more' : 'Add and farm'}</span>${single || both ? html`<button type="button" id="sj-max-${pid}">Max</button>` : ''}</div>
    ${seg}
    <p class="note how">${how}</p>
    ${single || both ? html`
      ${mode !== 'b' ? field(kA, `sj-a-${pid}`) : ''}
      ${mode !== 'a' ? field(kB, `sj-b-${pid}`) : ''}
      <div class="rcpt" id="sj-rcpt-${pid}" hidden></div>
      <div id="sj-ack-${pid}"></div>
      <div class="stick"><button class="btn" type="button" id="sj-go-${pid}" disabled>${single ? `Farm with ${unit[kS]}` : has ? 'Add to the farm' : 'Add and farm'}</button></div>
      <p class="note">The relay proves the bond and ${your()} sends it, paying its network fee, so that account is seen joining this farm. What you add shows in the pool’s public reserves, as all liquidity does; your private balances do not.</p>` : ''}`);
  wireSeg();
  $$('[data-join-one]', el).forEach((b) => b.onclick = () => { if (running('farm')) return; FARM.jm[pid] = b.dataset.joinOne; keep($('#sheet-farm'), render.farm); });
  if (!(single || both)) return;
  const aIn = $(`#sj-a-${pid}`), bIn = $(`#sj-b-${pid}`), sIn = mode === 'b' ? bIn : aIn, go = $(`#sj-go-${pid}`), rc = $(`#sj-rcpt-${pid}`), ackBox = $(`#sj-ack-${pid}`);
  let q = null, seq = 0;
  const reading = () => { mount(rc, html`<p class="note">Reading the pool and the relay’s fees…</p>`); rc.hidden = false; };
  const gateOk = () => { go.disabled = !q || q.over || q.gasShort || !lossOk(ackBox, q.impact || 0); };
  const yieldRows = (shares, a) => joinYield(p, shares, a);
  const gasRow = (j) => html`<div class="kv"><span>Network fee, from ${your()}</span><b>about ${fmt(j.gas, 18, 5)} ETH</b></div>`;
  const quotePair = async (e, my, t, j) => {
    const res = j.res;
    if (e?.target === bIn) { const b = parseUnits(bIn.value, 8), a0 = parseUnits(aIn.value, 8); if (!b) aIn.value = ''; else if (!a0 || bFor(a0, res) !== b) aIn.value = plain(aFor(b, res), 8); }
    const a = parseUnits(aIn.value, 8) || 0n, b = a ? bFor(a, res) : 0n;
    if (e?.target !== bIn) bIn.value = a ? plain(b, 8) : '';
    if (!a) { if (!tooFine(rc, (e?.target === bIn ? bIn : aIn).value, null, 8)) rc.hidden = true; return; }
    const eth = await ethBalance();
    if (my !== seq || !go.isConnected) return;
    const { q: pq, fA, fB, shares } = joinPairPlan(t, p, j, sd, a, eth != null && eth < j.gas);
    q = pq;
    mount(rc, html`
      <div class="kv"><span>Adds</span><b>${fmt(a, 8, 6)} tETH + ${fmt(b, 8, dpB)} ${other}</b></div>
      ${yieldRows(shares, a)}
      ${fA || fB ? html`<div class="kv"><span>Relay fee to split your notes</span><b>${[fA ? `${fmt(fA, 8, 6)} tETH` : '', fB ? `${fmt(fB, 8, dpB)} ${other}` : ''].filter(Boolean).join(' + ')}</b></div>` : ''}
      ${gasRow(j)}`);
    rc.hidden = false;
    const cutFee = fA + (fB ? fB * res.reserveA / res.reserveB : 0n);
    if (q.over) warn(rc, `More than your private balance covers${fA || fB ? ' with the relay fee' : ''}. Try Max.`);
    else if (q.gasShort) warn(rc, lowEth());
    else if (cutFee * 20n >= 2n * a) warn(rc, `The relay’s fees to split your notes are ${pctFmt(Number((cutFee * 1000n) / (2n * a)) / 10)} of this deposit: a larger one, or notes that are already this size, spreads them.`);
    gateOk();
  };
  const quoteOne = async (my, t, j) => {
    const Zin = parseUnits(sIn.value, 8) || 0n;
    if (!Zin) { if (!tooFine(rc, sIn.value, null, 8)) rc.hidden = true; return; }
    const eth = await ethBalance();
    if (my !== seq || !go.isConnected) return;
    const plan = joinOnePlan(t, p, j, sd, Zin, eth != null && eth < j.gas);
    mount(rc, html``); rc.hidden = false;
    if (plan.over) { warn(rc, overBalance()); return; }
    if (plan.small) { warn(rc, `Add more than ${fmt(plan.small, 8, dp[kS])} ${unit[kS]}: the relay’s fees for the swap and the note cuts come out of it.`); return; }
    const { z, s1, s2, reuse, a, b, shares, mkt, pm, fr } = plan, worst = plan.q.impact;
    q = plan.q;
    joinAhead(p, q);
    mount(rc, html`
      <div class="kv"><span>Swaps</span><b>${fmt(z.x, 8, dp[kS])} ${unit[kS]} for about ${fmt(z.out, 8, dp[kO])} ${unit[kO]}</b></div>
      <div class="kv"><span>Then adds</span><b>${fmt(a, 8, 6)} tETH + ${fmt(b, 8, dpB)} ${other}</b></div>
      ${lossLine(z.impact)}
      ${mkt >= 1 ? html`<div class="kv"><span>Against the market</span><b class="${mkt >= 5 ? 'err' : ''}">${pctFmt(mkt)} of this deposit</b></div>` : ''}
      ${yieldRows(shares, a)}
      <div class="kv"><span>Relay fee for the swap</span><b>${fmt(fr, 8, dp[kS])} ${unit[kS]}</b></div>
      ${s1 + s2 ? html`<div class="kv"><span>Relay fee to split your notes</span><b>${fmt(s1 + s2, 8, dp[kS])} ${unit[kS]}</b></div>` : ''}
      ${reuse ? html`<p class="note">Uses the two notes already made for this: nothing is split again.</p>` : ''}
      ${gasRow(j)}`);
    mount(ackBox, lossGate(`sj-ackv-${pid}`, worst, 'deposit'));
    wireAck(ackBox, `sj-ackv-${pid}`, worst, gateOk);
    if (q.gasShort) warn(rc, lowEth());
    else if (fr * 20n >= z.x) warn(rc, `The relay fee is ${pctFmt(Number((fr * 1000n) / z.x) / 10)} of the swap: a larger deposit spreads it.`);
    else if (mkt >= 5) warn(rc, html`This pool’s price for ${pm.unit} is ${pctFmt(Math.abs(pm.ratio - 1) * 100)} ${pm.ratio > 1 ? 'above' : 'below'} the market’s, and the swap is made at it${spendable(kO) > 0n ? html`. <button class="link" type="button" data-join-one="pair">Adding ${unit[kO]} too</button> needs no swap` : ''}.`);
    else if (z.impact >= 5) warn(rc, html`The swap inside the pool costs a lot at this size. A smaller deposit costs less${spendable(kO) > 0n ? html`, and so does <button class="link" type="button" data-join-one="pair">adding ${unit[kO]} too</button>` : ''}.`);
    rc.querySelector('[data-join-one]')?.addEventListener('click', () => { if (running('farm')) return; FARM.jm[pid] = 'pair'; keep($('#sheet-farm'), render.farm); });
    gateOk();
  };
  const requote = async (e) => {
    const my = ++seq;
    q = null; go.disabled = true; mount(ackBox, html``);
    if ((aIn?.value || bIn?.value) && !JOIN[pid]) reading();
    try {
      const t = await getUx(), j = await joinTerms(t, p);
      if (my !== seq || !go.isConnected) return;
      await (single ? quoteOne(my, t, j) : quotePair(e, my, t, j));
    } catch (e2) { if (my === seq) quoteErr(rc, e2); }
  };
  onEdit([aIn, bIn].filter(Boolean), go, requote);
  takeDraft('join', mode === 'b' ? bIn : aIn, (d) => d.pid === pid && mode === (d.side || 'a'));
  const fillMax = async (auto = false) => {
    if (!JOIN[pid]) reading();
    try {
      const t = await getUx(), j = await joinTerms(t, p);
      const typed = () => !!($(`#sj-a-${pid}`)?.value || $(`#sj-b-${pid}`)?.value);
      const fill = (id, v) => { const i = $(`#${id}`); if (!i || (auto && typed())) return; i.value = v > 0n ? plain(v, 8) : ''; i.dispatchEvent(new Event('input')); };
      fill(single ? `sj-${mode}-${pid}` : `sj-a-${pid}`, joinMax(p, j, sd, mode));
    } catch (e) { const rn = $(`#sj-rcpt-${pid}`); if (rn) quoteErr(rn, e); }
  };
  $(`#sj-max-${pid}`).onclick = () => fillMax();
  const autoKey = `${pid}:${mode}`;
  if (aIn?.value || bIn?.value) requote({ target: sIn });
  else if (!has && !FARM.auto[autoKey]) { FARM.auto[autoKey] = true; fillMax(true); }
  go.onclick = () => busy(go, async (run) => {
    const z = q;
    if (!z || z.over || z.gasShort || !lossOk(ackBox, z.impact || 0)) return;
    await joinNow({ run, p, z, sd, btn: 'Add and farm', line: () => $(`#sf-status-${pid}`) || status, moved: () => requote({}), swapped: () => { FARM.jm[pid] = 'pair'; },
      clear: () => { [aIn, bIn].filter(Boolean).forEach(clearField); delete acked[`sj-ackv-${pid}`]; }, after: () => rerender('farm') });
  });
}
const BSRC = { src: null };
function redeemPanel() {
  if (!redeemOn() || !REDEEM.op || REDEEM.pub !== S.key?.pubHex) return '';
  const l = bondsNow()?.locks.find((x) => x.op === REDEEM.op);
  if (!l) return '';
  const N = fmt(BigInt(l.vBtc), 8, 8), R = REDEEM.plan, r = R?.plan, step = redeemStep(r), sent = redeemSent(l), b = REDEEM.built;
  const link = (h) => html`<a href="${MEMPOOL}/tx/${h}" target="_blank" rel="noopener">${short(h, 6)} ↗</a>`;
  const c = (v) => `${fmt(BigInt(v), 8, 8)} cBTC`;
  const body = REDEEM.err ? html`<p class="note err">${errText(REDEEM.err)}</p><button class="btn ghost" type="button" id="bw-redeem-again">Try again</button>`
    : !r ? html`<p class="note">Reading the lock and your cBTC on Bitcoin…</p>`
    : r.step === 'done' ? html`<p class="note">Redeemed${sent ? html`: ${link(sent.reveal)}` : ''}. The bond above can be taken back.</p>`
    : r.step === 'gone' ? html`<p class="note err">This lock was spent on Bitcoin without a redeem, so there is nothing to redeem. Its bond goes to the insurance reserve.</p>`
    : r.step === 'unminted' ? html`<p class="note">No cBTC was minted on this lock, so there is nothing to burn. Its bond can be taken back above.</p>`
    : r.step === 'unknown' ? html`<p class="note">The pool has not recorded this lock yet.</p>`
    : sent ? html`<p class="note">Sent: ${link(sent.reveal)}. Bitcoin’s proof on Ethereum records it within a few hours. The lock then reads redeemed and its bond can be taken back above.</p>`
    : r.step === 'toobig' ? html`<p class="note err">One bridge takes at most ${c(R.cap)} and this lock needs ${c(r.bridge)}. Redeeming a lock this large is not offered here yet.</p>`
    : r.step === 'buy' && R.loans ? html`<p class="note">Your cBTC backs ${R.loans === 1 ? 'a loan' : `${R.loans} loans`}. Repay ${R.loans === 1 ? 'it' : 'them'} under Borrow cUSD above: the cBTC comes back and counts toward the redeem.</p>`
    : r.step === 'buy' ? html`<p class="note">You hold ${c(R.held)} privately. Redeeming needs ${c(r.bridge)}: the lock’s ${N} BTC${r.have ? `, less the ${c(r.have)} already on Bitcoin,` : ''} and the relay fee of ${c(R.fee)}. ${c(r.lack)} more.</p>
        <a class="btn ghost" href="#card=swap:ether:cbtc:private">Get cBTC in Swap</a>`
    : step === 'bridge' ? html`<p class="note">Bridge exactly ${c(r.bridge)} to Bitcoin: ${c(r.short)} for the lock${r.have ? ' (the rest of it)' : ''} and the relay fee of ${c(R.fee)}. It must be exact, since a redeem burns the lock’s value to the satoshi.</p><div id="bw-xo"></div>`
    : step === 'arriving' ? html`<p class="note">cBTC is on its way to Bitcoin. When it has arrived and Bitcoin’s proof holds it, this reads Redeem.</p><div id="bw-xo"></div>`
    : html`<div class="kv"><span>Burns</span><b>${c(l.vBtc)} on your Bitcoin address</b></div>
      <div class="kv"><span>Unlocks</span><b>${N} BTC, back to your Bitcoin address</b></div>
      ${b ? html`<div class="kv"><span>Bitcoin fees</span><b>${(b.commitFee + b.revealFee).toLocaleString('en-US')} sats, from ${viewAddr(b.address, 6)}</b></div>
        <label class="pick"><input type="checkbox" id="bw-redeem-ack" ${REDEEM.acked ? 'checked' : ''}><span>I understand the cBTC is burned and the lock is spent, and neither can be undone.</span></label>
        <button class="btn" type="button" id="bw-redeem-send" ${REDEEM.acked ? '' : 'disabled'}>Redeem</button>`
      : html`<button class="btn" type="button" id="bw-redeem-go">Review</button>`}`;
  return html`<div class="blk" id="bw-redeem"><div class="lbl"><span>Redeem ${N} BTC</span><button type="button" id="bw-redeem-x">close</button></div>${body}</div>`;
}
function wireRedeem(el, status) {
  $$('[data-redeem]', el).forEach((btn) => btn.onclick = () => {
    Object.assign(REDEEM, { op: btn.dataset.redeem, pub: S.key.pubHex, plan: null, err: null, built: null, acked: false });
    rerender('borrow'); redeemRefresh();
  });
  const x = $('#bw-redeem-x', el); if (x) x.onclick = () => { REDEEM.op = null; rerender('borrow'); };
  const again = $('#bw-redeem-again', el); if (again) again.onclick = () => { Object.assign(REDEEM, { err: null, plan: null }); rerender('borrow'); redeemRefresh(); };
  const go = $('#bw-redeem-go', el); if (go) go.onclick = () => busy(go, (run) => redeemBuild(run, status));
  const ack = $('#bw-redeem-ack', el), send = $('#bw-redeem-send', el);
  if (ack && send) { ack.onchange = () => { REDEEM.acked = ack.checked; send.disabled = !ack.checked; }; send.onclick = () => busy(send, (run) => redeemSend(run, status)); }
  const xo = $('#bw-xo', el), r = REDEEM.plan?.plan, step = redeemStep(r), l = REDEEM.op && bondsNow()?.locks.find((x) => x.op === REDEEM.op);
  if (xo && (step === 'bridge' || step === 'arriving')) {
    xoOut(xo, status, XA_REDEEM);
    const amt = $('#xkr-amt', xo);
    if (amt && step === 'bridge') { amt.value = plain(r.bridge, 8); amt.dispatchEvent(new Event('input')); }
  }
  clearTimeout(REDEEM.poll);
  const poll = () => { if (!REDEEM.op || !$('#sheet-borrow')?.open) return; if (document.hidden) REDEEM.poll = setTimeout(poll, 60e3); else redeemRefresh(); };
  if ($('#bw-redeem', el) && r && !REDEEM.err && (step === 'arriving' || (l && redeemSent(l) && r.step !== 'done'))) REDEEM.poll = setTimeout(poll, 60e3);
}
function bondsBlock() {
  const locks = (bondsNow()?.locks || []).filter((l) => l.total > 0n || l.bonds.length);
  if (!locks.length) return '';
  const what = { pending: 'not minted yet, can come back', backing: 'backs your cBTC until you redeem', free: 'can come back', forfeit: 'forfeit', slashed: 'in the insurance reserve' };
  const link = (l) => (l.txid ? html`<a href="${MEMPOOL}/tx/${l.txid}" target="_blank" rel="noopener">${short(l.txid, 6)} ↗</a>` : html`<span class="mono">${short(l.op, 6)}</span>`);
  const everyday = locks.filter((l) => l.everyday).length;
  return html`<div class="blk" id="bw-bonds">
    <div class="lbl"><span>Your bonds</span></div>
    ${locks.filter((l) => l.state === 'forfeit').map((l) => html`<div class="callout bad"><span>Lock ${link(l)} was spent on Bitcoin before its cBTC was redeemed, so its ${fmt(l.total, 18, 5)} wstETH bond cannot come back. It goes to the insurance reserve, which backs the ${fmt(l.vBtc, 8, 8)} cBTC minted on it.</span></div>`)}
    ${locks.filter((l) => l.health && !l.health.healthy).map((l) => html`<div class="callout bad"><span>Lock ${link(l)}: its bond is ${fmt(l.health.want - l.health.have, 18, 5)} wstETH short of what the engine asks for. Top it up${l.health.due ? ` by ${bondDue(l.health.due)}` : ''}, or it can go to the insurance reserve.</span><button class="btn ghost" type="button" data-bond-topup="${l.op}">Top up</button></div>`)}
    ${locks.map((l) => html`<div class="kv"><span>${l.vBtc ? `${fmt(l.vBtc, 8, 8)} BTC` : 'Lock'} · ${link(l)}${l.everyday ? ' · everyday address' : ''}</span><b class="${l.state === 'forfeit' ? 'err' : ''}">${fmt(l.total, 18, 5)} wstETH${l.par ? ` · ${fmt(l.total * 100n / l.par, 2, 2)}× the BTC` : ''} · ${what[l.state]}</b></div>
      ${l.state === 'backing' && l.par ? html`<button class="btn ghost" type="button" data-bond-add="${l.op}">Add 0.25× to this bond</button>` : ''}
      ${l.state === 'backing' && l.txid && redeemOn() ? html`<button class="btn ghost" type="button" data-redeem="${l.op}">Redeem this lock</button>` : ''}
      ${l.bonds.filter((b) => b.take && bondVia(b.account)).map((b) => html`<button class="btn ghost" type="button" data-bond-take="${l.op}|${b.contract}|${b.account}">Take back ${fmt(b.share, 18, 5)} wstETH to your ${bondVia(b.account) === 'tacit' ? 'Key address' : 'wallet'}</button>`)}
      ${bondElsewhere(l) ? html`<button class="btn ghost" type="button" data-bond-conn>Connect the wallet that posted it</button>` : ''}`)}
    ${everyday ? html`<p class="note">${everyday === 1 ? 'One lock holds its' : `${everyday} locks hold their`} BTC at your everyday Bitcoin address, where early locks put it. This app never spends it, but another Bitcoin wallet using this key would see it as spendable, and spending it gives up its bond. Keep this key out of other Bitcoin wallets until you redeem.</p>` : ''}
    <p class="note">A bond is held as wstETH, which keeps earning staking yield, and comes back as wstETH to the account that posted it, before its lock is minted against or once the lock is redeemed. It must be at least 1.5× the BTC when the lock is minted against, then moves with the price of ETH in BTC; adding to it keeps the lock well covered. Spending a lock’s BTC any other way gives its bond to the insurance reserve.</p>
    ${redeemPanel()}
  </div>`;
}
render.borrow = () => {
  const el = $('#borrow-body');
  if (!needKey(el, 'Borrow dollars against your bitcoin, which stays at an address only your key can spend.', 'btc')) return;
  const st = LOCK.state, rec = st?.rec;
  const intro = html`<p class="lede-s">Borrow cUSD against your bitcoin, which never leaves an address only your key can spend. A refundable wstETH bond stands behind the lock.</p>`;
  const wireBwFinish = () => wireFinish(el, 'borrow', 'bw-finish', 'bw-status');
  if (!st) {
    const blanks = [
      ['Lock BTC', 'Send BTC to an output only your key can spend, then lock it.'],
      ['Post the wstETH bond', 'A bond of wstETH worth at least 1.5× the BTC, staked from your ETH in one transaction. Refundable, as wstETH.'],
      ['Mint cBTC', 'One to one against the lock, free, once Bitcoin confirms it and the bond is posted.'],
      ['Borrow cUSD', 'Borrow against the cBTC up to the pool’s floor. Repay anytime to reclaim it.'],
    ];
    mount(el, html`${intro}${depositCallout('borrow', 'bw-finish')}
      <ol class="steps">${blanks.map(([h, d], i) => html`<li class="step"><span class="n">${i + 1}</span><div><h3>${h}</h3><div class="d">${d}</div></div></li>`)}</ol>
      <div class="status" role="status" id="bw-status">${FLASH['bw-status'] ? '' : html`<span class="sk ln" style="--w:40%"></span>`}</div>`);
    wireBwFinish();
    loadBorrow().then(() => rerender('borrow')).catch((e) => sayRetry($('#bw-status'), e, 'borrow'));
    return;
  }
  const stepCls = (done, now2) => done ? 'step done' : now2 ? 'step now' : 'step';
  const s1 = !!rec, s3 = !!st.minted, s2 = !!st.bonded || s3, s4 = !!st.borrowed;
  const confs = st.confs == null ? null : Math.max(0, Math.min(24, st.confs || 0));
  const attested = st.refl?.attestedHeight, lag = attested && st.tip ? Math.max(0, st.tip - attested) : null;
  const bf = s1 && !s2 && st.payEth ? bondFunds() : null;
  const need = bf ? st.payEth + bf.gas : 0n, shortEth = !!bf && bf.bal != null && bf.bal < need;
  const bondFlight = s1 && !s2 ? hxBwInflight(st, 2) : null;
  const form = html`
            <div class="d">Send BTC to your Bitcoin address, then lock it. Your Tacit key signs the lock here.</div>
            <div class="kv"><span>Address</span><b class="mono">${viewAddr(st.addr, 8)}</b><button class="link" type="button" data-copy="${st.addr}">copy</button><button class="link" type="button" id="bw-qr-t" aria-expanded="${String(LOCK.qr === st.addr)}">${LOCK.qr === st.addr ? 'hide QR' : 'QR'}</button></div>
            ${LOCK.qr === st.addr ? html`<div class="keyqr" id="bw-qr"></div>` : ''}
            <div class="kv"><span>Balance</span><b>${st.sats == null ? '—' : html`${fmt(st.sats, 8, 8)} BTC${st.pendingSats ? html` <span class="mute">(${fmt(st.pendingSats, 8, 8)} unconfirmed)</span>` : ''}`}</b></div>
            <div class="amt act"><input id="bw-amt" inputmode="decimal" placeholder="0.001" autocomplete="off" aria-label="BTC to lock"><span class="u"><svg class="tk sm" aria-hidden="true"><use href="#tk-btc"/></svg>BTC</span></div>
            <div class="row2"><button class="btn ghost" type="button" id="bw-fund">Send from Bitcoin wallet</button><button class="btn" type="button" id="bw-lock">Lock BTC</button></div>
            <div class="status" role="status" id="bw-s1"></div>
            ${st.lockWaiting ? html`<p class="note err">A lock of yours is not all on Bitcoin yet. It is sent again on its own, every half minute while this is open.</p>` : ''}
            <p class="note">Xverse, Leather or UniSat send it in one popup, or pay the address from anywhere. Locking waits for one confirmation.</p>
            ${lag != null ? html`<p class="note">Minting waits for Bitcoin’s proof on Ethereum to reach the lock’s block, which trails Bitcoin by at least 24 blocks (about 4 hours). It is at block ${attested.toLocaleString('en-US')}, ${lag.toLocaleString('en-US')} behind Bitcoin${lag > 36 ? ' and catching up' : ''}. Until it is minted, its bond can be taken back.</p>` : ''}`;
  const cbtcId = P.scan?.cbtc?.id, notes = cbtcId ? freeNotes(P.scan.cbtc.notes).sort(byValue) : [];
  const heldSats = notes.reduce((a, n) => a + BigInt(n.value), 0n), top = notes.at(-1);
  const loans = cbtcId ? (st.loans?.positions || []).filter((p) => p.live !== false && (p.basket || []).some((l) => String(l.asset).toLowerCase() === cbtcId)) : [];
  const payee = payer() === 'tacit' ? S.acct?.address : S.address;
  const pubSats = payee && CSEND.pubFor === payee && CSEND.pub ? CSEND.pub.cbtc / 10n ** 10n : 0n;
  const holdOn = heldSats > 0n || pubSats > 0n || loans.length > 0;
  const src = heldSats > 0n && (BSRC.src !== 'pub' || pubSats === 0n) ? 'priv' : pubSats > 0n ? 'pub' : null;
  const avail = src === 'pub' ? pubSats : heldSats, dflt = src === 'pub' ? pubSats : top ? BigInt(top.value) : 0n;
  const usdOf = (sats) => (st.px ? sats * st.px / 10n ** 8n : 0n);
  const loanRow = (p, i) => {
    const sats = BigInt(p.basket.find((l) => String(l.asset).toLowerCase() === cbtcId).value), debt = BigInt(p.debtValue), usd = usdOf(sats);
    const ratio = usd && debt ? Number(usd * 10000n / debt) / 100 : null, liqAt = debt && sats ? Number(debt) * Number(st.liq) / (1e4 * Number(sats)) : null;
    return html`<div class="kv"><span>${fmt(debt, 8, 2)} cUSD against ${fmt(sats, 8, 8)} cBTC</span><b class="${ratio == null ? '' : ratio < Number(st.ratio) / 100 ? 'err' : ratio < 175 ? 'warn' : ''}">${ratio == null ? '' : `${Math.round(ratio)}%`}</b></div>
      ${liqAt ? html`<div class="kv"><span>Liquidated below</span><b>$${Math.round(liqAt).toLocaleString('en-US')} a bitcoin</b></div>` : ''}
      <button class="btn ghost" type="button" ${i === 0 ? new Raw('id="bw-repay" ') : ''}data-repay="${i}">${LOCK.repayOver ? 'Repay anyway' : 'Repay'}</button>`;
  };
  const cusdHeld = P.scan?.cusd, cusdNote = cusdHeld ? freeNotes(cusdHeld.notes).sort(byValue).at(-1) : null;
  const holdBlock = !holdOn ? '' : html`<div class="blk" id="bw-hold">
    ${src ? html`
      <div class="lbl"><span>Borrow cUSD</span>${heldSats > 0n && pubSats > 0n
        ? html`<span><button type="button" data-bh-src="priv" aria-pressed="${src === 'priv'}">Private ${fmt(heldSats, 8, 8)} cBTC</button> · <button type="button" data-bh-src="pub" aria-pressed="${src === 'pub'}">${fmt(pubSats, 8, 8)} tacBTC</button></span>`
        : html`<span>${src === 'pub' ? html`${fmt(pubSats, 8, 8)} tacBTC in ${your()}` : html`Private ${fmt(heldSats, 8, 8)} cBTC`}</span>`}</div>
      <div class="amt act"><input id="bw-debt" inputmode="decimal" placeholder="${st.px ? plain(usdOf(dflt) / 2n / 10n ** 6n * 10n ** 6n, 8) : '0'}" autocomplete="off" aria-label="cUSD to borrow"><span class="u"><svg class="tk sm" aria-hidden="true"><use href="#tk-cusd"/></svg>cUSD</span></div>
      <div class="seg sub" role="group" aria-label="Collateral ratio">${[250, 200, 175].map((r) => html`<button type="button" data-bh-ratio="${r}">${r}%</button>`)}</div>
      <div class="rcpt" id="bw-rcpt" hidden></div>
      <details class="lockmore"><summary>Put up a different amount</summary><div class="amt"><input id="bh-coll" inputmode="decimal" placeholder="${plain(dflt, 8)}" autocomplete="off" aria-label="${src === 'pub' ? 'tacBTC' : 'cBTC'} to put up"><span class="u"><svg class="tk sm" aria-hidden="true"><use href="#tk-${src === 'pub' ? 'tacbtc' : 'cbtc'}"/></svg>${src === 'pub' ? 'tacBTC' : 'cBTC'}</span></div></details>
      ${src === 'priv' ? html`<label class="pick"><input type="checkbox" id="bw-pts"><span>Send the loan from ${your()} to earn points. It pays the network fee and is linked to the loan.</span></label>` : ''}
      <button class="btn" type="button" id="bw-borrow">Borrow cUSD</button>` : ''}
    ${st.loans === null ? html`<p class="note err">Your loans could not be read. <button class="link" type="button" data-retry="loan">Try again</button></p>` : ''}
    ${loans.length ? html`<div class="lbl"><span>Your loans</span></div>${loans.map(loanRow)}
      <p class="note">Repaying burns the cUSD you hold privately and returns the cBTC as a private note. tacUSD withdrawn to an account is made private again under Send, below.</p>` : ''}
    ${cusdNote ? html`<div class="kv"><span>Private cUSD</span><b>${fmt(cusdHeld.value, 8, 2)}</b></div><button class="btn ghost" type="button" id="bw-out">Withdraw ${fmt(BigInt(cusdNote.value), 8, 2)} as tacUSD</button>
      <button class="link" type="button" data-farm-with="cusd">Or farm it for TAC →</button>` : ''}
    <div class="status" role="status" id="bw-s4"></div>
  </div>`;
  mount(el, html`
    ${s1 || holdOn ? '' : intro}${depositCallout('borrow', 'bw-finish')}
    ${holdBlock}
    ${holdOn ? new Raw(`<details class="lockmore"${(s1 && !s3) || LOCK.focus ? ' open' : ''}><summary>Get cBTC from BTC</summary>`) : ''}<ol class="steps">
      <li class="${stepCls(s1, !s1)}">
        <span class="n">${s1 ? '✓' : '1'}</span>
        <div>
          <h3>Lock BTC</h3>
          ${s1 ? html`<div class="d">${fmt(BigInt(rec.vBtc), 8, 8)} BTC in your own output · <a href="${MEMPOOL}/tx/${rec.lockTxid}" target="_blank" rel="noopener">${short(rec.lockTxid, 6)} ↗</a></div>
            <details class="lockmore"><summary>Lock more BTC</summary>${form}</details>` : form}
        </div>
      </li>
      <li class="${stepCls(s2, s1 && !s2)}">
        <span class="n">${s2 ? '✓' : '2'}</span>
        <div>
          <h3>Post the wstETH bond</h3>
          <div class="d">${s2 ? 'Posted as wstETH, earning while it bonds the lock. Spending the BTC without redeeming forfeits it.' : s1 && st.payEth ? html`${fmt(st.payEth, 18, 5)} ETH${st.have ? ' more, as the price moved since the bond was posted' : ''}, staked as wstETH and earning while it bonds the lock. Spending the BTC without redeeming forfeits it.` : 'A bond of wstETH worth at least 1.5× the BTC, staked from your ETH in one transaction. Refundable, as wstETH.'}</div>
          ${bondFlight ? html`<p class="note">${HX_FLIGHT[2]}${bondFlight.hash ? html` ${txLink(bondFlight.hash)}` : ''}</p><button class="btn ghost" type="button" data-act-open>Follow it in Activity</button>`
            : s1 && !s2 ? (st.payEth ? html`
            <div class="kv"><span>Paid from ${your()}${payer() === 'tacit' && S.acct ? html` · <span class="mono">${viewAddr(S.acct.address, 6)}</span> <button class="link" type="button" data-copy="${S.acct.address}">copy</button>` : ''}</span><b>${bondNoWallet() ? 'not connected yet' : bf?.bal == null ? '…' : html`${fmt(bf.bal, 18, 5)} ETH`}</b></div>
            ${bondNoWallet() ? html`<p class="note">The button connects your Ethereum wallet. No wallet? <button class="link" type="button" data-fund>Send ETH to this key’s own address</button> and the bond is paid from there.</p>` : ''}
            ${shortEth && !bwCanWst(st) ? html`<p class="note err">The bond and its network fee come to about ${fmt(need, 18, 5)} ETH. ${payer() === 'tacit' ? html`Top up this key’s address from a connected wallet and the bond posts in the same go, or <button class="link" type="button" data-fund>add ETH another way</button> and post it once that arrives.` : 'Add ETH to your wallet, and Post bond opens once it arrives.'}</p>` : ''}
            ${bwCanWst(st) ? html`<p class="note">${your().replace(/^./, (c) => c.toUpperCase())} holds ${fmt(st.wst, 18, 5)} wstETH: the bond can be ${fmt(st.gapWst, 18, 5)} of it, approved by a signature and posted in the same transaction.</p>
              <button class="btn" type="button" id="bw-bond" data-bw-bond="wst">${st.have ? 'Top up bond' : 'Post bond'} with wstETH</button><button class="btn ghost" type="button" data-bw-bond="eth" ${shortEth ? 'disabled' : ''}>Or with ${fmt(st.payEth, 18, 5)} ETH</button>`
              : shortEth && payer() === 'tacit' ? html`<button class="btn" type="button" id="bw-topup">Top up from wallet and post bond</button>` : html`<button class="btn" type="button" id="bw-bond" data-bw-bond="eth" ${shortEth ? 'disabled' : ''}>${bondNoWallet() ? 'Connect wallet and post bond' : st.have ? 'Top up bond' : 'Post bond'}</button>`}
            <div class="status" role="status" id="bw-s2"></div>` : html`<div class="d err">The BTC price feed is updating; the bond can be sized again in a few minutes.</div>`) : ''}
          ${s1 && !s3 && !bondFlight ? (st.have ? html`<p class="note">To take the BTC back instead, take its bond back first, under Your bonds.</p>`
            : html`<p class="note"><button class="link" type="button" id="bw-unlock">${LOCK.unlockAsk === lockId(rec) ? 'Take it back' : 'Changed your mind? Take the BTC back'}</button></p><div class="status" role="status" id="bw-s2u"></div>`) : ''}
        </div>
      </li>
      <li class="${stepCls(s3, s2 && !s3)}">
        <span class="n">${s3 ? '✓' : '3'}</span>
        <div>
          <h3>Mint cBTC</h3>
          <div class="d">${s3 ? html`${fmt(BigInt(rec.vBtc), 8, 8)} cBTC, a private note.` : !s1 ? 'One to one against the lock, free, once Bitcoin confirms it and the bond is posted.' : st.reflected ? 'Your lock is proven on Ethereum. Mint is free.' : confs == null ? 'Confirmed on Bitcoin. Its count of confirmations could not be read.' : confs < 24 ? `Bitcoin confirmations ${confs} of 24.` : html`Confirmed. Waiting for the proof to reach block ${st.height}${attested ? ` (at ${attested} now)` : ''}. <a href="/prove/#tab=bitcoin&need=${st.height + 24}&why=lock">Speed this up →</a>`}</div>
          ${s2 && !s3 ? html`<button class="btn" type="button" id="bw-mint" ${st.reflected ? '' : 'disabled'}>Mint cBTC</button><div class="status" role="status" id="bw-s3"></div>` : ''}
        </div>
      </li>
      ${holdOn ? '' : html`<li class="${stepCls(s4, s3 && !s4)}">
        <span class="n">${s4 ? '✓' : '4'}</span>
        <div>
          <h3>Borrow cUSD</h3>
          <div class="d">${s4 ? html`Borrowed ${fmt(st.borrowed, 8, 2)} cUSD.${st.usd ? html` Collateral ratio now <b class="${st.usd * 10000n < st.borrowed * st.ratio ? 'err' : ''}">${Math.round(Number(st.usd * 10000n / st.borrowed) / 100)}%</b>; liquidation starts at ${Number(st.liq) / 100}%.` : ''}` : html`Up to ${st.usd ? `${fmt(st.usd * 10000n / st.ratio, 8, 2)} cUSD` : `about ${Math.round(1e6 / Number(st.ratio))}% of the BTC’s value`} at the ${Number(st.ratio) / 100}% floor; liquidation starts at ${Number(st.liq) / 100}%.`}</div>
          ${s3 && !s4 && st.loanErr ? html`<p class="note err">Your loans could not be read. <button class="link" type="button" data-retry="loan">Try again</button></p>` : ''}
          ${holdOn && s3 ? html`<p class="note">Borrow and repay under Borrow cUSD, above.</p>` : ''}
          ${s3 && !s4 && !st.loanErr && !holdOn ? html`
            <div class="amt act"><input id="bw-debt" inputmode="decimal" placeholder="${st.usd ? plain(st.usd / 2n / 10n ** 6n * 10n ** 6n, 8) : '0'}" autocomplete="off" aria-label="cUSD to borrow"><span class="u"><svg class="tk sm" aria-hidden="true"><use href="#tk-cusd"/></svg>cUSD</span></div>
            <div class="rcpt" id="bw-rcpt" hidden></div>
            <label class="pick"><input type="checkbox" id="bw-pts"><span>Send the loan from ${your()} to earn points. It pays the network fee and is linked to the loan.</span></label>
            <button class="btn" type="button" id="bw-borrow">Borrow cUSD</button>` : ''}
          ${s4 && !holdOn && st.cusd?.value ? html`<div class="kv"><span>Private cUSD</span><b>${fmt(st.cusd.value, 8, 2)}</b></div>${(() => { const n = freeNotes(st.cusd.notes).sort(byValue).at(-1); return n ? html`<button class="btn ghost" type="button" id="bw-out">Withdraw ${fmt(BigInt(n.value), 8, 2)} as tacUSD</button>
            <button class="link" type="button" data-farm-with="cusd">Or farm it for TAC →</button>` : ''; })()}` : ''}
          ${s4 && !holdOn ? html`<button class="btn" type="button" id="bw-repay">${LOCK.repayOver ? 'Repay anyway' : 'Repay and close'}</button>
            <div class="status" role="status" id="bw-s4"></div>
            <p class="note">Repaying burns ${fmt(st.borrowed, 8, 2)} cUSD you hold privately and returns the cBTC as a private note. tacUSD withdrawn to an account is made private again under Send, below.</p>` : ''}
        </div>
      </li>`}
    </ol>${holdOn ? new Raw('</details>') : ''}
    ${LOCK.list.length > 1 ? html`<div class="blk">
      <div class="lbl"><span>Your locks</span></div>
      ${LOCK.list.map((l) => html`<div class="kv"><span>${fmt(BigInt(l.vBtc), 8, 8)} BTC · <a href="${MEMPOOL}/tx/${l.lockTxid}" target="_blank" rel="noopener">${short(l.lockTxid, 6)} ↗</a></span>
        <b>${rec && lockId(l) === lockId(rec) ? html`${lockNext(l)} · shown above` : html`${lockNext(l)} <button class="link" type="button" data-pick="${lockId(l)}">Show</button>`}</b></div>`)}
    </div>` : ''}
    ${bondsBlock()}
    <button type="button" id="bw-see-bonds" hidden></button>
    <div class="blk" id="bw-send" hidden></div>
    <details class="lockmore" id="bw-btcx"${BWB.open ? ' open' : ''}><summary>cBTC and cUSD on Bitcoin</summary>${segSub('bwbx', BWB.k, [['cbtc', 'cBTC'], ['cusd', 'cUSD']])}<div id="bw-xo-gen"></div></details>
    <div class="status" role="status" id="bw-status"></div>`);
  const status = $('#bw-status');
  const bx = $('#bw-btcx');
  if (bx) {
    const draw = () => xoOut($('#bw-xo-gen'), status, XA[BWB.k]);
    bx.ontoggle = () => { if (bx.open === BWB.open) return; BWB.open = bx.open; if (bx.open) draw(); syncLink(); };
    wireSub(bx, 'bwbx', (k) => { BWB.k = k; rerender('borrow'); syncLink(); });
    if (BWB.open) draw();
  }
  takeDraft('lock', $('#bw-amt'));
  const qrT = $('#bw-qr-t');
  if (qrT) qrT.onclick = () => { LOCK.qr = LOCK.qr === st.addr ? null : st.addr; rerender('borrow'); $('#bw-qr-t')?.focus({ preventScroll: true }); };
  btcQr($('#bw-qr'), st.addr, 176);
  if (LOCK.focus) {
    LOCK.focus = false;
    const a = $('#bw-amt');
    if (a) { a.scrollIntoView({ block: 'center' }); if (matchMedia('(hover: hover)').matches) a.focus({ preventScroll: true }); }
  }
  const at = (n) => $('#bw-s' + n) || status;
  const only = (el) => { for (const x of [status, $('#bw-s1'), $('#bw-s2'), $('#bw-s2u'), $('#bw-s3'), $('#bw-s4')]) if (x && x !== el) say(x, ''); };
  clearTimeout(BF.poll);
  if (bondFlight) BF.poll = setTimeout(() => { const it = actGet(bondFlight.id); if (!it || ended(it)) loadBorrow(true).then(() => rerender('borrow'), () => {}); else rerender('borrow'); }, 15e3);
  else if (shortEth) BF.poll = setTimeout(() => { BF.at = 0; rerender('borrow'); }, 20e3);
  else if (s1 && !s2 && bondNoWallet()) BF.poll = setTimeout(() => rerender('borrow'), 30e3);
  const topup = $('#bw-topup');
  if (topup) topup.onclick = () => busy(topup, (run) => { only(at(2)); return BWX.topup(run, () => at(2)); });
  const unlock = $('#bw-unlock');
  if (unlock) unlock.onclick = () => busy(unlock, (run) => { only($('#bw-s2u')); return BWX.unlock(run, () => $('#bw-s2u') || status); });
  wireBwFinish();
  $$('[data-bond-take]', el).forEach((btn) => btn.onclick = () => busy(btn, (run) => takeBond(run, btn.dataset.bondTake, status)));
  $$('[data-bond-conn]', el).forEach((btn) => btn.onclick = () => busy(btn, () => connect({ key: false }).then(() => loadBonds(true), (e) => sayErr(status, e))));
  $$('[data-bond-topup]', el).forEach((btn) => btn.onclick = () => busy(btn, async (run) => {
    const l = bondsNow()?.locks.find((x) => x.op === btn.dataset.bondTopup);
    try {
      if (!l?.health) throw new Error('This bond no longer needs topping up.');
      const gapWst = l.health.want * 11n / 10n - l.health.have;
      if (gapWst <= 0n) throw new Error('This bond no longer needs topping up.');
      const value = wordAt(await ethCall(ADDR.wsteth, SEL.stEthPerWst + word(gapWst)), 0);
      const hash = await sendTx({ to: ADDR.escrow, data: SEL.postEscrowWithETH + strip(l.op), value, label: `Top up a bond by ${fmt(value, 18, 5)} ETH` });
      say(status, html`Topping up the bond… ${txLink(hash)}`);
      await waitTx(hash);
      say(status, html`<span class="ok">Bond topped up.</span> ${txLink(hash)}`);
      toast('Bond topped up');
      await settleBorrow();
    } catch (e) { txFail(run, status, e); }
  }));
  $$('[data-bond-add]', el).forEach((btn) => btn.onclick = () => busy(btn, async (run) => {
    const l = bondsNow()?.locks.find((x) => x.op === btn.dataset.bondAdd);
    try {
      if (l?.state !== 'backing' || !l.par) throw new Error('This bond no longer backs cBTC, so there is nothing to add to.');
      const value = wordAt(await ethCall(ADDR.wsteth, SEL.stEthPerWst + word(l.par / 4n)), 0);
      const hash = await sendTx({ to: ADDR.escrow, data: SEL.postEscrowWithETH + strip(l.op), value, label: `Add ${fmt(value, 18, 5)} ETH to a bond` });
      say(status, html`Adding to the bond… ${txLink(hash)}`);
      await waitTx(hash);
      say(status, html`<span class="ok">Added to the bond.</span> ${txLink(hash)}`);
      toast('Added to the bond');
      await settleBorrow();
    } catch (e) { txFail(run, status, e); }
  }));
  wireRedeem(el, status);
  $('#bw-see-bonds')?.addEventListener('click', () => $('#bw-bonds')?.scrollIntoView({ block: 'start', behavior: 'smooth' }));
  const lost = bondNotes().filter((n) => n.kind === 'lost').map((n) => n.id);
  if (lost.length) { const ack = new Set(store.get(bondAck())?.ids || []); if (lost.some((id) => !ack.has(id))) { store.set(bondAck(), { ids: [...ack, ...lost].slice(-200) }); dashSoon(); } }
  $$('[data-copy]', el).forEach((b) => b.onclick = () => copy(b.dataset.copy));
  $$('[data-pick]', el).forEach((b) => b.onclick = () => busy(b, async () => {
    LOCK.pick = b.dataset.pick;
    try { await loadBorrow(false, true); rerender('borrow'); } catch (e) { sayErr(status, e); }
  }));
  const fund = $('#bw-fund');
  if (fund) fund.onclick = () => busy(fund, () => { only(at(1)); return BWX.fund(() => at(1), parseUnits($('#bw-amt').value, 8)); });
  const lockBtn = $('#bw-lock');
  if (lockBtn) lockBtn.onclick = () => busy(lockBtn, () => { only(at(1)); return BWX.lock(() => at(1), parseUnits($('#bw-amt').value, 8)); });
  for (const b of $$('[data-bw-bond]', el)) b.onclick = () => busy(b, (run) => { only(at(2)); return BWX.bond(run, () => at(2), b.dataset.bwBond); });
  const mint = $('#bw-mint');
  if (mint) mint.onclick = () => busy(mint, (run) => { only(at(3)); return BWX.mint(run, () => at(3)); });
  const debt = $('#bw-debt'), rcb = $('#bw-rcpt');
  if (debt && !holdOn) (debt.oninput = () => {
    const v = parseUnits(debt.value || debt.placeholder, 8);
    if (!v || !st.usd) { rcb.hidden = true; return; }
    const ratio = Number(st.usd * 10000n / v) / 100;
    mount(rcb, html`<div class="kv"><span>You borrow</span><b>${fmt(v, 8, 2)} cUSD</b></div><div class="kv"><span>Collateral ratio</span><b class="${ratio < Number(st.ratio) / 100 ? 'err' : ratio < 175 ? 'warn' : ''}">${Math.round(ratio)}%</b></div>`);
    rcb.hidden = false;
  })();
  const borrow = $('#bw-borrow');
  if (borrow && !holdOn) borrow.onclick = () => busy(borrow, (run) => { only(at(4)); return BWX.borrow(run, () => at(4), parseUnits(debt.value || debt.placeholder, 8), !!$('#bw-pts')?.checked); });
  const repay = $('#bw-repay');
  if (repay && !holdOn) repay.onclick = () => busy(repay, (run) => { only(at(4)); return BWX.repay(run, () => at(4), repay); });
  if (holdOn) {
    for (const b of $$('[data-repay]', el)) b.onclick = () => busy(b, (run) => { only(at(4)); return BWX.repay(run, () => at(4), b, loans[Number(b.dataset.repay)]); });
    for (const b of $$('[data-bh-src]', el)) b.onclick = () => { BSRC.src = b.dataset.bhSrc; rerender('borrow'); };
    if (src && debt && borrow) {
      const coll = $('#bh-coll'), pub = src === 'pub';
      const putUp = () => { const v = (coll.value || '').trim(); return v ? parseUnits(v, 8) : dflt; };
      const paint = () => {
        const sats = putUp();
        if (coll.value.trim() && tooFine(rcb, coll.value, sats, 8)) return;
        if (!sats || !st.px) { rcb.hidden = true; return; }
        const usd = usdOf(sats);
        debt.placeholder = plain(usd / 2n / 10n ** 6n * 10n ** 6n, 8);
        const v = parseUnits(debt.value || debt.placeholder, 8);
        if (!v) { rcb.hidden = true; return; }
        const ratio = Number(usd * 10000n / v) / 100, liqAt = Number(v) * Number(st.liq) / (1e4 * Number(sats));
        for (const b of $$('[data-bh-ratio]', el)) b.setAttribute('aria-selected', String(Math.abs(ratio - Number(b.dataset.bhRatio)) < 0.6));
        mount(rcb, html`<div class="kv"><span>You borrow</span><b>${fmt(v, 8, 2)} cUSD</b></div>
          <div class="kv"><span>Collateral ratio</span><b class="${ratio < Number(st.ratio) / 100 ? 'err' : ratio < 175 ? 'warn' : ''}">${Math.round(ratio)}%</b></div>
          <div class="kv"><span>Liquidated below</span><b>$${Math.round(liqAt).toLocaleString('en-US')} a bitcoin</b></div>
          ${sats > avail ? html`<p class="note err">You hold ${fmt(avail, 8, 8)} ${pub ? 'tacBTC' : 'cBTC privately'}.</p>`
            : pub ? html`<p class="note">One transaction from ${your()}: you sign an approval for the tacBTC, and the loan lands with the deposit.</p>`
            : notes.some((n) => BigInt(n.value) === sats) ? '' : html`<p class="note">A note of exactly ${fmt(sats, 8, 8)} cBTC is cut first, which takes a few minutes and a small relay fee in cBTC.</p>`}`);
        rcb.hidden = false;
      };
      debt.oninput = paint; coll.oninput = paint;
      for (const b of $$('[data-bh-ratio]', el)) b.onclick = () => {
        const sats = putUp();
        if (!sats || !st.px) return;
        debt.value = plain(usdOf(sats) * 100n / BigInt(b.dataset.bhRatio) / 10n ** 6n * 10n ** 6n, 8);
        paint();
      };
      paint();
      borrow.onclick = () => busy(borrow, (run) => {
        only(at(4));
        const a = { sats: putUp(), debtValue: parseUnits(debt.value || debt.placeholder, 8) };
        return pub ? BWX.borrowPublic(run, () => at(4), a) : BWX.borrowHeld(run, () => at(4), { ...a, self: !!$('#bw-pts')?.checked });
      });
    }
  }
  const out = $('#bw-out');
  if (out) out.onclick = () => busy(out, async (run) => {
    const status = at(4); only(status);
    try {
      const t = await getUx(), priv = walletPriv(), to = await payingAccount();
      const note = freeNotes((P.scan?.cusd || st.cusd).notes).sort(byValue).at(-1);
      if (!note) throw new Error('Your cUSD is in an action still going through. Try again once it is done.');
      run.take(kNote(note));
      say(status, 'The relay is proving your withdrawal…');
      let r;
      r = await proveOr({ run, types: ['unwrap'], exit: true, go: exitGo(note, to, note.value), label: `Withdraw ${fmt(BigInt(note.value), 8, 2)} cUSD as tacUSD`, sheet: 'borrow', after: () => loadBorrow(true), status: () => $('#bw-status'),
        relayed: () => t.unwrap({ note, walletPriv: priv, recipient: to, waitOpts: run.wait(`Withdraw ${fmt(BigInt(note.value), 8, 2)} cUSD as tacUSD`, 15 * 60e3, { exit: { to, units: String(note.value), note: kNote(note), from: 'cusd', sheet: 'borrow' } }) }) });
      toast(`tacUSD sent to ${your()}`);
      await settleBorrow(); say($('#bw-s4') || $('#bw-status'), html`<span class="ok">Withdrawn.</span> ${r?.txHash ? txLink(r.txHash) : ''}`);
    } catch (e) { sayErr(status, e); }
  });
  cSend($('#bw-send'), status);
};
function cSend(el, status) {
  if (!el) return;
  const who = payer() === 'tacit' ? S.acct?.address : S.address;
  if (who && (CSEND.pubFor !== who || Date.now() - CSEND.pubAt > 30e3)) readPublicTac().then((p) => { if (p && (p.cbtc || p.cusd)) rerender('borrow'); }).catch(() => {});
  const sources = [
    ...Object.entries(CS_ASSETS).map(([k, a]) => ({ id: k, k, a, pub: false, held: privateOf(k), unit: shownAs(a.tk), dec: 8 })),
    ...Object.entries(CS_ASSETS).map(([k, a]) => ({ id: `pub-${k}`, k, a, pub: true, held: CSEND.pubFor === who ? CSEND.pub?.[k] ?? 0n : 0n, unit: a.out, dec: 18 })),
  ].filter((x) => x.held > 0n);
  assetSendForm(el, status, { prefix: 'cs', sheet: 'borrow', statusId: 'bw-status', sources, pick: CSEND });
}
return { renderProve, renderAct };
}
