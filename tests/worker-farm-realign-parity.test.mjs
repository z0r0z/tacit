// Worker farm decoders + owner-msg helpers ↔ dapp/amm-envelope.js (source of truth).
//
// The worker's AMM-farm decoders/handlers were re-aligned to the reflection receipt
// envelope layouts (bond +owner_commit/nonce, harvest 346B, unbond 217B receipt-only)
// and to the owner-key keccak auth. Drift here means the worker can't parse or
// authenticate the harvest/unbond/bond envelopes the dapp actually broadcasts, so
// /farm state + positions silently stop indexing. This pins byte-for-byte parity.
//
// Run: `node tests/worker-farm-realign-parity.test.mjs`
import * as secp from '@noble/secp256k1';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { signSchnorr, verifySchnorr } from '../dapp/bulletproofs.js';
import {
  encodeLpBond, encodeLpHarvest, encodeLpUnbond,
  farmReceiptLeaf as dFarmReceiptLeaf,
  lpHarvestOwnerMsg as dHarvestMsg, lpUnbondOwnerMsg as dUnbondMsg,
} from '../dapp/amm-envelope.js';
import {
  decodeTLpBondPayload, decodeTLpHarvestPayload, decodeTLpUnbondPayload,
  farmReceiptLeaf as wFarmReceiptLeaf,
  lpHarvestOwnerMsg as wHarvestMsg, lpUnbondOwnerMsg as wUnbondMsg,
} from '../worker/src/index.js';

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log('ok   ' + n); } else { fail++; console.log('FAIL ' + n); } };
const b = (n) => { const u = new Uint8Array(n); for (let i = 0; i < n; i++) u[i] = (i * 7 + 1) & 0xff; return u; };

const farmId = b(32), owner = b(32), nonce = b(32), oldNonce = b(32), newNonce = b(32);
// valid compressed secp point (generator G) — the bond/harvest decoders point-validate the pubkey
const bonderPub = hexToBytes('0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798');
const rewardR = b(32), lpReturnR = b(32), rp = new Uint8Array([0x01]);
const z33 = new Uint8Array(33), z64 = new Uint8Array(64), z36 = b(36);
const shares = 1234567n, rpsEntry = 99887766554433n, reward = 4242n, entryAcc = 7777n;

// ---- decoder roundtrips: dapp encode → worker decode ----
{
  const pl = encodeLpBond({ farmId, bonderPubkey: bonderPub, bondAmount: shares, entryAccPerShare: entryAcc,
    bondViewHeight: 800000, ownerCommit: owner, nonce, cChangeOrSentinel: z33, rangeProof: rp, kernelSig: z64, bonderSig: z64 });
  const d = decodeTLpBondPayload(pl);
  ok('bond decodes', !!d);
  ok('bond.owner_commit', d && d.owner_commit === bytesToHex(owner));
  ok('bond.receipt_nonce', d && d.receipt_nonce === bytesToHex(nonce));
  ok('bond.entry_acc', d && d.entry_acc_per_share === entryAcc.toString());
  ok('bond.bond_amount', d && d.bond_amount === shares.toString());
}
{
  const pl = encodeLpHarvest({ farmId, bondId: z36, harvesterPubkey: bonderPub, exitAccPerShare: entryAcc,
    exitViewHeight: 800001, rewardAmount: reward, rewardR, ownerCommit: owner, oldNonce, newNonce, shares, rpsEntry, harvesterSig: z64 });
  ok('harvest len 346', pl.length === 346);
  const d = decodeTLpHarvestPayload(pl);
  ok('harvest decodes', !!d);
  ok('harvest.owner_commit', d && d.owner_commit === bytesToHex(owner));
  ok('harvest.old_nonce', d && d.old_nonce === bytesToHex(oldNonce));
  ok('harvest.new_nonce', d && d.new_nonce === bytesToHex(newNonce));
  ok('harvest.shares', d && d.shares === shares.toString());
  ok('harvest.rps_entry', d && d.rps_entry === rpsEntry.toString());
  ok('harvest.reward_amount', d && d.reward_amount === reward.toString());
  ok('harvest.reward_r', d && d.reward_r === bytesToHex(rewardR));
  ok('harvest.bond_id', d && d.bond_id === bytesToHex(z36));
}
{
  const pl = encodeLpUnbond({ farmId, ownerCommit: owner, nonce, shares, rpsEntry, lpReturnR, unbonderSig: z64 });
  ok('unbond len 217', pl.length === 217);
  const d = decodeTLpUnbondPayload(pl);
  ok('unbond decodes', !!d);
  ok('unbond.owner_commit', d && d.owner_commit === bytesToHex(owner));
  ok('unbond.receipt_nonce', d && d.receipt_nonce === bytesToHex(nonce));
  ok('unbond.shares', d && d.shares === shares.toString());
  ok('unbond.rps_entry', d && d.rps_entry === rpsEntry.toString());
  ok('unbond.lp_return_r', d && d.lp_return_r === bytesToHex(lpReturnR));
}
// length discrimination: an old-layout (258B) unbond must NOT decode as the new one
ok('unbond rejects old 258B', decodeTLpUnbondPayload(new Uint8Array(258)) === null);
ok('harvest rejects old 226B', decodeTLpHarvestPayload(new Uint8Array(226)) === null);

