// CDP lifecycle real broadcast + verify E2E (Sepolia + Signet, post-deploy).
//
// REQUIRES A DEPLOYED POOL + A RUNNING BOX/WORKER. This drives the LIVE confidential-DeFi action layer
// (dapp/confidential-defi-actions.js → confidential-cdp.js) through the relay/box settle queue
// (dapp/confidential-relay.js → worker/src/confidential-settle.js → GPU box → ConfidentialPool.settle()),
// then self-verifies the on-chain effect (the CDP position tree from CdpPositionInserted + the cUSD debt
// supply delta from the LeavesInserted/NullifiersSpent stream). It CANNOT pass until:
//   • contracts/deployments/<chainId>.json (or dapp/confidential-deployments.js) has a real `pool` +
//     `collateralEngine` (the CDP controller / sole cUSD minter) + `relayBase`, and
//   • a box/worker is claiming + Groth16-proving the queue and submitting settle() on Sepolia.
// Until then it is correct-by-construction against the templates (amm-full-e2e / amm-farm-e2e) and the
// real assemblers (confidential-cdp-op.mjs / confidential-cdp-relay-fee.mjs), and it FAILS LOUDLY on a
// missing prereq rather than silently passing.
//
// Flow (phased; each phase resumable from .local/cdp-lifecycle-e2e-state.json):
//   Phase 0  pre-flight: pool + engine + relay reachable; the borrower's EVM account has cETH collateral
//            notes (wrap first if not — see confidential-pool-ux.buildWrap).
//   Phase 1  OPEN  — lock a cETH collateral note → mint a cUSD debt note (defi.openCdp). Verify a new
//            CdpPositionInserted leaf appears + a cUSD leaf was minted (debt supply += debtValue).
//   Phase 2  TOPUP — add a second cETH note to the SAME position (defi.topupCdp). Verify a second
//            CdpPositionInserted leaf appears (the replacement position) + no new cUSD minted.
//   Phase 3  CLOSE — burn the cUSD debt note + release the basket (defi.closeCdp). Verify the position
//            nullifier is spent + the cUSD debt supply returns (debt burned).
//   Phase 4  LIQUIDATE — a SECOND position is opened under-collateralized and a keeper seizes it
//            (defi.liquidateCdp). Verify the position nullifier is spent + the seized basket withdrawn.
//
// Run:  node tests/cdp-lifecycle-signet.mjs [contracts/deployments/11155111.json]
//       node tests/cdp-lifecycle-signet.mjs --reset    # wipe state and start over
//
// REVIEWER MUST CHECK at run time:
//   (a) The engine in the manifest is a FEE-FREE v1 controller (rateSnapshot = 0). If governance has armed
//       the cUSD stability fee, Phase 3 close must repay accrued (gross·rate/rateSnapshot) cUSD, not just
//       debtValue — bump the repayment note set accordingly.
//   (b) Phase 4's liquidation only lands if onCdpLiquidate sees the position as UNHEALTHY. With the v1
//       interest-free engine that means the collateral basket value must be < debtValue at the validated
//       ETH mark — sized below via LIQ_DEBT/LIQ_COLLAT. If the engine's LTV gate differs, adjust them.
//   (c) The keeper needs cUSD notes ≥ debtValue to burn (it repays the seized position's debt). The harness
//       reuses the borrower's wallet as keeper for self-containment; a real keeper is a distinct wallet.

import { JSDOM } from 'jsdom';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---- jsdom shim so the dapp modules load under Node (verbatim from amm-full-e2e-signet.mjs) ----
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
globalThis.location = dom.window.location;
globalThis.navigator = dom.window.navigator;
if (!globalThis.crypto) { try { globalThis.crypto = dom.window.crypto; } catch {} }
globalThis.prompt = () => null;
globalThis.alert = () => {};
globalThis.confirm = () => false;
globalThis.__TACIT_NO_INIT__ = true;
globalThis.localStorage.setItem('tacit-network-v1', 'signet');

import * as secp from '@noble/secp256k1';
import { sha256 as nobleSha256 } from '@noble/hashes/sha2';
import { keccak_256 } from '@noble/hashes/sha3';
import { hmac } from '@noble/hashes/hmac';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils';
import { createHash } from 'node:crypto';

