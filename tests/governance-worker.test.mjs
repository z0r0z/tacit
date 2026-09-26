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
const txHeight = new Map(); // txid -> confirmation height (default 900, before the snapshot)
const outspends = new Map(); // "txid:vout" -> probe result (default unspent)
function makeUtxo(txidHex, vout, amount, height = 900) {
  const blinding = modN(BigInt('0x' + bytesToHex(sha256(new TextEncoder().encode(txidHex + vout)))));
  utxoDB.set(`${txidHex}:${vout}`, { amount, blinding });
  txHeight.set(txidHex, height);
  return { txid: hexToBytes(txidHex), txidHex, vout, amount, blinding };
}
const bigUtxo = makeUtxo('aa'.repeat(32), 0, 500n * TAC); // covers the 100-TAC propose floor

function buildEnvelope({ utxos, scopeId, tier, sigDomain, expiryHeight = 2000, pub = holderPub, priv = holderPriv }) {
  let aggAmount = 0n, aggBlinding = 0n;
  for (const u of utxos) { aggAmount += u.amount; aggBlinding = modN(aggBlinding + modN(u.blinding)); }
  const { proof } = bpRangeAggProve([aggAmount - tier], [aggBlinding]);
  const attestation = concatBytes(new Uint8Array([0x00]), u64LE(tier), u16LE(proof.length), proof);
  const outpoints = new Uint8Array(36 * utxos.length);
  utxos.forEach((u, i) => { outpoints.set(u.txid, i * 36); outpoints.set(u32LE(u.vout), i * 36 + 32); });
  const preceding = concatBytes(
    scopeId, hexToBytes(CANONICAL_TAC_ASSET_ID_HEX), u32LE(expiryHeight),
    new Uint8Array([utxos.length]), outpoints, u16LE(attestation.length), attestation, pub,
  );
  const sig = signSchnorr(sha256(concatBytes(sigDomain, preceding)), priv);
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
const TIP = 1000;
const ownerOf = new Map(); // txid -> pubkey that owns its outputs (default: the holder)
let ethHead = 5000;
const ethCalls = [];
let ethBalanceAt = () => null;
let rpcStub = () => null;

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
    const owner = ownerOf.get(m && m[1]) || holderPub;
    for (let i = 0; i < 4; i++) vouts.push({ scriptpubkey: '0014' + bytesToHex(hash160(owner)) });
    return { vout: vouts, _txid: m && m[1], status: { confirmed: true, block_height: txHeight.get(m && m[1]) ?? 900 } };
  },
  async chainOutspendProbe(_e, _n, txid, vout) { return outspends.get(`${txid}:${vout}`) || { spent: false }; },
  async fetchTipHeight() { return TIP; },
  hash160,
  ethCall: async () => null, keccak256: keccak_256,
  ethBlockNumber: async () => ethHead,
  ethRpc: async (_n, method, params) => rpcStub(method, params),
  ethCallAt: async (_env, _net, to, data, blockTag) => { ethCalls.push({ to, data, blockTag }); return ethBalanceAt(blockTag); },
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
    snapshot_height: TIP, voting_ends_at: Math.floor(Date.now() / 1000) + 7 * 86400, quorum: '0',
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
    snapshot_height: TIP, voting_ends_at: Math.floor(Date.now() / 1000) + 86400, quorum: '0',
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

// ---- snapshots -------------------------------------------------------------
async function createAt(title, extra = {}) {
  const content = {
    network: NET, title, body: '', choices: ['Yes', 'No'], category: 'general',
    snapshot_height: TIP, voting_ends_at: Math.floor(Date.now() / 1000) + 86400, quorum: '0',
    proposer_pubkey: holderPubHex, exec_target: '', exec_note: '', ...extra,
  };
  const { idHex, contentHash } = govDeriveProposalId(content);
  const proposeEnv = buildEnvelope({ utxos: [bigUtxo], scopeId: govProposeScopeId(contentHash), tier: GOV_TIERS[2], sigDomain: GOV_PROPOSE_DOMAIN });
  const res = await gov.handle(mkReq('POST', { ...content, propose_envelope: proposeEnv }), env, mkUrl('/governance/proposals'), NET, {});
  return { res, idHex };
}
const castPrivate = (idHex, utxos, extra = {}) => gov.handle(mkReq('POST', {
  kind: 'private', choice: 0,
  weight_envelope: buildEnvelope({ utxos, scopeId: govVoteScopeId(idHex, 0), tier: GOV_TIERS[1], sigDomain: GOV_VOTE_DOMAIN, ...extra }),
}), env, mkUrl(`/governance/proposal/${idHex}/vote`), NET, {});

