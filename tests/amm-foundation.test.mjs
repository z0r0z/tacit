// AMM foundation tests — worker side. Verifies opcode constants, structural
// decoder, KV schema, and POOL_INIT registration. Does NOT exercise the full
// validator (cryptographic gates are staged for follow-up sessions).
//
// Run: `node tests/amm-foundation.test.mjs`

import * as worker from '../worker/src/index.js';
import { encodeLpAdd, OPCODE_T_LP_ADD, OPCODE_T_LP_REMOVE } from './amm-envelope.mjs';
import { XCURVE_PROOF_LEN } from './amm-sigma-xcurve.mjs';
import {
  OPCODE_T_SWAP_VAR, ENVELOPE_VERSION as SWAP_VAR_VERSION,
  encodeSwapVar, curveDeltaOut as refCurveDeltaOut,
  computeSwapVarEnvelopeHash, NO_CHANGE_SENTINEL,
} from './swap-var.mjs';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, concatBytes } from '@noble/hashes/utils';
import * as secp from '@noble/secp256k1';

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { console.log(`  PASS  ${name}`); pass++; }
  else { console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); fail++; }
}
function group(title) { console.log(`\n${title}:`); }

// ============== Opcode constants ==============
group('Opcode constants');
ok('T_LP_ADD === 0x2D', worker.T_LP_ADD === 0x2D);
ok('T_LP_REMOVE === 0x2E', worker.T_LP_REMOVE === 0x2E);
ok('T_SWAP_VAR === 0x32', worker.T_SWAP_VAR === 0x32);
ok('worker T_LP_ADD matches reference impl', worker.T_LP_ADD === OPCODE_T_LP_ADD);
ok('worker T_LP_REMOVE matches reference impl', worker.T_LP_REMOVE === OPCODE_T_LP_REMOVE);
ok('worker T_SWAP_VAR matches reference impl', worker.T_SWAP_VAR === OPCODE_T_SWAP_VAR);

// ============== Pool ID derivation ==============
group('ammPoolIdFromAssets (lex-canonical)');
{
  const aHex = bytesToHex(sha256(new TextEncoder().encode('asset-A')));
  const bHex = bytesToHex(sha256(new TextEncoder().encode('asset-B')));
  const idAB = worker.ammPoolIdFromAssets(aHex, bHex);
  const idBA = worker.ammPoolIdFromAssets(bHex, aHex);
  ok('(A,B) and (B,A) produce same pool_id', idAB === idBA);
  ok('pool_id is 64 hex chars', /^[0-9a-f]{64}$/.test(idAB));
  // Deterministic
  const idABAgain = worker.ammPoolIdFromAssets(aHex, bHex);
  ok('pool_id derivation is deterministic', idAB === idABAgain);
}

// ============== KV key shape ==============
group('ammPoolKey schema');
{
  const idHex = '00'.repeat(32);
  ok('signet bare', worker.ammPoolKey('signet', idHex) === `ammpool:${idHex}`);
  ok('mainnet namespaced', worker.ammPoolKey('mainnet', idHex) === `ammpool:mainnet:${idHex}`);
  ok('regtest namespaced', worker.ammPoolKey('regtest', idHex) === `ammpool:regtest:${idHex}`);
}