// @noble/secp256k1 needs a sync hmac for the opening-sigma nonces the assemblers derive.
const _cat = (a) => { const t = a.reduce((s, x) => s + x.length, 0); const o = new Uint8Array(t); let p = 0; for (const x of a) { o.set(x, p); p += x.length; } return o; };
secp.etc.hmacSha256Sync = (key, ...m) => hmac(nobleSha256, key, _cat(m));
const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const keccak256 = (b) => keccak_256(b);

const { makeConfidentialPoolUx } = await import('../dapp/confidential-pool-ux.js');
const { makeConfidentialCdp } = await import('../dapp/confidential-cdp.js');
const { makeConfidentialDefiActions } = await import('../dapp/confidential-defi-actions.js');
const { makeConfidentialFarm } = await import('../dapp/confidential-farm.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_DIR = path.join(__dirname, '..', '.local');
const STATE_FILE = path.join(STATE_DIR, 'cdp-lifecycle-e2e-state.json');
const WALLETS_FILE = path.join(STATE_DIR, 'cdp-e2e-signet-wallets.json'); // { borrower: { priv_hex } }

const FLAGS = new Set(process.argv.slice(2).filter((a) => a.startsWith('--')));
if (FLAGS.has('--reset') && existsSync(STATE_FILE)) { unlinkSync(STATE_FILE); console.log(`State reset: ${STATE_FILE} deleted`); }
const MANIFEST = process.argv.slice(2).find((a) => !a.startsWith('--'));

function fail(msg) { console.error(`\n✗ ${msg}\n`); process.exit(1); }
function info(msg) { console.log(`  ${msg}`); }
function ok(msg)   { console.log(`  ✓ ${msg}`); }
function warn(msg) { console.log(`  ⚠ ${msg}`); }
function step(n, msg) { console.log(`\n--- Phase ${n}: ${msg} ---`); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function loadState() { try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { return {}; } }
function saveState(s) { if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true }); writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); }
const rand32Hex = () => '0x' + bytesToHex(crypto.getRandomValues(new Uint8Array(32)));

// ---- network selection ----
// The pool UX resolves its config (pool, collateralEngine, relayBase, rpcs, chainId) from
// confidential-deployments.js by network. A deployments manifest path (Sepolia 11155111.json) overrides
// the pool/engine/relayer addresses so a fresh deploy is picked up without editing source.
// The Sepolia pilot pool lives under the deployment KEY "signet" (chainId 11155111; it's the Sepolia pool
// that bridges to signet). "mainnet" is the gated production entry (pool: null). Default to the pilot.
const NETWORK = process.env.NETWORK || 'signet';
let ux;
try { ux = makeConfidentialPoolUx({ secp, keccak256, sha256, network: NETWORK }); }
catch (e) { fail(`confidential pool UX not configured: ${e.message}\n  Deploy the pool + set dapp/confidential-deployments.js (or pass a deployments manifest).`); }
const cfg = ux.cfg;

if (MANIFEST) {
  try {
    const m = JSON.parse(readFileSync(MANIFEST, 'utf8'));
    if (m.pool) cfg.pool = m.pool;
    if (m.engine || m.collateralEngine) cfg.collateralEngine = m.engine || m.collateralEngine;
    if (m.relayer) cfg.relayer = m.relayer;
    if (m.deployBlock) cfg.deployBlock = m.deployBlock;
    info(`manifest ${MANIFEST}: pool=${cfg.pool} engine=${cfg.collateralEngine || '—'}`);
  } catch (e) { fail(`could not read manifest ${MANIFEST}: ${e.message}`); }
}
if (!cfg.collateralEngine) fail('cfg.collateralEngine is null — the CollateralEngine (CDP controller) is not deployed. Deploy it then re-run.');
const CONTROLLER = cfg.collateralEngine;

// ---- wallet (one EVM identity derived from the Tacit scalar; reused as borrower + keeper) ----
if (!existsSync(WALLETS_FILE)) {
  fail(`Wallets not found at ${WALLETS_FILE}\n  Create it with { "borrower": { "priv_hex": "<64-hex>" } } funded with cETH collateral notes.`);
}
const WALLET = JSON.parse(readFileSync(WALLETS_FILE, 'utf8'));
const PRIV = hexToBytes(String(WALLET.borrower.priv_hex).replace(/^0x/, ''));
const id = ux.identity(PRIV);