test('snapshot: a proposal must snapshot the current tip', async () => {
  for (const h of [TIP - 13, TIP + 1, 0]) {
    const { res } = await createAt(`stale ${h}`, { snapshot_height: h });
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.match(res.body.error, /current Bitcoin tip/);
  }
  const { res } = await createAt('fresh', { snapshot_height: TIP - 12 });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.proposal.eth_snapshot_block, ethHead - 12);
});

test('snapshot: coins confirmed after it do not vote, so moving TAC to a new key cannot vote twice', async () => {
  const { idHex } = await createAt('double vote probe');
  // The holder votes with coins held at the snapshot…
  const first = await castPrivate(idHex, [bigUtxo]);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  // …then moves them to a second key. The new output is confirmed after the snapshot.
  const priv2 = sha256(new TextEncoder().encode('gov-test-second-key'));
  const pub2 = secp.ProjectivePoint.BASE.multiply(BigInt('0x' + bytesToHex(priv2))).toRawBytes(true);
  const moved = makeUtxo('bb'.repeat(32), 0, 500n * TAC, TIP + 3);
  ownerOf.set('bb'.repeat(32), pub2);
  const second = await castPrivate(idHex, [moved], { pub: pub2, priv: priv2 });
  assert.equal(second.status, 403, JSON.stringify(second.body));
  assert.match(second.body.error, /not confirmed by the snapshot/);
  // The same coins spent before the snapshot never counted; spent after it, the owner at the snapshot votes.
  outspends.set(`${'aa'.repeat(32)}:0`, { spent: true, depth: 5, spent_at_height: TIP - 1 });
  const spentBefore = await castPrivate(idHex, [bigUtxo]);
  assert.equal(spentBefore.status, 403, JSON.stringify(spentBefore.body));
  assert.match(spentBefore.body.error, /spent by the snapshot/);
  outspends.set(`${'aa'.repeat(32)}:0`, { spent: true, depth: 2, spent_at_height: TIP + 3 });
  assert.equal((await castPrivate(idHex, [bigUtxo])).status, 200);
  outspends.set(`${'aa'.repeat(32)}:0`, { spent: true, depth: 0 });
  assert.equal((await castPrivate(idHex, [bigUtxo])).status, 200, 'a mempool spend is after the snapshot');
  outspends.set(`${'aa'.repeat(32)}:0`, { spent: true, depth: 1 });
  assert.equal((await castPrivate(idHex, [bigUtxo])).status, 403, 'a confirmed spend of unknown height fails closed');
  outspends.delete(`${'aa'.repeat(32)}:0`);
});

