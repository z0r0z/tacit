// Airdrop / snapshot helper tests.
//
// Covers:
//   - leaf hash domain separation + binding to (addr, amount, index)
//   - merkle root determinism
//   - proof generation + verification (positive + negative paths)
//   - odd-leaf-count handling (orphan promotion)
//   - CSV parser: header detection, comments, separators, validation
//   - computeAirdropCommitment: total, duplicates
//
// Run: `node airdrop.test.mjs`
import { hexToBytes, bytesToHex, concatBytes } from '@noble/hashes/utils';
import { sha256 } from '@noble/hashes/sha256';
import {
  AIRDROP_LEAF_TAG, AIRDROP_NODE_TAG,
  airdropLeafHash, buildAirdropMerkle, airdropMerkleProof, verifyAirdropMerkleProof,
  parseAirdropCSV, computeAirdropCommitment,
  truncateAmountDecimals, mergeAirdropRows, parseBlacklist,
  buildAirdropClaimMsg, eip191Hash, recoverEthAddrFromSig, verifyAirdropClaimSig,
  _signEip191WithPriv, _ethAddrFromPriv,
} from './composition.mjs';
import * as secp from '@noble/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';

let pass = 0, fail = 0;
function test(label, fn) {
  try {
    const ok = fn();
    if (ok) { console.log(`  PASS  ${label}`); pass++; }
    else    { console.log(`  FAIL  ${label}`); fail++; }
  } catch (e) {
    console.log(`  THROW ${label} — ${e.message}`);
    fail++;
  }
}
const bytesEq = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

// Synthetic snapshot fixtures
const A = hexToBytes('1111111111111111111111111111111111111111');
const B = hexToBytes('2222222222222222222222222222222222222222');
const C = hexToBytes('3333333333333333333333333333333333333333');
const D = hexToBytes('4444444444444444444444444444444444444444');
const E = hexToBytes('5555555555555555555555555555555555555555');

console.log('Leaf hashing:');

test('leaf hash is deterministic for same inputs', () => {
  const a = airdropLeafHash(A, 100n, 0);
  const b = airdropLeafHash(A, 100n, 0);
  return bytesEq(a, b);
});

test('leaf hash differs on address change', () => {
  return !bytesEq(airdropLeafHash(A, 100n, 0), airdropLeafHash(B, 100n, 0));
});

test('leaf hash differs on amount change', () => {
  return !bytesEq(airdropLeafHash(A, 100n, 0), airdropLeafHash(A, 101n, 0));
});

test('leaf hash differs on index change (binds same-(addr,amt) entries)', () => {
  return !bytesEq(airdropLeafHash(A, 100n, 0), airdropLeafHash(A, 100n, 1));
});

test('leaf hash matches the canonical SHA256 wire spec', () => {
  // Pin: any change to the encoding breaks every published merkle root.
  const amtLE = new Uint8Array(8); new DataView(amtLE.buffer).setBigUint64(0, 12345n, true);
  const idxLE = new Uint8Array(4); new DataView(idxLE.buffer).setUint32(0, 7, true);
  const expected = sha256(concatBytes(
    new TextEncoder().encode(AIRDROP_LEAF_TAG),
    A, amtLE, idxLE,
  ));
  return bytesEq(airdropLeafHash(A, 12345n, 7), expected);
});

test('leaf hash rejects amount >= 2^64', () => {
  try { airdropLeafHash(A, 1n << 64n, 0); return false; } catch { return true; }
});

test('leaf hash rejects malformed eth_address', () => {
  try { airdropLeafHash(new Uint8Array(19), 0n, 0); return false; } catch { return true; }
});

console.log('\nMerkle tree:');

function leavesOf(rows) {
  return rows.map(([addr, amt, idx]) => airdropLeafHash(addr, amt, idx));
}

test('single-leaf tree: root = leaf', () => {
  const leaves = leavesOf([[A, 100n, 0]]);
  const { root } = buildAirdropMerkle(leaves);
  return bytesEq(root, leaves[0]);
});

test('two-leaf tree: root depends on both leaves', () => {
  const ls = leavesOf([[A, 100n, 0], [B, 200n, 1]]);
  const { root: r1 } = buildAirdropMerkle(ls);
  const ls2 = leavesOf([[A, 100n, 0], [C, 200n, 1]]);
  const { root: r2 } = buildAirdropMerkle(ls2);
  return !bytesEq(r1, r2);
});

