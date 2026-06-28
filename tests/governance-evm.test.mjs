// End-to-end test for the EVM-lane (Ethereum shielded TAC / cTAC) governance
// vote path. Uses the REAL dapp confidential-pool primitives (leaf, nullifier,
// merkle path) + a REAL Bulletproofs+ range proof + REAL BIP-340 holder sig;
// only the on-chain reads (currentRoot / nullifierSpent) are mocked. Locks the
// envelope wire format + the worker resolver against the dapp/contract layout,
// and the ownership / membership / freshness / nullifier / scope checks.

import test from 'node:test';
import assert from 'node:assert/strict';

import * as secp from '@noble/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { keccak_256 } from '@noble/hashes/sha3';
import { hexToBytes, bytesToHex, concatBytes } from '@noble/hashes/utils';

import { H as PEDERSEN_H, ZERO as PEDERSEN_ZERO, bpRangeAggProve, bpRangeAggVerify, modN } from './bulletproofs.mjs';
import { signSchnorr, verifySchnorr } from './composition.mjs';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import { decodeCeremonyEligibilityEnvelope, CANONICAL_TAC_ASSET_ID_HEX } from '../worker/src/index.js';
import { buildGovernance, GOV_TIERS, govVoteScopeId } from '../worker/src/governance.js';

const TAC = 100_000_000n;
const enc = (s) => new TextEncoder().encode(s);
const GOV_EVM_DOMAIN = enc('tacit-governance-evm-weight-v1');
const u64LE = (n) => { const b = new Uint8Array(8); let v = BigInt(n); for (let i = 0; i < 8; i++) { b[i] = Number(v & 0xffn); v >>= 8n; } return b; };
const u32LE = (n) => { const b = new Uint8Array(4); let v = (n | 0) >>> 0; for (let i = 0; i < 4; i++) { b[i] = v & 0xff; v >>>= 8; } return b; };
const u16LE = (n) => new Uint8Array([n & 0xff, (n >> 8) & 0xff]);

const pool = makeConfidentialPool({ secp, keccak256: keccak_256, sha256 });
const POOL_ADDR = '0x00000000000000000000000000000000000c0ffe';
const SEL_ROOT = bytesToHex(keccak_256(enc('currentRoot()'))).slice(0, 8);
const SEL_NULL = bytesToHex(keccak_256(enc('nullifierSpent(bytes32)'))).slice(0, 8);

const holderPriv = sha256(enc('gov-evm-holder'));
const holderPub = secp.ProjectivePoint.BASE.multiply(BigInt('0x' + bytesToHex(holderPriv))).toRawBytes(true);
const ownerHex = bytesToHex(holderPub.slice(1)); // x-only = the note owner

// Build a one-note cTAC tree and the EVM weight envelope over it.
function buildEvmEnv({ value, scopeId, tier, asset = CANONICAL_TAC_ASSET_ID_HEX, badOwner = false, spent = false }) {
  const blinding = modN(BigInt('0x' + bytesToHex(sha256(enc('blind' + value)))));
  const { cx, cy } = pool.commitXY(value, blinding);
  const owner = badOwner ? '0x' + 'ab'.repeat(32) : '0x' + ownerHex;
  const leaf = pool.leaf('0x' + asset, cx, cy, owner);
  const T = new pool.Tree();
  const idx = T.insert(leaf);
  const { root, path } = T.rootAndPath(idx);

  const { proof } = bpRangeAggProve([value - tier], [blinding]);
  const attestation = concatBytes(new Uint8Array([0x00]), u64LE(tier), u16LE(proof.length), proof);
  const noteBytes = concatBytes(
    hexToBytes(cx.replace(/^0x/, '')), hexToBytes(cy.replace(/^0x/, '')),
    hexToBytes(owner.replace(/^0x/, '')), u32LE(idx),
    ...path.map((p) => hexToBytes(p.replace(/^0x/, ''))),
  );
  const preceding = concatBytes(
    scopeId, hexToBytes(asset), holderPub, hexToBytes(root.replace(/^0x/, '')),
    new Uint8Array([1]), noteBytes, u16LE(attestation.length), attestation,
  );
  const sig = signSchnorr(sha256(concatBytes(GOV_EVM_DOMAIN, preceding)), holderPriv);
  return { hex: bytesToHex(concatBytes(preceding, sig)), root, nul: pool.nullifier(cx, cy), spent };
}

function kv() {
  const m = new Map();
  return {
    _m: m,
    async get(k, t) { const v = m.get(k); if (v === undefined) return null; return t === 'json' ? JSON.parse(v) : v; },
    async put(k, v) { m.set(k, typeof v === 'string' ? v : String(v)); },
    async delete(k) { m.delete(k); },
    async list({ prefix, limit } = {}) { return { keys: [...m.keys()].filter((k) => !prefix || k.startsWith(prefix)).slice(0, limit || 1000).map((name) => ({ name })), list_complete: true }; },
  };
}

