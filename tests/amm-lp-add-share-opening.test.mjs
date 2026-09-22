// LP-add share opening: the envelope has no proof tail, so the mint is bound by the kernel signatures plus a DIRECT
// opening of the share commitment (shareCSecp == share_amount*H + shareR*G). The dapp validator checks this opening
// rather than requiring a Groth16 proof, since the encoder never emits one.
//
// Runs offline, no DOM: node tests/amm-lp-add-share-opening.test.mjs

import { hexToBytes, bytesToHex } from '@noble/hashes/utils';
import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha256';
import * as secp from '@noble/secp256k1';

const dappBp = await import('../dapp/bulletproofs.js');
const dappKernel = await import('../dapp/amm-kernel.js');
const dappEnvelope = await import('../dapp/amm-envelope.js');
const dappAsset = await import('../dapp/amm-asset.js');
const worker = await import('../worker/src/index.js');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { console.log(`  PASS  ${name}`); pass++; } else { console.log(`  FAIL  ${name}${detail ? ' - ' + detail : ''}`); fail++; }
}

const sk = secp.utils.randomPrivateKey();
const det = (tag) => hmac(sha256, sk, new TextEncoder().encode(tag));
const shareAmount = 1_414_213n;
const shareR = det('share-r');
const shareCSecp = dappBp.pedersenCommit(shareAmount, BigInt('0x' + bytesToHex(shareR))).toRawBytes(true);

console.log('\nthe opening rule:');
ok('a correct opening passes', dappKernel.lpAddShareOpens({ shareAmount, shareCSecp, shareR }) === true);
ok('amount as a string passes', dappKernel.lpAddShareOpens({ shareAmount: shareAmount.toString(), shareCSecp, shareR }) === true);
ok('hex inputs pass', dappKernel.lpAddShareOpens({ shareAmount, shareCSecp: bytesToHex(shareCSecp), shareR: bytesToHex(shareR) }) === true);
ok('wrong amount is rejected', dappKernel.lpAddShareOpens({ shareAmount: shareAmount + 1n, shareCSecp, shareR }) === false);
ok('wrong blinding is rejected', dappKernel.lpAddShareOpens({ shareAmount, shareCSecp, shareR: det('other') }) === false);
ok('a different commitment is rejected', dappKernel.lpAddShareOpens({ shareAmount, shareCSecp: dappBp.pedersenCommit(shareAmount, 5n).toRawBytes(true), shareR }) === false);
ok('zero amount is rejected', dappKernel.lpAddShareOpens({ shareAmount: 0n, shareCSecp, shareR }) === false);
ok('an amount past u64 is rejected', dappKernel.lpAddShareOpens({ shareAmount: 1n << 64n, shareCSecp, shareR }) === false);
ok('a short blinding is rejected', dappKernel.lpAddShareOpens({ shareAmount, shareCSecp, shareR: shareR.slice(0, 31) }) === false);
ok('a short commitment is rejected', dappKernel.lpAddShareOpens({ shareAmount, shareCSecp: shareCSecp.slice(0, 32), shareR }) === false);
ok('missing fields are rejected', dappKernel.lpAddShareOpens({ shareAmount, shareCSecp }) === false);

console.log('\non a real envelope, through encode -> decode:');
{
  const [a, b] = dappAsset.canonicalAssetPair(new Uint8Array(32).fill(1), new Uint8Array(32).fill(2));
  const payload = dappEnvelope.encodeLpAdd({
    variant: 1, assetA: a, assetB: b, deltaA: 1_000_000n, deltaB: 2_000_000n, shareAmount,
    shareCSecp, shareCBJJ: new Uint8Array(32).fill(7), shareXcurveSigma: new Uint8Array(169),
    kernelSigA: new Uint8Array(64).fill(1), kernelSigB: new Uint8Array(64).fill(2),
    feeBps: 30, vkCid: 'bafyTestVk', ceremonyCid: 'bafyTestCe', arbiterPubkeys: [], launcherSigs: [],
    protocolFeeAddress: new Uint8Array(33), protocolFeeBps: 0, poolMetaUri: '', poolCapabilityFlags: 0,
    shareR, expiryHeight: 967_900, refundABlinding: det('ra'), refundBBlinding: det('rb'),
  });
  const dec = dappEnvelope.decodeLpAdd(payload);
  ok('the dapp decoder returns the share opening', !!dec && dec.shareR instanceof Uint8Array && dec.shareR.length === 32);
  ok('the decoded envelope opens', !!dec && dappKernel.lpAddShareOpens({ shareAmount: dec.shareAmount, shareCSecp: dec.shareCSecp, shareR: dec.shareR }) === true);
  const wdec = worker.decodeTLpAddPayload(payload);
  ok('the worker decoder agrees on the opening', !!wdec && wdec.share_r === bytesToHex(shareR) && dappKernel.lpAddShareOpens({ shareAmount: wdec.share_amount, shareCSecp: wdec.share_c_secp, shareR: wdec.share_r }) === true);
  ok('the decoded envelope carries no proof tail', !!dec && !dec.proof);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