test('sort-pair determinism: order of siblings within a pair does NOT change root', () => {
  // Internal property: _airdropNodeHash(a,b) == _airdropNodeHash(b,a). This
  // is what makes proofs positionless. Since buildAirdropMerkle preserves
  // input order, we test the property by feeding swapped sibling pairs.
  const l1 = airdropLeafHash(A, 1n, 0);
  const l2 = airdropLeafHash(B, 2n, 1);
  const { root: r1 } = buildAirdropMerkle([l1, l2]);
  const { root: r2 } = buildAirdropMerkle([l2, l1]);
  return bytesEq(r1, r2);
});

test('odd-leaf count: orphan promoted unchanged', () => {
  // 3 leaves: layer0 has 3, layer1 has 2 (pair[0,1] + orphan[2]), layer2 has 1.
  const ls = leavesOf([[A, 1n, 0], [B, 2n, 1], [C, 3n, 2]]);
  const { layers } = buildAirdropMerkle(ls);
  return layers.length === 3 && layers[0].length === 3 && layers[1].length === 2 && layers[2].length === 1;
});

test('proof for each leaf verifies (8 leaves)', () => {
  const rows = [];
  for (let i = 0; i < 8; i++) rows.push([new Uint8Array(20).fill(i + 1), BigInt(i * 100 + 1), i]);
  const ls = leavesOf(rows);
  const { root, layers } = buildAirdropMerkle(ls);
  for (let i = 0; i < 8; i++) {
    const proof = airdropMerkleProof(layers, i);
    if (!verifyAirdropMerkleProof(ls[i], proof, root)) return false;
  }
  return true;
});

test('proof for each leaf verifies (odd count: 5 leaves)', () => {
  const rows = [[A, 1n, 0], [B, 2n, 1], [C, 3n, 2], [D, 4n, 3], [E, 5n, 4]];
  const ls = leavesOf(rows);
  const { root, layers } = buildAirdropMerkle(ls);
  for (let i = 0; i < 5; i++) {
    const proof = airdropMerkleProof(layers, i);
    if (!verifyAirdropMerkleProof(ls[i], proof, root)) {
      console.log(`    leaf ${i} proof failed`); return false;
    }
  }
  return true;
});

test('verify rejects wrong leaf for valid proof', () => {
  const rows = [[A, 1n, 0], [B, 2n, 1], [C, 3n, 2], [D, 4n, 3]];
  const ls = leavesOf(rows);
  const { root, layers } = buildAirdropMerkle(ls);
  const proof = airdropMerkleProof(layers, 0);
  // Use leaf-1's hash with leaf-0's proof — must reject.
  return !verifyAirdropMerkleProof(ls[1], proof, root);
});

test('verify rejects valid leaf+proof against wrong root', () => {
  const rows = [[A, 1n, 0], [B, 2n, 1]];
  const ls = leavesOf(rows);
  const { layers } = buildAirdropMerkle(ls);
  const proof = airdropMerkleProof(layers, 0);
  const fakeRoot = sha256(new Uint8Array([0xff]));
  return !verifyAirdropMerkleProof(ls[0], proof, fakeRoot);
});

test('verify rejects tampered sibling in proof', () => {
  const rows = [[A, 1n, 0], [B, 2n, 1], [C, 3n, 2], [D, 4n, 3]];
  const ls = leavesOf(rows);
  const { root, layers } = buildAirdropMerkle(ls);
  const proof = airdropMerkleProof(layers, 1);
  // Flip a bit in the first sibling
  const tampered = proof.map(s => s.slice());
  tampered[0][0] ^= 1;
  return !verifyAirdropMerkleProof(ls[1], tampered, root);
});

test('verify rejects extra (forged) sibling appended to proof', () => {
  const rows = [[A, 1n, 0], [B, 2n, 1]];
  const ls = leavesOf(rows);
  const { root, layers } = buildAirdropMerkle(ls);
  const proof = airdropMerkleProof(layers, 0);
  proof.push(sha256(new Uint8Array([0xab])));
  return !verifyAirdropMerkleProof(ls[0], proof, root);
});

console.log('\nCSV parser:');

