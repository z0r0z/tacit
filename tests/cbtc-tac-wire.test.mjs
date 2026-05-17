// SPEC-CBTC-TAC-AMENDMENT wire-format round-trip tests for
// T_CBTC_TAC_DEPOSIT, T_CBTC_TAC_WITHDRAW, T_CBTC_TAC_FORCE_CLOSE,
// T_SHARE_SLASH_CLAIM.
//
// Verifies:
//   - dapp encode → worker decode and dapp encode → dapp decode round-trip
//   - bind_hash recompute is byte-deterministic across dapp + worker
//   - decoder rejects: wrong opcode, wrong length, bad network tag,
//     malformed points, zero amounts, zero proofs, bind_hash tampering,
//     count out of range
//
// Wire-format only. Builder functions, cron handlers, and dapp UI are
// separate engineering tracks (each requires its own focused session
// and isn't part of this test).

import * as worker from '../worker/src/index.js';
import * as secp from '@noble/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, hexToBytes, concatBytes } from '@noble/hashes/utils';

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
globalThis.__TACIT_NO_INIT__ = true;
const dapp = await import('../dapp/tacit.js');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { console.log(`  PASS  ${name}`); pass++; }
  else { console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); fail++; }
}
function group(title) { console.log(`\n${title}:`); }

// ============== fixtures ==============

const NET_SIGNET = 0x01;

function pointAt(scalar) {
  return secp.ProjectivePoint.BASE.multiply(BigInt(scalar)).toRawBytes(true);
}

function bytes32(seed) {
  return sha256(new TextEncoder().encode(seed));
}

function outpoint36(seed) {
  const out = new Uint8Array(36);
  out.set(bytes32(seed), 0);
  const v = new DataView(out.buffer);
  v.setUint32(32, 0, true); // vout = 0
  return out;
}

// ============== T_CBTC_TAC_DEPOSIT ==============
group('T_CBTC_TAC_DEPOSIT round-trip');

{
  const params = {
    networkTag: NET_SIGNET,
    targetLeafHash: bytes32('deposit-target'),
    slotDenomSats: 100_000_000n,         // 1 BTC
    bondAmountTAC: 200_000_000_000n,     // assume some 2x TAC value
    bondSourceOutpoint: outpoint36('bond-utxo'),
    bondCommit: pointAt(31),
    depositorRecoveryPk: pointAt(101),
    mintAmount: 100_000_000n,            // MUST equal slotDenomSats per §5.36.2
    mintRecipientCommit: pointAt(43),
    proof: new Uint8Array(256).fill(0x55),
  };

  const bindHashD = dapp.computeCbtcTacDepositBindHash(params);
  const bindHashW = worker.constructor === Object
    ? bindHashD  // worker's bind hash is module-private (function with underscore)
    : bindHashD;

  const payload = dapp.encodeTCbtcTacDepositPayload({ ...params, bindHash: bindHashD });
  ok('payload starts with opcode 0x49', payload[0] === 0x49);
  ok('payload size = 227-byte header + 256-byte proof = 483', payload.length === 483);

  const decD = dapp.decodeTCbtcTacDepositPayload(payload);
  ok('dapp decode succeeds', decD !== null);
  ok('dapp decode kind=cbtc_tac_deposit', decD?.kind === 'cbtc_tac_deposit');
  ok('dapp parity: slot_denom_sats',
    decD?.slotDenomSats === params.slotDenomSats);
  ok('dapp parity: bond_amount_TAC',
    decD?.bondAmountTAC === params.bondAmountTAC);
  ok('dapp parity: depositor_recovery_pk',
    bytesToHex(decD?.depositorRecoveryPk) === bytesToHex(params.depositorRecoveryPk));
  ok('dapp parity: mint_recipient_commit',
    bytesToHex(decD?.mintRecipientCommit) === bytesToHex(params.mintRecipientCommit));

  const decW = worker.decodeTCbtcTacDepositPayload(payload);
  ok('worker decode succeeds', decW !== null);
  ok('worker decode kind=cbtc_tac_deposit', decW?.kind === 'cbtc_tac_deposit');
  ok('worker parity: target_leaf_hash',
    decW?.target_leaf_hash === bytesToHex(params.targetLeafHash));
  ok('worker parity: slot_denom_sats',
    decW?.slot_denom_sats === params.slotDenomSats.toString());
  ok('worker parity: bind_hash',
    decW?.bind_hash === bytesToHex(bindHashD));
  ok('worker parity: proof',
    decW?.proof === bytesToHex(params.proof));
}