test('public votes: balance at the snapshot block, in the same units as private tiers', async () => {
  env.GOV_TAC_ERC20_MAINNET = '0xa1313eb9f3a445606d9583bcac3ebeb56a858279';
  const { idHex } = await createAt('public probe');
  const ethPriv = sha256(new TextEncoder().encode('gov-test-eth-voter'));
  const ethPub = secp.getPublicKey(ethPriv, false);
  const addr = '0x' + bytesToHex(keccak_256(ethPub.slice(1)).slice(12));
  const msg = `Tacit governance vote\nProposal: ${idHex}\nChoice: 0 — Yes\nThis casts a vote weighted by your public TAC balance. No funds move.`;
  const m = new TextEncoder().encode(msg);
  const digest = keccak_256(concatBytes(new TextEncoder().encode(`\x19Ethereum Signed Message:\n${m.length}`), m));
  const sig = await secp.signAsync(digest, ethPriv);
  const ethSig = '0x' + sig.toCompactHex() + (27 + sig.recovery).toString(16);
  const snapTag = '0x' + (ethHead - 12).toString(16);
  ethBalanceAt = (tag) => (tag === snapTag ? '0x' + (2500n * 10n ** 18n).toString(16).padStart(64, '0') : null);

  const res = await gov.handle(mkReq('POST', { kind: 'public', choice: 0, eth_sig: ethSig }), env, mkUrl(`/governance/proposal/${idHex}/vote`), NET, {});
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.weight, (2500n * TAC).toString(), '2,500 TAC counts as 2,500 TAC, not 2,500 × 10^10');
  assert.equal(ethCalls.at(-1).blockTag, snapTag);
  assert.ok(ethCalls.at(-1).data.endsWith(addr.slice(2)));

  ethBalanceAt = () => null; // no archive answer: fail closed
  const noArchive = await gov.handle(mkReq('POST', { kind: 'public', choice: 0, eth_sig: ethSig }), env, mkUrl(`/governance/proposal/${idHex}/vote`), NET, {});
  assert.equal(noArchive.status, 502, JSON.stringify(noArchive.body));

  ethHead = null; // no Ethereum snapshot recorded: public voting is refused for that proposal
  const { idHex: id2 } = await createAt('public probe, no eth snapshot');
  const refused = await gov.handle(mkReq('POST', { kind: 'public', choice: 0, eth_sig: ethSig }), env, mkUrl(`/governance/proposal/${id2}/vote`), NET, {});
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  ethHead = 5000;
  delete env.GOV_TAC_ERC20_MAINNET;
});

test('execution: only a verified multisig transaction after the vote can be linked, and only by the operator', async () => {
  env.GOV_EXEC_TOKEN = 'x'.repeat(32);
  const OPS = '0x006cd14f36f65ecbb29b2519ccbe63a0dc8549f2';
  const { idHex } = await createAt('execution probe');
  const auth = (token) => ({ method: 'POST', headers: { get: (h) => (h === 'Authorization' ? `Bearer ${token}` : null) }, json: async () => ({ tx_hash: '0x' + 'ab'.repeat(32) }) });
  const exec = (token = env.GOV_EXEC_TOKEN) => gov.handle(auth(token), env, mkUrl(`/governance/proposal/${idHex}/execution`), NET, {});

  assert.equal((await exec('y'.repeat(32))).status, 401, 'a wrong token is refused');
  assert.equal((await exec()).status, 409, 'an open proposal has no execution');

  // Pass and finalize it.
  await castPrivate(idHex, [bigUtxo]);
  const rec = JSON.parse(env.REGISTRY_KV._m.get(`gov:p:${NET}:${idHex}`));
  const endsAt = Math.floor(Date.now() / 1000) - 100;
  rec.voting_ends_at = endsAt;
  env.REGISTRY_KV._m.set(`gov:p:${NET}:${idHex}`, JSON.stringify(rec));
  const fin = await gov.handle(mkReq('POST', {}), env, mkUrl(`/governance/proposal/${idHex}/finalize`), NET, {});
  assert.equal(fin.body.result.passed, true);

  const chain = { to: OPS, status: '0x1', ts: endsAt + 50 };
  rpcStub = (method) => {
    if (method === 'eth_getTransactionByHash') return { to: chain.to };
    if (method === 'eth_getTransactionReceipt') return { status: chain.status, blockNumber: '0x10' };
    if (method === 'eth_getBlockByNumber') return { timestamp: '0x' + chain.ts.toString(16) };
    return null;
  };
  chain.status = '0x0'; assert.equal((await exec()).status, 403, 'a reverted transaction is refused');
  chain.status = '0x1'; chain.to = '0x' + '11'.repeat(20);
  assert.match((await exec()).body.error, /ops multisig/);
  chain.to = OPS; chain.ts = endsAt - 1;
  assert.match((await exec()).body.error, /predates/);
  chain.ts = endsAt + 50;
  const ok = await exec();
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.execution.tx_hash, '0x' + 'ab'.repeat(32));
  const view = await gov.handle({ method: 'GET', headers: { get: () => null } }, env, mkUrl(`/governance/proposal/${idHex}`), NET, {});
  assert.equal(view.body.proposal.execution.block, 16);
  rpcStub = () => null;
  delete env.GOV_EXEC_TOKEN;
});
