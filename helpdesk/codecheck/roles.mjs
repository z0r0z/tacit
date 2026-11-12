// The roles in the review. A role is a prompt and the shape of the answer, nothing more: any node that can run a chat model can hold any role, and the gateway
// decides who gets which. SCOUT looks for one kind of mistake (a lens) in a snippet and proposes a replacement. SKEPTIC is given a finding and tries to refute it.
// The gateway itself is the third role: it checks that a verdict quotes a line that is really in the code, weighs the votes by how each machine has done on planted
// bugs, and lets a finding through only when enough skeptics agree.
import { createHash } from 'node:crypto';
import { PRIMER, LENS } from './lenses.mjs';
import { plain } from './scan.mjs';

// a job's messages must fit what a node accepts (24 KB); a snippet with a very long line does not, and is left out
export const fits = (messages) => JSON.stringify(messages).length <= 20000;
export const findingId = (file, old, nu) => createHash('sha1').update([file, old, nu].join('\u0001')).digest('hex').slice(0, 10);
const oneLine = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

export function scoutSystem(lensId) {
  const lens = LENS[lensId]; if (!lens) throw new Error(`no lens ${lensId}`);
  return `You review ONE snippet of Tacit's browser JavaScript for ONE kind of problem: ${lens.title}.
${PRIMER}
The question: ${lens.ask}
Report a problem only if you can point at the line and it is a real bug, not a style point and not a guess about code you cannot see. If the snippet is fine, reply {"findings":[]}.
Reply with JSON only, no prose: {"findings":[{"line":<line number>,"why":"<one sentence>","old":"<exact text copied from the code, 1 to 3 lines, without the line numbers>","new":"<the corrected text>"}]}
At most 1 finding. "old" must be copied exactly so it can be found by string search.`;
}
export const scoutMessages = (lensId, file, start, end, text) => [
  { role: 'system', content: scoutSystem(lensId) },
  { role: 'user', content: `File: ${file}\nLines ${start}-${end}\n\n${text}` },
];

export const SKEPTIC_SYSTEM = `You are the SKEPTIC in a code review of Tacit's browser JavaScript. A reviewer claims there is a bug in the snippet and proposes a change. Your job is to try to REFUTE the claim by reading the code.
${PRIMER}
Verdicts:
- "real": you checked, the problem exists as described on the line you quote, and the proposed change fixes it without breaking anything.
- "false": the code is fine, the claim misreads it, the change does the same thing as the old code, or the change would break the code.
- "unsure": it depends on something that is not in the snippet.
Reply with JSON only, no prose: {"verdict":"real|false|unsure","line":<line number>,"quote":"<the exact text of the line you relied on, copied from the code>","why":"<one sentence>"}`;
export const skepticMessages = (f, text) => [
  { role: 'system', content: SKEPTIC_SYSTEM },
  { role: 'user', content: `File: ${f.file}\nClaim (line ${f.line ?? '?'}): ${oneLine(f.why, 300)}\nProposed change:\n- ${String(f.old).split('\n').join('\n- ')}\n+ ${String(f.new).split('\n').join('\n+ ')}\n\nCode:\n${text}` },
];

// A small model quoting a line of code often leaves its own double quotes unescaped, which is not JSON. The fields are then read one by one: the verdict word, the
// line number, and the quote up to the "why" that follows it.
function looseVerdict(t) {
  const v = t.match(/"verdict"\s*:\s*"(real|false|unsure)"/i); if (!v) return null;
  const line = t.match(/"line"\s*:\s*(\d+)/), q = t.match(/"quote"\s*:\s*"([\s\S]*?)"\s*(?:,\s*"why"|\}|$)/), w = t.match(/"why"\s*:\s*"([\s\S]*?)"\s*\}?\s*$/);
  return { verdict: v[1], line: line ? Number(line[1]) : null, quote: q ? q[1].replace(/\\"/g, '"') : '', why: w ? w[1] : '' };
}
// A skeptic's reply -> { verdict, line, quote, why }, or null when it is not the shape asked for (such a reply earns nothing).
export function verdictOf(text) {
  const t = String(text), m = t.match(/\{[\s\S]*\}/); let j = null;
  if (m) { try { j = JSON.parse(m[0]); } catch { j = null; } }
  if (!j) j = looseVerdict(t);
  const verdict = String(j?.verdict ?? '').toLowerCase();
  if (!['real', 'false', 'unsure'].includes(verdict)) return null;
  return { verdict, line: Number.isInteger(j.line) ? j.line : null, quote: plain(j.quote).slice(0, 300), why: plain(j.why).slice(0, 300) };
}
export const shape = (text) => verdictOf(text) !== null;

// the code a snippet shows, without its line numbers and with whitespace collapsed
const bare = (text) => String(text).split('\n').map((l) => l.replace(/^\d+:\s?/, '')).join('\n').replace(/\s+/g, ' ');
// A quote counts when it is at least 6 characters (once its own line number and spaces are dropped) and appears in the code that was shown.
export function grounded(quote, codeText) {
  const q = String(quote ?? '').replace(/^\s*\d+:\s?/, '').replace(/\s+/g, ' ').trim();
  return q.length >= 6 && bare(codeText).includes(q);
}
// What the vote is: a verdict whose quote is not in the code was not read from it, and counts as unsure.
export const voteOf = (text, codeText) => { const v = verdictOf(text); if (!v) return null; return { ...v, ok: grounded(v.quote, codeText), vote: v.verdict !== 'unsure' && grounded(v.quote, codeText) ? v.verdict : 'unsure' }; };

// A claim built from a planted bug, for measuring skeptics. TRUE: the code shown has the bug and the claim proposes the original line back. FALSE: the code
// shown is the original and the claim proposes the bug. The reason is the same kind of sentence a scout would write.
export function examClaim(p, truth, origSrc) {
  const code = truth ? p.src : origSrc;
  return { truth, code, claim: { file: p.file, line: p.line, why: p.say, old: (truth ? p.mut : p.orig).trim(), new: (truth ? p.orig : p.mut).trim() } };
}
