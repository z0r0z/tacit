// Reading the data of a block that landed with its lists in EIP-4844 blobs (TacitBlocks `land`, word 15 set), so a leader can follow blocks another leader sent.
//
// The program puts the block's new notes (leaf ‖ memo), nullifiers and claims in one stream (tacit-block-common `blob.rs`: `stream`, `blob`, `parse`)
// and the stream in blobs, 31 bytes to a 32-byte field element (the element's first byte zero), 4096 elements to a blob. The landing call carries one
// 160-byte opening per blob (commitment ‖ z ‖ y ‖ proof), and the contract has checked each commitment's versioned hash is the transaction's blob,
// so the hashes to look for come from the call itself. Blobs are kept by blob archives and by beacon nodes for a few weeks.
//
// Whatever a source gives is checked before it is used: the stream must be laid out as the program lays it, and its outputs and nullifiers must hash to
// the words the block's public values commit (4 and 5), so a source that is wrong, or another block's, is passed over and the next one tried.
// Pure but for the fetches (`fetchImpl`), so tested: tests/tacit-leader-blobs.test.mjs.
import { sha256, concatBytes } from '../dapp/vendor/tacit-deps.min.js';
import { bytesOf, hexOf, listHash, memoHash } from './abi.mjs';

export const FIELD_ELEMENTS = 4096;
export const BYTES_PER_ELEMENT = 31;
export const BLOB_BYTES = 32 * FIELD_ELEMENTS;
export const BLOB_DATA = BYTES_PER_ELEMENT * FIELD_ELEMENTS;
export const OPENING_LEN = 160;
export const MEMO_LEN = 1152;
export const MAINNET_GENESIS = 1606824023;
const SLOT_SECS = 12;

/// EIP-4844's versioned hash of a KZG commitment: 0x01 ‖ SHA-256(commitment)[1:].
export function versionedHash(commitment) {
  const h = Uint8Array.from(sha256(commitment));
  h[0] = 1;
  return hexOf(h);
}

/// The versioned hashes of the blobs a land call carries openings for, in order (what `blobhash(i)` is in the landing transaction).
export function openingHashes(blobs) {
  const b = bytesOf(blobs);
  if (b.length === 0 || b.length % OPENING_LEN !== 0) return null;
  return Array.from({ length: b.length / OPENING_LEN }, (_, i) => versionedHash(b.subarray(OPENING_LEN * i, OPENING_LEN * i + 48)));
}

/// The stream a block's blobs hold, padding included; null when a blob is not 4096 elements or an element's first byte is not zero.
export function unblob(blobs) {
  const out = new Uint8Array(blobs.length * BLOB_DATA);
  let at = 0;
  for (const raw of blobs) {
    if (raw.length !== BLOB_BYTES) return null;
    for (let k = 0; k < FIELD_ELEMENTS; k++) {
      if (raw[32 * k] !== 0) return null;
      out.set(raw.subarray(32 * k + 1, 32 * k + 32), at);
      at += BYTES_PER_ELEMENT;
    }
  }
  return out;
}

/// The lists a stream holds, as `parse` reads them: { leaves, memos (bytes, memoLen each), nullifiers (hex words), claims (bytes) }, or null when the stream is
/// not one `stream` made (a count past the end, or anything after the lists that is not zero).
export function parseStream(stream, memoLen = MEMO_LEN) {
  let at = 0;
  const count = () => {
    if (at + 4 > stream.length) return null;
    const v = new DataView(stream.buffer, stream.byteOffset + at, 4).getUint32(0, false);
    at += 4;
    return v;
  };
  const take = (n, size) => {
    if (n === null || n > (stream.length - at) / size) return null;
    const s = stream.subarray(at, at + n * size);
    at += n * size;
    return s;
  };
  const n = count();
  const outputs = take(n, 32 + memoLen);
  if (outputs === null) return null;
  const leaves = new Uint8Array(32 * n), memos = new Uint8Array(memoLen * n);
  for (let i = 0; i < n; i++) {
    leaves.set(outputs.subarray(i * (32 + memoLen), i * (32 + memoLen) + 32), 32 * i);
    memos.set(outputs.subarray(i * (32 + memoLen) + 32, (i + 1) * (32 + memoLen)), memoLen * i);
  }
  const nf = take(count(), 32);
  if (nf === null) return null;
  const claims = take(count(), 64);
  if (claims === null) return null;
  for (let i = at; i < stream.length; i++) if (stream[i] !== 0) return null;
  return { leaves, memos, nullifiers: Array.from({ length: nf.length / 32 }, (_, i) => hexOf(nf.subarray(32 * i, 32 * i + 32))), claims };
}

/// Whether lists are the outputs and nullifiers a block's public values commit (words 4 and 5, as `land` checks them for a block with its data in calldata).
export function listsAgree(publicValues, l, memoLen = MEMO_LEN) {
  try {
    const pv = bytesOf(publicValues), w = (i) => hexOf(pv.subarray(32 * i, 32 * i + 32));
    const n = l.leaves.length / 32;
    if (!Number.isInteger(n) || l.memos.length !== n * memoLen) return false;
    const items = new Uint8Array(64 * n);
    for (let i = 0; i < n; i++) {
      items.set(l.leaves.subarray(32 * i, 32 * i + 32), 64 * i);
      items.set(memoHash(l.memos.subarray(memoLen * i, memoLen * (i + 1))), 64 * i + 32);
    }
    if (listHash(1, n, items) !== w(4)) return false;
    return listHash(2, l.nullifiers.length, concatBytes(...l.nullifiers.map((x) => bytesOf(x)))) === w(5);
  } catch { return false; }
}

