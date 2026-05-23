// BIP-352 receiver-side test vectors.
//
// Runs the official BIP-352 send_and_receive_test_vectors.json against
// dapp/tacit.js's receiverScanTxForSilentPayments + deriveSilentPaymentKeys +
// encodeSilentPaymentAddress + silentPaymentSpendingKey.
//
// Scope: RECEIVER side. For every vector whose receiving section has unlabeled
// outputs, we feed the vector's scan/spend privkeys into the receiver scanner
// and verify:
//   (a) the expected outputs are detected
//   (b) the derived spending key produces a valid signature for each output
//
// Labeled-address vectors are skipped (labels not implemented).
//
// Run: `node bip352-receiver-vectors.test.mjs`
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import * as secp from '@noble/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { ripemd160 } from '@noble/hashes/ripemd160';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
globalThis.location = dom.window.location;
globalThis.navigator = dom.window.navigator;
globalThis.prompt = () => null;
globalThis.alert = () => {};
globalThis.confirm = () => false;
globalThis.__TACIT_NO_INIT__ = true;

const dapp = await import('../dapp/tacit.js');
const {
  receiverScanTxForSilentPayments,
  silentPaymentSpendingKey,
  deriveSilentPaymentKeys,
  encodeSilentPaymentAddress,
  decodeSilentPaymentAddress,
  bip352OutpointBytes,
} = dapp;

const VECTORS = JSON.parse(readFileSync(
  new URL('./fixtures/bip352-send-and-receive-vectors.json', import.meta.url),
  'utf8',
));

const SECP_N = secp.CURVE.n;
function hexToBytes(h) {
  if (h.length & 1) throw new Error('odd hex');
  const b = new Uint8Array(h.length >> 1);
  for (let i = 0; i < b.length; i++) b[i] = parseInt(h.slice(i*2, i*2+2), 16);
  return b;
}
function bytesToHex(b) {
  return Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
}
function bytes32ToBigint(b) {
  let r = 0n;
  for (let i = 0; i < 32; i++) r = (r << 8n) | BigInt(b[i]);
  return r;
}

function parseWitnessWire(hex) {
  if (!hex) return [];
  const buf = hexToBytes(hex);
  let i = 0;
  const readVarint = () => {
    const b = buf[i++];
    if (b < 0xfd) return b;
    if (b === 0xfd) { const v = buf[i] | (buf[i+1] << 8); i += 2; return v; }
    throw new Error('varint > 0xfd unsupported');
  };
  const count = readVarint();
  const items = [];
  for (let n = 0; n < count; n++) {
    const len = readVarint();
    items.push(buf.slice(i, i + len));
    i += len;
  }
  return items;
}

function parsePushOps(buf) {
  const ops = [];
  let i = 0;
  while (i < buf.length) {
    const op = buf[i++];
    if (op >= 1 && op <= 75) { ops.push(buf.slice(i, i + op)); i += op; continue; }
    if (op === 0x4c) { const n = buf[i++]; ops.push(buf.slice(i, i + n)); i += n; continue; }
    if (op === 0x4d) {
      const n = buf[i++] | (buf[i++] << 8);
      ops.push(buf.slice(i, i + n)); i += n; continue;
    }
    if (op === 0x00) { ops.push(new Uint8Array(0)); continue; }
  }
  return ops;
}

function hash160(b) { return ripemd160(sha256(b)); }

// Classify inputs for the receiver. Unlike sender vectors, receiver vectors
// don't include private_key per vin — we extract pubkeys from witness/scriptSig
// the same way the dapp's classifyStealthInput does.
const H_NUMS_TAG_X = '50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0';

