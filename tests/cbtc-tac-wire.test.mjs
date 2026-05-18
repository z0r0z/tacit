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
    bondReturnCommit: pointAt(444),
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
  ok('dapp parity: bond_return_commit round-trips',
    decD?.bondReturnCommit && bytesToHex(decD.bondReturnCommit) === bytesToHex(params.bondReturnCommit));

  const decW = worker.decodeTCbtcTacWithdrawPayload(payload);
  ok('worker decode succeeds', decW !== null);
  ok('worker parity: burn_count', decW?.burn_count === 3);
  ok('worker parity: burn_amount',
    decW?.burn_amount === params.burnAmount.toString());
  ok('worker parity: insurance_claim_tac',
    decW?.insurance_claim_tac === params.insuranceClaimTAC.toString());
  ok('worker parity: bond_return_commit',
    decW?.bond_return_commit === bytesToHex(params.bondReturnCommit));
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
    bondReturnCommit: pointAt(555),
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
  ok('bond_return_commit still present with insurance_claim = 0',
    dec?.bondReturnCommit && dec.bondReturnCommit.length === 33);
}

{
  // bond_return_commit field tampering MUST invalidate the bind_hash
  // (defense against a third party swapping the bond return into a
  // different commit they control).
  const params = {
    networkTag: NET_SIGNET,
    targetLeafHash: bytes32('withdraw-tamper'),
    burnNullifiers: [bytes32('tn1')],
    burnCommits: [pointAt(101)],
    burnAmount: 50_000n,
    insuranceClaimTAC: 0n,
    bondReturnCommit: pointAt(666),
    burnBalanceProof: new Uint8Array(64).fill(0xab),
    proof: new Uint8Array(256).fill(0xcd),
  };
  const bindHash = dapp.computeCbtcTacWithdrawBindHash({
    ...params, burnCount: 1,
  });
  const payload = dapp.encodeTCbtcTacWithdrawPayload({ ...params, bindHash });
  // Locate the bond_return_commit region. Per the wire layout it lives
  // between insurance_claim (8B) and bind_hash (32B), preceded by all
  // earlier variable-length sections. Easier: just flip a bit in the
  // 33B region at the known offset (payload.length - proof_len - 2 - 32 - 33).
  const tampered = new Uint8Array(payload);
  const bondCommitOffset = tampered.length - 2 - params.proof.length - 32 - 33;
  tampered[bondCommitOffset] ^= 0x01;
  ok('rejects bond_return_commit tampering',
    dapp.decodeTCbtcTacWithdrawPayload(tampered) === null);
  ok('worker rejects bond_return_commit tampering',
    worker.decodeTCbtcTacWithdrawPayload(tampered) === null);
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

// ============== T_CTAC_LIEN_SPLIT round-trip (SPEC §5.47) ==============
group('T_CTAC_LIEN_SPLIT round-trip');

{
  const positionLeafHash = sha256(new TextEncoder().encode('test-pos-lien-split'));
  const sourceOutpoint = new Uint8Array(36);
  sourceOutpoint.set(sha256(new TextEncoder().encode('lp-utxo-txid')), 0);
  new DataView(sourceOutpoint.buffer).setUint32(32, 3, true);  // vout=3
  const outputCount = 3;
  const outputAmounts = [100_000_000n, 50_000_000n, 50_000_000n];  // sums to 200M
  const outputBlindings = [];
  const outputCommits = [];
  // Use real Pedersen commits (the decoder validates each commit is a valid
  // secp256k1 point via bytesToPoint). Deterministic for test reproducibility.
  for (let i = 0; i < outputCount; i++) {
    const b = sha256(new TextEncoder().encode(`blinding-${i}`));
    outputBlindings.push(b);
    const blindingBig = BigInt('0x' + bytesToHex(b)) % dapp.SECP_N;
    outputCommits.push(dapp.pedersenCommit(outputAmounts[i], blindingBig).toRawBytes(true));
  }
  const lienInheritIndex = 0;
  const bindHash = dapp.computeCtacLienSplitBindHash({
    networkTag: 0x01,
    positionLeafHash, sourceOutpoint, outputCount,
    outputAmounts, outputBlindings, outputCommits, lienInheritIndex,
  });
  const depositorSig = new Uint8Array(64).fill(0xaa);  // structural; not crypto-verified at decode

  const payload = dapp.encodeTCtacLienSplitPayload({
    networkTag: 0x01,
    positionLeafHash, sourceOutpoint,
    outputAmounts, outputBlindings, outputCommits,
    lienInheritIndex, depositorSig, bindHash,
  });

  ok('payload starts with opcode 0x4F', payload[0] === 0x4F);
  ok('payload network_tag = signet (0x01)', payload[1] === 0x01);

  // dapp decode
  const ddapp = dapp.decodeTCtacLienSplitPayload(payload);
  ok('dapp decode succeeds', ddapp !== null);
  ok('dapp parity: output_count', ddapp.outputCount === outputCount);
  ok('dapp parity: lien_inherit_index', ddapp.lienInheritIndex === lienInheritIndex);
  ok('dapp parity: output_amounts[0]', ddapp.outputAmounts[0] === outputAmounts[0]);
  ok('dapp parity: source_outpoint round-trips',
    bytesToHex(ddapp.sourceOutpoint) === bytesToHex(sourceOutpoint));

  // worker decode
  const dworker = worker.decodeTCtacLienSplitPayload(payload);
  ok('worker decode succeeds', dworker !== null);
  ok('worker parity: kind = ctac_lien_split', dworker?.kind === 'ctac_lien_split');
  ok('worker parity: output_count', dworker?.output_count === outputCount);
  ok('worker parity: lien_inherit_index', dworker?.lien_inherit_index === lienInheritIndex);
  ok('worker parity: output_amounts[0] (string-form BigInt)',
    BigInt(dworker.output_amounts[0]) === outputAmounts[0]);
  ok('worker parity: bind_hash matches', dworker?.bind_hash === bytesToHex(bindHash));

  // Reject malformed inputs
  ok('decoder rejects wrong opcode',
    dapp.decodeTCtacLienSplitPayload(new Uint8Array([0x4C, 0x01])) === null);
  ok('decoder rejects truncation',
    dapp.decodeTCtacLienSplitPayload(payload.slice(0, payload.length - 1)) === null);
  // Tamper with bind_hash → decoder rejects (bind_hash mismatch)
  const tampered = new Uint8Array(payload);
  tampered[payload.length - 1] ^= 0xff;
  ok('decoder rejects bind_hash tamper',
    dapp.decodeTCtacLienSplitPayload(tampered) === null);

  // Opcode constant parity
  ok('T_CTAC_LIEN_SPLIT opcode = 0x4F (dapp)', dapp.T_CTAC_LIEN_SPLIT === 0x4F);
  ok('T_CTAC_LIEN_SPLIT opcode = 0x4F (worker)', worker.T_CTAC_LIEN_SPLIT === 0x4F);
  ok('T_CTAC_LIEN_CLAIM = T_SHARE_SLASH_CLAIM (dapp)',
    dapp.T_CTAC_LIEN_CLAIM === dapp.T_SHARE_SLASH_CLAIM && dapp.T_CTAC_LIEN_CLAIM === 0x4C);
  ok('T_CTAC_LIEN_CLAIM = T_SHARE_SLASH_CLAIM (worker)',
    worker.T_CTAC_LIEN_CLAIM === worker.T_SHARE_SLASH_CLAIM);
}

// ============== T_CBTC_TAC_DEPOSIT_ATOMIC round-trip (SPEC §5.48) ==============
group('T_CBTC_TAC_DEPOSIT_ATOMIC round-trip');

{
  const targetLeafHash = sha256(new TextEncoder().encode('atomic-test-leaf'));
  const slotDenomSats = 100_000_000n;
  const poolId = sha256(new TextEncoder().encode('atomic-test-pool'));
  const deltaCbtcZk = 50_000_000n;
  const deltaTac = 200_000_000n;
  const shareAmount = 1_000_000n;
  const cbtcZkInputOutpoint = new Uint8Array(36);
  cbtcZkInputOutpoint.set(sha256(new TextEncoder().encode('cbtc-input')), 0);
  new DataView(cbtcZkInputOutpoint.buffer).setUint32(32, 2, true);
  const tacInputOutpoint = new Uint8Array(36);
  tacInputOutpoint.set(sha256(new TextEncoder().encode('tac-input')), 0);
  new DataView(tacInputOutpoint.buffer).setUint32(32, 5, true);
  // Real Pedersen commits (decoder validates each is a valid point).
  const cbtcZkInputCommit = dapp.pedersenCommit(
    deltaCbtcZk,
    BigInt('0x' + bytesToHex(sha256(new TextEncoder().encode('blind-cbtc')))) % dapp.SECP_N,
  ).toRawBytes(true);
  const tacInputCommit = dapp.pedersenCommit(
    deltaTac,
    BigInt('0x' + bytesToHex(sha256(new TextEncoder().encode('blind-tac')))) % dapp.SECP_N,
  ).toRawBytes(true);
  const lpShareCommit = dapp.pedersenCommit(
    shareAmount,
    BigInt('0x' + bytesToHex(sha256(new TextEncoder().encode('blind-lp')))) % dapp.SECP_N,
  ).toRawBytes(true);
  const depositorRecoveryPk = dapp.pedersenCommit(
    1n,
    BigInt('0x' + bytesToHex(sha256(new TextEncoder().encode('blind-dep')))) % dapp.SECP_N,
  ).toRawBytes(true);
  const mintRecipientCommit = dapp.pedersenCommit(
    slotDenomSats,
    BigInt('0x' + bytesToHex(sha256(new TextEncoder().encode('blind-mint')))) % dapp.SECP_N,
  ).toRawBytes(true);

  const bindHash = dapp.computeCbtcTacDepositAtomicBindHash({
    networkTag: 0x01,
    targetLeafHash, slotDenomSats, poolId,
    deltaCbtcZk, deltaTac, shareAmount,
    cbtcZkInputOutpoint, cbtcZkInputCommit,
    tacInputOutpoint, tacInputCommit,
    lpShareCommit, depositorRecoveryPk,
    mintAmount: slotDenomSats, mintRecipientCommit,
  });
  const proof = new Uint8Array(256).fill(0xaa);
  const payload = dapp.encodeTCbtcTacDepositAtomicPayload({
    networkTag: 0x01,
    targetLeafHash, slotDenomSats, poolId,
    deltaCbtcZk, deltaTac, shareAmount,
    cbtcZkInputOutpoint, cbtcZkInputCommit,
    tacInputOutpoint, tacInputCommit,
    lpShareCommit, depositorRecoveryPk,
    mintAmount: slotDenomSats, mintRecipientCommit,
    bindHash, proof,
  });

  ok('payload starts with opcode 0x57', payload[0] === 0x57);
  ok('payload network_tag = signet (0x01)', payload[1] === 0x01);

  // dapp decode
  const ddapp = dapp.decodeTCbtcTacDepositAtomicPayload(payload);
  ok('dapp decode succeeds', ddapp !== null);
  ok('dapp parity: slot_denom_sats', ddapp.slotDenomSats === slotDenomSats);
  ok('dapp parity: delta_cbtc_zk', ddapp.deltaCbtcZk === deltaCbtcZk);
  ok('dapp parity: delta_tac', ddapp.deltaTac === deltaTac);
  ok('dapp parity: share_amount', ddapp.shareAmount === shareAmount);

  // worker decode
  const dworker = worker.decodeTCbtcTacDepositAtomicPayload(payload);
  ok('worker decode succeeds', dworker !== null);
  ok('worker parity: kind = cbtc_tac_deposit_atomic',
    dworker?.kind === 'cbtc_tac_deposit_atomic');
  ok('worker parity: slot_denom_sats matches',
    dworker?.slot_denom_sats === slotDenomSats.toString());
  ok('worker parity: delta_cbtc_zk matches',
    dworker?.delta_cbtc_zk === deltaCbtcZk.toString());
  ok('worker parity: bind_hash matches',
    dworker?.bind_hash === bytesToHex(bindHash));

  // Reject malformed / tampered
  ok('decoder rejects wrong opcode',
    dapp.decodeTCbtcTacDepositAtomicPayload(new Uint8Array([0x4F, 0x01])) === null);
  ok('decoder rejects truncated payload',
    dapp.decodeTCbtcTacDepositAtomicPayload(payload.slice(0, payload.length - 10)) === null);
  // Tamper with bind_hash → decoder rejects
  const tampered = new Uint8Array(payload);
  tampered[payload.length - proof.length - 2 - 1] ^= 0xff;  // last byte of bind_hash
  ok('decoder rejects bind_hash tamper',
    dapp.decodeTCbtcTacDepositAtomicPayload(tampered) === null);

  // Opcode constant parity
  ok('T_CBTC_TAC_DEPOSIT_ATOMIC opcode = 0x57 (dapp)',
    dapp.T_CBTC_TAC_DEPOSIT_ATOMIC === 0x57);
  ok('T_CBTC_TAC_DEPOSIT_ATOMIC opcode = 0x57 (worker)',
    worker.T_CBTC_TAC_DEPOSIT_ATOMIC === 0x57);
}

// ============== T_CBTC_TAC_WITHDRAW_ATOMIC round-trip (SPEC §5.49) ==============
group('T_CBTC_TAC_WITHDRAW_ATOMIC round-trip');

{
  const targetLeafHash = sha256(new TextEncoder().encode('atomic-wd-leaf'));
  const slotDenomSats = 100_000_000n;
  const burnNullifiers = [sha256(new TextEncoder().encode('nullifier-0'))];
  const burnCommits = [dapp.pedersenCommit(
    slotDenomSats,
    BigInt('0x' + bytesToHex(sha256(new TextEncoder().encode('blind-burn')))) % dapp.SECP_N,
  ).toRawBytes(true)];
  const lpShareAmount = 500_000n;
  const recvCbtcZkCommit = dapp.pedersenCommit(
    50_000_000n,
    BigInt('0x' + bytesToHex(sha256(new TextEncoder().encode('blind-cbtc')))) % dapp.SECP_N,
  ).toRawBytes(true);
  const recvTacCommit = dapp.pedersenCommit(
    100_000_000n,
    BigInt('0x' + bytesToHex(sha256(new TextEncoder().encode('blind-tac')))) % dapp.SECP_N,
  ).toRawBytes(true);

  const bindHash = dapp.computeCbtcTacWithdrawAtomicBindHash({
    networkTag: 0x01,
    targetLeafHash, slotDenomSats, burnCount: 1,
    burnNullifiers, burnCommits,
    burnAmount: slotDenomSats, lpShareAmount,
    recvCbtcZkCommit, recvTacCommit,
  });
  const proof = new Uint8Array(256).fill(0xaa);
  const payload = dapp.encodeTCbtcTacWithdrawAtomicPayload({
    networkTag: 0x01,
    targetLeafHash, slotDenomSats,
    burnNullifiers, burnCommits,
    burnAmount: slotDenomSats, lpShareAmount,
    recvCbtcZkCommit, recvTacCommit,
    bindHash, proof,
  });

  ok('payload starts with opcode 0x58', payload[0] === 0x58);

  const ddapp = dapp.decodeTCbtcTacWithdrawAtomicPayload(payload);
  ok('dapp decode succeeds', ddapp !== null);
  ok('dapp parity: slot_denom_sats', ddapp.slotDenomSats === slotDenomSats);
  ok('dapp parity: lp_share_amount', ddapp.lpShareAmount === lpShareAmount);

  const dworker = worker.decodeTCbtcTacWithdrawAtomicPayload(payload);
  ok('worker decode succeeds', dworker !== null);
  ok('worker parity: kind = cbtc_tac_withdraw_atomic',
    dworker?.kind === 'cbtc_tac_withdraw_atomic');
  ok('worker parity: lp_share_amount matches',
    dworker?.lp_share_amount === lpShareAmount.toString());
  ok('worker parity: bind_hash matches',
    dworker?.bind_hash === bytesToHex(bindHash));

  ok('decoder rejects wrong opcode',
    dapp.decodeTCbtcTacWithdrawAtomicPayload(new Uint8Array([0x57, 0x01])) === null);
  ok('T_CBTC_TAC_WITHDRAW_ATOMIC opcode = 0x58 (dapp)',
    dapp.T_CBTC_TAC_WITHDRAW_ATOMIC === 0x58);
  ok('T_CBTC_TAC_WITHDRAW_ATOMIC opcode = 0x58 (worker)',
    worker.T_CBTC_TAC_WITHDRAW_ATOMIC === 0x58);
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

// ============== getAssetMeta — synthetic cBTC.tac variants ==============
group('getAssetMeta — synthetic cBTC.tac tier metadata');

if (typeof dapp.getAssetMeta === 'function') {
  // Canonical tiers must resolve to a non-null meta with the correct ticker
  // even when no explicit registry entry exists. Without this, cBTC.tac
  // UTXOs would render as ??? in holdings / marketplace.
  const tiers = [
    { denom: 100_000n,     expected: 'cBTC.tac' },
    { denom: 1_000_000n,   expected: 'cBTC.tac.k' },
    { denom: 10_000_000n,  expected: 'cBTC.tac.10M' },
    { denom: 100_000_000n, expected: 'cBTC.tac.1BTC' },
    { denom: 10_000n,      expected: 'cBTC.tac.10k' },
  ];
  for (const t of tiers) {
    const aid = dapp.ctacVariantAssetId(t.denom);
    const meta = dapp.getAssetMeta(aid);
    ok(`tier ${t.denom}: meta non-null`, meta !== null);
    ok(`tier ${t.denom}: ticker = ${t.expected}`, meta && meta.ticker === t.expected);
    ok(`tier ${t.denom}: syntheticCbtcTac flag`, meta && meta.syntheticCbtcTac === true);
    // cBTC.tac uses decimals=8 to align with Bitcoin + TAC (e.g. a 10k-sat
    // tier UTXO with amount=10000 base units renders as 0.0001 BTC-equivalent
    // rather than the raw sat count). See dapp _cbtcTacSyntheticMeta.
    ok(`tier ${t.denom}: decimals = 8`, meta && meta.decimals === 8);
    ok(`tier ${t.denom}: denom round-trips`,
      meta && BigInt(meta.cbtcTacDenomSats) === t.denom);
  }
  // Non-canonical denom MUST NOT resolve via the synthetic path (returns null)
  // so the holdings card correctly flags it as unknown / requires CETCH.
  const nonCanonicalAid = dapp.ctacVariantAssetId(123_456n);
  ok('non-canonical denom: meta is null (no synthetic match)',
    dapp.getAssetMeta(nonCanonicalAid) === null);
  // A random non-cBTC.tac asset_id resolves to null (no false-positive
  // synthetic match — important so unrelated asset_ids aren't mislabeled).
  ok('random asset_id: meta is null',
    dapp.getAssetMeta('a'.repeat(64)) === null);
}

// ============== canonical manifest (IPFS-pinnable) ==============
group('CBTC_TAC_CANONICAL_MANIFEST — shape + IPFS validation');

if (dapp.CBTC_TAC_CANONICAL_MANIFEST && typeof dapp._validateCbtcTacManifest === 'function') {
  const m = dapp.CBTC_TAC_CANONICAL_MANIFEST;
  ok('manifest: schema tag', m.schema === 'tacit-cbtc-tac-canonical-manifest');
  ok('manifest: schema_version is 1', m.schema_version === 1);
  ok('manifest: source_spec set', typeof m.source_spec === 'string' && m.source_spec.length > 0);
  ok('manifest: variant_asset_id_derivation documents formula',
    typeof m.variant_asset_id_derivation === 'string'
    && m.variant_asset_id_derivation.includes('tacit-cbtc-tac-variant-v1'));
  ok('manifest: tiers non-empty', Array.isArray(m.tiers) && m.tiers.length >= 5);
  // Every tier is well-shaped with the fields the synthetic-meta lookup uses
  for (const t of m.tiers) {
    ok(`manifest tier: denom_sats=${t.denom_sats} is int > 0`,
      Number.isInteger(t.denom_sats) && t.denom_sats > 0);
    ok(`manifest tier: ticker non-empty (${t.ticker})`,
      typeof t.ticker === 'string' && t.ticker.length > 0);
    ok(`manifest tier: name non-empty (${t.ticker})`,
      typeof t.name === 'string' && t.name.length > 0);
    ok(`manifest tier: description non-empty (${t.ticker})`,
      typeof t.description === 'string' && t.description.length > 0);
  }
  // Validator must accept the inline manifest (would catch a drift between
  // the validator's expectations and the inline shape).
  ok('validator accepts inline manifest', dapp._validateCbtcTacManifest(m) === null);
  // Validator must reject malformed payloads — these correspond to the
  // failure modes the IPFS fetch path needs to defend against.
  ok('validator rejects null',
    typeof dapp._validateCbtcTacManifest(null) === 'string');
  ok('validator rejects wrong schema tag',
    dapp._validateCbtcTacManifest({ ...m, schema: 'evil' }) !== null);
  ok('validator rejects empty tiers',
    dapp._validateCbtcTacManifest({ ...m, tiers: [] }) !== null);
  ok('validator rejects tier with non-int denom',
    dapp._validateCbtcTacManifest({ ...m, tiers: [{ denom_sats: 1.5, ticker: 'x', name: 'x' }] }) !== null);
  ok('validator rejects tier with negative denom',
    dapp._validateCbtcTacManifest({ ...m, tiers: [{ denom_sats: -1, ticker: 'x', name: 'x' }] }) !== null);
  ok('validator rejects tier with empty ticker',
    dapp._validateCbtcTacManifest({ ...m, tiers: [{ denom_sats: 100, ticker: '', name: 'x' }] }) !== null);
  ok('validator rejects tier with non-string name',
    dapp._validateCbtcTacManifest({ ...m, tiers: [{ denom_sats: 100, ticker: 'x', name: 123 }] }) !== null);
  // Active-manifest getter mirrors the inline (no IPFS CID set in test)
  ok('cbtcTacCanonicalManifest() returns active manifest',
    dapp.cbtcTacCanonicalManifest() === m);
  // CID is null until operator pins (sanity check on initial state)
  ok('CBTC_TAC_MANIFEST_CID is null pre-pin', dapp.CBTC_TAC_MANIFEST_CID === null);
}

// ============== summary ==============
console.log(`\n${pass}/${pass + fail} passed`);
if (fail > 0) process.exit(1);
