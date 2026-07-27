// Pin the Bitcoin-AMM intent-authorization message builders across every implementation of them.
//
// The reflection guest re-derives each trader's signed intent_msg from the confirmed tx and BIP-340-verifies
// it (H-01). If the guest's byte layout drifts from the emitter's by even one field, every honest swap fails
// auth in-guest AFTER the vin scan has already nullified the trader's input note — the receipt is never
// onboarded and the principal is stranded. So the three builders must agree byte-for-byte, always.
//
// The guest's own Rust KATs pin its builders against fixed digests. This test closes the remaining gap: it
// runs the REAL `worker/src/index.js` and `dapp/tacit.js` functions — not a hand-written replica of them —
// on the SAME vectors the Rust KATs use — plus the T_SWAP_VAR reference harness the swap-var suite validates
// against — and asserts they reproduce the digests literally parsed out of `bitcoin.rs`. A replica can drift
// from the thing it mirrors; the real function cannot.
//
//   node tests/amm-intent-msg-pin.test.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

// The dapp bundle is browser code that touches the DOM at import time; stub just enough for the module body
// to evaluate. Its top-level init() throws on `location` after the builders are defined — harmless here.
const noop = () => {};
globalThis.document = {
  addEventListener: noop, removeEventListener: noop,
  querySelector: () => null, querySelectorAll: () => [], getElementById: () => null,
  createElement: () => ({ style: {}, classList: { add: noop, remove: noop }, addEventListener: noop, appendChild: noop }),
  body: { appendChild: noop }, head: { appendChild: noop },
  documentElement: { style: { setProperty: noop } },
};
globalThis.window = {
  addEventListener: noop, removeEventListener: noop,
  location: { href: '', search: '', hash: '' },
  matchMedia: () => ({ matches: false, addEventListener: noop }),
  localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
};
globalThis.localStorage = globalThis.window.localStorage;
globalThis.navigator = { userAgent: 'node', clipboard: { writeText: noop } };
globalThis.location = globalThis.window.location;
globalThis.addEventListener = noop;

// The T_SWAP_VAR reference harness is a FOURTH implementation of this message — the validator it ships is what
// the swap-var suite tests against, so it is pinned here too or it drifts silently while that suite keeps
// passing against its own private layout. Imported BEFORE the dapp bundle, whose top-level init leaks.
const H = await import(join(REPO, 'tests/swap-var.mjs'));
const W = await import(join(REPO, 'worker/src/index.js'));
const D = await import(join(REPO, 'dapp/tacit.js'));

// ── the digests the guest pins, read straight out of the Rust source ──
const RUST = readFileSync(join(REPO, 'contracts/sp1/confidential/cxfer-core/src/bitcoin.rs'), 'utf8');
function guestKat(fnName) {
  // Each KAT is `fn <name>_kat() { .. assert_eq!(.., "<64 hex>", ..) }`; take the first digest in that fn.
  const at = RUST.indexOf(`fn ${fnName}_kat()`);
  if (at < 0) throw new Error(`no KAT test named ${fnName}_kat in bitcoin.rs`);
  const m = /"([0-9a-f]{64})"/.exec(RUST.slice(at));
  if (!m) throw new Error(`no pinned digest inside ${fnName}_kat`);
  return m[1];
}

const hex = (u8) => Buffer.from(u8).toString('hex');
const rep = (b, n) => new Uint8Array(n).fill(b);
const repHex = (b, n) => Buffer.from(rep(b, n)).toString('hex');

// The vectors use P2WPKH scripts (0x00 0x14 ‖ hash160) even though the emitters pay note outputs to P2TR: the
// builders must bind whatever script the confirmed tx carries, verbatim. A vector built from a reconstructed
// P2TR program would be tautological and would hide exactly the drift this test exists to catch.
const p2wpkh = (b) => new Uint8Array([0x00, 0x14, ...rep(b, 20)]);

const traderPubkey = new Uint8Array([0x02, ...rep(0x03, 32)]);

// ── vectors, byte-identical to the Rust KATs in bitcoin.rs ──
const varArgs = {
  poolId: rep(0x01, 32), direction: 0,
  deltaIn: 1000n, deltaInMin: 990n, deltaInMax: 1010n,
  minOut: 495n, tipAmount: 5n, tipAsset: 0,
  expiryHeight: 800000, traderPubkey,
  assetInputOutpoint: new Uint8Array([...rep(0xAA, 32), 4, 0, 0, 0]), // txid internal-LE ‖ vout LE
  receiveScriptPubKey: p2wpkh(0xBB),
  // The receipt's BLINDING, not its commitment: the guest re-clears the trade against the reserves at fold
  // time and forms C_receipt' = deltaOut'·H + rReceipt·G itself, so no exact deltaOut is authorized.
  rReceipt: rep(0xCC, 32),
  cChangeOrSentinel: rep(0x00, 33),
  changeScriptPubKey: new Uint8Array(0), // sentinel change ⇒ no change output ⇒ empty bound script
  refundScriptPubKey: p2wpkh(0xEE), // vout 3, bound on every swap (the branch is decided by pool state)
};

