// The cBTC lock as every page makes it (dapp/btc-borrow.js lock → cbtc-lock-mint.js → cbtc-lock-broadcast.js), run against a stand-in
// for Bitcoin's explorers: what it signs and sends, what it keeps until Bitcoin has both transactions, how a lock cut short is finished
// later, which coins it spends, and that the fee the pages set aside covers the lock they then build.
//   node tests/cbtc-lock-driver.test.mjs
import assert from 'node:assert/strict';

const mem = new Map();
globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (f, ms, ...a) => realSetTimeout(f, Math.min(ms || 0, 1), ...a);          // the retries' waits, not waited

const { sha256, hmac, secp, bytesToHex, hexToBytes } = await import('../dapp/vendor/tacit-deps.min.js');
const { makeLoans, lockPad, lockRate } = await import('../dapp/btc-borrow.js');

let n = 0;
const test = async (name, fn) => { await fn(); n++; console.log(`ok - ${name}`); };
const hash256 = (b) => sha256(sha256(b));
function parseTx(hex) {
  const b = hexToBytes(hex); let p = 4;
  const u32 = () => { const v = new DataView(b.buffer, b.byteOffset + p, 4).getUint32(0, true); p += 4; return v; };
  const u64 = () => { const v = Number(new DataView(b.buffer, b.byteOffset + p, 8).getBigUint64(0, true)); p += 8; return v; };
  const vi = () => { const x = b[p++]; if (x < 0xfd) return x; const v = b[p] | (b[p + 1] << 8); p += 2; return v; };
  const seg = b[p] === 0 && b[p + 1] === 1; if (seg) p += 2;
  const start = p, ins = [], outs = [];
  for (let i = vi(); i > 0; i--) { const txid = bytesToHex(b.slice(p, p + 32).reverse()); p += 32; const vout = u32(), l = vi(); p += l; u32(); ins.push({ txid, vout }); }
  for (let i = vi(); i > 0; i--) { const value = u64(), l = vi(); outs.push({ value, script: bytesToHex(b.slice(p, p + l)) }); p += l; }
  const end = p, base = 4 + (end - start) + 4, plain = new Uint8Array(base);
  plain.set(b.slice(0, 4), 0); plain.set(b.slice(start, end), 4); plain.set(b.slice(b.length - 4), base - 4);
  return { ins, outs, vsize: Math.ceil((base * 3 + b.length) / 4), txid: bytesToHex(hash256(plain).reverse()) };
}

// Bitcoin, as the driver sees it: the address's coins, a fee estimate, and a mempool that takes or refuses what is posted.
// `commit` and `reveal` are 'ok', a refusal's text (answered 400), or 'down' (no answer at all).
function world({ utxos, rate = 4, commit = 'ok', reveal = 'ok' }) {
  const w = { posts: [], known: new Set(), commit, reveal, onPost: null };
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url), json = (o) => new Response(JSON.stringify(o), { status: 200 });
    if (opts.method === 'POST' && u.endsWith('/tx')) {
      const hex = String(opts.body), tx = parseTx(hex);
      const isCommit = !w.posts.length || w.posts[0] === hex || tx.ins.length > 1 || !w.known.has(tx.ins[0].txid) && !w.posts.some((h) => parseTx(h).txid === tx.ins[0].txid);
      if (!w.posts.includes(hex)) { w.posts.push(hex); w.onPost?.(hex, tx); }
      const mode = isCommit ? w.commit : w.reveal;
      if (mode === 'down') throw new TypeError('fetch failed');
      if (mode !== 'ok') return new Response(mode, { status: 400 });
      if (w.known.has(tx.txid)) return new Response('Transaction already in block chain', { status: 400 });
      w.known.add(tx.txid);
      return new Response(tx.txid, { status: 200 });
    }
    if (/\/address\/[a-z0-9]+\/utxo$/.test(u)) return json(utxos);
    if (u.endsWith('/fee-estimates')) return json({ 2: rate });
    const st = u.match(/\/tx\/([0-9a-f]{64})\/status$/);
    if (st) return w.commit === 'down' && w.reveal === 'down' ? Promise.reject(new TypeError('fetch failed')) : w.known.has(st[1]) ? json({ confirmed: false }) : new Response('Transaction not found', { status: 404 });
    return new Response('not found', { status: 404 });
  };
  return w;
}
const priv = new Uint8Array(32).fill(0x11), PUB = 'pub';
const t = { syncCbtcLockReservations: async () => {}, pool: { CBTC_ZK_ASSET_ID: '0x62a20d98fc1cd20289621d1315294cb8772f934d822e404b71e1f471cf0679c8',
  commitXY: (v, b) => ({ cx: '0x' + bytesToHex(sha256(new TextEncoder().encode(`x${v}:${b}`))), cy: '0x' + bytesToHex(sha256(new TextEncoder().encode(`y${v}:${b}`))) }) } };
const LN = makeLoans({ sha256, hmac, secp, bytesToHex, hexToBytes, pubHex: () => PUB,
  lockModule: () => import('../dapp/cbtc-lock-mint.js'), deployments: () => import('../dapp/confidential-deployments.js') });
