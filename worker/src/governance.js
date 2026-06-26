// ============================================================================
// Off-chain TAC governance (Snapshot-style, advisory → multisig)
// ----------------------------------------------------------------------------
// Day-1 v1 governance for tacit.finance. TAC holders create proposals and vote
// until a deadline; results are advisory inputs the admin/multisig acts on
// (Collateral Engine admin/ownership, spec amendments, parameters, treasury).
//
// HYBRID weight model — a voter proves their TAC stake one of two ways:
//
//   • PRIVATE (Bitcoin / confidential holders) — a Bulletproofs+ threshold
//     attestation: the voter proves the SUM of their TAC UTXOs clears a tier
//     (≥1 / ≥10 / ≥100 / … TAC) WITHOUT revealing the exact balance. This is
//     the exact same audited primitive as the AMM-ceremony eligibility gate
//     (decodeCeremonyEligibilityEnvelope + bpRangeAggVerify), generalized with
//     a per-vote scope_id binding (proposal_id, choice) and a configurable
//     threshold X. Weight counted = the proven tier floor X. Residual leak:
//     the holder pubkey + which UTXOs back the vote (needed for the on-chain
//     ownership/liveness checks); the EXACT amount stays hidden.
//
//   • PUBLIC (Ethereum holders) — a transparent canonical-TAC-ERC20
//     balanceOf() read, authorised by an EIP-191 personal_sign. ERC20 balances
//     are already public on-chain, so nothing extra is leaked; weight counted =
//     the exact balance. Gated on a configured ERC20 address (TAC ERC20 is not
//     live yet → returns 501 until env GOV_TAC_ERC20_<NET> is set).
//
// Anti-double-vote nullifier: one vote per identity per proposal (keyed by the
// holder pubkey on the private path, the recovered ETH address on the public
// path). Proposal + final result/votes snapshot are pinned to IPFS; live state
// + running tally live in REGISTRY_KV.
//
// The factory takes its crypto/chain helpers from index.js (same pattern as
// buildCrossoutConsumer) so the worker shares ONE secp instance + NUMS H and
// never re-derives generators.
// ============================================================================

import { sha256 } from '@noble/hashes/sha256';
import { hexToBytes, bytesToHex, concatBytes } from '@noble/hashes/utils';

const enc = (s) => new TextEncoder().encode(s);

// ---- pure derivation helpers (exported so tests + the dapp mirror can pin
// byte-for-byte parity; no injected deps, only pure hashing) ----------------
export const GOV_TAC_BASE = 100_000_000n;                      // 1 TAC @ 8 decimals
export const GOV_TIERS = [1n, 10n, 100n, 1000n, 10000n, 100000n].map((t) => t * GOV_TAC_BASE);
export const GOV_PROPOSE_DOMAIN = enc('tacit-governance-propose-v1');
export const GOV_VOTE_DOMAIN = enc('tacit-governance-vote-v1');
export const GOV_PROPOSAL_ID_DOMAIN = enc('tacit-governance-proposal-id-v1');
export const GOV_PROPOSE_SCOPE_PREFIX = enc('tacit-gov-propose-scope-v1');
export const GOV_VOTE_SCOPE_PREFIX = enc('tacit-gov-vote-scope-v1');

export function govVoteScopeId(idHex, choice) {
  return sha256(concatBytes(GOV_VOTE_SCOPE_PREFIX, hexToBytes(idHex), new Uint8Array([choice & 0xff])));
}
export function govProposeScopeId(contentHash32) {
  return sha256(concatBytes(GOV_PROPOSE_SCOPE_PREFIX, contentHash32));
}
// MUST serialize identically to the dapp mirror _govProposalContentBytes().
export function govProposalContentBytes(c) {
  return enc(JSON.stringify([
    'tacit-governance-proposal-v1', c.network, c.title, c.body, c.choices, c.category,
    c.snapshot_height | 0, c.voting_ends_at | 0, c.quorum || '0', c.proposer_pubkey,
    c.exec_target || '', c.exec_note || '',
  ]));
}
export function govDeriveProposalId(c) {
  const contentHash = sha256(govProposalContentBytes(c));
  return { contentHash, idHex: bytesToHex(sha256(concatBytes(GOV_PROPOSAL_ID_DOMAIN, contentHash))) };
}