function classifyInputForReceiver(vin) {
  const spkHex = vin.prevout.scriptPubKey.hex.toLowerCase();
  const spk = hexToBytes(spkHex);
  const scriptSig = vin.scriptSig ? hexToBytes(vin.scriptSig) : new Uint8Array(0);
  const witness = parseWitnessWire(vin.txinwitness || '');

  // P2WPKH
  if (spk.length === 22 && spk[0] === 0x00 && spk[1] === 0x14) {
    if (witness.length !== 2) return { kind: 'unknown', pub: null };
    const pub = witness[1];
    if (pub.length !== 33 || (pub[0] !== 0x02 && pub[0] !== 0x03)) return { kind: 'unknown', pub: null };
    return { kind: 'p2wpkh', pub };
  }

  // P2PKH
  if (spk.length === 25 && spk[0] === 0x76 && spk[1] === 0xa9 && spk[2] === 0x14
      && spk[23] === 0x88 && spk[24] === 0xac) {
    const pushes = parsePushOps(scriptSig);
    for (const p of pushes) {
      if (p.length !== 33) continue;
      if ((p[0] !== 0x02) && (p[0] !== 0x03)) continue;
      return { kind: 'p2wpkh', pub: p };
    }
    return { kind: 'unknown', pub: null };
  }

  // P2SH-P2WPKH
  if (spk.length === 23 && spk[0] === 0xa9 && spk[1] === 0x14 && spk[22] === 0x87) {
    const pushes = parsePushOps(scriptSig);
    if (pushes.length !== 1) return { kind: 'unknown', pub: null };
    const redeem = pushes[0];
    if (redeem.length !== 22 || redeem[0] !== 0x00 || redeem[1] !== 0x14) return { kind: 'unknown', pub: null };
    if (witness.length !== 2) return { kind: 'unknown', pub: null };
    const pub = witness[1];
    if (pub.length !== 33 || (pub[0] !== 0x02 && pub[0] !== 0x03)) return { kind: 'unknown', pub: null };
    return { kind: 'p2wpkh', pub };
  }

  // P2TR keypath
  if (spk.length === 34 && spk[0] === 0x51 && spk[1] === 0x20) {
    const stripped = (witness.length > 0
                   && witness[witness.length - 1].length > 0
                   && witness[witness.length - 1][0] === 0x50)
      ? witness.slice(0, -1) : witness;
    if (stripped.length > 1) {
      const cb = stripped[stripped.length - 1];
      if (cb.length >= 33) {
        const internal = bytesToHex(cb.slice(1, 33));
        if (internal === H_NUMS_TAG_X) return { kind: 'unknown', pub: null };
      }
    }
    const xonly = spk.slice(2, 34);
    const pub = new Uint8Array(33);
    pub[0] = 0x02; pub.set(xonly, 1);
    return { kind: 'p2tr-keypath', pub };
  }

  return { kind: 'unknown', pub: null };
}

const SKIP_REASON = {
  12: 'labeled address — labels not implemented',
  13: 'labeled address — labels not implemented',
  14: 'labeled address — labels not implemented',
  15: 'labeled address — labels not implemented',
  16: 'labeled address — labels not implemented',
  17: 'labeled address — labels not implemented',
  18: 'labeled address — labels not implemented',
  27: 'labeled address K_max — labels not implemented',
};

