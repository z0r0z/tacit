// The wallet's TAC onto the tacit chain in one step, as the tile does it, against the leader's node with a real Halo2 proof: the leader's sweep fee
// read from GET /fee (and by anyone, with no key, from chainStatus), the shield proved, kept and handed to the leader with a holder's permit for its
// inbox (what the leader sends in with sweepWithPermit) or with only its way back (paid by a transfer), the permit kept with it so a client made again
// from the same storage hands it over again, and the spend landing from that. Also the bytes sweepWithPermit takes.
//   cargo build --release (contracts/sp1/confidential/tacit-block/node), then node tests/tacit-chain-shield-ways.test.mjs
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { keccak_256 } from '@noble/hashes/sha3';
import { makeHalo2System } from '../dapp/btc-pool-halo2-prover.js';
import { assetField, sharesFor } from '../dapp/tacit-chain-wallet.js';
import { makeChainClient, chainStatus, leaderTerms, UNIT } from '../dapp/tacit-chain-client.js';

const T = 100_000_000n;
const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, '../contracts/sp1/confidential/tacit-block/node/target/release/tacit-block-node');
const D = join(HERE, '../dapp/btc-pool/');
const PORT = 19800 + Math.floor(Math.random() * 90);
const LEADER = `http://127.0.0.1:${PORT}`;
const BLOCKS = '0x00000000000000000000000000000000000b10c5';
const TAC = '0xA1313eb9f3A445606D9583bcAc3ebeB56a858279';
const hx = (b) => '0x' + Buffer.from(b).toString('hex');
const bytes = (h) => Uint8Array.from(Buffer.from(h.replace(/^0x/, ''), 'hex'));
const sel = (s) => Buffer.from(keccak_256(new TextEncoder().encode(s)).slice(0, 4)).toString('hex');
const word = (v) => '0x' + BigInt(v).toString(16).padStart(64, '0');

const pin = JSON.parse(readFileSync(D + 'pin.json', 'utf8'));
const system = () => makeHalo2System({ wasm: readFileSync(D + pin.wasm), params: readFileSync(D + pin.params), vk: readFileSync(D + pin.vk), pinnedVkHash: pin.vk_hash, worker: null });
const asset = assetField(Uint8Array.from([...new Array(12).fill(0), ...bytes(TAC)]));
const assetHex = '0x' + asset.toString(16).padStart(64, '0');
const server = spawn(BIN, ['serve', '1', `${BLOCKS}@127.0.0.1:${PORT}`], { stdio: ['ignore', 'ignore', 'inherit'], env: { ...process.env, TACIT_NODE_ASSET: assetHex } });
const api = async (method, path, body) => { const r = await fetch(LEADER + path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); return { ok: r.ok, ...(await r.json()) }; };
async function landBlock() {
  for (let i = 0; i < 100 && !(await api('GET', '/mempool')).spends.length; i++) await new Promise((r) => setTimeout(r, 300));
  const b = await api('POST', '/build', { time: Math.floor(Date.now() / 1000), queue: [] });
  assert.ok(b.ok, b.error);
  const pv = bytes(b.publicValues);
  const words = Array.from({ length: pv.length / 32 }, (_, i) => hx(pv.subarray(32 * i, 32 * i + 32)));
  const leaves = b.lists.leaves.length > 2 ? b.lists.leaves.slice(2).match(/.{64}/g).map((x) => '0x' + x) : [];
  const memos = b.lists.memos.length > 2 ? b.lists.memos.slice(2).match(/.{2304}/g).map((x) => '0x' + x) : [];
  assert.ok((await api('POST', '/landed', { words, leaves, memos, nullifiers: b.lists.nullifiers })).ok);
  return b;
}
const store = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k), m }; };

