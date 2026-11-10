
// The chain client's kept state against a stubbed leader (no node, no proofs): what a leader that restarts, refuses or answers late must not do to the
// wallet's balance and to the spends it keeps.
//   node tests/tacit-chain-client-state.test.mjs
import assert from 'node:assert';
import { sha256 } from '@noble/hashes/sha256';
import { keccak_256 } from '@noble/hashes/sha3';
import { makeChainClient, chainSeed } from '../dapp/tacit-chain-client.js';
import { makeChainWallet } from '../dapp/tacit-chain-wallet.js';
import { poseidon2, poseidon3, poseidon4, poseidon5 } from '../dapp/vendor/tacit-poseidon.min.js';
const sel = (s) => Buffer.from(keccak_256(new TextEncoder().encode(s)).slice(0, 4)).toString('hex');
const BLOCKS = '0x00000000000000000000000000000000000b10c5';
const w32 = (v) => '0x' + BigInt(v).toString(16).padStart(64, '0');
const rpcCall = async (m, [{ data }]) => {
  if (data.startsWith('0x' + sel('CHAIN()'))) return w32(7);
  if (data.startsWith('0x' + sel('TAC_ASSET()'))) return w32(9);
  if (data.startsWith('0x' + sel('pool()'))) return w32(0);
  if (data.startsWith('0x' + sel('shares()'))) return w32(0);
  if (data.startsWith('0x' + sel('hops(bytes32)'))) return w32(0);
  throw new Error('unexpected ' + data);
};
const store = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k), m }; };
const res = (status, body) => ({ ok: status < 400, status, json: async () => body });
const pub = (n) => '0x' + (n.toString(16).padStart(2, '0')).repeat(32).repeat(12);
const bytesOf = (h) => Uint8Array.from(Buffer.from(h.replace(/^0x/, ''), 'hex'));
// (an entry's id is the hash of what it submits, as the client makes it)
const idOf = (sub) => Buffer.from(sha256(Buffer.concat([bytesOf(sub.publics), bytesOf(sub.data)]))).toString('hex');
function mkEntry(over = {}) {
  const e = mkEntry0(over);
  return { ...e, id: over.id ?? idOf(e.submission) };
}
function mkEntry0(over = {}) {
  return { id: 'e1', kind: 'pay', units: '5', extra: {}, submission: { publics: pub(1), proof: '0x', data: '0x' + '00'.repeat(96), memos: [], opMemos: [] },
    nullifiers: ['0x' + 'ab'.repeat(32)], leaves: ['0x' + '01'.repeat(32)], own: [{ leaf: '0x' + 'cd'.repeat(32), value: '400' }], at: Date.now(), queued: true, refused: false, ...over };
}
async function mk(fetchImpl, st = store()) {
  const c = makeChainClient({ cfg: { blocks: BLOCKS, leader: 'http://x' }, rpcCall, priv: new Uint8Array(32).fill(0x11), system: () => null, storage: st, fetchImpl });
  await c.ready();
  const lane = Buffer.from(await c.lane()).toString('hex').slice(0, 16);
  return { c, st, nk: `tacit-chain-notes-v1:${BLOCKS}:${lane}`, pk: `tacit-chain-pending-v1:${BLOCKS}:${lane}`, hk: `tacit-chain-hops-v1:${BLOCKS}:${lane}` };
}
const note = { index: 3, value: '1000', s: '11'.repeat(32), leaf: '5', nullifier: '0x' + 'ab'.repeat(32) };