// ============== Structural decoder ==============
group('decodeTLpAddPayload — variant 1 POOL_INIT');
{
  const assetA = sha256(new TextEncoder().encode('test-asset-a'));
  const assetB = sha256(new TextEncoder().encode('test-asset-b'));
  // Build a structurally-valid T_LP_ADD POOL_INIT envelope.
  // Crypto is junk (decoder doesn't verify) — but byte shape is canonical.
  const sharePub = secp.ProjectivePoint.BASE.multiply(7n).toRawBytes(true);
  const arbiterPub = secp.ProjectivePoint.BASE.multiply(11n).toRawBytes(true);
  const protoFeeAddr = secp.ProjectivePoint.BASE.multiply(13n).toRawBytes(true);
  const payload = encodeLpAdd({
    variant: 1,
    assetA, assetB,
    deltaA: 100_000_000n,
    deltaB: 200_000_000n,
    shareAmount: 100_000_000n,
    shareCSecp: sharePub,
    shareCBJJ: new Uint8Array(32).fill(0x11),
    shareXcurveSigma: new Uint8Array(XCURVE_PROOF_LEN).fill(0x22),
    kernelSigA: new Uint8Array(64).fill(0x33),
    kernelSigB: new Uint8Array(64).fill(0x44),
    feeBps: 30,
    vkCid: 'bafytest',
    ceremonyCid: 'bafyceremony',
    arbiterPubkeys: [arbiterPub],
    arbiterThresholdM: 1,
    launcherSigs: [],
    protocolFeeAddress: protoFeeAddr,
    protocolFeeBps: 50,
    poolMetaUri: 'ipfs://test-meta',
    poolCapabilityFlags: 0,
    proof: new Uint8Array(256).fill(0x55),
  });

  ok('payload starts with opcode 0x2D', payload[0] === 0x2D);
  ok('payload variant byte = 1', payload[1] === 1);

  const dec = worker.decodeTLpAddPayload(payload);
  ok('worker decodes structurally', dec !== null);
  ok('kind === lp_add', dec?.kind === 'lp_add');
  ok('variant === 1', dec?.variant === 1);
  ok('asset_a hex matches', dec?.asset_a === bytesToHex(assetA));
  ok('asset_b hex matches', dec?.asset_b === bytesToHex(assetB));
  ok('delta_a as string', dec?.delta_a === '100000000');
  ok('delta_b as string', dec?.delta_b === '200000000');
  ok('share_amount as string', dec?.share_amount === '100000000');
  ok('fee_bps = 30', dec?.fee_bps === 30);
  ok('vk_cid roundtrip', dec?.vk_cid === 'bafytest');
  ok('ceremony_cid roundtrip', dec?.ceremony_cid === 'bafyceremony');
  ok('arbiter_pubkeys count = 1', (dec?.arbiter_pubkeys || []).length === 1);
  ok('arbiter_threshold_m = 1', dec?.arbiter_threshold_m === 1);
  ok('protocol_fee_bps = 50', dec?.protocol_fee_bps === 50);
  ok('pool_meta_uri roundtrip', dec?.pool_meta_uri === 'ipfs://test-meta');
  ok('pool_capability_flags = 0', dec?.pool_capability_flags === 0);
  ok('proof len 256', dec?.proof?.length === 256 * 2); // hex
}

group('decodeTLpAddPayload — variant 0 standard add');
{
  const assetA = sha256(new TextEncoder().encode('std-a'));
  const assetB = sha256(new TextEncoder().encode('std-b'));
  const sharePub = secp.ProjectivePoint.BASE.multiply(17n).toRawBytes(true);
  const payload = encodeLpAdd({
    variant: 0,
    assetA, assetB,
    deltaA: 1n,
    deltaB: 2n,
    shareAmount: 3n,
    shareCSecp: sharePub,
    shareCBJJ: new Uint8Array(32).fill(0x66),
    shareXcurveSigma: new Uint8Array(XCURVE_PROOF_LEN).fill(0x77),
    kernelSigA: new Uint8Array(64).fill(0x88),
    kernelSigB: new Uint8Array(64).fill(0x99),
    proof: new Uint8Array(256).fill(0xaa),
  });
  const dec = worker.decodeTLpAddPayload(payload);
  ok('variant 0 decodes', dec !== null && dec.variant === 0);
  ok('variant 0 has no fee_bps field', dec?.fee_bps === undefined);
  ok('variant 0 has no vk_cid field', dec?.vk_cid === undefined);
}

