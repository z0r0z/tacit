// The send tab's public-payout panel: shown when the recipient field holds a plain 0x address, which a note send
// cannot pay. The payor deposits, discovers their shielded balance from their key, and pays an exact amount out
// with ux.sendUnwrap (relayed, gasless, the fee taken from what they pay, the rest kept as a hidden change note).
// The panel says plainly that this hides the sender only, and reports success only once the recipient's public
// balance has actually risen. The arithmetic and the poll live in confidential-payout.js.

import { esc, formatErr, notify } from './confidential-deployments.js';
import {
  parseRecipient, looksLikeAddress, parseUnits, formatUnits, underlyingUnits, payoutAssets, heldByAsset, notesOf,
  planPayout, planMerge, coverSince, makeBalanceReader, waitForPayout, activityView,
  PRIVACY_POINTS, poolSizeLine, coverLine, WHOLE_NOTE_LINE, NO_CHECKSUM_LINE, IRREVERSIBLE_LINE, feeExceedsLine, contractLine,
} from './confidential-payout.js';

export function payoutPanelHtml() {
  return `
        <div id="cpay-panel" style="display:none;margin-top:12px;">
          <div style="font-weight:600;">Pay this address publicly from your shielded balance</div>
          <div class="muted" style="font-size:11px;margin-top:4px;">Sends from your private balance to an ordinary Ethereum address, gasless through the relay. It hides who sent it; the address and the amount are public.</div>
          <div id="cpay-addr-note" class="muted" style="margin-top:6px;"></div>
          <div id="cpay-body">
            <label class="field-label" for="cpay-asset" style="margin-top:10px;">Asset</label>
            <select id="cpay-asset"></select>
            <div id="cpay-balance" class="muted" style="margin-top:4px;"></div>
            <div id="cpay-deposit" style="display:none;margin-top:8px;">
              <div id="cpay-deposit-text" class="muted"></div>
              <button id="cpay-deposit-btn" type="button" style="margin-top:6px;">Deposit first</button>
            </div>
            <div id="cpay-form">
              <label class="field-label" for="cpay-amount" style="margin-top:10px;">They receive</label>
              <div class="field-row">
                <input id="cpay-amount" type="text" inputmode="decimal" autocomplete="off" placeholder="Amount the recipient gets">
                <button id="cpay-review-btn" type="button">Review</button>
              </div>
            </div>
            <div id="cpay-merge" style="display:none;margin-top:8px;">
              <div id="cpay-merge-text" class="muted"></div>
              <button id="cpay-merge-btn" type="button" style="margin-top:6px;">Merge notes</button>
            </div>
            <div id="cpay-preview" style="display:none;"></div>
            <button id="cpay-confirm-btn" type="button" class="primary" style="display:none;margin-top:10px;" disabled>Confirm and pay publicly</button>
            <div id="cpay-status" class="muted field-status"></div>
          </div>
        </div>`;
}

// The latest payout this page submitted. It outlives a re-render of the tab (which rebuilds every element), and the
// poll keeps writing to whatever `cpay-activity` element currently exists.
let _activity = null;
let _inflight = false;
let _el = null;
let _wallet = null;

function paintActivity() {
  const box = _el && _el('cpay-activity');
  if (!box) return;
  // Another wallet unlocked on this page does not inherit the previous one's payout line.
  const v = _activity && _activity.wallet === _wallet ? activityView(_activity) : null;
  if (!v) { box.style.display = 'none'; box.innerHTML = ''; return; }
  const cls = v.tone === 'ok' ? 'info-card' : v.tone === 'error' ? 'info-card fail' : 'warn';
  box.style.display = '';
  box.innerHTML = `<div class="${cls}" style="margin-top:10px;overflow-wrap:anywhere;">${esc(v.text)}`
    + `${_activity.txHash ? ` <span class="muted">Settle transaction <code class="addr">${esc(_activity.txHash)}</code></span>` : ''}`
    + `${_inflight ? '' : ' <button type="button" data-dismiss style="font-size:10px;padding:1px 6px;margin-left:6px;">Dismiss</button>'}</div>`;
  const b = box.querySelector && box.querySelector('[data-dismiss]');
  if (b) b.onclick = () => { _activity = null; paintActivity(); };
}
function setActivity(patch) {
  _activity = { ..._activity, ...patch };
  paintActivity();
}

