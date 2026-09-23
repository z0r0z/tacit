// What a scan could not see, in the words the tabs show.
//
// ux.balance() / ux.recover() / ux.scanStealthLocks() already report the channels that failed, the walks
// that skipped a transaction and the notes known only from an unauthenticated memo. Nothing rendered any of
// it, so a scan that lost an endpoint looked exactly like an empty wallet. These are the pure string/HTML
// helpers every tab uses to say otherwise; no DOM, no network, so they are tested directly
// (tests/confidential-scan-health.mjs).
//
// The case that matters: cBTC and bridge-mint notes have NO memo channel. Key + chain re-derivation is the
// only way to find them, so one dead esplora or RPC renders a real holding as zero with nothing on screen.
// Every figure drawn from a scan whose `diag.errors` is non-empty is therefore labelled as possibly partial,
// naming the channel — calmly, and without ever implying the value itself is at risk. Nothing here changes
// what is spendable: it only changes what is said about it.

// esc() from confidential-deployments.js, inlined so this module stays importable on its own (the tabs pass
// nothing in, and the tests import it without the vendor bundle).
export function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// One phrase per scan channel, as a user would name it. Keys match `diag.errors` / recover()'s `d.errors`.
const CHANNEL_LABEL = {
  wrap: 'the deposit scan',
  cbtc: 'the cBTC scan',
  bridge: 'the Bitcoin-bridge scan',
  change: 'the change-note scan',
  derived: 'the settle-output scan',
  derivedOutputs: 'the settle-output scan',
  locks: 'the stealth-payment scan',
  cdp: 'the borrow-position scan',
  farm: 'the farm-position scan',
};

// The two channels with no memo to fall back on: a note of theirs is found from the wallet key and the
// chain or not at all, so an outage there understates a real balance rather than merely losing a label.
const KEY_ONLY = { cbtc: 'cBTC', bridge: 'bridged' };

export function channelLabel(key) {
  return CHANNEL_LABEL[key] || `the ${String(key || 'pool')} scan`;
}

function joinPhrases(list) {
  const a = list.filter(Boolean);
  if (!a.length) return '';
  if (a.length === 1) return a[0];
  if (a.length === 2) return `${a[0]} and ${a[1]}`;
  return `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`;
}

// Read the `diag` a balance() carries. Returns { ok, channels, keyOnly, truncated, pendingWraps,
// inboundUnverified, text }. `ok` true means every channel completed — the only case where a figure drawn
// from this scan is authoritative. `text` is '' when ok.
export function scanHealth(diag) {
  const d = diag || {};
  const channels = Object.keys(d.errors || {});
  const truncated = (d.wrap && d.wrap.truncated) || [];
  const pendingWraps = ((d.wrap && d.wrap.pending) || []).length;
  const inboundUnverified = Number(d.inboundUnverified || 0);
  const keyOnly = channels.filter((c) => KEY_ONLY[c]);
  const out = { ok: channels.length === 0 && !truncated.length, channels, keyOnly, truncated, pendingWraps, inboundUnverified, text: '' };
  if (out.ok) return out;

  const parts = [];
  if (channels.length) parts.push(`${joinPhrases(channels.map(channelLabel))} did not finish`);
  if (truncated.length) parts.push('the deposit scan stopped at its index limit');
  let text = `Balances may be incomplete — ${joinPhrases(parts)}.`;
  if (keyOnly.length) {
    const kinds = joinPhrases(keyOnly.map((c) => KEY_ONLY[c]));
    text += ` ${kinds} notes are found from your key and the chain alone, so any you hold can be missing from the figure until that scan succeeds.`;
  }
  text += ' Scanning again is safe and costs nothing.';
  out.text = text;
  return out;
}

// The same, as the banner the tabs put above a balance or note list. '' when the scan was clean.
export function scanHealthHtml(diag, { style = 'margin:8px 0;' } = {}) {
  const h = scanHealth(diag);
  if (h.ok) return '';
  return `<div class="warn" style="${escapeHtml(style)}">${escapeHtml(h.text)}</div>`;
}

// A one-line version for a status element that already holds a count ("3 shielded notes recovered").
export function scanHealthSuffix(diag) {
  const h = scanHealth(diag);
  return h.ok ? '' : ' — ' + h.text;
}

// Deposits the pool has recorded but no note has settled from yet. Not a failure; it is the other reason a
// balance can read low, and the tabs that show the health banner show this beside it.
export function pendingWrapsText(diag) {
  const n = ((diag && diag.wrap && diag.wrap.pending) || []).length;
  if (!n) return '';
  return `${n} deposit${n === 1 ? '' : 's'} ${n === 1 ? 'is' : 'are'} on-chain but ${n === 1 ? 'has' : 'have'} not settled into a note yet.`;
}

// ── inbound (memo-only) notes ────────────────────────────────────────────────────────────────────
// A memo is authenticated by the leaf it opens and nothing else: whoever knows this wallet's scan key can
// seal one over a note they built and keep its nullifier key. Such a note is spendable and is NOT filtered
// out anywhere — it is only labelled, so a balance made of them is not read as the wallet's own work.

