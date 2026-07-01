// CDP funded-path (relay fee) conservation KAT. The CDP mint/close fee legs (cxfer-core OP_CDP_MINT/CLOSE +
// dapp/confidential-cdp.js cdpMintDebtSigma / cdpCloseReleaseSigma) carve the relay fee from the user's OWN
// value: the debt / released note opens to the NET (gross − fee), the GROSS + the fee are bound in the opening
// context (so a settler can neither re-price nor redirect), and the position records the GROSS debt (the
// health check is on gross). Conservation: minted/released NET note + fee leg = the gross the position
// accounts for — nothing is inflated. This pins the dapp's fee binding to the guest's; box parity is the
// harness/re-prove. Run: node tests/confidential-cdp-relay-fee.mjs
import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { createHash } from 'node:crypto';
import { randomScalar } from '../dapp/bulletproofs-plus.js';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import { makeConfidentialCdp } from '../dapp/confidential-cdp.js';
import assert from 'node:assert';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const keccak256 = (b) => keccak_256(b);
const pool = makeConfidentialPool({ secp, keccak256, sha256 });
const cdp = makeConfidentialCdp({ keccak256, pool });
let n = 0; const ok = (s) => { console.log('  ok -', s); n++; };

const hx = (b) => '0x' + Buffer.from(b).toString('hex');
const chainBinding = '0x' + '11'.repeat(32);
const controller = '0x' + 'c1'.repeat(20);
// controllerWord = 12 zero bytes ‖ controller[20] (mirrors confidential-cdp.js `controllerWord`)
const controllerWord = hx(new Uint8Array([...new Uint8Array(12), ...Buffer.from(controller.slice(2), 'hex')]));
const note = (value, owner) => {
  const blinding = randomScalar();
  const { cx, cy } = pool.commitXY(value, blinding);
  return { cx, cy, value, blinding, owner };
};

// ── 1. cdp_mint debt note opens to NET (gross − fee); gross+fee bound; position records GROSS ──
{
  const gross = 1000n, fee = 30n, net = gross - fee;
  const owner = '0x' + '00'.repeat(31) + '07';
  const nonce = '0x' + '81'.repeat(32);
  const rateSnapshot = '0x' + '00'.repeat(32);
  const debtNote = note(net, owner); // the user's debt note opens to the NET
  const { sigR, sigZ } = cdp.cdpMintDebtSigma({ chainBinding, controller, nonce, owner, note: debtNote, debtValue: gross, fee, rateSnapshot });
  const debtAsset = cdp.debtAssetId(controller);
  const ctx = pool.intentContext('tacit-cdp-mint-debt-v1', chainBinding, debtAsset, nonce,
    [[debtNote.cx, debtNote.cy, debtNote.owner], [controllerWord, nonce, owner], [rateSnapshot, nonce, owner]], [gross, fee]);
  assert.strictEqual(pool.verifyOpeningSigma(debtNote.cx, debtNote.cy, net, sigR, sigZ, ctx), true,
    'debt note opens to net (gross − fee)');
  assert.strictEqual(pool.verifyOpeningSigma(debtNote.cx, debtNote.cy, gross, sigR, sigZ, ctx), false,
    'debt note does NOT open to the gross debt');
  // a settler that bumps the fee changes the bound context → the sigma no longer verifies
  const ctxBumped = pool.intentContext('tacit-cdp-mint-debt-v1', chainBinding, debtAsset, nonce,
    [[debtNote.cx, debtNote.cy, debtNote.owner], [controllerWord, nonce, owner], [rateSnapshot, nonce, owner]], [gross, fee + 10n]);
  assert.strictEqual(pool.verifyOpeningSigma(debtNote.cx, debtNote.cy, net, sigR, sigZ, ctxBumped), false,
    'a bumped relay fee breaks the opening (fee is bound)');
  // the POSITION records the GROSS debt (health on gross), distinct from a net-debt leaf
  const basketRoot = cdp.basketRoot([cdp.basketLeg('0x' + 'aa'.repeat(32), 500n)]);
  const snap = '0x' + '00'.repeat(32);
  assert.notStrictEqual(
    cdp.positionLeaf(controller, debtAsset, basketRoot, gross, snap, owner, nonce),
    cdp.positionLeaf(controller, debtAsset, basketRoot, net, snap, owner, nonce),
    'position records gross debt (≠ a net-debt leaf)');
  assert.strictEqual(net + fee, gross, 'conservation: net debt note + relay fee = gross debt (position)');
  ok('cdp_mint relay fee: debt note opens to net, gross+fee bound, position records gross, bumped fee rejected');
}

// ── 2. cdp_close first released leg opens to NET; gross+fee bound; fee=0 legs open full ──
{
  const gross = 800n, fee = 21n, net = gross - fee;
  const asset = '0x' + 'aa'.repeat(32);
  const position = '0x' + '42'.repeat(32); // the position leaf the close spends
  const owner = '0x' + '00'.repeat(31) + '09';
  const relNote = note(net, owner); // the FIRST released leg (carries the fee) opens to the NET
  const { sigR, sigZ } = cdp.cdpCloseReleaseSigma({ chainBinding, positionLeaf: position, asset, note: relNote, value: gross, fee });
  const ctx = pool.intentContext('tacit-cdp-close-release-v1', chainBinding, asset, position,
    [[relNote.cx, relNote.cy, relNote.owner]], [gross, fee]);
  assert.strictEqual(pool.verifyOpeningSigma(relNote.cx, relNote.cy, net, sigR, sigZ, ctx), true,
    'released leg opens to net (gross − fee)');
  assert.strictEqual(pool.verifyOpeningSigma(relNote.cx, relNote.cy, gross, sigR, sigZ, ctx), false,
    'released leg does NOT open to the gross released collateral');
  const ctxBumped = pool.intentContext('tacit-cdp-close-release-v1', chainBinding, asset, position,
    [[relNote.cx, relNote.cy, relNote.owner]], [gross, fee + 5n]);
  assert.strictEqual(pool.verifyOpeningSigma(relNote.cx, relNote.cy, net, sigR, sigZ, ctxBumped), false,
    'a bumped relay fee breaks the opening (fee is bound)');
  // a fee = 0 leg (the other released legs) opens to the FULL value
  const fullNote = note(gross, owner);
  const s0 = cdp.cdpCloseReleaseSigma({ chainBinding, positionLeaf: position, asset, note: fullNote, value: gross, fee: 0n });
  const ctx0 = pool.intentContext('tacit-cdp-close-release-v1', chainBinding, asset, position,
    [[fullNote.cx, fullNote.cy, fullNote.owner]], [gross, 0n]);
  assert.strictEqual(pool.verifyOpeningSigma(fullNote.cx, fullNote.cy, gross, s0.sigR, s0.sigZ, ctx0), true,
    'a fee = 0 leg opens to the full value (byte-identical to the fee-free path)');
  assert.strictEqual(net + fee, gross, 'conservation: net released note + relay fee = gross released collateral');
  ok('cdp_close relay fee: first leg opens to net, gross+fee bound, fee=0 legs open full, bumped fee rejected');
}

console.log(`confidential-cdp-relay-fee: all ${n} checks passed`);
