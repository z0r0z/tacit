// tools/airdrop-tree.mjs: input validation, deterministic indexing, proof recomputation and the CLI.
import { test } from 'node:test';
import assert from 'node:assert';
import { writeFileSync, mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { build, verifyFile, parseInput, parseTac, checksum, leafHash, buildTree, proofFor, UNIT_SCALE } from '../tools/airdrop-tree.mjs';

const A = '0x' + '11'.repeat(20), B = '0x' + '22'.repeat(20), C = '0x' + '33'.repeat(20);
const tac = (n) => parseTac(String(n));
const rows = (...p) => p.map(([address, n]) => ({ address, amountWei: tac(n) }));
const expectFail = (entries, opts, re) => assert.throws(() => build(entries, opts), (e) => re.test(e.message));

test('builds, assigns indexes by sorted address, and every proof recomputes', () => {
  const r = build(rows([C, 30], [A, 10], [B, 20]), { expectTotalWei: tac(60) });
  assert.equal(r.count, 3);
  assert.deepEqual(Object.keys(r.claims), [A, B, C]);
  assert.deepEqual(Object.values(r.claims).map((c) => c.index), [0, 1, 2]);
  assert.equal(r.totalWei, tac(60).toString());
  assert.ok(verifyFile(r).ok);
});

test('the root does not depend on input order', () => {
  const x = build(rows([C, 30], [A, 10], [B, 20]), { expectTotalWei: tac(60) });
  const y = build(rows([A, 10], [B, 20], [C, 30]), { expectTotalWei: tac(60) });
  assert.equal(x.root, y.root);
});

test('rejects duplicates in any letter case', () => {
  const upper = '0x' + 'AB'.repeat(20), lower = upper.toLowerCase();
  expectFail(rows([upper, 1], [lower, 2]), { expectTotalWei: tac(3) }, /duplicate/);
});

test('rejects the zero address, zero and negative-looking amounts, and non-addresses', () => {
  expectFail(rows(['0x' + '00'.repeat(20), 1]), { expectTotalWei: tac(1) }, /zero address/);
  expectFail([{ address: A, amountWei: 0n }], { expectTotalWei: 0n }, /positive/);
  expectFail(rows(['0x1234', 1]), { expectTotalWei: tac(1) }, /not an address/);
  assert.throws(() => parseTac('-1'), /bad amount/);
  assert.throws(() => parseTac('1.0000000000000000001'), /bad amount/);
});

test('rejects amounts that are not a multiple of the pool unit scale', () => {
  const dust = [{ address: A, amountWei: UNIT_SCALE + 1n }];
  expectFail(dust, { expectTotalWei: UNIT_SCALE + 1n }, /multiple of 10000000000/);
  build([{ address: A, amountWei: UNIT_SCALE }], { expectTotalWei: UNIT_SCALE }); // one pool unit is the smallest allowed
  assert.equal(parseTac('0.00000001'), UNIT_SCALE);
});

test('rejects a pool value beyond u64', () => {
  const big = (1n << 64n) * UNIT_SCALE;
  expectFail([{ address: A, amountWei: big }], { expectTotalWei: big }, /u64/);
});

test('rejects a total that differs from the expected funding, and requires one', () => {
  expectFail(rows([A, 10], [B, 20]), { expectTotalWei: tac(31) }, /differs from the expected/);
  expectFail(rows([A, 10]), {}, /expected total is required/);
});

test('rejects reserved contract addresses', () => {
  expectFail(rows([A, 1]), { expectTotalWei: tac(1), reserved: [A.toUpperCase().replace('0X', '0x')] }, /reserved/);
});

test('a mixed-case address must carry a valid checksum', () => {
  const good = checksum(A.replace(/1/g, 'a'));
  build([{ address: good, amountWei: UNIT_SCALE }], { expectTotalWei: UNIT_SCALE });
  const flipped = good.slice(0, 2) + good.slice(2).split('').map((c, i) => (i === 3 ? (c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase()) : c)).join('');
  if (flipped !== good && flipped !== flipped.toLowerCase()) expectFail([{ address: flipped, amountWei: UNIT_SCALE }], { expectTotalWei: UNIT_SCALE }, /checksum/);
});

test('reports every problem at once', () => {
  try { build([{ address: A, amountWei: 0n }, { address: A, amountWei: 1n }], { expectTotalWei: 5n }); assert.fail('should throw'); }
  catch (e) { assert.ok(e.problems.length >= 3, e.message); }
});

test('verifyFile catches a tampered proof, amount, index and root', () => {
  const r = build(rows([A, 10], [B, 20], [C, 30]), { expectTotalWei: tac(60) });
  const clone = () => JSON.parse(JSON.stringify(r));
  let t = clone(); t.claims[B].proof[0] = '0x' + '00'.repeat(32); assert.throws(() => verifyFile(t), /proof fails/);
  t = clone(); t.claims[B].amount = tac(21).toString(); assert.throws(() => verifyFile(t), /proof fails|totalWei/);
  t = clone(); t.claims[B].index = 7; assert.throws(() => verifyFile(t), /missing|proof fails/);
  assert.throws(() => verifyFile(r, { root: '0x' + '00'.repeat(32) }), /differs from expected/);
});

test('a one-recipient tree has an empty proof and root equal to its leaf', () => {
  const r = build(rows([A, 5]), { expectTotalWei: tac(5) });
  assert.deepEqual(r.claims[A].proof, []);
  assert.equal(r.root, '0x' + Buffer.from(leafHash(0, A, tac(5))).toString('hex'));
});

test('parses JSON (whole TAC and base units) and CSV with a header', () => {
  const json = JSON.stringify([{ address: A, amount: '1.5' }, { address: B, amountWei: '20000000000' }]);
  assert.deepEqual(parseInput(json).map((r) => r.amountWei), [tac('1.5'), 20000000000n]);
  const csv = `address,amount\n${A},1.5\n# note\n${B},2\n`;
  assert.deepEqual(parseInput(csv).map((r) => r.amountWei), [tac('1.5'), tac(2)]);
  assert.deepEqual(parseInput(`${A},15000000000\n`, 'wei').map((r) => r.amountWei), [15000000000n]);
  assert.throws(() => parseInput(`${A},1,2\n`), /expected address,amount/);
});

test('the root is a 32-byte hash and is stable across runs', () => {
  const r = build(rows([A, 10], [B, 20], [C, 30]), { expectTotalWei: tac(60) });
  assert.equal(r.root, build(rows([B, 20], [C, 30], [A, 10]), { expectTotalWei: tac(60) }).root);
  assert.match(r.root, /^0x[0-9a-f]{64}$/);
});

test('CLI: writes proofs and per-recipient files, and re-verifies a file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'airdrop-'));
  writeFileSync(join(dir, 'list.csv'), `${A},10\n${B},20\n${C},30\n`);
  const cli = (...a) => execFileSync('node', ['tools/airdrop-tree.mjs', ...a], { encoding: 'utf8', cwd: new URL('..', import.meta.url).pathname });
  const out = cli('--input', join(dir, 'list.csv'), '--expect-total', '60', '--out', join(dir, 'p.json'), '--out-dir', join(dir, 'd'));
  assert.match(out, /recipients  3/);
  assert.ok(existsSync(join(dir, 'd', `${B}.json`)) && existsSync(join(dir, 'd', 'manifest.json')));
  const one = JSON.parse(readFileSync(join(dir, 'd', `${B}.json`), 'utf8'));
  assert.equal(one.index, 1);
  assert.match(cli('--verify-file', join(dir, 'p.json')), /every proof recomputes/);
  assert.throws(() => cli('--input', join(dir, 'list.csv'), '--expect-total', '61'), /differs from the expected/);
  assert.throws(() => cli('--input', join(dir, 'list.csv')), /expected total is required/);
});

