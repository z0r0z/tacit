// What waits on a leader's node outlives a restart: a shield (a real Halo2 proof) is admitted, the node stops, a new one starts from the same
// TACIT_NODE_MEMPOOL file and, asked to restore (what the leader does after its first sync), has it waiting again; one no longer good is
// refused with its reason, and nothing is restored twice.
//   cargo build --release (contracts/sp1/confidential/tacit-block/node), then node tests/tacit-chain-mempool-restart.test.mjs
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
  const r = await api('POST', '/spend', sh.submission);
  assert.ok(r.ok && r.id, r.error);
  assert.deepEqual((await api('GET', '/mempool')).spends, [r.id]);
  const saved = JSON.parse(readFileSync(FILE, 'utf8'));
  assert.equal(saved.length, 1, 'the waiting shield was written down');

  // the node stops; a new one starts from the same file and, until asked, holds nothing
  await down(node);
  node = start();
  await up();
  assert.deepEqual((await api('GET', '/mempool')).spends, [], 'nothing is admitted before the chain is replayed');
  const back = await api('POST', '/restore', {});
  assert.equal(back.restored, 1, JSON.stringify(back));
  assert.deepEqual((await api('GET', '/mempool')).spends, [r.id], 'the shield waits again, under the same id');
  assert.equal((await api('POST', '/restore', {})).restored, 0, 'nothing is restored twice');

  // an entry that is no longer good (here, one that does not parse) is refused with its reason, and the rest still come back
  await down(node);
  writeFileSync(FILE, JSON.stringify([...JSON.parse(readFileSync(FILE, 'utf8')), { kind: 'spend', body: { publics: '0x00', proof: '0x00', data: '0x00' } }]));
  node = start();
  await up();
  const mixed = await api('POST', '/restore', {});
  assert.equal(mixed.restored, 1);
  assert.equal(mixed.refused.length, 1, JSON.stringify(mixed));
  console.log(JSON.stringify({ ok: true, restored: back.restored, refused: mixed.refused }));
} finally {
  node.kill();
}
