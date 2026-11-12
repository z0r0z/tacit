// node roles.test.mjs -- the scout and skeptic prompts, what counts as a grounded verdict, and the claims built from planted bugs
import { scoutSystem, scoutMessages, skepticMessages, SKEPTIC_SYSTEM, verdictOf, shape, grounded, voteOf, examClaim, findingId, fits } from './codecheck/roles.mjs';
import { LENSES, PRIMER } from './codecheck/lenses.mjs';
let fails = 0; const check = (n, c) => { console.log((c ? 'ok   ' : 'FAIL ') + n); if (!c) fails++; };

// --- scout
check('every lens gets a scout prompt with its question, the primer and the answer shape', LENSES.every((l) => { const s = scoutSystem(l.id); return s.includes(l.ask) && s.includes(PRIMER) && s.includes('{"findings":[]}'); }));
check('a scout prompt is about one lens only', !scoutSystem('units').includes('promises and failures') && scoutSystem('async').includes('promises and failures'));
check('an unknown lens is refused', (() => { try { scoutSystem('nope'); return false; } catch { return true; } })());
{
  const m = scoutMessages('bigint', 'dapp/a.js', 10, 20, '10: x');
  check('a scout job is a system and a user message naming the file and the lines', m.length === 2 && m[0].role === 'system' && m[1].role === 'user' && m[1].content === 'File: dapp/a.js\nLines 10-20\n\n10: x' && JSON.stringify(m).length < 24000);
}

// --- skeptic
const CODE = '10: function f(a, b) {\n11:   if (a >= b) return 1;\n12:   return 0;\n13: }';
{
  const m = skepticMessages({ file: 'dapp/a.js', line: 11, why: 'off by one', old: 'if (a >= b)', new: 'if (a > b)' }, CODE);
  check('a skeptic job holds the claim, the change and the numbered code', m[0].content === SKEPTIC_SYSTEM && m[1].content.includes('Claim (line 11): off by one') && m[1].content.includes('- if (a >= b)') && m[1].content.includes('+ if (a > b)') && m[1].content.endsWith(CODE));
  check('the skeptic is told to try to refute, and what the three verdicts mean', /REFUTE/.test(SKEPTIC_SYSTEM) && /"real"/.test(SKEPTIC_SYSTEM) && /"false"/.test(SKEPTIC_SYSTEM) && /"unsure"/.test(SKEPTIC_SYSTEM) && SKEPTIC_SYSTEM.includes(PRIMER));
  const multi = skepticMessages({ file: 'f', line: 1, why: 'w', old: 'a\nb', new: 'c\nd' }, CODE)[1].content;
  check('a change over several lines is shown line by line', multi.includes('- a\n- b') && multi.includes('+ c\n+ d'));
  check('a claim with no line number still reads', skepticMessages({ file: 'f', line: null, why: 'w', old: 'a', new: 'b' }, CODE)[1].content.includes('(line ?)'));
}

// --- verdicts
check('a verdict is read from the JSON, among any prose around it', verdictOf('Sure.\n{"verdict":"false","line":11,"quote":"if (a >= b) return 1;","why":"fine"}\nDone')?.verdict === 'false');
check('a verdict word in capitals is a verdict', verdictOf('{"verdict":"REAL","line":3,"quote":"const a = 1;","why":"x"}')?.verdict === 'real' && verdictOf('{"verdict":"False"}')?.verdict === 'false');
{
  // a small model leaves the quotes inside a quoted line of code unescaped, which is not JSON
  const v = verdictOf('{"verdict":"real","line":11,"quote":"const a = "x";","why":"the string is wrong"}');
  check('a reply whose quoted code has unescaped double quotes is still read: verdict, line, quote and why', v && v.verdict === 'real' && v.line === 11 && v.quote === 'const a = "x";' && v.why === 'the string is wrong');
  check('with a code fence and prose around it', verdictOf('Here is my answer:\n```json\n{"verdict": "false", "line": 4, "quote": "if (a >= b) return "yes";", "why": "fine"}\n```')?.quote === 'if (a >= b) return "yes";');
  check('a loosely read reply is checked like any other: its quote must be in the code', voteOf('{"verdict":"real","line":2,"quote":"let s = "q";","why":"w"}', '2: let s = "q";').vote === 'real' && voteOf('{"verdict":"real","line":2,"quote":"let t = "q";","why":"w"}', '2: let s = "q";').vote === 'unsure');
  check('a reply that mixes escaped and unescaped quotes is read, the escaped ones coming out as quotes', verdictOf('{"verdict":"real","line":1,"quote":"x = \\"a\\"; y = "b";","why":"w"}')?.quote === 'x = "a"; y = "b";');
  check('escaped quotes in valid JSON still come out as quotes', verdictOf('{"verdict":"real","quote":"x = \\"a\\";","why":"w"}')?.quote === 'x = "a";');
  check('a reply with no verdict word is still not a verdict, loose or not', verdictOf('"quote": "x", "why": "y"') === null && verdictOf('verdict: real') === null && verdictOf('{"verdict":"maybe","quote":"x"}') === null);
}
check('anything that is not a verdict is not one', [null, '', 'hello', '{"verdict":"maybe"}', '{"verdict":1}', '{"findings":[]}', '{bad json}', '[]'].every((t) => verdictOf(t) === null && !shape(t)));
check('the line is a number or nothing, and the text is cleaned and cut', (() => { const v = verdictOf(JSON.stringify({ verdict: 'real', line: '11', quote: 'x\u001b[2J' + 'q'.repeat(500), why: 'w‮' + 'y'.repeat(500) })); return v.line === null && !/[\u001b‮]/.test(v.quote + v.why) && v.quote.length === 300 && v.why.length === 300; })());

