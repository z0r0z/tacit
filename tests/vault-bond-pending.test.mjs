// The bond a person posts from the cBTC page (dapp/vault/mine.js bond): while an earlier bond for the same lock is pending in the Activity journal it is not sent again, and
// a speed-up in the wallet that landed after the wait gave up is told apart from one that is still on its way, so the person is not held for half an hour by a bond that is in.
// The real source is cut out of the module and run here with the real wallet module over a fake chain, and a real journal.
//   node --test tests/vault-bond-pending.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chain } from './fake-eth-chain.mjs';

const ET = new EventTarget();
globalThis.addEventListener = ET.addEventListener.bind(ET); globalThis.removeEventListener = ET.removeEventListener.bind(ET); globalThis.dispatchEvent = ET.dispatchEvent.bind(ET);
const mem = new Map(); globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
const { makeWallet } = await import('../dapp/trade/wallet.js');
const { makeJournal } = await import('../dapp/activity.js');                // (loaded here, so the wallet's own load of it is instant)

const text = readFileSync(new URL('../dapp/vault/mine.js', import.meta.url), 'utf8');
const a = text.indexOf('  const replacedPut = '), b = text.indexOf("  // An unminted lock's bond, taken back");
assert.ok(a > 0 && b > a, 'bond is where this test expects it');
const source = `${text.slice(a, b)}\nreturn { bond };`;

const me = '0x' + 'aa'.repeat(20), engine = '0x' + 'bb'.repeat(20), op = 'cd'.repeat(32);
const call = { to: engine, value: 3, input: '0xabcdef01' + '00'.repeat(64) };
const orig = { hash: '0x' + '01'.repeat(32), from: me, nonce: 0, ...call }, fast = { hash: '0x' + '02'.repeat(32), from: me, nonce: 0, ...call }, cancel = { hash: '0x' + '03'.repeat(32), from: me, nonce: 0, to: me, value: 0, input: '0x' };

// A lock with a bond sent a minute ago that is still pending in the journal (what the wait learned of it kept in the entry when it has been given up on).
async function world({ trace = true } = {}) {
  const c = chain(); c.send(orig);
  const real = makeWallet({ rpc: c.read }), o = { read: c.read, probeMs: 5, every: 5, timeoutMs: 1200 };
  const seen = (await real.receipt(orig.hash, o).catch((e) => e)).seen;
  mem.clear();                                                              // (the journal lives in localStorage, written a moment after a put: each test starts with none)
  const J = makeJournal({});
  J.put(`tx:1:${orig.hash}`, { kind: 'tx', label: 'Post the bond', chain: 1, hash: orig.hash, op, status: 'pending', seen });
  const said = [], SIZING = new Error('sizing reached');
  const wallet = { receipt: (h, x) => real.receipt(h, { ...o, ...x, timeoutMs: 100 }), ...(trace ? { trace: (h, s) => real.trace(h, s, { read: c.read }) } : {}) };
  const t = { ethCall: async () => { throw SIZING; } };
  const { bond } = new Function('D', 'wallet', 'W', 'getUx', 'outpointOf', 'run', 'say', 'word', 'ENGINE', 'SEL', 'wordAt', 'bondGap', 'WSTETH', 'ethTxt', 'btcTxt', 'connect', 'bondCall', 'bondShareCall', 'bondBackCall', source)(
    { locks: [{ lockTxid: 'x', sats: 1n, vBtc: 1n }] }, wallet, { account: me }, async () => t, () => '0x' + op, () => ({ journal: J }), (m) => said.push(String(m)), (x) => String(x), engine,
    { requiredEscrow: 'a', escrowTotal: 'b', stEthPerWst: 'c' }, () => 0n, () => ({ gap: 0n }), engine, String, String, async () => '', () => ({}), () => ({}), () => ({}));
  return { c, J, said, bond: () => bond(0), SIZING };
}
const entry = (J) => J.get(`tx:1:${orig.hash}`);

test('a bond a speed-up landed is confirmed under the hash that landed, and the person goes on to size the next step', async () => {
  const w = await world(); w.c.mempool.delete(orig.hash); w.c.mine(fast, 990);
  await assert.rejects(w.bond(), (e) => e === w.SIZING, 'it went past the pending check to sizing the bond');
  assert.equal(entry(w.J).status, 'confirmed'); assert.equal(entry(w.J).hash, fast.hash);
});
test('a bond a cancel took the place of never went in: it is ended as replaced, and the person goes on', async () => {
  const w = await world(); w.c.mempool.delete(orig.hash); w.c.mine(cancel, 990);
  await assert.rejects(w.bond(), (e) => e === w.SIZING);
  assert.equal(entry(w.J).status, 'failed'); assert.equal(entry(w.J).replaced, true); assert.equal(entry(w.J).hash, cancel.hash);
});
test('one still on its way holds the person, as it did', async () => {
  const w = await world();
  await assert.rejects(w.bond(), /A bond for this lock was sent and has not landed yet\. Wait for it, or speed it up in your wallet/);
  assert.equal(entry(w.J).status, 'pending');
});
test('its own receipt confirms it, and a host whose wallet cannot trace holds on the receipt alone', async () => {
  const w = await world(); w.c.mempool.delete(orig.hash); w.c.mine(orig, 990);
  await assert.rejects(w.bond(), (e) => e === w.SIZING); assert.equal(entry(w.J).status, 'confirmed'); assert.equal(entry(w.J).hash, orig.hash);
  const w2 = await world({ trace: false }); w2.c.mempool.delete(orig.hash); w2.c.mine(fast, 990);
  await assert.rejects(w2.bond(), /has not landed yet/, 'with no trace a speed-up cannot be told from nothing: it holds, as before');
});