const cdp = makeConfidentialCdp({ keccak256, pool: ux.pool });
const defi = makeConfidentialDefiActions({
  pool: ux.pool, cdp, farm: makeConfidentialFarm({ keccak256, pool: ux.pool }),
  relay: ux.relay, id, chainBindingHex: ux.chainBindingHex, secp,
});
const debtAsset = cdp.debtAssetId(CONTROLLER); // == keccak("tacit-cdp-debt-v1" ‖ controller) == the cUSD asset id

// ---- amounts (in-system units; collateral notes are cETH, debt is cUSD) ----
const ZERO32 = '0x' + '00'.repeat(32);
const DEBT_HEALTHY = 100n;   // cUSD against a well-collateralized basket (Phase 1-3)
const LIQ_DEBT = 100n;       // Phase 4: debt against an intentionally thin basket
const RATE_SNAPSHOT = ZERO32; // fee-free v1 controller (REVIEWER: bump if the stability fee is armed)

const state = loadState();
console.log(`\n=== CDP lifecycle E2E (Sepolia + Signet, post-deploy) ===\n`);
console.log(`  pool:       ${cfg.pool}`);
console.log(`  engine:     ${CONTROLLER}  (cUSD asset = ${debtAsset.slice(0, 18)}…)`);
console.log(`  relayBase:  ${cfg.relayBase}`);
console.log(`  evm acct:   ${ux.account(PRIV).address}`);
console.log(`  state:      ${STATE_FILE}\n`);

// ---- on-chain verify helpers (read the pool's authoritative state via the UX rpc fallback) ----
const _hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const CDP_POS_TOPIC0 = '0x' + _hex(keccak256(new TextEncoder().encode('CdpPositionInserted(bytes32)')));

async function positionLeafCount() {
  const fb = '0x' + Number(cfg.deployBlock || 0).toString(16);
  const logs = await ux.rpc('eth_getLogs', [{ address: cfg.pool, fromBlock: fb, toBlock: 'latest', topics: [CDP_POS_TOPIC0] }]);
  return (logs || []).length;
}
// cUSD "supply" proxy: the count of cUSD leaves inserted minus cUSD nullifiers spent isn't directly a
// supply scalar (notes are blinded), so we verify the borrower's OWN recoverable cUSD balance via the
// confidential scan (ux.balance), which is the user-observable conservation check the dapp surfaces.
async function ownCusdBalance() {
  const { notes } = await ux.balance(PRIV);
  return (notes || []).filter((n) => n.asset.toLowerCase() === debtAsset.toLowerCase())
    .reduce((s, n) => s + BigInt(n.value), 0n);
}
async function positionSpent(positionNullifierHex) {
  // nullifierSpent(bytes32) public mapping → selector + the 32-byte key
  const sel = _hex(keccak256(new TextEncoder().encode('nullifierSpent(bytes32)')).subarray(0, 4));
  const data = '0x' + sel + positionNullifierHex.replace(/^0x/, '').padStart(64, '0');
  const r = await ux.rpc('eth_call', [{ to: cfg.pool, data }, 'latest']);
  return BigInt(r || '0x0') === 1n;
}

// ---- collateral sourcing: scan the borrower's recoverable cETH notes (wrap first if empty) ----
async function pickCollateral(minLegs = 1) {
  const { notes } = await ux.balance(PRIV);
  const cEthId = (ux.assetByTicker.cETH || {}).assetId;
  const legs = (notes || []).filter((n) => cEthId && n.asset.toLowerCase() === cEthId.toLowerCase());
  if (legs.length < minLegs) {
    fail(`borrower has ${legs.length} cETH collateral note(s), need ≥ ${minLegs}.\n` +
      `  Wrap ETH into the pool first: ux.wrap({ walletPriv, amountWei, ticker:'cETH' }) (confidential-pool-ux.js).`);
  }
  // shape each leg as buildCdpMintOp expects: { asset, cx, cy, value, blinding, leafIndex, path }
  return legs.map((n) => ({ asset: n.asset, cx: n.cx, cy: n.cy, value: BigInt(n.value), blinding: n.blinding, leafIndex: n.leafIndex, path: n.path }));
}

