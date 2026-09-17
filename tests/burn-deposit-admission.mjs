#!/usr/bin/env node
// The worker's burn-deposit admission (dapp/burn-deposit-bitcoin.js makeBurnDepositKit().admitBurnDeposit) must reach
// the reflection guest's verdict on every provenance shape: the worker emits a provenance blob only for an admitted
// burn, so a disagreement either folds a burn the guest skips or withholds one the guest would fold. Each case below
// is built by tests/gen-reflection-burn-deposit.mjs (the same fixture the guest executes), under the env knobs that
// the guest-side KAT (tests/reflection-burn-deposit-stream-kat.sh) marks valid or invalid.
//   node tests/burn-deposit-admission.mjs
import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { makeBurnDepositKit, extractTaprootEnvelope, parseBurnEnvelope } from '../dapp/burn-deposit-bitcoin.js';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const kit = makeBurnDepositKit({ secp, keccak256: keccak_256, sha256 });
let failures = 0;
const ok = (c, m) => { if (c) console.log(`ok   ${m}`); else { console.error(`FAIL ${m}`); failures++; } };

function build(env) {
  const out = execFileSync(process.execPath, [new URL('./gen-reflection-burn-deposit.mjs', import.meta.url).pathname], {
    env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(out.toString());
}
function admit(f, tweak = {}) {
  const tx = f.blocks[0].txs[1];
  const burn = parseBurnEnvelope(extractTaprootEnvelope(tx.txData));
  const bd = tx.burnDeposit;
  const prev = '0x' + f.headers[0].replace(/^0x/, '').slice(8, 72);
  return kit.admitBurnDeposit({
    burnTxHex: tx.txData, envAsset: burn.asset, envNu: burn.nullifier, blobHex: bd.blob, provHeaders: bd.provHeaders,
    burnedCx: bd.burnedCx, burnedCy: bd.burnedCy, batchPrevHash: prev, ...tweak,
  });
}

const valid = [['fixed supply', {}], ['CBURN step', { CBURN: '1' }], ['mintable (issuer cmint)', { MINTABLE: '1' }], ['atomic settlement hop (asset input at vin 1)', { AXFER: '1' }]];
const invalid = [
  ['non-conserving hop', { TAMPER: '1' }], ['understated CBURN', { CBURN: '1', CBURN_LIE: '1' }],
  ['hop witness not committed', { WITNESS_TAMPER: '1' }], ['etch witness not committed', { ETCH_WITNESS_TAMPER: '1' }],
  ['unauthorized cmint', { MINTABLE: '1', CMINT_TAMPER: '1' }],
  ['atomic settlement hop witnessed with skip 0', { AXFER: '1', AXFER_SKIP: '0' }],
  ['atomic settlement hop witnessed with skip 2', { AXFER: '1', AXFER_SKIP: '2' }],
];
for (const [name, env] of valid) {
  const f = build(env);
  const r = admit(f);
  ok(r.admitted, `admits ${name}${r.admitted ? '' : ` (${r.reason})`}`);
  if (name === 'fixed supply') {
    const tx = f.blocks[0].txs[1];
    const burn = parseBurnEnvelope(extractTaprootEnvelope(tx.txData));
    // The burned outpoint is the burn tx's first input, and the leaf is owned by that outpoint key.
    const leaf = kit.burnDepositLeaf(burn.asset, tx.burnDeposit.burnedCx, tx.burnDeposit.burnedCy, r.burnedTxid, r.burnedVout);
    ok(r.burnedNoteLeaf === leaf, 'burned note leaf is owned by the burn tx input-0 outpoint');
    // A wrong opening, a bad ν, a header chain that stops short, and a chain that does not reach the anchor all refuse.
    ok(!admit(f, { burnedCx: tx.burnDeposit.burnedCy }).admitted, 'refuses a bundle opening that is not the authenticated commitment');
    ok(!admit(f, { envNu: '0x' + '11'.repeat(32) }).admitted, 'refuses an envelope ν that is not nullifier(outpoint-owned leaf)');
    ok(!admit(f, { provHeaders: tx.burnDeposit.provHeaders.slice(0, -1) }).admitted, 'refuses a header chain that does not reach the batch anchor');
    ok(!admit(f, { batchPrevHash: '0x' + '00'.repeat(32) }).admitted, 'refuses a chain whose tip is not the batch anchor');
    ok(!admit(f, { provHeaders: [] }).admitted, 'refuses an empty header chain');
    ok(!admit(f, { blobHex: '0x' }).admitted, 'refuses an empty blob');
    ok(!admit(f, { blobHex: tx.burnDeposit.blob + '00' }).admitted, 'refuses a blob with a trailing byte (exact consumption)');
    // A blob that carries a pool-membership shortcut leaf is refused outright (its outpoint is prover-asserted).
    {
      const blob = Buffer.from(tx.burnDeposit.blob.replace(/^0x/, ''), 'hex');
      if (blob.readUInt32LE(blob.length - 4) !== 0) throw new Error('fixture blob already carries memberships');
      const u32 = (n) => { const x = Buffer.alloc(4); x.writeUInt32LE(n); return x; };
      const pm = Buffer.concat([Buffer.alloc(32, 1), Buffer.alloc(32, 2), Buffer.alloc(32, 3), Buffer.alloc(32, 4), u32(0), Buffer.alloc(32, 5), Buffer.alloc(8), u32(0)]);
      const withPm = Buffer.concat([blob.subarray(0, blob.length - 4), u32(1), pm]);
      const r2 = admit(f, { blobHex: '0x' + withPm.toString('hex') });
      ok(!r2.admitted && /pool-membership/.test(r2.reason), 'refuses a blob carrying a pool-membership leaf');
    }
    // A corrupted middle header: linkage/PoW fails even though the tip still matches.
    if (tx.burnDeposit.provHeaders.length >= 2) {
      const hs = tx.burnDeposit.provHeaders.slice();
      const h0 = Buffer.from(hs[0].replace(/^0x/, ''), 'hex'); h0[0] ^= 1; hs[0] = '0x' + h0.toString('hex');
      ok(!admit(f, { provHeaders: hs }).admitted, 'refuses a header chain with a broken earlier header');
    }
    // The envelope ν the dapp builder produces is exactly the one the guest checks.
    const built = kit.buildBurnDepositEnvelope({ assetId: burn.asset, cx: tx.burnDeposit.burnedCx, cy: tx.burnDeposit.burnedCy, burnedTxid: r.burnedTxid, burnedVout: r.burnedVout, dest: burn.dest, target: burn.target });
    ok(built.nu.toLowerCase() === burn.nullifier.toLowerCase(), 'buildBurnDepositEnvelope ν == the fixture envelope ν');
    ok(built.envelope.length === 2 + 161 * 2 && built.envelope.slice(2, 4) === '2b', 'buildBurnDepositEnvelope emits a 161-byte 0x2B envelope');
  }
}
for (const [name, env] of invalid) {
  const r = admit(build(env));
  ok(!r.admitted, `refuses ${name}${r.admitted ? '' : ` (${r.reason})`}`);
}
if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nburn-deposit admission: all cases agree with the guest verdicts');
