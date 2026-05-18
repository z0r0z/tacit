// Dapp builders for the five LP-bond farm opcodes.
//
// Composes envelope encoders from dapp/amm-envelope.js with the
// taproot script-path tx-construction primitives from dapp/tacit.js
// into one-call buildAndBroadcast* helpers the UI tile uses for the
// Bond / Harvest / Unbond / Refund actions, plus the Create-Farm
// launcher flow.
//
// Pattern mirrors buildAndBroadcastSwapRoute / Slot* builders in
// tacit.js: each function ensures the privkey is loaded, builds the
// envelope, composes commit + reveal Bitcoin txs with the right vin/
// vout structure for that opcode, signs, broadcasts, and returns the
// reveal txid + computed bond_id / receipt info.
//
// All five builders are pure dispatch — no protocol logic. The math
// + crypto comes from amm-envelope.js (which mirrors the ref impl at
// tests/amm-farm.mjs byte-for-byte).

import {
  // Envelope encoders + msg builders
  encodeFarmInit, encodeLpBond, encodeLpUnbond,
  encodeLpHarvest, encodeFarmRefund,
  buildFarmInitMsg, buildLpBondMsg, buildLpUnbondMsg,
  buildLpHarvestMsg, buildFarmRefundMsg,
  deriveFarmId, deriveLpAssetIdFromPoolId,
  FARM_NO_CHANGE_SENTINEL, FARM_ACC_FIXED_POINT_SHIFT,
} from './amm-envelope.js';

import {
  // tacit.js primitives
  wallet, ensurePrivkey, scanHoldings, invalidateHoldingsCache,
  carveExactAmount, getUtxos, getFeeRate, feeFor,
  broadcast, broadcastWithRetry, DUST, NET,
  encodeEnvelopeScript, tapLeafHash, tweakedOutputKey,
  controlBlock, p2trScript, p2wpkhScript, TAP_NUMS,
  signP2wpkhInput, signTaprootScriptPathInput,
  serializeTx, txid as computeTxid,
  estCommitVb, sortSatsForCommit,
  signSchnorr, pedersenCommit, pointToBytes, SECP_N, modN,
  recordOpening,
} from './tacit.js';

import { concatBytes, hexToBytes, bytesToHex, sha256 } from './vendor/tacit-deps.min.js';

function bigintToBytes32(n) {
  let x = BigInt(n);
  if (x < 0n) x = ((x % SECP_N) + SECP_N) % SECP_N;
  const b = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) { b[i] = Number(x & 0xffn); x >>= 8n; }
  return b;
}

function randomScalar() {
  // Use the dapp's globalThis.crypto for browser + jsdom compatibility.
  const b = new Uint8Array(32);
  globalThis.crypto.getRandomValues(b);
  let n = BigInt('0x' + bytesToHex(b));
  if (n === 0n) n = 1n;
  return modN(n);
}

