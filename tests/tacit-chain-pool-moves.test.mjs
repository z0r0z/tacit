// The client's two moves with the confidential pool (V1), with real Halo2 proofs against the leader's node:
//  * private TAC onto the chain: a shield for exactly what the pool's unwrap pays (units less the relay's fee), its way back a V1 wrap commitment
//    of the key's for that amount, kept here and handed to the leader before anything is paid (its way back with it, as the leader sweeps by),
//    found again by a client made from the same storage, re-proved for a new amount when the fee moves (the first one forgotten), then taken in
//    once its inbox holds the deposit;
//  * chain TAC into the pool: a hop of exactly the amount to a V1 wrap commitment for that amount, the item the block publishes being the pool's
//    deposit for that commitment; kept until it is sent on (hopsWaiting), and the calldata that sends it.
//   cargo build --release (contracts/sp1/confidential/tacit-block/node), then node tests/tacit-chain-pool-moves.test.mjs
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as secp from '@noble/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import { sha256 } from '@noble/hashes/sha256';
import { makeHalo2System } from '../dapp/btc-pool-halo2-prover.js';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import { assetField, sharesFor, sharesToPay } from '../dapp/tacit-chain-wallet.js';
import { makeChainClient, UNIT } from '../dapp/tacit-chain-client.js';

const T = 100_000_000n; // 1 TAC in units
const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = process.env.CHAIN_NODE_BIN || join(HERE, '../contracts/sp1/confidential/tacit-block/node/target/release/tacit-block-node');
const D = join(HERE, '../dapp/btc-pool/');
const PORT = 19700 + Math.floor(Math.random() * 90);
const LEADER = `http://127.0.0.1:${PORT}`;
const BLOCKS = '0x00000000000000000000000000000000000b10c5';
const TAC = '0xA1313eb9f3A445606D9583bcAc3ebeB56a858279';
const CTAC = '0xf0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b';      // V1's TAC asset (TacitBlocks.CONFIDENTIAL_TAC)
const hx = (b) => '0x' + Buffer.from(b).toString('hex');
const bytes = (h) => Uint8Array.from(Buffer.from(h.replace(/^0x/, ''), 'hex'));
const sel = (s) => Buffer.from(keccak_256(new TextEncoder().encode(s)).slice(0, 4)).toString('hex');
const word = (v) => BigInt(v).toString(16).padStart(64, '0');
const strip = (h) => String(h).replace(/^0x/, '').toLowerCase();

const pin = JSON.parse(readFileSync(D + 'pin.json', 'utf8'));
const system = () => makeHalo2System({ wasm: readFileSync(D + pin.wasm), params: readFileSync(D + pin.params), vk: readFileSync(D + pin.vk), pinnedVkHash: pin.vk_hash, worker: null });
const asset = assetField(Uint8Array.from([...new Array(12).fill(0), ...bytes(TAC)]));
const assetHex = '0x' + asset.toString(16).padStart(64, '0');
const server = spawn(BIN, ['serve', '1', `${BLOCKS}@127.0.0.1:${PORT}`], { stdio: ['ignore', 'ignore', 'inherit'], env: { ...process.env, TACIT_NODE_ASSET: assetHex } });
const api = async (method, path, body) => { const r = await fetch(LEADER + path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); return { ok: r.ok, ...(await r.json()) }; };
// what the leader does between building a block and seeing it land; spends whose deposit has not come are left out, as the leader leaves them
async function landBlock(exclude = []) {
  for (let i = 0; i < 100 && !(await api('GET', '/mempool')).spends.some((id) => !exclude.includes(id)); i++) await new Promise((r) => setTimeout(r, 300));
  const b = await api('POST', '/build', { time: Math.floor(Date.now() / 1000), queue: [], exclude });
  assert.ok(b.ok, b.error);
  const pv = bytes(b.publicValues);
  const words = Array.from({ length: pv.length / 32 }, (_, i) => hx(pv.subarray(32 * i, 32 * i + 32)));
  const leaves = b.lists.leaves.length > 2 ? b.lists.leaves.slice(2).match(/.{64}/g).map((x) => '0x' + x) : [];
  const memos = b.lists.memos.length > 2 ? b.lists.memos.slice(2).match(/.{2304}/g).map((x) => '0x' + x) : [];
  assert.ok((await api('POST', '/landed', { words, leaves, memos, nullifiers: b.lists.nullifiers })).ok);
  return b;
}
const store = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k), m }; };

// V1's side, as the app's confidential-pool-ux makes it (buildWrap): the key's wrap note at an index, its commitment for a value, and the deposit
// id the pool records when wrap(asset, value * unitScale, commit) is called for it
const pool = makeConfidentialPool({ secp, keccak256: keccak_256, sha256 });
function v1Wrap(priv, index, value) {
  const { secret, blinding } = pool.deriveNote(priv, CTAC, index);
  const owner = pool.nkToOwner(secret), { cx, cy } = pool.commitXY(BigInt(value), '0x' + BigInt(blinding).toString(16).padStart(64, '0'));
  return { commit: pool.depositCommit(cx, cy, owner), depositId: pool.depositId(CTAC, BigInt(value), cx, cy, owner) };
}

