// End-to-end airdrop simulation against the live deployed worker.
//
// Generates N synthetic recipients, has each one construct + sign the
// canonical claim message exactly as a real MetaMask user would (EIP-191
// hashing + ECDSA over secp256k1 with recovery byte), POSTs the signed
// tuples to the live `/airdrops/:root/claims` endpoint, then pulls the
// queue back and runs the issuer-side verification path.
//
// What this validates:
//   - Canonical claim message bytes match between recipient and issuer
//   - EIP-191 prefix + keccak256 hash + ECDSA recover round-trip cleanly
//   - Worker POST validation accepts well-formed bodies, rejects malformed
//   - GET pagination (?cursor, ?limit) returns the expected slices
//   - GET ordering (lex by padded leaf_index = numeric)
//   - DELETE removes a single entry
//   - Issuer's verify path recovers each sig to the correct eth address
//
// What this does NOT validate (requires browser):
//   - Actual MetaMask popup behavior (we simulate the bytes it produces)
//   - Actual on-chain CXFER broadcast from the dapp's treasury wallet
//
// Run: `node airdrop-e2e-signet.mjs`
//
// Side effect: creates ~5 KV entries on the live worker under a test-derived
// merkle root. Cleaned up at end of run via DELETE.

import * as secp from '@noble/secp256k1';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils';
import {
  airdropLeafHash, buildAirdropMerkle, airdropMerkleProof, verifyAirdropMerkleProof,
  buildAirdropClaimMsg, verifyAirdropClaimSig,
  _signEip191WithPriv, _ethAddrFromPriv,
} from './composition.mjs';

const WORKER = process.env.WORKER_BASE || 'https://api.tacit.finance';
const NETWORK = 'signet';
const FAKE_ASSET = 'f0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b';
const FAKE_TICKER = 'TAC';
const FAKE_DECIMALS = 8;
const N_RECIPIENTS = 5;

let pass = 0, fail = 0;
function step(label, ok) {
  if (ok) { console.log(`  ✓ ${label}`); pass++; }
  else    { console.log(`  ✗ ${label}`); fail++; }
}

console.log(`\n=== Airdrop e2e signet simulation ===`);
console.log(`Worker:  ${WORKER}`);
console.log(`Network: ${NETWORK}`);
console.log(`Asset:   ${FAKE_ASSET.slice(0, 16)}…\n`);

// ---- Phase 1: generate synthetic recipients ----
console.log('Phase 1: generate recipients');
const recipients = [];
for (let i = 0; i < N_RECIPIENTS; i++) {
  const ethPriv = secp.utils.randomPrivateKey();
  const tacitPriv = secp.utils.randomPrivateKey();
  const ethAddr = _ethAddrFromPriv(ethPriv);  // 40-hex (no 0x)
  const tacitPub = bytesToHex(secp.getPublicKey(tacitPriv, true));
  recipients.push({
    leafIdx: i,
    ethPriv, tacitPriv,
    ethAddrHex: ethAddr,
    ethAddrBytes: hexToBytes(ethAddr),
    tacitPubHex: tacitPub,
    amount: BigInt((i + 1) * 1000),  // 1000, 2000, ..., 5000
  });
}
console.log(`  generated ${recipients.length} recipients with random ETH + tacit keys`);

// ---- Phase 2: build merkle tree (issuer side) ----
console.log('\nPhase 2: build merkle commitment');
const leaves = recipients.map(r => airdropLeafHash(r.ethAddrBytes, r.amount, r.leafIdx));
const { root, layers } = buildAirdropMerkle(leaves);
const rootHex = bytesToHex(root);
console.log(`  root: ${rootHex}`);
step('all leaves verify against root via merkle proof', recipients.every(r => {
  const proof = airdropMerkleProof(layers, r.leafIdx);
  return verifyAirdropMerkleProof(leaves[r.leafIdx], proof, root);
}));

// ---- Phase 3: each recipient signs canonical claim msg ----
console.log('\nPhase 3: recipients sign canonical claim msg (simulated MetaMask)');
for (const r of recipients) {
  const msg = buildAirdropClaimMsg({
    rootHex,
    network: NETWORK,
    assetIdHex: FAKE_ASSET,
    ethAddrHex: r.ethAddrHex,
    leafIndex: r.leafIdx,
    amount: r.amount,
    ticker: FAKE_TICKER,
    decimals: FAKE_DECIMALS,
    tacitPubHex: r.tacitPubHex,
  });
  r.claimMsg = msg;
  r.ethSigHex = _signEip191WithPriv(msg, r.ethPriv);
}
step('all recipients self-verify their own sig', recipients.every(r =>
  verifyAirdropClaimSig(r.claimMsg, r.ethSigHex, r.ethAddrHex)
));
console.log(`  example msg (leaf 0):\n${recipients[0].claimMsg.split('\n').map(l => '    | ' + l).join('\n')}`);
console.log(`  example sig (leaf 0): ${recipients[0].ethSigHex.slice(0, 20)}…${recipients[0].ethSigHex.slice(-4)} (${recipients[0].ethSigHex.length - 2} hex)`);