// Shared commit+reveal tx-composition helper. Used by every farm
// builder. Caller provides:
//   payload          : envelope payload bytes (from encodeFarmInit etc.)
//   envelopeHash     : SHA256(payload) — caller computes, we OP_RETURN it
//   vin1             : { txid, vout } if the opcode consumes a tacit asset
//                      input (FARM_INIT, LP_BOND); null for the rest
//   extraOutputs     : [{ value, script }, ...] vouts after OP_RETURN.
//                      For FARM_INIT: change UTXO (if any).
//                      For LP_BOND: bond marker + change.
//                      For LP_UNBOND: lp_return + reward (if payout > 0).
//                      For LP_HARVEST / FARM_REFUND: reward / refund UTXO.
async function broadcastFarmTx({ payload, envelopeHash, vin1, extraOutputs = [] }) {
  await ensurePrivkey();
  const envelopeScript = encodeEnvelopeScript(wallet.xonly(), payload);
  const tapLeaf = tapLeafHash(envelopeScript);
  const { Q_xonly, parity } = tweakedOutputKey(TAP_NUMS, tapLeaf);
  const commitSpk = p2trScript(Q_xonly);
  const cb = controlBlock(TAP_NUMS, parity);

  const feeRate = await getFeeRate();
  const opReturnSpk = concatBytes(new Uint8Array([0x6a, 0x20]), envelopeHash);

  // Estimate reveal vbytes (approximate; rounded up for fee safety).
  const dustOutBytes = extraOutputs.reduce((s, o) => s + (o.script.length + 9), 0);
  const revealVbBase = 11 + 41 + (vin1 ? 41 : 0) + 34 + dustOutBytes;
  const revealVb = revealVbBase + Math.ceil((1 + 1 + 65 + 3 + 45 + payload.length + 34 + 109) / 4);
  const revealFee = feeFor(revealVb, feeRate);
  const commitValue = Math.max(DUST, revealFee + extraOutputs.reduce((s, o) => s + o.value, 0));

  const allUtxos = await getUtxos(wallet.address());
  const assetKey = vin1 ? `${vin1.txid}:${vin1.vout}` : null;
  const sats = sortSatsForCommit(allUtxos.filter(u =>
    u.value > DUST && (!assetKey || `${u.txid}:${u.vout}` !== assetKey)));
  const picked = []; let total = 0; let commitFee = 500;
  for (const u of sats) {
    picked.push(u); total += u.value;
    commitFee = feeFor(estCommitVb(picked.length), feeRate);
    if (total >= commitValue + commitFee + DUST) break;
  }
  if (total < commitValue + commitFee) {
    throw new Error(`insufficient sats for farm tx: need ${commitValue + commitFee}, have ${total} (across ${picked.length} confirmed UTXOs)`);
  }
  const changeSats = total - commitValue - commitFee;
  const changeSpk = p2wpkhScript(wallet.pub);

  const commitOutputs = [{ value: commitValue, script: commitSpk }];
  if (changeSats >= DUST) commitOutputs.push({ value: changeSats, script: changeSpk });
  const commitTx = {
    version: 2, locktime: 0,
    inputs: picked.map(u => ({ txid: u.txid, vout: u.vout, sequence: 0xfffffffd, witness: [] })),
    outputs: commitOutputs,
  };
  for (let i = 0; i < commitTx.inputs.length; i++) {
    commitTx.inputs[i].witness = signP2wpkhInput(commitTx, i, picked[i].value);
  }
  const commitHex = bytesToHex(serializeTx(commitTx));
  const commitTxidHex = computeTxid(commitTx);

  const revealInputs = [
    { txid: commitTxidHex, vout: 0, sequence: 0xfffffffd, witness: [] },
  ];
  const revealPrevouts = [{ value: commitValue, script: commitSpk }];
  if (vin1) {
    revealInputs.push({ txid: vin1.txid, vout: vin1.vout | 0, sequence: 0xfffffffd, witness: [] });
    revealPrevouts.push({ value: DUST, script: p2wpkhScript(wallet.pub) });
  }
  const revealOutputs = [{ value: 0, script: opReturnSpk }, ...extraOutputs];
  const revealTx = {
    version: 2, locktime: 0,
    inputs: revealInputs,
    outputs: revealOutputs,
  };
  revealTx.inputs[0].witness = signTaprootScriptPathInput(
    revealTx, revealPrevouts, envelopeScript, cb,
  );
  if (vin1) revealTx.inputs[1].witness = signP2wpkhInput(revealTx, 1, DUST);
  const revealHex = bytesToHex(serializeTx(revealTx));
  const revealTxidHex = computeTxid(revealTx);

  await broadcast(commitHex);
  await broadcastWithRetry(revealHex);
  return { commitTxid: commitTxidHex, revealTxid: revealTxidHex };
}

// ============================================================
// T_FARM_INIT — launcher creates farm
// ============================================================

