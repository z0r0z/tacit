// Envelope script (Taproot tapscript) — outer wrapping that's stable across
// opcode additions (T_CETCH, T_CXFER, T_MINT, T_BURN, ...). This is the
// surface an external indexer or relay sees, so encode/decode determinism
// here is what makes cross-implementation interop possible.
//
// What's tested:
//   - Round-trip: encode(payload) → decode → same payload
//   - Pushdata variants: ≤75 (direct push), ≤255 (PUSHDATA1), ≤65535 (PUSHDATA2)
//   - Envelope chunking: payloads > 520 bytes get split across multiple pushes
//   - Magic/version pinned
//   - Rejections: wrong magic, wrong version, missing OP_CHECKSIG, missing
//     OP_FALSE OP_IF, missing OP_ENDIF, trailing bytes after OP_ENDIF, empty
//     payload
//
// Run: `node envelope.test.mjs`
import { hexToBytes, bytesToHex, concatBytes } from '@noble/hashes/utils';

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

// --- Mirror of envelope script encoder/decoder from tacit.html ---
// (kept minimal; just enough to run round-trips. Deliberately matches the
// protocol's wire format byte-for-byte.)
const ENVELOPE_MAGIC = new TextEncoder().encode('TACIT');
const ENVELOPE_VERSION = 0x01;
const MAX_SCRIPT_PUSH = 520;
const OP_FALSE = 0x00, OP_PUSHDATA1 = 0x4c, OP_PUSHDATA2 = 0x4d;
const OP_IF = 0x63, OP_ENDIF = 0x68, OP_CHECKSIG = 0xac;

function _encodePush(data) {
  if (data.length === 0) return new Uint8Array([OP_FALSE]);
  if (data.length <= 75) return concatBytes(new Uint8Array([data.length]), data);
  if (data.length <= 255) return concatBytes(new Uint8Array([OP_PUSHDATA1, data.length]), data);
  if (data.length <= 65535) {
    const lenLE = new Uint8Array(2); new DataView(lenLE.buffer).setUint16(0, data.length, true);
    return concatBytes(new Uint8Array([OP_PUSHDATA2]), lenLE, data);
  }
  throw new Error('push data too large');
}
function encodeEnvelopeScript(signingPubXonly, payload) {
  if (signingPubXonly.length !== 32) throw new Error('signing pubkey must be 32 bytes (x-only)');
  const chunks = [ENVELOPE_MAGIC, new Uint8Array([ENVELOPE_VERSION])];
  for (let i = 0; i < payload.length; i += MAX_SCRIPT_PUSH) {
    chunks.push(payload.slice(i, Math.min(i + MAX_SCRIPT_PUSH, payload.length)));
  }
  const pieces = [
    _encodePush(signingPubXonly),
    new Uint8Array([OP_CHECKSIG]),
    new Uint8Array([OP_FALSE, OP_IF]),
  ];
  for (const c of chunks) pieces.push(_encodePush(c));
  pieces.push(new Uint8Array([OP_ENDIF]));
  return concatBytes(...pieces);
}
function decodeEnvelopeScript(script) {
  if (!script || script.length < 36) return null;
  let p = 0;
  if (script[p] !== 32) return null; p += 1;
  if (p + 32 > script.length) return null;
  const signingPubXonly = script.slice(p, p + 32); p += 32;
  if (p + 1 > script.length || script[p] !== OP_CHECKSIG) return null; p += 1;
  if (p + 2 > script.length || script[p] !== OP_FALSE || script[p + 1] !== OP_IF) return null; p += 2;
  const pushes = [];
  let sawEndif = false;
  while (p < script.length) {
    if (script[p] === OP_ENDIF) { p += 1; sawEndif = true; break; }
    const op = script[p]; p += 1;
    let data;
    if (op >= 1 && op <= 75) {
      if (p + op > script.length) return null;
      data = script.slice(p, p + op); p += op;
    } else if (op === OP_PUSHDATA1) {
      if (p + 1 > script.length) return null;
      const ln = script[p]; p += 1;
      if (p + ln > script.length) return null;
      data = script.slice(p, p + ln); p += ln;
    } else if (op === OP_PUSHDATA2) {
      if (p + 2 > script.length) return null;
      const ln = script[p] | (script[p + 1] << 8); p += 2;
      if (p + ln > script.length) return null;
      data = script.slice(p, p + ln); p += ln;
    } else if (op === OP_FALSE) { data = new Uint8Array(0); }
    else { return null; }
    pushes.push(data);
  }
  if (!sawEndif) return null;
  if (p !== script.length) return null;
  if (pushes.length < 3) return null;
  if (pushes[0].length !== ENVELOPE_MAGIC.length) return null;
  for (let i = 0; i < ENVELOPE_MAGIC.length; i++) if (pushes[0][i] !== ENVELOPE_MAGIC[i]) return null;
  if (pushes[1].length !== 1 || pushes[1][0] !== ENVELOPE_VERSION) return null;
  const payload = concatBytes(...pushes.slice(2));
  if (payload.length < 1) return null;
  return { signingPubXonly, opcode: payload[0], payload };
}

