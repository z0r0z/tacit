// dapp/nostr-board.js: the open board on public Nostr relays. A post is a NIP-01 event (its id the sha256 of the serialized event, signed
// BIP-340, mined to POW_BITS); a reader keeps only well-formed, signed, mined, unexpired posts of proofs for this pool, one per proof; and
// the board's client talks to relays the NIP-01 way (EVENT → OK, REQ → EVENT… EOSE). A stand-in relay answers here.
// Run: node --test tests/nostr-board.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makePost, readPost, makeNostrBoard, mergeBoards, eventId, powBits, POW_BITS, BOARD_TAG, BOARD_KIND } from '../dapp/nostr-board.js';
import { verifySchnorr } from '../dapp/bulletproofs.js';
import { hexToBytes } from '../dapp/vendor/tacit-deps.min.js';
import { readFileSync } from 'node:fs';
import { NOSTR_RELAYS } from '../dapp/nostr-board.js';

const POOL = '0x000000000Ed1eabD231Be41d93b719056F7febFC';
const job = (n = 1, o = {}) => ({ type: 'transfer', publicValues: '0x' + String(n).padStart(2, '0').repeat(96), proof: '0x' + 'cd'.repeat(260), memos: ['0x' + 'ab'.repeat(40)], expiresAt: 0, ...o });
const NOW = 1_800_000_000_000;

test('the verifier is BIP-340’s: the official vectors', () => {
  // (BIP-340 test-vectors.csv rows 1 and 2, and row 1 with its last byte changed)
  const v = [['DFF1D77F2A671C5F36183726DB2341BE58FEAE1DA2DECED843240F7B502BA659', '243F6A8885A308D313198A2E03707344A4093822299F31D0082EFA98EC4E6C89', '6896BD60EEAE296DB48A229FF71DFE071BDE413E6D43F917DC8DCF8C78DE33418906D11AC976ABCCB20B091292BFF4EA897EFCB639EA871CFA95F6DE339E4B0A', true],
    ['DD308AFEC5777E13121FA72B9CC1B7CC0139715309B086C960E18FD969774EB8', '7E2D58D8B3BCDF1ABADEC7829054F90DDA9805AAB56C77333024B9D0A508B75C', '5831AAEED7B44BB74E5EAB94BA9D4294C49BCF2A60728D8B4C200F50DD313C1BAB745879A5AD954A72C45A91C3A51D3C7ADEA98D82F8481E0E1E03674A6F3FB7', true],
    ['DFF1D77F2A671C5F36183726DB2341BE58FEAE1DA2DECED843240F7B502BA659', '243F6A8885A308D313198A2E03707344A4093822299F31D0082EFA98EC4E6C89', '6896BD60EEAE296DB48A229FF71DFE071BDE413E6D43F917DC8DCF8C78DE33418906D11AC976ABCCB20B091292BFF4EA897EFCB639EA871CFA95F6DE339E4B0B', false]];
  for (const [pub, msg, sig, ok] of v) assert.equal(verifySchnorr(hexToBytes(sig), hexToBytes(msg), hexToBytes(pub)), ok);
});

test('a post is a mined, signed NIP-01 event, one per proof, read back as a board job', () => {
  const ev = makePost(job(), { pool: POOL, nowSec: NOW / 1000 });
  assert.equal(ev.kind, BOARD_KIND);
  assert.equal(eventId(ev), ev.id);
  assert.ok(powBits(ev.id) >= POW_BITS);
  assert.ok(verifySchnorr(hexToBytes(ev.sig), hexToBytes(ev.id), hexToBytes(ev.pubkey)));
  assert.ok(ev.tags.some((t) => t[0] === 't' && t[1] === BOARD_TAG));
  assert.equal(ev.tags.find((t) => t[0] === 'expiration')[1], String(NOW / 1000 + 86400), 'a day, with no deadline of its own');
  const j = readPost(ev, { pool: POOL, nowMs: NOW });
  assert.equal(j.type, 'transfer'); assert.equal(j.publicValues, job().publicValues); assert.equal(j.via, 'nostr'); assert.equal(j.status, 'open');
  assert.notEqual(makePost(job(), { pool: POOL, nowSec: NOW / 1000 }).pubkey, ev.pubkey, 'a key of its own for each post');
});

