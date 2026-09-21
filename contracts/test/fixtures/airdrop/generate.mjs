import { keccak_256 } from '@noble/hashes/sha3.js';
import { writeFileSync } from 'node:fs';
import { build, formatTac } from '../../../../tools/airdrop-tree.mjs';
const mk = (n, seed) => Array.from({ length: n }, (_, i) => {
  const h = keccak_256(Buffer.from(`airdrop-fixture-${seed}-${i}`));
  const address = '0x' + Buffer.from(h.slice(12)).toString('hex');
  const units = 1n + (BigInt('0x' + Buffer.from(h.slice(0, 5)).toString('hex')) % 5_000_000_000n); // 8-dp value units
  return { address, amountWei: units * 10n ** 10n };
});
for (const n of [1, 5, 260]) {
  const e = mk(n, n);
  const tot = e.reduce((s, r) => s + r.amountWei, 0n);
  const r = build(e, { expectTotalWei: tot });
  writeFileSync(new URL(`./tree-${n}.json`, import.meta.url), JSON.stringify(r, null, 2) + '\n');
  console.log(n, r.root, formatTac(tot));
}