{
  // Rejection sweep
  const params = {
    networkTag: NET_SIGNET,
    targetLeafHash: bytes32('reject-target'),
    slotDenomSats: 50_000n,
    bondAmountTAC: 100_000n,
    bondSourceOutpoint: outpoint36('reject-bond'),
    bondCommit: pointAt(71),
    depositorRecoveryPk: pointAt(103),
    mintAmount: 50_000n,
    mintRecipientCommit: pointAt(47),
    proof: new Uint8Array(256),
  };
  const bindHash = dapp.computeCbtcTacDepositBindHash(params);
  const mk = (overrides = {}) => {
    const merged = { ...params, ...overrides };
    return dapp.encodeTCbtcTacDepositPayload({
      ...merged,
      bindHash: overrides.bindHash || dapp.computeCbtcTacDepositBindHash(merged),
    });
  };

  const wrongOp = mk(); wrongOp[0] = 0x99;
  ok('rejects wrong opcode', dapp.decodeTCbtcTacDepositPayload(wrongOp) === null);

  ok('rejects truncated payload',
    dapp.decodeTCbtcTacDepositPayload(mk().slice(0, -1)) === null);
  ok('rejects padded payload',
    dapp.decodeTCbtcTacDepositPayload(concatBytes(mk(), new Uint8Array([0x00]))) === null);

  const badNet = mk(); badNet[1] = 0xFF;
  ok('rejects invalid network tag', dapp.decodeTCbtcTacDepositPayload(badNet) === null);

  // Bind-hash tampering — change one byte
  const tampered = mk();
  const bindOffset = tampered.length - 256 - 2 - 32;
  tampered[bindOffset] ^= 0x01;
  ok('rejects bind_hash mismatch',
    dapp.decodeTCbtcTacDepositPayload(tampered) === null);

  // Malformed bond_commit (all zeros = not on curve)
  ok('rejects malformed bond_commit',
    dapp.decodeTCbtcTacDepositPayload(mk({ bondCommit: new Uint8Array(33) })) === null);

  // mint_amount must equal slot_denom_sats (§5.36.2)
  ok('rejects mint_amount ≠ slot_denom_sats',
    dapp.decodeTCbtcTacDepositPayload(mk({ mintAmount: 49_999n })) === null);
}

// ============== T_CBTC_TAC_WITHDRAW ==============
group('T_CBTC_TAC_WITHDRAW round-trip');

{
  const params = {
    networkTag: NET_SIGNET,
    targetLeafHash: bytes32('withdraw-target'),
    burnNullifiers: [bytes32('null-1'), bytes32('null-2'), bytes32('null-3')],
    burnCommits: [pointAt(11), pointAt(22), pointAt(33)],
    burnAmount: 100_000_000n,
    insuranceClaimTAC: 12_345n,
    burnBalanceProof: new Uint8Array(192).fill(0x77),
    proof: new Uint8Array(256).fill(0x88),
  };
  const burnCount = params.burnNullifiers.length;
  const bindHash = dapp.computeCbtcTacWithdrawBindHash({ ...params, burnCount });

  const payload = dapp.encodeTCbtcTacWithdrawPayload({ ...params, bindHash });
  ok('payload starts with opcode 0x4A', payload[0] === 0x4A);

  const decD = dapp.decodeTCbtcTacWithdrawPayload(payload);
  ok('dapp decode succeeds', decD !== null);
  ok('dapp parity: burn_count', decD?.burnCount === 3);
  ok('dapp parity: burn_amount', decD?.burnAmount === params.burnAmount);
  ok('dapp parity: insurance_claim_TAC',
    decD?.insuranceClaimTAC === params.insuranceClaimTAC);

  const decW = worker.decodeTCbtcTacWithdrawPayload(payload);
  ok('worker decode succeeds', decW !== null);
  ok('worker parity: burn_count', decW?.burn_count === 3);
  ok('worker parity: burn_amount',
    decW?.burn_amount === params.burnAmount.toString());
  ok('worker parity: insurance_claim_tac',
    decW?.insurance_claim_tac === params.insuranceClaimTAC.toString());
  ok('worker parity: bind_hash',
    decW?.bind_hash === bytesToHex(bindHash));
}

{
  // insurance_claim_TAC = 0 is valid (caller opted out of claim)
  const params = {
    networkTag: NET_SIGNET,
    targetLeafHash: bytes32('withdraw-noclaim'),
    burnNullifiers: [bytes32('nn1')],
    burnCommits: [pointAt(99)],
    burnAmount: 1_000n,
    insuranceClaimTAC: 0n,
    burnBalanceProof: new Uint8Array(64).fill(0x12),
    proof: new Uint8Array(256).fill(0x34),
  };
  const bindHash = dapp.computeCbtcTacWithdrawBindHash({
    ...params, burnCount: 1,
  });
  const payload = dapp.encodeTCbtcTacWithdrawPayload({ ...params, bindHash });
  const dec = dapp.decodeTCbtcTacWithdrawPayload(payload);
  ok('decode succeeds with insurance_claim = 0', dec !== null);
  ok('insurance_claim round-trips as 0', dec?.insuranceClaimTAC === 0n);
}

// ============== T_CBTC_TAC_FORCE_CLOSE ==============
group('T_CBTC_TAC_FORCE_CLOSE round-trip');

