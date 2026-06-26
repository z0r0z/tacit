// Build the LIVE Mode-B reverse-reflection fixture: resume from the first attest's state (@RESUME_TO,
// digest must match EXPECT_RESUME_DIGEST), then fold [RESUME_TO+1 .. BATCH_TO] as a mode_b=1 batch that
// MINTS the 0x65 cross-out (using the real eth_set.json the eth-reflection prover emitted). Writes
// reflection_modeb_input.json for bitcoin_prove (MODE=execute validates the fold; MODE=groth16 proves it).
//
//   node tests/build-reflection-modeb-live.mjs <eth_set.json> <out.json>
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import { hmac } from '../node_modules/@noble/hashes/hmac.js';
import { sha256 as nobleSha256 } from '../node_modules/@noble/hashes/sha2.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';

const API = process.env.SIGNET_API || 'https://mempool.space/signet/api';
const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const _cat = (a) => { let n = 0; for (const x of a) n += x.length; const o = new Uint8Array(n); let i = 0; for (const x of a) { o.set(x, i); i += x.length; } return o; };
secp.etc.hmacSha256Sync = (key, ...m) => hmac(nobleSha256, key, _cat(m));
const toHex = (u8) => Buffer.from(u8).toString('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── the round-trip's live values (crossOut on 0x3D38a004; 0x65 reveal in block 309292) ──
const RESUME_FROM = 309252, RESUME_TO = 309257, BATCH_FROM = 309258, BATCH_TO = 309292;
const EXPECT_RESUME_DIGEST = '0x95f38b9e55f8c55d89b1c966da1276495d7eba8e3470cee8a746f0333b6d67fc';
const OX65_TXID = 'c5142fbd2463951f5b527fc617e818b039881f54719a8e70cb949b91d2b94b29';
const CLAIM = '0x64beaad5d46589801d37cf63f5f3cb607e081e33629e0efb23cd0531d6aeb615';
const ASSET = '0x2a0f3cb492f4add38bada8b7ef18de79445846ce7c5b7dc1c4b0d768467a04c2';
const CX = '0x126b639ffaf9d74298fcac39f73d5a6237ce078968f88e32a0e38c93ccd0cb64';
const CY = '0x0b4071992824238d33db6c7785a80dc4ea46d7d0afd36eaa09172e9625c943a1';
const OWNER = '0x6274632d646573742d6f776e6572000000000000000000000000000000000000';

async function fetchRetry(url, { binary = false, tries = 6 } = {}) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(url); if (!r.ok) { last = new Error(`${r.status} ${url}`); await sleep(700 * (i + 1)); continue; } return binary ? new Uint8Array(await r.arrayBuffer()) : (await r.text()).trim(); }
    catch (e) { last = e; await sleep(700 * (i + 1)); }
  }
  throw last;
}

// segwit-aware block splitter (verbatim from build-reflection-bootstrap-fixture.mjs)
function splitBlock(raw) {
  let o = 0; const u8 = raw;
  const rv = () => { const f = u8[o++]; if (f < 0xfd) return f; if (f === 0xfd) { const v = u8[o] | (u8[o + 1] << 8); o += 2; return v; } if (f === 0xfe) { const v = u8[o] | (u8[o + 1] << 8) | (u8[o + 2] << 16) | (u8[o + 3] << 24); o += 4; return v >>> 0; } let v = 0n; for (let i = 0; i < 8; i++) v |= BigInt(u8[o + i]) << BigInt(8 * i); o += 8; return Number(v); };
  const headerHex = toHex(u8.subarray(0, 80)); o = 80;
  const n = rv(); const txsHex = [];
  for (let t = 0; t < n; t++) {
    const start = o; o += 4; let sw = false;
    if (u8[o] === 0x00 && u8[o + 1] === 0x01) { sw = true; o += 2; }
    const vin = rv(); for (let i = 0; i < vin; i++) { o += 36; const sl = rv(); o += sl; o += 4; }
    const vout = rv(); for (let i = 0; i < vout; i++) { o += 8; const sl = rv(); o += sl; }
    if (sw) for (let i = 0; i < vin; i++) { const it = rv(); for (let j = 0; j < it; j++) { const il = rv(); o += il; } }
    o += 4; txsHex.push(toHex(u8.subarray(start, o)));
  }
  if (o !== u8.length) throw new Error(`block parse len mismatch ${o}/${u8.length}`);
  return { headerHex, txsHex };
}

async function getBlock(h) {
  const hash = await fetchRetry(`${API}/block-height/${h}`);
  const raw = await fetchRetry(`${API}/block/${hash}/raw`, { binary: true });
  const txids = JSON.parse(await fetchRetry(`${API}/block/${hash}/txids`));
  return { h, hash, ...splitBlock(raw), txids };
}