group('decodeTLpAddPayload — rejection cases');
{
  ok('null payload → null', worker.decodeTLpAddPayload(null) === null);
  ok('empty payload → null', worker.decodeTLpAddPayload(new Uint8Array(0)) === null);
  ok('wrong opcode → null', worker.decodeTLpAddPayload(new Uint8Array([0x99, 0x00])) === null);
  ok('truncated header → null', worker.decodeTLpAddPayload(new Uint8Array([0x2D, 0x00, 0x01, 0x02])) === null);

  // Build a valid variant 1 payload, then truncate the proof tail
  const assetA = sha256(new TextEncoder().encode('rej-a'));
  const assetB = sha256(new TextEncoder().encode('rej-b'));
  const sharePub = secp.ProjectivePoint.BASE.multiply(23n).toRawBytes(true);
  const arbiterPub = secp.ProjectivePoint.BASE.multiply(29n).toRawBytes(true);
  const fullPayload = encodeLpAdd({
    variant: 1,
    assetA, assetB,
    deltaA: 1n, deltaB: 1n, shareAmount: 1n,
    shareCSecp: sharePub,
    shareCBJJ: new Uint8Array(32),
    shareXcurveSigma: new Uint8Array(XCURVE_PROOF_LEN),
    kernelSigA: new Uint8Array(64),
    kernelSigB: new Uint8Array(64),
    feeBps: 0,
    vkCid: 'x', ceremonyCid: 'y',
    arbiterPubkeys: [arbiterPub],
    arbiterThresholdM: 1,
    launcherSigs: [],
    protocolFeeAddress: new Uint8Array(33),
    protocolFeeBps: 0,
    poolMetaUri: '',
    poolCapabilityFlags: 0,
    proof: new Uint8Array(128).fill(0xbb),
  });
  // Truncate before proof len arrives
  const truncated = fullPayload.slice(0, fullPayload.length - 130);
  ok('truncated proof → null', worker.decodeTLpAddPayload(truncated) === null);
  // Tamper with the trailing byte to misalign proof length
  const tampered = new Uint8Array(fullPayload);
  tampered[tampered.length - 1] = 0xff;
  const dec2 = worker.decodeTLpAddPayload(tampered);
  // This SHOULD succeed structurally — the byte is part of the proof tail
  ok('proof-byte tamper still decodes (proof is opaque to structural decoder)', dec2 !== null);
}

// ============== KV stub round-trip ==============
group('ammPoolGet/ammPoolPut round-trip (in-memory KV stub)');
{
  function makeKvStub() {
    const data = new Map();
    return {
      async get(k, kind) {
        const v = data.get(k);
        if (v === undefined) return null;
        if (kind === 'json') return JSON.parse(v);
        return v;
      },
      async put(k, v) { data.set(k, typeof v === 'string' ? v : JSON.stringify(v)); },
    };
  }
  const env = { REGISTRY_KV: makeKvStub() };
  const poolIdHex = '11'.repeat(32);
  const poolRec = {
    pool_id: poolIdHex,
    asset_a: 'aa'.repeat(32),
    asset_b: 'bb'.repeat(32),
    reserve_a: '100',
    reserve_b: '200',
    fee_bps: 30,
    vk_cid: 'test-vk',
    ceremony_cid: 'test-cer',
    validation: 'structural-only',
  };
  await worker.ammPoolPut(env, 'signet', poolIdHex, poolRec);
  const got = await worker.ammPoolGet(env, 'signet', poolIdHex);
  ok('round-trip pool_id', got?.pool_id === poolIdHex);
  ok('round-trip fee_bps', got?.fee_bps === 30);
  ok('round-trip reserves', got?.reserve_a === '100' && got?.reserve_b === '200');
  ok('round-trip validation tag', got?.validation === 'structural-only');
  ok('missing pool → null', (await worker.ammPoolGet(env, 'signet', '22'.repeat(32))) === null);
}

// ============== Crypto helpers (POOL_INIT validator gates) ==============
group('ammCanonicalAssetPair');
{
  const a = sha256(new TextEncoder().encode('canonical-a'));
  const b = sha256(new TextEncoder().encode('canonical-b'));
  const [low1, high1] = worker.ammCanonicalAssetPair(a, b);
  const [low2, high2] = worker.ammCanonicalAssetPair(b, a);
  ok('canonical pair (A,B) === (B,A) (lex-smaller first)',
    bytesToHex(low1) === bytesToHex(low2) && bytesToHex(high1) === bytesToHex(high2));
  let threwSame = false;
  try { worker.ammCanonicalAssetPair(a, a); } catch { threwSame = true; }
  ok('identical asset_ids throws', threwSame);
}

