// RFC 8785 JSON Canonicalization Scheme (JCS), restricted to the value shapes
// used in tacit AMM metadata blobs. Supports:
//
//   • objects (recursive; keys sorted by UTF-16 code-unit order per JCS §3.2.3)
//   • arrays (order preserved)
//   • strings (escaped per RFC 8259 + §3.2.2.2)
//   • booleans, null
//   • integers (within Number.MAX_SAFE_INTEGER = 2^53 - 1)
//
// Floats and >2^53 integers are NOT supported by this implementation. Tacit
// metadata blobs SHOULD encode large integers (e.g., asset supply) as strings.
// Encountering a non-integer or out-of-range number throws.
//
// For the launcher-gate use case (AMM.md §"Indexer-determinism for the metadata
// blob"), the indexer flow is:
//
//   1. Fetch the blob bytes by CID.
//   2. JSON.parse to a JS value.
//   3. Canonicalize the parsed value with this module.
//   4. Compare canonicalized bytes to the fetched bytes. If they differ,
//      treat the blob as "no launcher gate" (conservative default).
//   5. If they match, look for `tacit_amm_launcher` at top level. Accept iff
//      it is a 66-char lowercase hex string (33-byte compressed pubkey).

import { hexToBytes } from '@noble/hashes/utils';

// JCS-canonical JSON.parse equivalent: accepts a JS value, returns canonical
// UTF-8 bytes. Throws on unsupported shapes.
export function canonicalize(value) {
  return new TextEncoder().encode(serialize(value));
}

function serialize(v) {
  if (v === null) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return serializeNumber(v);
  if (typeof v === 'string') return serializeString(v);
  if (Array.isArray(v)) return serializeArray(v);
  if (typeof v === 'object') return serializeObject(v);
  throw new Error(`JCS: unsupported type ${typeof v}`);
}

function serializeNumber(n) {
  if (!Number.isFinite(n)) throw new Error('JCS: NaN/Infinity not allowed');
  if (!Number.isInteger(n)) throw new Error('JCS: non-integer numbers not supported in tacit blobs');
  if (Math.abs(n) > Number.MAX_SAFE_INTEGER) throw new Error('JCS: integer exceeds 2^53 — encode as string');
  // RFC 8785 §3.2.2.3: ES2019 ToString for finite numbers. For exact integers
  // up to MAX_SAFE_INTEGER, ToString matches a plain decimal repr.
  return String(n);
}

function serializeString(s) {
  // RFC 8259 string with mandatory escapes for control chars and " and \.
  // Solidus (/) is NOT escaped (JCS leaves the choice; we follow RFC 8259 default).
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    if (ch === 0x22) out += '\\"';
    else if (ch === 0x5c) out += '\\\\';
    else if (ch === 0x08) out += '\\b';
    else if (ch === 0x0c) out += '\\f';
    else if (ch === 0x0a) out += '\\n';
    else if (ch === 0x0d) out += '\\r';
    else if (ch === 0x09) out += '\\t';
    else if (ch < 0x20) {
      out += '\\u' + ch.toString(16).padStart(4, '0');
    } else if (ch >= 0xd800 && ch <= 0xdbff) {
      // High surrogate — emit as-is; pair with following low surrogate at i+1.
      out += s.charAt(i);
    } else {
      out += s.charAt(i);
    }
  }
  out += '"';
  return out;
}

function serializeArray(arr) {
  if (arr.length === 0) return '[]';
  let out = '[';
  for (let i = 0; i < arr.length; i++) {
    if (i > 0) out += ',';
    out += serialize(arr[i]);
  }
  out += ']';
  return out;
}

function serializeObject(obj) {
  // Skip undefined values (RFC 8785 §3.2.3: members with undefined are omitted,
  // matching JSON.stringify behavior). Sort remaining keys by UTF-16 code-unit
  // order (lexicographic, same as default String < comparison in JS).
  const keys = Object.keys(obj).filter(k => obj[k] !== undefined).sort();
  if (keys.length === 0) return '{}';
  let out = '{';
  for (let i = 0; i < keys.length; i++) {
    if (i > 0) out += ',';
    out += serializeString(keys[i]) + ':' + serialize(obj[keys[i]]);
  }
  out += '}';
  return out;
}

// ---- Launcher-gate extraction ----
//
// Indexer rule per AMM.md §"Indexer-determinism for the metadata blob":
//   • If the blob is byte-identical to its canonical form, AND it has a top-level
//     `tacit_amm_launcher` field that is a 66-char lowercase hex string, the
//     gate is set to that pubkey.
//   • Otherwise (non-canonical OR missing field OR malformed value), the
//     conservative default is "no gate" — first-mover wins for POOL_INIT.

export function extractLauncherPubkey(blobBytes) {
  if (!(blobBytes instanceof Uint8Array)) return null;
  let parsed;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8').decode(blobBytes));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;

  // JCS canonicalization check.
  let canonical;
  try { canonical = canonicalize(parsed); }
  catch { return null; }
  if (canonical.length !== blobBytes.length) return null;
  for (let i = 0; i < canonical.length; i++) {
    if (canonical[i] !== blobBytes[i]) return null;
  }

  // Extract field.
  const v = parsed.tacit_amm_launcher;
  if (typeof v !== 'string') return null;
  if (v.length !== 66) return null;
  if (!/^[0-9a-f]{66}$/.test(v)) return null;
  // Must be a valid 33-byte compressed pubkey prefix.
  if (v[0] !== '0' || (v[1] !== '2' && v[1] !== '3')) return null;
  try {
    const bytes = hexToBytes(v);
    return bytes;
  } catch { return null; }
}
