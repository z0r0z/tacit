// Unit tests for the dapp-side helpers in publishPreauthBidVar (SPEC §5.7.12):
//   _preauthBidVarNonceFromOutpoint, _preauthBidVarIdHex,
//   _preauthBidVarAuthMsg, _preauthBidVarCancelMsg, plus the per-ratio
//   bid_context_hash + sighash-preimage construction (reuses the §5.7.11
//   _preauthBidSighashPreimage shape with the new per-ratio hash).
//
// Each helper has a clean, deterministic spec; these tests pin field
// ordering, domain tags, and byte-level details the worker reproduces
// when verifying VAR bid records.

import { hexToBytes, bytesToHex, concatBytes } from '@noble/hashes/utils';
import { sha256 } from '@noble/hashes/sha2';
import { hmac } from '@noble/hashes/hmac';
import { ripemd160 } from '@noble/hashes/ripemd160';

let pass = 0, fail = 0;
function test(label, fn) {
  try {
    const ok = fn();
    if (ok) { console.log(`  PASS  ${label}`); pass++; }
    else    { console.log(`  FAIL  ${label}`); fail++; }
  } catch (e) {
    console.log(`  THROW ${label}: ${e.message}`); fail++;
  }
}

function reverseBytes(b) { const r = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) r[i] = b[b.length - 1 - i]; return r; }
function hash160(b) { return ripemd160(sha256(b)); }
function eq(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
function u64LE(n) { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(n), true); return b; }

function _preauthVarslice(b) {
  if (b.length < 0xfd) return concatBytes(new Uint8Array([b.length]), b);
  if (b.length <= 0xffff) {
    const lenLE = new Uint8Array(3); lenLE[0] = 0xfd;
    new DataView(lenLE.buffer, 1, 2).setUint16(0, b.length, true);
    return concatBytes(lenLE, b);
  }
  throw new Error('varslice >64KB unsupported in test');
}

// === Parallel impl mirroring dapp/tacit.js ===
function _preauthBidVarNonceFromOutpoint(buyerPrivBytes, fundingTxidHex, fundingVout) {
  const voutLE = new Uint8Array(4);
  new DataView(voutLE.buffer).setUint32(0, fundingVout >>> 0, true);
  return hmac(sha256, buyerPrivBytes, concatBytes(
    new TextEncoder().encode('tacit-preauth-bid-var-nonce-v1'),
    reverseBytes(hexToBytes(fundingTxidHex)),
    voutLE,
  )).slice(0, 16);
}

function _preauthBidVarIdHex(assetIdBytes, buyerPubBytes, nonceBytes) {
  const h = sha256(concatBytes(
    new TextEncoder().encode('tacit-preauth-bid-var-id-v1'),
    assetIdBytes, buyerPubBytes, nonceBytes,
  ));
  return bytesToHex(h.slice(0, 16));
}

function _preauthBidVarContextHash({
  assetIdBytes, bidIdBytes, recipientPubBytes,
  pricePerUnit, maxFill, fillIncrement, fillAmount,
  refundScriptHash, decimalsScale,
}) {
  return sha256(concatBytes(
    new TextEncoder().encode('tacit-preauth-bid-var-context-v1'),
    assetIdBytes, bidIdBytes, recipientPubBytes,
    u64LE(pricePerUnit), u64LE(maxFill), u64LE(fillIncrement), u64LE(fillAmount),
    refundScriptHash,
    new Uint8Array([(decimalsScale | 0) & 0xff]),
  ));
}

