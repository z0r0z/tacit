// Ceremony vk fingerprint pin — prevents a swapped or rebuilt bundle from
// shipping silently.
//
// What this guards against:
//   The mixer ceremony was finalized at Bitcoin block 948824 with 2,227
//   contributions. Its verification_key.json + zkey + r1cs are the only
//   inputs that make any Groth16 proof on the network verifiable. If the
//   bundle is rebuilt, swapped, or corrupted, every cBTC.zk burn / rotate
//   on this client would silently produce proofs that no honest indexer
//   accepts.
//
//   The other ceremony tests cover coordinator endpoints (init / contribute
//   / finalize) and fetch failover, but none of them assert the canonical
//   sha256 of the deployed vk. This one does.
//
// To update after a re-finalize: replace the constant below with the new
// sha256 (and document the migration in the PR / commit body).
//
// Run: `node tests/ceremony-vk-pin.test.mjs`

import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BUNDLE_DIR = path.join(__dirname, '..', 'dapp', 'circuits', 'ceremony-bundle');

// Canonical hashes — match dapp/circuits/ceremony-bundle/README.md +
// MIXER.md §Trusted setup. TACIT_DEFAULT_CEREMONY_HASH in dapp/tacit.js
// derives from r1cs sha256 and is also pinned below for symmetry.
const EXPECTED = {
  'verification_key.json': '760829334a626afbc74b24cff1058bec8f5714f802f74fb7f649b6a26ce933af',
  'withdraw.r1cs':         '1373a3bc34153c291d057b44edaba11d5a4aa779d0998e0d0c0e400dfc89129d',
  'pot14_final.ptau':      '489be9e5ac65d524f7b1685baac8a183c6e77924fdb73d2b8105e335f277895d',
  'withdraw_final.zkey':   'b8804fdb426289620287f9a918c8bee0369971e8f3fd6062c80f60147a308a03',
};

let pass = 0, fail = 0;
async function pin(filename, expected) {
  const full = path.join(BUNDLE_DIR, filename);
  try {
    await stat(full);
  } catch {
    console.log(`  FAIL  ${filename} missing at ${full}`);
    fail++;
    return;
  }
  const bytes = await readFile(full);
  const got = bytesToHex(sha256(bytes));
  if (got === expected) {
    console.log(`  PASS  ${filename} sha256 = ${expected}`);
    pass++;
  } else {
    console.log(`  FAIL  ${filename} sha256 mismatch`);
    console.log(`        expected: ${expected}`);
    console.log(`        got:      ${got}`);
    fail++;
  }
}

console.log('\nCeremony bundle vk + r1cs + ptau + zkey fingerprint pin:');
for (const [filename, expected] of Object.entries(EXPECTED)) {
  await pin(filename, expected);
}

// Sanity: the dapp's TACIT_DEFAULT_CEREMONY_HASH constant must match
// the r1cs sha256. This is what dapp/tacit.js feeds into
// ceremonyFetchHeadZkeyBytes() for every mixer + slot proof, so a drift
// here would silently route proofs to the wrong canonical zkey.
{
  globalThis.__TACIT_NO_INIT__ = true;
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://localhost/', pretendToBeVisual: true,
  });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.localStorage = dom.window.localStorage;
  globalThis.location = dom.window.location;
  globalThis.navigator = dom.window.navigator;
  globalThis.prompt = () => null;
  globalThis.alert = () => {};
  globalThis.confirm = () => false;
  const dapp = await import('../dapp/tacit.js');
  const want = EXPECTED['withdraw.r1cs'];
  const got = dapp.TACIT_DEFAULT_CEREMONY_HASH;
  if (got === want) {
    console.log(`  PASS  dapp.TACIT_DEFAULT_CEREMONY_HASH = ${want}`);
    pass++;
  } else {
    console.log(`  FAIL  dapp.TACIT_DEFAULT_CEREMONY_HASH mismatch — expected ${want}, got ${got}`);
    fail++;
  }
}

// On-chain burn verifier pin: the embedded Groth16Verifier.sol VK constants
// MUST equal the finalized ceremony verification_key.json. A foreign/dev key
// (the original CRITICAL audit finding) silently bricks every withdrawFromBurn,
// since a ceremony-keyed proof fails the on-chain pairing. snarkjs emits G2
// points (beta/gamma/delta) with the Fq2 halves swapped vs the JSON, so we
// compare with that swap; alpha and IC (G1) compare directly.
{
  const VERIFIER_SOL = path.join(__dirname, '..', 'contracts', 'src', 'Groth16Verifier.sol');
  const VK_JSON = path.join(BUNDLE_DIR, 'verification_key.json');
  const src = await readFile(VERIFIER_SOL, 'utf8');
  const vk = JSON.parse(await readFile(VK_JSON, 'utf8'));
  const constOf = (name) => {
    const m = src.match(new RegExp(`\\b${name}\\s*=\\s*(\\d+)`));
    return m ? BigInt(m[1]) : null;
  };
  const checks = [];
  const eq = (label, got, want) => checks.push([label, got === BigInt(want)]);
  // G1 — direct order.
  eq('alpha.x', constOf('alphax'), vk.vk_alpha_1[0]);
  eq('alpha.y', constOf('alphay'), vk.vk_alpha_1[1]);
  for (let i = 0; i < vk.IC.length; i++) {
    eq(`IC${i}.x`, constOf(`IC${i}x`), vk.IC[i][0]);
    eq(`IC${i}.y`, constOf(`IC${i}y`), vk.IC[i][1]);
  }
  // G2 — snarkjs solidity emits (c1,c0); JSON stores (c0,c1).
  const g2 = (field, pt) => {
    eq(`${field}.x1`, constOf(`${field}x1`), pt[0][1]);
    eq(`${field}.x2`, constOf(`${field}x2`), pt[0][0]);
    eq(`${field}.y1`, constOf(`${field}y1`), pt[1][1]);
    eq(`${field}.y2`, constOf(`${field}y2`), pt[1][0]);
  };
  g2('beta', vk.vk_beta_2);
  g2('gamma', vk.vk_gamma_2);
  g2('delta', vk.vk_delta_2);
  const bad = checks.filter(([, ok]) => !ok);
  if (bad.length === 0) {
    console.log(`  PASS  Groth16Verifier.sol VK == ceremony key (${checks.length} constants)`);
    pass++;
  } else {
    console.log(`  FAIL  Groth16Verifier.sol VK diverges from ceremony key: ${bad.map(([l]) => l).join(', ')}`);
    fail++;
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