export async function buildAndBroadcastFarmInit({
  poolIdHex, rewardAssetIdHex, rewardTotal, rewardPerBlock,
  startHeight,
}) {
  await ensurePrivkey();
  const rewardTotalBig = BigInt(rewardTotal);
  const rewardPerBlockBig = BigInt(rewardPerBlock);
  if (rewardPerBlockBig === 0n) throw new Error('reward_per_block must be > 0');
  if (rewardTotalBig % rewardPerBlockBig !== 0n) {
    throw new Error('reward_total must be divisible by reward_per_block');
  }
  const endHeight = startHeight + Number(rewardTotalBig / rewardPerBlockBig);

  const farmNonce = new Uint8Array(32);
  globalThis.crypto.getRandomValues(farmNonce);
  const farmIdBytes = deriveFarmId({
    poolId: hexToBytes(poolIdHex),
    launcherPubkey: wallet.pub,
    rewardAssetId: hexToBytes(rewardAssetIdHex),
    farmNonce,
  });

  // Carve exact-amount reward UTXO (sentinel-case for clean closure).
  const carved = await carveExactAmount({ assetIdHex: rewardAssetIdHex, amount: rewardTotalBig });
  if (!carved || !carved.utxo) throw new Error('failed to carve reward UTXO');
  const inputBlind = BigInt(carved.blinding);
  const cChangeOrSentinel = FARM_NO_CHANGE_SENTINEL;
  // Sentinel-case bulletproof: structural placeholder. Worker accepts
  // non-empty bytes when V_pt is ZERO (per spec's identity-sentinel rule).
  const rangeProof = new Uint8Array([0x01]);

  // Kernel sig closes the reward-asset side: excess = −r_in.
  const kernelExcess = modN(-inputBlind);
  // computeKernelMsg via the ref-impl-style helper would be cleaner;
  // we inline the bytes the worker expects to match buildFarmInitKernelMsg.
  const KERNEL_DOMAIN = new TextEncoder().encode('tacit-kernel-v1');
  const txidBE = new Uint8Array(32);
  const txidLE = hexToBytes(carved.utxo.txid);
  for (let i = 0; i < 32; i++) txidBE[i] = txidLE[31 - i];
  const voutLE = new Uint8Array(4);
  new DataView(voutLE.buffer).setUint32(0, carved.utxo.vout | 0, true);
  const burnedLE = new Uint8Array(8);
  const burnedView = new DataView(burnedLE.buffer);
  burnedView.setUint32(0, Number(rewardTotalBig & 0xffffffffn), true);
  burnedView.setUint32(4, Number((rewardTotalBig >> 32n) & 0xffffffffn), true);
  const kernelMsg = sha256(concatBytes(
    KERNEL_DOMAIN,
    hexToBytes(rewardAssetIdHex),
    new Uint8Array([1]),               // input_count
    txidBE, voutLE,
    new Uint8Array([1]),               // output_count
    cChangeOrSentinel,
    burnedLE,
  ));
  const kernelSig = signSchnorr(kernelMsg, bigintToBytes32(kernelExcess));

  const initMsg = buildFarmInitMsg({
    farmId: farmIdBytes, launcherPubkey: wallet.pub,
    rewardTotal: rewardTotalBig, rewardPerBlock: rewardPerBlockBig,
    startHeight, endHeight,
  });
  const launcherSig = signSchnorr(initMsg, wallet.priv);

  const payload = encodeFarmInit({
    poolId: hexToBytes(poolIdHex), farmNonce,
    launcherPubkey: wallet.pub,
    rewardAssetId: hexToBytes(rewardAssetIdHex),
    rewardTotal: rewardTotalBig, rewardPerBlock: rewardPerBlockBig,
    startHeight, endHeight,
    cChangeOrSentinel, rangeProof,
    kernelSig, launcherSig,
  });
  const envelopeHash = sha256(payload);

  const res = await broadcastFarmTx({
    payload, envelopeHash,
    vin1: { txid: carved.utxo.txid, vout: carved.utxo.vout },
    extraOutputs: [],  // sentinel case: no change vout
  });
  return {
    farmIdHex: bytesToHex(farmIdBytes),
    revealTxid: res.revealTxid,
    commitTxid: res.commitTxid,
    startHeight, endHeight,
  };
}