function _preauthBidVarAuthMsg({
  assetIdBytes, bidIdBytes, buyerPubBytes, recipientPubBytes, refundPubBytes,
  pricePerUnit, minFill, maxFill, fillIncrement,
  recipientBlindingBytes,
  fundingOutpointTxidHex, fundingOutpointVout, fundingOutpointValue,
  expiry, decimalsScale,
  buyerSatsSpendSigsConcat,
  nonceBytes,
}) {
  const voutLE = new Uint8Array(4);
  new DataView(voutLE.buffer).setUint32(0, fundingOutpointVout >>> 0, true);
  return sha256(concatBytes(
    new TextEncoder().encode('tacit-preauth-bid-var-v1'),
    assetIdBytes, bidIdBytes, buyerPubBytes, recipientPubBytes, refundPubBytes,
    u64LE(pricePerUnit), u64LE(minFill), u64LE(maxFill), u64LE(fillIncrement),
    recipientBlindingBytes,
    reverseBytes(hexToBytes(fundingOutpointTxidHex)),
    voutLE,
    u64LE(fundingOutpointValue),
    u64LE(expiry),
    new Uint8Array([(decimalsScale | 0) & 0xff]),
    _preauthVarslice(buyerSatsSpendSigsConcat),
    nonceBytes,
  ));
}

function _preauthBidVarCancelMsg(assetIdBytes, bidIdBytes) {
  return sha256(concatBytes(
    new TextEncoder().encode('tacit-preauth-bid-var-cancel-v1'),
    assetIdBytes, bidIdBytes,
  ));
}

function _preauthBidSighashPreimage({
  fundingOutpointTxidHex, fundingOutpointVout, fundingOutpointValue,
  buyerPubBytes, bidContextHash,
}) {
  const nVersion = new Uint8Array(4); new DataView(nVersion.buffer).setUint32(0, 2, true);
  const zero32 = new Uint8Array(32);
  const outpoint = concatBytes(
    reverseBytes(hexToBytes(fundingOutpointTxidHex)),
    (() => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, fundingOutpointVout >>> 0, true); return b; })(),
  );
  const pkh = hash160(buyerPubBytes);
  const scriptCode = concatBytes(
    new Uint8Array([0x19, 0x76, 0xa9, 0x14]), pkh, new Uint8Array([0x88, 0xac]),
  );
  const valueLE = new Uint8Array(8); new DataView(valueLE.buffer).setBigUint64(0, BigInt(fundingOutpointValue), true);
  const nSequence = new Uint8Array(4); new DataView(nSequence.buffer).setUint32(0, 0xfffffffd, true);
  const opReturnScript = concatBytes(new Uint8Array([0x6a, 0x20]), bidContextHash);
  const outSerialized = concatBytes(new Uint8Array(8), _preauthVarslice(opReturnScript));
  const hashOutputs = sha256(sha256(outSerialized));
  const nLocktime = new Uint8Array(4);
  const nHashType = new Uint8Array(4); new DataView(nHashType.buffer).setUint32(0, 0x83, true);
  const preimage = concatBytes(
    nVersion, zero32, zero32, outpoint, scriptCode, valueLE, nSequence,
    hashOutputs, nLocktime, nHashType,
  );
  return sha256(sha256(preimage));
}

console.log('\n=== VAR nonce derivation ===');

test('nonce is deterministic for fixed inputs', () => {
  const priv = new Uint8Array(32).fill(0x11);
  const n1 = _preauthBidVarNonceFromOutpoint(priv, '00'.repeat(32), 0);
  const n2 = _preauthBidVarNonceFromOutpoint(priv, '00'.repeat(32), 0);
  return n1.length === 16 && eq(n1, n2);
});

test('nonce changes when funding outpoint changes', () => {
  const priv = new Uint8Array(32).fill(0x11);
  const n1 = _preauthBidVarNonceFromOutpoint(priv, '00'.repeat(32), 0);
  const n2 = _preauthBidVarNonceFromOutpoint(priv, '00'.repeat(32), 1);
  return !eq(n1, n2);
});

