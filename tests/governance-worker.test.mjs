// End-to-end test for the worker governance module (worker/src/governance.js).
//
// Exercises the full lifecycle — createProposal → votePrivate → re-vote dedupe
// → finalize — against the REAL audited threshold-attestation primitive (real
// Bulletproofs+ range proof, real BIP-340 holder sig, real Pedersen homomorphic
// sum). Only the chain/KV/IPFS I/O is stubbed; all crypto is genuine, so this
// pins both the worker lifecycle AND the proposal-id / scope-id derivation that
// the dapp mirror (_gov* in tacit.js) must match byte-for-byte.

import test from 'node:test';
import assert from 'node:assert/strict';

import * as secp from '@noble/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { ripemd160 } from '@noble/hashes/ripemd160';
import { keccak_256 } from '@noble/hashes/sha3';
import { hexToBytes, bytesToHex, concatBytes } from '@noble/hashes/utils';

import {
  H as PEDERSEN_H, ZERO as PEDERSEN_ZERO,
  pedersenCommit, pointToBytes, bpRangeAggProve, bpRangeAggVerify, modN,
} from './bulletproofs.mjs';
import { signSchnorr, verifySchnorr } from './composition.mjs';

import {
  decodeCeremonyEligibilityEnvelope, CANONICAL_TAC_ASSET_ID_HEX,
} from '../worker/src/index.js';
import {
  buildGovernance, GOV_TIERS, GOV_VOTE_DOMAIN, GOV_PROPOSE_DOMAIN,
  govDeriveProposalId, govProposeScopeId, govVoteScopeId,
} from '../worker/src/governance.js';

const hash160 = (b) => ripemd160(sha256(b));
const u64LE = (n) => { const b = new Uint8Array(8); let v = BigInt(n); for (let i = 0; i < 8; i++) { b[i] = Number(v & 0xffn); v >>= 8n; } return b; };
const u32LE = (n) => { const b = new Uint8Array(4); let v = (n | 0) >>> 0; for (let i = 0; i < 4; i++) { b[i] = v & 0xff; v >>>= 8; } return b; };
const u16LE = (n) => new Uint8Array([n & 0xff, (n >> 8) & 0xff]);

// ---- a holder + their TAC UTXO set; chain stubs resolve against this map ----
const TAC = 100_000_000n;
const holderPriv = sha256(new TextEncoder().encode('gov-test-holder-seed'));
const holderPub = secp.ProjectivePoint.BASE.multiply(BigInt('0x' + bytesToHex(holderPriv))).toRawBytes(true);
const holderPubHex = bytesToHex(holderPub);
const utxoDB = new Map(); // "txid:vout" -> { amount, blinding }
function makeUtxo(txidHex, vout, amount) {
  const blinding = modN(BigInt('0x' + bytesToHex(sha256(new TextEncoder().encode(txidHex + vout)))));
  utxoDB.set(`${txidHex}:${vout}`, { amount, blinding });
  return { txid: hexToBytes(txidHex), txidHex, vout, amount, blinding };
}
const bigUtxo = makeUtxo('aa'.repeat(32), 0, 500n * TAC); // covers the 100-TAC propose floor

function buildEnvelope({ utxos, scopeId, tier, sigDomain, expiryHeight = 2000 }) {
  let aggAmount = 0n, aggBlinding = 0n;
  for (const u of utxos) { aggAmount += u.amount; aggBlinding = modN(aggBlinding + modN(u.blinding)); }
  const { proof } = bpRangeAggProve([aggAmount - tier], [aggBlinding]);
  const attestation = concatBytes(new Uint8Array([0x00]), u64LE(tier), u16LE(proof.length), proof);
  const outpoints = new Uint8Array(36 * utxos.length);
  utxos.forEach((u, i) => { outpoints.set(u.txid, i * 36); outpoints.set(u32LE(u.vout), i * 36 + 32); });
  const preceding = concatBytes(
    scopeId, hexToBytes(CANONICAL_TAC_ASSET_ID_HEX), u32LE(expiryHeight),
    new Uint8Array([utxos.length]), outpoints, u16LE(attestation.length), attestation, holderPub,
  );
  const sig = signSchnorr(sha256(concatBytes(sigDomain, preceding)), holderPriv);
  return bytesToHex(concatBytes(preceding, sig));
}

