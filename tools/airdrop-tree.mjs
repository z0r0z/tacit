#!/usr/bin/env node
// Merkle tree builder for contracts/src/TacAirdrop.sol.
//
//   node tools/airdrop-tree.mjs --input list.csv --expect-total 1000000 --out proofs.json
//
// Input  : JSON array of { address, amount } (or { address, amountWei }) or CSV lines `address,amount` (header optional).
//          `amount` is whole TAC by default (decimals allowed, up to 18 places); `--unit wei` reads it as base units.
// Output : proofs JSON { root, count, totalWei, unitScale, claims: { <lowercase address>: { index, address, amount, proof } } }
//          where `amount` is base units as a decimal string.
//
// Leaf : keccak256(keccak256(abi.encode(uint256 index, address account, uint256 amount)))
// Node : keccak256(min(a, b) ‖ max(a, b))
// Layout: the tree is one array of 2n-1 nodes with the leaves in reverse order at the end and node i's children at 2i+1 / 2i+2,
//         the same layout Solady's MerkleTreeLib builds, so the Solidity tests can rebuild any tree this tool emits.
// Index : addresses sorted ascending (as 20-byte numbers); index = position in that order.
//
// Every entry is checked before a root is produced: well-formed address (a mixed-case address must carry a valid checksum),
// no zero address, no duplicate (case-insensitive), no reserved contract address, amount > 0, amount a multiple of the pool unit
// scale (1e10 wei), pool value (amount / 1e10) within u64, and the total equal to --expect-total. Then every proof is recomputed
// against the root before anything is written.
//
// --out-dir <dir> additionally writes one file per recipient, <dir>/<lowercase address>.json = { root, index, address, amount, proof },
// plus <dir>/manifest.json = { root, count, totalWei, unitScale }, so a static host can serve a single small file per lookup.
//
// Other modes:
//   --verify-file proofs.json [--root 0x..]   recheck an existing proofs file (every proof, totals, index order, unit scale)

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { keccak_256 } from '@noble/hashes/sha3.js';

export const UNIT_SCALE = 10n ** 10n;
export const TAC_DECIMALS = 18;
const U64_MAX = (1n << 64n) - 1n;

const hex = (b) => '0x' + Buffer.from(b).toString('hex');
const unhex = (h) => Uint8Array.from(Buffer.from(String(h).replace(/^0x/, ''), 'hex'));
const cat = (...a) => Buffer.concat(a.map((x) => Buffer.from(x)));
const word = (v) => { const b = Buffer.alloc(32); let x = BigInt(v); for (let i = 31; i >= 0; i--) { b[i] = Number(x & 0xffn); x >>= 8n; } if (x) throw new Error('overflow'); return b; };

export function checksum(addr) {
  const a = addr.toLowerCase().replace(/^0x/, '');
  const h = Buffer.from(keccak_256(Buffer.from(a, 'ascii'))).toString('hex');
  let out = '0x';
  for (let i = 0; i < 40; i++) out += parseInt(h[i], 16) >= 8 ? a[i].toUpperCase() : a[i];
  return out;
}

export function normalizeAddress(s) {
  const t = String(s).trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(t)) throw new Error(`not an address: ${t}`);
  const body = t.slice(2);
  if (body !== body.toLowerCase() && body !== body.toUpperCase() && checksum(t) !== t) throw new Error(`bad checksum: ${t}`);
  return t.toLowerCase();
}

export function leafHash(index, address, amount) {
  const inner = keccak_256(cat(word(index), word(BigInt(address)), word(amount)));
  return keccak_256(inner);
}

const pairHash = (a, b) => keccak_256(Buffer.compare(Buffer.from(a), Buffer.from(b)) <= 0 ? cat(a, b) : cat(b, a));

// Build the node array from the ordered leaf hashes.
export function buildTree(leaves) {
  const n = leaves.length;
  if (n === 0) throw new Error('no leaves');
  const tree = new Array(2 * n - 1);
  for (let i = 0; i < n; i++) tree[2 * n - 2 - i] = leaves[i];
  for (let i = n - 2; i >= 0; i--) tree[i] = pairHash(tree[2 * i + 1], tree[2 * i + 2]);
  return tree;
}

