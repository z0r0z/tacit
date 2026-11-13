// node swarmbook.test.mjs -- the running record of exam answers and votes: counts kept as rows come in, files read again only when changed under it, cut back when
// large, weights and pay from recent answers only, and each address's standing
import { mkdtempSync, writeFileSync, appendFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { makeExamBook, makeVoteBook, makeTailRows, weightFor, examSummary, examAdd, emptySummary } from './swarmbook.mjs';
import { writeSync, openSync, closeSync, renameSync, utimesSync } from 'node:fs';
let fails = 0; const check = (n, c) => { console.log((c ? 'ok   ' : 'FAIL ') + n); if (!c) fails++; };
const dir = mkdtempSync(path.join(tmpdir(), 'sb-'));
const A = '0x' + 'a1'.repeat(20), B = '0x' + 'b2'.repeat(20);
const sk = (node, outcome, o = {}) => ({ t: 1, role: 'skeptic', node, miner: A, tier: 'small', lens: 'bounds', kind: 'ge-to-gt', truth: true, choice: 'A', outcome, ...o });
const sc = (node, outcome, o = {}) => ({ t: 1, role: 'scout', node, miner: A, tier: 'small', lens: 'units', kind: 'scale', outcome, fp: 0, ...o });
const lines = (f) => readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).length;

// --- weights
check('no weight below the minimum answers, then by how often it was right', weightFor(5, 0) === null && weightFor(8, 2) === 1.5 && weightFor(7, 3) === 1 && weightFor(6, 4) === 1 && weightFor(11, 9) === 0.5 && weightFor(5, 5) === 0 && weightFor(2, 8) === 0 && weightFor(3, 0, 3) === 1.5);

