#!/usr/bin/env node
// The archive's address index and GET /chain/tac/notes: the outputs of archived Tacit transactions are found by the script they pay, an archive that was
// filled before the index existed is indexed page by page, and the route lists only outputs the reflected live set still holds.
//   node tests/tac-notes-index.test.mjs
import { readFileSync } from 'node:fs';
import { sha256 } from '@noble/hashes/sha256';
import { keccak_256 } from '@noble/hashes/sha3';
import * as secp from '@noble/secp256k1';
import { bech32 } from '@scure/base';
import worker from '../worker/src/index.js';
import { makeTacArchive, parseTx } from '../worker/src/tac-archive.js';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';

let n = 0;
const ok = (c, m) => { if (c) { console.log('ok  -', m); n++; } else { console.error('FAIL -', m); process.exitCode = 1; } };
const makeKv = () => {
  const m = new Map();
  return { m,
    async get(k, t) { return m.has(k) ? (t === 'json' ? JSON.parse(m.get(k)) : m.get(k)) : null; },
    async put(k, v) { m.set(k, v); }, async delete(k) { m.delete(k); },
    async list({ prefix = '', cursor, limit = 1000 } = {}) {
      const all = [...m.keys()].filter((k) => k.startsWith(prefix)).sort();
      const from = cursor ? Number(cursor) : 0, keys = all.slice(from, from + limit).map((name) => ({ name }));
      const end = from + limit >= all.length;
      return { keys, list_complete: end, cursor: end ? undefined : String(from + limit) };
    } };
};
const dsha = (b) => sha256(sha256(b));
const hexBytes = (h) => Uint8Array.from(Buffer.from(h, 'hex'));
const FIX = JSON.parse(readFileSync(new URL('./fixtures/burndep-listing-purchase-2026-10-16.json', import.meta.url), 'utf8'));
const id = (p) => Object.keys(FIX).find((k) => k.startsWith(p));
const PURCHASE = id('c654294c'), SPLIT = id('57829e14');
const heightOf = (t) => JSON.parse(FIX[t].json).status.block_height;
const isTacit = (w) => !!(w && w.length >= 3);
const outsOf = (t) => parseTx(hexBytes(FIX[t].hex), dsha).outs;

{
  const a = makeTacArchive({ kv: makeKv(), network: 'mainnet', dsha256: dsha, isTacit });
  await a.keep(FIX[PURCHASE].hex, heightOf(PURCHASE));
  const outs = outsOf(PURCHASE);
  const o = outs.findIndex((x) => x.s.length === 44 && x.s.startsWith('0014'));
  ok(o >= 0, 'the fixture pays a P2WPKH output');
  const got = await a.notesAt(outs[o].s);
  ok(got.some((x) => x.txid === PURCHASE && x.vout === o && x.value === outs[o].v && x.h === heightOf(PURCHASE)), 'a kept transaction is found by the script of its output, with value and height');
  ok((await a.notesAt('0014' + '00'.repeat(20))).length === 0, 'a script nothing was archived for has no notes');
  ok(!(await a.notesAt('')).length, 'an empty script has none');
}
{
  // an archive filled before the index existed
  const kv = makeKv();
  const rec = { hex: FIX[SPLIT].hex, h: heightOf(SPLIT) };
  kv.m.set(`tacarch:mainnet:${SPLIT}`, JSON.stringify(rec));
  const a = makeTacArchive({ kv, network: 'mainnet', dsha256: dsha, isTacit });
  const outs = outsOf(SPLIT), o = outs.findIndex((x) => x.s.length === 44 && x.s.startsWith('0014'));
  ok((await a.notesAt(outs[o].s)).length === 0, 'an old record is not indexed yet');
  const r1 = await a.indexPage({ limit: 10 });
  ok(r1.done && r1.indexed > 0 && (await a.notesAt(outs[o].s)).some((x) => x.txid === SPLIT), 'a page of the archive is indexed and the note is then found');
  ok((await a.indexPage({ limit: 10 })).done, 'a finished index says so and does no more work');
}
{
  // the route: only a live output is listed
  const kv = makeKv();
  const a = makeTacArchive({ kv, network: 'mainnet', dsha256: dsha, isTacit });
  await a.keep(FIX[PURCHASE].hex, heightOf(PURCHASE));
  const outs = outsOf(PURCHASE);
  const pays = outs.map((x, i) => ({ ...x, i })).filter((x) => x.s.length === 44 && x.s.startsWith('0014'));
  const pool = makeConfidentialPool({ secp, keccak256: keccak_256, sha256 });
  const liveOne = pays[0];
  const addrOf = (s) => bech32.encode('bc', [0, ...bech32.toWords(hexBytes(s.slice(4)))]);
  kv.m.set('reflection:scan:mainnet', JSON.stringify({ snapshot: { height: 977000, liveTriples: [[pool.outpointKey('0x' + PURCHASE.match(/../g).reverse().join(''), liveOne.i)  /* internal byte order, as the reflection records it (checked against the live mainnet set) */, '0x00', '0x00', '0x00', 0]] } }));
  const env = { REGISTRY_KV: kv };
  const ask = (addr) => worker.fetch(new Request(`https://api.test/chain/tac/notes?network=mainnet&address=${addr}`), env, { waitUntil() {} });
  const r = await ask(addrOf(liveOne.s));
  const j = await r.json();
  ok(r.status === 200 && j.height === 977000 && j.notes.length === 1 && j.notes[0].txid === PURCHASE && j.notes[0].vout === liveOne.i, 'the live output is listed with its txid, vout, value and height');
  if (pays.length > 1 && pays[1].s !== liveOne.s) {
    const j2 = await (await ask(addrOf(pays[1].s))).json();
    ok(j2.notes.length === 0, 'an output the live set does not hold is not listed');
  }
  ok((await ask('notanaddress')).status === 400, 'a malformed address is refused');
  ok((await ask('tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx')).status === 400, 'an address of another network is refused');
}
console.log(`${n} checks`);
