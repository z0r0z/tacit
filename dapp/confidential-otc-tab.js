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
import { confidentialPoolReady, confidentialUnavailableHTML } from './confidential-deployments.js';
import { makeConfidentialOtc } from './confidential-otc.js';
import { randomScalar } from './bulletproofs-plus.js';

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
    btn.disabled = true;
    if (statusEl) statusEl.textContent = `Offer valid (${result.leaves.length} outputs) — settling via the relayer…`;
    try {
      const r = await ux.relay.settle({
        type: 'otc', op: otc, leaves: result.leaves, outputs: [], ephRand: () => 1n,
        waitOpts: { onUpdate: (st) => { if (statusEl) statusEl.textContent = `OTC ${st.status}…`; } },
      });
      if (statusEl) statusEl.innerHTML = 'OTC settled'
        + (r && r.txHash ? ` (<code class="addr">${r.txHash}</code>)` : '') + '.';
    } catch (e) {
      if (statusEl) statusEl.textContent = 'OTC settle failed: ' + (e && e.message || e);
      btn.disabled = false;
    }
  };
}

// 3-step trustless composer: maker builds its leg (commitments only shared), taker countersigns its own leg
// against the shared context, maker finalizes by signing its leg + assembling. No blinding ever leaves the
// owner's browser; the assembled offer drops into the Verify+settle box below.
function wireComposer(wallet, ux, notes) {
  const otc = makeConfidentialOtc({ keccak256: keccak_256, pool: ux.pool });
  const id = ux.identity(wallet.priv);
  const byLeaf = new Map((notes || []).map((n) => [String(n.leafIndex), n]));
  const noteOpt = (n) => `<option value="${n.leafIndex}">${n.value} ${ux.tickerOf(n.asset) || n.asset.slice(0, 8)} #${n.leafIndex}</option>`;
  ['otc-mk-note', 'otc-tk-note'].forEach((sel) => {
    const e = document.getElementById(sel);
    if (e) e.innerHTML = (notes || []).map(noteOpt).join('');
  });

  const mkBtn = document.getElementById('otc-mk-btn');
  if (mkBtn) mkBtn.onclick = () => {
    const st = document.getElementById('otc-compose-status');
    try {
      const n = byLeaf.get((document.getElementById('otc-mk-note') || {}).value);
      const vA = BigInt((document.getElementById('otc-mk-give') || {}).value || '0');
      const assetB = ((document.getElementById('otc-mk-wantasset') || {}).value || '').trim();
      const vB = BigInt((document.getElementById('otc-mk-wantamt') || {}).value || '0');
      if (!n || vA <= 0n || vB <= 0n || !/^0x[0-9a-fA-F]{64}$/.test(assetB)) { if (st) st.textContent = 'Fill in note, give, want asset id, and want amount.'; return; }
      const recvR = randomScalar();
      const inVal = BigInt(n.value);
      const changeR = inVal > vA ? randomScalar() : null;
      const leg = otc.buildLeg({ owner: id.owner, inAmount: inVal, inR: BigInt(n.blinding), inLeafIndex: n.leafIndex, inPath: n.path, give: vA, recvValue: vB, recvR, changeR });
      const draft = { assetA: n.asset, assetB, vA: vA.toString(), vB: vB.toString(), chainBinding: ux.chainBindingHex(), spendRoot: n.root, deadline: 0, makerLeg: { ...leg, in: { ...leg.in, _r: leg.in._r.toString() }, recv: { ...leg.recv, _r: leg.recv._r.toString() }, change: leg.change ? { ...leg.change, _r: leg.change._r.toString() } : null } };
      localStorage.setItem(OTC_DRAFT_KEY, JSON.stringify(draft, (k, v) => typeof v === 'bigint' ? v.toString() : v));
      const offer = { assetA: n.asset, assetB, vA: vA.toString(), vB: vB.toString(), chainBinding: draft.chainBinding, spendRoot: n.root, deadline: 0, maker: publicLeg(leg) };
      const out = document.getElementById('otc-mk-out');
      if (out) out.value = JSON.stringify(offer, (k, v) => typeof v === 'bigint' ? v.toString() : v);
      if (st) st.textContent = 'Offer created — send it to your taker (step 2).';
    } catch (e) { if (st) st.textContent = 'Create failed: ' + (e && e.message || e); }
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
      const taker = otc.buildLeg({ owner: id.owner, inAmount: inVal, inR: BigInt(n.blinding), inLeafIndex: n.leafIndex, inPath: n.path, give: vB, recvValue: vA, recvR, changeR });
      const maker = hydrateLeg(offer.maker);
      const ctx = otc.composeCtx({ assetA: offer.assetA, assetB: offer.assetB, chainBinding: offer.chainBinding, vA, vB, maker, taker, deadline: offer.deadline || 0 });
      otc.signLegs(taker, ctx, 'taker');
      const countersign = { ...offer, taker: publicLeg(taker) };
      const out = document.getElementById('otc-tk-out');
      if (out) out.value = JSON.stringify(countersign, (k, v) => typeof v === 'bigint' ? v.toString() : v);
      if (st) st.textContent = 'Countersigned — send this back to the maker (step 3).';
    } catch (e) { if (st) st.textContent = 'Countersign failed: ' + (e && e.message || e); }
  };

  const fnBtn = document.getElementById('otc-fn-btn');
  if (fnBtn) fnBtn.onclick = () => {
    const st = document.getElementById('otc-compose-status');
    try {
      const cs = JSON.parse((document.getElementById('otc-fn-in') || {}).value || '{}');
      const draft = JSON.parse(localStorage.getItem(OTC_DRAFT_KEY) || '{}');
      if (!draft.makerLeg) { if (st) st.textContent = 'No local maker draft — create the offer in step 1 first.'; return; }
      const reBig = (p) => p && { ...p, amount: BigInt(p.amount), _r: BigInt(p._r) };
      const maker = { owner: draft.makerLeg.owner, in: reBig(draft.makerLeg.in), recv: reBig(draft.makerLeg.recv), change: draft.makerLeg.change ? reBig(draft.makerLeg.change) : null };
      const taker = hydrateLeg(cs.taker);
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
    } catch (e) { if (st) st.textContent = 'Finalize failed: ' + (e && e.message || e); }
  };
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
  body.innerHTML = `
    <div class="tab-form">
    <div class="note-concept"><b>Trade note-for-note, privately.</b> A confidential OTC
      swaps two shielded notes between counterparties atomically — no order book, no price curve, fixed agreed terms.
      Same primitive across <span class="btc-word">Bitcoin</span> and <span class="eth-word">Ethereum</span> notes.</div>
    <div>Account: <code class="addr" style="font-size:11px;">${acct.address}</code></div>
    <div id="otc-notes" class="muted">Scanning your notes…</div>

    <details class="divider">
      <summary>Compose a trustless offer <span class="muted" style="font-weight:400;">· 3-step handshake, no blinding ever shared</span></summary>
      <div class="details-body" style="font-size:12px;">
        <div style="font-weight:600;margin-bottom:4px;">1 · Maker — create</div>
        <div class="muted" style="font-size:11px;margin-bottom:6px;">Pick a note to give, name what you want back, share the offer.</div>
        <div class="field-row" style="margin-bottom:6px;">
          <select id="otc-mk-note"></select>
          <input id="otc-mk-give" type="number" min="0" placeholder="give (vA)" style="flex:0 0 90px;width:90px;">
          <input id="otc-mk-wantasset" type="text" placeholder="want asset id 0x…" style="flex:1 1 140px;min-width:140px;">
          <input id="otc-mk-wantamt" type="number" min="0" placeholder="want (vB)" style="flex:0 0 90px;width:90px;">
          <button id="otc-mk-btn">Create</button>
        </div>
        <textarea id="otc-mk-out" rows="3" readonly placeholder="offer to send the taker" style="${taFont}"></textarea>

        <div style="font-weight:600;margin:10px 0 4px;">2 · Taker — countersign</div>
        <textarea id="otc-tk-in" rows="2" placeholder="paste the maker's offer" style="${taFont}margin-bottom:6px;"></textarea>
        <div class="field-row" style="margin-bottom:6px;">
          <select id="otc-tk-note"></select>
          <button id="otc-tk-btn">Countersign</button>
        </div>
        <textarea id="otc-tk-out" rows="3" readonly placeholder="countersignature to send back to the maker" style="${taFont}"></textarea>

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

  try {
    const { notes } = await ux.balance(wallet.priv);
    const box = el('otc-notes');
    if (!box) return;
    if (!notes || !notes.length) {
      box.textContent = 'No notes yet — wrap into the pool to have something to trade.';
    } else {
      box.innerHTML = '<div style="font-weight:600;margin-bottom:4px;color:var(--ink);">Your tradeable notes</div>'
        + notes.map((n) => {
          const ticker = ux.tickerOf(n.asset) || 'note';
          return `<div style="padding:3px 0;">${n.value} ${ticker} <span class="muted">#${n.leafIndex}</span></div>`;
        }).join('');
    }
    wireComposer(wallet, ux, notes || []);
  } catch (e) {
    const box = el('otc-notes');
    if (box) box.textContent = 'Could not scan the pool: ' + (e && e.message || e);
  }
}
