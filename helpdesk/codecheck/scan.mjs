// Scan one source file with a small model: windows of ~110 lines, findings as exact-text replacement patches.
export const SYSTEM = `You are a careful reviewer of browser JavaScript for a crypto dapp. Look for REAL bugs in the code window: wrong variable, off-by-one, missing await, wrong comparison, unhandled edge case (empty, zero, null), wrong units, swapped arguments. Ignore style, naming and missing comments.
Reply with JSON only, no prose: {"findings":[{"line":<line number>,"why":"<one sentence>","old":"<exact text copied from the code, 1 to 4 lines>","new":"<the corrected text>"}]}
At most 3 findings. If you see no real bug reply {"findings":[]}. "old" must be copied exactly so it can be found by string search.`;

export function windows(src, size = 110, overlap = 15) {
  const lines = src.split('\n'); const out = [];
  for (let s = 0; s < lines.length; s += size - overlap) {
    let e = Math.min(lines.length, s + size);
    for (let k = e; k > s + size - 30 && k < lines.length; k--) if (lines[k - 1].trim() === '') { e = k; break; }   // prefer to end on a blank line
    out.push({ start: s + 1, end: e, text: lines.slice(s, e).map((l, i) => `${s + i + 1}: ${l}`).join('\n') });
    if (e >= lines.length) break;
  }
  return out;
}
export async function scanWindow(base, win, file, { timeoutMs = 60000 } = {}) {
  const body = { model: 'local', temperature: 0, max_tokens: 500, chat_template_kwargs: { enable_thinking: false }, messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: `File: ${file}\nLines ${win.start}-${win.end}\n\n${win.text}` }] };
  const r = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  return parseFindings((await r.json()).choices?.[0]?.message?.content ?? '');
}
// the model's reply -> up to 3 usable findings (anything that is not the JSON shape asked for is dropped)
// Control and direction-changing characters (all but tab and newline) are taken out of a finding's text after it is decoded: a reply may spell an escape
// as \u001b, and the reviewer's terminal would act on it.
export const plain = (v) => String(v ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '');
export function parseFindings(txt) {
  const m = String(txt).match(/\{[\s\S]*\}/); if (!m) return [];
  try {
    return (JSON.parse(m[0]).findings || []).filter((f) => f && typeof f.old === 'string' && typeof f.new === 'string' && f.old.trim() && f.old !== f.new).slice(0, 3)
      .map((f) => ({ line: Number.isInteger(f.line) ? f.line : null, why: plain(f.why).slice(0, 300), old: plain(f.old).replace(/^\d+:\s?/gm, ''), new: plain(f.new) }));
  } catch { return []; }
}
// apply one finding to a source string: the old text must occur exactly once
export function applyPatch(src, f) { const i = src.indexOf(f.old); if (i < 0 || src.indexOf(f.old, i + 1) >= 0) return null; return src.slice(0, i) + f.new + src.slice(i + f.old.length); }