/// One blob from what a source answered: the 131072 bytes themselves, a JSON body holding them as hex (`data` or `blob`), or one (a blob archive's) that
/// names where they are kept (`dataStorageReferences[].url`, each read with `get`). `hash`: the versioned hash asked for, which a body naming its own must match.
async function blobFrom(body, hash, get) {
  if (body.length === BLOB_BYTES) return body;
  let j;
  try { j = JSON.parse(new TextDecoder().decode(body)); } catch { throw new Error('not a blob and not JSON'); }
  if (typeof j?.versionedHash === 'string' && j.versionedHash.toLowerCase() !== hash) throw new Error('answers for another blob');
  for (const k of ['data', 'blob']) {
    if (typeof j?.[k] === 'string') { const b = bytesOf(j[k]); if (b.length === BLOB_BYTES) return b; }
  }
  for (const ref of Array.isArray(j?.dataStorageReferences) ? j.dataStorageReferences : []) {
    if (typeof ref?.url !== 'string') continue;
    try { const b = await get(ref.url); if (b.length === BLOB_BYTES) return b; } catch { /* the next reference */ }
  }
  throw new Error('no blob in the answer');
}

/// A leader's blob sources, tried in this order: `urls` (templates with `{hash}`, one request a blob) and then `beaconUrl`'s blob sidecars of the slot the
/// block landed in. `read(hashes, slotOf)` → { blobs, via } for the first source that holds all of them, `check(blobs)` accepting what it gave; or throws
/// an error whose `attempts` lists each source's reason.
export function makeBlobReader({ urls = [], beaconUrl = '', genesis = MAINNET_GENESIS, fetchImpl = (...a) => fetch(...a), timeoutMs = 20_000 } = {}) {
  const get = async (url) => {
    const r = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return new Uint8Array(await r.arrayBuffer());
  };
  const host = (u) => { try { return new URL(u.replace('{hash}', 'x')).host; } catch { return 'source'; } };
  const sources = urls.map((t) => ({ name: host(t), load: (hashes) => Promise.all(hashes.map(async (h) => blobFrom(await get(t.replaceAll('{hash}', h)), h, get))) }));
  if (beaconUrl) {
    sources.push({
      name: host(beaconUrl),
      async load(hashes, slotOf) {
        const slot = Math.floor((await slotOf() - genesis) / SLOT_SECS);
        const j = JSON.parse(new TextDecoder().decode(await get(`${beaconUrl}/eth/v1/beacon/blob_sidecars/${slot}`)));
        const byHash = new Map();
        for (const s of Array.isArray(j?.data) ? j.data : []) {
          if (typeof s?.kzg_commitment === 'string' && typeof s?.blob === 'string') byHash.set(versionedHash(bytesOf(s.kzg_commitment)), bytesOf(s.blob));
        }
        return hashes.map((h) => { const b = byHash.get(h); if (!b) throw new Error(`no sidecar for ${h.slice(0, 12)} in slot ${slot}`); return b; });
      },
    });
  }
  return {
    sources: sources.length,
    async read(hashes, slotOf, check = () => true) {
      const attempts = [];
      for (const s of sources) {
        try {
          const blobs = await s.load(hashes, slotOf);
          if (blobs.length === hashes.length && check(blobs)) return { blobs, via: s.name };
          attempts.push({ source: s.name, error: 'what it gave does not match the block' });
        } catch (e) { attempts.push({ source: s.name, error: String(e?.message || e).slice(0, 120) }); }
      }
      throw Object.assign(new Error(attempts.length ? 'no blob source held the block\'s data' : 'no blob source is set'), { attempts });
    },
  };
}

/// The lists of a block that landed with its data in blobs: { leaves, memos, nullifiers } as the node's /landed takes them, from `openings` (the call's `blobs`)
/// and `publicValues`, with the blobs from `reader` (`slotOf`: the landing's block time, for a beacon source). Throws when no source gives data that matches.
export async function blobLists({ openings, publicValues, reader, slotOf }) {
  const hashes = openingHashes(openings);
  if (!hashes) throw new Error('the call\'s blob openings are not whole');
  const pv = bytesOf(publicValues);
  let lists = null;
  const { via } = await reader.read(hashes, slotOf, (blobs) => {
    const stream = unblob(blobs);
    const parsed = stream && parseStream(stream);
    if (!parsed || !listsAgree(pv, parsed)) return false;
    lists = parsed;
    return true;
  });
  return { leaves: lists.leaves, memos: lists.memos, nullifiers: lists.nullifiers, via, blobs: hashes.length };
}

/// The wait between tries of what could not be read, per key: `firstMs`, doubling to `maxMs`.
export function makeRetries({ firstMs = 15_000, maxMs = 600_000, now = () => Date.now() } = {}) {
  const tries = new Map();
  return {
    /// Ms still to wait over every key (0 when nothing is waiting).
    pending() { let w = 0; for (const t of tries.values()) w = Math.max(w, t.at - now()); return w; },
    /// Records a failed try; → the wait before the next, in ms.
    failed(key) { const n = (tries.get(key)?.n ?? 0) + 1, wait = Math.min(maxMs, firstMs * 2 ** (n - 1)); tries.set(key, { n, at: now() + wait }); return wait; },
    clear(key) { tries.delete(key); },
  };
}
