// The reflection's tracked notes, checked against Ethereum before anything is credited from them. The API serves the live set and
// the other words of the reflection digest (GET /reflection/live); this rebuilds the set's root and size, hashes the words, and
// accepts the set only when that equals the digest the pool has attested (attestedReflectionDigest()). A note in the set was proven
// valid by the reflection's own fold, so a wallet can credit it without walking its history; anything that does not check out is
// simply not used, and the wallet walks the history as before.

const LIVE_ROOT_AT = 4; // the live set's root and size are words 4 and 5 of the digest (confidential-pool.js digestParts)
const strip = (h) => String(h).replace(/^0x/, '').toLowerCase();
const rev = (h) => strip(h).match(/../g).reverse().join('');
function bytesOf(words) {
  const out = new Uint8Array(words.length * 32);
  words.forEach((w, i) => { const s = strip(w).padStart(64, '0'); for (let j = 0; j < 32; j++) out[i * 32 + j] = parseInt(s.slice(2 * j, 2 * j + 2), 16); });
  return out;
}
const hexOf = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

// → { height, get(txid, vout) → { commitmentHash, asset, authKey, bound } | null, size }, or throws when the set does not check out.
export async function loadTrackedNotes({ pool, keccak256, fetchLive, attestedDigest, treeWorkers = null }) {
  const [live, onChain] = await Promise.all([fetchLive(), attestedDigest()]);
  const parts = live && Array.isArray(live.parts) ? live.parts : null;
  const triples = live && Array.isArray(live.liveTriples) ? live.liveTriples : null;
  if (!parts || parts.length <= LIVE_ROOT_AT + 1 || !triples) throw new Error('tracked notes: the API answer is not a live set');
  const set = pool.makeLiveUtxoSet();
  set.load(triples);
  // the root of a set of thousands is a hash for each entry and for each pair above them: in `treeWorkers` where the set has the way to (rootAsync), else here, the same root
  const root = typeof set.rootAsync === 'function' && treeWorkers ? await set.rootAsync(treeWorkers) : set.root();
  if (strip(root) !== strip(parts[LIVE_ROOT_AT]) || BigInt('0x' + strip(parts[LIVE_ROOT_AT + 1])) !== BigInt(set.len())) {
    throw new Error('tracked notes: the live set does not match the digest words it came with');
  }
  const digest = hexOf(keccak256(bytesOf(parts)));
  if (!/^(0x)?[0-9a-f]{64}$/i.test(String(onChain || '')) || digest !== strip(onChain)) {
    throw new Error('tracked notes: the live set is not the one attested on Ethereum');
  }
  const byKey = new Map(triples.map(([k, v, a, ak, b]) => [strip(k).padStart(64, '0'), { commitmentHash: strip(v).padStart(64, '0'), asset: strip(a).padStart(64, '0'), authKey: strip(ak || '0').padStart(64, '0'), bound: Number(b) === 1 }]));
  return {
    height: Number(live.height),
    size: byKey.size,
    // txid in display order, as explorers give it; the reflection keys an outpoint by keccak(txid in internal order ‖ vout LE).
    get: (txid, vout) => byKey.get(strip(pool.outpointKey('0x' + rev(txid), Number(vout))).padStart(64, '0')) || null,
  };
}