const coin = (i, value, confirmed = true) => ({ txid: (i + 1).toString(16).padStart(64, 'a'), vout: i % 3, value, status: { confirmed } });
const SIGNED = `tacit-cbtc-lock-signed-v1:${PUB}`, PROTECTED = 'tacit-protected-outpoints-v1';
const signed = () => JSON.parse(mem.get(SIGNED) || '[]'), protectedNow = () => Object.keys(JSON.parse(mem.get(PROTECTED) || '{}'));
const fresh = () => { mem.clear(); };
const fees = (w, utxos) => {
  const [c, r] = w.posts.map(parseTx), spent = c.ins.reduce((a, i) => a + utxos.find((u) => u.txid === i.txid && u.vout === i.vout).value, 0);
  return { c, r, commitRate: (spent - c.outs.reduce((a, o) => a + o.value, 0)) / c.vsize, revealRate: (c.outs[0].value - r.outs.reduce((a, o) => a + o.value, 0)) / r.vsize };
};

await test('a lock is signed on a page that gave the curve no HMAC, and both transactions pay the rate they were sized at', async () => {
  fresh();
  assert.equal(typeof secp.etc.hmacSha256Sync, 'undefined', 'nothing set it before the wallet loads');
  const utxos = [coin(0, 500000)], w = world({ utxos, rate: 4 });
  let keptAtCommit = null;
  w.onPost = (hex) => { if (w.posts.length === 1) keptAtCommit = signed(); };
  const res = await LN.lock(t, priv, { sats: 100000n, rate: 4 });
  assert.equal(w.posts.length, 2, 'a commit and a reveal');
  const { c, r, commitRate, revealRate } = fees(w, utxos);
  assert.deepEqual([r.ins.length, r.ins[0].txid, r.ins[0].vout], [1, c.txid, 0], 'the reveal spends the commit’s first output');
  assert.deepEqual([r.outs[0].value, r.outs[1].value, r.outs[1].script.slice(0, 4)], [546, 100000, '5120'], 'a dust output, then the lock: the amount, to a taproot script');
  assert.deepEqual([res.lockTxid, res.lockVout, res.record.vBtc, res.record.anchor], [r.txid, 1, '100000', { txid: utxos[0].txid, vout: utxos[0].vout }], 'the lock, and the record its mint needs');
  assert.ok(commitRate >= 4 && revealRate >= 4, `both pay at least 4 sat/vB (${commitRate.toFixed(2)}, ${revealRate.toFixed(2)})`);
  assert.ok(keptAtCommit?.length === 1 && keptAtCommit[0].revealHex === w.posts[1] && keptAtCommit[0].commitHex === w.posts[0] && keptAtCommit[0].lockTxid === r.txid,
    'when the commit is sent, the signed reveal is already kept');
  assert.deepEqual(signed(), [], 'and it is let go once Bitcoin has both');
  assert.deepEqual(protectedNow(), [`${r.txid}:1`], 'the lock’s output is never a coin to spend');
});

await test('a reveal that is refused leaves the lock kept, and a later look sends it again', async () => {
  fresh();
  const utxos = [coin(0, 500000)], w = world({ utxos, reveal: 'mempool min fee not met' });
  const e = await LN.lock(t, priv, { sats: 100000n, rate: 4 }).then(() => null, (x) => x);
  assert.ok(e?.lockKept && /kept in this browser/.test(e.message), `it says the lock is kept (${e?.message})`);
  assert.equal(w.posts.length, 2);
  const kept = signed();
  assert.equal(kept.length, 1); assert.deepEqual(protectedNow(), [`${kept[0].lockTxid}:1`], 'its output is protected already');
  assert.deepEqual(await LN.resumeLocks(t, priv), { locked: [], waiting: 1 }, 'still refused: it waits');
  assert.equal(signed().length, 1);
  w.reveal = 'ok';
  const back = await LN.resumeLocks(t, priv);
  assert.deepEqual([back.waiting, back.locked.length, back.locked[0].lockTxid, back.locked[0].vBtc, back.locked[0].anchor], [0, 1, kept[0].lockTxid, '100000', { txid: utxos[0].txid, vout: utxos[0].vout }], 'sent again, it is a lock, with the record its mint needs');
  assert.ok(w.known.has(kept[0].lockTxid)); assert.deepEqual(signed(), []);
  assert.deepEqual(await LN.resumeLocks(t, priv), { locked: [], waiting: 0 }, 'and nothing is left to finish');
});

await test('pressing Lock again finishes the kept lock and makes no second one', async () => {
  fresh();
  const utxos = [coin(0, 500000), coin(1, 300000)], w = world({ utxos, reveal: 'down' });
  await LN.lock(t, priv, { sats: 100000n, rate: 4 }).catch(() => {});
  const kept = signed()[0];
  assert.ok(kept, 'kept');
  await assert.rejects(LN.lock(t, priv, { sats: 100000n, rate: 4 }), /earlier lock.*still being sent/, 'while it cannot be sent, another is not made');
  w.reveal = 'ok';
  const res = await LN.lock(t, priv, { sats: 100000n, rate: 4 });
  assert.deepEqual([res.resumed, res.lockTxid], [true, kept.lockTxid]);
  assert.equal(w.posts.length, 2, 'one commit and one reveal in all');
});