// The change note is onboarded too, so its destination is bound as well. Second vector: a real (non-sentinel)
// change commitment plus the change output's own script.
const varChangeArgs = {
  ...varArgs,
  cChangeOrSentinel: new Uint8Array([0x03, ...rep(0xDD, 32)]),
  changeScriptPubKey: p2wpkh(0xCD),
};

const batchArgs = {
  poolIdBytes: rep(0x10, 32), direction: 0,
  inputUtxos: [{ txid: repHex(0x77, 32), vout: 1 }],
  cInSecp: new Uint8Array([0x02, ...rep(0xC1, 32)]),
  cInBjj: rep(0xB1, 32), xcurveSigma: rep(0x5a, 169),
  receiveScriptPubKey: p2wpkh(0xEE),
  minOut: 495n, tipAmount: 5n, tipAsset: 0, expiryHeight: 800000, traderPubkey,
};

const routeSpk = p2wpkh(0xEE);
// The route's refund destination (vout 2 — a route has no change output), bound on every route.
const routeRefundSpk = p2wpkh(0xEF);
const routeWorker = {
  trader_pubkey: '02' + repHex(0x03, 32),
  trader_input_asset_id: repHex(0xA1, 32),
  trader_output_asset_id: repHex(0xB2, 32),
  min_out: 400, expiry_height: 900000, n_hops: 2,
  hops: [
    { pool_id: repHex(0x11, 32), direction: 0, fee_bps: 30, R_A_pre: 10000, R_B_pre: 5000, delta_a_net_mag: 1000, delta_b_net_mag: 450 },
    { pool_id: repHex(0x22, 32), direction: 1, fee_bps: 30, R_A_pre: 8000, R_B_pre: 8000, delta_a_net_mag: 440, delta_b_net_mag: 450 },
  ],
  c_in_secp: '02' + repHex(0xCC, 32),
  r_receipt: repHex(0xC7, 32),
};
const routeDapp = {
  traderPubkey, traderInputAssetId: rep(0xA1, 32), traderOutputAssetId: rep(0xB2, 32),
  minOut: 400n, expiryHeight: 900000,
  hops: [
    { poolId: rep(0x11, 32), direction: 0, feeBps: 30, R_A_pre: 10000n, R_B_pre: 5000n, deltaANetMag: 1000n, deltaBNetMag: 450n },
    { poolId: rep(0x22, 32), direction: 1, feeBps: 30, R_A_pre: 8000n, R_B_pre: 8000n, deltaANetMag: 440n, deltaBNetMag: 450n },
  ],
  cInSecp: new Uint8Array([0x02, ...rep(0xCC, 32)]),
  rReceipt: rep(0xC7, 32),
  receiveScriptPubKey: routeSpk,
  refundScriptPubKey: routeRefundSpk,
};

let pass = 0, fail = 0;
function pin(label, guestDigest, actual) {
  if (guestDigest === actual) { console.log(`  PASS  ${label}`); pass++; return; }
  console.log(`  FAIL  ${label}\n        guest: ${guestDigest}\n        got:   ${actual}`);
  fail++;
}

const varKat = guestKat('swap_var_intent_msg');
const varChangeKat = guestKat('swap_var_intent_msg_change_dest');
const batchKat = guestKat('swap_batch_intent_msg');
const routeKat = guestKat('swap_route_intent_msg');

pin('T_SWAP_VAR   guest == worker ammSwapVarIntentMsg', varKat, hex(W.ammSwapVarIntentMsg(varArgs)));
pin('T_SWAP_VAR   guest == worker ammSwapVarIntentMsg (with change dest)', varChangeKat, hex(W.ammSwapVarIntentMsg(varChangeArgs)));
pin('T_SWAP_BATCH guest == worker ammBuildIntentMsg', batchKat, hex(W.ammBuildIntentMsg(batchArgs)));
pin('T_SWAP_ROUTE guest == worker ammSwapRouteIntentMsg', routeKat, hex(W.ammSwapRouteIntentMsg(routeWorker, routeSpk, routeRefundSpk)));
pin('T_SWAP_VAR   guest == reference harness buildSwapVarIntentMsg', varKat, hex(H.buildSwapVarIntentMsg(varArgs)));
pin('T_SWAP_VAR   guest == reference harness (with change dest)', varChangeKat, hex(H.buildSwapVarIntentMsg(varChangeArgs)));

