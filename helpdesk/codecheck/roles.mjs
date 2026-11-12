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
At most 1 finding. "old" must be copied exactly so it can be found by string search.
Decide before you write: if you are not sure the line is wrong, reply {"findings":[]}. "why" is one short sentence (at most 25 words), not your reasoning.`;
}
export const scoutMessages = (lensId, file, start, end, text) => [
  { role: 'system', content: scoutSystem(lensId) },
  { role: 'user', content: `File: ${file}\nLines ${start}-${end}\n\n${text}` },
];

// The skeptic is not told what the reviewer thought. It is given two versions of the lines, in an order the gateway chose at random, and picks the correct one from
// the code around them. A question that can be answered yes or no is answered the same way every time by a small model; a choice between two things that are
// shuffled is only answered right by reading, and a machine that always says A scores a half.
export const SKEPTIC_SYSTEM = `You are the JUDGE in a code review of Tacit's browser JavaScript. Two versions of a few lines are given. At most one has a bug; they may also behave the same. The surrounding code is shown with those lines taken out: the marked line is where version A or version B goes. Decide, from the surrounding code, which version is correct.
${PRIMER}
Choices:
- "A": version A is the correct one.
- "B": version B is the correct one.
- "same": the two versions behave the same.
- "unsure": it depends on something that is not in the code shown.
Reply with JSON only, no prose: {"choice":"A|B|same|unsure","line":<line number>,"quote":"<the exact text of a line of the surrounding code that shows which one is right, copied from it>","why":"<one sentence>"}`;
// `flip` puts the proposed text in A and the code as it stands in B; the proposed text is B otherwise. The surrounding code shows the lines as they stand now.
export const proposedSide = (flip) => (flip ? 'A' : 'B');
export function skepticMessages(f, text, flip = false) {
  const a = flip ? f.new : f.old, b = flip ? f.old : f.new;
  return [
    { role: 'system', content: SKEPTIC_SYSTEM },
    { role: 'user', content: `File: ${f.file}\nLines around ${f.line ?? '?'}\n\nVersion A:\n${a}\n\nVersion B:\n${b}\n\nSurrounding code (the marked line is where version A or version B goes):\n${text}` },
  ];
}

// What a judge is shown for a finding: the lines it is about, whole, as they stand (old) and with the change made (new), and the code around them with those lines
// replaced by one marked line. A judge shown the code as it stands sees the old version fit and picks it; with the lines taken out, neither version is the one already
// there. Of several places the old text occurs, the one nearest the line the finding names. -> { codeText, old, new, line, count } or null if the old text is not there.
export const MARK = '>>> version A or version B goes here <<<';
const dedent = (s) => { const ls = s.split('\n'), pads = ls.filter((l) => l.trim()).map((l) => l.match(/^\s*/)[0].length), pad = pads.length ? Math.min(...pads) : 0; return ls.map((l) => l.slice(pad)).join('\n'); };
export function blindView(src, f, context = 15) {
  if (!f.old) return null;
  let at = -1, dist = Infinity;
  for (let i = src.indexOf(f.old); i >= 0; i = src.indexOf(f.old, i + 1)) { const ln = src.slice(0, i).split('\n').length, d = Math.abs(ln - (Number.isInteger(f.line) ? f.line : ln)); if (d < dist) { at = i; dist = d; } }
  if (at < 0) return null;
  const ls = src.lastIndexOf('\n', at - 1) + 1, le0 = src.indexOf('\n', at + f.old.length), le = le0 < 0 ? src.length : le0;
  const first = src.slice(0, ls).split('\n').length, count = src.slice(ls, le).split('\n').length, lines = src.split('\n');
  const from = Math.max(1, first - context), to = Math.min(lines.length, first + count - 1 + context), out = [];
  for (let n = from; n <= to; n++) { if (n === first) out.push(`${n}: ${MARK}`); else if (n < first || n >= first + count) out.push(`${n}: ${lines[n - 1]}`); }
  return { codeText: out.join('\n'), old: dedent(src.slice(ls, le)), new: dedent(src.slice(ls, at) + f.new + src.slice(at + f.old.length, le)), line: first, count };
}

const letter = (v) => { const s = String(v ?? '').trim(); if (/^(?:version\s*)?a$/i.test(s)) return 'A'; if (/^(?:version\s*)?b$/i.test(s)) return 'B'; if (/^same/i.test(s)) return 'same'; if (/^unsure/i.test(s)) return 'unsure'; return null; };
// A small model quoting a line of code often leaves its own double quotes unescaped, which is not JSON. The fields are then read one by one: the choice, the line
// number, and the quote up to the "why" that follows it.
function looseChoice(t) {
  const c = t.match(/"choice"\s*:\s*"([^"]*)"/i); if (!c) return null;
  const line = t.match(/"line"\s*:\s*(\d+)/), q = t.match(/"quote"\s*:\s*"([\s\S]*?)"\s*(?:,\s*"why"|\}|$)/), w = t.match(/"why"\s*:\s*"([\s\S]*?)"\s*\}?\s*$/);
  return { choice: c[1], line: line ? Number(line[1]) : null, quote: q ? q[1].replace(/\\"/g, '"') : '', why: w ? w[1] : '' };
}
// A skeptic's reply -> { choice: 'A' | 'B' | 'same' | 'unsure', line, quote, why }, or null when it is not the shape asked for (such a reply earns nothing).
export function choiceOf(text) {
  const t = String(text), m = t.match(/\{[\s\S]*\}/); let j = null;
  if (m) { try { j = JSON.parse(m[0]); } catch { j = null; } }
  if (!j) j = looseChoice(t);
  const choice = letter(j?.choice);
  if (!choice) return null;
  return { choice, line: Number.isInteger(j.line) ? j.line : null, quote: plain(j.quote).slice(0, 300), why: plain(j.why).slice(0, 300) };
}
export const shape = (text) => choiceOf(text) !== null;

// the code a snippet shows, without its line numbers and with whitespace collapsed
const bare = (text) => String(text).split('\n').map((l) => l.replace(/^\d+:\s?/, '')).join('\n').replace(/\s+/g, ' ');
// A quote counts when it is at least 6 characters (once its own line number and spaces are dropped) and appears in what the skeptic was shown.
export function grounded(quote, codeText) {
  const q = String(quote ?? '').replace(/^\s*\d+:\s?/, '').replace(/\s+/g, ' ').trim();
  return q.length >= 6 && bare(codeText).includes(q);
}
// What the vote is, given the side the proposed text was shown on: the proposed text chosen is REAL; the other chosen, or "same" (the change does nothing), is FALSE;
// "unsure" is unsure; and a choice whose quote is not in what was shown was not read from it, and counts as unsure.
export function voteOf(text, shown, proposed) {
  const v = choiceOf(text); if (!v) return null;
  const ok = grounded(v.quote, shown), raw = v.choice === 'unsure' ? 'unsure' : v.choice === proposed ? 'real' : 'false';
  return { ...v, ok, vote: raw !== 'unsure' && ok ? raw : 'unsure' };
}

// A claim built from a planted bug, for measuring skeptics. TRUE: the code shown has the bug and the claim proposes the original line back. FALSE: the code
// shown is the original and the claim proposes the bug. The reason is the same kind of sentence a scout would write.
export function examClaim(p, truth, origSrc) {
  const code = truth ? p.src : origSrc;
  return { truth, code, claim: { file: p.file, line: p.line, why: p.say, old: (truth ? p.mut : p.orig).trim(), new: (truth ? p.orig : p.mut).trim() } };
}