// ---- Phase 4: POST to live worker ----
console.log('\nPhase 4: POST signed claims to live worker');
const baseUrl = `${WORKER}/airdrops/${rootHex}/claims`;
async function postClaim(r) {
  const resp = await fetch(`${baseUrl}?network=${NETWORK}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      leaf_index: r.leafIdx,
      tacit_pubkey: r.tacitPubHex,
      eth_sig: r.ethSigHex,
    }),
  });
  return { status: resp.status, body: await resp.json() };
}
for (const r of recipients) {
  const { status, body } = await postClaim(r);
  step(`POST leaf ${r.leafIdx} → ${status}`, status === 200 && body.ok === true);
}

// ---- Phase 5: GET queue, full pull ----
console.log('\nPhase 5: GET queue (full)');
const listResp = await fetch(`${baseUrl}?network=${NETWORK}`);
const listJson = await listResp.json();
step(`GET status 200`, listResp.status === 200);
step(`count === ${N_RECIPIENTS}`, listJson.count === N_RECIPIENTS);
step(`claims sorted by leaf_index ascending`, listJson.claims.every((c, i) =>
  i === 0 || c.leaf_index >= listJson.claims[i - 1].leaf_index
));
step(`truncated === false`, listJson.truncated === false);
step(`next_cursor === null`, listJson.next_cursor === null);

// ---- Phase 6: issuer-side verification ----
console.log('\nPhase 6: issuer reconstructs canonical msg + verifies each sig');
for (const claim of listJson.claims) {
  const r = recipients[claim.leaf_index];
  // Issuer rebuilds canonical msg from THEIR snapshot data + claim's tacit_pubkey
  const reconstructed = buildAirdropClaimMsg({
    rootHex,
    network: NETWORK,
    assetIdHex: FAKE_ASSET,
    ethAddrHex: r.ethAddrHex,
    leafIndex: r.leafIdx,
    amount: r.amount,
    ticker: FAKE_TICKER,
    decimals: FAKE_DECIMALS,
    tacitPubHex: claim.tacit_pubkey,
  });
  const sigOk = verifyAirdropClaimSig(reconstructed, claim.eth_sig, r.ethAddrHex);
  step(`leaf ${claim.leaf_index}: sig recovers to row's eth_address`, sigOk);
}

// ---- Phase 7: pagination ----
console.log('\nPhase 7: pagination ?limit=2');
const page1Resp = await fetch(`${baseUrl}?network=${NETWORK}&limit=2`);
const page1 = await page1Resp.json();
step(`page 1 count === 2`, page1.count === 2);
step(`page 1 truncated === true`, page1.truncated === true);
step(`page 1 next_cursor present`, typeof page1.next_cursor === 'string' && page1.next_cursor.length > 0);

const page2Resp = await fetch(`${baseUrl}?network=${NETWORK}&limit=2&cursor=${encodeURIComponent(page1.next_cursor)}`);
const page2 = await page2Resp.json();
step(`page 2 count === 2`, page2.count === 2);
step(`page 2 leaves > page 1 leaves`,
  page2.claims.every(c2 => page1.claims.every(c1 => c2.leaf_index > c1.leaf_index))
);

const page3Resp = await fetch(`${baseUrl}?network=${NETWORK}&limit=2&cursor=${encodeURIComponent(page2.next_cursor || '')}`);
const page3 = await page3Resp.json();
step(`page 3 has the remaining 1`, page3.count === 1);
step(`page 3 truncated === false`, page3.truncated === false);

// ---- Phase 8: malformed POST rejection ----
console.log('\nPhase 8: malformed POST rejection');
const badPosts = [
  { body: { leaf_index: -1, tacit_pubkey: '02' + 'a'.repeat(64), eth_sig: '00'.repeat(65) },
    label: 'negative leaf_index' },
  { body: { leaf_index: 0, tacit_pubkey: '04' + 'a'.repeat(64), eth_sig: '00'.repeat(65) },
    label: 'tacit_pubkey wrong prefix (04 = uncompressed)' },
  { body: { leaf_index: 0, tacit_pubkey: '02' + 'a'.repeat(64), eth_sig: '00'.repeat(64) },
    label: 'eth_sig too short (128 hex)' },
];
for (const t of badPosts) {
  const resp = await fetch(`${baseUrl}?network=${NETWORK}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(t.body),
  });
  step(`reject ${t.label} → 400`, resp.status === 400);
}

// ---- Phase 9: re-submission overwrites ----
console.log('\nPhase 9: re-submission for same leaf overwrites');
const r0 = recipients[0];
// Sign a new claim with a DIFFERENT tacit_pubkey but same eth identity
const newTacitPriv = secp.utils.randomPrivateKey();
const newTacitPub = bytesToHex(secp.getPublicKey(newTacitPriv, true));
const newMsg = buildAirdropClaimMsg({
  rootHex, network: NETWORK, assetIdHex: FAKE_ASSET,
  ethAddrHex: r0.ethAddrHex, leafIndex: r0.leafIdx, amount: r0.amount,
  ticker: FAKE_TICKER, decimals: FAKE_DECIMALS, tacitPubHex: newTacitPub,
});
const newSig = _signEip191WithPriv(newMsg, r0.ethPriv);
const reResp = await fetch(`${baseUrl}?network=${NETWORK}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ leaf_index: r0.leafIdx, tacit_pubkey: newTacitPub, eth_sig: newSig }),
});
step(`re-POST status 200`, reResp.status === 200);
const verifyResp = await fetch(`${baseUrl}?network=${NETWORK}`);
const verifyJson = await verifyResp.json();
const updated = verifyJson.claims.find(c => c.leaf_index === r0.leafIdx);
step(`leaf 0's tacit_pubkey was overwritten with new value`, updated.tacit_pubkey === newTacitPub);

// ---- Phase 10: DELETE cleanup ----
console.log('\nPhase 10: DELETE cleanup');
for (const r of recipients) {
  const resp = await fetch(`${baseUrl}/${r.leafIdx}?network=${NETWORK}`, { method: 'DELETE' });
  step(`DELETE leaf ${r.leafIdx} → ${resp.status}`, resp.status === 200);
}
const finalResp = await fetch(`${baseUrl}?network=${NETWORK}`);
const finalJson = await finalResp.json();
step(`queue empty after cleanup (count = 0)`, finalJson.count === 0);

// ---- Summary ----
console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail > 0 ? 1 : 0);
