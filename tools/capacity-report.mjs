// Lifecycle capacity report — what actually runs out, and when.
//
//   node tools/capacity-report.mjs [--api https://api.tacit.finance]
//
// Reads only PUBLIC endpoints, so anyone can reproduce it without credentials.
//
// The question this answers is not throughput, it is accumulation: does anything in the protocol get
// worse as notes pile up over its life? For the immutable surface the answer is no, and that is
// structural rather than a matter of headroom:
//
//   * the note tree is TREE_LEVELS = 32 with `filledSubtrees[32]`, so an insert costs 32 hashes whether
//     the tree holds fifty leaves or four billion — cost does not grow with fill;
//   * roots and nullifiers are `mapping(bytes32 => bool)` — one fixed SSTORE each, O(1) lookup, never
//     iterated, so no operation ever walks accumulated state;
//   * the guest reaches accumulated state only through witnessed proofs (imt_membership,
//     imt_non_membership, imt_insert_transition), each O(depth). It is stateless per proof, and MAX_OPS /
//     MAX_ITEMS_PER_OP are per-batch caps, not lifetime ones. Guest cost tracks batch size, not ledger size.
//
// The exception is off-chain, and it is the only line in this report that trends: the reflection
// snapshot's `noteLeaves` and `spentLinks` are append-only and never compacted. Frontier compaction is a
// known follow-up, and — this is the part worth remembering — it is a host-side change. The guest verifies
// against roots it is handed, so compacting the bookkeeping needs no redeploy, no re-prove, no vkey
// rotation.

const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const API = arg('--api', 'https://api.tacit.finance').replace(/\/$/, '');

const TREE_LEVELS = 32n;
const MAX_LEAVES = 1n << TREE_LEVELS;
const U64_MAX = 18_446_744_073_709_551_615n;

const mib = (b) => (b / (1024 * 1024)).toFixed(2);
const pct = (a, b) => `${((Number(a) / Number(b)) * 100).toExponential(2)}%`;
const commas = (n) => n.toLocaleString('en-US');

async function getJson(path) {
  const res = await fetch(`${API}${path}`);
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json();
}

const [index, dump] = await Promise.all([
  getJson('/confidential/index?network=mainnet'),
  getJson('/reflection/dump?network=mainnet'),
]);
const s = dump.snapshot || dump;

console.log(`\ntacit capacity report — ${new Date().toISOString()}`);
console.log(`pool ${index.pool}  (deploy block ${commas(index.deployBlock)})\n`);

// ── 1. Ethereum note tree ────────────────────────────────────────────────────
const used = BigInt(index.counts?.leaves ?? 0);
console.log('ETHEREUM NOTE TREE');
console.log(`  leaves used        ${commas(Number(used))} of ${commas(Number(MAX_LEAVES))}  (${pct(used, MAX_LEAVES)})`);
console.log(`  insert cost        ${TREE_LEVELS} hashes, flat — independent of fill`);
console.log(`  wraps / crossOuts  ${index.counts?.wraps ?? 0} / ${index.counts?.crossOuts ?? 0}`);
// Time-to-full is the honest way to read a 2^32 cap: the number is so large that any rate makes it absurd,
// which is the point — the tree is not a resource that needs managing.
for (const perDay of [1_000, 100_000]) {
  const years = Number(MAX_LEAVES - used) / perDay / 365;
  console.log(`  at ${commas(perDay).padStart(7)} notes/day   ${commas(Math.round(years))} years to fill`);
}

// ── 2. Value headroom ────────────────────────────────────────────────────────
// Note values and pool reserves are u64. At 8 decimals that is the ceiling on any single note and on any
// single reserve — not on TVL as a whole, which is spread across many notes.
console.log('\nVALUE HEADROOM (u64, per note and per reserve)');
console.log(`  at 8 decimals      ${commas(Number(U64_MAX / 100_000_000n))} units`);
console.log(`  at 6 decimals      ${commas(Number(U64_MAX / 1_000_000n))} units`);

// ── 3. Reflection snapshot — the one cumulative resource ─────────────────────
const raw = JSON.stringify(dump.snapshot ? dump : { snapshot: s });
const bytes = raw.length;
const size = (k) => (Array.isArray(s[k]) ? JSON.stringify(s[k]).length : 0);
const count = (k) => (Array.isArray(s[k]) ? s[k].length : 0);

const fields = ['noteLeaves', 'spentLinks', 'liveTriples', 'coords'];
const permanentKeys = ['noteLeaves', 'spentLinks'];

console.log('\nREFLECTION SNAPSHOT (off-chain — the only line that trends)');
console.log(`  height ${commas(s.height)}   total ${mib(bytes)} MiB\n`);
console.log('    field           count     bytes/elem   lifetime');
let permanentPerNote = 0;
for (const f of fields) {
  const n = count(f);
  const per = n ? size(f) / n : 0;
  const permanent = permanentKeys.includes(f);
  if (permanent) permanentPerNote += per;
  console.log(`    ${f.padEnd(14)}${commas(n).padStart(7)}${per.toFixed(0).padStart(13)}   ${permanent ? 'append-only' : 'freed on spend'}`);
}

// Growth model. Every note ever created costs `permanentPerNote` forever (its leaf, and eventually its
// spend link); while it is live it additionally costs the live-set fields. Reading the live fraction from
// the current set rather than assuming one keeps the projection honest about this deployment's actual mix.
const created = count('noteLeaves');
const live = count('liveTriples');
const liveFraction = created ? live / created : 0;
const transientPerNote = (count('liveTriples') ? size('liveTriples') / count('liveTriples') : 0)
  + (count('coords') ? size('coords') / count('coords') : 0);
const perNote = permanentPerNote + liveFraction * transientPerNote;

console.log(`\n  permanent cost     ${permanentPerNote.toFixed(0)} B per note-lifecycle`);
console.log(`  live-set cost      ${transientPerNote.toFixed(0)} B while unspent (currently ${(liveFraction * 100).toFixed(0)}% of notes are live)`);
console.log(`  modelled           ${perNote.toFixed(0)} B per note created, at this deployment's live fraction`);

console.log('\n  projected snapshot size:');
for (const n of [50_000, 250_000, 1_000_000, 5_000_000]) {
  console.log(`    ${commas(n).padStart(9)} notes   ${mib(n * perNote).padStart(8)} MiB`);
}

// The binding number. The assembler has been measured peaking +58-216MB above the snapshot against a
// 1280MB heap, so the snapshot wants to stay well under a fifth of that — call it 64MB as the point to
// schedule compaction, not the point where anything breaks.
const WARN_BYTES = 64 * 1024 * 1024;
const notesToWarn = Math.round((WARN_BYTES - bytes) / perNote);
console.log(`\n  headroom to the ${mib(WARN_BYTES)} MiB compaction trigger: ~${commas(notesToWarn)} more notes`);
console.log('  (a host-side limit — frontier compaction needs no redeploy, re-prove or vkey rotation)');

console.log('\nVERDICT');
console.log('  Nothing on the immutable surface accumulates cost. The snapshot does, slowly, and the fix');
console.log('  for it is off-chain and already scoped. Successor deployments resume reflection state by');
console.log('  digest, so migration needs no state copy.\n');
