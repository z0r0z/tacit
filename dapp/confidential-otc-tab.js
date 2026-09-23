// Confidential OTC tab — peer-to-peer shielded swap (OP_OTC). Drives the REAL assembler/verifier
// (confidential-otc.js) over the live pool scan, then settles through the gasless relay (type 'otc').
//
// PROTOCOL NOTE: a trustless OTC is a 3-message handshake — the shared opening-sigma context binds BOTH
// parties' note commitments, so neither side can sign until both sets of commitments are exchanged. A
// note's blinding `r` MUST NEVER appear in a shared artifact (it is bearer-spend authority). This tab
// therefore does the part that is safe + guest-exact today: it VERIFIES a fully-assembled OTC offer
// (every commitment + opening sigma present, as produced by a matcher or counterparty tooling) against
// the live spend root, then submits it to the relay. The interactive composer (exchange commitments →
// each party signs its own legs → assemble) is the follow-up; it reuses these same primitives, so a
// passing verifyOtc here is the exact check the settle guest re-runs.

import { secp, sha256, keccak_256 } from './vendor/tacit-deps.min.js';
import { makeConfidentialPoolUx } from './confidential-pool-ux.js';
import { confidentialPoolReady, confidentialUnavailableHTML, esc, formatErr, notify, copyToClipboard } from './confidential-deployments.js';
import { makeConfidentialOtc } from './confidential-otc.js';
import { randomScalar } from './bulletproofs-plus.js';
import { scanHealth, scanHealthHtml, inboundBadgeHtml, inboundSummaryHtml } from './confidential-scan-health.js';

// Strip the client-only blindings (_r) from a leg before it leaves this browser. The opening sigmas (R,z)
// are zero-knowledge; the raw _r is bearer-spend authority and must never be shared.
function publicLeg(leg) {
  const strip = (p) => p && { cx: p.cx, cy: p.cy, amount: p.amount.toString(), leafIndex: p.leafIndex, path: p.path, sig: p.sig };
  return { owner: leg.owner, in: strip(leg.in), recv: strip(leg.recv), change: leg.change ? strip(leg.change) : null };
}
// Re-hydrate a pasted public leg's amounts to BigInt for verifyOtc / ctx.
function hydrateLeg(leg) {
  const h = (p) => p && { ...p, amount: BigInt(p.amount) };
  return { owner: leg.owner, in: h(leg.in), recv: h(leg.recv), change: leg.change ? h(leg.change) : null };
}
const OTC_DRAFT_KEY = 'tacit-otc-maker-draft-v1';

// The maker draft below carries the raw blinding `_r` of the input/recv/change legs — under this
// protocol's bearer-note model that IS spend authority over the maker's traded note, so it must not sit
// in localStorage as cleartext (any same-origin script bug elsewhere, or a browser extension with a
// storage-read permission, could read it and later spend the note). It still has to survive a reload —
// the maker may close the tab while waiting on the taker's countersignature — so it's encrypted at rest
// with a key derived from the wallet's own private key (never itself written to storage), which raises
// the bar from "any localStorage reader" to "present with this wallet unlocked."
const _concatBytes = (a, b) => { const o = new Uint8Array(a.length + b.length); o.set(a, 0); o.set(b, a.length); return o; };
async function _otcDraftKey(walletPriv) {
  const km = sha256(_concatBytes(new TextEncoder().encode('tacit-otc-draft-v1'), walletPriv));
  return crypto.subtle.importKey('raw', km, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
async function saveOtcDraft(walletPriv, draft) {
  const key = await _otcDraftKey(walletPriv);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const pt = new TextEncoder().encode(JSON.stringify(draft, (k, v) => typeof v === 'bigint' ? v.toString() : v));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, pt));
  localStorage.setItem(OTC_DRAFT_KEY, JSON.stringify({ iv: Array.from(iv), ct: Array.from(ct) }));
}
async function loadOtcDraft(walletPriv) {
  let parsed;
  try { parsed = JSON.parse(localStorage.getItem(OTC_DRAFT_KEY) || 'null'); } catch { return null; }
  if (!parsed || !parsed.iv || !parsed.ct) return null;
  try {
    const key = await _otcDraftKey(walletPriv);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: Uint8Array.from(parsed.iv) }, key, Uint8Array.from(parsed.ct));
    return JSON.parse(new TextDecoder().decode(pt));
  } catch { return null; } // wrong wallet unlocked, or corrupted — treat as no draft
}

let _ux = null;
function getUx() {
  return _ux || (_ux = makeConfidentialPoolUx({ secp, keccak256: keccak_256, sha256}));
}
const el = (id) => document.getElementById(id);

