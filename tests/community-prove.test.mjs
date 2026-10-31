// dapp/community-prove.js: the command the keeper page's mining card shows, and what it says mining pays, from the answers the pool and the points
// service give (here the live ones of 2026-10-31, and the shapes they take when mining is off).
//
// Run: node --test tests/community-prove.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { PROVE_URL, cleanAddress, proveCommand, tacText, utcDay, mineTerms, mineLines } from '../dapp/community-prove.js';

const ADDR = '0x1234567890abcdef1234567890abcdef12345678';
const OTHER = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';
const POOL = { queued: 0, leased: 0, doneToday: 23, minersToday: 0, top: [], terms: { pointsPerProof: 20, proofsPerMinerDay: 30, leaseMs: 2700000 } };
const MINE = {
  enabled: true, endSec: 1795478400, feed: 'https://api.tacit.finance/prover/pool/credits',
  pocket: { totalWei: '1500000000000000000000', creditedWei: '0', remainingWei: '1500000000000000000000' },
  terms: { fromDay: 20751, dailyWei: '50000000000000000000', capWeiPerPoint: '10000000000000000' },
  next: { fromDay: 20781, off: true }, lastPaidDay: 20756,
};
const NOW = Date.UTC(2026, 9, 31) / 1000;

test('an address is what tacit-prover takes: 0x and 40 hex digits, trimmed', () => {
  assert.equal(cleanAddress(ADDR), ADDR);
  assert.equal(cleanAddress(`  ${ADDR}\n`), ADDR);
  assert.equal(cleanAddress(ADDR.toUpperCase().replace('0X', '0x')), ADDR.toUpperCase().replace('0X', '0x'));
  for (const bad of ['', null, undefined, '0xYourAddress', '0x' + 'a'.repeat(39), '0x' + 'a'.repeat(41), '0x' + 'g'.repeat(40), 'vitalik.eth', ADDR.slice(2), '0X' + ADDR.slice(2)]) assert.equal(cleanAddress(bad), null, String(bad));
});

test('the command is the script piped into sh with the address, a placeholder until there is one', () => {
  assert.equal(PROVE_URL, 'https://tacit.finance/prove.sh');
  assert.equal(proveCommand(ADDR), `curl -fsSL https://tacit.finance/prove.sh | sh -s -- ${ADDR}`);
  assert.equal(proveCommand(''), 'curl -fsSL https://tacit.finance/prove.sh | sh -s -- 0xYourAddress');
  assert.equal(proveCommand('not an address'), 'curl -fsSL https://tacit.finance/prove.sh | sh -s -- 0xYourAddress');
  assert.equal(proveCommand(ADDR, 'status'), 'curl -fsSL https://tacit.finance/prove.sh | sh -s -- --status');
  assert.equal(proveCommand(ADDR, 'uninstall'), 'curl -fsSL https://tacit.finance/prove.sh | sh -s -- --uninstall');
});

test('TAC is written to two places without trailing zeros, truncated and never rounded up', () => {
  assert.equal(tacText('0'), '0');
  assert.equal(tacText('200000000000000000'), '0.2');
  assert.equal(tacText('6000000000000000000'), '6');
  assert.equal(tacText('6200000000000000000'), '6.2');
  assert.equal(tacText('10000000000000000'), '0.01');
  assert.equal(tacText('1999999999999999999'), '1.99');
  assert.equal(tacText('1500000000000000000000'), '1500');
  assert.equal(tacText('1234567890123456789', 4), '1.2345');
});

test('a proof pays its points times the cap, and the daily limit is the pool\'s', () => {
  const t = mineTerms(POOL, MINE, NOW);
  assert.equal(t.pointsPerProof, 20);
  assert.equal(t.proofsPerDay, 30);
  assert.equal(t.perProofWei, 200000000000000000n);      // 20 points × 0.01 TAC
  assert.equal(t.perDayWei, 6000000000000000000n);       // × 30 proofs
  assert.equal(t.until, '24 Nov');
});

