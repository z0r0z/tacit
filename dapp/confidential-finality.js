// Cross-chain finality indicator for confidential-pool actions.
//
// A confidential action settled on Ethereum is FAST-FINAL in ~seconds: the SP1 settle lands, the
// nullifier set serializes the spend, and the note / withdrawal is usable. But a Bitcoin-arbitrated
// (cross-chain / Bitcoin-homed) action is only HARD-FINAL once it is anchored back onto Bitcoin — the
// reflection prover folds the consumed nullifier into the reflected bitcoinSpentRoot. Until then a deep
// Bitcoin reorg (beyond the reflection finality window) could reverse it: the same bridge-wide
// accept-and-document assumption the tETH bridge / AMM already carry, surfaced here instead of hidden.
//
// Window derivation (the conservative ESTIMATE used when no authoritative `anchored` signal is given):
//   Ethereum finality (~13 min, finalized beacon slot)
// + Bitcoin burial REFLECTION_CONFIRMATIONS = 6 (~60 min)
// + one reflection prove/attest cycle (~5-20 min)
// The authoritative signal is `anchored` (the consume present in the reflected spent set); pass it when
// known and it overrides the time estimate. Elapsed time alone NEVER claims hard-final — it only stops
// counting down and shows "awaiting Bitcoin anchor". Pure + dependency-free so the dapp bundle and the
// Node tests run identical logic.

export const FINALITY = {
  anchorWindowMs: 90 * 60 * 1000, // conservative ETH-settle → Bitcoin-anchored window
};

// Human ETA from a millisecond remainder. Coarse on purpose (a finality estimate, not a clock).
export function formatEta(ms) {
  if (!(ms > 0)) return 'any moment';
  const mins = Math.ceil(ms / 60000);
  if (mins <= 1) return '~1 min';
  if (mins < 90) return `~${mins} min`;
  const hrs = Math.round((mins / 60) * 10) / 10;
  return `~${hrs} hr`;
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// Classify the finality of a single Bitcoin-arbitrated action.
//   settledAtMs     : when the Ethereum settle landed (ms epoch). Falsy → not settled yet.
//   nowMs           : current time (ms epoch).
//   anchored        : true once Bitcoin-anchored (reflection folded the consume); null/undefined if unknown.
//   anchorWindowMs  : override the conservative window.
// Returns { stage, anchored, tone, label, detail, etaMs, etaText }.
//   stage : 'unsettled' | 'fast-final' | 'hard-final'
//   tone  : 'pending' | 'final'
export function classifyFinality({ settledAtMs, nowMs, anchored = null, anchorWindowMs = FINALITY.anchorWindowMs } = {}) {
  if (!settledAtMs) {
    return { stage: 'unsettled', anchored: false, tone: 'pending', label: 'Settling…',
      detail: 'Awaiting the Ethereum settle.', etaMs: 0, etaText: '' };
  }
  if (anchored === true) {
    return { stage: 'hard-final', anchored: true, tone: 'final', label: 'Bitcoin-final',
      detail: 'Anchored on Bitcoin — irreversible.', etaMs: 0, etaText: '' };
  }
  const etaMs = Math.max(0, settledAtMs + anchorWindowMs - (nowMs || 0));
  const detail = etaMs > 0
    ? `Fast-final on Ethereum. Settling to Bitcoin — ${formatEta(etaMs)} to anchor; reversible by a deep Bitcoin reorg until then.`
    : 'Fast-final on Ethereum. Awaiting Bitcoin anchor confirmation.';
  return { stage: 'fast-final', anchored: false, tone: 'pending', label: 'Fast-final (Ethereum)',
    detail, etaMs, etaText: etaMs > 0 ? formatEta(etaMs) : 'awaiting anchor' };
}

// Small inline badge for a finality status (design-token colours; degrade with literal fallbacks).
export function finalityBadgeHtml(status) {
  const final = status.tone === 'final';
  const color = final ? 'var(--green-positive,#1A7548)' : 'var(--amber,#b8651d)';
  const dot = final ? '●' : '◷';
  return `<span class="cpool-finality-badge" title="${escapeHtml(status.detail)}" `
    + `style="display:inline-flex;align-items:center;gap:4px;font-size:11px;font-weight:700;color:${color};">`
    + `${dot} ${escapeHtml(status.label)}${status.etaText ? ` · ${escapeHtml(status.etaText)}` : ''}</span>`;
}

// ── Optional session store ───────────────────────────────────────────────────
// Lets any cross-chain flow (crossOut / bridge / a future fast-lane UI) register a provisional action so
// the pool tab can show its live anchoring countdown. In-memory, per page load — the underlying value is
// recovered from chain regardless, this only drives the indicator.
const _provisional = new Map(); // id → { id, label, settledAtMs, anchored, anchorWindowMs }

export function trackProvisional(action) {
  if (!action || !action.id) return;
  _provisional.set(action.id, { anchored: false, ...action });
}
export function markAnchored(id) { const a = _provisional.get(id); if (a) a.anchored = true; }
export function clearProvisional(id) { _provisional.delete(id); }
export function listProvisional() { return Array.from(_provisional.values()); }
export function hasPendingProvisional(nowMs) {
  for (const a of _provisional.values()) {
    if (classifyFinality({ settledAtMs: a.settledAtMs, nowMs, anchored: a.anchored, anchorWindowMs: a.anchorWindowMs }).tone === 'pending') return true;
  }
  return false;
}