// ---- stubs ----------------------------------------------------------------
function kv() {
  const m = new Map();
  return {
    _m: m,
    async get(k, type) { const v = m.get(k); if (v === undefined) return null; return type === 'json' ? JSON.parse(v) : v; },
    async put(k, v) { m.set(k, typeof v === 'string' ? v : String(v)); },
    async delete(k) { m.delete(k); },
    async list({ prefix, limit } = {}) {
      const keys = [...m.keys()].filter((k) => !prefix || k.startsWith(prefix)).slice(0, limit || 1000).map((name) => ({ name }));
      return { keys };
    },
  };
}
const env = { REGISTRY_KV: kv(), UPLOAD_KV: kv(), PINATA_JWT: 'x', DAILY_LIMIT: '100' };

const gov = buildGovernance({
  jsonResponse: (obj, status = 200) => ({ status, body: obj }),
  safeInt: (v, fb, { min = -Infinity, max = Infinity } = {}) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fb; },
  secp, PEDERSEN_H, PEDERSEN_ZERO,
  verifySchnorr, decodeCeremonyEligibilityEnvelope, bpRangeAggVerify,
  async commitmentForUtxo(_e, txid, vout) {
    const u = utxoDB.get(`${txid}:${vout}`); if (!u) throw new Error('unknown utxo');
    return { asset_id: CANONICAL_TAC_ASSET_ID_HEX, commitment: bytesToHex(pointToBytes(pedersenCommit(u.amount, u.blinding))) };
  },
  async apiJson(_e, path) {
    const m = path.match(/\/tx\/([0-9a-f]{64})/); const vouts = [];
    for (let i = 0; i < 4; i++) vouts.push({ scriptpubkey: '0014' + bytesToHex(hash160(holderPub)) });
    return { vout: vouts, _txid: m && m[1] };
  },
  async chainOutspendProbe() { return { spent: false }; },
  async fetchTipHeight() { return 1000; },
  hash160,
  ethCall: async () => null, keccak256: keccak_256,
  pinFileToIpfs: async () => ({ cid: 'bafyfake' }), filebaseConfigured: () => true,
  CANONICAL_TAC_ASSET_ID_HEX,
});

const NET = 'mainnet';
const mkReq = (method, body) => ({ method, headers: { get: () => null }, json: async () => body });
const mkUrl = (p) => new URL('https://w' + p);