test('a reader keeps nothing it cannot check', () => {
  const ev = makePost(job(), { pool: POOL, nowSec: NOW / 1000 });
  const read = (e, o = {}) => readPost(e, { pool: POOL, nowMs: NOW, ...o });
  assert.equal(read({ ...ev, content: ev.content.replace('transfer', 'unwrap') }), null, 'content changed: the id no longer matches');
  assert.equal(read({ ...ev, sig: ev.sig.slice(0, -2) + (ev.sig.endsWith('00') ? '01' : '00') }), null, 'a bad signature');
  assert.equal(read(ev, { pool: '0x' + '11'.repeat(20) }), null, 'another pool');
  assert.equal(read(ev, { nowMs: NOW + 2 * 86400e3 }), null, 'expired');
  assert.equal(read(ev, { minBits: 40 }), null, 'too little work');
  assert.throws(() => makePost(job(1, { type: 'wraplp' }), { pool: POOL }), /not a settle any account can send/);
  assert.throws(() => makePost(job(1, { proof: '0x12z' }), { pool: POOL }));
  const late = makePost(job(1, { expiresAt: NOW + 60e3 }), { pool: POOL, nowSec: NOW / 1000 });
  assert.equal(read(late, { nowMs: NOW + 120e3 }), null, 'past the proof’s own deadline');
});

// A stand-in relay: keeps what it is sent and answers REQ with what matches kind and #t.
function relayNet() {
  const store = [], log = [];
  class WS {
    constructor(url) { this.url = url; log.push(url); setTimeout(() => this.onopen?.(), 0); }
    send(s) {
      const x = JSON.parse(s), out = (m) => setTimeout(() => this.onmessage?.({ data: JSON.stringify(m) }), 0);
      if (x[0] === 'EVENT') { store.push(x[1]); out(['OK', x[1].id, true, '']); }
      if (x[0] === 'REQ') { const f = x[2]; for (const e of store) if (f.kinds.includes(e.kind) && e.tags.some((t) => t[0] === 't' && f['#t'].includes(t[1]))) out(['EVENT', x[1], e]); out(['EOSE', x[1]]); }
    }
    close() {}
  }
  return { WS, store, log };
}

test('the board posts to every relay and reads back one job per proof, oldest first', async () => {
  const n = relayNet();
  let t = NOW;
  const b = makeNostrBoard({ pool: POOL, relays: ['wss://a.example', 'wss://b.example'], WS: n.WS, now: () => t });
  const p = await b.post(job(1));
  assert.deepEqual(p.relays, ['wss://a.example', 'wss://b.example']);
  t += 5000; await b.post(job(2)); await b.post(job(1));            // the same proof posted again: still one job, its first post
  const jobs = await b.read();
  assert.equal(jobs.length, 2);
  assert.equal(jobs[0].publicValues, job(1).publicValues);
  assert.equal(jobs[0].openSince, NOW);
});

test('a relay that never answers does not hold the board up', async () => {
  class Dead { constructor() {} send() {} close() {} }
  const b = makeNostrBoard({ pool: POOL, relays: ['wss://dead.example'], WS: Dead, timeoutMs: 50 });
  assert.deepEqual(await b.read(), []);
  assert.deepEqual((await b.post(job(3))).relays, []);
});

test('the API’s board and the Nostr posts as one, each proof once', () => {
  const api = [{ jobId: 'j1', publicValues: job(1).publicValues }], nostr = [{ jobId: 'nostr:x', publicValues: job(1).publicValues.toUpperCase().replace('0X', '0x') }, { jobId: 'nostr:y', publicValues: job(2).publicValues }];
  assert.deepEqual(mergeBoards(api, nostr).map((j) => j.jobId), ['j1', 'nostr:y']);
  assert.deepEqual(mergeBoards(null, nostr).map((j) => j.jobId), ['nostr:x', 'nostr:y']);
});

test('the pages that read the board let the browser reach every relay', () => {
  for (const page of ['dapp/prove/index.html', 'dapp/index.html']) {
    const csp = readFileSync(new URL('../' + page, import.meta.url), 'utf8').match(/connect-src([^;"]*)/)?.[1].split(/\s+/) || [];
    for (const r of NOSTR_RELAYS) assert.ok(csp.includes(r), `${page} lets the page reach ${r}`);
  }
});