test('CSV: minimal two-row, comma-separated, no header', () => {
  const csv = `0x${'1'.repeat(40)},100\n0x${'2'.repeat(40)},200\n`;
  const rows = parseAirdropCSV(csv);
  return rows.length === 2 && rows[0].amount === 100n && rows[1].index === 1;
});

test('CSV: with header row (auto-detected and skipped)', () => {
  const csv = `address,balance\n0x${'1'.repeat(40)},100\n0x${'2'.repeat(40)},200\n`;
  const rows = parseAirdropCSV(csv);
  return rows.length === 2 && rows[0].index === 0;
});

test('CSV: tab-separated', () => {
  const csv = `0x${'1'.repeat(40)}\t100\n0x${'2'.repeat(40)}\t200\n`;
  const rows = parseAirdropCSV(csv);
  return rows.length === 2;
});

test('CSV: comments and blank lines skipped', () => {
  const csv = `# snapshot of TAC at block 19000000\n\n0x${'1'.repeat(40)},100\n// inline note\n0x${'2'.repeat(40)},200\n\n`;
  const rows = parseAirdropCSV(csv);
  return rows.length === 2;
});

test('CSV: underscore separators in amounts', () => {
  const csv = `0x${'1'.repeat(40)},1_000_000\n`;
  const rows = parseAirdropCSV(csv);
  return rows.length === 1 && rows[0].amount === 1000000n;
});

test('CSV: rejects decimal amounts (must be base units)', () => {
  const csv = `0x${'1'.repeat(40)},1.5\n`;
  try { parseAirdropCSV(csv); return false; } catch { return true; }
});

test('CSV: rejects amount overflow', () => {
  const csv = `0x${'1'.repeat(40)},${(1n << 64n).toString()}\n`;
  try { parseAirdropCSV(csv); return false; } catch { return true; }
});

test('CSV: rejects malformed address', () => {
  const csv = `0xZZZZ${'1'.repeat(36)},100\n`;
  try { parseAirdropCSV(csv); return false; } catch { return true; }
});

test('CSV: rejects single-column rows', () => {
  const csv = `0x${'1'.repeat(40)}\n`;
  try { parseAirdropCSV(csv); return false; } catch { return true; }
});

test('CSV: lowercases addresses', () => {
  const csv = `0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA,100\n`;
  const rows = parseAirdropCSV(csv);
  return rows[0].ethAddrHex === 'a'.repeat(40);
});

console.log('\nCommitment computation:');

test('computeAirdropCommitment: total + count + root match expected', () => {
  const csv = `0x${'1'.repeat(40)},100\n0x${'2'.repeat(40)},200\n0x${'3'.repeat(40)},300\n`;
  const rows = parseAirdropCSV(csv);
  const commit = computeAirdropCommitment(rows);
  if (commit.count !== 3) return false;
  if (commit.total !== 600n) return false;
  if (commit.root.length !== 32) return false;
  if (commit.duplicates.length !== 0) return false;
  // Each row's leaf survives in the result
  for (let i = 0; i < 3; i++) {
    if (!bytesEq(commit.rows[i].leaf, airdropLeafHash(rows[i].ethAddrBytes, rows[i].amount, i))) return false;
  }
  return true;
});

test('computeAirdropCommitment: detects duplicate addresses', () => {
  const csv = `0x${'1'.repeat(40)},100\n0x${'1'.repeat(40)},200\n`;
  const rows = parseAirdropCSV(csv);
  const commit = computeAirdropCommitment(rows);
  // Duplicates surfaced — but the commitment still computes (issuer decides how to handle).
  return commit.duplicates.length === 1 && commit.duplicates[0].indexes[0] === 0 && commit.duplicates[0].indexes[1] === 1;
});

test('end-to-end: parse → commit → prove → verify per row', () => {
  // A claim portal's whole job is row-by-row: given row i, look up amount,
  // compute leaf, produce proof, hand to claim handler, verify against root.
  const csv = `address,balance\n` +
    Array.from({ length: 17 }, (_, i) => `0x${(i + 1).toString(16).padStart(40, '0')},${(i + 1) * 1000}`).join('\n');
  const rows = parseAirdropCSV(csv);
  const commit = computeAirdropCommitment(rows);
  for (let i = 0; i < rows.length; i++) {
    const proof = airdropMerkleProof(commit.layers, i);
    if (!verifyAirdropMerkleProof(commit.rows[i].leaf, proof, commit.root)) return false;
  }
  return true;
});

