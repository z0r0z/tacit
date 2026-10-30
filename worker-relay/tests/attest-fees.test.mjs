// What the relay wallet must hold to send an attest: what the node checks (gas limit x fee cap), not twice the base fee.
// node --test tests/attest-fees.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { attestFundsNeed, ATTEST_CAP_PCT } from '../src/lib/attest-fees.js';

const G = 1_000_000_000n;

test('the need is the gas limit at 1.35x the base fee plus the tip', () => {
  // 700k gas at a 0.70 gwei base fee and a 10 wei tip
  assert.equal(attestFundsNeed({ gas: 700_000n, base: 700_000_000n, tip: 10n }), 700_000n * (945_000_000n + 10n));
  assert.equal(ATTEST_CAP_PCT, 135n);
});

test('it is over what viem sends (1.2x the base fee), so a wallet that passes can send, and well under the old twice', () => {
  const gas = 498_252n, base = 650_000_000n, tip = 10n;
  const sends = gas * ((base * 120n) / 100n + tip);
  const need = attestFundsNeed({ gas, base, tip });
  assert.ok(need > sends, 'a wallet that passes the check can send');
  assert.ok(need < gas * (2n * base + tip) * 75n / 100n, 'and it asks for under three quarters of what the old check asked');
});

test('the real attest of 2026-10-30: 394k gas used at a 0.70 gwei base fee cost 0.00028 ETH; the wallet it needed held 0.0009', () => {
  const need = attestFundsNeed({ gas: (394_305n * 125n) / 100n, base: 650_000_000n, tip: 10n });
  assert.ok(need < 450_000_000_000_000n, 'about 0.00043 ETH for the padded limit');
  assert.ok(need < 900_000_000_000_000n, 'so 0.0009 ETH was enough, where the old check asked for 0.0010');
});

test('numbers and bigints both read', () => {
  assert.equal(attestFundsNeed({ gas: 700000, base: 1e9, tip: 0 }), 700_000n * 1_350_000_000n);
});