let _spentNow = false;
const env = { REGISTRY_KV: kv(), UPLOAD_KV: kv(), PINATA_JWT: 'x', DAILY_LIMIT: '100' };
const gov = buildGovernance({
  jsonResponse: (obj, status = 200) => ({ status, body: obj }),
  safeInt: (v, fb) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : fb; },
  sha256, concatBytes, bytesToHex, hexToBytes,
  secp, PEDERSEN_H, PEDERSEN_ZERO,
  verifySchnorr, decodeCeremonyEligibilityEnvelope, bpRangeAggVerify,
  commitmentForUtxo: async () => { throw new Error('btc path not used'); },
  apiJson: async () => ({}), chainOutspendProbe: async () => ({ spent: false }),
  fetchTipHeight: async () => 1000, hash160: (b) => b,
  ethCall: async (_net, _to, data) => {
    const sel = data.replace(/^0x/, '').slice(0, 8);
    if (sel === SEL_ROOT) return '0x' + _curRoot;
    return null;
  },
  // nullifierSpent's getter was internalized → read by storage slot (keccak256(ν ‖ uint256(69))).
  ethGetStorageAt: async (_net, _to, _slot) => (_spentNow ? '0x' + '0'.repeat(63) + '1' : '0x' + '0'.repeat(64)),
  keccak256: keccak_256,
  pinFileToIpfs: async () => ({ cid: 'bafyfake' }), filebaseConfigured: () => true,
  CANONICAL_TAC_ASSET_ID_HEX,
  evmPool: pool,
  confidentialPoolAddrFor: () => POOL_ADDR,
});

let _curRoot = '00'.repeat(32);
const NET = 'mainnet';
const mkReq = (body) => ({ method: 'POST', headers: { get: () => null }, json: async () => body });
const mkUrl = (p) => new URL('https://w' + p);

// Seed a proposal directly in KV (the BTC create path is covered elsewhere).
const idHex = bytesToHex(sha256(enc('evm-proposal')));
function seedProposal() {
  env.REGISTRY_KV._m.set(`gov:p:${NET}:${idHex}`, JSON.stringify({
    schema: 'tacit-governance-proposal-v1', id: idHex, network: NET, title: 'EVM probe',
    body: '', choices: ['Yes', 'No'], category: 'general', snapshot_height: 0,
    voting_ends_at: Math.floor(Date.now() / 1000) + 86400, quorum: '0', proposer_pubkey: bytesToHex(holderPub),
    created_at: Math.floor(Date.now() / 1000), tally: { totals: ['0', '0'], voters: 0, total_weight: '0', public_voters: 0, private_voters: 0 }, finalized: false,
  }));
}

test('cTAC private vote: real note + proof verifies and tallies', async () => {
  seedProposal(); _spentNow = false;
  const e = buildEvmEnv({ value: 500n * TAC, scopeId: govVoteScopeId(idHex, 0), tier: GOV_TIERS[1] });
  _curRoot = e.root.replace(/^0x/, '');
  const res = await gov.handle(mkReq({ kind: 'private-eth', choice: 0, weight_envelope: e.hex }), env, mkUrl(`/governance/proposal/${idHex}/vote`), NET, {});
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.weight, GOV_TIERS[1].toString());
  assert.equal(res.body.tally.totals[0], GOV_TIERS[1].toString());
});

test('stale pool_root is rejected', async () => {
  seedProposal();
  const e = buildEvmEnv({ value: 500n * TAC, scopeId: govVoteScopeId(idHex, 0), tier: GOV_TIERS[1] });
  _curRoot = 'ff'.repeat(32); // on-chain root moved
  const res = await gov.handle(mkReq({ kind: 'private-eth', choice: 0, weight_envelope: e.hex }), env, mkUrl(`/governance/proposal/${idHex}/vote`), NET, {});
  assert.equal(res.status, 403);
  assert.match(res.body.error, /stale/);
});

test('spent note is rejected', async () => {
  seedProposal();
  const e = buildEvmEnv({ value: 500n * TAC, scopeId: govVoteScopeId(idHex, 0), tier: GOV_TIERS[1] });
  _curRoot = e.root.replace(/^0x/, ''); _spentNow = true;
  const res = await gov.handle(mkReq({ kind: 'private-eth', choice: 0, weight_envelope: e.hex }), env, mkUrl(`/governance/proposal/${idHex}/vote`), NET, {});
  assert.equal(res.status, 403);
  assert.match(res.body.error, /spent/);
  _spentNow = false;
});

test('note owned by another key is rejected (ownership binding)', async () => {
  seedProposal();
  const e = buildEvmEnv({ value: 500n * TAC, scopeId: govVoteScopeId(idHex, 0), tier: GOV_TIERS[1], badOwner: true });
  _curRoot = e.root.replace(/^0x/, '');
  const res = await gov.handle(mkReq({ kind: 'private-eth', choice: 0, weight_envelope: e.hex }), env, mkUrl(`/governance/proposal/${idHex}/vote`), NET, {});
  assert.equal(res.status, 403);
  // either owner!=holder or (since leaf changes) not-in-tree — both are correct rejections
  assert.ok(/owner|not in pool tree/.test(res.body.error), res.body.error);
});

test('scope binding: a cTAC proof for choice 0 cannot vote choice 1', async () => {
  seedProposal();
  const e = buildEvmEnv({ value: 500n * TAC, scopeId: govVoteScopeId(idHex, 0), tier: GOV_TIERS[1] });
  _curRoot = e.root.replace(/^0x/, '');
  const res = await gov.handle(mkReq({ kind: 'private-eth', choice: 1, weight_envelope: e.hex }), env, mkUrl(`/governance/proposal/${idHex}/vote`), NET, {});
  assert.equal(res.status, 403);
  assert.match(res.body.error, /scope_id mismatch/);
});