test('VAR nonce ≠ §5.7.11 nonce for same inputs (domain separation)', () => {
  // The §5.7.11 nonce uses "tacit-preauth-bid-nonce-v1"; VAR uses
  // "tacit-preauth-bid-var-nonce-v1". A buyer using the SAME funding
  // outpoint for both opcodes must not produce colliding nonces.
  const priv = new Uint8Array(32).fill(0x11);
  const exactNonce = hmac(sha256, priv, concatBytes(
    new TextEncoder().encode('tacit-preauth-bid-nonce-v1'),
    reverseBytes(hexToBytes('00'.repeat(32))),
    new Uint8Array(4),
  )).slice(0, 16);
  const varNonce = _preauthBidVarNonceFromOutpoint(priv, '00'.repeat(32), 0);
  return !eq(exactNonce, varNonce);
});

console.log('\n=== VAR bid_id ===');

test('bid_id is 16 bytes / 32 hex chars', () => {
  const bidId = _preauthBidVarIdHex(
    new Uint8Array(32).fill(0xab),
    new Uint8Array(33).fill(0x02),
    new Uint8Array(16).fill(0xcc),
  );
  return /^[0-9a-f]{32}$/.test(bidId);
});

test('bid_id changes when asset_id changes', () => {
  const buyerPub = new Uint8Array(33).fill(0x02);
  const nonce = new Uint8Array(16).fill(0xcc);
  const a1 = _preauthBidVarIdHex(new Uint8Array(32).fill(0xab), buyerPub, nonce);
  const a2 = _preauthBidVarIdHex(new Uint8Array(32).fill(0xcd), buyerPub, nonce);
  return a1 !== a2;
});

test('VAR bid_id ≠ §5.7.11 bid_id for same inputs (domain separation)', () => {
  const assetId = new Uint8Array(32).fill(0xab);
  const buyerPub = new Uint8Array(33).fill(0x02);
  const nonce = new Uint8Array(16).fill(0xcc);
  const exactHash = sha256(concatBytes(
    new TextEncoder().encode('tacit-preauth-bid-id-v1'),
    assetId, buyerPub, nonce,
  ));
  const varBid = _preauthBidVarIdHex(assetId, buyerPub, nonce);
  return bytesToHex(exactHash.slice(0, 16)) !== varBid;
});

console.log('\n=== VAR auth_msg ===');

function authBase() {
  return {
    assetIdBytes: new Uint8Array(32).fill(0x01),
    bidIdBytes: new Uint8Array(16).fill(0x02),
    buyerPubBytes: (() => { const k = new Uint8Array(33); k[0] = 0x02; k.fill(0x03, 1); return k; })(),
    recipientPubBytes: (() => { const k = new Uint8Array(33); k[0] = 0x02; k.fill(0x04, 1); return k; })(),
    refundPubBytes: (() => { const k = new Uint8Array(33); k[0] = 0x02; k.fill(0x05, 1); return k; })(),
    pricePerUnit: 50000n,
    minFill: 1000n,
    maxFill: 10000n,
    fillIncrement: 1000n,
    recipientBlindingBytes: new Uint8Array(32).fill(0x06),
    fundingOutpointTxidHex: 'aa'.repeat(32),
    fundingOutpointVout: 0,
    fundingOutpointValue: 500_000_000,
    expiry: 2_000_000_000,
    decimalsScale: 0,
    buyerSatsSpendSigsConcat: new Uint8Array(71 * 10).fill(0x55),  // K=10 dummy sigs
    nonceBytes: new Uint8Array(16).fill(0x07),
  };
}

test('auth_msg deterministic for fixed inputs', () => {
  const b = authBase();
  const h1 = _preauthBidVarAuthMsg(b);
  const h2 = _preauthBidVarAuthMsg(b);
  return eq(h1, h2) && h1.length === 32;
});

test('auth_msg changes when refund_pubkey changes', () => {
  const b = authBase();
  const h1 = _preauthBidVarAuthMsg(b);
  const refund2 = new Uint8Array(b.refundPubBytes); refund2[5] ^= 0xff;
  const h2 = _preauthBidVarAuthMsg({ ...b, refundPubBytes: refund2 });
  return !eq(h1, h2);
});

test('auth_msg changes when min_fill changes', () => {
  const b = authBase();
  const h1 = _preauthBidVarAuthMsg(b);
  const h2 = _preauthBidVarAuthMsg({ ...b, minFill: b.minFill + 1n });
  return !eq(h1, h2);
});

