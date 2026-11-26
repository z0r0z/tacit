// node --test ceremony-phase2/proxy/mirror.test.mjs: the mirror copies only files of the pinned, signed chain.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { trustedFiles } from './mirror.mjs';

const t = JSON.parse(readFileSync(new URL('../../dapp/praxis/transcript.json', import.meta.url)));

test('the published transcript is trusted end to end', async () => {
  const { files, why } = await trustedFiles(t);
  assert.equal(why, null);
  assert.equal(files.length, 1 + t.receipts.length);
});

test('a receipt with a changed field, a broken link or another key stops the copy there', async () => {
  const forged = structuredClone(t);
  forged.receipts[0].name = 'Mallory';
  assert.match((await trustedFiles(forged)).why, /not signed/);
  assert.equal((await trustedFiles(forged)).files.length, 1);

  const unlinked = structuredClone(t);
  unlinked.receipts[0].prev_file_sha256 = '00'.repeat(32);
  assert.match((await trustedFiles(unlinked)).why, /does not link/);

  const other = structuredClone(t);
  other.coordinator_pubkey = '11'.repeat(32);
  assert.deepEqual((await trustedFiles(other)).files, []);
});

test('credits: one per 0x address, on its receipt day, only from signed receipts', async () => {
  const { dayTally, credited, addressOf } = await import('./credits.mjs');
  assert.equal(addressOf({ name: 'Tacit', handle: '@tacitfinance' }), null);
  assert.equal(addressOf({ name: 'x', handle: ' 0xAbCdEf0123456789abcdef0123456789ABCDEF01 ' }), '0xabcdef0123456789abcdef0123456789abcdef01');
  // the saved transcript's first receipt (name Tacit, handle @tacitfinance) has no address: it is never credited, and every credit is an address
  const real = await credited(t);
  assert.ok(real.every((c) => /^0x[0-9a-f]{40}$/.test(c.miner)) && !real.some((c) => c.index === t.receipts[0].index));
  const day = Math.floor(Date.parse(t.receipts[0].at) / 86_400_000);
  const tally = await dayTally(t, day, { nowMs: Date.now() });
  assert.ok(tally.over && tally.miners.every((m) => /^0x[0-9a-f]{40}$/.test(m.miner)));
  // a receipt whose handle was changed to an address no longer verifies, so it credits nothing
  const forged = structuredClone(t);
  forged.receipts[0].handle = '0x' + '11'.repeat(20);
  assert.deepEqual(await credited(forged), [], 'a changed receipt stops the chain there: nothing after it counts');
});

test('credits from a signed chain: the first contribution per address, its day, excluded addresses skipped', async () => {
  const { generateKeyPairSync, sign, createHash } = await import('node:crypto');
  const { signedBytes } = await import('../../dapp/praxis/receipt.js');
  const { dayTally } = await import('./credits.mjs');
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const key = publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('hex');
  const h = (s) => createHash('sha256').update(s).digest('hex');
  const base = { index: 17, sha256: h('base') };
  const A = '0x' + 'aa'.repeat(20), B = '0x' + 'bb'.repeat(20), HOUSE = '0x' + 'cc'.repeat(20);
  const rows = [[A, '2026-11-26T10:00:00Z'], [A, '2026-11-26T11:00:00Z'], [B, '2026-11-27T01:00:00Z'], [HOUSE, '2026-11-27T02:00:00Z']];
  let prev = base.sha256;
  const receipts = rows.map(([addr, at], i) => {
    const r = { index: 18 + i, name: 'someone', handle: addr, contribution_hash: h(String(i)), file_sha256: h(String(i)), prev_file_sha256: prev, at };
    r.signature = sign(null, Buffer.from(signedBytes(r)), privateKey).toString('hex');
    prev = r.file_sha256;
    return r;
  });
  const t = { base_index: 17, base_sha256: base.sha256, head_index: 21, head_sha256: prev, coordinator_pubkey: key, receipts };
  const d1 = Math.floor(Date.parse('2026-11-26T00:00:00Z') / 86_400_000);
  const opts = { key, base, exclude: [HOUSE], nowMs: Date.parse('2026-11-28T00:00:00Z') };
  assert.deepEqual(await dayTally(t, d1, opts), { day: d1, over: true, miners: [{ miner: A, proofs: 1, points: 100 }] });
  assert.deepEqual((await dayTally(t, d1 + 1, opts)).miners, [{ miner: B, proofs: 1, points: 100 }], 'B credited; HOUSE excluded; A not twice');
  assert.equal((await dayTally(t, d1 + 1, { ...opts, nowMs: Date.parse('2026-11-27T12:00:00Z') })).over, false, 'today is not over');
});
