// A key's record in the leader's directory (the chain address a Tacit address is paid at under its key), against the leader's node: a dated
// record replaces an undated one and only a newer one replaces it, so a record the key signed before (a PQ ID's address replaced by the address
// from before it) cannot be posted again over its latest, dated or not; the order survives a restart from the directory's file; a payer checks
// the date's signature, and a client from before dated records still checks the record's undated one.
//   cargo build --release (contracts/sp1/confidential/tacit-block/node), then node tests/tacit-chain-key-record.test.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { keccak_256 } from '@noble/hashes/sha3';
import { secp } from '../dapp/vendor/tacit-deps.min.js';
import { poseidon2, poseidon3, poseidon4, poseidon5 } from '../dapp/vendor/tacit-poseidon.min.js';
import { makeChainWallet } from '../dapp/tacit-chain-wallet.js';
import { makeChainClient, keyMessage, keyMessageDated } from '../dapp/tacit-chain-client.js';
import { chainSeed, rootSeed } from '../dapp/tacit-chain-lane.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, '../contracts/sp1/confidential/tacit-block/node/target/release/tacit-block-node');
const BLOCKS = '0x00000000000000000000000000000000000b10c5';
const hx = (b) => '0x' + Buffer.from(b).toString('hex');
const bytes = (h) => Uint8Array.from(Buffer.from(h.replace(/^0x/, ''), 'hex'));
const sel = (s) => Buffer.from(keccak_256(new TextEncoder().encode(s)).slice(0, 4)).toString('hex');
const POSEIDON = { 2: poseidon2, 3: poseidon3, 4: poseidon4, 5: poseidon5 };
const w = makeChainWallet({ poseidon: (xs) => POSEIDON[xs.length](xs), prover: null, chain: '0x' + '00'.repeat(32), asset: 0n });
const addrOf = (seed) => w.encodeAddress(w.address(w.keys(seed))).slice(3);   // hex, no 0x
const PRIV = new Uint8Array(32).fill(0x11), KEY = secp.getPublicKey(PRIV, true);
const OLD = addrOf(chainSeed(PRIV)), PQ = addrOf(rootSeed(new Uint8Array(32).fill(0x77)));
const undated = async (a, priv = PRIV) => ({ address: '0x' + a, key: hx(KEY), sig: hx((await secp.signAsync(keyMessage(KEY, bytes(a)), priv)).toCompactRawBytes()) });
const dated = async (a, at, priv = PRIV) => ({ ...(await undated(a)), at, sig2: hx((await secp.signAsync(keyMessageDated(KEY, bytes(a), at), priv)).toCompactRawBytes()) });

const dir = mkdtempSync(join(tmpdir(), 'tacit-keyrec-'));
const PORT = 19700 + Math.floor(Math.random() * 90), LEADER = `http://127.0.0.1:${PORT}`;
const start = () => spawn(BIN, ['serve', '1', `${BLOCKS}@127.0.0.1:${PORT}`], { stdio: ['ignore', 'ignore', 'inherit'], env: { ...process.env, TACIT_NODE_DIRECTORY: join(dir, 'directory.txt') } });
const up = async () => { for (let i = 0; i < 60; i++) { try { await fetch(LEADER + '/state'); return; } catch { await new Promise((r) => setTimeout(r, 300)); } } throw new Error('the node did not start'); };
const api = async (method, path, body) => { const r = await fetch(LEADER + path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); return { ok: r.ok, ...(await r.json()) }; };
const post = (b) => api('POST', '/address', b);
const record = () => api('GET', `/address/key/${hx(KEY).slice(2)}`);
let n = 0;
const ok = (c, s) => { assert.ok(c, s); n++; console.log('  ok   ' + s); };

let server = start();
try {
  await up();
  // a client from before dated records: an undated record, kept and served undated
  ok((await post(await undated(OLD))).ok, 'an undated record is taken (a client from before dated records)');
  let r = await record();
  ok(r.address === '0x' + OLD && r.at === undefined && r.sig2 === undefined, 'and served undated');
  // dated records: one replaces the undated record, a newer one replaces it
  ok((await post(await dated(OLD, 1000))).ok, 'a dated record replaces an undated one');
  ok((await post(await dated(PQ, 2000))).ok, 'a newer dated record replaces it (the PQ ID\'s address)');
  r = await record();
  ok(r.address === '0x' + PQ && r.at === 2000, 'the newest record stands');
  // the replay: the records the key signed before, posted again
  const back = await post(await dated(OLD, 1000));
  ok(!back.ok && /newer record/.test(back.error), `an older dated record is refused (${back.error})`);
  const backUndated = await post(await undated(OLD));
  ok(!backUndated.ok && /newer, dated record/.test(backUndated.error), `an undated record is refused once the key has a dated one (${backUndated.error})`);
  ok((await post(await undated(PQ))).ok && (await record()).at === 2000, 'the latest address posted undated again (a client from before) changes nothing');
  ok((await post(await dated(PQ, 1500))).ok && (await record()).at === 2000, 'the same address at an older time leaves the record as it is');
  const ahead = await post(await dated(OLD, Math.floor(Date.now() / 1000) + 2 * 86400));
  ok(!ahead.ok && /time/.test(ahead.error), 'a record dated more than a day ahead is refused');
  const forged = await post({ ...(await dated(OLD, 3000)), sig2: (await dated(OLD, 3000, new Uint8Array(32).fill(0x33))).sig2 });
  ok(!forged.ok, 'a date signed by another key is refused');
  r = await record();
  ok(r.address === '0x' + PQ && r.at === 2000, 'after all of that the PQ ID\'s record stands');

  // a restart reads the directory's file in the order it was written: the same record stands
  server.kill(); await new Promise((res) => server.once('exit', res));
  server = start(); await up();
  r = await record();
  ok(r.address === '0x' + PQ && r.at === 2000, 'after a restart the newest record stands');
  ok(!(await post(await dated(OLD, 1000))).ok, 'and the old one is still refused');

  // payers: the app's client checks both signatures and pays the PQ ID; a client from before checks the undated one, which is the latest address's
  const { chain } = await api('GET', '/state');
  const rpcCall = async (m, [{ data }]) => (data.startsWith('0x' + sel('CHAIN()')) ? chain : '0x' + '00'.repeat(32));
  const payer = makeChainClient({ cfg: { blocks: BLOCKS, leader: LEADER }, rpcCall, priv: new Uint8Array(32).fill(0x22), system: () => null, storage: null });
  ok(w.encodeAddress(await payer.recipientOf({ btc: { spendPub: KEY }, chain: { hash: w.chainAddressHash(w.decodeAddress('tc1' + OLD)) } })) === 'tc1' + PQ, 'a payer reaches the PQ ID\'s address, over the lane of the address from before');
  ok(secp.verify(bytes(r.sig), keyMessage(KEY, bytes(r.address)), KEY), 'a client from before dated records checks the record\'s undated signature, for the latest address');
  console.log(`${n} ok`);
} finally {
  server.kill();
  rmSync(dir, { recursive: true, force: true });
}