// ============================================================
// T_LP_BOND — bond LP shares
// ============================================================

export async function buildAndBroadcastLpBond({
  farmIdHex, poolIdHex, bondAmount,
  entryAccPerShare, bondViewHeight,
}) {
  await ensurePrivkey();
  const bondAmountBig = BigInt(bondAmount);
  const lpAssetIdBytes = deriveLpAssetIdFromPoolId(hexToBytes(poolIdHex));
  const lpAssetIdHex = bytesToHex(lpAssetIdBytes);

  // Carve exact-amount LP UTXO if possible; otherwise use a larger UTXO + change.
  const carved = await carveExactAmount({ assetIdHex: lpAssetIdHex, amount: bondAmountBig });
  if (!carved || !carved.utxo) throw new Error(`failed to carve ${bondAmountBig} of LP shares`);
  const inputValue = BigInt(carved.amount);
  const inputBlind = BigInt(carved.blinding);
  const changeValue = inputValue - bondAmountBig;

  let cChangeOrSentinel, rangeProof, kernelExcess;
  if (changeValue === 0n) {
    cChangeOrSentinel = FARM_NO_CHANGE_SENTINEL;
    rangeProof = new Uint8Array([0x01]);
    kernelExcess = modN(-inputBlind);
  } else {
    const changeBlind = randomScalar();
    const cChange = pedersenCommit(changeValue, changeBlind);
    cChangeOrSentinel = pointToBytes(cChange);
    // For non-sentinel case, the worker expects a real bulletproof.
    // Browser-side bulletproof generation isn't wired here; the UI should
    // ensure carveExactAmount returns an exact-size UTXO so we hit the
    // sentinel branch. If we somehow ended up with change, surface a
    // clear error.
    throw new Error('LP_BOND with non-zero change is not yet wired in this dapp build; ' +
                    'carveExactAmount should produce an exact-amount UTXO. Try unbond/re-bond.');
  }

  const KERNEL_DOMAIN = new TextEncoder().encode('tacit-kernel-v1');
  const txidBE = new Uint8Array(32);
  const txidLE = hexToBytes(carved.utxo.txid);
  for (let i = 0; i < 32; i++) txidBE[i] = txidLE[31 - i];
  const voutLE = new Uint8Array(4);
  new DataView(voutLE.buffer).setUint32(0, carved.utxo.vout | 0, true);
  const burnedLE = new Uint8Array(8);
  const burnedView = new DataView(burnedLE.buffer);
  burnedView.setUint32(0, Number(bondAmountBig & 0xffffffffn), true);
  burnedView.setUint32(4, Number((bondAmountBig >> 32n) & 0xffffffffn), true);
  const kernelMsg = sha256(concatBytes(
    KERNEL_DOMAIN,
    lpAssetIdBytes,
    new Uint8Array([1]), txidBE, voutLE,
    new Uint8Array([1]), cChangeOrSentinel,
    burnedLE,
  ));
  const kernelSig = signSchnorr(kernelMsg, bigintToBytes32(kernelExcess));

  const bondMsg = buildLpBondMsg({
    farmId: hexToBytes(farmIdHex), bonderPubkey: wallet.pub,
    bondAmount: bondAmountBig,
    entryAccPerShare: BigInt(entryAccPerShare),
    bondViewHeight,
  });
  const bonderSig = signSchnorr(bondMsg, wallet.priv);

  const payload = encodeLpBond({
    farmId: hexToBytes(farmIdHex), bonderPubkey: wallet.pub,
    bondAmount: bondAmountBig,
    entryAccPerShare: BigInt(entryAccPerShare),
    bondViewHeight,
    cChangeOrSentinel, rangeProof,
    kernelSig, bonderSig,
  });
  const envelopeHash = sha256(payload);

  const bondMarkerSpk = p2wpkhScript(wallet.pub);
  const res = await broadcastFarmTx({
    payload, envelopeHash,
    vin1: { txid: carved.utxo.txid, vout: carved.utxo.vout },
    extraOutputs: [{ value: DUST, script: bondMarkerSpk }],
  });
  // bond_id = vout[1].outpoint of reveal tx.
  const revealTxidBytes = hexToBytes(res.revealTxid);
  const revealTxidBE = new Uint8Array(32);
  for (let i = 0; i < 32; i++) revealTxidBE[i] = revealTxidBytes[31 - i];
  const bondIdBytes = new Uint8Array(36);
  bondIdBytes.set(revealTxidBE, 0);
  new DataView(bondIdBytes.buffer).setUint32(32, 1, true);
  return {
    bondIdHex: bytesToHex(bondIdBytes),
    revealTxid: res.revealTxid,
    commitTxid: res.commitTxid,
  };
}