test('a root that also commits to an unlisted leaf is rejected even though every listed proof verifies', () => {
  const D = '0x' + '44'.repeat(20);
  const full = build(rows([A, 10], [B, 20], [C, 30], [D, 40]), { expectTotalWei: tac(100) });
  const shown = { ...full, count: 3, totalWei: tac(60).toString(), claims: { [A]: full.claims[A], [B]: full.claims[B], [C]: full.claims[C] } };
  assert.throws(() => verifyFile(shown), /commits to leaves that are not listed/);
  assert.ok(verifyFile(full).ok);
});

test('JSON amounts must be strings so no precision is lost', () => {
  assert.throws(() => parseInput(JSON.stringify([{ address: A, amount: 123456789.123456789 }])), /must be a string/);
  assert.throws(() => parseInput(JSON.stringify([{ address: A, amountWei: 1000000000000 }])), /must be a string/);
  assert.equal(parseInput(JSON.stringify([{ address: A, amount: '123456789.123456789' }]))[0].amountWei, 123456789123456789000000000n);
});

test('--out-shards writes one file per leading address byte that holds every claim once', () => {
  const dir = mkdtempSync(join(tmpdir(), 'airdrop-'));
  writeFileSync(join(dir, 'list.csv'), `${A},10\n${B},20\n${C},30\n`);
  const cwd = new URL('..', import.meta.url).pathname;
  execFileSync('node', ['tools/airdrop-tree.mjs', '--input', join(dir, 'list.csv'), '--expect-total', '60', '--out-shards', join(dir, 's')], { encoding: 'utf8', cwd });
  const man = JSON.parse(readFileSync(join(dir, 's', 'manifest.json'), 'utf8'));
  assert.deepEqual(man.shards, ['11', '22', '33']);
  const s = JSON.parse(readFileSync(join(dir, 's', '22.json'), 'utf8'));
  assert.equal(s.root, man.root);
  assert.deepEqual(Object.keys(s.claims), [B]);
  assert.equal(s.claims[B].index, 1);
  assert.ok(Array.isArray(s.claims[B].proof));
});