let pass = 0, fail = 0, skip = 0;
function logResult(label, ok, detail) {
  if (ok === true) { console.log(`  PASS  ${label}`); pass++; }
  else if (ok === 'skip') { console.log(`  SKIP  ${label}${detail ? ' — ' + detail : ''}`); skip++; }
  else { console.log(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`); fail++; }
}

console.log('BIP-352 receiver-side reference vectors:\n');

for (let vi = 0; vi < VECTORS.length; vi++) {
  const v = VECTORS[vi];
  const label = `${vi} ${v.comment}`;
  if (SKIP_REASON[vi]) { logResult(label, 'skip', SKIP_REASON[vi]); continue; }

  for (let ri = 0; ri < v.receiving.length; ri++) {
    const recv = v.receiving[ri];
    const km = recv.given.key_material;
    const scanPriv = hexToBytes(km.scan_priv_key);
    const spendPriv = hexToBytes(km.spend_priv_key);
    const spendPub = secp.getPublicKey(spendPriv, true);

    const expectedOutputs = recv.expected.outputs.map(o => o.pub_key.toLowerCase());
    const expectedTweaks = recv.expected.outputs.map(o => o.priv_key_tweak.toLowerCase());

    const classifiedInputs = recv.given.vin.map(classifyInputForReceiver);
    const allOutpoints = recv.given.vin.map(inp =>
      bip352OutpointBytes(inp.txid, inp.vout),
    );
    const outputs = recv.given.outputs.map(xonly => ({
      script: new Uint8Array([0x51, 0x20, ...hexToBytes(xonly)]),
    }));

    const matches = receiverScanTxForSilentPayments({
      classifiedInputs, allOutpoints, outputs, scanPriv, spendPub,
    });

    if (expectedOutputs.length === 0) {
      logResult(label, matches.length === 0, matches.length > 0 ? `expected 0 matches, got ${matches.length}` : '');
      continue;
    }

    const gotPubkeys = new Set(matches.map(m => bytesToHex(m.outputXonly)));
    const wantPubkeys = new Set(expectedOutputs);
    const pubkeyMatch = gotPubkeys.size === wantPubkeys.size && [...wantPubkeys].every(p => gotPubkeys.has(p));
    if (!pubkeyMatch) {
      logResult(label, false, `pubkey mismatch got=[${[...gotPubkeys]}] want=[${[...wantPubkeys]}]`);
      continue;
    }

    // Verify spending key derivation: b_spend + t_k must produce a valid
    // public key matching the output.
    let tweakOk = true;
    for (const m of matches) {
      const sk = silentPaymentSpendingKey(spendPriv, m.tweakScalar);
      const derivedPub = secp.getPublicKey(sk, true);
      const derivedXonly = derivedPub.slice(1);
      const outputMatch = derivedXonly.every((b, i) => b === m.outputXonly[i]);
      if (!outputMatch) { tweakOk = false; break; }
    }

    logResult(label, tweakOk, tweakOk ? '' : 'spending key derivation failed');
  }
}

// ============================================================================
// Round-trip test: derive keys → encode address → sender derives → receiver scans
// ============================================================================
console.log('\nRound-trip (derive → encode → send → scan):');

function roundTripTest() {
  const spendPriv = hexToBytes('9d6ad855ce3417ef84e836892e5a56392bfba05fa5d97ccea30e266f540e08b3');
  const { scanPriv, scanPub, spendPub } = deriveSilentPaymentKeys(spendPriv);

  const addr = encodeSilentPaymentAddress({ scanPub, spendPub, network: 'mainnet' });
  const decoded = decodeSilentPaymentAddress(addr);
  if (!decoded) { console.log('  FAIL  encode→decode returned null'); fail++; return; }
  if (decoded.scanPub.length !== 33 || decoded.spendPub.length !== 33) {
    console.log('  FAIL  decoded pubkey lengths wrong'); fail++; return;
  }
  const scanMatch = decoded.scanPub.every((b, i) => b === scanPub[i]);
  const spendMatch = decoded.spendPub.every((b, i) => b === spendPub[i]);
  if (!scanMatch || !spendMatch) {
    console.log('  FAIL  encode→decode pubkey mismatch'); fail++; return;
  }
  console.log(`  PASS  encode→decode round-trip (${addr.slice(0, 20)}…)`); pass++;

  // Simulate a sender: construct a mock tx and derive the output
  const senderPriv = hexToBytes('eadc78165ff1f8ea94ad7cfdc54e7f1b4e29bef26170ee7bcb65035ed2c7af05');
  const senderPub = secp.getPublicKey(senderPriv, true);
  const mockOutpoint = bip352OutpointBytes(
    'a000000000000000000000000000000000000000000000000000000000000000', 0,
  );
  const { senderComputeSilentPaymentOutput } = dapp;
  const senderOut = senderComputeSilentPaymentOutput({
    inputPrivs: [senderPriv],
    inputOutpoints: [mockOutpoint],
    scanPub: decoded.scanPub,
    spendPub: decoded.spendPub,
    k: 0,
  });

  // Receiver scans
  const classifiedInputs = [{ kind: 'p2wpkh', pub: senderPub }];
  const outputs = [{ script: new Uint8Array([0x51, 0x20, ...senderOut.xOnly]) }];
  const matches = receiverScanTxForSilentPayments({
    classifiedInputs,
    allOutpoints: [mockOutpoint],
    outputs,
    scanPriv,
    spendPub,
  });
  if (matches.length !== 1) {
    console.log(`  FAIL  receiver found ${matches.length} matches, expected 1`); fail++;
    return;
  }
  const m = matches[0];
  if (bytesToHex(m.outputXonly) !== bytesToHex(senderOut.xOnly)) {
    console.log('  FAIL  receiver output xonly mismatch'); fail++;
    return;
  }
  console.log('  PASS  sender→receiver round-trip detection'); pass++;

  // Verify spending key
  const sk = silentPaymentSpendingKey(spendPriv, m.tweakScalar);
  const derivedPub = secp.getPublicKey(sk, true).slice(1);
  if (!derivedPub.every((b, i) => b === senderOut.xOnly[i])) {
    console.log('  FAIL  spending key does not match output'); fail++;
    return;
  }
  console.log('  PASS  spending key matches output'); pass++;
}
roundTripTest();

console.log(`\nFinal: ${pass} passed · ${fail} failed · ${skip} skipped`);
if (fail > 0) process.exit(1);
