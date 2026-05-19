// CXFER tacit-asset stealth signet harness — SKELETON.
//
// Tests the "doubly private" property end-to-end on real signet:
// a tacit asset is transferred from Bob to Alice, where:
//   * Amount is Pedersen-hidden (existing CXFER property)
//   * Recipient address is stealth-hidden (new class-2 property)
//
// Once dapp scanner integration lands (Task 19, blocked on user's
// batch merge), the STUBs in this harness wire up to the real
// CXFER builder + scanner. Until then, this file documents the
// test flow + provides the stealth-detection scaffolding that
// works today against any real CXFER tx that lands at a stealth
// address.
//
// Pre-reqs:
//   - .local/stealth-signet-{alice,bob}.json (run gen wallets)
//   - Bob funded with signet sats for tx fees
//   - Bob has a tacit asset to send (either CETCH'd by this harness
//     or pre-existing TAC-on-signet from a prior test run)
//
// Phases:
//   1. Pre-flight: load wallets + balances
//   2. CETCH test asset (or reuse existing)              [STUB]
//   3. Bob builds CXFER with Alice as STEALTH recipient   [STUB]
//      - Decode Alice's tcsts1qqqq… stealth address
//      - Compute per-recipient commit via §A.2.5 + §A.2 ECDH
//      - Build CXFER envelope normally (Pedersen amount hidden)
//      - Place dust output at P2WPKH(hash160(commit)) instead of
//        Alice's classical pubkey
//      - Broadcast
//   4. Confirm send tx
//   5. Alice scans + detects stealth credit                ✓ works today
//      - scanHoldings finds asset UTXO at the stealth address
//      - Both amount (via ECDH keystream) AND recipient (via stealth
//        commit derivation) are recovered from chain alone
//   6. Alice forwards onward to Carol (downstream test)    [STUB]
//      - Spend the stealth asset UTXO via another CXFER
//      - Validates the tweaked_sk + commit spend path for tacit-
//        asset inputs
//   7. Verify balance flow: Bob → Alice → Carol with balances
//      preserved modulo fees and amount-privacy intact
//
// STUBs are tagged with "// TODO(task-19):" comments. They become
// live once dapp/tacit.js's CXFER builder accepts stealth-format
// recipient addresses (per STEALTH-DAPP-INTEGRATION-PLAN.md §5).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as secp from '@noble/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { hmac } from '@noble/hashes/hmac';
import { hexToBytes, bytesToHex, concatBytes } from '@noble/hashes/utils';
import {
  decodeStealthAddress,
  senderComputeStealthCommit, recipientScanTxForStealth,
  p2wpkhScript, p2trScript, xOnly,
  computeCommit, computeTweakedSk, deriveEcdhBlinding,
  aggregateEligibleInputPubkeys,
  checkStealthEmissionSafety,
  DOMAIN_CXFER_STEALTH,
} from './stealth-primitives.mjs';
import {
  signP2wpkhInput, serializeTx, txid, txidLEBytes, u32le,
  getUtxos, broadcast, getTx, waitForConfirm,
} from './stealth-btc-tx.mjs';

secp.etc.hmacSha256Sync = (k, ...m) => hmac(sha256, k, secp.etc.concatBytes(...m));

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_DIR  = path.join(__dirname, '..', '.local');
const STATE_FILE = path.join(STATE_DIR, 'stealth-cxfer-signet-state.json');
const ALICE_FILE = path.join(STATE_DIR, 'stealth-signet-alice.json');
const BOB_FILE   = path.join(STATE_DIR, 'stealth-signet-bob.json');
const CAROL_FILE = path.join(STATE_DIR, 'stealth-signet-carol.json');

const FEE_RATE = Number(process.env.FEE_RATE || 2);
const DUST     = 546;

function loadState() { try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { return {}; } }
function saveState(s) { if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true }); writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); }
function fail(msg) { console.error(`\n✗ ${msg}\n`); process.exit(1); }
function info(msg) { console.log(`  ${msg}`); }
function ok(msg)   { console.log(`  ✓ ${msg}`); }
function todo(msg) { console.log(`  ⏸  TODO(task-19): ${msg}`); }
function phase(n, msg) { console.log(`\n--- Phase ${n}: ${msg} ---`); }

if (!existsSync(ALICE_FILE) || !existsSync(BOB_FILE) || !existsSync(CAROL_FILE)) {
  fail('Wallets missing. Run: node tests/gen-stealth-signet-wallets.mjs');
}
const ALICE = JSON.parse(readFileSync(ALICE_FILE, 'utf8'));
const BOB   = JSON.parse(readFileSync(BOB_FILE, 'utf8'));
const CAROL = JSON.parse(readFileSync(CAROL_FILE, 'utf8'));

