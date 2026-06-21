// Validates the JS CDP/cBTC-mint derivation mirror (dapp/confidential-cdp.js) against:
//   (1) independently-constructed preimages + keccak (byte-parity with cxfer-core lib.rs `cdp_*`), and
//   (2) the structural KAT cxfer-core asserts (determinism, field-binding, domain-separation).
// keccak_256 is the same dep the dapp injects, so a green run pins the JS layout to the Rust + the
// on-chain ConfidentialPool / CollateralEngine derivations, including the top-up helper surface.
// Run: node tests/confidential-cdp.mjs
import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import assert from 'node:assert';
import { makeConfidentialCdp } from '../dapp/confidential-cdp.js';

const cdp = makeConfidentialCdp({ keccak256: keccak_256 });
const enc = new TextEncoder();
const hx = (b) => '0x' + Buffer.from(b).toString('hex');
const cat = (...a) => { const n = a.reduce((s, x) => s + x.length, 0); const o = new Uint8Array(n); let p = 0; for (const x of a) { o.set(x, p); p += x.length; } return o; };
const bytesN = (h, n) => Uint8Array.from(String(h).replace(/^0x/, '').padStart(n * 2, '0').match(/../g).map((x) => parseInt(x, 16)));
const beN = (v, n) => { let x = BigInt(v); const o = new Uint8Array(n); for (let i = n - 1; i >= 0; i--) { o[i] = Number(x & 0xffn); x >>= 8n; } return o; };

const controllerA = '0x' + 'c1'.repeat(20);
const controllerB = '0x' + 'c2'.repeat(20);

// (1) byte-parity: build the cxfer-core preimages independently and keccak them directly.
{
  // debt asset = keccak("tacit-cdp-debt-v1" ‖ controller[20])
  const expDebt = hx(keccak_256(cat(enc.encode('tacit-cdp-debt-v1'), bytesN(controllerA, 20))));
  assert.equal(cdp.debtAssetId(controllerA), expDebt, 'debtAssetId byte-parity (== on-chain keccak(domain‖controller))');

  // basket leg = keccak(asset[32] ‖ value_be[32])
  const asset = '0x' + 'aa'.repeat(32);
  const expLeg = hx(keccak_256(cat(bytesN(asset, 32), beN(100n, 32))));
  assert.equal(cdp.basketLeg(asset, 100n), expLeg, 'basketLeg byte-parity');

  // cBTC mint commitment = keccak(Cx ‖ Cy) == cxfer-core commitment_hash
  const cx = '0x' + '10'.repeat(32), cy = '0x' + '11'.repeat(32);
  const expCommit = hx(keccak_256(cat(bytesN(cx, 32), bytesN(cy, 32))));
  assert.equal(cdp.cbtcMintCommitment(cx, cy), expCommit, 'cbtcMintCommitment byte-parity');

  // position nullifier = keccak("tacit-cdp-position-v1" ‖ leaf[32] ‖ "spent")
  const someLeaf = '0x' + '42'.repeat(32);
  const expNu = hx(keccak_256(cat(enc.encode('tacit-cdp-position-v1'), bytesN(someLeaf, 32), enc.encode('spent'))));
  assert.equal(cdp.positionNullifier(someLeaf), expNu, 'positionNullifier byte-parity');
  assert.equal(typeof cdp.cdpTopupCollateralSigma, 'function', 'top-up sigma helper exported');
  assert.equal(typeof cdp.cdpLiquidateDebtSigma, 'function', 'liquidation debt sigma helper exported');
}

// (2) structural KAT — mirrors cxfer-core::tests::cdp_primitives_bind_and_separate.
{
  // debt asset derives from the controller ALONE (sole minter); deterministic; distinct per controller.
  assert.equal(cdp.debtAssetId(controllerA), cdp.debtAssetId(controllerA), 'debt asset deterministic');
  assert.notEqual(cdp.debtAssetId(controllerA), cdp.debtAssetId(controllerB), 'debt asset is controller-derived');

  // basket root binds the leg set + each leg binds (asset, value); n=1 and n>1 both work.
  const da = cdp.debtAssetId(controllerA);
  const legA = cdp.basketLeg('0x' + 'aa'.repeat(32), 100n);
  const legB = cdp.basketLeg('0x' + 'bb'.repeat(32), 200n);
  const single = cdp.basketRoot([legA]);
  const multi = cdp.basketRoot([legA, legB]);
  assert.notEqual(single, multi, 'basket root binds the leg set');
  assert.notEqual(cdp.basketLeg('0x' + 'aa'.repeat(32), 100n), cdp.basketLeg('0x' + 'aa'.repeat(32), 101n), 'leg binds value');
  assert.notEqual(cdp.basketLeg('0x' + 'aa'.repeat(32), 100n), cdp.basketLeg('0x' + 'ab'.repeat(32), 100n), 'leg binds asset');

  // position leaf binds every field.
  const owner = '0x' + '71'.repeat(32), nonce = '0x' + '81'.repeat(32);
  const base = cdp.positionLeaf(controllerA, da, single, 50n, owner, nonce);
  assert.equal(base, cdp.positionLeaf(controllerA, da, single, 50n, owner, nonce), 'position leaf deterministic');
  assert.notEqual(base, cdp.positionLeaf(controllerB, da, single, 50n, owner, nonce), 'controller bound');
  assert.notEqual(base, cdp.positionLeaf(controllerA, cdp.debtAssetId(controllerB), single, 50n, owner, nonce), 'debt asset bound');
  assert.notEqual(base, cdp.positionLeaf(controllerA, da, multi, 50n, owner, nonce), 'basket root bound');
  assert.notEqual(base, cdp.positionLeaf(controllerA, da, single, 51n, owner, nonce), 'debt value bound');
  assert.notEqual(base, cdp.positionLeaf(controllerA, da, single, 50n, '0x' + '72'.repeat(32), nonce), 'owner bound');
  assert.notEqual(base, cdp.positionLeaf(controllerA, da, single, 50n, owner, '0x' + '82'.repeat(32)), 'nonce bound');

  // the position nullifier is one-to-one with the leaf.
  assert.equal(cdp.positionNullifier(base), cdp.positionNullifier(base), 'position ν deterministic');
  assert.notEqual(cdp.positionNullifier(base), cdp.positionNullifier(cdp.positionLeaf(controllerA, da, single, 50n, owner, '0x' + '82'.repeat(32))), 'distinct positions ⇒ distinct ν');
}

console.log('confidential-cdp: all assertions passed');
