// Decisive test: is the b60a7940-vs-c54cebed divergence purely a Mode-B accumulator setting,
// or a block-level fold difference? Load the reconstructed 958344 snapshot, vary ONLY the
// Mode-B accumulators (consumedCount, foldedCrossoutCount, ethReflDigest, consumedCrossoutLinks),
// recompute the digest each way. If any combo == c54cebed → head is a pure accumulator patch.
import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import { sha256 as nobleSha256 } from '../node_modules/@noble/hashes/sha2.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { makeScanReflectionIndexer } from '../dapp/confidential-reflection-scan-indexer.js';
import { SWAP_BATCH_VK } from '../dapp/confidential-swapbatch-vk.js';
import { readFileSync } from 'node:fs';

const sha256 = (b) => nobleSha256(b instanceof Uint8Array ? b : Uint8Array.from(b));
const deps = { secp, keccak256: keccak_256, sha256, swapBatchVk: SWAP_BATCH_VK };
const TARGET = '0xc54cebeda7022277bb405288308e6f81f83f2add96ec2052f9a8ca75bdc96ebb'.toLowerCase();
const S = '/private/tmp/claude-501/-Users-z-tacit/218e951b-c019-470f-a2bb-2d938e3c5ef4/scratchpad/modeb-kv.json';

const raw = JSON.parse(readFileSync(S, 'utf8'))['reflection:scan:mainnet'];
const kv = typeof raw === 'string' ? JSON.parse(raw) : raw;
const baseSnap = kv.snapshot;
const ZERO = '0x' + '0'.repeat(64);
const ETH0 = baseSnap.ethReflDigest;                              // b810d091…
const link = ['0xaf9445828765e1ce0405f98e7a2f55bf816e8b90487283b24a54ab5023afae0a', ZERO]; // the crossout nu

function digestOf(over) {
  const snap = JSON.parse(JSON.stringify(baseSnap));
  Object.assign(snap, over);
  const idx = makeScanReflectionIndexer({ ...deps, swapBatchVk: SWAP_BATCH_VK });
  idx.load(snap);
  return String(idx.digest()).toLowerCase();
}

console.log('target:', TARGET);
console.log('base   :', digestOf({}), '(unchanged)');
let found = null;
for (const cc of [0, 1, 2]) {
  for (const fc of [0, 1, 2]) {
    for (const eth of [ETH0, ZERO]) {
      for (const links of [baseSnap.consumedCrossoutLinks, [], [link], [[ZERO, ZERO]]]) {
        const d = digestOf({ consumedCount: String(cc), foldedCrossoutCount: String(fc), ethReflDigest: eth, consumedCrossoutLinks: links });
        if (d === TARGET) { found = { cc, fc, eth, links }; console.log('✅ MATCH:', JSON.stringify(found)); }
      }
    }
  }
}
if (!found) console.log('❌ no accumulator combo reproduces c54cebed → the divergence is BLOCK-LEVEL (fold differs), not a simple accumulator patch.');
