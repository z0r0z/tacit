// The amount parsers of /pay, /pay/eth and /tac read a decimal comma as a decimal point, a thousands comma as nothing, and
// refuse a lone comma before three digits (1,500) rather than guess. The pages must agree.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const DAPP = new URL('../dapp/', import.meta.url);
const pull = (page, name) => {
  const src = readFileSync(new URL(page, DAPP), 'utf8');
  const m = new RegExp(`function ${name}\\(s, dec = \\d+\\) \\{[\\s\\S]*?\\n\\}`).exec(src);
  assert.ok(m, `${page} defines ${name}`);
  return m[0];
};
const hub = eval(`(${pull('pay/index.html', 'parseAmount')})`);
const eth = eval(`(${pull('pay/eth/index.html', 'parseUnits')})`);
const tac = eval(`(${pull('tac/app.js', 'parseAmount')})`);

// [text, decimals, wanted (null: not an amount)]
const CASES = [
  ['0.001', 8, 100000n], ['.5', 8, 50000000n], ['1.', 8, 100000000n], ['1', 8, 100000000n],
  ['0,001', 8, 100000n], ['0,5', 8, 50000000n], ['1,5', 8, 150000000n], ['12,5', 8, 1250000000n], ['10,50', 8, 1050000000n],
  ['1,234.5', 8, 123450000000n], ['1,000,000', 8, 100000000000000n], ['1,000.', 8, 100000000000n],
  ['1,500', 8, null], ['1,2,3', 8, null], ['1,23,456', 8, null],
  ['', 8, null], ['.', 8, null], ['abc', 8, null], ['-1', 8, null], ['0.123456789', 8, null],
];
for (const [text, dec, want] of CASES) {
  assert.equal(hub(text, dec), want, `hub ${JSON.stringify(text)}`);
  assert.equal(eth(text, dec), want, `eth ${JSON.stringify(text)}`);
  assert.equal(tac(text, dec), want, `tac ${JSON.stringify(text)}`);
}
// Eighteen decimals, as the ETH page uses them.
assert.equal(hub('0,001', 18), 10n ** 15n);
assert.equal(eth('0,001', 18), 10n ** 15n);
console.log(`ok: ${CASES.length + 2} amounts parse the same on /pay, /pay/eth and /tac`);
