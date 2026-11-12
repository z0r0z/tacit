// node roles.test.mjs -- the scout and skeptic prompts, what counts as a grounded verdict, and the claims built from planted bugs
import { scoutSystem, scoutMessages, skepticMessages, proposedSide, SKEPTIC_SYSTEM, choiceOf, shape, grounded, voteOf, examClaim, findingId, fits, blindView, MARK } from './codecheck/roles.mjs';
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

// --- skeptic: a blind choice between two versions, in an order the gateway chose
const CODE = '10: function f(a, b) {\n11:   if (a >= b) return 1;\n12:   return 0;\n13: }';
{
  const f = { file: 'dapp/a.js', line: 11, why: 'off by one', old: 'if (a >= b)', new: 'if (a > b)' };
  const m = skepticMessages(f, CODE), n = skepticMessages(f, CODE, true);
  check('a skeptic job is the two versions and the code around them, the code as it stands as A when not flipped', m[0].content === SKEPTIC_SYSTEM && m[1].content === `File: dapp/a.js\nLines around 11\n\nVersion A:\nif (a >= b)\n\nVersion B:\nif (a > b)\n\nSurrounding code (the marked line is where version A or version B goes):\n${CODE}`);
  check('flipped, the proposed text is A and the code as it stands is B', n[1].content.includes('Version A:\nif (a > b)\n\nVersion B:\nif (a >= b)'));
  check('the proposed text is B when not flipped and A when flipped', proposedSide(false) === 'B' && proposedSide(true) === 'A');
  check('the skeptic is NOT told what the reviewer thought: no claim, no reason, no word of a bug found', !m[1].content.includes('off by one') && !/Claim|reviewer/i.test(m[1].content) && !/REFUTE|refute|skeptic/i.test(SKEPTIC_SYSTEM));
  check('the choices are A, B, same and unsure, with the primer and the answer shape', ['"A"', '"B"', '"same"', '"unsure"'].every((c) => SKEPTIC_SYSTEM.includes(c)) && SKEPTIC_SYSTEM.includes(PRIMER) && SKEPTIC_SYSTEM.includes('"choice":"A|B|same|unsure"'));
  const multi = skepticMessages({ file: 'f', line: 1, why: 'w', old: 'a\nb', new: 'c\nd' }, CODE)[1].content;
  check('a change over several lines is shown as it is', multi.includes('Version A:\na\nb\n\nVersion B:\nc\nd'));
  check('a finding with no line number still reads', skepticMessages({ file: 'f', line: null, why: 'w', old: 'a', new: 'b' }, CODE)[1].content.includes('Lines around ?'));
}

// --- what a judge is shown: whole lines, and the code around them with those lines taken out
{
  const SRC = ['function f(a, b) {', '  if (a >= b) return 1;', '  return 0;', '}', 'function g(a, b) {', '  if (a >= b) return 2;', '  return 0;', '}'].join('\n');
  const v = blindView(SRC, { old: 'a >= b', new: 'a > b', line: 2 }, 2);
  check('the versions are the whole lines, as they stand and with the change made, without their indent', v.old === 'if (a >= b) return 1;' && v.new === 'if (a > b) return 1;' && v.line === 2 && v.count === 1);
  check('the code around them has those lines replaced by one marked line, numbered from the file', v.codeText === `1: function f(a, b) {\n2: ${MARK}\n3:   return 0;\n4: }` && !v.codeText.includes('a >= b'));
  const w = blindView(SRC, { old: 'a >= b', new: 'a > b', line: 6 }, 1);
  check('of several places the old text occurs, the one nearest the line named is used', w.line === 6 && w.old === 'if (a >= b) return 2;' && w.codeText === `5: function g(a, b) {\n6: ${MARK}\n7:   return 0;`);
  const multi = blindView(SRC, { old: 'return 1;\n  return 0;', new: 'return 1;\n  return 9;', line: 2 }, 1);
  check('a change over several lines takes all of them out, keeping the numbers of the lines after', multi.count === 2 && multi.old === 'if (a >= b) return 1;\nreturn 0;' && multi.new === 'if (a >= b) return 1;\nreturn 9;' && multi.codeText === `1: function f(a, b) {\n2: ${MARK}\n4: }`);
  check('a finding whose old text is not there, or empty, has no view', blindView(SRC, { old: 'nope', new: 'x', line: 1 }) === null && blindView(SRC, { old: '', new: 'x', line: 1 }) === null);
  check('with no line named, the first place is used', blindView(SRC, { old: 'a >= b', new: 'a > b' }, 0).line === 2);
  check('the judge is told what the marked line is', SKEPTIC_SYSTEM.includes('the marked line is where version A or version B goes') && skepticMessages({ file: 'f', line: 1, old: 'a', new: 'b' }, 'x')[1].content.includes('Surrounding code (the marked line is where version A or version B goes):'));
}