group('ammDerivePoolId (V3/V4 fee-tier parity)');
{
  const a = sha256(new TextEncoder().encode('feeA'));
  const b = sha256(new TextEncoder().encode('feeB'));
  const id30 = worker.ammDerivePoolId(a, b, 30, 0);
  const id100 = worker.ammDerivePoolId(a, b, 100, 0);
  const id30flag1 = worker.ammDerivePoolId(a, b, 30, 1);
  ok('different fee tier → different pool_id', bytesToHex(id30) !== bytesToHex(id100));
  ok('different capability flags → different pool_id', bytesToHex(id30) !== bytesToHex(id30flag1));
  ok('(A,B,30,0) === (B,A,30,0)', bytesToHex(worker.ammDerivePoolId(b, a, 30, 0)) === bytesToHex(id30));
  let threwBadFee = false;
  try { worker.ammDerivePoolId(a, b, 1001, 0); } catch { threwBadFee = true; }
  ok('fee_bps > 1000 throws', threwBadFee);
  let threwBadFlag = false;
  try { worker.ammDerivePoolId(a, b, 30, 256); } catch { threwBadFlag = true; }
  ok('capability_flags > 255 throws', threwBadFlag);
}

group('ammDeriveLpAssetId');
{
  const a = sha256(new TextEncoder().encode('lpA'));
  const b = sha256(new TextEncoder().encode('lpB'));
  const poolId = worker.ammDerivePoolId(a, b, 30, 0);
  const lpId = worker.ammDeriveLpAssetId(poolId);
  ok('lp_asset_id is 32 bytes', lpId.length === 32);
  ok('lp_asset_id deterministic', bytesToHex(worker.ammDeriveLpAssetId(poolId)) === bytesToHex(lpId));
  ok('different pool_id → different lp_asset_id',
    bytesToHex(worker.ammDeriveLpAssetId(sha256(new TextEncoder().encode('other-pool')))) !== bytesToHex(lpId));
}

group('ammIsqrt (Uniswap V2 init-share floor sqrt)');
{
  ok('isqrt(0) = 0', worker.ammIsqrt(0n) === 0n);
  ok('isqrt(1) = 1', worker.ammIsqrt(1n) === 1n);
  ok('isqrt(2) = 1', worker.ammIsqrt(2n) === 1n);
  ok('isqrt(3) = 1', worker.ammIsqrt(3n) === 1n);
  ok('isqrt(4) = 2', worker.ammIsqrt(4n) === 2n);
  ok('isqrt(8) = 2', worker.ammIsqrt(8n) === 2n);
  ok('isqrt(2e12) = 1_414_213', worker.ammIsqrt(2_000_000_000_000n) === 1_414_213n);
  let threwNeg = false;
  try { worker.ammIsqrt(-1n); } catch { threwNeg = true; }
  ok('isqrt of negative throws', threwNeg);
}

group('ammLpInitShares (founder + locked)');
{
  // 100 × 400 = 40000 → isqrt = 200; founder = 200 - 1000 (ML) → throws
  let threwLow = false;
  try { worker.ammLpInitShares(100n, 400n); } catch { threwLow = true; }
  ok('initial liquidity below ML throws', threwLow);

  // 10000 × 10000 = 1e8 → isqrt = 10000; founder = 9000, locked = 1000
  const big = worker.ammLpInitShares(10_000n, 10_000n);
  ok('total_shares = isqrt(Δa·Δb) = 10000', big.total_shares === 10_000n);
  ok('founder_shares = total - ML (= 9000)', big.founder_shares === 9_000n);
  ok('locked_shares = ML (= 1000)', big.locked_shares === worker.AMM_MINIMUM_LIQUIDITY);
}

group('ammLauncherGateMsg');
{
  const poolId = sha256(new TextEncoder().encode('gate-pool'));
  const msg = worker.ammLauncherGateMsg(poolId, 'bafy-vk', 30);
  ok('gate_msg is 32 bytes', msg.length === 32);
  // Deterministic
  const msg2 = worker.ammLauncherGateMsg(poolId, 'bafy-vk', 30);
  ok('gate_msg deterministic', bytesToHex(msg) === bytesToHex(msg2));
  // Domain-bound
  const msg3 = worker.ammLauncherGateMsg(poolId, 'bafy-other-vk', 30);
  ok('different vk_cid → different gate_msg', bytesToHex(msg) !== bytesToHex(msg3));
  const msg4 = worker.ammLauncherGateMsg(poolId, 'bafy-vk', 100);
  ok('different fee_bps → different gate_msg', bytesToHex(msg) !== bytesToHex(msg4));
}