try {
  for (let i = 0; i < 60; i++) { try { await fetch(LEADER + '/state'); break; } catch { await new Promise((r) => setTimeout(r, 500)); } }
  const { chain } = await api('GET', '/state');
  const rpcCall = async (m, [{ data }]) => {
    const st = await api('GET', '/state');
    if (data.startsWith('0x' + sel('CHAIN()'))) return chain;
    if (data.startsWith('0x' + sel('TAC_ASSET()'))) return assetHex;
    if (data.startsWith('0x' + sel('pool()'))) return word(st.pool);
    if (data.startsWith('0x' + sel('shares()'))) return word(st.shares);
    if (data.startsWith('0x' + sel('height()'))) return word(st.height);
    if (data.startsWith('0x' + sel('lastLanded()'))) return word(1_700_000_000);
    throw new Error('unexpected call');
  };
  const cfg = { blocks: BLOCKS, leader: LEADER };

  // the leader's terms, its sweep fee in TAC's own wei (18 decimals)
  const SWEEP = 123_450_000_000_000_000n;
  assert.ok((await api('POST', '/fee', { fee: '0', shieldCap: '0', sweepFee: String(SWEEP) })).ok);
  assert.deepEqual(leaderTerms({ fee: '7', shieldCap: '0', sweepFee: 'x' }), { fee: 7n, shieldCap: null, sweepFee: 0n }, 'terms read plainly; a bad figure is none');
  const seen = await chainStatus({ cfg, rpcCall });
  assert.deepEqual(seen.leader, { fee: 0n, shieldCap: null, sweepFee: SWEEP }, 'anyone reads the leader\'s terms with no key');
  assert.equal(seen.lastLanded, 1_700_000_000);
  const off = await chainStatus({ cfg: { ...cfg, leader: 'http://127.0.0.1:9' }, rpcCall });
  assert.equal(off.leader, null, 'a leader that does not answer is none, and the contract is still read');

  const aliceStore = store();
  const alice = makeChainClient({ cfg, rpcCall, priv: new Uint8Array(32).fill(0x31), system, storage: aliceStore });
  assert.equal((await alice.fee()).sweepFee, SWEEP);
  assert.equal((await alice.quote('shield', 10n * T)).sweepFee, SWEEP, 'a shield\'s quote names the sweep fee');

  // the wallet's 10 TAC, signed once: the permit's value is the deposit and the leader's fee
  const sh = await alice.shield(10n * T);
  assert.equal(sh.sweepFee, SWEEP);
  assert.equal(sh.permitValue(), 10n * T * UNIT + SWEEP);
  assert.equal(sh.permitValue(0n), 10n * T * UNIT);
  const back = '0x' + '6b'.repeat(32), owner = '0x90f79bf6eb2c4f870365e785982e1f101e93b906';
  const permit = { owner, fee: String(SWEEP), deadline: '1900000000', v: 27, r: '0x' + '11'.repeat(32), s: '0x' + '22'.repeat(32), back };
  const until = Date.now() + 3600e3;
  const { id, kept } = await sh.offer({ back, permit, meta: { inbox: '0x' + 'ab'.repeat(20), src: 'wallet', pay: { until } } });
  assert.deepEqual(kept.extra, { back, permit }, 'the permit and the way back are kept with the spend');
  assert.equal(kept.src, 'wallet');
  assert.equal(kept.pay.until, until);
  const held = (await api('POST', '/pending', {})).spends.find((x) => x.id === id);
  assert.ok(held, 'the leader holds it before anything is paid');
  assert.deepEqual(held.permit, permit, 'with the permit it sends in');
  assert.ok(held.backs.includes(back), 'and the way back');

  // a reload: a client made again from the same storage finds it waiting and hands it over again, permit and all; it lands
  const again = makeChainClient({ cfg, rpcCall, priv: new Uint8Array(32).fill(0x31), system, storage: aliceStore });
  const waiting = await again.pending();
  assert.equal(waiting.length, 1);
  assert.deepEqual(waiting[0].extra.permit, permit);
  await Promise.all([again.resubmit(waiting[0]), landBlock()]);
  assert.equal((await again.pending()).length, 0, 'landed, it is no longer kept');
  assert.equal(await again.scan(), sh.deposit.shares - 0n, 'the shield\'s shares are the wallet\'s');
  assert.equal(sh.deposit.shares, sharesFor(10n * T, { pool: 0n, shares: 0n }));

  // the other way: a transfer to the inbox pays it, and only the way back goes with the spend
  const sh2 = await again.shield(5n * T);
  const o2 = await sh2.offer({ back: '0x' + '7c'.repeat(32), meta: { inbox: '0x' + 'cd'.repeat(20), src: 'wallet', pay: { until } } });
  assert.deepEqual(o2.kept.extra, { back: '0x' + '7c'.repeat(32) }, 'no permit with a transfer');
  const held2 = (await api('POST', '/pending', {})).spends.find((x) => x.id === o2.id);
  assert.ok(held2 && held2.permit == null && held2.backs.includes('0x' + '7c'.repeat(32)));

  // TacitBlocks.sweepWithPermit's bytes: the deposit's words, the way back, the owner, the fee, the deadline and the signature, in that order
  const cd = again.sweepWithPermitCalldata(sh.deposit, permit), w = (i) => cd.slice(10 + 64 * i, 74 + 64 * i);
  assert.equal(cd.slice(0, 10), '0x' + sel('sweepWithPermit(uint256,uint256,bytes32,bytes32,bytes32,bytes32,address,uint256,uint256,uint8,bytes32,bytes32)'));
  assert.equal((cd.length - 10) / 64, 12);
  assert.equal(BigInt('0x' + w(0)), sh.deposit.shares);
  assert.equal(BigInt('0x' + w(1)), 10n * T);
  assert.equal('0x' + w(2), sh.deposit.cx.toLowerCase());
  assert.equal('0x' + w(4), sh.deposit.body.toLowerCase());
  assert.equal('0x' + w(5), back);
  assert.equal('0x' + w(6).slice(24), owner);
  assert.equal(BigInt('0x' + w(7)), SWEEP);
  assert.equal(BigInt('0x' + w(8)), 1_900_000_000n);
  assert.equal(BigInt('0x' + w(9)), 27n);
  assert.equal('0x' + w(10), permit.r);
  assert.equal('0x' + w(11), permit.s);
  console.log(JSON.stringify({ ok: true, shares: String(sh.deposit.shares), sweepFee: String(SWEEP) }));
} finally {
  server.kill();
}