export function proofFor(tree, position) {
  const n = (tree.length + 1) / 2;
  let i = 2 * n - 2 - position;
  const proof = [];
  while (i > 0) {
    proof.push(tree[i % 2 === 1 ? i + 1 : i - 1]);
    i = (i - 1) >> 1;
  }
  return proof;
}

export function verifyProof(proof, root, leaf) {
  let h = Buffer.from(leaf);
  for (const p of proof) h = Buffer.from(pairHash(h, unhex(p)));
  return hex(h) === String(root).toLowerCase();
}

// "12.5" TAC -> 12500000000000000000n (exact; rejects more than 18 decimal places).
export function parseTac(s) {
  const m = /^(\d+)(?:\.(\d{1,18}))?$/.exec(String(s).trim());
  if (!m) throw new Error(`bad amount: ${s}`);
  return BigInt(m[1]) * 10n ** 18n + BigInt((m[2] || '').padEnd(18, '0') || '0');
}
export const parseWei = (s) => {
  if (!/^\d+$/.test(String(s).trim())) throw new Error(`bad base-unit amount: ${s}`);
  return BigInt(String(s).trim());
};
export const formatTac = (wei) => {
  const w = BigInt(wei);
  const frac = (w % 10n ** 18n).toString().padStart(18, '0').replace(/0+$/, '');
  return (w / 10n ** 18n).toString() + (frac ? '.' + frac : '');
};

// entries: [{ address, amountWei: bigint }]; opts.reserved: lowercase addresses no recipient may be.
// Throws with every problem listed rather than stopping at the first.
export function build(entries, { expectTotalWei, reserved = [] } = {}) {
  const problems = [];
  const seen = new Map();
  const rows = [];
  const bad = new Set(reserved.map((a) => a.toLowerCase()));
  entries.forEach((e, i) => {
    const where = `entry ${i + 1}`;
    let addr;
    try { addr = normalizeAddress(e.address); } catch (err) { problems.push(`${where}: ${err.message}`); return; }
    if (BigInt(addr) === 0n) problems.push(`${where}: zero address`);
    if (bad.has(addr)) problems.push(`${where}: ${addr} is a reserved contract address`);
    if (seen.has(addr)) problems.push(`${where}: duplicate of entry ${seen.get(addr) + 1} (${addr})`);
    else seen.set(addr, i);
    const amt = e.amountWei;
    if (typeof amt !== 'bigint' || amt <= 0n) problems.push(`${where}: amount must be positive (${addr})`);
    else if (amt % UNIT_SCALE !== 0n) problems.push(`${where}: amount ${amt} is not a multiple of ${UNIT_SCALE} wei (${addr})`);
    else if (amt / UNIT_SCALE > U64_MAX) problems.push(`${where}: pool value exceeds u64 (${addr})`);
    rows.push({ address: addr, amountWei: amt });
  });
  if (!rows.length) problems.push('no entries');
  const total = rows.reduce((s, r) => s + (typeof r.amountWei === 'bigint' ? r.amountWei : 0n), 0n);
  if (expectTotalWei === undefined) problems.push('an expected total is required (--expect-total)');
  else if (total !== expectTotalWei) problems.push(`total ${formatTac(total)} TAC (${total} wei) differs from the expected ${formatTac(expectTotalWei)} TAC (${expectTotalWei} wei)`);
  if (problems.length) { const e = new Error(problems.length + ' problem(s):\n  ' + problems.join('\n  ')); e.problems = problems; throw e; }

  rows.sort((a, b) => (BigInt(a.address) < BigInt(b.address) ? -1 : 1));
  const leaves = rows.map((r, i) => leafHash(i, r.address, r.amountWei));
  const tree = buildTree(leaves);
  const root = hex(tree[0]);
  const claims = {};
  rows.forEach((r, i) => {
    claims[r.address] = { index: i, address: checksum(r.address), amount: r.amountWei.toString(), proof: proofFor(tree, i).map(hex) };
  });
  const out = { root, count: rows.length, totalWei: total.toString(), unitScale: UNIT_SCALE.toString(), claims };
  verifyFile(out); // never emit a file that does not check out
  return out;
}