// ============== T_SWAP_VAR ==============
group('T_SWAP_VAR — curve recompute parity (worker vs reference)');
{
  // A → B, balanced reserves, 30 bps fee
  const ra = 1_000_000n, rb = 2_000_000n, din = 50_000n;
  const ref = refCurveDeltaOut({ direction: 0, R_A_pre: ra, R_B_pre: rb, delta_in: din, fee_bps: 30 });
  const wrk = worker.ammCurveDeltaOut(0, ra, rb, din, 30);
  ok('delta_out matches ref', wrk.deltaOut === ref.deltaOut);
  ok('raPost matches ref', wrk.raPost === ref.raPost);
  ok('rbPost matches ref', wrk.rbPost === ref.rbPost);

  // B → A direction
  const wrk2 = worker.ammCurveDeltaOut(1, ra, rb, din, 30);
  const ref2 = refCurveDeltaOut({ direction: 1, R_A_pre: ra, R_B_pre: rb, delta_in: din, fee_bps: 30 });
  ok('B→A delta_out matches', wrk2.deltaOut === ref2.deltaOut);
  ok('B→A raPost matches', wrk2.raPost === ref2.raPost);
  ok('B→A rbPost matches', wrk2.rbPost === ref2.rbPost);

  // 0 fee tier
  const wrk0 = worker.ammCurveDeltaOut(0, 1000n, 1000n, 100n, 0);
  const ref0 = refCurveDeltaOut({ direction: 0, R_A_pre: 1000n, R_B_pre: 1000n, delta_in: 100n, fee_bps: 0 });
  ok('0-bps fee parity', wrk0.deltaOut === ref0.deltaOut);

  // Bad inputs
  let threwBadDir = false;
  try { worker.ammCurveDeltaOut(2, 100n, 100n, 1n, 30); } catch { threwBadDir = true; }
  ok('bad direction throws', threwBadDir);
  let threwZero = false;
  try { worker.ammCurveDeltaOut(0, 0n, 100n, 1n, 30); } catch { threwZero = true; }
  ok('zero reserve throws', threwZero);
}

group('T_SWAP_VAR — decoder round-trip via reference encoder');
{
  const ra = 5_000_000n, rb = 10_000_000n, din = 100_000n;
  const ref = refCurveDeltaOut({ direction: 0, R_A_pre: ra, R_B_pre: rb, delta_in: din, fee_bps: 30 });
  // Build a valid SwapVar envelope using the reference encoder
  const poolId = sha256(new TextEncoder().encode('test-swap-pool'));
  const traderPub = secp.ProjectivePoint.BASE.multiply(7n).toRawBytes(true);
  const cIn = secp.ProjectivePoint.BASE.multiply(31n).toRawBytes(true);
  const cChange = secp.ProjectivePoint.BASE.multiply(41n).toRawBytes(true);
  const cReceipt = secp.ProjectivePoint.BASE.multiply(43n).toRawBytes(true);
  const rReceipt = new Uint8Array(32).fill(0x11);
  const rangeProof = new Uint8Array(700).fill(0x22);  // m=2 bulletproof size
  const kernelSig = new Uint8Array(64).fill(0x33);
  const intentSig = new Uint8Array(64).fill(0x44);

  const payload = encodeSwapVar({
    poolId, direction: 0, R_A_pre: ra, R_B_pre: rb,
    deltaIn: din, deltaInMin: 50_000n, deltaInMax: 150_000n,
    deltaOut: ref.deltaOut, minOut: ref.deltaOut - 100n,
    tipAmount: 0n, tipAsset: 0, expiryHeight: 1_000_000,
    traderPubkey: traderPub, cInSecp: cIn,
    cChangeOrSentinel: cChange, cReceiptSecp: cReceipt,
    rReceipt, rangeProof, kernelSig, intentSig,
  });
  ok('payload starts with version 0x01', payload[0] === SWAP_VAR_VERSION);
  ok('payload[1] opcode 0x32', payload[1] === 0x32);

  const dec = worker.decodeTSwapVarPayload(payload);
  ok('worker decodes', dec !== null);
  ok('kind = swap_var', dec?.kind === 'swap_var');
  ok('pool_id round-trip', dec?.pool_id === bytesToHex(poolId));
  ok('direction = 0', dec?.direction === 0);
  ok('R_A_pre as string', dec?.R_A_pre === ra.toString());
  ok('R_B_pre as string', dec?.R_B_pre === rb.toString());
  ok('delta_in as string', dec?.delta_in === din.toString());
  ok('delta_out as string', dec?.delta_out === ref.deltaOut.toString());
  ok('expiry_height', dec?.expiry_height === 1_000_000);
  ok('trader_pubkey hex', dec?.trader_pubkey === bytesToHex(traderPub));
  ok('range_proof hex length 1400', dec?.range_proof?.length === 1400);  // 700 bytes * 2 hex
  ok('kernel_sig hex length 128', dec?.kernel_sig?.length === 128);
  ok('intent_sig hex length 128', dec?.intent_sig?.length === 128);

  // Envelope hash binding
  const expected = bytesToHex(computeSwapVarEnvelopeHash(payload));
  const got = bytesToHex(worker.ammSwapVarEnvelopeHash(payload));
  ok('envelope_hash matches reference', expected === got);
}