console.log('\nDecimal truncation:');

test('truncate 18→8 yields the right base-unit count', () => {
  const src = 1234567890123456789n;
  const dst = truncateAmountDecimals(src, 18, 8);
  return dst === 123456789n;
});

test('truncate 18→8 floors a holder of "1.5" ERC-20', () => {
  // 1.5 in 18 decimals = 1500000000000000000
  // → 8 decimals: 150000000 (= 1.5 in 8-decimal display)
  const src = 1500000000000000000n;
  return truncateAmountDecimals(src, 18, 8) === 150000000n;
});

test('truncate 18→8 produces 0 for a sub-1e-8 holder', () => {
  // 0.00000000123 ETH = 1230000000n in 18-decimal base units (1.23 * 10^9)
  // 8-decimal smallest unit is 10^10 / 10^18 of an ETH = 10^-8 ETH.
  // 1.23 * 10^-9 < 10^-8 → truncates to 0.
  const src = 1230000000n;  // 1.23e9 source base units = 1.23e-9 ETH
  return truncateAmountDecimals(src, 18, 8) === 0n;
});

test('truncate 6→8 scales up (no precision lost)', () => {
  // USDC has 6 decimals. 100 USDC = 100000000 (6-dec base units).
  // → 8 decimals: 100 * 10^8 = 10000000000.
  return truncateAmountDecimals(100000000n, 6, 8) === 10000000000n;
});

test('truncate same→same is identity', () => {
  return truncateAmountDecimals(123456789n, 8, 8) === 123456789n;
});

console.log('\nEtherscan CSV format:');

const ETHERSCAN_SAMPLE = `"HolderAddress","Balance","PendingBalanceUpdate"
"0x0000000000000000000000000000000000000001","100.0","No"
"0x0000000000000000000000000000000000000002","1234.567890123456789","No"
"0x0000000000000000000000000000000000000003","0.000000005","No"
`;

test('Etherscan CSV: header skipped, decimal balances parsed', () => {
  const rows = parseAirdropCSV(ETHERSCAN_SAMPLE, { sourceDecimals: 18, targetDecimals: 8 });
  // Row 1: "100.0" → 100 * 10^8 = 10000000000
  // Row 2: "1234.567890123456789" 18-dec → 1234567890123456789 (18-dec), /10^10 → 123456789012 (8-dec)
  // Row 3: "0.000000005" 18-dec = 5000000000 → /10^10 → 0 → DROPPED
  return rows.length === 2
      && rows[0].amount === 10000000000n
      && rows[1].amount === 123456789012n;
});

test('Etherscan CSV: drops sub-precision holders silently (count reduced)', () => {
  const rows = parseAirdropCSV(ETHERSCAN_SAMPLE, { sourceDecimals: 18, targetDecimals: 8 });
  for (const r of rows) {
    if (r.amount === 0n) return false;
  }
  return true;
});

test('Etherscan CSV: tolerates quoted cells with internal commas', () => {
  // Hypothetical (real Etherscan exports don't include thousands commas, but
  // some hand-edited CSVs do). Quoted cells preserve internal commas.
  const csv = `"HolderAddress","Balance"\n"0x0000000000000000000000000000000000000001","1,234.5","No"\n`;
  const rows = parseAirdropCSV(csv, { sourceDecimals: 18, targetDecimals: 8 });
  // "1,234.5" → strip commas → "1234.5" → 18-dec: 1234500000000000000000 → 8-dec: 123450000000
  return rows.length === 1 && rows[0].amount === 123450000000n;
});

test('Etherscan CSV: ignores trailing PendingBalanceUpdate column', () => {
  const csv = `0x0000000000000000000000000000000000000001,1.0,No\n0x0000000000000000000000000000000000000002,2.0,Yes\n`;
  const rows = parseAirdropCSV(csv, { sourceDecimals: 18, targetDecimals: 8 });
  return rows.length === 2 && rows[0].amount === 100000000n && rows[1].amount === 200000000n;
});

test('CSV: rejects "1.5" when sourceDecimals=0 (legacy integer-only mode)', () => {
  const csv = `0x${'1'.repeat(40)},1.5\n`;
  try { parseAirdropCSV(csv); return false; } catch { return true; }
});

