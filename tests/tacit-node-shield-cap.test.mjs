// The chain node holds a client address to so many shields waiting on their deposits at once (TACIT_NODE_SHIELDS_PER_CLIENT), so no one address takes all
// the slots: a second shield from the address is refused, another address's is taken, and the leader's own (admin) are not counted against a client.
// Real shields (Halo2 proofs, about half a minute each), against the real node.
//   cargo build --release (contracts/sp1/confidential/tacit-block/node), then node tests/tacit-node-shield-cap.test.mjs
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { poseidon2, poseidon3, poseidon4, poseidon5 } from 'poseidon-lite';
import { makeHalo2System } from '../dapp/btc-pool-halo2-prover.js';
import { makeChainWallet, assetField } from '../dapp/tacit-chain-wallet.js';

const T = 100_000_000n;
const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = process.env.TACIT_NODE_BIN || join(HERE, '../contracts/sp1/confidential/tacit-block/node/target/release/tacit-block-node');
const D = join(HERE, '../dapp/btc-pool/');
const PORT = 19000 + Math.floor(Math.random() * 900);
const LANDER = '0x00000000000000000000000000000000000b10c5';
const TAC = '0xA1313eb9f3A445606D9583bcAc3ebeB56a858279';
const ADMIN = 'an-admin-token-nobody-here-has';
const poseidon = (xs) => ({ 2: poseidon2, 3: poseidon3, 4: poseidon4, 5: poseidon5 })[xs.length](xs);
const pin = JSON.parse(readFileSync(D + 'pin.json', 'utf8'));
const prover = makeHalo2System({ wasm: readFileSync(D + pin.wasm), params: readFileSync(D + pin.params), vk: readFileSync(D + pin.vk), pinnedVkHash: pin.vk_hash, worker: null });
const asset = assetField(Uint8Array.from([...new Array(12).fill(0), ...Buffer.from(TAC.slice(2), 'hex')]));
const base = `http://127.0.0.1:${PORT}`;
const env = { ...process.env, TACIT_NODE_ASSET: '0x' + asset.toString(16).padStart(64, '0'), TACIT_NODE_TRUST_PROXY: '1', TACIT_NODE_ADMIN: ADMIN, TACIT_NODE_SHIELDS_PER_CLIENT: '1' };
const server = spawn(BIN, ['serve', '1', `${LANDER}@127.0.0.1:${PORT}`], { stdio: ['ignore', 'ignore', 'inherit'], env });
const post = async (path, body, headers = {}) => { const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }); return { ...(await r.json()), code: r.status }; };
let n = 0; const ok = (c, m) => { assert.ok(c, m); console.log('ok  -', m); n++; };
try {
  for (let i = 0; i < 60; i++) { try { await fetch(base + '/state'); break; } catch { await new Promise((r) => setTimeout(r, 500)); } }
  const st = await (await fetch(base + '/state')).json();
  const w = makeChainWallet({ poseidon, prover, chain: st.chain, asset });
  const leader = { notes: async () => ({ leaves: [], memos: [], next: 0, total: 0 }), spent: async () => false };
  const shield = async (seed, units) => (await w.spend(w.keys(new Uint8Array(32).fill(seed)), { dep: { v: units * T, amount: units * T }, leader })).submission;
  const [s1, s2, s3, s4] = [await shield(0x31, 5n), await shield(0x32, 6n), await shield(0x33, 7n), await shield(0x34, 8n)];
  const A = { 'true-client-ip': '203.0.113.5' }, B = { 'true-client-ip': '203.0.113.6' };

  ok((await post('/spend', s1, A)).code === 200, 'a client address\'s first shield is taken');
  const second = await post('/spend', s2, A);
  ok(second.code === 400 && /as many shields waiting on their deposits as it may/.test(second.error), `its second is refused with the reason (${second.error})`);
  ok((await post('/spend', s3, B)).code === 200, 'another address\'s shield is taken');
  ok((await post('/spend', s1, A)).code === 200, 'the first one sent again is the same submission, not a new slot');
  ok((await post('/spend', s4, { authorization: `Bearer ${ADMIN}` })).code === 200, 'the leader\'s own shield is not held to it');
  const mem = await (await fetch(base + '/mempool')).json();
  ok(mem.spends.length === 3, `three shields wait (${mem.spends.length})`);
  console.log(`${n} ok`);
} finally { server.kill(); }
process.exit(0);