group('T_SWAP_VAR — decoder rejection cases');
{
  ok('null payload → null', worker.decodeTSwapVarPayload(null) === null);
  ok('empty payload → null', worker.decodeTSwapVarPayload(new Uint8Array(0)) === null);
  ok('wrong version → null',
    worker.decodeTSwapVarPayload(new Uint8Array(300).fill(0xff)) === null);
  // Wrong opcode
  const bad = new Uint8Array(300).fill(0x00);
  bad[0] = SWAP_VAR_VERSION;
  bad[1] = 0x99;
  ok('wrong opcode → null', worker.decodeTSwapVarPayload(bad) === null);
}

group('T_SWAP_VAR — NO_CHANGE_SENTINEL accepted');
{
  const poolId = sha256(new TextEncoder().encode('sentinel-pool'));
  const traderPub = secp.ProjectivePoint.BASE.multiply(7n).toRawBytes(true);
  const cIn = secp.ProjectivePoint.BASE.multiply(31n).toRawBytes(true);
  const cReceipt = secp.ProjectivePoint.BASE.multiply(43n).toRawBytes(true);
  const payload = encodeSwapVar({
    poolId, direction: 1, R_A_pre: 1000n, R_B_pre: 1000n,
    deltaIn: 100n, deltaInMin: 100n, deltaInMax: 100n,
    deltaOut: refCurveDeltaOut({ direction: 1, R_A_pre: 1000n, R_B_pre: 1000n, delta_in: 100n, fee_bps: 0 }).deltaOut,
    minOut: 0n, tipAmount: 0n, tipAsset: 1, expiryHeight: 999_999,
    traderPubkey: traderPub, cInSecp: cIn,
    cChangeOrSentinel: NO_CHANGE_SENTINEL, cReceiptSecp: cReceipt,
    rReceipt: new Uint8Array(32),
    rangeProof: new Uint8Array(700).fill(0x55),
    kernelSig: new Uint8Array(64),
    intentSig: new Uint8Array(64),
  });
  const dec = worker.decodeTSwapVarPayload(payload);
  ok('payload with sentinel decodes', dec !== null);
  // 33 zero bytes → 66 hex zeros
  ok('c_change_or_sentinel is all zero hex',
    dec?.c_change_or_sentinel === '00'.repeat(33));
}

// ============== T_LP_ADD variant 0 + T_LP_REMOVE arithmetic ==============
group('ammLpAddShares (variant 0 proportional join)');
{
  // Pool: 1M / 4M reserves, 2M total shares. LP joins at-ratio with
  // 100k / 400k → expected shares = floor(100k · 2M / 1M) = 200k
  // (or floor(400k · 2M / 4M) = 200k; both sides agree at-ratio).
  const got = worker.ammLpAddShares(100_000n, 400_000n, 1_000_000n, 4_000_000n, 2_000_000n);
  ok('at-ratio LP gets proportional shares', got === 200_000n);

  // Off-ratio: 100k / 500k vs reserves 1M / 4M → A-side = 200k, B-side = 250k.
  // floor(min) = 200k. The 50k B-side excess donates to existing LPs.
  const off = worker.ammLpAddShares(100_000n, 500_000n, 1_000_000n, 4_000_000n, 2_000_000n);
  ok('off-ratio LP gets the smaller side', off === 200_000n);

  let threwInit = false;
  try { worker.ammLpAddShares(1n, 1n, 0n, 0n, 0n); } catch { threwInit = true; }
  ok('S == 0 throws (POOL_INIT path)', threwInit);
}