// Recompute every proof of a proofs file. Returns { ok, errors }.
export function verifyFile(file, { root } = {}) {
  const errors = [];
  const want = (root || file.root || '').toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(want)) errors.push('missing or malformed root');
  if (root && file.root && root.toLowerCase() !== file.root.toLowerCase()) errors.push(`file root ${file.root} differs from expected ${root}`);
  const list = Object.entries(file.claims || {});
  let total = 0n;
  const idxSeen = new Set();
  let prev = -1n;
  const byIndex = list.slice().sort((a, b) => a[1].index - b[1].index);
  for (const [key, c] of byIndex) {
    try {
      const addr = normalizeAddress(c.address);
      if (addr !== key) errors.push(`key ${key} does not match its address ${c.address}`);
      if (BigInt(addr) === 0n) errors.push(`zero address at index ${c.index}`);
      if (BigInt(addr) <= prev) errors.push(`indexes are not in ascending address order at ${addr}`);
      prev = BigInt(addr);
      if (idxSeen.has(c.index)) errors.push(`duplicate index ${c.index}`);
      idxSeen.add(c.index);
      const amt = BigInt(c.amount);
      if (amt <= 0n || amt % UNIT_SCALE !== 0n) errors.push(`bad amount at index ${c.index}: ${c.amount}`);
      total += amt;
      if (!verifyProof(c.proof, want, leafHash(c.index, addr, amt))) errors.push(`proof fails for index ${c.index} (${addr})`);
    } catch (e) { errors.push(`index ${c.index}: ${e.message}`); }
  }
  for (let i = 0; i < list.length; i++) if (!idxSeen.has(i)) errors.push(`index ${i} missing (indexes must be 0..count-1)`);
  // Completeness: rebuild the whole tree from the listed leaves and require the same root. A root that also commits to leaves
  // the file does not list still verifies each listed proof, so only this comparison shows there are none.
  if (!errors.length && list.length) {
    const ordered = new Array(list.length);
    for (const [, c] of list) ordered[c.index] = leafHash(c.index, normalizeAddress(c.address), BigInt(c.amount));
    if (hex(buildTree(ordered)[0]) !== want) errors.push('the root does not equal the tree rebuilt from the listed claims: the root commits to leaves that are not listed');
  }
  if (file.count !== undefined && file.count !== list.length) errors.push(`count ${file.count} but ${list.length} claims`);
  if (file.totalWei !== undefined && BigInt(file.totalWei) !== total) errors.push(`totalWei ${file.totalWei} but claims sum to ${total}`);
  if (errors.length) { const e = new Error(errors.length + ' verification error(s):\n  ' + errors.slice(0, 20).join('\n  ')); e.errors = errors; throw e; }
  return { ok: true, count: list.length, totalWei: total };
}

export function parseInput(text, unit = 'tac') {
  const t = text.trim();
  const parse = unit === 'wei' ? parseWei : parseTac;
  let rows;
  if (t.startsWith('[') || t.startsWith('{')) {
    let j = JSON.parse(t);
    if (!Array.isArray(j)) j = j.entries || j.claims || j.recipients;
    if (!Array.isArray(j)) throw new Error('JSON input must be an array of { address, amount }');
    rows = j.map((r, i) => {
      if (r.amountWei !== undefined) {
        if (typeof r.amountWei !== 'string') throw new Error(`entry ${i + 1}: amountWei must be a string (a JSON number loses precision)`);
        return { address: r.address, amountWei: parseWei(r.amountWei) };
      }
      if (r.amount === undefined) throw new Error(`entry ${i + 1}: missing amount`);
      if (typeof r.amount !== 'string') throw new Error(`entry ${i + 1}: amount must be a string (a JSON number loses precision)`);
      return { address: r.address, amountWei: parse(r.amount) };
    });
  } else {
    rows = [];
    t.split(/\r?\n/).forEach((line, i) => {
      const l = line.trim();
      if (!l || l.startsWith('#')) return;
      const [a, b, ...rest] = l.split(',').map((s) => s.trim());
      if (i === 0 && !/^0x/i.test(a)) return; // header
      if (b === undefined || rest.length) throw new Error(`line ${i + 1}: expected address,amount`);
      rows.push({ address: a, amountWei: parse(b) });
    });
  }
  return rows;
}