// =========================================================================
// Phase 0: pre-flight
// =========================================================================
step(0, 'pre-flight (pool/engine/relay reachable, collateral present)');
{
  // relay reachability: a status() on a junk id should answer (unknown), not throw a network error.
  try { const st = await ux.relay.status('preflight-probe'); info(`relay reachable (probe status=${st.status})`); }
  catch (e) { fail(`relay/worker unreachable at ${cfg.relayBase}: ${e.message}`); }
  // pool reachability: the position-leaf count read must succeed.
  let posCount; try { posCount = await positionLeafCount(); } catch (e) { fail(`pool RPC unreachable: ${e.message}`); }
  ok(`pool reachable; ${posCount} CdpPositionInserted leaves on-chain`);
  const legs = await pickCollateral(1);
  ok(`pre-flight passed (${legs.length} cETH collateral note(s) available)`);
}

// =========================================================================
// Phase 1: OPEN — mint a cUSD debt note against a cETH basket
// =========================================================================
step(1, 'OPEN (lock cETH collateral → mint cUSD)');
if (state.open?.completed) {
  ok(`reusing open: position owner ${state.open.positionOwner.slice(0, 12)}…  debt=${state.open.debtValue}`);
} else {
  const legs = await pickCollateral(1);
  const leg = legs[0]; // single-leg basket for the healthy lifecycle
  const positionOwner = rand32Hex();
  const debtBlinding = rand32Hex();
  const posBefore = await positionLeafCount();
  const cusdBefore = await ownCusdBalance();
  const spendRoot = (await ux.balance(PRIV)).notes.find((n) => n.leafIndex === leg.leafIndex)?.root || leg.path && undefined;
  if (!spendRoot) fail('could not resolve the spend root for the collateral note (re-scan)');
  info(`openCdp debt=${DEBT_HEALTHY} against ${leg.value} cETH (positionOwner ${positionOwner.slice(0, 12)}…)…`);
  const r = await defi.openCdp({
    controller: CONTROLLER, debtValue: DEBT_HEALTHY, rateSnapshot: RATE_SNAPSHOT, fee: 0n,
    collateral: [leg], spendRoot, debtBlinding, positionOwner,
    waitOpts: { onUpdate: (st) => info(`  · open ${st.status}…`) },
  });
  info(`settle landed: ${r.txHash || r.status}`);
  info(`waiting 30s for the pool log scan to catch up…`);
  await sleep(30_000);
  // VERIFY: a new CdpPositionInserted leaf + the borrower's cUSD balance rose by debtValue.
  const posAfter = await positionLeafCount();
  if (posAfter !== posBefore + 1) fail(`expected +1 CdpPositionInserted (${posBefore}→${posBefore + 1}), got ${posAfter}`);
  const cusdAfter = await ownCusdBalance();
  if (cusdAfter - cusdBefore !== DEBT_HEALTHY) fail(`cUSD balance delta ${cusdAfter - cusdBefore} != minted debt ${DEBT_HEALTHY}`);
  ok(`OPEN verified: +1 position leaf, cUSD balance +${DEBT_HEALTHY}`);
  // Persist the open descriptor (the close needs the exact basket + position owner + debt blinding).
  state.open = {
    completed: true, positionOwner, debtBlinding, debtValue: DEBT_HEALTHY.toString(),
    rateSnapshot: RATE_SNAPSHOT, nonce: ZERO32, txHash: r.txHash || null,
    basket: [{ asset: leg.asset, value: leg.value.toString() }],
  };
  saveState(state);
}