group('ammLpRemoveOutputs (proportional withdraw)');
{
  // Burn 250k shares from a 2M total over 1M / 4M reserves:
  //   deltaA = 1M · 250k / 2M = 125k
  //   deltaB = 4M · 250k / 2M = 500k
  const got = worker.ammLpRemoveOutputs(250_000n, 1_000_000n, 4_000_000n, 2_000_000n);
  ok('deltaA = floor(R_A · sa / S)', got.deltaA === 125_000n);
  ok('deltaB = floor(R_B · sa / S)', got.deltaB === 500_000n);

  // Over-burn rejected
  let threwOver = false;
  try { worker.ammLpRemoveOutputs(3_000_000n, 1_000_000n, 4_000_000n, 2_000_000n); } catch { threwOver = true; }
  ok('over-burn (sa > S) throws', threwOver);

  // Empty pool rejected
  let threwEmpty = false;
  try { worker.ammLpRemoveOutputs(1n, 0n, 0n, 0n); } catch { threwEmpty = true; }
  ok('empty pool (S == 0) throws', threwEmpty);
}

group('decodeTLpRemovePayload structural round-trip');
{
  // The reference encoder for T_LP_REMOVE lives in tests/amm-envelope.mjs.
  // Reuse it to build a structurally-valid payload and round-trip.
  const { encodeLpRemove } = await import('./amm-envelope.mjs');
  const assetA = sha256(new TextEncoder().encode('lprm-a'));
  const assetB = sha256(new TextEncoder().encode('lprm-b'));
  const pubA = secp.ProjectivePoint.BASE.multiply(3n).toRawBytes(true);
  const pubB = secp.ProjectivePoint.BASE.multiply(5n).toRawBytes(true);
  const payload = encodeLpRemove({
    assetA, assetB,
    shareAmount: 250_000n,
    deltaA: 125_000n, deltaB: 500_000n,
    recvACSecp: pubA,
    recvACBJJ: new Uint8Array(32).fill(0x11),
    recvAXcurveSigma: new Uint8Array(XCURVE_PROOF_LEN).fill(0x22),
    recvBCSecp: pubB,
    recvBCBJJ: new Uint8Array(32).fill(0x33),
    recvBXcurveSigma: new Uint8Array(XCURVE_PROOF_LEN).fill(0x44),
    kernelSigLP: new Uint8Array(64).fill(0x55),
    proof: new Uint8Array(192).fill(0x66),
  });
  ok('payload[0] === 0x2E', payload[0] === 0x2E);
  const dec = worker.decodeTLpRemovePayload(payload);
  ok('worker decodes', dec !== null);
  ok('kind = lp_remove', dec?.kind === 'lp_remove');
  ok('asset_a hex matches', dec?.asset_a === bytesToHex(assetA));
  ok('asset_b hex matches', dec?.asset_b === bytesToHex(assetB));
  ok('share_amount string', dec?.share_amount === '250000');
  ok('delta_a string', dec?.delta_a === '125000');
  ok('delta_b string', dec?.delta_b === '500000');
  ok('recv_a_c_secp hex', dec?.recv_a_c_secp === bytesToHex(pubA));
  ok('recv_b_c_secp hex', dec?.recv_b_c_secp === bytesToHex(pubB));
  ok('kernel_sig_lp hex 128 chars', dec?.kernel_sig_lp?.length === 128);
  ok('proof hex 384 chars', dec?.proof?.length === 384);  // 192 * 2

  // Rejection cases
  ok('null → null', worker.decodeTLpRemovePayload(null) === null);
  ok('wrong opcode → null',
    worker.decodeTLpRemovePayload(new Uint8Array([0x99, 0x00, 0x00])) === null);
  ok('truncated → null',
    worker.decodeTLpRemovePayload(new Uint8Array(10).fill(0x2E)) === null);
}