export function buildGovernance(deps) {
  const {
    jsonResponse, safeInt,
    secp, PEDERSEN_H, PEDERSEN_ZERO,
    verifySchnorr, decodeCeremonyEligibilityEnvelope, bpRangeAggVerify,
    commitmentForUtxo, apiJson, chainOutspendProbe, fetchTipHeight, hash160,
    ethCall, keccak256,
    pinFileToIpfs, filebaseConfigured,
    CANONICAL_TAC_ASSET_ID_HEX,
    evmPool, confidentialPoolAddrFor,   // EVM-lane (cTAC) resolver — optional
  } = deps;

  // ---- domains / scopes (distinct from ceremony so no cross-surface replay) ----
  const GOV_PRED_GE = 0x00;            // matches CER_ELIGIBILITY_PRED_GE
  const TAC = GOV_TAC_BASE;            // 1 TAC @ 8 decimals (base units)
  const GOV_PROPOSE_MIN_DEFAULT = 100n * TAC;   // anti-spam floor to open a proposal
  const GOV_EVM_DOMAIN = enc('tacit-governance-evm-weight-v1');
  const GOV_MAX_EVM_NOTES = 8;
  // Contract selectors (computed, not hardcoded, to avoid typos).
  const _SEL_CURRENT_ROOT = keccak256 ? bytesToHex(keccak256(enc('currentRoot()'))).slice(0, 8) : '4b9f2d36';
  const _SEL_NULLIFIER_SPENT = keccak256 ? bytesToHex(keccak256(enc('nullifierSpent(bytes32)'))).slice(0, 8) : '6f10dbc3';
  const GOV_CATEGORIES = ['collateral-engine', 'spec-amendment', 'parameter', 'treasury', 'general'];
  const GOV_MIN_CHOICES = 2;
  const GOV_MAX_CHOICES = 8;
  const GOV_MAX_TITLE = 140;
  const GOV_MAX_BODY = 12000;
  const GOV_MAX_DURATION_S = 60 * 24 * 3600;    // 60 days
  const GOV_MIN_DURATION_S = 60 * 60;           // 1 hour (test/quorum-fast)
  const GOV_MAX_VOTES_SNAPSHOT = 10000;         // bound the finalize snapshot

  // ---- KV key helpers (network-scoped) ----
  const pKey = (net, id) => `gov:p:${net}:${id}`;
  const pPrefix = (net) => `gov:p:${net}:`;
  const vKey = (net, id, voterKey) => `gov:v:${net}:${id}:${voterKey}`;
  const vPrefix = (net, id) => `gov:v:${net}:${id}:`;

  function nowS() { return Math.floor(Date.now() / 1000); }

  // Cloudflare KV.list returns at most 1000 keys per call. Walk the cursor so
  // tallies/snapshots never silently truncate a popular proposal. Bounded by
  // `cap` so a pathological key count can't blow the subrequest/CPU budget.
  async function listAllKeys(kvNs, prefix, cap) {
    const out = [];
    let cursor;
    do {
      const page = await kvNs.list({ prefix, limit: 1000, cursor });
      out.push(...page.keys);
      cursor = page.list_complete ? null : page.cursor;
    } while (cursor && out.length < cap);
    return out.slice(0, cap);
  }

  function u32le(n) { const b = new Uint8Array(4); let v = (n >>> 0); for (let i = 0; i < 4; i++) { b[i] = v & 0xff; v >>>= 8; } return b; }

  const voteScopeId = govVoteScopeId;
  const proposeScopeId = govProposeScopeId;
  const deriveProposalId = govDeriveProposalId;

  // ----------------------------------------------------------------------------
  // Generalized threshold-attestation verifier (private path).
  // Mirrors verifyCeremonyEligibilityProof but:
  //   • scope_id is supplied by the caller (binds proposal/choice or content),
  //   • domain is supplied by the caller (propose vs vote),
  //   • threshold X is READ FROM the attestation (the tier claimed) and only
  //     checked to be a recognised tier ≥ minTier — returned as the weight.
  // Returns { ok, status?, reason?, tier, holderPubkeyHex, outpoints }.
  // ----------------------------------------------------------------------------
  async function verifyThresholdAttestation(env, envelopeBytes, sigDomain, expectedScope32, minTier, network) {
    const dec = decodeCeremonyEligibilityEnvelope(envelopeBytes);
    if (!dec.ok) return { ok: false, status: 400, reason: `weight_proof: ${dec.reason}` };

    // (1) holder_sig over SHA256(domain || preceding)
    const sigMsg = sha256(concatBytes(sigDomain, dec.preceding));
    if (!verifySchnorr(dec.holderSig, sigMsg, dec.holderPubkey.slice(1))) {
      return { ok: false, status: 403, reason: 'weight_proof: invalid holder_sig' };
    }
    // (2) scope binds to this exact proposal/choice (or content) — no replay.
    if (bytesToHex(dec.scopeId) !== bytesToHex(expectedScope32)) {
      return { ok: false, status: 403, reason: 'weight_proof: scope_id mismatch (proof bound to a different proposal/choice)' };
    }
    // (3) asset_id == canonical TAC.
    if (bytesToHex(dec.assetId).toLowerCase() !== CANONICAL_TAC_ASSET_ID_HEX) {
      return { ok: false, status: 403, reason: 'weight_proof: asset_id is not canonical TAC' };
    }
    // (4) freshness — fail closed on tip-fetch failure (a stale envelope from
    //     when the holder had stake would otherwise replay while UTXOs live).
    let tip = null;
    for (let i = 0; i < 2 && tip === null; i++) { try { tip = await fetchTipHeight(env, network); } catch { tip = null; } }
    if (tip === null) return { ok: false, status: 502, reason: 'weight_proof: chain tip unavailable, retry shortly' };
    if (dec.expiryHeight < tip) return { ok: false, status: 403, reason: `weight_proof: expired (expiry=${dec.expiryHeight}, tip=${tip})` };

    // (5) resolve outpoints: TAC, owned by holder, unspent; sum commitments.
    let sumC = PEDERSEN_ZERO;
    const holderHash160Hex = bytesToHex(hash160(dec.holderPubkey));
    for (const op of dec.outpoints) {
      let resolved;
      try { resolved = await commitmentForUtxo(env, op.txid, op.vout, network); }
      catch (e) { return { ok: false, status: 403, reason: `weight_proof: ${op.txid}:${op.vout} lookup failed: ${e.message || 'unknown'}` }; }
      if (String(resolved.asset_id || '').toLowerCase() !== CANONICAL_TAC_ASSET_ID_HEX) {
        return { ok: false, status: 403, reason: `weight_proof: ${op.txid}:${op.vout} is not TAC` };
      }
      let tx;
      try { tx = await apiJson(env, `/tx/${op.txid}`, {}, network); }
      catch (e) { return { ok: false, status: 502, reason: `weight_proof: failed to fetch ${op.txid}: ${e.message || 'unknown'}` }; }
      const voutObj = tx?.vout?.[op.vout];
      const spk = voutObj?.scriptpubkey ? hexToBytes(voutObj.scriptpubkey) : null;
      if (!spk || spk.length !== 22 || spk[0] !== 0x00 || spk[1] !== 0x14) {
        return { ok: false, status: 403, reason: `weight_proof: ${op.txid}:${op.vout} is not P2WPKH` };
      }
      if (bytesToHex(spk.slice(2, 22)) !== holderHash160Hex) {
        return { ok: false, status: 403, reason: `weight_proof: holder does not own ${op.txid}:${op.vout}` };
      }
      const probe = await chainOutspendProbe(env, network, op.txid, op.vout, tip);
      if (!probe) return { ok: false, status: 502, reason: `weight_proof: outspend probe failed for ${op.txid}:${op.vout}` };
      if (probe.spent) return { ok: false, status: 403, reason: `weight_proof: ${op.txid}:${op.vout} is spent` };
      try { sumC = sumC.add(secp.ProjectivePoint.fromHex(String(resolved.commitment))); }
      catch (e) { return { ok: false, status: 500, reason: `weight_proof: commitment decode failed: ${e.message || 'unknown'}` }; }
    }

    // (6) PRED_GE attestation: read X, verify it's a recognised tier ≥ minTier,
    //     then check bpRangeAggVerify against (C_sum − X·H) ⇒ sum ≥ X.
    if (dec.attestation.length < 11) return { ok: false, status: 400, reason: 'weight_proof: attestation truncated' };
    if (dec.attestation[0] !== GOV_PRED_GE) return { ok: false, status: 403, reason: 'weight_proof: predicate is not PRED_GE' };
    let X = 0n;
    for (let i = 0; i < 8; i++) X |= BigInt(dec.attestation[1 + i]) << (8n * BigInt(i));
    if (!GOV_TIERS.some((t) => t === X)) return { ok: false, status: 403, reason: `weight_proof: threshold ${X} is not a recognised tier` };
    if (X < minTier) return { ok: false, status: 403, reason: `weight_proof: tier ${X} below minimum ${minTier}` };
    const proofLen = dec.attestation[9] | (dec.attestation[10] << 8);
    if (dec.attestation.length !== 11 + proofLen) return { ok: false, status: 400, reason: 'weight_proof: proof_len mismatch' };
    const proof = dec.attestation.slice(11, 11 + proofLen);
    const shifted = X === 0n ? sumC : sumC.add(PEDERSEN_H.multiply(X).negate());
    let verified;
    try { verified = bpRangeAggVerify([shifted], proof); }
    catch (e) { return { ok: false, status: 500, reason: `weight_proof: bulletproof threw: ${e.message || 'unknown'}` }; }
    if (!verified) return { ok: false, status: 403, reason: 'weight_proof: bulletproof verify failed' };

    return {
      ok: true,
      tier: X,
      holderPubkeyHex: bytesToHex(dec.holderPubkey).toLowerCase(),
      outpoints: dec.outpoints.map((o) => `${o.txid}:${o.vout}`),
    };
  }

  // ----------------------------------------------------------------------------
  // EVM-lane (Ethereum shielded TAC / cTAC) threshold attestation.
  // Same homomorphic threshold idea as the Bitcoin path — EVM notes commit
  // value with the BYTE-IDENTICAL secp Pedersen H, so cTAC commitments sum into
  // the same BP+ range proof. Per note the worker re-derives the leaf
  // (keccak(asset‖cx‖cy‖owner)), verifies membership against the live on-chain
  // currentRoot() (the pool keeps only one root, so the path must be fresh),
  // checks the nullifier (keccak(cx‖cy‖"spent")) is unspent, and binds
  // ownership by owner == holder_pubkey[1:33] (the x-coord — exactly what the
  // Schnorr verify uses). Wire format (all big-endian 32-byte words unless noted):
  //   scope_id(32) ‖ asset_id(32) ‖ holder_pubkey(33) ‖ pool_root(32) ‖
  //   note_count(1) ‖ [ cx(32) cy(32) owner(32) leafIndex_LE(4) path(32*32) ]*N ‖
  //   attestation_len_LE(2) ‖ attestation ‖ holder_sig(64)
  // attestation = PRED_GE(1) ‖ X_LE(8) ‖ proofLen_LE(2) ‖ proof.
  const _EVM_NOTE_LEN = 32 + 32 + 32 + 4 + 32 * 32;   // 1124
  function decodeGovEvmEnvelope(bytes) {
    if (!(bytes instanceof Uint8Array)) return { ok: false, reason: 'not bytes' };
    const HEAD = 32 + 32 + 33 + 32 + 1;
    if (bytes.length < HEAD + _EVM_NOTE_LEN + 2 + 11 + 64) return { ok: false, reason: 'truncated' };
    let off = 0;
    const scopeId = bytes.slice(off, off += 32);
    const assetId = bytes.slice(off, off += 32);
    const holderPubkey = bytes.slice(off, off += 33);
    const poolRoot = bytes.slice(off, off += 32);
    const count = bytes[off]; off += 1;
    if (count < 1 || count > GOV_MAX_EVM_NOTES) return { ok: false, reason: `note_count out of range [1,${GOV_MAX_EVM_NOTES}]` };
    if (bytes.length < off + count * _EVM_NOTE_LEN + 2 + 11 + 64) return { ok: false, reason: 'truncated at notes' };
    const notes = [];
    for (let i = 0; i < count; i++) {
      const cx = bytes.slice(off, off += 32);
      const cy = bytes.slice(off, off += 32);
      const owner = bytes.slice(off, off += 32);
      const leafIndex = (bytes[off] | (bytes[off + 1] << 8) | (bytes[off + 2] << 16) | (bytes[off + 3] << 24)) >>> 0; off += 4;
      const path = [];
      for (let j = 0; j < 32; j++) { path.push('0x' + bytesToHex(bytes.slice(off, off += 32))); }
      notes.push({ cx, cy, owner, leafIndex, path });
    }
    const attLen = bytes[off] | (bytes[off + 1] << 8); off += 2;
    if (bytes.length !== off + attLen + 64) return { ok: false, reason: 'length mismatch' };
    const attestation = bytes.slice(off, off += attLen);
    const holderSig = bytes.slice(off, off += 64);
    const preceding = bytes.slice(0, bytes.length - 64);
    return { ok: true, scopeId, assetId, holderPubkey, poolRoot, count, notes, attestation, holderSig, preceding };
  }

  async function verifyGovEvmAttestation(env, envelopeBytes, expectedScope32, minTier, network) {
    if (!evmPool || !confidentialPoolAddrFor) return { ok: false, status: 501, reason: 'evm shielded voting not wired' };
    const poolAddr = confidentialPoolAddrFor(network);
    if (!poolAddr) return { ok: false, status: 501, reason: 'evm shielded voting not enabled (no confidential pool on this network)' };

    const dec = decodeGovEvmEnvelope(envelopeBytes);
    if (!dec.ok) return { ok: false, status: 400, reason: `evm_weight: ${dec.reason}` };
    // (1) holder_sig
    const sigMsg = sha256(concatBytes(GOV_EVM_DOMAIN, dec.preceding));
    if (!verifySchnorr(dec.holderSig, sigMsg, dec.holderPubkey.slice(1))) {
      return { ok: false, status: 403, reason: 'evm_weight: invalid holder_sig' };
    }
    // (2) scope, (3) asset
    if (bytesToHex(dec.scopeId) !== bytesToHex(expectedScope32)) return { ok: false, status: 403, reason: 'evm_weight: scope_id mismatch' };
    if (bytesToHex(dec.assetId).toLowerCase() !== CANONICAL_TAC_ASSET_ID_HEX) return { ok: false, status: 403, reason: 'evm_weight: asset_id is not canonical TAC' };

    // (4) freshness — the supplied pool_root must equal the live on-chain root
    // (the pool keeps a single currentRoot; a stale path won't match).
    const rootRes = await ethCall(network, poolAddr, '0x' + _SEL_CURRENT_ROOT);
    if (rootRes === null) return { ok: false, status: 502, reason: 'evm_weight: currentRoot() read failed' };
    const onchainRoot = rootRes.replace(/^0x/, '').toLowerCase().padStart(64, '0');
    if (onchainRoot !== bytesToHex(dec.poolRoot)) return { ok: false, status: 403, reason: 'evm_weight: pool_root is stale (rescan and rebuild paths)' };
    const poolRootHex = '0x' + bytesToHex(dec.poolRoot);

    // (5) per note: ownership, membership, unspent; accumulate commitment.
    const holderXonlyHex = bytesToHex(dec.holderPubkey.slice(1));
    const assetHex = '0x' + bytesToHex(dec.assetId);
    let sumC = PEDERSEN_ZERO;
    const seen = new Set();
    for (const n of dec.notes) {
      const cxHex = '0x' + bytesToHex(n.cx), cyHex = '0x' + bytesToHex(n.cy), ownerHex = '0x' + bytesToHex(n.owner);
      const key = cxHex + cyHex;
      if (seen.has(key)) return { ok: false, status: 400, reason: 'evm_weight: duplicate note' };
      seen.add(key);
      if (bytesToHex(n.owner) !== holderXonlyHex) return { ok: false, status: 403, reason: 'evm_weight: note owner != holder' };
      const leafHex = evmPool.leaf(assetHex, cxHex, cyHex, ownerHex);
      if (!evmPool.verifyPath(leafHex, n.leafIndex, n.path, poolRootHex)) {
        return { ok: false, status: 403, reason: `evm_weight: note ${n.leafIndex} not in pool tree` };
      }
      const nul = evmPool.nullifier(cxHex, cyHex).replace(/^0x/, '').padStart(64, '0');
      const spentRes = await ethCall(network, poolAddr, '0x' + _SEL_NULLIFIER_SPENT + nul);
      if (spentRes === null) return { ok: false, status: 502, reason: `evm_weight: nullifierSpent read failed for note ${n.leafIndex}` };
      let spent = false; try { spent = BigInt(spentRes) === 1n; } catch {}
      if (spent) return { ok: false, status: 403, reason: `evm_weight: note ${n.leafIndex} is spent` };
      try { sumC = sumC.add(secp.ProjectivePoint.fromHex('04' + bytesToHex(n.cx) + bytesToHex(n.cy))); }
      catch (e) { return { ok: false, status: 400, reason: `evm_weight: bad commitment point at note ${n.leafIndex}` }; }
    }

    // (6) PRED_GE range proof over (C_sum − X·H).
    if (dec.attestation.length < 11) return { ok: false, status: 400, reason: 'evm_weight: attestation truncated' };
    if (dec.attestation[0] !== GOV_PRED_GE) return { ok: false, status: 403, reason: 'evm_weight: predicate is not PRED_GE' };
    let X = 0n;
    for (let i = 0; i < 8; i++) X |= BigInt(dec.attestation[1 + i]) << (8n * BigInt(i));
    if (!GOV_TIERS.some((t) => t === X)) return { ok: false, status: 403, reason: `evm_weight: threshold ${X} is not a recognised tier` };
    if (X < minTier) return { ok: false, status: 403, reason: `evm_weight: tier ${X} below minimum ${minTier}` };
    const proofLen = dec.attestation[9] | (dec.attestation[10] << 8);
    if (dec.attestation.length !== 11 + proofLen) return { ok: false, status: 400, reason: 'evm_weight: proof_len mismatch' };
    const proof = dec.attestation.slice(11, 11 + proofLen);
    const shifted = X === 0n ? sumC : sumC.add(PEDERSEN_H.multiply(X).negate());
    let verified;
    try { verified = bpRangeAggVerify([shifted], proof); }
    catch (e) { return { ok: false, status: 500, reason: `evm_weight: bulletproof threw: ${e.message || 'unknown'}` }; }
    if (!verified) return { ok: false, status: 403, reason: 'evm_weight: bulletproof verify failed' };

    return { ok: true, tier: X, holderPubkeyHex: bytesToHex(dec.holderPubkey).toLowerCase() };
  }

  // ---- PUBLIC path: EIP-191 recover + ERC20 balanceOf -----------------------
  function ethVoteMessage(idHex, choice, choiceLabel) {
    return `Tacit governance vote\nProposal: ${idHex}\nChoice: ${choice} — ${choiceLabel}\nThis casts a vote weighted by your public TAC balance. No funds move.`;
  }
  function eip191Hash(msg) {
    const m = enc(msg);
    return keccak256(concatBytes(enc(`\x19Ethereum Signed Message:\n${m.length}`), m));
  }
  function recoverEthAddr(msg, sigHex) {
    const sig = sigHex.replace(/^0x/, '').toLowerCase();
    if (sig.length !== 130) throw new Error('eth sig must be 65 bytes');
    const r = sig.slice(0, 64), s = sig.slice(64, 128);
    let v = parseInt(sig.slice(128, 130), 16);
    if (v >= 27) v -= 27;
    if (v !== 0 && v !== 1) throw new Error('bad recovery id');
    const sigObj = secp.Signature.fromCompact(r + s).addRecoveryBit(v);
    const pub = sigObj.recoverPublicKey(eip191Hash(msg));
    const xy = pub.toRawBytes(false).slice(1);
    return '0x' + bytesToHex(keccak256(xy).slice(12));
  }
  function govTacErc20(env, network) {
    const raw = network === 'mainnet' ? env.GOV_TAC_ERC20_MAINNET : env.GOV_TAC_ERC20_SIGNET;
    if (!raw || !/^0x[0-9a-fA-F]{40}$/.test(raw)) return null;
    return raw.toLowerCase();
  }
  async function readErc20Balance(env, network, token, addr) {
    // balanceOf(address) selector 0x70a08231
    const data = '0x70a08231' + '0'.repeat(24) + addr.replace(/^0x/, '').toLowerCase();
    const res = await ethCall(network, token, data);
    if (!res || !/^0x[0-9a-fA-F]+$/.test(res)) return null;
    try { return BigInt(res); } catch { return null; }
  }

  // ---- tally / proposal lifecycle helpers -----------------------------------
  function emptyTally(n) { return { totals: new Array(n).fill('0'), voters: 0, total_weight: '0', public_voters: 0, private_voters: 0 }; }
  function statusOf(p) { return p.finalized ? 'closed' : (nowS() >= p.voting_ends_at ? 'ended' : 'active'); }

  function proposalPublicView(p, includeVotes, votes) {
    const v = {
      id: p.id, network: p.network, schema: p.schema,
      title: p.title, body: p.body, choices: p.choices, category: p.category,
      proposer_pubkey: p.proposer_pubkey,
      snapshot_height: p.snapshot_height, created_at: p.created_at, voting_ends_at: p.voting_ends_at,
      quorum: p.quorum, cid: p.cid || null,
      exec_target: p.exec_target || '', exec_note: p.exec_note || '',
      tally: p.tally, status: statusOf(p),
      finalized: !!p.finalized, result: p.result || null, result_cid: p.result_cid || null,
    };
    if (includeVotes) v.votes = votes || [];
    return v;
  }

  // ====================== route handlers ======================================
  async function listProposals(env, network, url, cors) {
    const list = await env.REGISTRY_KV.list({ prefix: pPrefix(network), limit: 1000 });
    const out = [];
    for (const k of list.keys) {
      const p = await env.REGISTRY_KV.get(k.name, 'json');
      if (p) out.push(proposalPublicView(p, false));
    }
    out.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
    const status = url.searchParams.get('status');
    const filtered = status ? out.filter((p) => p.status === status) : out;
    return jsonResponse({ proposals: filtered }, 200, cors);
  }

  async function getProposal(env, network, idHex, url, cors) {
    if (!/^[0-9a-f]{64}$/.test(idHex)) return jsonResponse({ error: 'bad proposal id' }, 400, cors);
    const p = await env.REGISTRY_KV.get(pKey(network, idHex), 'json');
    if (!p) return jsonResponse({ error: 'proposal not found' }, 404, cors);
    let votes = null;
    if (url.searchParams.get('votes') === '1') {
      votes = [];
      const vl = await env.REGISTRY_KV.list({ prefix: vPrefix(network, idHex), limit: 1000 });
      for (const k of vl.keys) { const rec = await env.REGISTRY_KV.get(k.name, 'json'); if (rec) votes.push(rec); }
      votes.sort((a, b) => (b.voted_at || 0) - (a.voted_at || 0));
    }
    return jsonResponse({ proposal: proposalPublicView(p, votes !== null, votes) }, 200, cors);
  }

  async function createProposal(req, env, network, cors) {
    if (!env.PINATA_JWT && !filebaseConfigured(env)) return jsonResponse({ error: 'no pin provider configured' }, 500, cors);
    // per-IP daily cap (reuses the pin counter shape)
    const ip = req.headers.get('CF-Connecting-IP') || 'anon';
    const day = new Date().toISOString().slice(0, 10);
    const kvKey = `pin:${day}:${ip}`;
    const dailyLimit = safeInt(env.DAILY_LIMIT, 20, { min: 0 });
    const prior = safeInt(await env.UPLOAD_KV.get(kvKey), 0, { min: 0 });
    if (prior >= dailyLimit) return jsonResponse({ error: 'daily limit reached' }, 429, cors);

    let body;
    try { body = await req.json(); } catch { return jsonResponse({ error: 'expected JSON body' }, 400, cors); }

    const title = String(body.title || '').trim();
    const text = String(body.body || '').trim();
    const choices = Array.isArray(body.choices) ? body.choices.map((c) => String(c).trim()) : null;
    const category = String(body.category || 'general');
    const endsAt = body.voting_ends_at | 0;
    const snapshotHeight = body.snapshot_height | 0;
    const quorum = String(body.quorum || '0');
    const proposerPub = String(body.proposer_pubkey || '').toLowerCase();
    const execTarget = String(body.exec_target || '').slice(0, 80);
    const execNote = String(body.exec_note || '').slice(0, 400);
    const envelopeHex = String(body.propose_envelope || '').toLowerCase();

    if (!title || title.length > GOV_MAX_TITLE) return jsonResponse({ error: `title required (1..${GOV_MAX_TITLE} chars)` }, 400, cors);
    if (text.length > GOV_MAX_BODY) return jsonResponse({ error: `body exceeds ${GOV_MAX_BODY} chars` }, 400, cors);
    if (!choices || choices.length < GOV_MIN_CHOICES || choices.length > GOV_MAX_CHOICES) {
      return jsonResponse({ error: `choices: ${GOV_MIN_CHOICES}..${GOV_MAX_CHOICES} options` }, 400, cors);
    }
    if (choices.some((c) => !c || c.length > 80)) return jsonResponse({ error: 'each choice 1..80 chars' }, 400, cors);
    if (new Set(choices).size !== choices.length) return jsonResponse({ error: 'choices must be distinct' }, 400, cors);
    if (!GOV_CATEGORIES.includes(category)) return jsonResponse({ error: `category must be one of ${GOV_CATEGORIES.join(', ')}` }, 400, cors);
    if (!/^[0-9a-f]{66}$/.test(proposerPub) || !/^0[23]/.test(proposerPub)) return jsonResponse({ error: 'proposer_pubkey must be 33-byte compressed hex' }, 400, cors);
    const dur = endsAt - nowS();
    if (dur < GOV_MIN_DURATION_S || dur > GOV_MAX_DURATION_S) {
      return jsonResponse({ error: `voting window must be ${GOV_MIN_DURATION_S / 3600}h..${GOV_MAX_DURATION_S / 86400}d from now` }, 400, cors);
    }
    if (!/^[0-9a-f]+$/.test(envelopeHex)) return jsonResponse({ error: 'propose_envelope (hex) required' }, 400, cors);

    const content = {
      network, title, body: text, choices, category,
      snapshot_height: snapshotHeight, voting_ends_at: endsAt, quorum,
      proposer_pubkey: proposerPub, exec_target: execTarget, exec_note: execNote,
    };
    const { contentHash, idHex } = deriveProposalId(content);

    // proposer must clear the propose floor AND authorise this exact content
    const minPropose = (() => { try { const t = BigInt(env.GOV_PROPOSE_MIN_BASE || '0'); return t > 0n ? t : GOV_PROPOSE_MIN_DEFAULT; } catch { return GOV_PROPOSE_MIN_DEFAULT; } })();
    let envBytes;
    try { envBytes = hexToBytes(envelopeHex); } catch { return jsonResponse({ error: 'bad envelope hex' }, 400, cors); }
    const v = await verifyThresholdAttestation(env, envBytes, GOV_PROPOSE_DOMAIN, proposeScopeId(contentHash), minPropose, network);
    if (!v.ok) return jsonResponse({ error: v.reason }, v.status || 403, cors);
    if (v.holderPubkeyHex !== proposerPub) return jsonResponse({ error: 'envelope holder != proposer_pubkey' }, 403, cors);

    const existing = await env.REGISTRY_KV.get(pKey(network, idHex), 'json');
    if (existing) return jsonResponse({ error: 'identical proposal already exists', id: idHex }, 409, cors);

    // pin the canonical proposal blob to IPFS
    const blob = { schema: 'tacit-governance-proposal-v1', id: idHex, ...content, created_at: nowS(), proposer_tier: v.tier.toString() };
    let pinned;
    try { pinned = await pinFileToIpfs(env, enc(JSON.stringify(blob)), 'application/json', 'tacit-gov-proposal'); }
    catch (e) { return jsonResponse({ error: e.msg || 'pin failed' }, e.status || 502, cors); }

    const record = {
      schema: 'tacit-governance-proposal-v1', id: idHex, ...content,
      created_at: nowS(), cid: pinned.cid, proposer_tier: v.tier.toString(),
      tally: emptyTally(choices.length), finalized: false,
    };
    await env.REGISTRY_KV.put(pKey(network, idHex), JSON.stringify(record));
    await env.UPLOAD_KV.put(kvKey, String(prior + 1), { expirationTtl: 90000 });
    return jsonResponse({ ok: true, id: idHex, cid: pinned.cid, proposal: proposalPublicView(record, false) }, 200, cors);
  }

  async function castVote(req, env, network, idHex, cors) {
    if (!/^[0-9a-f]{64}$/.test(idHex)) return jsonResponse({ error: 'bad proposal id' }, 400, cors);
    const p = await env.REGISTRY_KV.get(pKey(network, idHex), 'json');
    if (!p) return jsonResponse({ error: 'proposal not found' }, 404, cors);
    if (p.finalized) return jsonResponse({ error: 'proposal is closed' }, 409, cors);
    if (nowS() >= p.voting_ends_at) return jsonResponse({ error: 'voting window has ended' }, 409, cors);

    let body;
    try { body = await req.json(); } catch { return jsonResponse({ error: 'expected JSON body' }, 400, cors); }
    const choice = body.choice | 0;
    if (choice < 0 || choice >= p.choices.length) return jsonResponse({ error: 'choice out of range' }, 400, cors);
    const kind = body.kind === 'public' ? 'public' : (body.kind === 'private-eth' ? 'private-eth' : 'private');

    let voterKey, voterId, weight, tier = null, outpoints = null;

    if (kind === 'private-eth') {
      const envelopeHex = String(body.weight_envelope || '').toLowerCase();
      if (!/^[0-9a-f]+$/.test(envelopeHex)) return jsonResponse({ error: 'weight_envelope (hex) required' }, 400, cors);
      let envBytes;
      try { envBytes = hexToBytes(envelopeHex); } catch { return jsonResponse({ error: 'bad envelope hex' }, 400, cors); }
      const v = await verifyGovEvmAttestation(env, envBytes, voteScopeId(idHex, choice), GOV_TIERS[0], network);
      if (!v.ok) return jsonResponse({ error: v.reason }, v.status || 403, cors);
      voterId = v.holderPubkeyHex;
      voterKey = 'ceth-' + bytesToHex(sha256(enc(voterId))).slice(0, 32);
      weight = v.tier; tier = v.tier;
    } else if (kind === 'private') {
      const envelopeHex = String(body.weight_envelope || '').toLowerCase();
      if (!/^[0-9a-f]+$/.test(envelopeHex)) return jsonResponse({ error: 'weight_envelope (hex) required' }, 400, cors);
      let envBytes;
      try { envBytes = hexToBytes(envelopeHex); } catch { return jsonResponse({ error: 'bad envelope hex' }, 400, cors); }
      const v = await verifyThresholdAttestation(env, envBytes, GOV_VOTE_DOMAIN, voteScopeId(idHex, choice), GOV_TIERS[0], network);
      if (!v.ok) return jsonResponse({ error: v.reason }, v.status || 403, cors);
      voterId = v.holderPubkeyHex;
      voterKey = 'btc-' + bytesToHex(sha256(enc(voterId))).slice(0, 32);
      weight = v.tier; tier = v.tier; outpoints = v.outpoints;
    } else {
      const token = govTacErc20(env, network);
      if (!token) return jsonResponse({ error: 'public ETH voting not enabled (TAC ERC20 not live on this network yet)' }, 501, cors);
      const ethSig = String(body.eth_sig || '');
      if (!/^0x?[0-9a-fA-F]{130}$/.test(ethSig.replace(/^0x/, '0x'))) return jsonResponse({ error: 'eth_sig (65-byte hex) required' }, 400, cors);
      let addr;
      try { addr = recoverEthAddr(ethVoteMessage(idHex, choice, p.choices[choice]), ethSig); }
      catch (e) { return jsonResponse({ error: 'eth sig recover failed: ' + (e.message || 'unknown') }, 400, cors); }
      const bal = await readErc20Balance(env, network, token, addr);
      if (bal === null) return jsonResponse({ error: 'ERC20 balanceOf read failed' }, 502, cors);
      if (bal <= 0n) return jsonResponse({ error: 'address holds no TAC' }, 403, cors);
      voterId = addr;
      voterKey = 'eth-' + addr.replace(/^0x/, '');
      weight = bal;   // TAC ERC20 is 8-dec, unitScale 1 → base units already
    }

    const existing = await env.REGISTRY_KV.get(vKey(network, idHex, voterKey), 'json');
    const record = {
      proposal_id: idHex, network, kind, choice, weight: weight.toString(),
      tier: tier !== null ? tier.toString() : null, voter: voterId, outpoints,
      voted_at: nowS(), revote: !!existing,
    };
    await env.REGISTRY_KV.put(vKey(network, idHex, voterKey), JSON.stringify(record));

    // running tally — recompute from the live vote set (authoritative, immune
    // to lost read-modify-write races; bounded by GOV_MAX_VOTES_SNAPSHOT).
    const tally = await recomputeTally(env, network, idHex, p.choices.length);
    p.tally = tally;
    await env.REGISTRY_KV.put(pKey(network, idHex), JSON.stringify(p));

    return jsonResponse({ ok: true, weight: weight.toString(), tier: tier !== null ? tier.toString() : null, revote: !!existing, tally }, 200, cors);
  }

  async function recomputeTally(env, network, idHex, nChoices) {
    const t = emptyTally(nChoices);
    const totals = new Array(nChoices).fill(0n);
    let total = 0n, pub = 0, priv = 0, voters = 0;
    const keys = await listAllKeys(env.REGISTRY_KV, vPrefix(network, idHex), GOV_MAX_VOTES_SNAPSHOT);
    for (const k of keys) {
      const rec = await env.REGISTRY_KV.get(k.name, 'json');
      if (!rec) continue;
      let w = 0n; try { w = BigInt(rec.weight); } catch {}
      const ci = rec.choice | 0;
      if (ci < 0 || ci >= nChoices) continue;
      totals[ci] += w; total += w; voters += 1;
      if (rec.kind === 'public') pub += 1; else priv += 1;
    }
    t.totals = totals.map((x) => x.toString());
    t.total_weight = total.toString();
    t.voters = voters; t.public_voters = pub; t.private_voters = priv;
    return t;
  }

  async function finalize(env, network, idHex, cors) {
    if (!/^[0-9a-f]{64}$/.test(idHex)) return jsonResponse({ error: 'bad proposal id' }, 400, cors);
    const p = await env.REGISTRY_KV.get(pKey(network, idHex), 'json');
    if (!p) return jsonResponse({ error: 'proposal not found' }, 404, cors);
    if (nowS() < p.voting_ends_at) return jsonResponse({ error: 'voting window still open' }, 409, cors);
    if (p.finalized) return jsonResponse({ ok: true, already: true, result: p.result, result_cid: p.result_cid }, 200, cors);

    const tally = await recomputeTally(env, network, idHex, p.choices.length);
    // collect votes for the permanent snapshot
    const votes = [];
    const fkeys = await listAllKeys(env.REGISTRY_KV, vPrefix(network, idHex), GOV_MAX_VOTES_SNAPSHOT);
    for (const k of fkeys) { const rec = await env.REGISTRY_KV.get(k.name, 'json'); if (rec) votes.push(rec); }

    const totals = tally.totals.map((x) => BigInt(x));
    let winner = -1, winnerW = -1n;
    totals.forEach((w, i) => { if (w > winnerW) { winnerW = w; winner = i; } });
    const totalW = BigInt(tally.total_weight);
    const quorum = (() => { try { return BigInt(p.quorum || '0'); } catch { return 0n; } })();
    const quorumMet = totalW >= quorum;
    const result = {
      winner, winner_choice: winner >= 0 ? p.choices[winner] : null,
      winner_weight: winnerW < 0n ? '0' : winnerW.toString(),
      total_weight: totalW.toString(), quorum: quorum.toString(), quorum_met: quorumMet,
      passed: quorumMet && winner >= 0 && winnerW > 0n,
      finalized_at: nowS(),
    };

    let resultCid = null;
    if (env.PINATA_JWT || filebaseConfigured(env)) {
      const snapshot = {
        schema: 'tacit-governance-result-v1', id: idHex, network,
        title: p.title, choices: p.choices, category: p.category, cid: p.cid || null,
        voting_ends_at: p.voting_ends_at, tally, result, votes,
      };
      try { const pinned = await pinFileToIpfs(env, enc(JSON.stringify(snapshot)), 'application/json', 'tacit-gov-result'); resultCid = pinned.cid; }
      catch { resultCid = null; }   // pin failure shouldn't block finalization
    }

    p.tally = tally; p.finalized = true; p.result = result; p.result_cid = resultCid;
    await env.REGISTRY_KV.put(pKey(network, idHex), JSON.stringify(p));
    return jsonResponse({ ok: true, result, result_cid: resultCid, tally }, 200, cors);
  }

  // ---- public router ---------------------------------------------------------
  async function handle(req, env, url, network, cors, ctx) {
    const path = url.pathname;
    if (path === '/governance/proposals' && req.method === 'GET') return listProposals(env, network, url, cors);
    if (path === '/governance/proposals' && req.method === 'POST') return createProposal(req, env, network, cors);
    let m = path.match(/^\/governance\/proposal\/([0-9a-f]{64})$/);
    if (m && req.method === 'GET') return getProposal(env, network, m[1], url, cors);
    m = path.match(/^\/governance\/proposal\/([0-9a-f]{64})\/vote$/);
    if (m && req.method === 'POST') return castVote(req, env, network, m[1], cors);
    m = path.match(/^\/governance\/proposal\/([0-9a-f]{64})\/finalize$/);
    if (m && req.method === 'POST') return finalize(env, network, m[1], cors);
    return null;   // not a governance route — let index.js fall through
  }

  return { handle, GOV_TIERS, GOV_CATEGORIES, GOV_PROPOSE_MIN_DEFAULT };
}