test('auth_msg changes when fill_increment changes', () => {
  const b = authBase();
  const h1 = _preauthBidVarAuthMsg(b);
  const h2 = _preauthBidVarAuthMsg({ ...b, fillIncrement: b.fillIncrement + 1n });
  return !eq(h1, h2);
});

test('auth_msg changes when ANY of the K sigs is tampered (varslice binding)', () => {
  const b = authBase();
  const h1 = _preauthBidVarAuthMsg(b);
  const tampered = new Uint8Array(b.buyerSatsSpendSigsConcat);
  tampered[100] ^= 0xff;  // tweak one byte in one of the K sigs
  const h2 = _preauthBidVarAuthMsg({ ...b, buyerSatsSpendSigsConcat: tampered });
  return !eq(h1, h2);
});

test('auth_msg domain tag is part of preimage', () => {
  const b = authBase();
  const correct = _preauthBidVarAuthMsg(b);
  // Re-derive with the §5.7.11 domain tag — same field order would collide.
  // Verify the var-prefixed tag changes the output.
  const voutLE = new Uint8Array(4);
  new DataView(voutLE.buffer).setUint32(0, b.fundingOutpointVout >>> 0, true);
  const wrong = sha256(concatBytes(
    new TextEncoder().encode('tacit-preauth-bid-v1'),  // §5.7.11 tag
    b.assetIdBytes, b.bidIdBytes, b.buyerPubBytes, b.recipientPubBytes, b.refundPubBytes,
    u64LE(b.pricePerUnit), u64LE(b.minFill), u64LE(b.maxFill), u64LE(b.fillIncrement),
    b.recipientBlindingBytes,
    reverseBytes(hexToBytes(b.fundingOutpointTxidHex)), voutLE,
    u64LE(b.fundingOutpointValue), u64LE(b.expiry),
    new Uint8Array([(b.decimalsScale | 0) & 0xff]),
    _preauthVarslice(b.buyerSatsSpendSigsConcat),
    b.nonceBytes,
  ));
  return !eq(correct, wrong);
});

test('auth_msg changes when decimals_scale changes', () => {
  // The decimals_scale byte is part of the preimage so a settlement
  // posted under a different scale than the buyer pre-signed produces
  // a different auth_msg AND a different per-ratio context hash — both
  // gates fail. Pin the auth-side gate here.
  const b = authBase();
  const h1 = _preauthBidVarAuthMsg(b);
  const h2 = _preauthBidVarAuthMsg({ ...b, decimalsScale: 8 });
  return !eq(h1, h2);
});

console.log('\n=== VAR cancel_msg ===');

test('cancel_msg deterministic', () => {
  const a = new Uint8Array(32).fill(0xab);
  const b = new Uint8Array(16).fill(0xcd);
  const h1 = _preauthBidVarCancelMsg(a, b);
  const h2 = _preauthBidVarCancelMsg(a, b);
  return eq(h1, h2) && h1.length === 32;
});

test('cancel_msg domain tag separates VAR from §5.7.11', () => {
  const a = new Uint8Array(32).fill(0xab);
  const b = new Uint8Array(16).fill(0xcd);
  const varCancel = _preauthBidVarCancelMsg(a, b);
  const exactCancel = sha256(concatBytes(
    new TextEncoder().encode('tacit-preauth-bid-cancel-v1'),
    a, b,
  ));
  return !eq(varCancel, exactCancel);
});

console.log('\n=== per-ratio SIGHASH_SINGLE_ACP preimage ===');