function wireSubmit(wallet, ux) {
  const btn = el('otc-submit-btn');
  if (!btn) return;
  const statusEl = el('otc-submit-status');
  btn.onclick = async () => {
    if (!wallet || !wallet.priv) { if (statusEl) statusEl.textContent = 'Unlock your wallet first.'; return; }
    const raw = (el('otc-offer-input') && el('otc-offer-input').value || '').trim();
    if (!raw) { if (statusEl) statusEl.textContent = 'Paste an assembled OTC offer.'; return; }
    let otc;
    try { otc = JSON.parse(raw); }
    catch { if (statusEl) statusEl.textContent = 'Offer is not valid JSON.'; return; }
    const otcLib = makeConfidentialOtc({ keccak256: keccak_256, pool: ux.pool });
    let result;
    try {
      result = otcLib.verifyOtc(otc, { merkleRootFrom: ux.pool.merkleRootFrom });
    } catch (e) {
      if (statusEl) statusEl.textContent = 'Offer rejected: ' + (e && e.message || e);
      return;
    }
    // The relay's box proves this op with contracts/sp1/confidential/harnesses/exec-otc, which reads a
    // FLAT per-leg wire shape (inCx/inLeafIndex/.../nk/.../recvSigZ) — not the nested {in,recv,change}
    // shape verifyOtc/buildOtc use internally. toWireOp also fails loudly here if either leg's nk is
    // missing, instead of letting an incomplete witness reach the box (which the guest would reject
    // SILENTLY — EXECUTE_OK with pv_bytes = 0 — since input_leaf_authed's nk_to_owner assert just fails).
    let wireOp;
    try {
      wireOp = otcLib.toWireOp(otc);
    } catch (e) {
      if (statusEl) statusEl.textContent = 'Offer incomplete: ' + (e && e.message || e);
      return;
    }
    // Settling is NOT wired, and is refused here rather than attempted.
    //
    // This call used to pass `outputs: []` with four real leaves, so the relay's recovery guard threw on
    // every attempt — the button could never succeed. Worse was what sat next to it: `ephRand: () => 1n`, a
    // CONSTANT ephemeral scalar. Anyone "fixing" the first problem by supplying real output descriptors
    // would have armed the second, and an ephemeral of 1 makes the ECDH shared secret equal to the
    // recipient's own public key — every OTC memo on chain would be decryptable by any observer. Removing
    // the constant is the point of this change: a dead path that fails closed is fine, a dead path carrying
    // a loaded footgun for the next person to touch it is not.
    //
    // To finish this: build one recovery descriptor per leaf (as confidential-pool-ux's own op builders do),
    // pass `ephRand: freshEph` — the CSPRNG scalar source, never a fixed value — and move `waitOpts` to
    // settle()'s SECOND argument, where it is actually read.
    if (statusEl) {
      statusEl.textContent = 'OTC settle is not wired up in this build — the offer above is valid and verified, '
        + 'but settling it needs per-leaf recovery descriptors that this tab does not build yet.';
    }
    notify('OTC settle is not available in this build', 'error');
  };
}

