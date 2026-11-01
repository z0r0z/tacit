#!/usr/bin/env node
// dapp/evm-trade-tile.js parseUnitsStr: the amount typed in the TAC trade tile is read the way the front page reads it. A lone comma is a decimal
// point (0,05 is a twentieth), a comma that plainly groups thousands is dropped, and an ambiguous 1,500 is left unread.
import assert from 'node:assert/strict';
import { parseUnitsStr } from '../dapp/evm-trade-tile.js';

const E = 10n ** 18n;
for (const [s, want] of [['0.05', E / 20n], ['0,05', E / 20n], ['1,5', (E * 3n) / 2n], ['1,500.25', 1500n * E + E / 4n], ['1,000,000', 1_000_000n * E], ['1_000', 1000n * E], ['.5', E / 2n], ['2', 2n * E]]) {
  assert.equal(parseUnitsStr(s), want, `${s} reads as ${want}`);
}
for (const s of ['1,500', '1,5,5', '1.500,50', '1,2.3', '', '.', 'abc', '1e18', '-1']) assert.equal(parseUnitsStr(s), null, `${JSON.stringify(s)} is left unread`);
assert.equal(parseUnitsStr('0,000000000000000001'), 1n, 'a decimal comma keeps every place');
console.log('  ok - amounts typed in the trade tile are read as the front page reads them');
console.log('evm-trade-units checks passed');