// ---- owner-msg / receipt-leaf byte parity (worker vs dapp) ----
{
  const dLeaf = dFarmReceiptLeaf({ farmId, shares, rpsEntry, owner, nonce });
  const wLeaf = wFarmReceiptLeaf(bytesToHex(farmId), shares, rpsEntry, bytesToHex(owner), bytesToHex(nonce));
  ok('receiptLeaf parity', bytesToHex(dLeaf) === bytesToHex(wLeaf));

  const destSpk = new Uint8Array([0x00, 0x14, ...b(20)]);
  const dH = dHarvestMsg({ farmId, oldLeaf: dLeaf, reward, rewardR, destSpk });
  const wH = wHarvestMsg(bytesToHex(farmId), wLeaf, reward, bytesToHex(rewardR), destSpk);
  ok('harvestOwnerMsg parity', bytesToHex(dH) === bytesToHex(wH));

  const dU = dUnbondMsg({ farmId, oldLeaf: dLeaf, shares, lpReturnR, destSpk });
  const wU = wUnbondMsg(bytesToHex(farmId), wLeaf, shares, bytesToHex(lpReturnR), destSpk);
  ok('unbondOwnerMsg parity', bytesToHex(dU) === bytesToHex(wU));

  // reward==0 → empty destSpk (matches guest output_scriptpubkey fallback + dapp harvestDestSpk)
  const dH0 = dHarvestMsg({ farmId, oldLeaf: dLeaf, reward: 0n, rewardR, destSpk: new Uint8Array(0) });
  const wH0 = wHarvestMsg(bytesToHex(farmId), wLeaf, 0n, bytesToHex(rewardR), new Uint8Array(0));
  ok('harvestOwnerMsg parity (reward=0, empty spk)', bytesToHex(dH0) === bytesToHex(wH0));
}

// ---- end-to-end owner-auth: a real BIP-340 sig over the worker's msg verifies
// against owner_commit, and a redirected dest_spk (front-run) is rejected ----
{
  const priv = b(32); priv[0] |= 1;
  const xonly = secp.getPublicKey(priv, true).slice(1);   // 32-byte x-only = owner_commit
  const ownerHex = bytesToHex(xonly);
  const destSpk = new Uint8Array([0x00, 0x14, ...b(20)]);
  const destSpkFR = new Uint8Array([0x00, 0x14, ...b(20).map((x) => x ^ 0xff)]);
  const leaf = wFarmReceiptLeaf(bytesToHex(farmId), shares, rpsEntry, ownerHex, bytesToHex(nonce));

  const hMsg = wHarvestMsg(bytesToHex(farmId), leaf, reward, bytesToHex(rewardR), destSpk);
  const hSig = signSchnorr(hMsg, priv);
  ok('harvest owner-sig verifies (worker path)', verifySchnorr(hSig, hMsg, xonly));
  const hMsgFR = wHarvestMsg(bytesToHex(farmId), leaf, reward, bytesToHex(rewardR), destSpkFR);
  ok('harvest owner-sig REJECTS redirected dest_spk (front-run)', !verifySchnorr(hSig, hMsgFR, xonly));

  const uMsg = wUnbondMsg(bytesToHex(farmId), leaf, shares, bytesToHex(lpReturnR), destSpk);
  const uSig = signSchnorr(uMsg, priv);
  ok('unbond owner-sig verifies (worker path)', verifySchnorr(uSig, uMsg, xonly));
  const uMsgFR = wUnbondMsg(bytesToHex(farmId), leaf, shares, bytesToHex(lpReturnR), destSpkFR);
  ok('unbond owner-sig REJECTS redirected dest_spk (front-run)', !verifySchnorr(uSig, uMsgFR, xonly));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
