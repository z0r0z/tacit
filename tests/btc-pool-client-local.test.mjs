// The pool client works out spend paths from the note feed and reads spent flags from the whole nullifier list, so no
// request it makes names the wallet's notes. Paths and roots match the replay's own tree (worker/src/btc-shielded-pool.js).
import assert from 'node:assert/strict';
import { makePoolClient } from '../dapp/btc-pool-client.js';
import { PoseidonTree } from '../worker/src/btc-shielded-pool.js';

const hex = (b) => '0x' + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log(`ok - ${name}`); };

// A feed of 13 leaves over blocks 100..106 (two a block), and the replay's tree over it.
const leaves = Array.from({ length: 13 }, (_, i) => BigInt(i * 7919 + 13) * 1000003n);
const heightOf = (i) => 100 + Math.floor(i / 2);
const tree = new PoseidonTree();
const feed = leaves.map((v, i) => { tree.append(hex(new Uint8Array(Buffer.from(v.toString(16).padStart(64, '0'), 'hex')))); return { leafIndex: i, txid: 'aa'.repeat(32), height: heightOf(i), leaf: '0x' + v.toString(16).padStart(64, '0'), asset: '0x00', pk_eph: '0x00', ct_note: '0x00' }; });
const rootAt = (h) => { const n = feed.filter((x) => x.height <= h).length; return hex(tree.rootAndPathAt(0, n).root); };
const NF = ['11'.repeat(32), '22'.repeat(32), '33'.repeat(32)];

function server({ list = true, rootFails = false } = {}) {
  const calls = [];
  const json = (v, status = 200) => ({ ok: status < 400, status, json: async () => v });
  const fetchImpl = async (url) => {
    const u = new URL(url), p = u.pathname;
    calls.push(p + u.search);
    if (p === '/btc-pool/status') return json({ height: 106 });
    if (p === '/btc-pool/notes') { const from = Number(u.searchParams.get('from')); return json({ notes: feed.slice(from), next: feed.length }); }
    if (p.startsWith('/btc-pool/root/')) { if (rootFails) return json({ error: 'busy' }, 429); const h = Number(p.split('/').pop()); return json({ height: h, root: rootAt(h), retained: true }); }
    if (p === '/btc-pool/nullifiers') {
      if (!list) return json({ error: 'not found' }, 404);
      const lim = Number(u.searchParams.get('limit')), rows = NF.map((n, i) => ['0x' + n, 101 + i]);
      return json({ height: 106, nullifiers: rows.slice(0, lim), next: null });
    }
    if (p.startsWith('/btc-pool/nullifier/')) return json({ spent: NF.includes(p.split('/').pop()) });
    if (p.startsWith('/btc-pool/path/')) {
      if (!rootFails) throw new Error('a path was asked of the replay');
      const idx = Number(p.split('/').pop()), at = Number(u.searchParams.get('at')), n = feed.filter((x) => x.height <= at).length, r = tree.rootAndPathAt(idx, n);
      return json({ leaf: feed[idx].leaf, hAnchor: at, root: hex(r.root), path: r.path.map(hex) });
    }
    return json({ error: 'not found' }, 404);
  };
  return { calls, client: makePoolClient({ api: 'http://replay', fetchImpl }) };
}

await test('paths and roots for notes of any age match the replay tree at the anchor', async () => {
  const { client } = server();
  for (const [h, idx] of [[103, [0, 7]], [106, [12]], [106, [3, 11]], [101, [2]]]) {
    const notes = idx.map((i) => ({ leafIndex: i, leaf: feed[i].leaf, height: feed[i].height }));
    const r = await client.anchorAndPaths(notes, { anchor: h });
    const n = feed.filter((x) => x.height <= h).length;
    assert.equal(r.root, rootAt(h));
    r.notes.forEach((x, k) => assert.deepEqual(x.path, tree.rootAndPathAt(idx[k], n).path.map(hex), `path of leaf ${idx[k]} at ${h}`));
  }
});

await test('spent flags come from the whole list; no request names a note', async () => {
  const { client, calls } = server();
  const wallet = {}, pool = { scan: () => [{ leafIndex: 1, nf: '0x' + NF[1] }, { leafIndex: 4, nf: '0x' + '44'.repeat(32) }] };
  const mine = await client.walletNotes(pool, wallet);
  assert.deepEqual(mine.map((x) => x.spent), [true, false]);
  assert.ok(!calls.some((c) => c.startsWith('/btc-pool/nullifier/') || c.startsWith('/btc-pool/path/')), calls.join(' '));
  await client.walletNotes(pool, wallet);
  assert.ok(calls.filter((c) => c.startsWith('/btc-pool/nullifiers')).at(-1).includes('from=94'), 'the next read starts twelve blocks back');
});

await test('a replay without the list is not asked note by note unless the caller says so', async () => {
  const { client, calls } = server({ list: false });
  const pool = { scan: () => [{ leafIndex: 1, nf: '0x' + NF[0] }] };
  await assert.rejects(client.walletNotes(pool, {}), /does not serve its list of spent notes/);
  assert.ok(!calls.some((c) => c.startsWith('/btc-pool/nullifier/')), 'no request names a note: ' + calls.join(' '));
  assert.deepEqual((await client.walletNotes(pool, {}, { namedChecks: true })).map((x) => x.spent), [true]);
  assert.ok(calls.some((c) => c.startsWith('/btc-pool/nullifier/')), 'the caller that allowed it is asked note by note');
});