// --- choices
check('a choice is read from the JSON, among any prose around it', choiceOf('Sure.\n{"choice":"B","line":11,"quote":"if (a >= b) return 1;","why":"fine"}\nDone')?.choice === 'B');
check('a, b, "Version A", "SAME" and "unsure" are read as the letters or words they mean', ['a', 'A', 'Version A', 'version a', ' A '].every((v) => choiceOf(JSON.stringify({ choice: v }))?.choice === 'A') && choiceOf('{"choice":"b"}')?.choice === 'B' && choiceOf('{"choice":"SAME"}')?.choice === 'same' && choiceOf('{"choice":"Unsure"}')?.choice === 'unsure');
check('anything that is not a choice is not one', [null, '', 'hello', '{"choice":"C"}', '{"choice":"AB"}', '{"choice":1}', '{"choice":""}', '{"verdict":"real"}', '{"findings":[]}', '{bad json}', '[]'].every((t) => choiceOf(t) === null && !shape(t)));
check('the line is a number or nothing, and the text is cleaned and cut', (() => { const v = choiceOf(JSON.stringify({ choice: 'A', line: '11', quote: 'x\u001b[2J' + 'q'.repeat(500), why: 'w\u202e' + 'y'.repeat(500) })); return v.line === null && !/[\u001b\u202e]/.test(v.quote + v.why) && v.quote.length === 300 && v.why.length === 300; })());
{
  // a small model leaves the quotes inside a quoted line of code unescaped, which is not JSON
  const v = choiceOf('{"choice":"A","line":11,"quote":"const a = "x";","why":"the string is wrong"}');
  check('a reply whose quoted code has unescaped double quotes is still read: choice, line, quote and why', v && v.choice === 'A' && v.line === 11 && v.quote === 'const a = "x";' && v.why === 'the string is wrong');
  check('with a code fence and prose around it', choiceOf('Here is my answer:\n```json\n{"choice": "B", "line": 4, "quote": "if (a >= b) return "yes";", "why": "fine"}\n```')?.quote === 'if (a >= b) return "yes";');
  check('a reply that mixes escaped and unescaped quotes is read, the escaped ones coming out as quotes', choiceOf('{"choice":"A","line":1,"quote":"x = \\"a\\"; y = "b";","why":"w"}')?.quote === 'x = "a"; y = "b";');
  check('escaped quotes in valid JSON still come out as quotes', choiceOf('{"choice":"A","quote":"x = \\"a\\";","why":"w"}')?.quote === 'x = "a";');
  check('a reply with no choice word is still not a choice, loose or not', choiceOf('"quote": "x", "why": "y"') === null && choiceOf('choice: A') === null && choiceOf('{"choice":"maybe","quote":"x"}') === null);
}

// --- grounding
check('a quote that is in the code is grounded, line number or not', grounded('if (a >= b) return 1;', CODE) && grounded('11:   if (a >= b) return 1;', CODE) && grounded('if  (a >=  b)   return 1;', CODE));
check('a quote that is not in the code is not grounded', !grounded('if (a > b) return 1;', CODE) && !grounded('const total = 5;', CODE));
check('a quote that is too short to mean anything is not grounded', !grounded('a', CODE) && !grounded('if (', CODE) && !grounded('', CODE) && !grounded(null, CODE));
check('a line number alone is not a quote, and one in front of a real fragment is dropped', !grounded('10: ', CODE) && !grounded('11:', CODE) && grounded('10: function f(a, b)', CODE));

// --- the vote: which side the proposed text was on decides what a choice means
{
  const reply = (c, q = 'if (a >= b) return 1;') => JSON.stringify({ choice: c, line: 11, quote: q, why: 'w' });
  check('choosing the proposed text is a real vote, on whichever side it was shown', voteOf(reply('B'), CODE, 'B').vote === 'real' && voteOf(reply('A'), CODE, 'A').vote === 'real');
  check('choosing the other one is a false vote', voteOf(reply('A'), CODE, 'B').vote === 'false' && voteOf(reply('B'), CODE, 'A').vote === 'false');
  check('"same" is a false vote: a change that does nothing is not a finding', voteOf(reply('same'), CODE, 'B').vote === 'false' && voteOf(reply('same'), CODE, 'A').vote === 'false');
  check('unsure stays unsure', voteOf(reply('unsure'), CODE, 'B').vote === 'unsure');
  check('a choice whose quote is not in what was shown counts as unsure, whichever it is', voteOf(reply('B', 'made up text here'), CODE, 'B').vote === 'unsure' && voteOf(reply('A', 'made up text here'), CODE, 'B').vote === 'unsure' && voteOf(reply('same', 'made up text here'), CODE, 'B').vote === 'unsure');
  check('the vote says whether the quote was grounded and what the choice was', (() => { const v = voteOf(reply('A'), CODE, 'B'); return v.ok === true && v.choice === 'A' && v.line === 11; })());
  check('a quote may be taken from the two versions as well as the code, when what was shown includes them', voteOf(reply('A', 'if (a > b) return 1;'), CODE + '\nif (a > b) return 1;', 'B').vote === 'false');
  check('a reply that is not a choice is no vote at all', voteOf('nope', CODE, 'B') === null);
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