// --- grounding
check('a quote that is in the code is grounded, line number or not', grounded('if (a >= b) return 1;', CODE) && grounded('11:   if (a >= b) return 1;', CODE) && grounded('if  (a >=  b)   return 1;', CODE));
check('a quote that is not in the code is not grounded', !grounded('if (a > b) return 1;', CODE) && !grounded('const total = 5;', CODE));
check('a quote that is too short to mean anything is not grounded', !grounded('a', CODE) && !grounded('if (', CODE) && !grounded('', CODE) && !grounded(null, CODE));
check('a line number alone is not a quote, and one in front of a real fragment is dropped', !grounded('10: ', CODE) && !grounded('11:', CODE) && grounded('10: function f(a, b)', CODE));
{
  const reply = (v, q) => JSON.stringify({ verdict: v, line: 11, quote: q, why: 'w' });
  check('a real verdict with a quote from the code is a real vote', voteOf(reply('real', 'if (a >= b) return 1;'), CODE).vote === 'real');
  check('a false verdict with a quote from the code is a false vote', voteOf(reply('false', 'return 0;'), CODE).vote === 'false');
  check('a verdict whose quote is not in the code counts as unsure, either way', voteOf(reply('real', 'made up text here'), CODE).vote === 'unsure' && voteOf(reply('false', 'made up text here'), CODE).vote === 'unsure');
  check('unsure stays unsure', voteOf(reply('unsure', 'return 0;'), CODE).vote === 'unsure');
  check('a reply that is not a verdict is no vote at all', voteOf('nope', CODE) === null);
}

// --- what a node will take
check('a job that fits is kept and one with a very long line is not', fits(scoutMessages('bigint', 'a.js', 1, 9, '1: x')) && !fits(scoutMessages('bigint', 'a.js', 1, 9, '1: ' + 'x'.repeat(30000))) && fits(skepticMessages({ file: 'f', line: 1, why: 'w', old: 'a', new: 'b' }, '1: y')) && !fits(skepticMessages({ file: 'f', line: 1, why: 'w', old: 'a', new: 'b' }, 'y'.repeat(25000))));

// --- ids
check('a finding id is stable and tells different findings apart', findingId('a', 'x', 'y') === findingId('a', 'x', 'y') && findingId('a', 'x', 'y') !== findingId('b', 'x', 'y') && findingId('a', 'x', 'y') !== findingId('a', 'x', 'z') && /^[0-9a-f]{10}$/.test(findingId('a', 'x', 'y')));
check('the id does not mix up fields that run together', findingId('a', 'bc', 'd') !== findingId('ab', 'c', 'd'));

// --- exam claims from a planted bug
{
  const orig = 'if (a >= b) go();';
  const p = { file: 'dapp/a.js', line: 3, orig: `  ${orig}`, mut: '  if (a > b) go();', src: 'MUTATED SOURCE', say: 'off by one' };
  const t = examClaim(p, true, 'ORIGINAL SOURCE'), f = examClaim(p, false, 'ORIGINAL SOURCE');
  check('a true claim shows the broken code and proposes the original line', t.truth === true && t.code === 'MUTATED SOURCE' && t.claim.old === 'if (a > b) go();' && t.claim.new === orig);
  check('a false claim shows the original code and proposes the bug', f.truth === false && f.code === 'ORIGINAL SOURCE' && f.claim.old === orig && f.claim.new === 'if (a > b) go();');
  check('both read like a real finding: the same file, line and reason', t.claim.file === f.claim.file && t.claim.line === 3 && t.claim.why === 'off by one' && f.claim.why === 'off by one');
}
console.log(fails ? `${fails} roles test(s) failed` : 'roles: all tests passed'); process.exit(fails ? 1 : 0);