const eqBytes = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const fakeXonly = () => crypto.getRandomValues(new Uint8Array(32));

console.log('Envelope round-trip:');
test('1-byte payload', () => {
  const xonly = fakeXonly();
  const payload = new Uint8Array([0x21]);
  const script = encodeEnvelopeScript(xonly, payload);
  const dec = decodeEnvelopeScript(script);
  return dec && eqBytes(dec.payload, payload) && eqBytes(dec.signingPubXonly, xonly) && dec.opcode === 0x21;
});
test('75-byte payload (max direct push)', () => {
  const xonly = fakeXonly();
  const payload = crypto.getRandomValues(new Uint8Array(75));
  payload[0] = 0x21;
  const script = encodeEnvelopeScript(xonly, payload);
  const dec = decodeEnvelopeScript(script);
  return dec && eqBytes(dec.payload, payload);
});
test('100-byte payload (PUSHDATA1)', () => {
  const xonly = fakeXonly();
  const payload = crypto.getRandomValues(new Uint8Array(100));
  payload[0] = 0x23;
  const script = encodeEnvelopeScript(xonly, payload);
  const dec = decodeEnvelopeScript(script);
  return dec && eqBytes(dec.payload, payload);
});
test('256-byte payload (PUSHDATA2)', () => {
  const xonly = fakeXonly();
  const payload = crypto.getRandomValues(new Uint8Array(256));
  payload[0] = 0x21;
  const script = encodeEnvelopeScript(xonly, payload);
  const dec = decodeEnvelopeScript(script);
  return dec && eqBytes(dec.payload, payload);
});
test('520-byte payload (max single push)', () => {
  const xonly = fakeXonly();
  const payload = crypto.getRandomValues(new Uint8Array(520));
  payload[0] = 0x23;
  const script = encodeEnvelopeScript(xonly, payload);
  const dec = decodeEnvelopeScript(script);
  return dec && eqBytes(dec.payload, payload);
});
test('521-byte payload (split across 2 chunks)', () => {
  const xonly = fakeXonly();
  const payload = crypto.getRandomValues(new Uint8Array(521));
  payload[0] = 0x23;
  const script = encodeEnvelopeScript(xonly, payload);
  const dec = decodeEnvelopeScript(script);
  return dec && eqBytes(dec.payload, payload);
});
test('5000-byte payload (~10 chunks; typical CXFER size)', () => {
  const xonly = fakeXonly();
  const payload = crypto.getRandomValues(new Uint8Array(5000));
  payload[0] = 0x23;
  const script = encodeEnvelopeScript(xonly, payload);
  const dec = decodeEnvelopeScript(script);
  return dec && eqBytes(dec.payload, payload);
});

