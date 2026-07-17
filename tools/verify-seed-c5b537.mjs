import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import { sha256 as nobleSha256 } from '../node_modules/@noble/hashes/sha2.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { makeScanReflectionIndexer } from '../dapp/confidential-reflection-scan-indexer.js';
import { SWAP_BATCH_VK } from '../dapp/confidential-swapbatch-vk.js';
import { readFileSync } from 'node:fs';

const sha256 = (b) => nobleSha256(b instanceof Uint8Array ? b : Uint8Array.from(b));
const deps = { secp, keccak256: keccak_256, sha256, swapBatchVk: SWAP_BATCH_VK };

const kv = JSON.parse(readFileSync('/Users/z/tacit-critical-backup/seed-rebuild/newseed-kv.json','utf8'));
const val = JSON.parse(kv['reflection:scan:mainnet']);
const snap = val.snapshot;
console.log('snapshot keys:', Object.keys(snap));
console.log('noteLeaves:', (snap.noteLeaves||[]).length, 'spentLinks:', (snap.spentLinks||[]).length, 'height:', snap.height);

const idx = makeScanReflectionIndexer(deps);
idx.load(snap);
const d = idx.digest();
const got = (d.startsWith('0x')?d:'0x'+d).toLowerCase();
console.log('digest got :', got);
console.log('digest want: 0x64b3ae2abd94812c8a139f93d7da049cfee12354a9116a01444d5a7c05fb3825 (seed @958151)');
console.log(got === '0x64b3ae2abd94812c8a139f93d7da049cfee12354a9116a01444d5a7c05fb3825' ? 'SEED MATCH ✓' : 'SEED MISMATCH ✗');
