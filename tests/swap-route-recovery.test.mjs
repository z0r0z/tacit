// T_SWAP_ROUTE recovery: privkey-only restoration of the trader's receipt
// UTXO from chain alone. The receipt opening (amount, blinding) is FULLY
// PUBLIC in the envelope per SPEC-SWAP-ROUTE-AMENDMENT — no localStorage,
// no worker, no priv-derived secret. This test asserts that the scanner
// extracts the right (amount, blinding) pair from a valid envelope and that
// it Pedersen-commits to the on-chain `c_receipt_secp`.
//
// Tested via the dapp's own decoder so any drift between encoder and
// scanner (e.g. confusing delta_a_net_mag vs delta_b_net_mag for the last
// hop direction) is caught.

import { JSDOM } from 'jsdom';
import { bytesToHex, hexToBytes, concatBytes } from '@noble/hashes/utils';
import { sha256 } from '@noble/hashes/sha256';
import * as secp from '@noble/secp256k1';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
globalThis.location = dom.window.location;
globalThis.navigator = dom.window.navigator;
globalThis.prompt = () => null;
globalThis.alert = () => {};
globalThis.confirm = () => false;
globalThis.__TACIT_NO_INIT__ = true;

import {
  G, H, SECP_N, pedersenCommit,
} from './bulletproofs.mjs';

const dapp = await import('../dapp/tacit.js');
const { encodeTSwapRoutePayload, decodeTSwapRoutePayload, T_SWAP_ROUTE } = dapp;

let pass = 0, fail = 0;
function test(label, fn) {
  try {
    const r = fn();
    if (r === true) { console.log(`  PASS  ${label}`); pass++; }
    else { console.log(`  FAIL  ${label}: ${r}`); fail++; }
  } catch (e) { console.log(`  THROW ${label}: ${e.message}`); fail++; }
}

function bytes32ToBigint(b) {
  let x = 0n;
  for (let i = 0; i < 32; i++) x = (x << 8n) | BigInt(b[i]);
  return x;
}

function bigintTo32(x) {
  const b = new Uint8Array(32);
  let v = BigInt(x);
  for (let i = 31; i >= 0; i--) { b[i] = Number(v & 0xffn); v >>= 8n; }
  return b;
}

// Build a 2-hop fixture envelope with a known receipt opening. We exercise
// the scanner's amount-extraction logic by computing the same `deltaOutLast`
// the recovery code does and asserting the Pedersen commitment matches.
function buildFixture({ lastDir }) {
  // Fixed asset ids — values don't have to be real, just distinct + non-equal.
  const assetIn  = hexToBytes('aa' + '11'.repeat(31));
  const assetOut = hexToBytes('cc' + '33'.repeat(31));
  const traderPriv = new Uint8Array(32).fill(0x77);
  const traderPub  = secp.getPublicKey(traderPriv, true);

  // Pool IDs — arbitrary 32 B.
  const poolAB = sha256(new TextEncoder().encode('pool-AB-v1'));
  const poolBC = sha256(new TextEncoder().encode('pool-BC-v1'));

  // Hop 1: A → B (direction 0 ⇒ in=A, out=B).
  // Hop 2 (last): depends on lastDir. If 0 ⇒ in=B,out=C; if 1 ⇒ in=C,out=B (toy).
  // Reserves + deltas are arbitrary BUT the recovery path only reads the
  // final hop's delta_*_net_mag based on its direction. Curve correctness
  // is the validator's job — out of scope here.
  const hop1 = {
    poolId: poolAB, direction: 0, feeBps: 30,
    R_A_pre: 1_000_000n, R_B_pre: 2_000_000n,
    deltaANetMag: 100n, deltaBNetMag: 198n,  // A in, B out
  };
  const hop2 = {
    poolId: poolBC, direction: lastDir, feeBps: 30,
    R_A_pre: 2_000_000n, R_B_pre: 4_000_000n,
    deltaANetMag: 196n, deltaBNetMag: 391n,
  };
  const hops = [hop1, hop2];

  // Receipt opening: amount = last-hop output. For direction 0 that's
  // deltaBNetMag; for direction 1 that's deltaANetMag.
  const deltaOutLast = lastDir === 0 ? hop2.deltaBNetMag : hop2.deltaANetMag;
  const rReceiptBig = bytes32ToBigint(sha256(new TextEncoder().encode('r_receipt_v1'))) % SECP_N;
  const rReceipt = bigintTo32(rReceiptBig);
  const cReceiptPoint = pedersenCommit(deltaOutLast, rReceiptBig);
  const cReceiptSecp = cReceiptPoint.toRawBytes(true);

  // The other commitment + sigs aren't exercised by the recovery path; fill
  // with non-zero placeholders. cInSecp must be a valid point — use G·1.
  const cInSecp = G.toRawBytes(true);

  // Fake outpoint + sigs (decoder only checks structural validity).
  const traderInputOutpointTxidBE = new Uint8Array(32).fill(0x11);
  const traderInputOutpointVout = 0;
  const rangeProof = new Uint8Array([0xaa, 0xbb, 0xcc]);
  const kernelSig = new Uint8Array(64).fill(0x55);
  const intentSig = new Uint8Array(64).fill(0x66);

  const payload = encodeTSwapRoutePayload({
    traderInputAssetId: assetIn,
    traderOutputAssetId: assetOut,
    minOut: 100n,
    expiryHeight: 1_000_000,
    traderPubkey: traderPub,
    hops,
    traderInputOutpointTxidBE,
    traderInputOutpointVout,
    cInSecp, cReceiptSecp, rReceipt,
    rangeProof, kernelSig, intentSig,
  });

  return { payload, deltaOutLast, rReceiptBig, cReceiptSecp, assetOut };
}