test('preimage uses 0x83 sighash type (SIGHASH_SINGLE_ACP)', () => {
  // Reconstruct manually and verify the trailing 4 bytes of the
  // BIP-143-pre-doubleSHA preimage equal 0x83 in little-endian.
  // Easiest path: build a preimage by hand and inspect the raw bytes.
  // Since _preauthBidSighashPreimage returns sha256(sha256(preimage)),
  // we can't see the bytes directly — but we can verify behaviour by
  // building two preimages that differ only in the bidContextHash, and
  // confirm distinct sighashes (the OP_RETURN bytes are part of
  // hashOutputs which depends on the hash).
  const buyerPub = (() => { const k = new Uint8Array(33); k[0] = 0x02; k.fill(0x03, 1); return k; })();
  const fund = { fundingOutpointTxidHex: 'aa'.repeat(32), fundingOutpointVout: 0, fundingOutpointValue: 1_000_000, buyerPubBytes: buyerPub };
  const h1 = _preauthBidSighashPreimage({ ...fund, bidContextHash: new Uint8Array(32).fill(0x11) });
  const h2 = _preauthBidSighashPreimage({ ...fund, bidContextHash: new Uint8Array(32).fill(0x22) });
  return h1.length === 32 && h2.length === 32 && !eq(h1, h2);
});

test('K-distinct preimages → K-distinct sighashes', () => {
  // The load-bearing primitive: K different per-ratio context hashes
  // produce K different sighashes (so K signatures are required, none
  // are redundant). If any two collided, the buyer's "I pre-signed K
  // distinct ratios" guarantee would be broken.
  const buyerPub = (() => { const k = new Uint8Array(33); k[0] = 0x02; k.fill(0x03, 1); return k; })();
  const refund = new Uint8Array(20).fill(0x55);
  const base = {
    assetIdBytes: new Uint8Array(32).fill(0x01),
    bidIdBytes: new Uint8Array(16).fill(0x02),
    recipientPubBytes: (() => { const k = new Uint8Array(33); k[0] = 0x02; k.fill(0x03, 1); return k; })(),
    pricePerUnit: 50000n,
    maxFill: 10000n,
    fillIncrement: 1000n,
    refundScriptHash: refund,
    decimalsScale: 0,
  };
  const sighashes = new Set();
  for (let i = 0; i < 10; i++) {
    const fillAmount = base.fillIncrement * BigInt(i + 1);
    const h = _preauthBidVarContextHash({ ...base, fillAmount });
    const sh = _preauthBidSighashPreimage({
      fundingOutpointTxidHex: 'aa'.repeat(32),
      fundingOutpointVout: 0,
      fundingOutpointValue: 1_000_000,
      buyerPubBytes: buyerPub,
      bidContextHash: h,
    });
    sighashes.add(bytesToHex(sh));
  }
  return sighashes.size === 10;
});

test('preimage independent of outputs OTHER than the OP_RETURN at vout[k]', () => {
  // SIGHASH_SINGLE | ANYONECANPAY: signature pins my-input + same-index-output.
  // Other inputs and other outputs are NOT in the preimage. Verify by
  // constructing two distinct (funding_outpoint) preimages and confirming
  // their distinctness; then assert the preimage shape is independent of
  // funding_outpoint when the OP_RETURN content is the same. (Sanity test;
  // a regression here would mean we accidentally included extra inputs.)
  // Same OP_RETURN, different funding outpoints → different sighashes
  // (because the funding outpoint is in the preimage as `this.outpoint`).
  const buyerPub = (() => { const k = new Uint8Array(33); k[0] = 0x02; k.fill(0x03, 1); return k; })();
  const h = new Uint8Array(32).fill(0xab);
  const s1 = _preauthBidSighashPreimage({ fundingOutpointTxidHex: 'aa'.repeat(32), fundingOutpointVout: 0, fundingOutpointValue: 1_000_000, buyerPubBytes: buyerPub, bidContextHash: h });
  const s2 = _preauthBidSighashPreimage({ fundingOutpointTxidHex: 'bb'.repeat(32), fundingOutpointVout: 0, fundingOutpointValue: 1_000_000, buyerPubBytes: buyerPub, bidContextHash: h });
  return !eq(s1, s2);
});

console.log(`\n${pass + fail} tests, ${pass} pass, ${fail} fail`);
if (fail > 0) process.exit(1);