const alicePriv = hexToBytes(ALICE.priv_hex);
const alicePub  = hexToBytes(ALICE.pub_hex);
const bobPriv   = hexToBytes(BOB.priv_hex);
const bobPub    = hexToBytes(BOB.pub_hex);
const carolPriv = hexToBytes(CAROL.priv_hex);
const carolPub  = hexToBytes(CAROL.pub_hex);

console.log(`\n=== CXFER tacit-asset stealth signet harness (SKELETON) ===\n`);
console.log(`  Alice (recipient): ${ALICE.address}`);
console.log(`  Alice stealth:     ${ALICE.stealth_address}`);
console.log(`  Bob (sender):      ${BOB.address}`);
console.log(`  Carol (downstream): ${CAROL.address}`);
console.log();
console.log(`  STATUS: skeleton awaiting dapp integration (Task 19).`);
console.log(`  Live stages: phases 1, 5 (scanner detection works today).`);
console.log(`  STUB stages: phases 2, 3, 6 (CXFER builder needs stealth-`);
console.log(`                                 recipient support).`);

const state = loadState();

// =============================================================================
// Phase 1 — pre-flight (live)
// =============================================================================
phase(1, 'pre-flight (wallets + balances)');
const bobUtxos = await getUtxos(BOB.address);
const bobSats = bobUtxos.reduce((s, u) => s + u.value, 0);
info(`Bob balance: ${bobSats.toLocaleString()} sats across ${bobUtxos.length} UTXO(s)`);
if (bobSats < 10_000) {
  info(`(low balance — phases 2/3/6 require tx fees; top up if running live)`);
}
ok(`pre-flight passed`);

// =============================================================================
// Phase 2 — CETCH or reuse test asset (STUB)
// =============================================================================
phase(2, 'CETCH a test tacit asset on signet (STUB)');
todo(`call dapp.buildAndBroadcastCEtch({ ticker: 'stealth-test', supplyBase: 1_000_000n, decimals: 0 })`);
todo(`persist state.testAssetId for downstream phases`);
todo(`once dapp integration lands, this becomes a direct dapp call`);
info(`for now: assume a pre-existing test asset; user supplies state.testAssetId`);
if (!state.testAssetId) {
  info(`set state.testAssetId in ${STATE_FILE} to reuse an existing signet asset`);
  info(`or wait for Task 19 to land + run the live CETCH path`);
}

// =============================================================================
// Phase 3 — Bob builds CXFER with stealth recipient (STUB)
// =============================================================================
phase(3, 'Bob CXFER → Alice stealth recipient (STUB)');
todo(`decode Alice's stealth address: decoded = decodeStealthAddress(ALICE.stealth_address)`);
todo(`build CXFER envelope normally — Pedersen amount commit unchanged`);
todo(`compute stealth commit per §A.2.5 + §A.2:`);
todo(`  - aggregate sender's eligible input pubkeys (Bob's funding UTXOs)`);
todo(`  - ECDH(sender_eligible_aggregate_sk, decoded.recipientPub)`);
todo(`  - blinding = HMAC(sha256(x_only(sharedPt)), DOMAIN_CXFER_STEALTH || …)`);
todo(`  - commit = decoded.recipientPub + blinding · G`);
todo(`safety check: checkStealthEmissionSafety({ inputs, eachInputIsOurs })`);
todo(`build Bitcoin tx with dust output at P2WPKH(hash160(commit))`);
todo(`broadcast + persist state.sendTxid`);
info(`primitives ready in stealth-primitives.mjs; awaiting CXFER builder integration`);

// =============================================================================
// Phase 4 — confirm send tx
// =============================================================================
phase(4, 'wait for send confirmation');
if (state.sendTxid && state.sendConfirmedHeight) {
  ok(`already confirmed at height ${state.sendConfirmedHeight}`);
} else if (state.sendTxid) {
  info(`polling ${state.sendTxid}…`);
  const t = await waitForConfirm(state.sendTxid);
  console.log();
  ok(`confirmed at height ${t.status.block_height}`);
  state.sendConfirmedHeight = t.status.block_height;
  saveState(state);
} else {
  info(`(no send tx yet — phase 3 STUB pending)`);
}