await test('a commit that Bitcoin refuses keeps nothing, and the press can be made again', async () => {
  fresh();
  const w = world({ utxos: [coin(0, 500000)], commit: 'min relay fee not met' });
  const e = await LN.lock(t, priv, { sats: 100000n, rate: 4 }).then(() => null, (x) => x);
  assert.ok(e && !e.lockKept && /min relay fee/.test(e.message), `the refusal is said as it is (${e?.message})`);
  assert.equal(w.posts.length, 1, 'no reveal was sent');
  assert.deepEqual([signed(), protectedNow()], [[], []]);
});

await test('a lock signed while the network was away is sent whole on a later look', async () => {
  fresh();
  const w = world({ utxos: [coin(0, 500000)], commit: 'down', reveal: 'down' });
  const e = await LN.lock(t, priv, { sats: 100000n, rate: 4 }).then(() => null, (x) => x);
  assert.ok(e?.lockKept, 'whether the commit arrived cannot be asked, so it is kept');
  assert.deepEqual(await LN.resumeLocks(t, priv), { locked: [], waiting: 1 });
  w.commit = 'ok'; w.reveal = 'ok';
  const back = await LN.resumeLocks(t, priv);
  assert.equal(back.locked.length, 1); assert.equal(w.known.size, 2, 'the commit and the reveal are both out'); assert.deepEqual(signed(), []);
});

await test('a kept lock whose coins went another way is let go', async () => {
  fresh();
  const w = world({ utxos: [coin(0, 500000)], commit: 'down', reveal: 'down' });
  await LN.lock(t, priv, { sats: 100000n, rate: 4 }).catch(() => {});
  const kept = signed()[0];
  w.commit = 'bad-txns-inputs-missingorspent'; w.reveal = 'ok';
  assert.deepEqual(await LN.resumeLocks(t, priv), { locked: [], waiting: 0 });
  assert.deepEqual([signed(), protectedNow().includes(`${kept.lockTxid}:1`)], [[], false], 'nothing of it is on Bitcoin, so nothing is kept or protected');
});

await test('fees are topped up from the largest coins, never from one that costs more than it holds or is unconfirmed', async () => {
  fresh();
  let utxos = [coin(0, 100000), coin(1, 700), coin(2, 700), coin(3, 700), coin(4, 16500)], w = world({ utxos, rate: 30 });
  await LN.lock(t, priv, { sats: 100000n, rate: 30 });
  assert.deepEqual(parseTx(w.posts[0]).ins.map((i) => i.txid), [utxos[0].txid, utxos[4].txid], 'the lock’s coin, then the one large enough to pay for it');
  fresh();
  utxos = [coin(0, 60000), coin(1, 500000, false)]; w = world({ utxos });
  await LN.lock(t, priv, { sats: 50000n, rate: 4 });
  assert.deepEqual(parseTx(w.posts[0]).ins.map((i) => i.txid), [utxos[0].txid], 'the confirmed coin');
  fresh(); w = world({ utxos });
  await assert.rejects(LN.lock(t, priv, { sats: 400000n, rate: 4 }), /insufficient sats/, 'what is unconfirmed is not there to lock');
  assert.equal(w.posts.length, 0);
});

await test('the fee the page sets aside covers locking all an address holds, for any number of coins', async () => {
  for (const coins of [1, 2, 3, 5, 8]) for (const rate of [1, 2, 4, 10, 30, 60]) {
    fresh();
    const utxos = Array.from({ length: coins }, (_, i) => coin(i, 40000 + 1000 * i)), w = world({ utxos, rate });
    const f = { fastestFee: rate }, total = utxos.reduce((a, u) => a + BigInt(u.value), 0n), max = total - lockPad(f, null, coins);
    assert.equal(lockRate(f, null), rate);
    const res = await LN.lock(t, priv, { sats: max, rate: lockRate(f, null) }).catch((e) => e);
    assert.ok(res?.lockTxid, `${coins} coin(s) at ${rate} sat/vB: Max locks (${res?.message || 'ok'})`);
    const { commitRate, revealRate } = fees(w, utxos);
    assert.ok(commitRate >= rate && revealRate >= rate, `and pays ${rate} sat/vB (${commitRate.toFixed(2)}, ${revealRate.toFixed(2)})`);
  }
  assert.ok(lockPad({ fastestFee: 10 }, null, 3) > lockPad({ fastestFee: 10 }, null, 2), 'each coin is an input to pay for');
  assert.equal(lockPad({ fastestFee: 10 }, null), lockPad({ fastestFee: 10 }, null, 2), 'two, when the count is not given');
});

console.log(`\n${n} passed`);
process.exit(0);
