#!/usr/bin/env node
// node tools/nudger/verify-input.mjs --out DIR --n N
//
// Writes DIR/verify-<N>.txt, what the verifier reads for commit N: where the snapshot is, the commit message and diff exactly as the reviewer saw them, and the
// reviewer's findings numbered F1, F2, ... from DIR/findings-<N>.json. Prints the path, or nothing and exits 3 when the reviewer raised nothing.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? undefined : process.argv[i + 1]; };
const out = arg('out'), n = Number(arg('n'));
if (!out || !Number.isInteger(n) || n < 1) { console.error('usage: verify-input.mjs --out DIR --n N'); process.exit(2); }
let findings = [];
try { findings = JSON.parse(readFileSync(`${out}/findings-${n}.json`, 'utf8')).findings; } catch { /* no reply */ }
findings = (Array.isArray(findings) ? findings : []).filter((f) => f && typeof f.why === 'string' && f.why.trim());
if (!findings.length) process.exit(3);
const review = readFileSync(`${out}/review-${n}.txt`, 'utf8');
const lines = findings.map((f, i) => `F${i + 1} (${f.file || '?'}:${Number.isInteger(f.line) ? f.line : '?'}): ${f.why.replace(/\s+/g, ' ').trim()}`);
writeFileSync(`${out}/verify-${n}.txt`, `Snapshot root: ${resolve(out, 'snap', String(n))}\n\n${review}\nFindings to try to refute:\n${lines.join('\n')}\n`);
console.log(`${out}/verify-${n}.txt`);
