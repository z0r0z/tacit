// Recovery-parity: protocol-wide guardrail that every value-bearing opcode
// has a scanHoldings branch. Without this, a new opcode can be shipped (worker
// validates it, dapp emits it, chain accepts it) while a user who restores
// from privkey + chain alone never sees the UTXO surface in their Holdings.
//
// The invariant is: for every `const T_X = 0x..` declared in dapp/tacit.js OR
// worker/src/index.js, EITHER (a) scanHoldings has an `env.opcode === T_X`
// branch (or the opcode appears in a compound condition with one), OR (b) it
// is in the allowlist below with a documented reason. Adding a new opcode
// without doing one or the other fails this test.
//
// This is a textual analysis (no jsdom / no execution) so it runs fast and
// catches drift even when the dapp can't be loaded headlessly. Run:
//
//   node tests/recovery-parity.test.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

const dappSrc = readFileSync(join(REPO_ROOT, 'dapp/tacit.js'), 'utf8');
const workerSrc = readFileSync(join(REPO_ROOT, 'worker/src/index.js'), 'utf8');
const ammEnvSrc = readFileSync(join(REPO_ROOT, 'dapp/amm-envelope.js'), 'utf8');

let pass = 0, fail = 0;
function test(label, fn) {
  try {
    const r = fn();
    if (r === true) { console.log(`  PASS  ${label}`); pass++; }
    else { console.log(`  FAIL  ${label}: ${r}`); fail++; }
  } catch (e) { console.log(`  THROW ${label}: ${e.message}`); fail++; }
}

// ---- Opcode extraction --------------------------------------------------

// Match e.g. `const T_FOO = 0x21;` or `export const OPCODE_T_FOO = 0x34;`
function extractOpcodes(src) {
  const out = new Map();          // name -> opcode hex
  const re1 = /^\s*const\s+(T_[A-Z_]+)\s*=\s*(0x[0-9A-Fa-f]+)/gm;
  const re2 = /^\s*export\s+const\s+OPCODE_(T_[A-Z_]+)\s*=\s*(0x[0-9A-Fa-f]+)/gm;
  let m;
  while ((m = re1.exec(src)) !== null) out.set(m[1], m[2].toLowerCase());
  while ((m = re2.exec(src)) !== null) out.set(m[1], m[2].toLowerCase());
  return out;
}

const dappOpcodes = extractOpcodes(dappSrc);
const workerOpcodes = extractOpcodes(workerSrc);
const ammEnvOpcodes = extractOpcodes(ammEnvSrc);

// Union of all known opcodes. Worker may define opcodes the dapp doesn't
// (e.g. farm constants that live in amm-envelope.js or amm-farm-actions.js),
// so we treat any opcode declared anywhere as a recovery candidate.
const allOpcodes = new Map([
  ...dappOpcodes,
  ...workerOpcodes,
  ...ammEnvOpcodes,
]);

// ---- scanHoldings body extraction ---------------------------------------

// Slice the body of `async function _scanHoldingsImpl(...) { ... }`. Brace
// counting from the first `{` after the function name; stop when depth
// returns to zero.
function extractFunctionBody(src, fnName) {
  const headerRe = new RegExp(`async\\s+function\\s+${fnName}\\s*\\(`);
  const m = headerRe.exec(src);
  if (!m) return null;
  const start = src.indexOf('{', m.index);
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return null;
}

const scanBody = extractFunctionBody(dappSrc, '_scanHoldingsImpl');
if (!scanBody) {
  console.error('FATAL: could not locate _scanHoldingsImpl in dapp/tacit.js');
  process.exit(1);
}

// Strip JS line + block comments so an opcode mentioned only in a comment
// (e.g. "// see T_LP_BOND") can't false-pass as a scanner branch.
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const scanBodyCode = stripComments(scanBody);

// Does scanHoldings recognize this opcode? Accept either:
//   env.opcode === T_FOO
//   opcode === T_FOO
//   case T_FOO:
//   (T_FOO|T_BAR) compound conditions
function scannerHandles(opcodeName, body) {
  const re = new RegExp(`\\b${opcodeName}\\b`);
  return re.test(body);
}

// ---- Allowlist: opcodes that legitimately produce no holdable UTXO ----