test('governance lifecycle: create → vote → dedupe → finalize', async () => {
  // ---- create ----
  const content = {
    network: NET, title: 'Transfer Collateral Engine admin to 3/5 multisig',
    body: 'Rationale here.', choices: ['Yes', 'No', 'Abstain'], category: 'collateral-engine',
    snapshot_height: 0, voting_ends_at: Math.floor(Date.now() / 1000) + 7 * 86400, quorum: '0',
    proposer_pubkey: holderPubHex, exec_target: '', exec_note: '',
  };
  const { idHex, contentHash } = govDeriveProposalId(content);
  const proposeEnv = buildEnvelope({ utxos: [bigUtxo], scopeId: govProposeScopeId(contentHash), tier: GOV_TIERS[2], sigDomain: GOV_PROPOSE_DOMAIN });

  const createBody = { ...content, propose_envelope: proposeEnv };
  delete createBody.proposer_pubkey; createBody.proposer_pubkey = holderPubHex;
  const created = await gov.handle(mkReq('POST', createBody), env, mkUrl('/governance/proposals'), NET, {});
  assert.equal(created.status, 200, JSON.stringify(created.body));
  assert.equal(created.body.id, idHex);
  assert.equal(created.body.cid, 'bafyfake');

  // ---- vote private (10-TAC tier) on choice 0 ----
  const voteEnv0 = buildEnvelope({ utxos: [bigUtxo], scopeId: govVoteScopeId(idHex, 0), tier: GOV_TIERS[1], sigDomain: GOV_VOTE_DOMAIN });
  const voted = await gov.handle(mkReq('POST', { kind: 'private', choice: 0, weight_envelope: voteEnv0 }), env, mkUrl(`/governance/proposal/${idHex}/vote`), NET, {});
  assert.equal(voted.status, 200, JSON.stringify(voted.body));
  assert.equal(voted.body.weight, (GOV_TIERS[1]).toString());
  assert.equal(voted.body.tally.voters, 1);
  assert.equal(voted.body.tally.totals[0], (GOV_TIERS[1]).toString());

  // ---- scope binding: a proof minted for choice 0 must NOT verify for choice 1 ----
  const bad = await gov.handle(mkReq('POST', { kind: 'private', choice: 1, weight_envelope: voteEnv0 }), env, mkUrl(`/governance/proposal/${idHex}/vote`), NET, {});
  assert.equal(bad.status, 403);
  assert.match(bad.body.error, /scope_id mismatch/);

  // ---- re-vote (same identity, choice 1, fresh proof) → dedupes to one voter ----
  const voteEnv1 = buildEnvelope({ utxos: [bigUtxo], scopeId: govVoteScopeId(idHex, 1), tier: GOV_TIERS[1], sigDomain: GOV_VOTE_DOMAIN });
  const revote = await gov.handle(mkReq('POST', { kind: 'private', choice: 1, weight_envelope: voteEnv1 }), env, mkUrl(`/governance/proposal/${idHex}/vote`), NET, {});
  assert.equal(revote.status, 200, JSON.stringify(revote.body));
  assert.equal(revote.body.revote, true);
  assert.equal(revote.body.tally.voters, 1);                       // still one voter
  assert.equal(revote.body.tally.totals[0], '0');                  // moved off choice 0
  assert.equal(revote.body.tally.totals[1], (GOV_TIERS[1]).toString());

  // ---- finalize before deadline is refused ----
  const early = await gov.handle(mkReq('POST', {}), env, mkUrl(`/governance/proposal/${idHex}/finalize`), NET, {});
  assert.equal(early.status, 409);

  // ---- fast-forward the deadline in KV, then finalize ----
  const rec = JSON.parse(env.REGISTRY_KV._m.get(`gov:p:${NET}:${idHex}`));
  rec.voting_ends_at = Math.floor(Date.now() / 1000) - 10;
  env.REGISTRY_KV._m.set(`gov:p:${NET}:${idHex}`, JSON.stringify(rec));
  const fin = await gov.handle(mkReq('POST', {}), env, mkUrl(`/governance/proposal/${idHex}/finalize`), NET, {});
  assert.equal(fin.status, 200, JSON.stringify(fin.body));
  assert.equal(fin.body.result.winner, 1);
  assert.equal(fin.body.result.winner_choice, 'No');
  assert.equal(fin.body.result.passed, true);
  assert.equal(fin.body.result_cid, 'bafyfake');

  // ---- voting after close is refused ----
  const late = await gov.handle(mkReq('POST', { kind: 'private', choice: 0, weight_envelope: voteEnv0 }), env, mkUrl(`/governance/proposal/${idHex}/vote`), NET, {});
  assert.equal(late.status, 409);
});

test('forged threshold (tier above actual holdings) is rejected by the bulletproof', async () => {
  // Claim the 1000-TAC tier while only holding 500 → (agg − X) underflows the
  // range; bpRangeAggProve produces a proof for a wrapped value the verifier rejects.
  const content = {
    network: NET, title: 'Forgery probe', body: '', choices: ['Yes', 'No'], category: 'general',
    snapshot_height: 0, voting_ends_at: Math.floor(Date.now() / 1000) + 86400, quorum: '0',
    proposer_pubkey: holderPubHex, exec_target: '', exec_note: '',
  };
  const { idHex, contentHash } = govDeriveProposalId(content);
  const proposeEnv = buildEnvelope({ utxos: [bigUtxo], scopeId: govProposeScopeId(contentHash), tier: GOV_TIERS[2], sigDomain: GOV_PROPOSE_DOMAIN });
  await gov.handle(mkReq('POST', { ...content, propose_envelope: proposeEnv }), env, mkUrl('/governance/proposals'), NET, {});

  let threw = false;
  let voteEnv;
  try { voteEnv = buildEnvelope({ utxos: [bigUtxo], scopeId: govVoteScopeId(idHex, 0), tier: GOV_TIERS[3] /* 1000 TAC */, sigDomain: GOV_VOTE_DOMAIN }); }
  catch { threw = true; } // prover may itself refuse the out-of-range value
  if (!threw) {
    const res = await gov.handle(mkReq('POST', { kind: 'private', choice: 0, weight_envelope: voteEnv }), env, mkUrl(`/governance/proposal/${idHex}/vote`), NET, {});
    assert.equal(res.status, 403);
    assert.match(res.body.error, /bulletproof verify failed/);
  }
});