async function fetchRange(from, to) {
  const blocks = []; let tot = 0;
  for (let h = from; h <= to; h++) { const b = await getBlock(h); blocks.push(b); tot += b.txsHex.length; await sleep(110); }
  console.error(`fetched [${from}..${to}] ${blocks.length} blocks, ${tot} txs`);
  return blocks;
}

function batchOf(blocks) {
  return { headers: blocks.map((b) => '0x' + b.headerHex), blocks: blocks.map((b) => ({ txs: b.txsHex.map((txData) => ({ txData, txid: null, vins: [], env: null })) })) };
}

async function main() {
  const ethBundle = JSON.parse(readFileSync(process.argv[2] || '/tmp/eth_set.json', 'utf8'));
  const out = process.argv[3] || 'reflection_modeb_input.json';
  const cp = makeConfidentialPool({ secp, keccak256: keccak_256, sha256 });

  // 1. fetch all blocks [RESUME_FROM .. BATCH_TO]
  const all = await fetchRange(RESUME_FROM, BATCH_TO);
  const resumeBlocks = all.filter((b) => b.h >= RESUME_FROM && b.h <= RESUME_TO);
  const batchBlocks = all.filter((b) => b.h >= BATCH_FROM && b.h <= BATCH_TO);

  // 2. resume to @RESUME_TO from genesis; verify the digest matches the on-chain knownReflectionDigest
  const state = cp.makeScanReflectionState();
  state.setHeight(RESUME_FROM - 1);
  console.error(`genesis digest = ${state.digest()}`);
  const coords = new Map();
  const r1 = await cp.assembleReflectionScanInput(state, { anchorHeight: RESUME_FROM, ...batchOf(resumeBlocks) }, coords);
  console.error(`resume newDigest = ${r1.newDigest}  (want ${EXPECT_RESUME_DIGEST})`);
  if (r1.newDigest.toLowerCase() !== EXPECT_RESUME_DIGEST.toLowerCase()) { console.error('FATAL: resume digest != on-chain knownReflectionDigest — state divergence'); process.exit(1); }

  // 3. buildModeBBatch from the real eth set; locate + mark the 0x65 tx in block BATCH_TO
  const { modeB, membership } = cp.buildModeBBatch(ethBundle, [{ txid: OX65_TXID, claimId: CLAIM }], []);
  const m = membership.get(OX65_TXID);
  if (!m) { console.error('FATAL: 0x65 claimId not a member of the eth crossOutSet'); process.exit(1); }
  console.error(`modeB membership: setIndex=${m.setIndex} setPath=${m.setPath.length} crossoutSetRoot=${modeB.crossoutSetRoot}`);

  const b2 = batchOf(batchBlocks);
  const lastIdx = batchBlocks.length - 1; // block BATCH_TO
  const tgt = batchBlocks[lastIdx];
  const txIndex = tgt.txids.indexOf(OX65_TXID);
  if (txIndex < 0) { console.error(`FATAL: 0x65 ${OX65_TXID} not in block ${tgt.h}`); process.exit(1); }
  console.error(`0x65 at block ${tgt.h} (batch index ${lastIdx}) tx index ${txIndex}`);
  b2.blocks[lastIdx].txs[txIndex].env = { type: 'crossout_mint', asset: ASSET, claimId: CLAIM, cx: CX, cy: CY, owner: OWNER, membership: m };

  // 4. assemble the mode_b=1 fixture (prior = state @RESUME_TO)
  const before = state.counts();
  const fixture = await cp.assembleReflectionScanInput(state, { anchorHeight: BATCH_FROM, ...b2, modeB }, coords);
  const after = state.counts();
  console.error(`mode_b=${fixture.modeB} ethPv_match=${fixture.ethPv === ethBundle.ethPv} newDigest=${fixture.newDigest}`);
  console.error(`pool note ${before.note}->${after.note}  spent ${before.spent}->${after.spent}  (the 0x65 mint adds 1 note)`);
  const cm = fixture.blocks[lastIdx].txs[txIndex].crossoutMint;
  console.error(`0x65 fold: ${cm ? 'minted setPath=' + cm.setPath.length + ' notePath=' + cm.notePath.length : 'NOT FOLDED'}`);
  if (!cm) { console.error('FATAL: the 0x65 did not fold (membership/skip)'); process.exit(1); }
  if (after.note !== before.note + 1) { console.error('FATAL: mint did not add exactly one note'); process.exit(1); }

  writeFileSync(out, JSON.stringify(fixture));
  console.error(`WROTE ${out} (${(Buffer.byteLength(JSON.stringify(fixture)) / 1e6).toFixed(2)} MB)`);
}
main().catch((e) => { console.error('ERR', e); process.exit(1); });