// --- the counts are the same as reading every row
{
  const rows = [sk('n1', 'right'), sk('n1', 'wrong', { truth: false, choice: 'B' }), sk('n2', 'unsure'), sk('n2', 'invalid'), sc('n1', 'restored'), sc('n2', 'miss', { fp: 2 }), sc('n2', 'invalid')];
  const f = path.join(dir, 'e1.jsonl'), book = makeExamBook({ file: f });
  for (const r of rows) book.add(r);
  check('rows added one by one give the counts reading them all would', JSON.stringify(book.summary()) === JSON.stringify(examSummary(rows)) && JSON.stringify(rows.reduce(examAdd, emptySummary())) === JSON.stringify(examSummary(rows)));
  check('and each is written to the file', lines(f) === rows.length);
  check('a new book over the same file has the same counts', JSON.stringify(makeExamBook({ file: f }).summary()) === JSON.stringify(book.summary()));
}
// --- a file changed under the book is read again
{
  const f = path.join(dir, 'e2.jsonl'), book = makeExamBook({ file: f });
  book.add(sk('n1', 'right'));
  appendFileSync(f, JSON.stringify(sk('n1', 'wrong')) + '\n' + JSON.stringify(sc('n1', 'near')) + '\n');
  check('rows another writer appended are counted', book.summary().skeptic.n === 2 && book.summary().scout.near === 1);
  writeFileSync(f, JSON.stringify(sk('n9', 'right')) + '\n');
  check('a file rewritten shorter is read again from the start', book.summary().skeptic.n === 1 && book.summary().scout.n === 0);
  writeFileSync(f, JSON.stringify(sk('n8', 'wrong')) + '\n'); utimesSync(f, new Date(), new Date(Date.now() + 7000));
  check('a file rewritten at the same size is read again (its time moved)', book.summary().skeptic.n === 1 && book.summary().skeptic.wrong === 1);
  rmSync(f);
  check('a file that is gone is no rows', book.summary().skeptic.n === 0);
  book.add(sk('n1', 'right'));
  check('and is started again on the next row', lines(f) === 1 && book.summary().skeptic.n === 1);
  const v0 = book.version(); book.add(sk('n1', 'right'));
  check('the version moves with every row, so what is worked out from it is worked out again', book.version() > v0);
}
// --- the file is cut back to its newest rows once it holds twice the limit
{
  const f = path.join(dir, 'e3.jsonl'), book = makeExamBook({ file: f, keep: 10 });
  for (let i = 0; i < 20; i++) book.add(sk('n1', 'right', { t: i }));
  check('at twice the limit it still holds them all', lines(f) === 20 && book.lines() === 20);
  book.add(sk('n1', 'wrong', { t: 20 }));
  const kept = readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  check('one more and it is cut back to the newest, the counts with it', kept.length === 10 && kept[0].t === 11 && kept[9].t === 20 && book.summary().skeptic.n === 10 && book.summary().skeptic.wrong === 1);
  writeFileSync(f, Array.from({ length: 25 }, (_, i) => JSON.stringify(sk('n1', 'right', { t: i }))).join('\n') + '\n');
  check('a file already over the limit when a book opens it is cut back too', makeExamBook({ file: f, keep: 10 }).lines() === 10 && lines(f) === 10);
}
// --- weights come from recent answers only
{
  const f = path.join(dir, 'e4.jsonl'), book = makeExamBook({ file: f, window: 20 });
  for (let i = 0; i < 40; i++) book.add(sk('old', 'wrong'));      // forty wrong answers under an old prompt
  check('a machine wrong forty times in a row carries no weight', book.skill().get('old') === 0);
  for (let i = 0; i < 20; i++) book.add(sk('old', 'right'));      // then twenty right
  check('after twenty right in a row, with a window of twenty, it carries full weight: the old answers no longer count', book.skill().get('old') === 1.5);
  check('a machine with too few answers has no weight on record', (() => { book.add(sk('new', 'right')); return !book.skill().has('new'); })());
  check('unsure and invalid answers are not counted either way', (() => { for (let i = 0; i < 10; i++) { book.add(sk('u', 'unsure')); book.add(sk('u', 'invalid')); } return !book.skill().has('u'); })());
  check('scout answers are not skeptic weight', (() => { for (let i = 0; i < 10; i++) book.add(sc('s', 'restored')); return !book.skill().has('s'); })());
}
// --- weights by lens
{
  const f = path.join(dir, 'e7.jsonl'), book = makeExamBook({ file: f, window: 200, lensWindow: 20 });
  for (let i = 0; i < 20; i++) book.add(sk('m', 'right', { lens: 'async' }));
  for (let i = 0; i < 20; i++) book.add(sk('m', i % 2 ? 'right' : 'wrong', { lens: 'bounds' }));
  const W = book.weights();
  check('a machine right every time on one lens carries full weight there', W.get('m', 'async') === 1.5);
  check('and none on a lens where it is at chance', W.get('m', 'bounds') === 0);
  check('on a lens it has too few answers on, its overall record counts (30 of 40 right: 1)', W.get('m', 'units') === 1 && W.get('m', undefined) === 1 && book.skill().get('m') === 1);
  check('a machine with nothing on record has no weight, and no machine is none', W.get('nobody', 'async') === undefined && W.get(null, 'async') === undefined);
  for (let i = 0; i < 20; i++) book.add(sk('m', 'wrong', { lens: 'async' }));
  check('weights are worked out again once new answers come in, from the recent ones only', book.weights().get('m', 'async') === 0);
}
// --- an appended file read a piece at a time
{
  const f = path.join(dir, 'inbox.jsonl'), t = makeTailRows(f);
  check('a file that is not there yet is no rows', t.rows().length === 0);
  writeFileSync(f, JSON.stringify({ n: 1 }) + '\n' + JSON.stringify({ n: 2 }) + '\n');
  const first = t.rows();
  check('lines written are read', first.length === 2 && first[1].n === 2);
  appendFileSync(f, JSON.stringify({ n: 3, why: 'é' }) + '\n');
  check('lines appended are added to the same rows', t.rows() === first && first.length === 3 && first[2].why === 'é');
  appendFileSync(f, '{"n":4,"half":');
  check('a line still being written is not read', t.rows().length === 3);
  appendFileSync(f, 'true}\n');
  check('and is read once it is whole', t.rows().length === 4 && t.rows()[3].half === true);
  // a character of more than one byte split between two writes
  const fd = openSync(f, 'a'), line = Buffer.from(JSON.stringify({ n: 5, why: '✓ ok' }) + '\n'); const cut = line.indexOf(Buffer.from('✓')) + 1;
  writeSync(fd, line.subarray(0, cut)); t.rows(); writeSync(fd, line.subarray(cut)); closeSync(fd);
  check('a character split between two writes is read whole', t.rows().length === 5 && t.rows()[4].why === '✓ ok');
  const gen0 = t.gen();
  // the inbox tool marks a finding: the file is rewritten, longer
  const marked = readFileSync(f, 'utf8').replace('{"n":1}', '{"n":1,"review":"rejected"}'); writeFileSync(f, marked);
  const again = t.rows();
  check('a file rewritten longer is read again from the start, not as an append', again !== first && again.length === 5 && again[0].review === 'rejected' && t.gen() > gen0);
  writeFileSync(f, JSON.stringify({ n: 9 }) + '\n');
  check('a file rewritten shorter is read again from the start', t.rows().length === 1 && t.rows()[0].n === 9);
  const same = JSON.stringify({ n: 8 }) + '\n'; writeFileSync(f, same); utimesSync(f, new Date(), new Date(Date.now() + 5000));
  check('a file rewritten at the same size is read again (its time changed)', t.rows().length === 1 && t.rows()[0].n === 8);
  const other = path.join(dir, 'inbox2.jsonl'); writeFileSync(other, JSON.stringify({ n: 7 }) + '\n' + JSON.stringify({ n: 6 }) + '\n'); renameSync(other, f);
  check('a file replaced by another is read from the start', t.rows().length === 2 && t.rows()[0].n === 7);
  appendFileSync(f, 'not json\n' + JSON.stringify({ n: 5 }) + '\n');
  check('a torn or foreign line is skipped', t.rows().length === 3 && t.rows()[2].n === 5);
  // a replacement that keeps the bytes last read where they were, changes an earlier row and adds one: only its being another file says to read from the start
  const long = JSON.stringify({ n: 7, pad: 'x'.repeat(120) }) + '\n' + JSON.stringify({ n: 6 }) + '\n';
  writeFileSync(f, long); t.rows();
  const swapped = path.join(dir, 'inbox3.jsonl');
  writeFileSync(swapped, long.replace('"n":7', '"n":1') + JSON.stringify({ n: 4 }) + '\n'); renameSync(swapped, f);
  check('a file replaced by another that ends the same is still read from the start', t.rows().length === 3 && t.rows()[0].n === 1 && t.rows()[2].n === 4);
  rmSync(f);
  check('a file that is gone is no rows', t.rows().length === 0);
}
// --- pay
{
  const f = path.join(dir, 'e5.jsonl'), book = makeExamBook({ file: f, window: 20, scoutWindow: 30, scoutProbation: 20 });
  check('a machine with nothing on record is paid, and so is one that names no machine', book.payable('check', 'fresh') && book.payable('scan', 'fresh') && book.payable('check', null) && book.payable('answer', 'x'));
  for (let i = 0; i < 10; i++) { book.add(sk('coin', 'right')); book.add(sk('coin', 'wrong')); }
  check('a skeptic at chance is not paid for checking', book.payable('check', 'coin') === false);
  for (let i = 0; i < 10; i++) { book.add(sk('ok', 'right')); book.add(sk('ok', 'right')); book.add(sk('ok', 'wrong')); }
  check('one above chance is', book.payable('check', 'ok') === true);
  for (let i = 0; i < 19; i++) book.add(sc('lazy', 'miss'));
  check('a scout that has missed nineteen planted bugs is still on probation, and paid', book.payable('scan', 'lazy') === true);
  book.add(sc('lazy', 'miss'));
  check('at twenty misses and none found it is not paid for scanning', book.payable('scan', 'lazy') === false);
  check('but still for checking, which is judged on its own', book.payable('check', 'lazy') === true);
  book.add(sc('lazy', 'near'));
  check('one bug found and it is paid again', book.payable('scan', 'lazy') === true);
  for (let i = 0; i < 30; i++) book.add(sc('lazy2', 'miss')); for (let i = 0; i < 1; i++) book.add(sc('lazy2', 'restored'));
  for (let i = 0; i < 30; i++) book.add(sc('lazy2', 'miss'));
  check('a find that has dropped out of the recent window no longer counts', book.payable('scan', 'lazy2') === false);
}
// --- standings
{
  const f = path.join(dir, 'e6.jsonl'), book = makeExamBook({ file: f });
  book.add(sk('n2', 'right', { miner: B })); book.add(sk('n2', 'invalid', { miner: B }));   // the quieter address first, so the order has to come from the sort
  for (let i = 0; i < 5; i++) book.add(sk('n1', i < 4 ? 'right' : 'wrong', { miner: A }));
  for (let i = 0; i < 3; i++) book.add(sc('n1', i ? 'miss' : 'restored', { miner: A }));
  const st = book.standings();
  check('each address is listed short, the busiest first, with its recent graded answers', st.length === 2 && st[0].miner === '0xa1a1a1…a1a1' && st[0].skeptic.n === 5 && st[0].skeptic.right === 4 && st[0].scout.n === 3 && st[0].scout.found === 1 && st[1].miner === '0xb2b2b2…b2b2' && st[1].skeptic.n === 1);
  check('the list can be cut short', book.standings(1).length === 1);
  book.add(sk('n3', 'right', { miner: 'not an address' }));
  check('something that is not an address is shown as ?', book.standings().some((x) => x.miner === '?'));
}
// --- votes
{
  const f = path.join(dir, 'v.jsonl'), votes = makeVoteBook({ file: f });
  votes.add({ id: 'f1', node: 'a', vote: 'real' }); votes.add({ id: 'f1', node: 'b', vote: 'false' }); votes.add({ id: 'f2', node: 'a', vote: 'real' });
  check('votes are kept by finding', votes.of('f1').length === 2 && votes.of('f2').length === 1 && votes.of('nope').length === 0 && votes.count() === 3);
  appendFileSync(f, JSON.stringify({ id: 'f2', node: 'c', vote: 'real' }) + '\n');
  check('a vote another writer appended is seen', votes.of('f2').length === 2);
  writeFileSync(f, JSON.stringify({ id: 'f9', node: 'a', vote: 'real' }) + '\n' + JSON.stringify({ id: 'f9', node: 'b', vote: 'real' }) + '\n' + JSON.stringify({ id: 'f9', node: 'c', vote: 'real' }) + '\n');
  const sameSize = readFileSync(f, 'utf8').replace(/f9/g, 'f8'); writeFileSync(f, sameSize); utimesSync(f, new Date(), new Date(Date.now() + 9000));
  check('votes rewritten at the same size are read again', votes.of('f9').length === 0 && votes.of('f8').length === 3);
  writeFileSync(f, '');
  check('a file emptied under it is read again', votes.of('f1').length === 0 && votes.count() === 0);
  check('a vote with no finding is not kept', (() => { votes.add({ node: 'x', vote: 'real' }); return votes.count() === 0; })());
  const v1 = votes.version(); votes.add({ id: 'f3', node: 'a', vote: 'real' });
  check('the version moves with every vote', votes.version() > v1 && makeVoteBook({ file: f }).of('f3').length === 1);
}
rmSync(dir, { recursive: true, force: true });
console.log(fails ? `${fails} swarmbook test(s) failed` : 'swarmbook: all tests passed'); process.exit(fails ? 1 : 0);