// ============== Dapp T_SWAP_VAR wire primitives (cross-impl parity) ==============
group('Dapp T_SWAP_VAR encoder → worker decoder parity');
{
  // Load dapp module with JSDOM globals.
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

  ok('dapp T_SWAP_VAR = 0x32', dapp.T_SWAP_VAR === 0x32);
  ok('dapp SWAP_VAR_ENVELOPE_VERSION = 0x01', dapp.SWAP_VAR_ENVELOPE_VERSION === 0x01);

  // Dapp pool ID derivation matches worker
  const a = sha256(new TextEncoder().encode('parity-A'));
  const b = sha256(new TextEncoder().encode('parity-B'));
  const dappPoolId = dapp.ammDerivePoolIdDapp(a, b, 30, 0);
  const workerPoolId = worker.ammDerivePoolId(a, b, 30, 0);
  ok('dapp ↔ worker pool_id parity',
    bytesToHex(dappPoolId) === bytesToHex(workerPoolId));

  // Dapp curve recompute matches worker
  const dappCurve = dapp.swapVarCurveDeltaOut(0, 1_000_000n, 2_000_000n, 50_000n, 30);
  const workerCurve = worker.ammCurveDeltaOut(0, 1_000_000n, 2_000_000n, 50_000n, 30);
  ok('dapp ↔ worker delta_out parity', dappCurve.deltaOut === workerCurve.deltaOut);
  ok('dapp ↔ worker raPost parity', dappCurve.raPost === workerCurve.raPost);
  ok('dapp ↔ worker rbPost parity', dappCurve.rbPost === workerCurve.rbPost);

  // Build a valid SwapVar envelope via dapp encoder, decode with worker
  const poolId = sha256(new TextEncoder().encode('parity-pool'));
  const traderPub = secp.ProjectivePoint.BASE.multiply(13n).toRawBytes(true);
  const cIn = secp.ProjectivePoint.BASE.multiply(17n).toRawBytes(true);
  const cChange = secp.ProjectivePoint.BASE.multiply(19n).toRawBytes(true);
  const cReceipt = secp.ProjectivePoint.BASE.multiply(23n).toRawBytes(true);
  const ra = 5_000_000n, rb = 10_000_000n, din = 100_000n;
  const expectedOut = worker.ammCurveDeltaOut(0, ra, rb, din, 30).deltaOut;

  const payload = dapp.encodeTSwapVarPayload({
    poolId, direction: 0, R_A_pre: ra, R_B_pre: rb,
    deltaIn: din, deltaInMin: 50_000n, deltaInMax: 150_000n,
    deltaOut: expectedOut, minOut: expectedOut - 100n,
    tipAmount: 0n, tipAsset: 0, expiryHeight: 1_000_000,
    traderPubkey: traderPub, cInSecp: cIn,
    cChangeOrSentinel: cChange, cReceiptSecp: cReceipt,
    rReceipt: new Uint8Array(32).fill(0x77),
    rangeProof: new Uint8Array(700).fill(0x88),
    kernelSig: new Uint8Array(64).fill(0x99),
    intentSig: new Uint8Array(64).fill(0xaa),
  });
  ok('dapp-encoded payload[0] = 0x01 (version)', payload[0] === 0x01);
  ok('dapp-encoded payload[1] = 0x32 (opcode)', payload[1] === 0x32);

  const decW = worker.decodeTSwapVarPayload(payload);
  ok('worker decodes dapp-encoded payload', decW !== null);
  ok('worker R_A_pre parity', decW?.R_A_pre === ra.toString());
  ok('worker delta_out parity', decW?.delta_out === expectedOut.toString());
  ok('worker pool_id parity',
    decW?.pool_id === bytesToHex(poolId));

  // Dapp self-roundtrip
  const decD = dapp.decodeTSwapVarPayload(payload);
  ok('dapp decodes its own encoded payload', decD !== null);
  ok('dapp R_A_pre parity', decD?.R_A_pre === ra);  // dapp returns bigint
  ok('dapp delta_out parity', decD?.deltaOut === expectedOut);

  // Envelope hash parity
  const dappHash = bytesToHex(dapp.computeSwapVarEnvelopeHash(payload));
  const workerHash = bytesToHex(worker.ammSwapVarEnvelopeHash(payload));
  ok('dapp ↔ worker envelope hash parity', dappHash === workerHash);
}

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
