// What the header feeder reads of the Bitcoin chain, asked of the explorers as seldom as it can be (the reader under it is lib/esplora-reader.js).
//
// The public explorers rate-limit a shared address by how often it asks, so the cheapest request is the one not made:
//  - tip(): the tip height is kept for tipTtlMs. Bitcoin finds a block every ten minutes, and a feeder that is current, or holding a batch for cheaper
//    gas, gains nothing from knowing it to the second (it was read every cycle, 30 s apart).
//  - hashAt(h): a block buried `depth` deep under the tip is not going to change, so its hash is kept for good (bounded); the shallow ones are asked
//    again, since a reorg replaces those.
//  - headers(from, to): the 80-byte headers of a range, ten to a request. An Esplora `GET /blocks/<height>` lists ten blocks downward from <height> with
//    every field of their headers, so each header is rebuilt from its fields and accepted only when its double SHA-256 is the block's id and it links to
//    the block below it. A page that is short, malformed, or fails either check is dropped and its blocks are asked one by one (`/block-height/<h>`, then
//    `/block/<hash>/header`, as before), so an explorer that does not serve the page, or serves a wrong one, costs only the old way. (A 40-header batch was
//    80 requests in a burst; it is 4.)
// The relay checks every header's proof of work on its own, so what the explorer says is never taken on trust past this point.
import { createHash } from 'node:crypto';

const sha256 = (b) => createHash('sha256').update(b).digest();
const le32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(Number(n) >>> 0); return b; };
const rev = (hex) => Buffer.from(hex, 'hex').reverse();
const HEX64 = /^[0-9a-f]{64}$/;
const parentOf = (hex) => rev(hex.slice(8, 72)).toString('hex');   // the id of the block a header names as its parent

// The 80-byte header (hex) of an Esplora block object, or null when a field is missing or the result does not hash to the block's id.
export function headerFromBlock(b) {
  if (!b || !HEX64.test(String(b.id)) || !HEX64.test(String(b.previousblockhash)) || !HEX64.test(String(b.merkle_root))) return null;
  for (const k of ['version', 'timestamp', 'bits', 'nonce']) if (!Number.isInteger(b[k])) return null;
  const raw = Buffer.concat([le32(b.version), rev(b.previousblockhash), rev(b.merkle_root), le32(b.timestamp), le32(b.bits), le32(b.nonce)]);
  return sha256(sha256(raw)).reverse().toString('hex') === b.id ? raw.toString('hex') : null;
}

export function makeExplorerChain(reader, {
  now = Date.now, tipTtlMs = 90_000, depth = 12, keep = 4096, page = 10, log = () => {},
} = {}) {
  let tipAt = 0, tipHeight = null;
  const buried = new Map();      // height -> hash, only for heights at least `depth` under the tip as it was read
  const headerOf = new Map();    // hash -> header hex (a header never changes)
  const remember = (map, k, v) => { map.set(k, v); if (map.size > keep) map.delete(map.keys().next().value); };

  async function tip() {
    if (tipHeight != null && now() - tipAt < tipTtlMs) return tipHeight;
    const h = parseInt(await reader.get('/blocks/tip/height'), 10);
    if (!Number.isInteger(h) || h < 0) throw new Error(`esplora /blocks/tip/height: not a height (${h})`);
    tipHeight = h; tipAt = now();
    return h;
  }

  async function hashAt(h) {
    if (buried.has(h)) return buried.get(h);
    const hash = await reader.get(`/block-height/${h}`);
    if (tipHeight != null && h <= tipHeight - depth && HEX64.test(hash)) remember(buried, h, hash);
    return hash;
  }

  async function oneHeader(h) {
    const hash = await hashAt(h);
    if (headerOf.has(hash)) return headerOf.get(hash);
    const hdr = await reader.get(`/block/${hash}/header`);
    if (!/^[0-9a-fA-F]{160}$/.test(hdr)) throw new Error(`bad header @${h} (${hdr.slice(0, 16)}…)`);
    remember(headerOf, hash, hdr);
    return hdr;
  }

  // The headers of from..to, ascending. A page is the ten blocks at and under `top`: each is kept only if it rebuilds to its id and the header above it
  // (already held, or the one just kept) names it as its parent. The first block that fails ends the page, and the blocks left are asked again, from there.
  async function headers(from, to) {
    const out = new Map();
    let top = to;
    while (top >= from) {
      let got = 0;
      try {
        const blocks = JSON.parse(await reader.get(`/blocks/${top}`));
        const byHeight = new Map(Array.isArray(blocks) ? blocks.map((b) => [b && b.height, b]) : []);
        for (let h = top; h >= Math.max(from, top - page + 1); h--) {
          const b = byHeight.get(h), hex = b && headerFromBlock(b);
          const above = out.get(h + 1);
          if (!hex || (above && parentOf(above) !== b.id)) break;
          out.set(h, hex); remember(headerOf, b.id, hex); got++;
        }
      } catch (e) { log(`block page ${top}: ${String(e.message).slice(0, 80)} — asking one block at a time`); }
      if (!got) out.set(top, await oneHeader(top));
      while (top >= from && out.has(top)) top--;
    }
    return Array.from({ length: to - from + 1 }, (_, i) => out.get(from + i));
  }

  return { tip, hashAt, headers };
}