await test('a spend whose root cannot be read waits instead of naming its notes', async () => {
  const { client, calls } = server({ rootFails: true });
  const notes = [3, 6].map((i) => ({ leafIndex: i, leaf: feed[i].leaf, height: feed[i].height }));
  await assert.rejects(client.anchorAndPaths(notes, { anchor: 106 }), /try again in a moment/);
  assert.ok(!calls.some((c) => c.startsWith('/btc-pool/path/')), 'no request names a note: ' + calls.join(' '));
  const r = await client.anchorAndPaths(notes, { anchor: 106, namedPaths: true });
  assert.equal(r.root, rootAt(106));
  assert.ok(calls.some((c) => c.startsWith('/btc-pool/path/3')) && calls.some((c) => c.startsWith('/btc-pool/path/6')), 'the caller that allowed it gets its paths from the replay');
});

await test('a later feed read asks only from twelve blocks below its newest note, and paths over the grown feed still match', async () => {
  // leaves a block apart from 50 on, so the first read's tail (blocks 50+n-13 on) is a small part of it
  const mk = (i) => { const v = BigInt(i * 104729 + 7) * 999983n; return { leafIndex: i, txid: 'bb'.repeat(32), height: 50 + i, leaf: '0x' + v.toString(16).padStart(64, '0'), asset: '0x00', pk_eph: '0x00', ct_note: '0x00' }; };
  const grown = Array.from({ length: 40 }, (_, i) => mk(i));
  const t = new PoseidonTree(); grown.forEach((x) => t.append(x.leaf));
  let shown = 30, now = Date.now();
  const calls = [];
  const json = (v) => ({ ok: true, status: 200, json: async () => v });
  const fetchImpl = async (url) => {
    const u = new URL(url), p = u.pathname;
    calls.push(p + u.search);
    if (p === '/btc-pool/status') return json({ height: 50 + shown - 1 });
    if (p === '/btc-pool/notes') { const from = Number(u.searchParams.get('from')); return json({ notes: grown.slice(from, shown), next: shown }); }
    if (p.startsWith('/btc-pool/root/')) { const h = Number(p.split('/').pop()); return json({ height: h, root: hex(t.rootAndPathAt(0, h - 50 + 1).root), retained: true }); }
    return json({ error: 'not found' });
  };
  const realNow = Date.now;
  Date.now = () => now;
  try {
    const client = makePoolClient({ api: 'http://replay', fetchImpl });
    const spend = async (i) => client.anchorAndPaths([{ leafIndex: i, leaf: grown[i].leaf, height: grown[i].height }], { anchor: 50 + shown - 1 });
    let r = await spend(20);
    assert.deepEqual(r.notes[0].path, t.rootAndPathAt(20, shown).path.map(hex));
    assert.ok(calls.find((c) => c.startsWith('/btc-pool/notes')).includes('from=0'));
    const mark = calls.length;
    shown = 40; now += 21e3;
    r = await spend(35);
    assert.equal(r.root, hex(t.rootAndPathAt(0, 40).root));
    assert.deepEqual(r.notes[0].path, t.rootAndPathAt(35, 40).path.map(hex));
    assert.ok(calls.slice(mark).find((c) => c.startsWith('/btc-pool/notes')).includes('from=17'), calls.join(' '));
  } finally { Date.now = realNow; }
});

await test('envelope asks the replay what it made of one transaction, with the txid bare and lower case; feedHas finds a shield by its txid in the feed', async () => {
  const calls = [], TX = 'ab'.repeat(32), json = (v, status = 200) => ({ ok: status < 400, status, json: async () => v });
  const fetchImpl = async (url) => {
    const u = new URL(url), p = u.pathname; calls.push(p);
    if (p === `/btc-pool/envelope/${TX}`) return json({ txid: TX, height: 9, seen: true, envelopes: [{ height: 8, vin: 0, opcode: 0x6c, accepted: false, reason: 'proof does not verify' }] });
    if (p === '/btc-pool/notes') return json({ notes: [{ leafIndex: 0, txid: TX, height: 8, leaf: '0x' + '01'.repeat(32), asset: '0x00', pk_eph: '0x00', ct_note: '0x00' }], next: 1 });
    return json({ error: 'not found' }, 404);
  };
  const client = makePoolClient({ api: 'http://replay', fetchImpl });
  const v = await client.envelope('0x' + TX.toUpperCase());
  assert.deepEqual([v.seen, v.envelopes[0].accepted, v.envelopes[0].reason], [true, false, 'proof does not verify']);
  assert.ok(calls.includes(`/btc-pool/envelope/${TX}`), calls.join(' '));
  await assert.rejects(() => client.envelope('cd'.repeat(32)), (e) => e.status === 404, 'a replay without the route (or an unknown path) answers 404');
  assert.equal(await client.feedHas(TX), true); assert.equal(await client.feedHas('cd'.repeat(32)), false);
});

console.log(`\n${passed} passed`);