// Each entry MUST include a `reason` explaining why scanHoldings doesn't need
// to recognize this opcode. If a new opcode is added that legitimately
// shouldn't be in scanHoldings, add it here with a reason. Anything missing
// from both scanHoldings and this list fails the test.
const ALLOWLIST = {
  // Metadata-only opcodes: produce no recipient-claimable UTXO. The asset
  // they declare is later minted/transferred via T_MINT / T_PMINT / T_CXFER
  // etc., which scanHoldings does handle.
  T_PETCH:           'permissionless-mint deployment record (SPEC §5.8); declares parameters, mints happen via T_PMINT which IS scanned.',
  T_WRAPPER_ATTEST:  'optional on-chain wrapper attestation (SPEC §5.19); pure metadata, no UTXO produced.',

  // Pool-side opcodes: depositor's value moves INTO a pool. The depositor
  // gets no recipient UTXO from this tx — recovery happens on the redeem
  // side (T_WITHDRAW for mixer, T_DCLAIM for drops), which IS scanned.
  T_DEPOSIT:         'mixer pool deposit (SPEC §5.10); value moves into pool, no depositor UTXO; redemption via T_WITHDRAW (scanned).',
  T_DROP:            'public-claim pool deposit (SPEC §5.12); value moves into drop pool, no depositor UTXO; claims via T_DCLAIM (scanned). Reclaim shape produces a UTXO handled via T_DROP parent in pass 2.',

  // Worker-internal opcodes that don't have a dapp surface.
  T_SWAP_BATCH:      'batched uniform-clearing settlement (SPEC §5.16); ceremony-gated, not yet emitted by dapp; per-trader receipts are equivalent to T_SWAP_VAR outputs and will be added when batch ships.',

  // cBTC.tac opcodes that produce only native-BTC outputs (no tacit-asset UTXO
  // to credit). The user recovers their BTC via the standard getUtxos
  // wallet-address scan — no tacit envelope decoding needed.
  T_CBTC_TAC_WITHDRAW:    'SPEC-CBTC-TAC-AMENDMENT §5.37 v1 lien model. Reveal produces ONLY a native BTC payout at vout[0] (slot_denom_sats - fee → recipientAddr). Lien is KV-released by worker; no bond return UTXO under v1. BTC recovery is via standard wallet-address scan, not scanHoldings.',
  T_CBTC_TAC_FORCE_CLOSE: 'SPEC-CBTC-TAC-AMENDMENT §5.38 v1 lien model. Permissionless early-SLASH; reveal produces ONLY a liquidator-marker DUST P2WPKH at vout[0]. No tacit-asset UTXO; reward (if any) accrues via worker ledger under v1. BTC recovery via standard wallet scan.',

  // Farm opcodes. Two categories:
  //   (a) Burn-into-virtual-treasury — produce no tacit UTXO at all.
  //   (b) Worker decree-mint — produce a DUST P2WPKH at vout[1+] whose tacit
  //       value is established by the worker's KV ledger, not by a chain-side
  //       Pedersen-committed envelope output. Openings are PUBLIC in the
  //       envelope (amount + blinding); the gap is that scanHoldings's
  //       ancestry walk (validateOutpoint) fails for these because there's
  //       no tacit-chain ancestor on the input side — the reveal tx spends
  //       only sats + commit P2TR.
  // Proper scanner integration requires either teaching validateOutpoint to
  // recognize farm-decree outputs, or routing them through a new h.farm
  // bucket. Tracked as follow-up to SPEC-AMM-FARM-AMENDMENT §5.45 once the
  // farm code lands (dapp/amm-farm-actions.js is currently uncommitted).
  T_FARM_INIT:    'SPEC-AMM-FARM-AMENDMENT §5.40 (category a). Launcher burns reward-asset UTXO into VIRTUAL treasury (worker KV). Sentinel-case builder produces no change vout — no tacit UTXO recoverable. Refund path (T_FARM_REFUND) handles unspent treasury return.',
  T_LP_BOND:      'SPEC-AMM-FARM-AMENDMENT §5.41 (category a). Bonder burns LP-share UTXO into virtual bond pool; vout[1] P2WPKH(bonder) DUST is a chain-discovery marker, not a tacit-asset UTXO. Bond identity = (revealTxid, 1). LP shares recovered at unbond.',
  T_LP_UNBOND:    'SPEC-AMM-FARM-AMENDMENT §5.42 (category b — decree-mint). vout[1] returns the bonded LP shares (amount from T_LP_BOND ancestry, blinding=lpReturnR PUBLIC); vout[2] reward (amount + rewardR PUBLIC). Scanner integration deferred: validateOutpoint must learn to recognize worker-decree-minted outputs that have no on-chain tacit ancestor.',
  T_LP_HARVEST:   'SPEC-AMM-FARM-AMENDMENT §5.43 (category b — decree-mint). vout[1] reward UTXO with PUBLIC (rewardAmount, rewardR). Scanner integration deferred for the same reason as T_LP_UNBOND: needs validateOutpoint to recognize decree-minted farm outputs.',
  T_FARM_REFUND:  'SPEC-AMM-FARM-AMENDMENT §5.44 (category b — decree-mint). vout[1] refund UTXO with PUBLIC (refundAmount, refundR). Scanner integration deferred (same reason as T_LP_UNBOND/HARVEST).',

  // Slot opcodes. cBTC.zk self-custody slots use a fundamentally different
  // recovery model from the rest of the protocol:
  //
  //   - A slot UTXO sits at K_btc (a P2TR address), NOT at wallet.address().
  //     So scanHoldings's getUtxos(wallet.address()) never sees it.
  //
  //   - K_btc is derived as p2tr(slotXOnly(recipientCommitment, denomination))
  //     where recipientCommitment = pedersenCommit(denomination, secret).
  //     Two of those secrets — `secret` and `nullifierPreimage` — are today
  //     generated with crypto.getRandomValues at 8+ call sites in dapp/tacit.js
  //     (slot mint / burn / rotate / split / merge builders) and persisted only
  //     in localStorage via saveSlotRecord. A clean wipe loses them.
  //
  // Closing the recovery gap requires TWO pieces of work, both architectural:
  //
  //   (1) Deterministic secret derivation. Replace each crypto.getRandomValues
  //       call with HMAC(priv, "tacit-slot-secret-v1" || funding_outpoint) and
  //       HMAC(priv, "tacit-slot-nullifier-v1" || funding_outpoint). For
  //       ROTATE/SPLIT/MERGE, the anchor is the input slot's K_btc outpoint.
  //
  //   (2) A new scanSlots() function distinct from scanHoldings. It enumerates
  //       candidate K_btc addresses by deriving (secret, nullifier) for each
  //       (priv, funding_outpoint, denomination) tuple the user could have
  //       used, and queries chain for any UTXOs at p2tr(slotXOnly(...)).
  //       Found UTXOs are the user's slots; their state (live / redeemed /
  //       rotated) is derived from on-chain spend status.
  //
  // Allowlisted as a unified architectural gap rather than 5 per-opcode
  // scanner stubs because the right fix is the new scanSlots() function +
  // deterministic derivation, not 5 branches in scanHoldings that wouldn't
  // find the slots anyway. Tracked for a focused follow-up alongside the
  // cBTC.zk ceremony finalization (currently slot opcodes are "not shipped
  // on mainnet" per dapp/tacit.js:5152).
  T_SLOT_MINT:    'SPEC-CBTC-ZK-AMENDMENT §5.21. See block comment above on the slot-recovery architecture gap.',
  T_SLOT_BURN:    'SPEC-CBTC-ZK-AMENDMENT §5.22. Slot redeem to native BTC; recovery via scanSlots() architectural follow-up.',
  T_SLOT_ROTATE:  'SPEC-CBTC-ZK-AMENDMENT §5.23. Slot transfer producing a new K_btc; same recovery follow-up.',
  T_SLOT_SPLIT:   'SPEC-CBTC-ZK-FUNGIBILITY-AMENDMENT §5.24. Atomic 1→N slot split; same recovery follow-up.',
  T_SLOT_MERGE:   'SPEC-CBTC-ZK-FUNGIBILITY-AMENDMENT §5.25. Atomic N→1 slot merge; same recovery follow-up.',
};