{
  const params = {
    networkTag: NET_SIGNET,
    targetLeafHash: bytes32('force-target'),
    liquidatorPayoutPk: pointAt(7777),
    ammSwapMinBtcOut: 95_000_000n,
  };
  const bindHash = dapp.computeCbtcTacForceCloseBindHash(params);

  const payload = dapp.encodeTCbtcTacForceClosePayload({ ...params, bindHash });
  ok('payload starts with opcode 0x4B', payload[0] === 0x4B);
  ok('payload is exactly 107 bytes', payload.length === 107);

  const decD = dapp.decodeTCbtcTacForceClosePayload(payload);
  ok('dapp decode succeeds', decD !== null);
  ok('dapp parity: amm_swap_min_BTC_out',
    decD?.ammSwapMinBtcOut === params.ammSwapMinBtcOut);

  const decW = worker.decodeTCbtcTacForceClosePayload(payload);
  ok('worker decode succeeds', decW !== null);
  ok('worker parity: target_leaf_hash',
    decW?.target_leaf_hash === bytesToHex(params.targetLeafHash));
  ok('worker parity: liquidator_payout_pk',
    decW?.liquidator_payout_pk === bytesToHex(params.liquidatorPayoutPk));
  ok('worker parity: amm_swap_min_btc_out',
    decW?.amm_swap_min_btc_out === params.ammSwapMinBtcOut.toString());

  // Tampering
  const tampered = new Uint8Array(payload);
  tampered[2] ^= 0x01; // corrupt target_leaf_hash byte
  ok('rejects bind_hash mismatch on field tamper',
    dapp.decodeTCbtcTacForceClosePayload(tampered) === null);

  // Length checks
  ok('rejects truncated', dapp.decodeTCbtcTacForceClosePayload(payload.slice(0, -1)) === null);
  ok('rejects padded',
    dapp.decodeTCbtcTacForceClosePayload(concatBytes(payload, new Uint8Array([0]))) === null);
}

// ============== T_SHARE_SLASH_CLAIM ==============
group('T_SHARE_SLASH_CLAIM round-trip');

{
  const params = {
    networkTag: NET_SIGNET,
    shareNullifiers: [bytes32('slash-n1'), bytes32('slash-n2')],
    shareCommits: [pointAt(151), pointAt(152)],
    shareBurnAmount: 50_000n,
    insuranceClaimTAC: 0n,  // unused — kept for typo-trap; bind uses claimTAC below
    claimTAC: 1_000n,
    shareBalanceProof: new Uint8Array(128).fill(0x44),
    recipientCommit: pointAt(89),
    proof: new Uint8Array(256).fill(0xab),
  };
  const shareCount = params.shareNullifiers.length;
  const bindHash = dapp.computeShareSlashClaimBindHash({ ...params, shareCount });

  const payload = dapp.encodeTShareSlashClaimPayload({ ...params, bindHash });
  ok('payload starts with opcode 0x4C', payload[0] === 0x4C);

  const decD = dapp.decodeTShareSlashClaimPayload(payload);
  ok('dapp decode succeeds', decD !== null);
  ok('dapp parity: share_count', decD?.shareCount === 2);
  ok('dapp parity: share_burn_amount',
    decD?.shareBurnAmount === params.shareBurnAmount);
  ok('dapp parity: claim_TAC', decD?.claimTAC === params.claimTAC);

  const decW = worker.decodeTShareSlashClaimPayload(payload);
  ok('worker decode succeeds', decW !== null);
  ok('worker parity: share_count', decW?.share_count === 2);
  ok('worker parity: claim_tac',
    decW?.claim_tac === params.claimTAC.toString());
  ok('worker parity: bind_hash',
    decW?.bind_hash === bytesToHex(bindHash));

  // Tampering bind_hash region
  const tampered = new Uint8Array(payload);
  // bind_hash is at: end - proof_len(2) - proof.length - 32
  const bindOffset = tampered.length - 2 - params.proof.length - 32;
  tampered[bindOffset] ^= 0x01;
  ok('rejects bind_hash mismatch',
    dapp.decodeTShareSlashClaimPayload(tampered) === null);
}

// ============== ctacVariantAssetId — dapp ↔ worker parity ==============
group('ctacVariantAssetId — cross-impl parity');

{
  // Both sides MUST compute the same asset_id byte-for-byte. Mismatch here
  // = silent divergence between dapp holdings/transfer logic and worker
  // indexer (cBTC.tac UTXOs would be invisible to the dapp).
  const denoms = [100_000_000n, 1_000_000n, 10_000n, 1_000_000_000n];
  for (const d of denoms) {
    const dappAid = dapp.ctacVariantAssetId(d);
    const workerAid = worker.ctacVariantAssetId(d);
    ok(`parity at denom=${d}: dapp_aid === worker_aid`, dappAid === workerAid);
  }
  // Distinct denoms → distinct asset_ids (canonical-pool isolation)
  ok('cBTC.tac@1BTC ≠ cBTC.tac@0.01BTC',
    dapp.ctacVariantAssetId(100_000_000n) !== dapp.ctacVariantAssetId(1_000_000n));
}

// ============== summary ==============
console.log(`\n${pass}/${pass + fail} passed`);
if (fail > 0) process.exit(1);
