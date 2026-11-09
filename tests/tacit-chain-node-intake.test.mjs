// What a leader's node takes in from the public: a permit that does not read is refused (it must not reach the leader, which hands its fields to the
// chain as they are), only a submission's own fields are kept and written down (a body can be 4 MB of anything), the permit is kept in one form, and
// a mempool read at start is not written over before it is restored.
//   cargo build --release (contracts/sp1/confidential/tacit-block/node), then node tests/tacit-chain-node-intake.test.mjs
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { keccak_256 } from '@noble/hashes/sha3';
import { makeHalo2System } from '../dapp/btc-pool-halo2-prover.js';
import { assetField } from '../dapp/tacit-chain-wallet.js';
import { makeChainClient } from '../dapp/tacit-chain-client.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, '../contracts/sp1/confidential/tacit-block/node/target/release/tacit-block-node');
const D = join(HERE, '../dapp/btc-pool/');
const PORT = 19800 + Math.floor(Math.random() * 90);
const LEADER = `http://127.0.0.1:${PORT}`;
const BLOCKS = '0x00000000000000000000000000000000000b10c5';
const TAC = '0xA1313eb9f3A445606D9583bcAc3ebeB56a858279';
const T = 100_000_000n;
const bytes = (h) => Uint8Array.from(Buffer.from(h.replace(/^0x/, ''), 'hex'));
const sel = (s) => Buffer.from(keccak_256(new TextEncoder().encode(s)).slice(0, 4)).toString('hex');
const pin = JSON.parse(readFileSync(D + 'pin.json', 'utf8'));
const system = () => makeHalo2System({ wasm: readFileSync(D + pin.wasm), params: readFileSync(D + pin.params), vk: readFileSync(D + pin.vk), pinnedVkHash: pin.vk_hash, worker: null });
const asset = assetField(Uint8Array.from([...new Array(12).fill(0), ...bytes(TAC)]));
const assetHex = '0x' + asset.toString(16).padStart(64, '0');
const FILE = join(mkdtempSync(join(tmpdir(), 'tacit-mempool-')), 'mempool.json');
const start = () => spawn(BIN, ['serve', '1', `${BLOCKS}@127.0.0.1:${PORT}`], { stdio: ['ignore', 'ignore', 'inherit'], env: { ...process.env, TACIT_NODE_ASSET: assetHex, TACIT_NODE_MEMPOOL: FILE } });
const api = async (method, path, body) => { const r = await fetch(LEADER + path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); return { ok: r.ok, ...(await r.json()) }; };
const up = async () => { for (let i = 0; i < 60; i++) { try { await fetch(LEADER + '/state'); return; } catch { await new Promise((r) => setTimeout(r, 300)); } } throw new Error('the node did not start'); };
const down = (p) => new Promise((r) => { p.once('exit', r); p.kill(); });
const store = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v) }; };

let node = start();
try {
  await up();
  const { chain } = await api('GET', '/state');
  const word = (v) => '0x' + BigInt(v).toString(16).padStart(64, '0');
  const rpcCall = async (m, [{ data }]) => {
    if (data.startsWith('0x' + sel('CHAIN()'))) return chain;
    if (data.startsWith('0x' + sel('TAC_ASSET()'))) return assetHex;
    if (data.startsWith('0x' + sel('pool()'))) return word((await api('GET', '/state')).pool);
    if (data.startsWith('0x' + sel('shares()'))) return word((await api('GET', '/state')).shares);
    throw new Error('unexpected call');
  };
  const alice = makeChainClient({ cfg: { blocks: BLOCKS, leader: LEADER }, rpcCall, priv: new Uint8Array(32).fill(0x11), system, storage: store() });
  const sh = await alice.shield(10n * T);
  const back = '0x' + 'ab'.repeat(32);
  const good = { owner: '0x' + '12'.repeat(20), fee: '123450000000000000', deadline: '1900000000', v: 27, r: '0x' + '11'.repeat(32), s: '0x' + '22'.repeat(32), back };

  // a permit that does not read is refused, and nothing waits
  for (const [what, permit] of [['a way back that is not hex', { ...good, back: 'zz' }], ['a fee that is not digits', { ...good, fee: '1e30' }], ['a v over a byte', { ...good, v: 300 }],
    ['a short r', { ...good, r: '0x11' }], ['no owner', { ...good, owner: undefined }], ['a string', 'permit'], ['a fee of 40 digits', { ...good, fee: '9'.repeat(40) }]]) {
    const r = await api('POST', '/spend', { ...sh.submission, back, permit });
    assert.ok(!r.ok && /permit does not read/.test(r.error || ''), `${what}: ${JSON.stringify(r)}`);
  }
  assert.deepEqual((await api('GET', '/mempool')).spends, [], 'none of them waits');

  // a good one, in another form (capitals, a fee as a number, extra fields), is taken, kept in one form, with 3 MB of other fields not kept
  const loud = { ...good, owner: good.owner.toUpperCase().replace('0X', '0x'), fee: 123450000000000000n.toString(), v: '27', extra: 'x', r: good.r.toUpperCase().replace('0X', '0x') };
  const r = await api('POST', '/spend', { ...sh.submission, back, permit: loud, junk: 'x'.repeat(3_000_000) });
  assert.ok(r.ok && r.id, JSON.stringify(r));
  const held = (await api('POST', '/pending', {})).spends.find((x) => x.id === r.id);
  assert.deepEqual(held.permit, { ...good, fee: '123450000000000000' }, 'the permit is kept in one form, with only its own fields');
  const saved = JSON.parse(readFileSync(FILE, 'utf8'));
  assert.equal(saved.length, 1);
  assert.deepEqual(Object.keys(saved[0].body).sort(), ['back', 'data', 'memos', 'opMemos', 'permit', 'proof', 'publics'], 'only the submission\'s own fields are written down');
  assert.ok(readFileSync(FILE).length < 400_000, `the file is small (${readFileSync(FILE).length} bytes), not 3 MB`);
  assert.deepEqual((await api('GET', '/pending-notes')).leaves, [], 'a shield is no one\'s incoming payment');

  // a node that starts with a mempool does not write over it before it is restored
  await down(node);
  node = start();
  await up();
  await api('POST', '/drop', { ids: [] });
  assert.equal(JSON.parse(readFileSync(FILE, 'utf8')).length, 1, 'what waited is still on disk before it is restored');
  assert.equal((await api('POST', '/restore', {})).restored, 1);
  assert.deepEqual((await api('GET', '/mempool')).spends, [r.id]);
  console.log(JSON.stringify({ ok: true }));
} finally { node.kill(); }
process.exit(0);