// ============================================================
// T_LP_HARVEST — claim reward, keep bond alive
// ============================================================

export async function buildAndBroadcastLpHarvest({
  farmIdHex, bondIdHex, exitAccPerShare, exitViewHeight, rewardAmount,
}) {
  await ensurePrivkey();
  const rewardAmountBig = BigInt(rewardAmount);
  const rewardR = bigintToBytes32(randomScalar());
  const harvestMsg = buildLpHarvestMsg({
    farmId: hexToBytes(farmIdHex), bondId: hexToBytes(bondIdHex),
    harvesterPubkey: wallet.pub,
    exitAccPerShare: BigInt(exitAccPerShare),
    exitViewHeight,
    rewardAmount: rewardAmountBig,
    rewardR,
  });
  const harvesterSig = signSchnorr(harvestMsg, wallet.priv);
  const payload = encodeLpHarvest({
    farmId: hexToBytes(farmIdHex), bondId: hexToBytes(bondIdHex),
    harvesterPubkey: wallet.pub,
    exitAccPerShare: BigInt(exitAccPerShare),
    exitViewHeight,
    rewardAmount: rewardAmountBig,
    rewardR, harvesterSig,
  });
  const envelopeHash = sha256(payload);
  const rewardSpk = p2wpkhScript(wallet.pub);
  const extraOutputs = rewardAmountBig > 0n
    ? [{ value: DUST, script: rewardSpk }]
    : [];
  const res = await broadcastFarmTx({
    payload, envelopeHash, vin1: null, extraOutputs,
  });
  // Persist the reward UTXO's opening so scanHoldings picks it up.
  // The validator emits vout[1] (when payout > 0) of asset_id = reward_asset_id,
  // committed to (rewardAmount, rewardR). recordOpening lets the wallet
  // know how to spend it forward.
  if (rewardAmountBig > 0n) {
    // The dapp doesn't yet know reward_asset_id at this layer; the
    // caller (UI) should pass it through and we record here. Defer
    // recording to caller for now.
  }
  return { revealTxid: res.revealTxid, commitTxid: res.commitTxid, rewardR: bytesToHex(rewardR) };
}

// ============================================================
// T_LP_UNBOND — settle bond, return LP shares + final reward
// ============================================================