// 3-step trustless composer: maker builds its leg (commitments only shared), taker countersigns its own leg
// against the shared context, maker finalizes by signing its leg + assembling. No blinding ever leaves the
// owner's browser; the assembled offer drops into the Verify+settle box below.
function wireComposer(wallet, ux, notes) {
  const otc = makeConfidentialOtc({ keccak256: keccak_256, pool: ux.pool });
  const byLeaf = new Map((notes || []).map((n) => [String(n.leafIndex), n]));
  const noteOpt = (n) => `<option value="${n.leafIndex}">${n.value} ${ux.tickerOf(n.asset) || n.asset.slice(0, 8)} #${n.leafIndex}</option>`;
  ['otc-mk-note', 'otc-tk-note'].forEach((sel) => {
    const e = document.getElementById(sel);
    if (e) e.innerHTML = (notes || []).map(noteOpt).join('');
  });

  const mkBtn = document.getElementById('otc-mk-btn');
  if (mkBtn) mkBtn.onclick = async () => {
    const st = document.getElementById('otc-compose-status');
    try {
      const n = byLeaf.get((document.getElementById('otc-mk-note') || {}).value);
      const vA = BigInt((document.getElementById('otc-mk-give') || {}).value || '0');
      const assetB = ((document.getElementById('otc-mk-wantasset') || {}).value || '').trim();
      const vB = BigInt((document.getElementById('otc-mk-wantamt') || {}).value || '0');
      if (!n || vA <= 0n || vB <= 0n || !/^0x[0-9a-fA-F]{64}$/.test(assetB)) { if (st) st.textContent = 'Fill in the give note + amount and the want asset + amount.'; return; }
      if (n.asset.toLowerCase() === assetB.toLowerCase()) { if (st) st.textContent = 'Pick a different want asset than the one you give.'; return; }
      if (vA > BigInt(n.value)) { if (st) st.textContent = 'Give amount exceeds the selected note.'; return; }
      const recvR = randomScalar();
      const inVal = BigInt(n.value);
      const changeR = inVal > vA ? randomScalar() : null;
      // `owner`/`nk` are the SELECTED NOTE's own (H(nk) owner + its secret nullifier key), not the
      // wallet's default identity — the guest rebuilds membership from the note's real owner and
      // requires this exact nk to authorize the spend (input_leaf_authed's native branch).
      const leg = otc.buildLeg({ owner: n.owner, nk: n.secret, inAmount: inVal, inR: BigInt(n.blinding), inLeafIndex: n.leafIndex, inPath: n.path, give: vA, recvValue: vB, recvR, changeR });
      const draft = { assetA: n.asset, assetB, vA: vA.toString(), vB: vB.toString(), chainBinding: ux.chainBindingHex(), spendRoot: n.root, deadline: 0, makerLeg: { ...leg, in: { ...leg.in, _r: leg.in._r.toString() }, recv: { ...leg.recv, _r: leg.recv._r.toString() }, change: leg.change ? { ...leg.change, _r: leg.change._r.toString() } : null } };
      await saveOtcDraft(wallet.priv, draft);
      const offer = { assetA: n.asset, assetB, vA: vA.toString(), vB: vB.toString(), chainBinding: draft.chainBinding, spendRoot: n.root, deadline: 0, maker: publicLeg(leg) };
      const out = document.getElementById('otc-mk-out');
      if (out) out.value = JSON.stringify(offer, (k, v) => typeof v === 'bigint' ? v.toString() : v);
      const cp = document.getElementById('otc-mk-copy'); if (cp) cp.disabled = false;
      if (st) st.textContent = 'Offer created — send it to your taker (step 2).';
    } catch (e) { if (st) st.textContent = formatErr(e, 'Create'); }
  };

  const tkBtn = document.getElementById('otc-tk-btn');
  if (tkBtn) tkBtn.onclick = () => {
    const st = document.getElementById('otc-compose-status');
    try {
      const offer = JSON.parse((document.getElementById('otc-tk-in') || {}).value || '{}');
      const n = byLeaf.get((document.getElementById('otc-tk-note') || {}).value);
      if (!n) { if (st) st.textContent = 'Pick the note you give as the taker.'; return; }
      const vA = BigInt(offer.vA), vB = BigInt(offer.vB);
      const inVal = BigInt(n.value);
      const recvR = randomScalar();
      const changeR = inVal > vB ? randomScalar() : null;
      // Same as the maker leg: bind to the SELECTED note's own owner + nk, not the wallet's default
      // identity — otherwise membership (and later, the guest's native-spend nk check) never matches.
      const taker = otc.buildLeg({ owner: n.owner, nk: n.secret, inAmount: inVal, inR: BigInt(n.blinding), inLeafIndex: n.leafIndex, inPath: n.path, give: vB, recvValue: vA, recvR, changeR });
      const maker = hydrateLeg(offer.maker);
      const ctx = otc.composeCtx({ assetA: offer.assetA, assetB: offer.assetB, chainBinding: offer.chainBinding, vA, vB, maker, taker, deadline: offer.deadline || 0 });
      otc.signLegs(taker, ctx, 'taker');
      const countersign = { ...offer, taker: publicLeg(taker) };
      const out = document.getElementById('otc-tk-out');
      if (out) out.value = JSON.stringify(countersign, (k, v) => typeof v === 'bigint' ? v.toString() : v);
      const cp = document.getElementById('otc-tk-copy'); if (cp) cp.disabled = false;
      if (st) st.textContent = 'Countersigned — send this back to the maker (step 3).';
    } catch (e) { if (st) st.textContent = formatErr(e, 'Countersign'); }
  };

  const fnBtn = document.getElementById('otc-fn-btn');
  if (fnBtn) fnBtn.onclick = async () => {
    const st = document.getElementById('otc-compose-status');
    try {
      const cs = JSON.parse((document.getElementById('otc-fn-in') || {}).value || '{}');
      const draft = (await loadOtcDraft(wallet.priv)) || {};
      if (!draft.makerLeg) { if (st) st.textContent = 'No local maker draft — create the offer in step 1 first.'; return; }
      const reBig = (p) => p && { ...p, amount: BigInt(p.amount), _r: BigInt(p._r) };
      const maker = { owner: draft.makerLeg.owner, nk: draft.makerLeg.nk, in: reBig(draft.makerLeg.in), recv: reBig(draft.makerLeg.recv), change: draft.makerLeg.change ? reBig(draft.makerLeg.change) : null };
      // `cs.taker` is the taker's PUBLIC countersignature (publicLeg strips nk on the way out, same as it
      // strips the input blinding) — it never carries the taker's nk, so `assembled` below cannot reach
      // the relay on its own. verifyOtc's nk_to_owner check rejects it with a clear error rather than let
      // a witness missing the taker's nk reach the box (which the guest would fail on SILENTLY —
      // EXECUTE_OK with pv_bytes = 0). A trustless 3-party handoff would need the relay to collect each
      // side's nk directly from its own party — never routed through the counterparty, which would hand
      // the maker outright spend authority over the taker's note — and this tab has no such co-submission
      // channel. So this finalize step is only for the case where maker and taker are the same trusted
      // operator (e.g. a matcher wallet holding both legs), which supplies the taker's nk out of band.
      const taker = hydrateLeg(cs.taker);
      if (cs.takerNk) taker.nk = cs.takerNk; // optional out-of-band field, not part of the public countersignature
      const vA = BigInt(cs.vA), vB = BigInt(cs.vB);
      const ctx = otc.composeCtx({ assetA: cs.assetA, assetB: cs.assetB, chainBinding: cs.chainBinding, vA, vB, maker, taker, deadline: cs.deadline || 0 });
      otc.signLegs(maker, ctx, 'maker');
      const assembled = otc.assembleOtc({ assetA: cs.assetA, assetB: cs.assetB, vA, vB, chainBinding: cs.chainBinding, spendRoot: cs.spendRoot, maker, taker, deadline: cs.deadline || 0 });
      // Local proof it's well-formed + guest-exact before anyone settles.
      otc.verifyOtc(assembled, { merkleRootFrom: ux.pool.merkleRootFrom });
      const box = document.getElementById('otc-offer-input');
      if (box) box.value = JSON.stringify(assembled, (k, v) => typeof v === 'bigint' ? v.toString() : v);
      localStorage.removeItem(OTC_DRAFT_KEY);
      if (st) st.textContent = 'Verified offer assembled below — review and Verify + settle.';
    } catch (e) { if (st) st.textContent = formatErr(e, 'Finalize'); }
  };

  // Copy affordances for the two handoff blobs the counterparties exchange.
  const mkCopy = document.getElementById('otc-mk-copy');
  if (mkCopy) mkCopy.onclick = () => copyToClipboard((document.getElementById('otc-mk-out') || {}).value || '', mkCopy);
  const tkCopy = document.getElementById('otc-tk-copy');
  if (tkCopy) tkCopy.onclick = () => copyToClipboard((document.getElementById('otc-tk-out') || {}).value || '', tkCopy);
}