// 1. a spend refused when it is handed over again frees its notes (it was kept as queued)
{
  const f = async (url, o) => { if (o.method === 'POST') return res(400, { error: 'the leader refused: pays no fee' }); return res(404, { error: 'x' }); };
  const { st, nk } = await mk(f);
  st.setItem(nk, JSON.stringify({ next: 4, notes: [note] }));
  const m = await mk(f, st);
  st.setItem(m.pk, JSON.stringify([mkEntry()]));
  assert.equal(m.c.balance(), 400n, 'queued: the note is taken, its change counted');
  await m.c.resubmit(JSON.parse(st.getItem(m.pk))[0]).catch(() => {});
  const e = JSON.parse(st.getItem(m.pk))[0];
  assert.ok(e.refused && m.c.balance() === 1000n, 'refused at the hand-over: the note is free again');
  // a busy leader (429) is not a refusal
  const busy = async (url, o) => (o.method === 'POST' ? res(429, { error: 'slow down' }) : res(404, { error: 'x' }));
  const b = await mk(busy, st);
  st.setItem(b.pk, JSON.stringify([mkEntry({ id: 'e2' })]));
  await b.c.resubmit(JSON.parse(st.getItem(b.pk))[0]).catch(() => {});
  assert.ok(!JSON.parse(st.getItem(b.pk))[0].refused, 'a 429 is not a refusal');
}
// 2. a hop that lands through a resubmit is recorded for sending on
{
  const f = async (url, o) => {
    if (o.method === 'POST') return res(200, { id: 'rid', status: 'queued' });
    if (url.includes('/receipt/')) return res(200, { id: 'rid', status: 'landed', height: 5 });
    if (url.includes('/notes')) return res(200, { leaves: [], memos: [], next: 0, total: 0 });
    return res(404, { error: 'x' });
  };
  const { c, st, hk, pk } = await mk(f);
  st.setItem(pk, JSON.stringify([mkEntry({ kind: 'hop', units: '100', commit: '0x' + '5a'.repeat(32), own: [] })]));
  await c.resubmit(JSON.parse(st.getItem(pk))[0]);
  assert.ok(st.getItem(hk) && JSON.parse(st.getItem(hk))[0].units === '100', 'the landed hop is kept to be sent on');
}
// 2b. a hop that landed while no one was waiting (the page was closed after it was handed over) is recorded when the next visit finds it landed,
// so a leader that does not send it on leaves the button to send it
{
  const f = async (url) => (url.includes('/leaf/') ? res(200, { index: 7 }) : url.includes('/notes') ? res(200, { leaves: [], memos: [], next: 0, total: 0 }) : res(404, { error: 'x' }));
  const { c, st, hk, pk } = await mk(f);
  st.setItem(pk, JSON.stringify([mkEntry({ kind: 'hop', units: '250', commit: '0x' + '6b'.repeat(32), own: [] })]));
  assert.equal(st.getItem(hk), null, 'nothing is kept for sending on yet');
  const left = await c.pending();
  assert.equal(left.length, 0, 'the landed hop is no longer a pending spend');
  const hops = JSON.parse(st.getItem(hk) || '[]');
  assert.equal(hops.length, 1, 'but it is kept to be sent on');
  assert.equal(hops[0].units, '250');
  assert.equal(hops[0].commit, '0x' + '6b'.repeat(32));
  // a payment that landed is not a hop
  const g = await mk(f);
  g.st.setItem(g.pk, JSON.stringify([mkEntry({ kind: 'pay' })]));
  await g.c.pending();
  assert.equal(g.st.getItem(g.hk), null, 'a plain payment leaves no hop behind');
}
// 2c. a note the wallet's own spend made is told from a payment to it (the request screen calls a landed note that is not its own a payment)
{
  const f = async (url, o) => {
    if (o?.method === 'POST') return res(200, { id: 'rid', status: 'queued' });
    if (url.includes('/receipt/')) return res(200, { id: 'rid', status: 'landed', height: 5 });
    if (url.includes('/notes')) return res(200, { leaves: [], memos: [], next: 0, total: 0 });
    return res(404, { error: 'x' });
  };
  const { c, st, pk } = await mk(f);
  const key = '01'.repeat(32), other = '02'.repeat(32);
  assert.equal(c.ownLeaf(key), false, 'nothing of its own yet');
  st.setItem(pk, JSON.stringify([mkEntry({ leaves: ['0x' + key] })]));
  assert.equal(c.ownLeaf(key), true, 'a leaf of a spend still kept is its own');
  assert.equal(c.ownLeaf(other), false, 'another note is not');
  await c.resubmit(JSON.parse(st.getItem(pk))[0]);
  assert.equal(JSON.parse(st.getItem(pk) || '[]').length, 0, 'the spend landed and is no longer kept');
  assert.equal(c.ownLeaf(key), true, 'its note is still told as its own once the spend is let go');
  assert.equal(c.ownLeaf(other), false);
  // one a later visit finds landed (dropped by `pending`) is its own too
  const g = await mk(async (url) => (url.includes('/leaf/') ? res(200, { index: 1 }) : res(404, { error: 'x' })));
  g.st.setItem(g.pk, JSON.stringify([mkEntry({ leaves: ['0x' + other] })]));
  await g.c.pending();
  assert.equal(g.c.ownLeaf(other), true, 'a landed spend found by a reload is its own');
}
// 3. a shield's deposit entry does not expire (it is what a reclaim needs); a plain spend does
{
  const f = async () => res(404, { error: 'x' });
  const { c, st, pk } = await mk(f);
  const old = Date.now() - 31 * 864e5, dep = { shares: '9', amount: '10', cx: '0x' + '01'.repeat(32), cy: '0x' + '02'.repeat(32), body: '0x' + '03'.repeat(32) };
  st.setItem(pk, JSON.stringify([mkEntry({ id: 'dep', kind: 'shield', queued: false, nullifiers: [], at: old, deposit: dep }), mkEntry({ id: 'plain', at: old, queued: false })]));
  const left = await c.pending();
  assert.deepEqual(left.map((e) => e.id), ['dep'], 'the deposit stays, the old plain spend goes');
}
// 4. pending() does not overwrite a spend kept while it asked the network
{
  let release;
  const gate = new Promise((r) => { release = r; });
  const f = async (url, o) => {
    if (url.includes('/leaf/')) { await gate; return res(404, { error: 'x' }); }
    if (url.includes('/spent/')) return res(200, { spent: false });
    if (o.method === 'POST') return res(400, { error: 'refused' });
    return res(404, { error: 'x' });
  };
  const { c, st, pk } = await mk(f);
  st.setItem(pk, JSON.stringify([mkEntry({ id: 'old', leaves: ['0x' + '07'.repeat(32)] })]));
  const p = c.pending();
  await new Promise((r) => setTimeout(r, 20));
  const e2 = mkEntry({ id: 'x', submission: { publics: pub(2), proof: '0x', data: '0x' + '00'.repeat(96) }, queued: false, nullifiers: ['0x' + 'ee'.repeat(32)] });
  await c.resubmit(e2).catch(() => {});
  const mid = JSON.parse(st.getItem(pk)).length;
  release(); await p;
  assert.equal(JSON.parse(st.getItem(pk)).length, mid, 'the spend kept meanwhile is still kept');
}
// 5. a leader that restarts and replays (serving fewer leaves for a while) never doubles a note or sends the scan back
{
  const PO = { 2: poseidon2, 3: poseidon3, 4: poseidon4, 5: poseidon5 };
  const priv = new Uint8Array(32).fill(0x11);
  const gen = makeChainWallet({ poseidon: (x) => PO[x.length](x), prover: null, chain: w32(7), asset: 9n });
  const me = gen.keys(chainSeed(priv)), addr = gen.address(me), hx = (b) => '0x' + Buffer.from(b).toString('hex');
  const notes = [100n, 250n].map((v) => gen.makeNote(addr, v));
  let served = 2;
  const ok200 = (b) => ({ ok: true, status: 200, json: async () => b });
  const f = async (url) => {
    if (url.includes('/notes')) {
      const from = Math.min(Number(new URL(url).searchParams.get('from')), served);
      return ok200({ from, next: served, total: served, leaves: notes.slice(from, served).map((n) => w32(n.leaf)), memos: notes.slice(from, served).map((n) => hx(n.memo)) });
    }
    if (url.includes('/spent/')) return ok200({ spent: false });
    return res(404, {});
  };
  const rpc2 = async (m, [{ data }]) => (data.startsWith('0x' + sel('CHAIN()')) ? w32(7) : data.startsWith('0x' + sel('TAC_ASSET()')) ? w32(9) : w32(0));
  const m = new Map(), storage = { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k) };
  const c = makeChainClient({ cfg: { blocks: BLOCKS, leader: 'http://x' }, rpcCall: rpc2, priv, system: () => null, storage, fetchImpl: f });
  assert.equal(await c.scan(), 350n, 'two notes: 100 + 250');
  served = 0;
  assert.equal(await c.scan(), 350n, 'the leader replaying (serving none yet): the balance stands');
  served = 2;
  assert.equal(await c.scan(), 350n, 'the replay done: no note twice');
}
console.log('chain client state: all passed');