test('CSV: truncates excess fractional digits past sourceDecimals', () => {
  // sourceDecimals=8, value "1.123456789" — last digit is below precision and
  // must be truncated, not error.
  const csv = `0x${'1'.repeat(40)},1.123456789\n`;
  const rows = parseAirdropCSV(csv, { sourceDecimals: 8, targetDecimals: 8 });
  // 1.12345678 (truncated from 1.123456789) → 8 decimals → 112345678
  return rows.length === 1 && rows[0].amount === 112345678n;
});

console.log('\nMulti-source merge:');

test('merge: sums same-address across two sources', () => {
  const a = `0x${'1'.repeat(40)},10\n0x${'2'.repeat(40)},20\n`;
  const b = `0x${'1'.repeat(40)},5\n0x${'3'.repeat(40)},30\n`;
  const ra = parseAirdropCSV(a);
  const rb = parseAirdropCSV(b);
  const merged = mergeAirdropRows([ra, rb]);
  // Address 1: 10+5=15; address 2: 20; address 3: 30. Three unique addresses.
  if (merged.length !== 3) return false;
  // Sorted by address, indexes reassigned
  const byAddr = new Map(merged.map(r => [r.ethAddrHex, r.amount]));
  return byAddr.get('11'.repeat(20)) === 15n
      && byAddr.get('22'.repeat(20)) === 20n
      && byAddr.get('33'.repeat(20)) === 30n;
});

test('merge: indexes are 0..N-1 in sorted-by-address order (deterministic)', () => {
  const a = `0x${'aa'.repeat(20)},1\n0x${'01'.repeat(20)},2\n0x${'cc'.repeat(20)},3\n`;
  const merged = mergeAirdropRows([parseAirdropCSV(a)]);
  // Sort order: 01... < aa... < cc...
  return merged[0].ethAddrHex.startsWith('01')
      && merged[1].ethAddrHex.startsWith('aa')
      && merged[2].ethAddrHex.startsWith('cc')
      && merged[0].index === 0 && merged[1].index === 1 && merged[2].index === 2;
});

test('merge: order of rowSets does not affect root', () => {
  // The whole point: regardless of which CSV the issuer uploaded first, the
  // merkle commitment is the same. Auditors with the same CSVs (in any order)
  // recompute the same root.
  const a = `0x${'aa'.repeat(20)},10\n0x${'bb'.repeat(20)},20\n`;
  const b = `0x${'aa'.repeat(20)},5\n0x${'cc'.repeat(20)},15\n`;
  const r1 = mergeAirdropRows([parseAirdropCSV(a), parseAirdropCSV(b)]);
  const r2 = mergeAirdropRows([parseAirdropCSV(b), parseAirdropCSV(a)]);
  const c1 = computeAirdropCommitment(r1);
  const c2 = computeAirdropCommitment(r2);
  return c1.root.length === 32 && c1.root.every((b, i) => b === c2.root[i]);
});

test('merge: detects u64 overflow on summed amounts', () => {
  // Two sources each holding ~max u64 / 2 + 1 → sum overflows.
  const big = (1n << 63n) + 1n;
  const a = [{ ethAddrHex: '00'.repeat(20), ethAddrBytes: new Uint8Array(20), amount: big, index: 0 }];
  const b = [{ ethAddrHex: '00'.repeat(20), ethAddrBytes: new Uint8Array(20), amount: big, index: 0 }];
  try { mergeAirdropRows([a, b]); return false; } catch { return true; }
});

test('merge: cross-decimal sources (USDC + WETH style) compose correctly', () => {
  // USDC has 6 decimals; WETH has 18. User holds 100 USDC and 0.5 WETH; airdrop
  // is 1:1 sum at TAC's 8 decimals → 100.5 TAC = 10050000000 base units.
  const usdcCsv = `0x${'aa'.repeat(20)},100.0\n`;
  const wethCsv = `0x${'aa'.repeat(20)},0.5\n`;
  const r1 = parseAirdropCSV(usdcCsv, { sourceDecimals: 6, targetDecimals: 8 });
  const r2 = parseAirdropCSV(wethCsv, { sourceDecimals: 18, targetDecimals: 8 });
  const merged = mergeAirdropRows([r1, r2]);
  return merged.length === 1 && merged[0].amount === 10050000000n;
});