console.log('\nEnvelope rejection cases:');
test('reject empty input', () => decodeEnvelopeScript(new Uint8Array(0)) === null);
test('reject null', () => decodeEnvelopeScript(null) === null);
test('reject script too short (< 36 bytes)', () => decodeEnvelopeScript(new Uint8Array(35)) === null);
test('reject wrong xonly push length (not 32)', () => {
  const bad = concatBytes(new Uint8Array([20]), new Uint8Array(20)); // 20-byte push
  return decodeEnvelopeScript(bad) === null;
});
test('reject missing OP_CHECKSIG', () => {
  const xonly = fakeXonly();
  const bad = concatBytes(new Uint8Array([32]), xonly, new Uint8Array([0x88])); // wrong opcode
  return decodeEnvelopeScript(bad) === null;
});
test('reject missing OP_FALSE OP_IF', () => {
  const xonly = fakeXonly();
  const bad = concatBytes(new Uint8Array([32]), xonly, new Uint8Array([OP_CHECKSIG, OP_IF])); // missing OP_FALSE
  return decodeEnvelopeScript(bad) === null;
});
test('reject missing OP_ENDIF', () => {
  // Build full envelope but truncate before the OP_ENDIF.
  const xonly = fakeXonly();
  const script = encodeEnvelopeScript(xonly, new Uint8Array([0x21, 0x02]));
  const truncated = script.slice(0, script.length - 1); // drop OP_ENDIF
  return decodeEnvelopeScript(truncated) === null;
});
test('reject trailing bytes after OP_ENDIF', () => {
  const xonly = fakeXonly();
  const script = encodeEnvelopeScript(xonly, new Uint8Array([0x21, 0x02]));
  const corrupted = concatBytes(script, new Uint8Array([0x00]));
  return decodeEnvelopeScript(corrupted) === null;
});
test('reject wrong magic ("FOO" instead of "TACIT")', () => {
  const xonly = fakeXonly();
  const fakeMagic = new TextEncoder().encode('FOO');
  const pieces = [
    new Uint8Array([32]), xonly,
    new Uint8Array([OP_CHECKSIG]),
    new Uint8Array([OP_FALSE, OP_IF]),
    _encodePush(fakeMagic),
    _encodePush(new Uint8Array([ENVELOPE_VERSION])),
    _encodePush(new Uint8Array([0x21])),
    new Uint8Array([OP_ENDIF]),
  ];
  return decodeEnvelopeScript(concatBytes(...pieces)) === null;
});
test('reject wrong version', () => {
  const xonly = fakeXonly();
  const pieces = [
    new Uint8Array([32]), xonly,
    new Uint8Array([OP_CHECKSIG]),
    new Uint8Array([OP_FALSE, OP_IF]),
    _encodePush(ENVELOPE_MAGIC),
    _encodePush(new Uint8Array([0x99])), // bad version
    _encodePush(new Uint8Array([0x21])),
    new Uint8Array([OP_ENDIF]),
  ];
  return decodeEnvelopeScript(concatBytes(...pieces)) === null;
});
test('reject empty payload (only magic + version, no opcode)', () => {
  const xonly = fakeXonly();
  const pieces = [
    new Uint8Array([32]), xonly,
    new Uint8Array([OP_CHECKSIG]),
    new Uint8Array([OP_FALSE, OP_IF]),
    _encodePush(ENVELOPE_MAGIC),
    _encodePush(new Uint8Array([ENVELOPE_VERSION])),
    new Uint8Array([OP_ENDIF]),
  ];
  return decodeEnvelopeScript(concatBytes(...pieces)) === null;
});
test('reject unknown opcode in script (e.g. OP_DUP=0x76)', () => {
  // Build malformed script with OP_DUP where a push is expected.
  const xonly = fakeXonly();
  const pieces = [
    new Uint8Array([32]), xonly,
    new Uint8Array([OP_CHECKSIG]),
    new Uint8Array([OP_FALSE, OP_IF]),
    _encodePush(ENVELOPE_MAGIC),
    _encodePush(new Uint8Array([ENVELOPE_VERSION])),
    new Uint8Array([0x76]), // OP_DUP (not a push)
    new Uint8Array([OP_ENDIF]),
  ];
  return decodeEnvelopeScript(concatBytes(...pieces)) === null;
});

console.log('\nDecoder fuzzing:');
test('100 random buffers per length [0..2000] never throw', () => {
  const lens = [0, 1, 2, 10, 36, 50, 100, 500, 1000, 2000];
  for (const len of lens) {
    for (let i = 0; i < 100; i++) {
      const buf = crypto.getRandomValues(new Uint8Array(len));
      try { decodeEnvelopeScript(buf); }
      catch (e) {
        console.log(`    threw at len=${len} iter=${i}: ${e.message}`);
        return false;
      }
    }
  }
  return true;
});

console.log('\nMagic / version pinning (interop interface):');
test('magic bytes are exactly "TACIT" (5 bytes)', () => {
  return ENVELOPE_MAGIC.length === 5 &&
         bytesToHex(ENVELOPE_MAGIC) === '5441434954';
});
test('envelope version = 0x01', () => ENVELOPE_VERSION === 0x01);
test('encoded envelope hex starts with: 20<xonly>ac0063', () => {
  const xonly = new Uint8Array(32); xonly[0] = 0x99;
  const script = encodeEnvelopeScript(xonly, new Uint8Array([0x21]));
  // 20 (push 32) || xonly || ac (OP_CHECKSIG) || 00 (OP_FALSE) || 63 (OP_IF)
  return script[0] === 0x20 && eqBytes(script.slice(1, 33), xonly) &&
         script[33] === 0xac && script[34] === 0x00 && script[35] === 0x63;
});

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