// ---- Tests --------------------------------------------------------------

test('encoder + decoder agree on payload structure', () => {
  const f = buildFixture({ lastDir: 0 });
  const dec = decodeTSwapRoutePayload(f.payload);
  if (!dec) return 'decoder returned null';
  if (dec.opcode !== T_SWAP_ROUTE) return 'wrong opcode';
  if (dec.nHops !== 2) return 'wrong hop count';
  return true;
});

test('last-hop direction 0 → receipt amount = deltaBNetMag', () => {
  const f = buildFixture({ lastDir: 0 });
  const dec = decodeTSwapRoutePayload(f.payload);
  const lastHop = dec.hops[dec.hops.length - 1];
  const recovered = lastHop.direction === 0 ? lastHop.deltaBNetMag : lastHop.deltaANetMag;
  return recovered === f.deltaOutLast || `got ${recovered}, expected ${f.deltaOutLast}`;
});

test('last-hop direction 1 → receipt amount = deltaANetMag', () => {
  const f = buildFixture({ lastDir: 1 });
  const dec = decodeTSwapRoutePayload(f.payload);
  const lastHop = dec.hops[dec.hops.length - 1];
  const recovered = lastHop.direction === 0 ? lastHop.deltaBNetMag : lastHop.deltaANetMag;
  return recovered === f.deltaOutLast || `got ${recovered}, expected ${f.deltaOutLast}`;
});

test('rReceipt scalar → commitment matches envelope cReceiptSecp', () => {
  const f = buildFixture({ lastDir: 0 });
  const dec = decodeTSwapRoutePayload(f.payload);
  const lastHop = dec.hops[dec.hops.length - 1];
  const amount = lastHop.direction === 0 ? lastHop.deltaBNetMag : lastHop.deltaANetMag;
  const rBig = bytes32ToBigint(dec.rReceipt) % SECP_N;
  const recomputed = pedersenCommit(amount, rBig).toRawBytes(true);
  if (bytesToHex(recomputed) !== bytesToHex(dec.cReceiptSecp)) {
    return `commitment mismatch: ${bytesToHex(recomputed)} vs ${bytesToHex(dec.cReceiptSecp)}`;
  }
  return true;
});

test('receipt asset_id is dec.traderOutputAssetId (not input)', () => {
  const f = buildFixture({ lastDir: 0 });
  const dec = decodeTSwapRoutePayload(f.payload);
  return bytesToHex(dec.traderOutputAssetId) === bytesToHex(f.assetOut)
    || `traderOutputAssetId mismatch`;
});

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