console.log('\nBlacklist:');

test('blacklist: parses addresses with mixed 0x prefix + casing', () => {
  const text = `# excluded\n0x${'AA'.repeat(20)}\n${'bb'.repeat(20)}\n`;
  const bl = parseBlacklist(text);
  return bl.size === 2 && bl.has('aa'.repeat(20)) && bl.has('bb'.repeat(20));
});

test('blacklist: rejects malformed entries with line number', () => {
  const text = `0x${'aa'.repeat(20)}\nnot-an-address\n`;
  try { parseBlacklist(text); return false; }
  catch (e) { return /line 2/.test(e.message); }
});

test('blacklist: applied at parse time excludes those addresses', () => {
  const csv = `0x${'aa'.repeat(20)},10\n0x${'bb'.repeat(20)},20\n0x${'cc'.repeat(20)},30\n`;
  const bl = parseBlacklist(`0x${'bb'.repeat(20)}\n`);
  const rows = parseAirdropCSV(csv, { blacklist: bl });
  return rows.length === 2
      && rows.every(r => r.ethAddrHex !== 'bb'.repeat(20));
});

test('blacklist: applied across merge — even with multiple sources', () => {
  // Issuer flow: blacklist is applied to each parse, so a blacklisted address
  // is excluded from EVERY source before merge. Verify summed result.
  const a = `0x${'aa'.repeat(20)},10\n0x${'bb'.repeat(20)},5\n`;
  const b = `0x${'bb'.repeat(20)},100\n0x${'cc'.repeat(20)},50\n`;
  const bl = parseBlacklist(`0x${'bb'.repeat(20)}\n`);
  const r1 = parseAirdropCSV(a, { blacklist: bl });
  const r2 = parseAirdropCSV(b, { blacklist: bl });
  const merged = mergeAirdropRows([r1, r2]);
  return merged.length === 2 && merged.every(r => r.ethAddrHex !== 'bb'.repeat(20));
});

console.log('\nClaim message format:');

const FIXED_ROOT = 'a'.repeat(64);
const FIXED_TACIT = '02' + 'b'.repeat(64);

test('buildAirdropClaimMsg: pinned canonical format', () => {
  // If this test ever fails, ANY previously-collected user signatures stop
  // verifying. Treat it as a wire-format change requiring a deliberate v2.
  const msg = buildAirdropClaimMsg({
    rootHex: FIXED_ROOT,
    network: 'mainnet',
    ethAddrHex: '0xabcdef0123456789abcdef0123456789abcdef01',
    leafIndex: 7,
    amount: 123456789n,        // 1.23456789 in 8 decimals
    ticker: 'TAC',
    decimals: 8,
    tacitPubHex: FIXED_TACIT,
  });
  const expected = [
    'tacit airdrop claim v1',
    '',
    `Drop:    ${FIXED_ROOT}`,
    'Network: mainnet',
    'Address: 0xabcdef0123456789abcdef0123456789abcdef01',
    'Leaf:    7',
    'Amount:  1.23456789 TAC (123456789)',
    `Tacit:   ${FIXED_TACIT}`,
    '',
    'By signing, you authorize the airdrop issuer to send the above amount of TAC to the tacit pubkey listed.',
  ].join('\n');
  return msg === expected;
});

test('buildAirdropClaimMsg: rejects malformed eth address', () => {
  try {
    buildAirdropClaimMsg({
      rootHex: FIXED_ROOT, network: 'mainnet',
      ethAddrHex: '0xZZZZ', leafIndex: 0, amount: 1n,
      ticker: 'TAC', decimals: 8, tacitPubHex: FIXED_TACIT,
    });
    return false;
  } catch { return true; }
});

test('buildAirdropClaimMsg: rejects malformed tacit pubkey', () => {
  try {
    buildAirdropClaimMsg({
      rootHex: FIXED_ROOT, network: 'mainnet',
      ethAddrHex: '0x' + '1'.repeat(40), leafIndex: 0, amount: 1n,
      ticker: 'TAC', decimals: 8, tacitPubHex: '04' + 'b'.repeat(64),  // uncompressed prefix → invalid
    });
    return false;
  } catch { return true; }
});