try {
  for (let i = 0; i < 60; i++) { try { await fetch(LEADER + '/state'); break; } catch { await new Promise((r) => setTimeout(r, 500)); } }
  const { chain } = await api('GET', '/state');
  // Ethereum as the client reads it: the landing contract (its binding, asset, pool and shares, its inbox addresses, the hops it holds) and TAC
  const TAC_ADDR = '0x' + 'ac'.repeat(20), inboxes = [], tacHeld = new Map(), swept = new Set(), hopsHeld = new Map();
  const rpcCall = async (m, ps) => {
    if (m === 'eth_getCode') return swept.has(ps[0].toLowerCase()) ? '0xfe' : '0x';
    const { to, data } = ps[0];
    if (to.toLowerCase() === TAC_ADDR && data.startsWith('0x70a08231')) return '0x' + word(tacHeld.get('0x' + data.slice(-40)) ?? 0n);
    assert.equal(to, BLOCKS);
    if (data.startsWith('0x' + sel('CHAIN()'))) return chain;
    if (data.startsWith('0x' + sel('TAC_ASSET()'))) return assetHex;
    if (data.startsWith('0x' + sel('TAC()'))) return '0x' + TAC_ADDR.slice(2).padStart(64, '0');
    if (data.startsWith('0x' + sel('pool()'))) return '0x' + word((await api('GET', '/state')).pool);
    if (data.startsWith('0x' + sel('shares()'))) return '0x' + word((await api('GET', '/state')).shares);
    if (data.startsWith('0x' + sel('inbox(uint256,uint256,bytes32,bytes32,bytes32,bytes32)'))) {
      // a CREATE2 address of every argument, the way back among them
      inboxes.push(data.slice(10));
      return '0x' + word(BigInt(hx(keccak_256(bytes(data.slice(10))).slice(12))));
    }
    if (data.startsWith('0x' + sel('hops(bytes32)'))) return '0x' + word(hopsHeld.get(data.slice(10)) ?? 0n);
    throw new Error('unexpected call ' + data.slice(0, 10));
  };
  const cfg = { blocks: BLOCKS, leader: LEADER };
  const PRIV = new Uint8Array(32).fill(0x33), aliceStore = store();
  const alice = makeChainClient({ cfg, rpcCall, priv: PRIV, system, storage: aliceStore });
  await alice.ready();

  // the leader's launch cap on a shield (GET /fee shieldCap): published, quoted, and a shield over it refused before anything is proved
  assert.ok((await api('POST', '/fee', { fee: '0', shieldCap: String(500n * T) })).ok);
  assert.equal(await alice.shieldCap(), 500n * T);
  assert.equal((await alice.quote('shield', 600n * T)).cap, 500n * T);
  await assert.rejects(alice.shield(600n * T), (e) => e.overCap && /^For now the Tacit chain takes up to 500 TAC a shield\.$/.test(e.message));
  assert.ok((await api('POST', '/fee', { fee: '0', shieldCap: '0' })).ok);
  assert.equal(await alice.shieldCap(), null, '"0" is no cap');

  // ── private TAC onto the chain. 1,000 TAC leaves the pool; the relay's unwrap fee (fixed before anything is proved) is 2 TAC, so the
  // unwrap pays the inbox exactly 998 TAC and the shield deposits exactly that
  const units = 1000n * T;
  let fee = 2n * T, amount = units - fee;
  const s1 = await alice.shield(amount);
  assert.equal(s1.deposit.amount, amount, 'the shield deposits exactly what the unwrap pays');
  assert.equal(s1.deposit.shares, sharesFor(amount, { pool: 0n, shares: 0n }), 'and buys its shares at the rate, the margin left');
  const back1 = v1Wrap(PRIV, 0, amount).commit, inbox1 = await s1.inbox(back1);
  assert.ok(inboxes.at(-1).endsWith(strip(back1)) && inboxes.at(-1).startsWith(word(s1.deposit.shares) + word(amount)), 'the inbox is the shield\'s deposit\'s, with its way back');
  const o1 = await s1.offer({ back: back1, meta: { inbox: inbox1, pay: { units: String(units), fee: String(fee), index: 0, until: Date.now() + 80 * 60e3 } } });
  assert.ok((await api('GET', '/mempool')).spends.includes(o1.id), 'handed to the leader before anything is paid');
  assert.deepEqual((await api('POST', '/pending', {})).spends.find((x) => x.id === o1.id)?.backs, [back1], 'with its way back, which the leader sweeps by');
  assert.deepEqual(await alice.inboxState(inbox1), { held: 0n, swept: false }, 'the inbox is not paid yet');

  // the relay refused that fee (gas moved): read again (3 TAC now), the shield is proved again for the new amount and the first one forgotten
  await alice.forget(o1.id);
  await api('POST', '/drop', { ids: [o1.id] });
  fee = 3n * T; amount = units - fee;
  const s = await alice.shield(amount);
  assert.equal(s.deposit.amount, amount);
  const back = v1Wrap(PRIV, 0, amount).commit, inbox = await s.inbox(back);
  assert.notEqual(inbox, inbox1, 'a new amount is a new inbox, with its own way back');
  const o = await s.offer({ back, meta: { inbox, pay: { units: String(units), fee: String(fee), index: 0, until: Date.now() + 80 * 60e3 } } });

  // a reload: a client made from the same storage finds the move, what pays it and its way back
  const again = makeChainClient({ cfg, rpcCall, priv: PRIV, system, storage: aliceStore });
  const kept = await again.pending();
  assert.equal(kept.length, 1, 'only the move still on, the one forgotten gone');
  assert.equal(kept[0].id, o.id);
  assert.equal(kept[0].inbox, inbox); assert.equal(kept[0].back, back); assert.equal(kept[0].extra.back, back);
  assert.equal(kept[0].deposit.amount, String(amount)); assert.equal(kept[0].pay.fee, String(fee));

  // the pool's unwrap pays the inbox exactly the deposit; the leader sweeps it (its code is left there) and the spend is taken in
  tacHeld.set(inbox.toLowerCase(), amount * UNIT);
  assert.deepEqual(await alice.inboxState(inbox), { held: amount * UNIT, swept: false }, 'paid, to the unit');
  swept.add(inbox.toLowerCase()); tacHeld.set(inbox.toLowerCase(), 0n);
  assert.equal((await alice.inboxState(inbox)).swept, true);
  assert.equal(alice.sweepCalldata(s.deposit, back), '0x' + sel('sweep(uint256,uint256,bytes32,bytes32,bytes32,bytes32)') + word(s.deposit.shares) + word(amount) + strip(s.deposit.cx) + strip(s.deposit.cy) + strip(s.deposit.body) + strip(back));
  await Promise.all([again.resubmit(kept[0]), landBlock()]);
  assert.equal((await again.pending()).length, 0, 'landed: nothing kept');
  assert.equal(await alice.scan(), s.deposit.shares, 'the move\'s shares are the key\'s on the chain');

  // ── chain TAC into the pool: exactly 100 TAC to the key's V1 wrap commitment for 100 TAC (its next index)
  const hopUnits = 100n * T, r = await alice.rate(), w = v1Wrap(PRIV, 1, hopUnits);
  const b = (await Promise.all([alice.hop(w.commit, hopUnits), landBlock()]))[1];
  const item = b.lists.hops.slice(2);
  assert.equal(item.length, 192, 'one hop');
  assert.equal(BigInt('0x' + item.slice(64, 128)), hopUnits, 'exactly the amount, as the pool\'s deposit for the commitment needs');
  assert.equal('0x' + item.slice(128), w.commit.toLowerCase(), 'for the commitment made as a wrap\'s');
  // the deposit TacitBlocks.sendHop makes: wrap(V1 TAC, 100 TAC, commit), whose id is the one the key's wrap note at that index opens
  assert.equal(pool.depositId(CTAC, hopUnits, ...(() => { const { secret, blinding } = pool.deriveNote(PRIV, CTAC, 1); const { cx, cy } = pool.commitXY(hopUnits, '0x' + BigInt(blinding).toString(16).padStart(64, '0')); return [cx, cy, pool.nkToOwner(secret)]; })()), w.depositId);
  assert.equal(await alice.scan(), s.deposit.shares - sharesToPay(hopUnits, r), 'the hop spent its shares, the exit fee on top');
  // kept until the landing contract no longer holds it unsent
  const key = hx(keccak_256(bytes(word(hopUnits) + strip(w.commit)))).slice(2);
  hopsHeld.set(key, 1n);
  assert.deepEqual((await alice.hopsWaiting()).map((h) => [h.units, h.commit]), [[String(hopUnits), w.commit.toLowerCase()]], 'landed, not sent on: kept');
  assert.equal(alice.sendHopCalldata(hopUnits, w.commit), '0x' + sel('sendHop(uint256,bytes32)') + word(hopUnits) + strip(w.commit));
  hopsHeld.set(key, 0n);
  assert.deepEqual(await alice.hopsWaiting(), [], 'sent on: dropped');
  console.log(JSON.stringify({ ok: true, moved: String(amount), shares: String(s.deposit.shares), hop: String(hopUnits) }));
} finally {
  server.kill();
}
