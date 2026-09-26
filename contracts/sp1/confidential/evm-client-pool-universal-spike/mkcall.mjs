// mkcall.mjs <calldata.txt> <solidity signature> <out.hex> [tamperWordIndex]
// All verifyProof arguments are fixed-size uint/bytes32 arrays, so the ABI encoding is the selector
// followed by every word in order. Pulls the words out of `snarkjs zkey export soliditycalldata`.
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const [, , inFile, sig, outFile, tamper] = process.argv;
const words = readFileSync(inFile, 'utf8').match(/0x[0-9a-fA-F]+/g).map((w) => BigInt(w));
if (tamper !== undefined) words[+tamper] += 1n;
const sel = execFileSync('cast', ['sig', sig]).toString().trim();
const hex = sel + words.map((w) => w.toString(16).padStart(64, '0')).join('');
writeFileSync(outFile, hex);
console.log(`${outFile}: ${words.length} words, ${(hex.length - 2) / 2} B calldata`);