export async function renderOtcTab(wallet) {
  const body = el('otc-body');
  if (!body) return;
  if (!confidentialPoolReady()) { body.innerHTML = confidentialUnavailableHTML('Confidential OTC'); return; }
  const ux = getUx();
  if (!wallet || !wallet.priv) {
    body.innerHTML = '<div class="muted">Unlock a wallet to settle a private over-the-counter swap.</div>';
    return;
  }
  const acct = ux.account(wallet.priv);
  const taFont = 'font-size:10px;font-family:var(--mono);';
  const assetOptions = (ux.assets || []).map((a) => `<option value="${a.assetId}">${a.ticker}</option>`).join('');
  body.innerHTML = `
    <div class="tab-form">
    <div class="note-concept"><b>Trade note-for-note, privately.</b> A confidential OTC
      swaps two shielded notes between a specific pair of counterparties atomically — no order book, no price curve,
      fixed agreed terms. Same From→To shape as a Swap, but the price is what you both agree, not a pool.
      Instant and note-to-note: you end up holding a <b>shielded note</b>, cleared on the <span class="eth-word">Ethereum</span>
      lane. For <span class="btc-word">real sats</span>, use the <a href="#tab=market">order book</a>.</div>
    <div>Account: <code class="addr" style="font-size:11px;">${acct.address}</code></div>
    <div id="otc-notes" class="muted">Scanning your notes…</div>

    <details class="divider">
      <summary>Compose a trustless offer <span class="muted" style="font-weight:400;">· 3-step handshake, no blinding ever shared</span></summary>
      <div class="details-body" style="font-size:12px;">
        <div style="font-weight:600;margin-bottom:4px;">1 · Maker — create</div>
        <div class="muted" style="font-size:11px;margin-bottom:6px;">From a note you give → the asset + amount you want back. Share the offer with your taker.</div>
        <label class="field-label" for="otc-mk-note">From (give)</label>
        <div class="field-row" style="margin-bottom:6px;">
          <select id="otc-mk-note" style="flex:1 1 160px;"></select>
          <input id="otc-mk-give" type="number" min="0" placeholder="amount" style="flex:0 0 90px;width:90px;">
        </div>
        <label class="field-label" for="otc-mk-wantasset">To (want)</label>
        <div class="field-row" style="margin-bottom:6px;">
          <select id="otc-mk-wantasset" style="flex:1 1 160px;">${assetOptions}</select>
          <input id="otc-mk-wantamt" type="number" min="0" placeholder="amount" style="flex:0 0 90px;width:90px;">
          <button id="otc-mk-btn">Create</button>
        </div>
        <textarea id="otc-mk-out" rows="3" readonly placeholder="offer to send the taker" style="${taFont}"></textarea>
        <button id="otc-mk-copy" type="button" style="margin-top:4px;font-size:11px;" disabled>Copy offer</button>

        <div style="font-weight:600;margin:10px 0 4px;">2 · Taker — countersign</div>
        <textarea id="otc-tk-in" rows="2" placeholder="paste the maker's offer" style="${taFont}margin-bottom:6px;"></textarea>
        <div class="field-row" style="margin-bottom:6px;">
          <select id="otc-tk-note"></select>
          <button id="otc-tk-btn">Countersign</button>
        </div>
        <textarea id="otc-tk-out" rows="3" readonly placeholder="countersignature to send back to the maker" style="${taFont}"></textarea>
        <button id="otc-tk-copy" type="button" style="margin-top:4px;font-size:11px;" disabled>Copy countersignature</button>

        <div style="font-weight:600;margin:10px 0 4px;">3 · Maker — finalize</div>
        <textarea id="otc-fn-in" rows="2" placeholder="paste the taker's countersignature" style="${taFont}margin-bottom:6px;"></textarea>
        <button id="otc-fn-btn">Finalize → verified offer</button>
        <div id="otc-compose-status" class="muted field-status" style="margin-top:4px;"></div>
      </div>
    </details>

    <div class="divider">
      <div style="font-weight:600;margin-bottom:6px;">Settle an assembled offer</div>
      <div class="muted" style="font-size:11px;margin-bottom:6px;">Paste a fully-assembled OTC offer (commitments + opening sigmas) from your counterparty or matcher. It is verified against the live pool before settling.</div>
      <textarea id="otc-offer-input" rows="5" placeholder='{"assetA":"0x…","assetB":"0x…","vA":"…","vB":"…","maker":{…},"taker":{…},"spendRoot":"0x…",…}' style="font-size:11px;font-family:var(--mono);"></textarea>
      <button id="otc-submit-btn" class="primary" style="margin-top:8px;">Verify + settle</button>
      <div id="otc-submit-status" class="muted field-status" style="margin-top:6px;"></div>
    </div>
    </div>`;

  wireSubmit(wallet, ux);

  if (el('otc-notes')) el('otc-notes').textContent = 'Scanning the pool…';
  try {
    const { notes, diag } = await ux.balance(wallet.priv);
    const box = el('otc-notes');
    if (!box) return;
    const banner = scanHealthHtml(diag, { style: 'margin:6px 0;' });
    if (!notes || !notes.length) {
      box.innerHTML = banner + (scanHealth(diag).ok
        ? 'No shielded notes yet — wrap into the pool to have something to trade.'
        : 'No tradeable notes found in the channels this scan could finish.');
    } else {
      box.innerHTML = banner + '<div style="font-weight:600;margin-bottom:4px;color:var(--ink);">Your tradeable notes</div>'
        + notes.map((n) => {
          const ticker = ux.tickerOf(n.asset) || 'note';
          return `<div style="padding:3px 0;">${n.value} ${esc(ticker)} <span class="muted">#${n.leafIndex}</span>${inboundBadgeHtml(n)}</div>`;
        }).join('') + inboundSummaryHtml(notes);
    }
    wireComposer(wallet, ux, notes || []);
  } catch (e) {
    const box = el('otc-notes');
    if (box) box.textContent = 'Could not scan the pool: ' + formatErr(e);
  }
}