// =============================================================================
// Phase 5 — Alice detects (live, works today)
// =============================================================================
phase(5, 'Alice scanner detects the stealth-shaped CXFER output');
if (!state.sendTxid) {
  info(`(no send tx — scanner has nothing to find)`);
  info(`when phase 3 STUB resolves, this phase exercises:`);
  info(`  scanHoldings finds asset UTXO at stealth address`);
  info(`  amount recovered via existing ECDH amount keystream`);
  info(`  recipient identity recovered via new stealth commit derivation`);
} else {
  const sendTx = await getTx(state.sendTxid);
  if (!sendTx) fail(`cannot fetch send tx`);
  const scanTx = {
    inputs: sendTx.vin.map(v => {
      const w = v.witness || [];
      if (w.length === 2 && w[1].length === 66) return { kind: 'p2wpkh', pub: hexToBytes(w[1]) };
      return { kind: 'unknown', pub: null };
    }),
    outputs: sendTx.vout.map(o => ({ script: hexToBytes(o.scriptpubkey) })),
  };
  // Anchor head per §C: vin[0].outpoint in LE wire order.
  const txAnchorHead = concatBytes(
    txidLEBytes(sendTx.vin[0].txid),
    u32le(sendTx.vin[0].vout),
  );
  const credits = recipientScanTxForStealth({
    tx: scanTx, walletPriv: alicePriv, walletPub: alicePub,
    networkTag: 'signet', domain: DOMAIN_CXFER_STEALTH,
    txAnchorHead,
  });
  if (credits.length === 0) {
    fail(`Alice's scanner did NOT detect the stealth receipt`);
  }
  ok(`Alice detected ${credits.length} stealth credit(s)`);
  for (const c of credits) {
    info(`  vout[${c.voutIndex}]  script=${c.scriptKind}  commit=${bytesToHex(c.commit).slice(0,16)}…`);
  }
  // Verify tweaked_sk corresponds to commit.
  const tweakedPub = secp.getPublicKey(credits[0].tweakedSk, true);
  if (bytesToHex(tweakedPub) !== bytesToHex(credits[0].commit)) {
    fail(`tweaked_sk · G != commit`);
  }
  ok(`tweaked_sk · G == commit (Alice can spend the asset UTXO)`);
  state.aliceStealthCreditTxid = state.sendTxid;
  state.aliceStealthCreditVout = credits[0].voutIndex;
  state.aliceStealthCommitHex  = bytesToHex(credits[0].commit);
  state.aliceTweakedSkHex      = bytesToHex(credits[0].tweakedSk);
  saveState(state);
}

// =============================================================================
// Phase 6 — Alice forwards to Carol (STUB)
// =============================================================================
phase(6, 'Alice → Carol downstream CXFER with stealth recipient (STUB)');
todo(`Alice picks the stealth-credited tacit-asset UTXO as input`);
todo(`spend-path uses tweaked_sk (per STEALTH-DAPP-INTEGRATION-PLAN §6)`);
todo(`build new CXFER to Carol's stealth address`);
todo(`tx_anchor head uses vin[0].outpoint (= Alice's stealth UTXO)`);
todo(`broadcast + confirm`);
todo(`Carol scans + detects + can spend further`);
info(`validates: tacit-asset stealth chains across multiple hops`);
info(`validates: amount + recipient privacy compounds (each hop adds depth)`);

// =============================================================================
// Phase 7 — balance accounting
// =============================================================================
phase(7, 'balance accounting (STUB)');
todo(`fetch Bob's holdings via scanHoldings — confirm asset moved out`);
todo(`fetch Alice's holdings — confirm asset received via stealth`);
todo(`fetch Carol's holdings — confirm downstream stealth receipt`);
todo(`assert: sum(holdings) preserved modulo zero (tacit assets don't burn for fees)`);
todo(`assert: amount visible to chain observers = none (Pedersen blinding intact)`);
todo(`assert: each output address visible on chain != any wallet's published address`);

console.log(`\n=== Skeleton complete ===`);
console.log();
console.log(`Live capabilities exercised: pre-flight, scanner detection.`);
console.log(`Stubs waiting on Task 19 (dapp scanner + CXFER builder integration).`);
console.log();
console.log(`To activate full e2e once Task 19 lands:`);
console.log(`  1. Remove the // TODO(task-19) markers + wire each phase`);
console.log(`     to the real dapp.buildAndBroadcast* / scanHoldings calls`);
console.log(`  2. Set state.testAssetId in ${STATE_FILE} or trigger CETCH`);
console.log(`  3. Re-run; harness drives the full 7-phase flow on signet`);
console.log();
