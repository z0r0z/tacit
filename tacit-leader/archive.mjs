// The blocks a leader has landed, kept on its disk (ARCHIVE_DIR/<height>.json: the block's public values and the lists it published), so a restart
// rebuilds the node from them and not from the chain's logs (an endpoint that serves old logs is not always to be had). Pure, so tested:
// tests/tacit-leader-archive.test.mjs.
import { bytesOf, hexOf } from './abi.mjs';

const WORDS = 19;                                         // a block's public values: 19 words; the first is the state it starts from, the second the one it ends at
const word = (pv, i) => hexOf(pv.subarray(32 * i, 32 * i + 32));

/// A block's file, from its public values and the lists it published (bytes or hex, as the call carried them). `ethBlock`: where it landed, when known.
export function archiveEntry(pv, lists, ethBlock = null) {
  return { publicValues: hexOf(bytesOf(pv)), lists: { leaves: hexOf(bytesOf(lists.leaves)), memos: hexOf(bytesOf(lists.memos)), nullifiers: [...lists.nullifiers].map((n) => hexOf(bytesOf(n))) }, includes: [], ...(ethBlock != null ? { ethBlock } : {}) };
}

/// Blocks 1..`upTo` from the archive, each read and checked to start where the one before ended. → { ok: true, blocks: [{ height, pv, lists }], first (the state
/// block 1 starts from), last (the state the last ends at) } or { ok: false, why }. `read(height)` gives a block's file as text, or null when there is none.
export function loadArchive(upTo, read) {
  const blocks = [];
  let prev = null, first = null;
  for (let h = 1; h <= upTo; h++) {
    const text = read(h);
    if (text == null) return { ok: false, why: `no file for block ${h}` };
    let a, pv;
    try {
      a = JSON.parse(text);
      pv = bytesOf(a.publicValues);
      if (pv.length < 32 * WORDS || pv.length % 32) throw new Error('public values');
      if (typeof a.lists?.leaves !== 'string' || typeof a.lists?.memos !== 'string' || !Array.isArray(a.lists?.nullifiers)) throw new Error('lists');
    } catch (e) { return { ok: false, why: `block ${h}'s file does not read (${e.message})` }; }
    if (prev !== null && word(pv, 0) !== prev) return { ok: false, why: `block ${h} does not start where block ${h - 1} ended` };
    if (first === null) first = word(pv, 0);
    prev = word(pv, 1);
    blocks.push({ height: h, pv, lists: a.lists });
  }
  return { ok: true, blocks, first, last: prev };
}