test('the card says what pays in a line, what the address made today, and what it has been credited', () => {
  const tally = { day: 20757, over: false, pointsPerProof: 20, miners: [{ miner: ADDR.toLowerCase(), proofs: 2, points: 40 }, { miner: OTHER, proofs: 1, points: 20 }] };
  const l = mineLines(POOL, { ...MINE, account: { address: ADDR, creditedWei: '6200000000000000000' } }, { tally, address: ADDR, nowSec: NOW });
  assert.equal(l.pays, 'Up to 0.2 TAC a proof, 30 proofs a day, until 24 Nov');
  assert.equal(l.today, '2 proofs, 40 points today');
  assert.equal(l.credited, '6.2 TAC credited');
  // the tally lists addresses in lower case; the field takes them as a wallet shows them
  assert.equal(mineLines(POOL, MINE, { tally, address: ADDR.replace('abcdef', 'ABCDEF'), nowSec: NOW }).today, '2 proofs, 40 points today');
  assert.equal(mineLines(POOL, MINE, { tally, address: OTHER, nowSec: NOW }).today, '1 proof, 20 points today');
  assert.equal(mineLines(POOL, MINE, { tally, address: '0x' + '9'.repeat(40), nowSec: NOW }).today, 'No proofs yet today');
  // nothing is said about an address when none is given, or the tally could not be read
  assert.equal(mineLines(POOL, MINE, { tally, nowSec: NOW }).today, null);
  assert.equal(mineLines(POOL, MINE, { tally: null, address: ADDR, nowSec: NOW }).today, null);
  assert.equal(mineLines(POOL, MINE, { tally: { miners: 'x' }, address: ADDR, nowSec: NOW }).today, null);
  assert.equal(mineLines(POOL, MINE, { address: ADDR, nowSec: NOW }).credited, null, 'no account in the answer, nothing credited is said');
  assert.equal(mineLines(POOL, { ...MINE, account: { address: ADDR, creditedWei: '0' } }, { nowSec: NOW }).credited, '0 TAC credited');
});

test('the pool tallies by UTC day', () => {
  assert.equal(utcDay(Date.UTC(2026, 9, 31, 12)), 20757);
  assert.equal(utcDay(Date.UTC(2026, 9, 31, 23, 59, 59)), 20757);
  assert.equal(utcDay(Date.UTC(2026, 10, 1)), 20758);
});

test('a change of terms on the service changes the card', () => {
  const l = mineLines({ ...POOL, terms: { pointsPerProof: 10, proofsPerMinerDay: 12 } }, { ...MINE, terms: { ...MINE.terms, capWeiPerPoint: '50000000000000000' } }, { nowSec: NOW });
  assert.equal(l.pays, 'Up to 0.5 TAC a proof, 12 proofs a day, until 24 Nov');       // 10 × 0.05
});

test('nothing is promised when mining does not pay: off, ended, no terms today, or unreadable', () => {
  for (const mine of [
    null, undefined, {}, { enabled: false },
    { ...MINE, enabled: false },
    { ...MINE, terms: null },
    { ...MINE, terms: { fromDay: 20781, off: true } },
    { ...MINE, terms: { ...MINE.terms, capWeiPerPoint: '0' } },
    { ...MINE, endSec: NOW - 1 },
  ]) {
    assert.equal(mineTerms(POOL, mine, NOW), null, JSON.stringify(mine));
    assert.equal(mineLines(POOL, mine, { nowSec: NOW }).pays, null);
  }
  assert.equal(mineTerms(null, MINE, NOW), null, 'the pool\'s terms are what says how many points a proof earns');
  assert.equal(mineTerms({ terms: { pointsPerProof: 0 } }, MINE, NOW), null);
  // A pool that does not say the daily limit still gets the per-proof line.
  const l = mineLines({ terms: { pointsPerProof: 20 } }, MINE, { nowSec: NOW });
  assert.equal(l.pays, 'Up to 0.2 TAC a proof, until 24 Nov');
});
