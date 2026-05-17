// AMM foundation tests — worker side. Verifies opcode constants, structural
// decoder, KV schema, and POOL_INIT registration. Does NOT exercise the full
// validator (cryptographic gates are staged for follow-up sessions).
//
// Run: `node tests/amm-foundation.test.mjs`

import * as worker from '../worker/src/index.js';
import { encodeLpAdd, OPCODE_T_LP_ADD, OPCODE_T_LP_REMOVE } from './amm-envelope.mjs';
import { XCURVE_PROOF_LEN } from './amm-sigma-xcurve.mjs';
import { OPCODE_T_SWAP_VAR } from './swap-var.mjs';
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

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