export const INBOUND_LABEL = 'inbound';
export const INBOUND_TITLE = 'Known only from a memo sealed to your scan key — spendable as normal, but not re-derived from your key alone, so who created it is unverified.';

export function noteIsInbound(note) {
  return !!(note && note.inboundUnverified);
}

// The tag that goes next to a note in a list. '' for a key-derived note.
export function inboundBadgeHtml(note) {
  if (!noteIsInbound(note)) return '';
  return ` <span class="muted" title="${escapeHtml(INBOUND_TITLE)}">· ${escapeHtml(INBOUND_LABEL)}</span>`;
}

// Plain-text form, for an <option> or a title where markup is not allowed.
export function inboundBadgeText(note) {
  return noteIsInbound(note) ? ` · ${INBOUND_LABEL}` : '';
}

// The line under a note list when some of it is inbound. Takes the note array or the count.
export function inboundSummaryText(notesOrCount) {
  const n = Array.isArray(notesOrCount) ? notesOrCount.filter(noteIsInbound).length : Number(notesOrCount || 0);
  if (!n) return '';
  return `${n} note${n === 1 ? '' : 's'} marked “${INBOUND_LABEL}” ${n === 1 ? 'was' : 'were'} found from a memo addressed to you rather than from your own key. ${n === 1 ? 'It is' : 'They are'} spendable; who created ${n === 1 ? 'it' : 'them'} is unverified.`;
}

export function inboundSummaryHtml(notesOrCount) {
  const t = inboundSummaryText(notesOrCount);
  return t ? `<div class="muted" style="margin-top:4px;">${escapeHtml(t)}</div>` : '';
}

// ── recovery coverage ────────────────────────────────────────────────────────────────────────────
// recover()'s diagnostics.coverage.complete is false whenever a channel errored OR a walk skipped a
// transaction it could not read. A partial restore presented as a finished one is the worst answer to give
// someone rebuilding from a seed, so this names what went unread.

const SKIPPED_LABEL = {
  change: 'change notes',
  derived: 'settle outputs',
  cdp: 'borrow positions',
};

export function recoveryCoverage(diagnostics) {
  const d = diagnostics || {};
  const cov = d.coverage || {};
  const complete = cov.complete === true;
  const channels = Object.keys(d.errors || {});
  const skipped = cov.skipped || {};
  const skippedParts = Object.keys(SKIPPED_LABEL)
    .map((k) => ({ k, n: (skipped[k] || []).length }))
    .filter((x) => x.n > 0)
    .map((x) => `${x.n} settle transaction${x.n === 1 ? '' : 's'} behind your ${SKIPPED_LABEL[x.k]} could not be read`);
  const out = { complete, channels, skipped: skippedParts, text: '' };
  if (complete) {
    out.text = 'Restore complete — every channel this wallet uses was scanned.';
    return out;
  }
  const parts = [];
  if (channels.length) parts.push(`${joinPhrases(channels.map(channelLabel))} did not finish`);
  parts.push(...skippedParts);
  out.text = `Restore incomplete — ${joinPhrases(parts) || 'part of the scan did not finish'}.`
    + ' Anything it missed is still recoverable from your wallet key: run the restore again rather than treating this as the whole wallet.';
  return out;
}

export function recoveryCoverageHtml(diagnostics, { style = 'margin:8px 0;' } = {}) {
  const c = recoveryCoverage(diagnostics);
  const cls = c.complete ? 'info-card' : 'warn';
  return `<div class="${cls}" style="${escapeHtml(style)}">${escapeHtml(c.text)}</div>`;
}

// ── stealth locks ────────────────────────────────────────────────────────────────────────────────
// scanLockLeaves distinguishes "the pool confirmed this set" (verified === true) from "the pool's lock
// state could not be read, so nothing was checked" (null) — and a lock whose memo was unavailable was never
// trial-decrypted at all, so an empty result is not the same as "nothing is waiting for you".

export function lockScanHealth(scanned) {
  const s = scanned || {};
  const verified = s.verified === true;
  const withoutMemo = Number(s.locksWithoutMemo || 0);
  const out = { ok: verified && !withoutMemo, verified, locksWithoutMemo: withoutMemo, text: '' };
  if (out.ok) return out;
  const parts = [];
  if (!verified) {
    parts.push('the pool did not confirm the lock set this scan was built from'
      + (s.unverifiedReason ? ` (${String(s.unverifiedReason)})` : ''));
  }
  if (withoutMemo) parts.push(`${withoutMemo} lock${withoutMemo === 1 ? '' : 's'} could not be read, so a payment to you could be missing from this list`);
  out.text = `This list may be incomplete — ${joinPhrases(parts)}. Scanning again is safe and costs nothing.`;
  return out;
}

export function lockScanHealthHtml(scanned, { style = 'margin:8px 0;' } = {}) {
  const h = lockScanHealth(scanned);
  if (h.ok) return '';
  return `<div class="warn" style="${escapeHtml(style)}">${escapeHtml(h.text)}</div>`;
}
