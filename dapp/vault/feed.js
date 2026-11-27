// Keeping the vaults' price feed up from the page. A vault prices TAC from two venue oracles, and an oracle only knows an interval once someone has
// recorded it: the venue's storage proofs at one block of the interval, with the headers of that block and of the block after it. Lending needs every
// interval of the last eight hours from both venues, so when nobody has recorded for a while the page can do it from the visitor's wallet, a batch at
// a time through Multicall3. Each record is built here from an archive node (headers re-encoded and checked against their own block hash, proofs as
// the node gives them) and the oracle checks it all again: a wrong record reverts, and the page tests every batch with eth_call before it is sent.
import { keccak_256, bytesToHex, hexToBytes } from '/vendor/tacit-deps.min.js';
import { _internal, MULTICALL3 } from '/evm-trade-venues.js?cb=9aac0fac';
export { MULTICALL3 };

const strip = (h) => String(h).replace(/^0x/, '');
const word = (n) => BigInt(n).toString(16).padStart(64, '0');
const wordAt = (hex, i) => BigInt(`0x${strip(hex).slice(i * 64, (i + 1) * 64) || '0'}`);
const addrAt = (hex, i) => `0x${strip(hex).slice(i * 64 + 24, (i + 1) * 64)}`;

export const SEL = {
  record: '0x3113428b', sampleOf: '0x89906360', slots: '0x48547d69', STEP: '0x53d0f255', MAX_WINDOW: '0xdeb96634', POOL: '0x7535d246',
  A: '0xf446c1d0', B: '0x32e7c5bf', ORACLE: '0x38013f02', coverage: '0xee8f6a0e', GRACE: '0x137d29d9', FALLBACK: '0x3a6dd405',
};
export const GRACE = 10;             // blocks after an interval ends before it counts (TacIntervalOracle.GRACE)
export const BLOCK_SECONDS = 12;
export const RECORD_GAS = 945_000;    // measured on mainnet: a batch of 10 records used 9.45M gas
// A transaction may use at most 2^24 gas since Fusaka (EIP-7825), and a wallet's own batch of calls (EIP-5792) is one transaction too, so no single confirmation
// carries more than about 17 records. A batch is 10 (about 9.5M gas, and under the 128 KB a transaction may carry), and `GAS_ROOM` is what a batch is let use: one estimated over it is cut down before it is sent.
export const TX_GAS_CAP = 16_777_216;
export const PER_TX = 10;   // a record is 9-11 KB of proofs and a transaction may carry at most 128 KB: 16 would not fit
export const GAS_ROOM = 16_000_000;

// ── RLP, for a block header ──
const concat = (...parts) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let i = 0; for (const p of parts) { out.set(p, i); i += p.length; } return out; };
const bytesOf = (h) => { const s = strip(h); return hexToBytes(s.length % 2 ? `0${s}` : s); };
const intBytes = (v) => { const x = BigInt(v); if (x === 0n) return new Uint8Array(0); const h = x.toString(16); return hexToBytes(h.length % 2 ? `0${h}` : h); };
function prefix(n, base) {
  if (n < 56) return Uint8Array.of(base + n);
  const b = []; for (let m = n; m > 0; m = Math.floor(m / 256)) b.unshift(m % 256);
  return Uint8Array.of(base + 55 + b.length, ...b);
}
const rlpString = (b) => (b.length === 1 && b[0] < 0x80 ? b : concat(prefix(b.length, 0x80), b));
const rlpList = (items) => { const body = concat(...items); return concat(prefix(body.length, 0xc0), body); };

// The header fields in order, and whether each is a number (shortest big-endian bytes) or fixed bytes. A node leaves out the ones its fork does not have.
// Glamsterdam's two (EIP-7928's block access list hash, EIP-7843's slot number) come after requestsHash.
const HEADER = [
  ['parentHash', 'b'], ['sha3Uncles', 'b'], ['miner', 'b'], ['stateRoot', 'b'], ['transactionsRoot', 'b'], ['receiptsRoot', 'b'], ['logsBloom', 'b'],
  ['difficulty', 'i'], ['number', 'i'], ['gasLimit', 'i'], ['gasUsed', 'i'], ['timestamp', 'i'], ['extraData', 'b'], ['mixHash', 'b'], ['nonce', 'b'],
  ['baseFeePerGas', 'i'], ['withdrawalsRoot', 'b'], ['blobGasUsed', 'i'], ['excessBlobGas', 'i'], ['parentBeaconBlockRoot', 'b'], ['requestsHash', 'b'],
  ['blockAccessListHash', 'b'], ['slotNumber', 'i'],
];
// The RLP header of a block as the node returned it (0x…), or an error when its hash is not the block's own: nothing wrong is ever sent.
export function headerRlp(block) {
  const items = HEADER.filter(([k]) => block[k] != null).map(([k, kind]) => rlpString(kind === 'i' ? intBytes(block[k]) : bytesOf(block[k])));
  const raw = rlpList(items);
  if (`0x${bytesToHex(keccak_256(raw))}` !== String(block.hash).toLowerCase()) throw new Error(`the header of block ${Number(block.number)} did not rebuild to its hash`);
  return `0x${bytesToHex(raw)}`;
}