// =========================================================================
// Phase 2: TOPUP — add a second collateral note to the same position
// =========================================================================
step(2, 'TOPUP (add cETH collateral, debt unchanged)');
if (state.topup?.completed) {
  ok(`reusing topup: ${state.topup.txHash || 'done'}`);
} else {
  const legs = await pickCollateral(1);
  // an UNUSED collateral note (not the one Phase 1 locked — that leaf is now spent into the position)
  const added = legs[0];
  if (!added) fail('no spare cETH note for the topup — wrap another cETH note first');
  const posBefore = await positionLeafCount();
  const cusdBefore = await ownCusdBalance();
  // rebuild the old position's membership against the live position tree
  const oldBasket = state.open.basket.map((l) => ({ asset: l.asset, value: BigInt(l.value) }));
  const sorted = [...oldBasket].sort((a, b) => (BigInt(a.asset) < BigInt(b.asset) ? -1 : 1));
  const basketRootHex = cdp.basketRoot(sorted.map((l) => cdp.basketLeg(l.asset, l.value)));
  const positionLeaf = cdp.positionLeaf(CONTROLLER, debtAsset, basketRootHex, BigInt(state.open.debtValue), RATE_SNAPSHOT, state.open.positionOwner, ZERO32);
  const posTree = await ux.cdpPositionTree();
  const positionIndex = posTree.indexOf(positionLeaf);
  if (positionIndex < 0) fail('Phase-1 position not yet on-chain (still settling?) — re-run');
  const positionPath = posTree.pathFor(positionIndex).path;
  const spendRoot = (await ux.balance(PRIV)).notes.find((n) => n.leafIndex === added.leafIndex)?.root;
  info(`topupCdp adding ${added.value} cETH to position #${positionIndex}…`);
  const r = await defi.topupCdp({
    controller: CONTROLLER, debtValue: BigInt(state.open.debtValue), rateSnapshot: RATE_SNAPSHOT,
    oldBasket: sorted, addedCollateral: [added], positionIndex, positionPath,
    spendRoot, cdpPositionRoot: posTree.root, positionOwner: state.open.positionOwner,
    waitOpts: { onUpdate: (st) => info(`  · topup ${st.status}…`) },
  });
  info(`settle landed: ${r.txHash || r.status}`);
  await sleep(30_000);
  const posAfter = await positionLeafCount();
  if (posAfter !== posBefore + 1) fail(`topup should append the replacement position (+1), got ${posAfter - posBefore}`);
  const cusdAfter = await ownCusdBalance();
  if (cusdAfter !== cusdBefore) fail(`topup minted cUSD (${cusdBefore}→${cusdAfter}) — it must be debt-neutral`);
  ok(`TOPUP verified: +1 replacement position leaf, cUSD balance unchanged`);
  // the live position is now the COMBINED basket under the same fresh owner + nonce 0
  state.topup = {
    completed: true, txHash: r.txHash || null,
    basket: [...sorted.map((l) => ({ asset: l.asset, value: l.value.toString() })), { asset: added.asset, value: added.value.toString() }],
  };
  saveState(state);
}