export async function buildAndBroadcastLpUnbond({
  farmIdHex, bondIdHex, exitAccPerShare, exitViewHeight, rewardAmount,
}) {
  await ensurePrivkey();
  const rewardAmountBig = BigInt(rewardAmount);
  const lpReturnR = bigintToBytes32(randomScalar());
  const rewardR = rewardAmountBig === 0n ? new Uint8Array(32) : bigintToBytes32(randomScalar());
  const unbondMsg = buildLpUnbondMsg({
    farmId: hexToBytes(farmIdHex), bondId: hexToBytes(bondIdHex),
    unbonderPubkey: wallet.pub,
    exitAccPerShare: BigInt(exitAccPerShare),
    exitViewHeight,
    rewardAmount: rewardAmountBig,
    lpReturnR, rewardR,
  });
  const unbonderSig = signSchnorr(unbondMsg, wallet.priv);
  const payload = encodeLpUnbond({
    farmId: hexToBytes(farmIdHex), bondId: hexToBytes(bondIdHex),
    unbonderPubkey: wallet.pub,
    exitAccPerShare: BigInt(exitAccPerShare),
    exitViewHeight,
    rewardAmount: rewardAmountBig,
    lpReturnR, rewardR, unbonderSig,
  });
  const envelopeHash = sha256(payload);
  const myAddr = p2wpkhScript(wallet.pub);
  const extraOutputs = [{ value: DUST, script: myAddr }];   // lp_return
  if (rewardAmountBig > 0n) extraOutputs.push({ value: DUST, script: myAddr });
  const res = await broadcastFarmTx({
    payload, envelopeHash, vin1: null, extraOutputs,
  });
  return { revealTxid: res.revealTxid, commitTxid: res.commitTxid, lpReturnR: bytesToHex(lpReturnR), rewardR: bytesToHex(rewardR) };
}

// ============================================================
// T_FARM_REFUND — launcher reclaims unspent treasury
// ============================================================

export async function buildAndBroadcastFarmRefund({
  farmIdHex, refundAmount, refundViewHeight,
}) {
  await ensurePrivkey();
  const refundAmountBig = BigInt(refundAmount);
  const refundR = bigintToBytes32(randomScalar());
  const refundMsg = buildFarmRefundMsg({
    farmId: hexToBytes(farmIdHex), launcherPubkey: wallet.pub,
    refundAmount: refundAmountBig,
    refundViewHeight,
    refundR,
  });
  const launcherSig = signSchnorr(refundMsg, wallet.priv);
  const payload = encodeFarmRefund({
    farmId: hexToBytes(farmIdHex), launcherPubkey: wallet.pub,
    refundAmount: refundAmountBig,
    refundViewHeight,
    refundR, launcherSig,
  });
  const envelopeHash = sha256(payload);
  const refundSpk = p2wpkhScript(wallet.pub);
  const res = await broadcastFarmTx({
    payload, envelopeHash, vin1: null,
    extraOutputs: [{ value: DUST, script: refundSpk }],
  });
  return { revealTxid: res.revealTxid, commitTxid: res.commitTxid, refundR: bytesToHex(refundR) };
}

// ============================================================
// Worker queries (used by the UI to render farm state)
// ============================================================

const WORKER_BASE_RX = /^https?:\/\/[^\s/]+/;
function workerBase() {
  // Dapp's NET constant or env-pinned base. Falls back to localStorage.
  try {
    const v = localStorage.getItem('tacit-worker-base-v1');
    if (v && WORKER_BASE_RX.test(v)) return v;
  } catch {}
  // Default production worker base.
  return 'https://tacit-pin.rosscampbell9.workers.dev';
}

export async function fetchFarm(farmIdHex) {
  const r = await fetch(`${workerBase()}/farm/${farmIdHex}?network=${NET || 'signet'}`);
  if (!r.ok) return null;
  return await r.json();
}

export async function fetchFarmsForPool(poolIdHex) {
  const r = await fetch(`${workerBase()}/farms?pool=${poolIdHex}&network=${NET || 'signet'}`);
  if (!r.ok) return { farms: [] };
  return await r.json();
}

export async function fetchAllFarms({ cursor = null, limit = 50 } = {}) {
  let url = `${workerBase()}/farms?network=${NET || 'signet'}&limit=${limit}`;
  if (cursor) url += `&cursor=${encodeURIComponent(cursor)}`;
  const r = await fetch(url);
  if (!r.ok) return { farms: [], cursor: null };
  return await r.json();
}

export async function fetchBondsForBonder(farmIdHex, bonderPubHex) {
  const r = await fetch(
    `${workerBase()}/farm/${farmIdHex}/bonds?bonder=${bonderPubHex}&network=${NET || 'signet'}`,
  );
  if (!r.ok) return { bonds: [] };
  return await r.json();
}