// ── ABI, for record and for Multicall3 ──
const pad32 = (h) => h.padEnd(Math.ceil(h.length / 64) * 64, '0');
const encBytes = (hex) => { const h = strip(hex); return word(h.length / 2) + pad32(h); };
function encBytesList(list) {
  let head = '', tail = '', off = list.length * 32;
  for (const x of list) { const t = encBytes(x); head += word(off); tail += t; off += t.length / 2; }
  return word(list.length) + head + tail;
}
// record(bytes header, bytes next, bytes[] accountProof, bytes[] proofA, bytes[] proofB)
export function encRecord(a) {
  const parts = [encBytes(a[0]), encBytes(a[1]), encBytesList(a[2]), encBytesList(a[3]), encBytesList(a[4])];
  let head = '', tail = '', off = 5 * 32;
  for (const t of parts) { head += word(off); tail += t; off += t.length / 2; }
  return SEL.record + head + tail;
}
// One transaction for several records: every call must succeed, so a record someone else has just made fails the whole batch and it is built again.
export const encBatch = (calls) => _internal.encAggregate3(calls, false);

// ── reading what is recorded ──
// `rpc(method, params)` for the page's reads, `headerRpc` for the headers of blocks hours old (any node has them) and `proofRpc` for eth_getProof at those blocks (an
// archive node: only some serve them). Either may be a pool that takes `rpc(method, params, { check })`, which asks the next node when a reply fails the check.
// A vault whose oracle is a TacProvenOracle (it answers `coverage()`) is kept up by one proof instead: `proofUrls` are where provers post their newest
// ({ publicValues, proof }, as tac-oracle-host writes it), and the proof goes in as that oracle's `record`, checked by eth_call like any other. With no
// newer proof posted, its views read the pair behind it (its FALLBACK), which the page records as it always has, each record sent through the proven
// oracle with the venue it is for as one more `proofB` element, so the router carries it as before.
export function makeFeed({ rpc, proofRpc = rpc, headerRpc = proofRpc, proofUrls = [], fetchImpl = (...a) => fetch(...a) }) {
  const call = (to, data, extra = {}) => rpc('eth_call', [{ to, data, ...extra }, 'latest']);
  const batch = async (list) => (list.length ? _internal.decAggregate3(await call(MULTICALL3, _internal.encAggregate3(list)), list.length) : []);

  // The venue oracles behind a pair, and for each its step, longest window, pool and storage slots. They never change, so they are read once and handed out
  // as copies (a read writes its own figures on them).
  const PAIRS = new Map();                                                                                                   // pair → venues
  async function pairVenues(pair) {
    if (!PAIRS.has(pair)) {
      const [a, b] = (await batch([{ to: pair, data: SEL.A }, { to: pair, data: SEL.B }])).map((r) => addrAt(r, 0));
      const out = [];
      for (const oracle of [a, b]) {
        const [step, maxWindow, pool, slots] = await batch([{ to: oracle, data: SEL.STEP }, { to: oracle, data: SEL.MAX_WINDOW }, { to: oracle, data: SEL.POOL }, { to: oracle, data: SEL.slots }]);
        out.push({ oracle, step: Number(wordAt(step, 0)), points: Number(wordAt(maxWindow, 0)) / (Number(wordAt(step, 0)) * BLOCK_SECONDS), pool: addrAt(pool, 0), slots: [`0x${strip(slots).slice(0, 64)}`, `0x${strip(slots).slice(64, 128)}`] });
      }
      PAIRS.set(pair, out);
    }
    return PAIRS.get(pair).map((v) => ({ ...v }));
  }

  // What a vault prices from: its pair's two venues, or a proven oracle. The vault's oracle is asked for on every read (the owner can put in another).
  const PROVEN = new Map();                                                                                                  // oracle → its figures
  async function venuesOf(vault) {
    const pair = addrAt(await call(vault, SEL.ORACLE), 0);
    if (!PROVEN.has(pair) && await call(pair, SEL.coverage).then((r) => strip(r).length >= 192, () => false)) {
      const [step, grace, fallback] = await batch([{ to: pair, data: SEL.STEP }, { to: pair, data: SEL.GRACE }, { to: pair, data: SEL.FALLBACK }]);
      PROVEN.set(pair, { oracle: pair, proven: true, step: Number(wordAt(step, 0)), grace: Number(wordAt(grace, 0)), fallback: addrAt(fallback, 0), points: 1 });
    }
    return PROVEN.has(pair) ? [{ ...PROVEN.get(pair) }] : pairVenues(pair);
  }

  async function read(vault) {
    const venues = await venuesOf(vault);
    const head = Number(BigInt(await rpc('eth_blockNumber', [])));
    return venues[0]?.proven ? readProven(venues[0], head) : readVenues(venues, head);
  }

  // What each venue has recorded of the intervals a vault reads now (the last eight hours) and of the newer ones, newest first.
  async function readVenues(venues, head) {
    const calls = [], keys = [];
    for (const v of venues) {
      v.newest = Math.floor((head - 1 - GRACE) / v.step) - 1;               // the newest interval that counts
      v.top = Math.floor((head - 1) / v.step) - 1;                          // the newest whose following block exists
      v.from = v.newest - v.points + 1;
      for (let k = v.top; k >= v.from; k--) { calls.push({ to: v.oracle, data: SEL.sampleOf + word(k) }); keys.push([v, k]); }
    }
    const res = await batch(calls);
    for (const v of venues) { v.have = new Set(); v.missing = []; v.depth = null; }
    keys.forEach(([v, k], i) => {
      if (!res[i] || wordAt(res[i], 0) === 0n) { v.missing.push(k); return; }
      v.have.add(k);
      const d = wordAt(res[i], 1);                                                     // the venue's ETH depth at that interval
      if (k >= v.from && k <= v.newest && (v.depth == null || d < v.depth)) v.depth = d;
    });
    for (const v of venues) v.counted = v.points - v.missing.filter((k) => k <= v.newest).length;     // of `points`, the ones lending reads
    // The depth lending would read, from what is recorded: the thinner venue's lowest. Once every interval is in it is the vault's own figure;
    // before, a missing interval may be thinner still, so it is an upper bound.
    const depth = venues.every((v) => v.depth != null) ? venues.reduce((m, v) => (m == null || v.depth < m ? v.depth : m), null) : null;
    return { head, venues, depth, missing: venues.reduce((n, v) => n + v.missing.length, 0), ready: venues.every((v) => v.counted === v.points) };
  }

  // A proven oracle holds X, its first interval (X - 1) and how many it answers for; the depth lending reads is held for the first two. Past them, one
  // proof of a newer interval is the one record missing; with none posted, the views read the pair, and its venues are what is missing.
  async function readProven(v, head) {
    const cov = await call(v.oracle, SEL.coverage);
    const [x, first] = [0, 1].map((i) => Number(wordAt(cov, i)));
    v.newest = Math.floor((head - 1 - v.grace) / v.step) - 1;               // the newest interval that counts
    v.top = Math.floor((head - 1) / v.step) - 1;                            // the newest whose following block exists
    v.x = x;
    v.depth = null;
    const held = v.newest >= first && v.newest - first < 2;
    v.have = new Set(held ? [v.newest] : []);
    v.counted = held ? 1 : 0;
    v.missing = [];
    if (held) return { head, venues: [v], depth: null, missing: 0, ready: true, proven: true };
    v.proof = await newestProof(v).catch((e) => { v.why = e.message; return null; });
    if (v.proof || !/[1-9a-f]/i.test(strip(v.fallback || ''))) {
      v.missing = v.top > x ? [v.top] : [];
      return { head, venues: [v], depth: null, missing: v.missing.length, ready: false, proven: true };
    }
    const venues = (await pairVenues(v.fallback)).map((u, i) => ({ ...u, relay: v.oracle, tag: i }));
    return { ...(await readVenues(venues, head)), proven: true };
  }

  // The newest proof a prover has posted, if it covers the interval that counts and is newer than what the oracle holds; an error says why there is none.
  async function newestProof(v) {
    let last = 'no prover is listed';
    for (const url of proofUrls) {
      try {
        const r = await fetchImpl(url, { cache: 'no-store' });
        if (!r.ok) { last = `${url} answered ${r.status}`; continue; }
        const p = await r.json();
        const pv = strip(p?.publicValues || ''), proof = strip(p?.proof || '');
        if (pv.length < 128 || pv.length % 64 || proof.length !== 576) { last = `${url} sent no proof`; continue; }
        const head = BigInt(`0x${pv.slice(64, 128)}`), x = Number(head & 0xffffffffn);
        if (x < v.newest || x <= v.x) { last = `the newest proof (interval ${x}) is not newer than the prices it would replace`; continue; }
        return { pv: `0x${pv}`, proof: `0x${proof}`, x, anchor: Number((head >> 168n) & 0xffffffffn) };
      } catch (e) {
        last = `${url}: ${e?.message || e}`;
      }
    }
    throw new Error(`No proof of the newest prices is posted yet (${last}).`);
  }

  // The record for a proven oracle: that proof as its `record`. `k` is kept as asked, so the record answers the plan it was built for.
  async function provenRecord(v, k) {
    const p = v.proof || await newestProof(v);
    return { to: v.oracle, k, n: p.anchor, data: encRecord([p.pv, p.proof, [], [], []]) };
  }

  // ── building one record ──
  // A header rebuilt to its own hash (a node that sends anything else is not believed: the next one is asked), kept in `memo` so that the two venues of an interval, which
  // share their blocks, ask for each once. A node that does not have the block yet is only given a moment's rest.
  const header = (n, memo, skip) => {
    if (!memo.has(n)) {
      const p = headerRpc('eth_getBlockByNumber', [`0x${n.toString(16)}`, false], {
        skip, check: (b) => { if (!b) throw Object.assign(new Error(`block ${n} is not at the node yet`), { rest: 8e3 }); headerRlp(b); return b.mixHash != null; },
      }).then((b) => { if (!b) throw new Error(`block ${n} is not available from the node`); return { b, rlp: headerRlp(b) }; });
      memo.set(n, p);
      p.catch(() => memo.delete(n));
    }
    return memo.get(n);
  };
  // A proof has the account's nodes and one list of nodes for each slot asked.
  const proofOk = (slots) => (p) => Array.isArray(p?.accountProof) && p.accountProof.length > 0 && Array.isArray(p.storageProof) && p.storageProof.length === slots.length && p.storageProof.every((x) => Array.isArray(x?.proof) && x.proof.length > 0);
  // The arguments of `record` for interval k of a venue: the sample block is picked by the next block's mixHash. `skip` is for building a record again after the oracle
  // refused it: the nodes that answered first are left out. A venue behind a proven oracle (`relay`) gets its record through that oracle, its `tag` last in proofB.
  async function buildRecord(v, k, memo = new Map(), skip = 0) {
    if (v.proven) return provenRecord(v, k);
    const nextBlock = await header((k + 1) * v.step, memo, skip);
    const n = k * v.step + Number(BigInt(nextBlock.b.mixHash) % BigInt(v.step));
    const [sample, proof] = await Promise.all([header(n, memo, skip), proofRpc('eth_getProof', [v.pool, v.slots, `0x${n.toString(16)}`], { check: proofOk(v.slots), skip })]);
    const proofB = v.relay ? [...proof.storageProof[1].proof, v.tag ? '0x01' : '0x00'] : proof.storageProof[1].proof;
    const data = encRecord([sample.rlp, nextBlock.rlp, proof.accountProof, proof.storageProof[0].proof, proofB]);
    return v.relay ? { to: v.relay, venue: v.oracle, k, n, data } : { to: v.oracle, k, n, data };
  }
  // Records for a list of [venue, k], a few at a time so a public node is not flooded.
  async function build(list, parallel = 4) {
    const out = new Array(list.length), memo = new Map();
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(parallel, list.length) }, async () => {
      for (let j = i++; j < list.length; j = i++) out[j] = await buildRecord(...list[j], memo);
    }));
    return out;
  }

  // The next batch to send: the newest missing intervals first, as the keeper does.
  const nextBatch = (state, n = PER_TX) => state.venues.flatMap((v) => v.missing.map((k) => [v, k])).sort((x, y) => y[1] - x[1]).slice(0, n);

  return { read, build, buildRecord, nextBatch, venuesOf, call };
}