// ---- Tests --------------------------------------------------------------

console.log(`\nRecovery-parity audit\n=====================\n`);
console.log(`Opcodes discovered: ${allOpcodes.size} (dapp:${dappOpcodes.size}, worker:${workerOpcodes.size}, amm-env:${ammEnvOpcodes.size})\n`);

const sorted = [...allOpcodes.entries()].sort((a, b) => a[1].localeCompare(b[1]));

let scannedCount = 0;
let allowlistedCount = 0;
const missing = [];

for (const [name, hex] of sorted) {
  if (scannerHandles(name, scanBodyCode)) {
    test(`${hex} ${name}: scanner branch present`, () => true);
    scannedCount++;
  } else if (ALLOWLIST[name]) {
    test(`${hex} ${name}: allowlisted (${ALLOWLIST[name].slice(0, 60)}...)`, () => true);
    allowlistedCount++;
  } else {
    test(`${hex} ${name}: NO scanner branch AND not allowlisted`, () => `missing — add a scanHoldings case OR add to ALLOWLIST with a reason`);
    missing.push({ name, hex });
  }
}

// ---- Allowlist hygiene: no stale entries -------------------------------

// If an opcode is in the allowlist but ALSO has a scanner branch, the
// allowlist entry is stale and should be removed.
for (const name of Object.keys(ALLOWLIST)) {
  if (scannerHandles(name, scanBodyCode)) {
    test(`${name}: allowlist entry is stale (scanner now handles it — remove from ALLOWLIST)`, () => `stale allowlist entry`);
  }
  if (!allOpcodes.has(name)) {
    test(`${name}: allowlist entry refers to unknown opcode`, () => `no const ${name} = 0x.. declared anywhere`);
  }
}

// ---- Summary -------------------------------------------------------------

console.log(`\nSummary: ${scannedCount} scanned, ${allowlistedCount} allowlisted, ${missing.length} GAPS`);
if (missing.length > 0) {
  console.log(`\nGap details:`);
  for (const { name, hex } of missing) {
    console.log(`  ${hex} ${name} — declared in dapp/worker but scanHoldings does not recognize it.`);
  }
  console.log(`\nFix path: add an \`else if (env.opcode === ${missing[0].name})\` branch in _scanHoldingsImpl,`);
  console.log(`OR add to ALLOWLIST in this file with a documented reason if the opcode legitimately produces no holdable UTXO.`);
}

console.log(`\n${pass} pass, ${fail} fail\n`);
process.exit(fail === 0 ? 0 : 1);