// ── CLI ──
function arg(name, args) { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; }

async function main() {
  const args = process.argv.slice(2);
  const fail = (m) => { console.error('airdrop-tree: ' + m); process.exit(1); };
  const vf = arg('--verify-file', args);
  if (vf) {
    try {
      const r = verifyFile(JSON.parse(readFileSync(vf, 'utf8')), { root: arg('--root', args) });
      console.log(`ok: ${r.count} claims, total ${formatTac(r.totalWei)} TAC, every proof recomputes to the root`);
    } catch (e) { fail(e.message); }
    return;
  }
  const input = arg('--input', args);
  if (!input || args.includes('--help')) fail('usage: --input <list.json|list.csv> --expect-total <TAC> [--unit tac|wei] [--reserve 0x..,0x..] [--out proofs.json] [--out-dir dir]');
  const unit = arg('--unit', args) || 'tac';
  if (unit !== 'tac' && unit !== 'wei') fail('--unit must be tac or wei');
  const et = arg('--expect-total', args);
  const expectTotalWei = et === undefined ? undefined : (unit === 'wei' ? parseWei(et) : parseTac(et));
  // No protocol contract, the token, the pool, the ops multisig or the burn addresses can be a recipient: TAC sent to a contract that
  // cannot move it is lost. More can be added with --reserve (for example the airdrop's own address).
  const reserved = ['0x000000000000000000000000000000000000dead'];
  const dep = fileURLToPath(new URL('../contracts/deployments/1.json', import.meta.url));
  if (!existsSync(dep)) fail(`cannot read ${dep}: the reserved contract list must be enforced`);
  const d = JSON.parse(readFileSync(dep, 'utf8'));
  for (const v of Object.values(d)) if (typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v)) reserved.push(v.toLowerCase());
  if (!reserved.includes(String(d.tacToken || '').toLowerCase()) || !reserved.includes(String(d.pool || '').toLowerCase())) fail('deployments/1.json has no tacToken or pool address');
  for (const a of (arg('--reserve', args) || '').split(',').filter(Boolean)) reserved.push(normalizeAddress(a));
  let result;
  try { result = build(parseInput(readFileSync(input, 'utf8'), unit), { expectTotalWei, reserved }); }
  catch (e) { fail(e.message); }
  const out = arg('--out', args);
  if (out) writeFileSync(out, JSON.stringify(result, null, 2) + '\n');
  const outDir = arg('--out-dir', args);
  if (outDir) {
    mkdirSync(outDir, { recursive: true });
    for (const [a, c] of Object.entries(result.claims)) writeFileSync(`${outDir}/${a}.json`, JSON.stringify({ root: result.root, ...c }) + '\n');
    writeFileSync(`${outDir}/manifest.json`, JSON.stringify({ root: result.root, count: result.count, totalWei: result.totalWei, unitScale: result.unitScale }, null, 2) + '\n');
  }
  console.log(`root        ${result.root}`);
  console.log(`recipients  ${result.count}`);
  console.log(`total       ${formatTac(result.totalWei)} TAC (${result.totalWei} wei)`);
  console.log(`verified    every proof recomputes to the root`);
  if (out) console.log(`written     ${out}`);
  if (outDir) console.log(`written     ${outDir}/ (${result.count} files + manifest.json)`);
  if (!out && !outDir) console.log('(no --out / --out-dir: nothing written)');
}

if (import.meta.url === `file://${process.argv[1]}`) main();