const fire = (node, type) => { try { node.dispatchEvent(new Event(type, { bubbles: true })); } catch { /* no DOM events here */ } };

// A fault in this panel must not take the note-send controls down with it.
export function wirePayout(opts) {
  try { wire(opts); } catch (e) { console.error('payout panel', e); }
}

function wire({
  ux, wallet, scan = null, own, keccak256, el = (id) => document.getElementById(id), toast = notify, sleep, now, timeoutMs, intervalMs,
} = {}) {
  _el = el;
  const walletId = ux.identity(wallet.priv).pubHex;
  _wallet = walletId;
  const $ = (id) => el(id);
  paintActivity();
  if (!$('cpay-panel') || !$('csend-recipient')) return;

  const assets = payoutAssets({ assets: ux.assets, relayFeeEligible: (t) => ux.relayFeeEligible(t) });
  const deny = [{ address: ux.cfg.pool, reason: 'That is the pool contract. Value sent to it cannot be recovered.' }];
  if (ux.cfg.router) deny.push({ address: ux.cfg.router, reason: 'That is the Tacit router contract, not a place to send a payout.' });
  for (const a of ux.assets) {
    if (!a.native && /^0x[0-9a-fA-F]{40}$/.test(String(a.underlying || '')) && !/^0x0{40}$/.test(a.underlying)) {
      deny.push({ address: a.underlying, reason: `That is the ${a.ticker.replace(/^c/, '')} token contract itself. Tokens sent to it cannot be recovered.` });
    }
  }

  const state = { scan, addr: null, plan: null, merge: null, seq: 0, busy: false };
  const held = () => heldByAsset(state.scan && state.scan.notes);
  const currentAsset = () => { const id = String(($('cpay-asset') || {}).value || '').toLowerCase(); return assets.find((a) => a.assetId === id) || null; };
  const show = (id, on) => { const n = $(id); if (n) n.style.display = on ? '' : 'none'; };
  const say = (t) => { const n = $('cpay-status'); if (n) n.textContent = t || ''; };

  // Anything the payor changes voids a review: the numbers on screen must be the ones a confirm would send.
  function invalidate() {
    state.seq++;
    state.plan = null; state.merge = null;
    show('cpay-preview', false); show('cpay-merge', false); show('cpay-confirm-btn', false);
    const p = $('cpay-preview'); if (p) p.innerHTML = '';
    const c = $('cpay-confirm-btn'); if (c) c.disabled = true;
    say('');
  }

  function renderPicker() {
    const sel = $('cpay-asset');
    if (!sel) return;
    const h = held();
    const prev = String(sel.value || '').toLowerCase();
    const top = $('csend-asset');
    const order = [...assets].sort((a, b) => (h.has(b.assetId) ? 1 : 0) - (h.has(a.assetId) ? 1 : 0));
    sel.innerHTML = order.map((a) => {
      const x = h.get(a.assetId);
      return `<option value="${esc(a.assetId)}">${esc(a.label)} · ${x ? `${esc(formatUnits(x.total, a.decimals))} shielded` : 'none shielded'}</option>`;
    }).join('');
    // Keep the choice; else follow the tab's asset select when that asset is held (or nothing is); else the first held.
    const valid = (id) => order.some((a) => a.assetId === id);
    const topId = String((top && top.value) || '').toLowerCase();
    const anyHeld = order.some((a) => h.has(a.assetId));
    sel.value = valid(prev) ? prev : (valid(topId) && (h.has(topId) || !anyHeld)) ? topId : (order[0] ? order[0].assetId : '');
  }

  function renderBalance() {
    const a = currentAsset();
    const bal = $('cpay-balance');
    if (!a) {
      if (bal) bal.textContent = 'No asset in this pool can be paid out to an address yet.';
      show('cpay-form', false); show('cpay-deposit', false);
      return;
    }
    const x = held().get(a.assetId);
    if (!state.scan) {
      if (bal) bal.textContent = 'Could not read your shielded balance yet. Review will try again.';
      show('cpay-deposit', false); show('cpay-form', true);
      return;
    }
    if (!x) {
      if (bal) bal.textContent = `Shielded balance: none in ${a.label}.`;
      show('cpay-form', false);
      return renderDeposit(a);
    }
    if (bal) {
      bal.textContent = `Shielded balance: ${formatUnits(x.total, a.decimals)} ${a.label} in ${x.count} note${x.count === 1 ? '' : 's'}`
        + (x.count > 1 ? `, largest ${formatUnits(x.largest, a.decimals)}.` : '.');
    }
    show('cpay-deposit', false); show('cpay-form', true);
  }

  function renderDeposit(a, lead) {
    const acct = ux.account(wallet.priv);
    const t = $('cpay-deposit-text');
    if (t) {
      t.innerHTML = `${esc(lead || `You have no shielded ${a.label} to pay from.`)} <b>Deposit first</b>: wrap public ${esc(a.label)} into the pool and wait for it to settle, then come back here. `
        + `Deposits are paid from your Tacit account’s Ethereum address <code class="addr">${esc(acct.address)}</code>, so fund that address first. `
        + 'The deposit itself is public; this feature only hides which deposit a later payment came from.';
    }
    const b = $('cpay-deposit-btn');
    if (b) b.textContent = `Deposit ${a.label}…`;
    show('cpay-deposit', true);
  }

  function syncRecipient() {
    const raw = String(($('csend-recipient') || {}).value || '').trim();
    const on = looksLikeAddress(raw);
    show('cpay-panel', on);
    show('csend-note-send', !on);
    invalidate();
    if (!on) { state.addr = null; return; }
    const r = parseRecipient(raw, { keccak256, deny });
    state.addr = r.ok ? r : null;
    const note = $('cpay-addr-note');
    if (note) note.textContent = r.ok ? (r.hasChecksum ? 'Address checksum verified.' : '') : r.message;
    show('cpay-body', r.ok);
    if (r.ok) { renderPicker(); renderBalance(); }
  }

  async function rescan() {
    state.scan = await ux.balance(wallet.priv);
    renderPicker(); renderBalance();
    return state.scan;
  }

  async function review() {
    if (state.busy) return;
    const a = currentAsset();
    const addr = state.addr;
    if (!a || !addr) return;
    invalidate();
    const mine = state.seq;
    let net;
    try { net = parseUnits(($('cpay-amount') || {}).value, a.decimals); } catch (e) { say(e.message); return; }
    if (net <= 0n) { say('Enter an amount greater than zero.'); return; }
    const btn = $('cpay-review-btn');
    state.busy = true; if (btn) btn.disabled = true;
    try {
      say('Reading your shielded balance…');
      const sc = await ux.balance(wallet.priv);
      if (mine !== state.seq) return;
      state.scan = sc; renderPicker(); renderBalance();
      say('Getting the relay fee…');
      const minFee = BigInt(await ux.quoteOpFee(a.ticker, 'sendunwrap'));
      if (mine !== state.seq) return;
      const feeOf = (g) => ux.quoteUnwrapFee(g, a.ticker, { minFee }).fee;
      const plan = planPayout({ notes: sc.notes, asset: a.assetId, net, feeOf, minFee });
      if (plan.ok) {
        const [feeUsd, isContract] = await Promise.all([
          ux.feeUsdFor(plan.fee, a.ticker).catch(() => null),
          ux.rpc('eth_getCode', [addr.address, 'latest']).then((c) => !!c && c !== '0x').catch(() => false),
        ]);
        if (mine !== state.seq) return;
        state.plan = { ...plan, minFee, asset: a, address: addr.address, checksummed: addr.checksummed, hasChecksum: addr.hasChecksum };
        paintPreview(state.plan, { feeUsd, isContract, poolStats: sc.poolStats });
        say('');
        return;
      }
      await explain(plan, a, sc, mine);
    } catch (e) {
      if (mine === state.seq) say(formatErr(e));
    } finally {
      state.busy = false; if (btn) btn.disabled = false;
    }
  }

  function paintPreview(p, { feeUsd, isContract, poolStats }) {
    const a = p.asset;
    const f = (v) => `${esc(formatUnits(v, a.decimals))} ${esc(a.label)}`;
    const row = (label, html) => `<div class="row"><span class="label">${label}</span> ${html}</div>`;
    const noteValue = BigInt(p.note.value);
    const lines = [...PRIVACY_POINTS];
    const pool = poolSizeLine(poolStats && poolStats.outstandingNotes);
    const cover = coverLine(coverSince({ note: p.note, poolStats }));
    if (pool) lines.push(pool);
    if (cover) lines.push(cover);
    if (p.wholeNote) lines.push(WHOLE_NOTE_LINE);
    if (p.fee > p.net) lines.push(feeExceedsLine());
    if (!p.hasChecksum) lines.push(NO_CHECKSUM_LINE);
    if (isContract) lines.push(contractLine(a.label));
    lines.push(IRREVERSIBLE_LINE);
    const box = $('cpay-preview');
    if (box) {
      box.style.display = 'block';
      box.innerHTML = `<div class="tx-preview"><h4>Review public payout</h4>`
        + row('Pay', `<b>${f(p.net)}</b> to <code class="addr">${esc(p.checksummed)}</code>`)
        + row('Relay fee', `${f(p.fee)}${feeUsd != null ? ` (about $${esc(Number(feeUsd).toFixed(2))})` : ''}, taken out of what you pay`)
        + row('You pay', `<b>${f(p.gross)}</b> from your shielded balance`)
        + row('Spends', p.wholeNote
          ? `one whole note of ${f(noteValue)}`
          : `one note of ${f(noteValue)}; the other ${f(p.change)} comes back to you as a new hidden note`)
        + row('Delivery', 'relayed and gasless: the relay pays the gas and you send nothing on-chain')
        + `<div class="warn" style="margin-top:10px;"><ul style="margin:0;padding-left:16px;">${lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul></div>`
        + '</div>';
    }
    const c = $('cpay-confirm-btn');
    if (c) { c.textContent = `Confirm: pay ${formatUnits(p.net, a.decimals)} ${a.label} publicly`; c.disabled = _inflight; c.style.display = ''; }
  }

  // A payment the notes cannot cover as they are. The message names what is short and the one thing to do.
  async function explain(plan, a, sc, mine) {
    const f = (v) => `${formatUnits(v, a.decimals)} ${a.label}`;
    if (plan.code === 'no-balance') { renderDeposit(a); say(''); return; }
    if (plan.code === 'insufficient') {
      renderDeposit(a, `You hold ${f(plan.total)} shielded, and this payment needs ${f(plan.gross)} (${f(plan.net)} to them plus a ${f(plan.fee)} relay fee).`);
      say('');
      return;
    }
    // no-single-note: enough in total, but each payout spends one note.
    let merge = null;
    try {
      const mergeFee = await ux.quoteTransferFee(plan.total, a.ticker);
      merge = planMerge({ notes: notesOf(sc.notes, a.assetId), need: plan.gross, mergeFee });
    } catch { merge = null; }
    if (mine !== state.seq) return;
    const t = $('cpay-merge-text');
    const lead = `You hold ${f(plan.total)}, but a payout spends one note and your largest is ${f(plan.largest)}; this payment needs ${f(plan.gross)}.`;
    if (merge && merge.ok && merge.covers) {
      state.merge = merge;
      if (t) t.textContent = `${lead} Merge ${merge.count} of your notes into one first: a relayed step that costs a ${f(merge.fee)} relay fee and lets the relay see those notes belong together.`;
      const b = $('cpay-merge-btn'); if (b) { b.textContent = `Merge ${merge.count} notes (fee ${f(merge.fee)})`; b.disabled = false; }
      show('cpay-merge-btn', true); show('cpay-merge', true);
    } else if (merge && merge.ok) {
      state.merge = merge;
      if (t) t.textContent = `${lead} Merging your ${merge.count} largest notes leaves ${f(merge.merged)} in one note after a ${f(merge.fee)} fee, which is still short. Merge them, then merge again, or deposit more.`;
      const b = $('cpay-merge-btn'); if (b) { b.textContent = `Merge ${merge.count} notes (fee ${f(merge.fee)})`; b.disabled = false; }
      show('cpay-merge-btn', true); show('cpay-merge', true);
    } else {
      if (t) t.textContent = `${lead} Pay a smaller amount, or deposit more.`;
      show('cpay-merge-btn', false);
      show('cpay-merge', true);
    }
    say('');
  }

  async function doMerge() {
    const m = state.merge;
    const a = currentAsset();
    if (!m || !a || state.busy || _inflight) return;
    state.busy = true;
    const b = $('cpay-merge-btn'); if (b) b.disabled = true;
    try {
      say(`Merging ${m.count} notes into one. This takes a minute or two…`);
      const id = ux.identity(wallet.priv);
      await ux.transfer({ walletPriv: wallet.priv, notes: m.notes, recipientPubHex: id.pubHex, amount: m.merged, fee: m.fee });
      say('Merged. Reading the new note…');
      for (let i = 0; i < 20; i++) {
        const sc = await ux.balance(wallet.priv);
        state.scan = sc;
        if (notesOf(sc.notes, a.assetId).some((n) => BigInt(n.value) === m.merged)) break;
        await (sleep || ((ms) => new Promise((r) => setTimeout(r, ms))))(4000);
      }
      renderPicker(); renderBalance();
      state.busy = false;
      await review();
    } catch (e) {
      say(formatErr(e, 'Merge'));
      toast(formatErr(e, 'Merge'), 'error');
      if (b) b.disabled = false;
    } finally {
      state.busy = false;
    }
  }

  async function confirm() {
    const p = state.plan;
    if (!p || state.busy) return;
    if (_inflight) { say('A payment is already in flight. Wait for it to finish.'); return; }
    const a = p.asset;
    const c = $('cpay-confirm-btn'); if (c) c.disabled = true;
    state.busy = true;
    let r, readBalance, baseline;
    try {
      say('Checking the relay fee once more…');
      const minNow = BigInt(await ux.quoteOpFee(a.ticker, 'sendunwrap'));
      const feeNow = ux.quoteUnwrapFee(p.gross, a.ticker, { minFee: minNow }).fee;
      if (feeNow > p.fee) {
        state.busy = false;
        await review();
        say(`The relay fee rose from ${formatUnits(p.fee, a.decimals)} to ${formatUnits(feeNow, a.decimals)} ${a.label} while you were reviewing. These are the new numbers.`);
        return;
      }
      readBalance = makeBalanceReader({ rpc: ux.rpc, ethCall: ux.ethCall, token: a.token, address: p.address });
      say('Reading the recipient’s balance…');
      baseline = await readBalance();
      say('Submitting to the relay…');
      _inflight = true;
      r = await ux.sendUnwrap({
        note: p.note, walletPriv: wallet.priv, recipient: p.address, amount: p.gross, feeOpts: { minFee: p.minFee }, wait: false,
      });
      if (!r || !r.jobId) throw new Error('The relay did not return a job id.');
    } catch (e) {
      _inflight = false;
      state.busy = false;
      say(formatErr(e, 'Payment'));
      toast(formatErr(e, 'Payment'), 'error');
      if (c && state.plan === p) c.disabled = false;
      return;
    }
    // Submitted: the reviewed plan is spent, so it cannot be confirmed twice.
    state.busy = false;
    invalidate();
    const paidNet = BigInt(r.payout != null ? r.payout : r.net != null ? r.net : p.net);
    const shown = { wallet: walletId, address: p.checksummed, label: a.label, amountText: formatUnits(paidNet, a.decimals), jobId: r.jobId, txHash: null, error: null };
    _activity = { ...shown, phase: 'submitted', relayStatus: r.status || null };
    paintActivity();
    if (paidNet !== p.net) say(`The relay was sent ${shown.amountText} ${a.label}, not the ${formatUnits(p.net, a.decimals)} reviewed.`);
    let out;
    try {
      out = await waitForPayout({
        readBalance, baseline, expected: underlyingUnits(paidNet, a.unitScale),
        readJob: () => ux.relay.status(r.jobId), now, sleep, timeoutMs, intervalMs,
        onTick: ({ job }) => { if (_activity && _activity.phase === 'submitted') setActivity({ relayStatus: job && job.status }); },
      });
    } catch {
      out = { status: 'timeout', delta: 0n, job: null };
    } finally {
      _inflight = false;
    }
    const txHash = (out.job && out.job.txHash) || null;
    if (out.status === 'paid') {
      setActivity({ phase: 'paid', txHash, relayStatus: null, receivedText: formatUnits(out.delta / a.unitScale, a.decimals) });
      toast(`Paid ${shown.amountText} ${a.label} to ${p.checksummed}`, 'ok');
    } else if (out.status === 'failed') {
      setActivity({ phase: 'failed', error: out.error, relayStatus: null });
      toast('The relay could not settle the payment', 'error');
    } else if (out.status === 'lost') {
      setActivity({ phase: 'lost', relayStatus: null });
    } else {
      setActivity({ phase: 'timeout', relayStatus: null });
    }
    if (state.plan) { invalidate(); say('Your balance changed after that payment. Review again.'); }
    rescan().catch(() => {});
  }

  // The existing own-address send wraps public funds into a note in one transaction; reuse it instead of a second
  // deposit form. "Always pay from my wallet" makes it wrap fresh funds even when some shielded balance exists.
  function depositFirst() {
    const a = currentAsset();
    const recip = $('csend-recipient');
    if (recip) { recip.value = own || ''; fire(recip, 'input'); }
    const top = $('csend-asset');
    if (top && a) { top.value = a.assetId; fire(top, 'change'); }
    const force = $('csend-forcewrap');
    if (force) { force.checked = true; fire(force, 'change'); }
    const amt = $('csend-amount');
    if (amt) {
      if (amt.scrollIntoView) amt.scrollIntoView({ behavior: 'smooth', block: 'center' });
      if (amt.focus) amt.focus();
    }
    const st = $('csend-status');
    if (st && a) st.textContent = `Enter the amount to deposit, then Review and Send. This wraps public ${a.label} into a shielded note you hold, in one transaction. Come back here and paste the address to pay once it has settled.`;
  }

  const guarded = (fn) => async () => { try { await fn(); } catch (e) { say(formatErr(e)); } };
  const listen = (id, type, fn) => { const n = $(id); if (n) n.addEventListener(type, fn); };
  listen('csend-recipient', 'input', syncRecipient);
  listen('cpay-amount', 'input', () => { invalidate(); renderBalance(); });
  listen('cpay-asset', 'change', () => {
    const a = currentAsset();
    const top = $('csend-asset');
    if (top && a && Array.from(top.options || []).some((o) => String(o.value).toLowerCase() === a.assetId)) { top.value = a.assetId; fire(top, 'change'); }
    invalidate(); renderBalance();
  });
  listen('csend-asset', 'change', () => {
    const sel = $('cpay-asset'); const top = $('csend-asset');
    if (sel && top && assets.some((a) => a.assetId === String(top.value).toLowerCase())) { sel.value = String(top.value).toLowerCase(); invalidate(); renderBalance(); }
  });
  const click = (id, fn) => { const n = $(id); if (n) n.onclick = guarded(fn); };
  click('cpay-review-btn', review);
  click('cpay-confirm-btn', confirm);
  click('cpay-merge-btn', doMerge);
  click('cpay-deposit-btn', depositFirst);
  syncRecipient();
}