test('buildAirdropClaimMsg: address is lowercased', () => {
  const msg = buildAirdropClaimMsg({
    rootHex: FIXED_ROOT, network: 'signet',
    ethAddrHex: '0xABCDEF0123456789ABCDEF0123456789ABCDEF01',
    leafIndex: 0, amount: 100n, ticker: 'TST', decimals: 0,
    tacitPubHex: FIXED_TACIT,
  });
  return msg.includes('Address: 0xabcdef0123456789abcdef0123456789abcdef01');
});

console.log('\nEIP-191 hash (matches MetaMask personal_sign):');

test('eip191Hash: matches the canonical "Hello world" vector', () => {
  // Reference: keccak256("\x19Ethereum Signed Message:\n11Hello world")
  // Reproduce inline to pin parity with what MetaMask actually signs.
  const msg = 'Hello world';
  const expected = keccak_256(new TextEncoder().encode('\x19Ethereum Signed Message:\n11Hello world'));
  const got = eip191Hash(msg);
  return got.length === 32 && got.every((b, i) => b === expected[i]);
});

test('eip191Hash: prefix uses utf8 byte-length, not char count', () => {
  // "ä" is 2 UTF-8 bytes. The prefix length must reflect that.
  const msg = 'ä';
  const expected = keccak_256(new TextEncoder().encode('\x19Ethereum Signed Message:\n2ä'));
  const got = eip191Hash(msg);
  return got.length === 32 && got.every((b, i) => b === expected[i]);
});

console.log('\nECDSA recover from EIP-191 signature:');

test('recoverEthAddrFromSig: round-trip — sign then recover gives same address', () => {
  const priv = secp.utils.randomPrivateKey();
  const expectedAddr = _ethAddrFromPriv(priv);
  const msg = 'tacit test message';
  const sig = _signEip191WithPriv(msg, priv);
  const recovered = recoverEthAddrFromSig(msg, sig);
  return recovered === expectedAddr;
});

test('recoverEthAddrFromSig: tolerates v=27 and v=28 forms', () => {
  // Both recovery bits exist. Sign repeatedly until we've seen both.
  const priv = secp.utils.randomPrivateKey();
  const addr = _ethAddrFromPriv(priv);
  const seen = new Set();
  for (let i = 0; i < 20 && seen.size < 2; i++) {
    const sig = _signEip191WithPriv('msg ' + i, priv);
    const v = sig.slice(-2);
    if (recoverEthAddrFromSig('msg ' + i, sig) !== addr) return false;
    seen.add(v);
  }
  return seen.size === 2 && seen.has('1b') && seen.has('1c');  // 27 and 28
});

test('recoverEthAddrFromSig: tolerates v=0 and v=1 forms (some wallets)', () => {
  const priv = secp.utils.randomPrivateKey();
  const addr = _ethAddrFromPriv(priv);
  const msg = 'lowv test';
  const sig27or28 = _signEip191WithPriv(msg, priv);
  // Convert v form: replace last 2 hex chars with v - 27.
  const r = sig27or28.slice(2, 66);
  const s = sig27or28.slice(66, 130);
  const oldV = parseInt(sig27or28.slice(130, 132), 16);
  const newV = (oldV - 27).toString(16).padStart(2, '0');
  const lowV = '0x' + r + s + newV;
  return recoverEthAddrFromSig(msg, lowV) === addr;
});

test('recoverEthAddrFromSig: tampered signature recovers a different (wrong) address', () => {
  const priv = secp.utils.randomPrivateKey();
  const addr = _ethAddrFromPriv(priv);
  const msg = 'tamper test';
  const sig = _signEip191WithPriv(msg, priv);
  const tampered = '0x' + sig.slice(2, 4) === '0xff'
    ? '0x00' + sig.slice(4)
    : '0xff' + sig.slice(4);
  // Tampered sig either fails to recover at all (throws → verify returns false)
  // or recovers a different pubkey. Either way, the strict verifier rejects.
  return !verifyAirdropClaimSig(msg, tampered, addr);
});

test('recoverEthAddrFromSig: rejects malformed sig length', () => {
  try { recoverEthAddrFromSig('m', '0xabc'); return false; }
  catch { return true; }
});

test('verifyAirdropClaimSig: rejects same sig under different message', () => {
  const priv = secp.utils.randomPrivateKey();
  const addr = _ethAddrFromPriv(priv);
  const sig = _signEip191WithPriv('original', priv);
  return !verifyAirdropClaimSig('different', sig, addr);
});

