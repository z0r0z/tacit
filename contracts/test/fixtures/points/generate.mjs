import { keccak_256 } from '@noble/hashes/sha3.js';
import { writeFileSync } from 'node:fs';
import { build, formatTac } from '../../../../tools/points-tree.mjs';
const mk = (n, seed) => Array.from({ length: n }, (_, i) => {
  const h = keccak_256(Buffer.from(`points-fixture-${seed}-${i}`));
  const address = '0x' + Buffer.from(h.slice(12)).toString('hex');
  const whole = 1n + (BigInt('0x' + Buffer.from(h.slice(0, 5)).toString('hex')) % 5_000n); // 1..5000 whole TAC
  return { address, cumulativeAmountWei: whole * 10n ** 18n };
});
for (const n of [1, 5, 260]) {
  const e = mk(n, n);
  const r = build(e);
  writeFileSync(new URL(`./tree-${n}.json`, import.meta.url), JSON.stringify(r, null, 2) + '\n');
  console.log(n, r.root, formatTac(r.totalWei));
}