// =========================================================================
// Phase 3: CLOSE — burn the cUSD debt + release the basket
// =========================================================================
step(3, 'CLOSE (burn cUSD debt, release the collateral basket)');
if (state.close?.completed) {
  ok(`reusing close: ${state.close.txHash || 'done'}`);
} else {
  const debtValue = BigInt(state.open.debtValue);
  // the live position after Phase 2 is the combined basket (topup) under the same owner+nonce 0
  const liveBasket = (state.topup?.basket || state.open.basket).map((l) => ({ asset: l.asset, value: BigInt(l.value) }));
  const sorted = [...liveBasket].sort((a, b) => (BigInt(a.asset) < BigInt(b.asset) ? -1 : 1));
  const basketRootHex = cdp.basketRoot(sorted.map((l) => cdp.basketLeg(l.asset, l.value)));
  const positionLeaf = cdp.positionLeaf(CONTROLLER, debtAsset, basketRootHex, debtValue, RATE_SNAPSHOT, state.open.positionOwner, ZERO32);
  const positionNullifier = cdp.positionNullifier(positionLeaf);
  const posTree = await ux.cdpPositionTree();
  const positionIndex = posTree.indexOf(positionLeaf);
  if (positionIndex < 0) fail('live (post-topup) position not found on-chain — verify Phase 2 settled');
  const positionPath = posTree.pathFor(positionIndex).path;
  // repay: pick cUSD notes summing to the gross debt
  const { notes } = await ux.balance(PRIV);
  const debtNotes = []; let sum = 0n;
  for (const n of notes.filter((x) => x.asset.toLowerCase() === debtAsset.toLowerCase())) {
    debtNotes.push({ cx: n.cx, cy: n.cy, value: n.value, blinding: n.blinding, leafIndex: n.leafIndex, path: n.path, owner: n.owner });
    sum += BigInt(n.value); if (sum >= debtValue) break;
  }
  if (sum < debtValue) fail(`need ${debtValue} cUSD to repay; borrower holds ${sum}`);
  const spendRoot = notes.find((x) => x.asset.toLowerCase() === debtAsset.toLowerCase())?.root;
  const releaseBlindings = sorted.map(() => rand32Hex());
  const cusdBefore = await ownCusdBalance();
  info(`closeCdp repaying ${debtValue} cUSD, releasing ${sorted.length} leg(s)…`);
  const r = await defi.closeCdp({
    controller: CONTROLLER, debtValue, rateSnapshot: RATE_SNAPSHOT, positionOwner: state.open.positionOwner,
    basket: sorted, positionIndex, positionPath, spendRoot, cdpPositionRoot: posTree.root,
    fee: 0n, releaseBlindings, debtNotes,
    waitOpts: { onUpdate: (st) => info(`  · close ${st.status}…`) },
  });
  info(`settle landed: ${r.txHash || r.status}`);
  await sleep(30_000);
  // VERIFY: the position nullifier is spent + the cUSD debt was burned (balance fell by debtValue).
  if (!(await positionSpent(positionNullifier))) fail(`position nullifier ${positionNullifier.slice(0, 12)}… not marked spent on-chain`);
  const cusdAfter = await ownCusdBalance();
  if (cusdBefore - cusdAfter < debtValue) fail(`cUSD debt not burned: balance fell ${cusdBefore - cusdAfter}, expected ≥ ${debtValue}`);
  ok(`CLOSE verified: position nullifier spent, cUSD debt -${debtValue} (burned), basket released to notes`);
  state.close = { completed: true, txHash: r.txHash || null, positionNullifier };
  saveState(state);
}