test('verifyAirdropClaimSig: rejects against wrong expected address', () => {
  const priv = secp.utils.randomPrivateKey();
  const otherPriv = secp.utils.randomPrivateKey();
  const otherAddr = _ethAddrFromPriv(otherPriv);
  const msg = 'ok';
  const sig = _signEip191WithPriv(msg, priv);
  return !verifyAirdropClaimSig(msg, sig, otherAddr);
});

console.log('\nClaim flow integration:');

test('end-to-end claim: portal builds msg, signs; issuer verifies', () => {
  // Simulate the full flow.
  // 1. Issuer publishes drop with rows → root.
  const rows = [];
  for (let i = 0; i < 4; i++) {
    const fakePriv = new Uint8Array(32); fakePriv[31] = i + 1;
    const addrHex = _ethAddrFromPriv(fakePriv);
    rows.push({
      ethAddrHex: addrHex,
      ethAddrBytes: hexToBytes(addrHex),
      amount: BigInt((i + 1) * 1000),
      index: i,
    });
  }
  const commit = computeAirdropCommitment(rows);
  // 2. Recipient (the i=2 row) constructs claim msg and signs.
  const claimantPriv = new Uint8Array(32); claimantPriv[31] = 3;  // index 2 was i+1=3
  const claimantAddr = _ethAddrFromPriv(claimantPriv);
  // Find their row.
  const myRow = rows.find(r => r.ethAddrHex === claimantAddr);
  if (!myRow) return false;
  // Tacit pubkey (separate identity)
  const tacitPriv = secp.utils.randomPrivateKey();
  const tacitPub = bytesToHex(secp.getPublicKey(tacitPriv, true));
  const msg = buildAirdropClaimMsg({
    rootHex: bytesToHex(commit.root),
    network: 'mainnet',
    ethAddrHex: claimantAddr,
    leafIndex: myRow.index,
    amount: myRow.amount,
    ticker: 'TAC',
    decimals: 8,
    tacitPubHex: tacitPub,
  });
  const sig = _signEip191WithPriv(msg, claimantPriv);
  // 3. Issuer reconstructs the same msg, verifies sig + merkle proof.
  const reconstructed = buildAirdropClaimMsg({
    rootHex: bytesToHex(commit.root),
    network: 'mainnet',
    ethAddrHex: claimantAddr,
    leafIndex: myRow.index,
    amount: myRow.amount,
    ticker: 'TAC',
    decimals: 8,
    tacitPubHex: tacitPub,
  });
  if (reconstructed !== msg) return false;
  if (!verifyAirdropClaimSig(reconstructed, sig, claimantAddr)) return false;
  // 4. Merkle proof inclusion
  const proof = airdropMerkleProof(commit.layers, myRow.index);
  if (!verifyAirdropMerkleProof(commit.rows[myRow.index].leaf, proof, commit.root)) return false;
  return true;
});

test('claim sig binds to tacit pubkey: cannot redirect to a different tacit identity', () => {
  // The whole point of binding tacit pubkey into the signed msg: a relay /
  // worker / man-in-the-middle who intercepts a valid signed claim CAN'T
  // change the destination tacit pubkey without invalidating the sig.
  const priv = new Uint8Array(32); priv[31] = 7;
  const addr = _ethAddrFromPriv(priv);
  const tacitA = '02' + 'a'.repeat(64);
  const tacitB = '03' + 'b'.repeat(64);
  const msgA = buildAirdropClaimMsg({
    rootHex: FIXED_ROOT, network: 'mainnet', ethAddrHex: addr,
    leafIndex: 0, amount: 1000n, ticker: 'T', decimals: 0, tacitPubHex: tacitA,
  });
  const sigA = _signEip191WithPriv(msgA, priv);
  // Attacker swaps tacitA → tacitB in the message they relay.
  const msgB = buildAirdropClaimMsg({
    rootHex: FIXED_ROOT, network: 'mainnet', ethAddrHex: addr,
    leafIndex: 0, amount: 1000n, ticker: 'T', decimals: 0, tacitPubHex: tacitB,
  });
  // sigA must not verify against msgB.
  return !verifyAirdropClaimSig(msgB, sigA, addr);
});

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail > 0 ? 1 : 0);