if (D?.buildSwapVarIntentMsg) {
  pin('T_SWAP_VAR   guest == dapp buildSwapVarIntentMsg', varKat, hex(D.buildSwapVarIntentMsg(varArgs)));
  pin('T_SWAP_VAR   guest == dapp buildSwapVarIntentMsg (with change dest)', varChangeKat, hex(D.buildSwapVarIntentMsg(varChangeArgs)));
  pin('T_SWAP_ROUTE guest == dapp buildSwapRouteIntentMsg', routeKat, hex(D.buildSwapRouteIntentMsg(routeDapp)));
} else {
  console.log('  FAIL  dapp/tacit.js did not expose the intent-msg builders');
  fail++;
}

// Non-degeneracy: the destination must actually be bound. Flip one byte of the receipt script and every
// digest must move — otherwise a coordinator could redirect the receipt and still reproduce the message.
const movedVar = hex(W.ammSwapVarIntentMsg({ ...varArgs, receiveScriptPubKey: p2wpkh(0xBC) }));
pin('T_SWAP_VAR   receipt script is load-bearing', 'differs', movedVar === varKat ? 'SAME' : 'differs');
const movedRoute = hex(W.ammSwapRouteIntentMsg(routeWorker, p2wpkh(0xAB), routeRefundSpk));
pin('T_SWAP_ROUTE receipt script is load-bearing', 'differs', movedRoute === routeKat ? 'SAME' : 'differs');
const movedBatch = hex(W.ammBuildIntentMsg({ ...batchArgs, receiveScriptPubKey: p2wpkh(0xEF) }));
pin('T_SWAP_BATCH receipt script is load-bearing', 'differs', movedBatch === batchKat ? 'SAME' : 'differs');
// Same for the VAR change destination — the change is onboarded as a note, so redirecting it must break the sig.
const movedVarChange = hex(W.ammSwapVarIntentMsg({ ...varChangeArgs, changeScriptPubKey: p2wpkh(0xCE) }));
pin('T_SWAP_VAR   change script is load-bearing', 'differs', movedVarChange === varChangeKat ? 'SAME' : 'differs');
// And the empty-vs-present distinction must not collide: a sentinel swap's message can never equal a
// change-bearing one whose bound change script is empty.
const emptyChange = hex(W.ammSwapVarIntentMsg({ ...varChangeArgs, changeScriptPubKey: new Uint8Array(0) }));
pin('T_SWAP_VAR   empty change script != bound change script', 'differs', emptyChange === varChangeKat ? 'SAME' : 'differs');
// And the refund destination: a coordinator that redirects vout 3 must not be able to reproduce the message,
// or it could force staleness and collect the refunded principal of every swap it settles.
const movedVarRefund = hex(W.ammSwapVarIntentMsg({ ...varChangeArgs, refundScriptPubKey: p2wpkh(0xEF) }));
pin('T_SWAP_VAR   refund script is load-bearing', 'differs', movedVarRefund === varChangeKat ? 'SAME' : 'differs');
const movedRouteRefund = hex(W.ammSwapRouteIntentMsg(routeWorker, routeSpk, p2wpkh(0xAC)));
pin('T_SWAP_ROUTE refund script is load-bearing', 'differs', movedRouteRefund === routeKat ? 'SAME' : 'differs');
// A hop's pre-reserves / declared output / fee tier are NOT authorized any more — the fold recomputes them — so
// a pool moving must NOT invalidate the trader's signature. That is what stops a moved pool stranding a route.
const movedRouteHopState = hex(W.ammSwapRouteIntentMsg({
  ...routeWorker,
  hops: [{ ...routeWorker.hops[0], R_A_pre: 999999, delta_b_net_mag: 1, fee_bps: 100 }, routeWorker.hops[1]],
}, routeSpk, routeRefundSpk));
pin('T_SWAP_ROUTE hop reserves/output/fee are NOT authorized', routeKat, movedRouteHopState);
// The route's SHAPE still is.
const repointedRoute = hex(W.ammSwapRouteIntentMsg({
  ...routeWorker,
  hops: [routeWorker.hops[0], { ...routeWorker.hops[1], pool_id: repHex(0x23, 32) }],
}, routeSpk, routeRefundSpk));
pin('T_SWAP_ROUTE hop pool_id is load-bearing', 'differs', repointedRoute === routeKat ? 'SAME' : 'differs');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