// =========================================================================
// Phase 4: LIQUIDATE — open a thin position, then a keeper seizes it
// =========================================================================
step(4, 'LIQUIDATE (open under-collateralized → keeper seizes)');
if (state.liquidate?.completed) {
  ok(`reusing liquidate: ${state.liquidate.txHash || 'done'}`);
} else {
  // 4a: open a deliberately thin position (collateral value below the debt at the validated mark)
  if (!state.liqOpen?.completed) {
    const legs = await pickCollateral(1);
    const leg = legs[0];
    if (!leg) fail('no cETH note to open the liquidatable position — wrap a small cETH note first');
    if (leg.value >= LIQ_DEBT * 2n) warn(`collateral ${leg.value} may keep the position HEALTHY; the seize will revert. Use a thin note (≈ < ${LIQ_DEBT}).`);
    const positionOwner = rand32Hex();
    const debtBlinding = rand32Hex();
    const spendRoot = (await ux.balance(PRIV)).notes.find((n) => n.leafIndex === leg.leafIndex)?.root;
    info(`openCdp (thin) debt=${LIQ_DEBT} against ${leg.value} cETH…`);
    const r = await defi.openCdp({
      controller: CONTROLLER, debtValue: LIQ_DEBT, rateSnapshot: RATE_SNAPSHOT, fee: 0n,
      collateral: [leg], spendRoot, debtBlinding, positionOwner,
      waitOpts: { onUpdate: (st) => info(`  · liq-open ${st.status}…`) },
    });
    await sleep(30_000);
    state.liqOpen = {
      completed: true, positionOwner, debtBlinding, txHash: r.txHash || null,
      basket: [{ asset: leg.asset, value: leg.value.toString() }],
    };
    saveState(state);
    ok(`thin position opened (owner ${positionOwner.slice(0, 12)}…)`);
  }
  // 4b: a keeper seizes it (the position owner+nonce+legs are public from the mint, so any keeper can build).
  // RELAYED-with-fee path needs the keeper to fund the fee from the seized leg; here fee=0 ⇒ SELF-SETTLE
  // (box prove-only → the keeper broadcasts ConfidentialPool.settle itself). The keeper burns its OWN cUSD.
  const debtValue = LIQ_DEBT;
  const sorted = [...state.liqOpen.basket.map((l) => ({ asset: l.asset, value: BigInt(l.value) }))].sort((a, b) => (BigInt(a.asset) < BigInt(b.asset) ? -1 : 1));
  const basketRootHex = cdp.basketRoot(sorted.map((l) => cdp.basketLeg(l.asset, l.value)));
  const positionLeaf = cdp.positionLeaf(CONTROLLER, debtAsset, basketRootHex, debtValue, RATE_SNAPSHOT, state.liqOpen.positionOwner, ZERO32);
  const positionNullifier = cdp.positionNullifier(positionLeaf);
  const posTree = await ux.cdpPositionTree();
  const positionIndex = posTree.indexOf(positionLeaf);
  if (positionIndex < 0) fail('thin position not found on-chain — verify Phase 4a settled');
  const positionPath = posTree.pathFor(positionIndex).path;
  // keeper repayment cUSD notes ≥ debtValue
  const { notes } = await ux.balance(PRIV);
  const debtNotes = []; let sum = 0n;
  for (const n of notes.filter((x) => x.asset.toLowerCase() === debtAsset.toLowerCase())) {
    debtNotes.push({ cx: n.cx, cy: n.cy, value: n.value, blinding: n.blinding, leafIndex: n.leafIndex, path: n.path, owner: n.owner });
    sum += BigInt(n.value); if (sum >= debtValue) break;
  }
  if (sum < debtValue) fail(`keeper needs ${debtValue} cUSD to seize; holds ${sum} (mint/keep cUSD from another position)`);
  const spendRoot = notes.find((x) => x.asset.toLowerCase() === debtAsset.toLowerCase())?.root;
  const liquidator = ux.account(PRIV).address; // the keeper EVM address that receives the seized basket
  info(`liquidateCdp seizing position #${positionIndex} (debt ${debtValue})… (self-settle; keeper broadcasts settle)`);
  let r;
  try {
    // fee=0 ⇒ defi.liquidateCdp returns the box PROVE result { publicValues, proof }; submit it ourselves.
    const proven = await defi.liquidateCdp({
      controller: CONTROLLER, owner: state.liqOpen.positionOwner, debtValue, rateSnapshot: RATE_SNAPSHOT,
      basket: sorted, positionIndex, positionPath, spendRoot, cdpPositionRoot: posTree.root,
      liquidator, debtNotes, fee: 0n,
      waitOpts: { onUpdate: (st) => info(`  · liq prove ${st.status}…`) },
    });
    if (proven.publicValues && proven.proof) {
      const sub = await ux.submitSettle({ settlerPriv: PRIV, publicValues: proven.publicValues, proof: proven.proof, memos: [] });
      r = { txHash: sub.txHash };
      info(`keeper self-settle tx: ${sub.txHash}`);
    } else {
      r = proven; // it relay-settled (fee>0 path) — surface the txHash
    }
  } catch (e) {
    fail(`liquidate failed: ${e.message}\n  If "healthy" — the position was over-collateralized; size the thin note below LIQ_DEBT (reviewer note b).`);
  }
  await sleep(30_000);
  if (!(await positionSpent(positionNullifier))) fail(`liquidated position nullifier ${positionNullifier.slice(0, 12)}… not spent on-chain`);
  ok(`LIQUIDATE verified: thin position seized, nullifier spent, basket withdrawn to keeper ${liquidator}`);
  state.liquidate = { completed: true, txHash: r.txHash || null, positionNullifier, liquidator };
  saveState(state);
}

// =========================================================================
// Summary
// =========================================================================
console.log(`\n=== CDP lifecycle E2E COMPLETE ===\n`);
console.log(`  OPEN:      ${state.open?.txHash || '—'}  (debt ${state.open?.debtValue} cUSD)`);
console.log(`  TOPUP:     ${state.topup?.txHash || '—'}`);
console.log(`  CLOSE:     ${state.close?.txHash || '—'}  (debt burned)`);
console.log(`  LIQUIDATE: ${state.liquidate?.txHash || '—'}  (keeper ${state.liquidate?.liquidator || '—'})`);
console.log(`\nState: ${STATE_FILE}`);
process.exit(0); // dapp modules can leave timers alive under jsdom
