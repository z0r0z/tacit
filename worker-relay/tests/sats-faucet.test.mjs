// sats-faucet against a mocked tacit module: the drip route (address validation, limits, lock, CORS) and the
// exit-to-sats maker (quote terms, offer validation over real pool spend bodies, budgets, lock, inventory).
//   node tests/sats-faucet.test.mjs   (from worker-relay/)

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { secp, sha256, keccak_256, bytesToHex, hexToBytes } from '../../dapp/vendor/tacit-deps.min.js';
import { makeBtcShieldedPool } from '../../dapp/btc-shielded-pool.js';
import { makeBtcPoolZap } from '../../dapp/btc-pool-zap.js';
import { publicSignals } from '../../dapp/btc-pool-zk.js';
import * as W from '../../worker/src/btc-shielded-pool.js';
import { configFromEnv, decodeSignetAddress, makeFaucet, makeHandler, makeLock, clientIp, makerKeyFor, HttpError } from '../src/sats-faucet.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hex = (b) => Buffer.from(b).toString('hex');
const ASSET_OUT = { txid: 'a'.repeat(64), vout: 0, value: 546 };

const ADDR_Q = 'tb1qd4hzm4wh6q73ty9l68tvlh3w5ddmp6z9lep4pl';
const ADDR_WSH = 'tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k7';
const ADDR_P = 'tb1pqqqqp399et2xygdj5xreqhjjvcmzhxw4aywxecjdzew6hylgvsesf3hn0c';
const ADDR_P2 = 'tb1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vq47zagq';

function mockTacit({ utxos, broadcastMs = 0 }) {
  const sent = [];
  let active = 0, maxActive = 0;
  const tacit = {
    NET: { name: 'signet', api: 'http://127.0.0.1:1' },
    DUST: 546,
    wallet: { pub: new Uint8Array(33).fill(2), address: () => 'tb1qfaucet' },
    scanHoldings: async () => new Map([['aa', { utxos: [{ utxo: ASSET_OUT, amount: 1n, blinding: 1n }] }]]),
    getUtxos: async () => [...utxos.map((u) => ({ ...u })), { ...ASSET_OUT, status: { confirmed: true } }, { txid: 'b'.repeat(64), vout: 9, value: 5000, status: { confirmed: true } }],
    // The real classifier: holdings-listed outpoints and the dust band are never sats.
    selectSatsUtxosSafe: (all, holdings) => {
      const ex = new Set();
      for (const h of holdings.values()) for (const u of h.utxos || []) ex.add(`${u.utxo.txid}:${u.utxo.vout}`);
      return all.filter((u) => !ex.has(`${u.txid}:${u.vout}`) && u.value > 546);
    },
    getFeeRate: async () => 1,
    feeFor: (vb, rate) => Math.max(500, Math.ceil(vb * rate)),
    p2wpkhScript: (pub) => Uint8Array.from([0, 20, ...sha256(pub).slice(0, 20)]),
    signP2wpkhInput: () => [],
    serializeTx: (tx) => tx,
    txid: (tx) => createHash('sha256').update(JSON.stringify(tx.inputs.map((i) => [i.txid, i.vout]))).digest('hex'),
    broadcast: async (tx) => {
      active++; maxActive = Math.max(maxActive, active);
      await sleep(broadcastMs);
      sent.push(tx);
      active--;
    },
    // carrier primitives (maker)
    TAP_NUMS: new Uint8Array(32),
    encodeEnvelopeScript: (_x, payload) => payload,
    tapLeafHash: () => new Uint8Array(32),
    tweakedOutputKey: () => ({ Q_xonly: new Uint8Array(32).fill(9), parity: 0 }),
    p2trScript: (x) => Uint8Array.from([0x51, 0x20, ...x]),
    controlBlock: () => new Uint8Array(33),
    estCommitVb: (n) => 11 + 68 * n + 43 + 31,
    signP2wpkhInputWithKey: (_tx, _i, _v, _priv, pub) => [pub],
    signTaprootScriptPathInput: () => ['taproot'],
  };
  tacit.wallet.xonly = () => new Uint8Array(32).fill(2);
  tacit.broadcastWithRetry = tacit.broadcast;
  // A spent UTXO stays listed by the indexer for a while; the faucet must not reselect it.
  const deps = { bytesToHex: (x) => (x instanceof Uint8Array ? bytesToHex(x) : x), hexToBytes };
  return { tacit, deps, sent, maxActive: () => maxActive };
}

function memStore(init = {}) {
  let s = JSON.parse(JSON.stringify(init));
  return { load: () => JSON.parse(JSON.stringify(s)), save: (x) => { s = JSON.parse(JSON.stringify(x)); }, peek: () => s };
}

const cfgOf = (env = {}) => configFromEnv({ FAUCET_ASSET_ID: 'ab'.repeat(32), FAUCET_DRIP_SATS: '10000', FAUCET_DRIP_DAILY: '50', FAUCET_DRIP_FLOOR_SATS: '50000', ...env });
const utxo = (n, value, confirmed = true) => ({ txid: n.repeat(64), vout: 0, value, status: { confirmed } });

function build({ utxos = [utxo('1', 100_000), utxo('2', 100_000), utxo('3', 100_000)], env = {}, store = memStore(), broadcastMs = 0, clock = { t: 1_800_000_000 }, maker = null } = {}) {
  const m = mockTacit({ utxos, broadcastMs });
  const faucet = makeFaucet({ tacit: m.tacit, deps: m.deps, cfg: cfgOf(env), store, logger: () => {}, now: () => clock.t, dripWaitMs: 0, maker });
  return { ...m, faucet, store, clock };
}

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`ok   ${name}`); }
  catch (e) { console.error(`FAIL ${name}\n${e.stack}`); process.exitCode = 1; }
}

// ── address validation ──
await test('decodes tb1q P2WPKH, tb1q P2WSH and tb1p P2TR to their scripts', () => {
  const q = decodeSignetAddress(ADDR_Q);
  assert.equal(q.script.length, 22); assert.equal(q.script[0], 0); assert.equal(q.script[1], 20);
  const w = decodeSignetAddress(ADDR_WSH);
  assert.equal(w.script.length, 34); assert.equal(w.script[0], 0);
  const p = decodeSignetAddress(ADDR_P);
  assert.equal(p.script.length, 34); assert.equal(p.script[0], 0x51); assert.equal(p.script[1], 32);
  assert.equal(decodeSignetAddress(ADDR_Q.toUpperCase()).address, ADDR_Q);
  assert.equal(decodeSignetAddress(`  ${ADDR_P2}  `).address, ADDR_P2);
});

await test('rejects mainnet, bad checksum, wrong encoding, mixed case and junk', () => {
  const bad = [
    'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
    ADDR_Q.slice(0, -1) + (ADDR_Q.endsWith('l') ? 'q' : 'l'),
    'tb1q0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vq24jc47', // v0 program with a bech32m checksum
    'tb1Qd4hzm4wh6q73ty9l68tvlh3w5ddmp6z9lep4pl',
    'tb1zw508d6qejxtdg4y5r3zarvaryvqyzf3du', // witness v2
    'mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn',
    '', null, undefined, 42, 'tb1' + 'q'.repeat(100),
  ];
  for (const a of bad) assert.throws(() => decodeSignetAddress(a), (e) => e instanceof HttpError && e.status === 400, String(a));
});

await test('client IP is the right-most X-Forwarded-For hop', () => {
  assert.equal(clientIp({ headers: { 'x-forwarded-for': '6.6.6.6, 1.2.3.4' }, socket: {} }), '1.2.3.4');
  assert.equal(clientIp({ headers: {}, socket: { remoteAddress: '9.9.9.9' } }), '9.9.9.9');
});

// ── drips and limits ──
await test('a drip pays the address, excludes asset and dust UTXOs, returns change, and is recorded', async () => {
  const b = build();
  const r = await b.faucet.drip({ address: ADDR_P, ip: '1.1.1.1' });
  assert.equal(r.sats, 10_000);
  assert.equal(b.sent.length, 1);
  const tx = b.sent[0];
  assert.equal(hex(tx.outputs[0].script), hex(decodeSignetAddress(ADDR_P).script));
  assert.equal(tx.outputs[0].value, 10_000);
  for (const i of tx.inputs) { assert.notEqual(i.txid, ASSET_OUT.txid); assert.notEqual(i.txid, 'b'.repeat(64)); }
  const inSum = tx.inputs.length * 100_000;
  assert.ok(tx.outputs[1].value > 0 && inSum - tx.outputs[0].value - tx.outputs[1].value >= 500);
  assert.equal(b.faucet.status().drips_left_today, 49);
  assert.equal(b.faucet.status().drip_sats, 10_000);
  assert.equal(b.store.peek().drips.length, 1);
  assert.ok(!JSON.stringify(b.store.peek()).includes('1.1.1.1'), 'client IPs are stored hashed');
});

await test('one drip per address and per client per 24h', async () => {
  const b = build();
  await b.faucet.drip({ address: ADDR_Q, ip: '1.1.1.1' });
  await assert.rejects(b.faucet.drip({ address: ADDR_Q, ip: '2.2.2.2' }), (e) => e.status === 429 && /address/.test(e.message));
  await assert.rejects(b.faucet.drip({ address: ADDR_Q.toUpperCase(), ip: '3.3.3.3' }), (e) => e.status === 429);
  await assert.rejects(b.faucet.drip({ address: ADDR_P, ip: '1.1.1.1' }), (e) => e.status === 429 && /client/.test(e.message));
  await b.faucet.drip({ address: ADDR_P, ip: '2.2.2.2' });
  b.clock.t += 86_401;
  await b.faucet.drip({ address: ADDR_Q, ip: '1.1.1.1' });
  assert.equal(b.sent.length, 3);
});

await test('global daily budget', async () => {
  const b = build({ env: { FAUCET_DRIP_DAILY: '2' } });
  await b.faucet.drip({ address: ADDR_Q, ip: '1.1.1.1' });
  await b.faucet.drip({ address: ADDR_P, ip: '2.2.2.2' });
  assert.equal(b.faucet.status().drips_left_today, 0);
  await assert.rejects(b.faucet.drip({ address: ADDR_WSH, ip: '3.3.3.3' }), (e) => e.status === 429 && /budget/.test(e.message));
  b.clock.t += 86_401;
  assert.equal(b.faucet.status().drips_left_today, 2);
  await b.faucet.drip({ address: ADDR_WSH, ip: '3.3.3.3' });
});

await test('limits survive a restart through the state file', async () => {
  const store = memStore();
  const clock = { t: 1_800_000_000 };
  await build({ store, clock }).faucet.drip({ address: ADDR_Q, ip: '1.1.1.1' });
  const again = build({ store, clock });
  await assert.rejects(again.faucet.drip({ address: ADDR_Q, ip: '5.5.5.5' }), (e) => e.status === 429);
  await assert.rejects(again.faucet.drip({ address: ADDR_P, ip: '1.1.1.1' }), (e) => e.status === 429);
  assert.equal(again.faucet.status().drips_left_today, 49);
});

await test('refuses to drip below the listing floor, and nothing is recorded', async () => {
  const b = build({ utxos: [utxo('1', 55_000)] });
  await assert.rejects(b.faucet.drip({ address: ADDR_Q, ip: '1.1.1.1' }), (e) => e.status === 503 && /low/.test(e.message));
  assert.equal(b.sent.length, 0);
  assert.equal(b.faucet.status().drips_left_today, 50);
  const ok = build({ utxos: [utxo('1', 70_000)] });
  await ok.faucet.drip({ address: ADDR_Q, ip: '1.1.1.1' });
});

await test('concurrent drips are serialised and never select the same UTXO', async () => {
  const b = build({ utxos: [utxo('1', 100_000), utxo('2', 100_000), utxo('3', 100_000), utxo('4', 100_000)], broadcastMs: 30 });
  const rs = await Promise.all([
    b.faucet.drip({ address: ADDR_Q, ip: '1.1.1.1' }),
    b.faucet.drip({ address: ADDR_P, ip: '2.2.2.2' }),
    b.faucet.drip({ address: ADDR_WSH, ip: '3.3.3.3' }),
  ]);
  assert.equal(new Set(rs.map((r) => r.txid)).size, 3);
  assert.equal(b.maxActive(), 1);
  const used = b.sent.flatMap((tx) => tx.inputs.map((i) => `${i.txid}:${i.vout}`));
  assert.equal(new Set(used).size, used.length, 'an outpoint was spent twice');
});

await test('concurrent requests for one address give exactly one drip', async () => {
  const b = build({ broadcastMs: 20 });
  const rs = await Promise.allSettled([1, 2, 3].map((n) => b.faucet.drip({ address: ADDR_Q, ip: `${n}.0.0.1` })));
  assert.equal(rs.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(b.sent.length, 1);
});

await test('lock runs tasks one at a time and survives a failing task', async () => {
  const lock = makeLock();
  let active = 0, max = 0;
  const task = (fail) => lock(async () => { active++; max = Math.max(max, active); await sleep(5); active--; if (fail) throw new Error('x'); return 1; });
  const rs = await Promise.allSettled([task(false), task(true), task(false)]);
  assert.deepEqual(rs.map((r) => r.status), ['fulfilled', 'rejected', 'fulfilled']);
  assert.equal(max, 1);
});

// ── HTTP ──
await test('HTTP: CORS allow-list on POST, open GET, JSON errors, right-most XFF', async () => {
  const b = build();
  const server = createServer(makeHandler(b.faucet, { corsOrigins: ['https://tacit.finance', 'http://localhost:8765'], logger: () => {} }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (body, headers = {}) => fetch(`${base}/faucet/sats`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body });
  try {
    let r = await fetch(`${base}/faucet/sats`, { method: 'OPTIONS', headers: { Origin: 'https://tacit.finance', 'Access-Control-Request-Method': 'POST' } });
    assert.equal(r.status, 204);
    assert.equal(r.headers.get('access-control-allow-origin'), 'https://tacit.finance');
    assert.match(r.headers.get('access-control-allow-headers'), /Content-Type/i);
    r = await fetch(`${base}/faucet/sats`, { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } });
    assert.equal(r.status, 403);
    assert.equal(r.headers.get('access-control-allow-origin'), null);
    r = await post(JSON.stringify({ address: ADDR_Q }), { Origin: 'https://evil.example' });
    assert.equal(r.status, 403);
    r = await post('not json', { Origin: 'http://localhost:8765' });
    assert.equal(r.status, 400);
    r = await post('x'.repeat(5000));
    assert.equal(r.status, 413);
    r = await post(JSON.stringify({ address: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4' }));
    assert.equal(r.status, 400);
    r = await post(JSON.stringify({ address: ADDR_Q }), { Origin: 'http://localhost:8765', 'X-Forwarded-For': '6.6.6.6, 1.2.3.4' });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('access-control-allow-origin'), 'http://localhost:8765');
    assert.match((await r.json()).txid, /^[0-9a-f]{64}$/);
    r = await post(JSON.stringify({ address: ADDR_P }), { 'X-Forwarded-For': '7.7.7.7, 1.2.3.4' });
    assert.equal(r.status, 429);
    r = await fetch(`${base}/faucet/sats`);
    assert.equal(r.status, 405);
    r = await fetch(`${base}/faucet/status`, { headers: { Origin: 'https://anything.example' } });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('access-control-allow-origin'), '*');
    const st = await r.json();
    assert.equal(st.drip_sats, 10_000);
    assert.equal(st.drips_left_today, 49);
  } finally {
    server.close();
  }
});

// ── maker: exit to sats ──
const bp = makeBtcShieldedPool({ secp, keccak256: keccak_256, sha256 });
const zap = makeBtcPoolZap({ secp, sha256, keccak256: keccak_256 });
const standIn = { prove: async (input) => ({ wire: new Uint8Array(256), publicSignals: publicSignals(input) }) };
const ASSET_ID = 'ab'.repeat(32);
const SYS = { id: 'halo2-kzg-bn254', vkHash: 'cd'.repeat(64) };
const MAKER_PUB = new Uint8Array(33).fill(3);
const MAIN_SPK = hex(Uint8Array.from([0, 20, ...sha256(new Uint8Array(33).fill(2)).slice(0, 20)]));
const MAKER_SPK = hex(Uint8Array.from([0, 20, ...sha256(MAKER_PUB).slice(0, 20)]));

// A user holding one 30,000-unit pool note, anchored at 1000 of a replay whose tip is 1006.
const user = bp.walletFromSeed(crypto.getRandomValues(new Uint8Array(32)), 'signet');
const fx = (() => {
  const st = new W.BtcPoolState();
  const notes = [bp.createNote(user.addressString, '0x' + ASSET_ID, 30_000n)];
  st.beginBlock(1000);
  for (const n of notes) { st.tree.append(hexToBytes(n.leaf.replace(/^0x/, ''))); st.leafHeights.push(1000); }
  st.endBlock();
  for (let h = 1001; h <= 1006; h++) { st.beginBlock(h); st.endBlock(); }
  const scanned = bp.scan(user, notes.map((n, i) => ({ ...n, leafIndex: i }))).map((x) => ({ ...x, path: st.tree.rootAndPathAt(x.leafIndex, 1).path.map((p) => '0x' + hex(p)) }));
  return { scanned, root: '0x' + hex(st.roots.get(1000)) };
})();

function makerCtl(over = {}) {
  const ctl = {
    proofOk: true, retained: true, spent: new Set(), exits: new Set(), sys: { ...SYS },
    coins: [{ txid: 'c1'.repeat(32), vout: 0, value: 3_000 }, { txid: 'c2'.repeat(32), vout: 0, value: 20_000 }, { txid: 'c3'.repeat(32), vout: 1, value: 20_000 }],
    calls: [],
    ...over,
  };
  ctl.maker = {
    key: { priv: new Uint8Array(32).fill(7), pub: MAKER_PUB },
    pool: bp, zap,
    verifier: { verify: async () => ctl.proofOk, system: { id: SYS.id, vkHash: SYS.vkHash }, vkHash: SYS.vkHash },
    utxos: async (spkHex) => { assert.equal(spkHex, MAKER_SPK, 'maker coins are read from the maker key only'); return ctl.coins.map((c) => ({ ...c, status: { confirmed: true } })); },
    poolGet: async (p) => {
      ctl.calls.push(p);
      let m;
      if (p === '/btc-pool/status') return { height: 1006, halted: null, proofSystem: ctl.sys.id, vkHash: ctl.sys.vkHash };
      if ((m = p.match(/^\/btc-pool\/root\/(\d+)$/))) return Number(m[1]) === 1000 ? { height: 1000, root: fx.root, retained: ctl.retained } : { retained: false };
      if ((m = p.match(/^\/btc-pool\/nullifier\/([0-9a-f]{64})$/))) return { spent: ctl.spent.has(m[1]) };
      if ((m = p.match(/^\/btc-pool\/exit\/([0-9a-f]{64})\/(\d+)$/))) return { exists: ctl.exits.has(`${m[1]}:${m[2]}`) };
      throw new Error(`unexpected pool call ${p}`);
    },
  };
  return ctl;
}
const makerStore = () => memStore({ assetId: ASSET_ID, lots: [], recovered: true });
function buildMaker({ env = {}, ctl = makerCtl(), ...rest } = {}) {
  return { ...build({ env, store: makerStore(), maker: ctl.maker, ...rest }), ctl };
}

// The user's side: exitToSats against the quote (or altered terms), proved with the stand-in.
async function userOffer(q, { maker = {}, amount = null } = {}) {
  const terms = { spk: '0x' + q.makerSpk, sats: BigInt(q.sats), vout: q.wantVout, exitVout: q.exitVout, bind: q.bind, ...maker };
  const r = zap.exitToSats({ pool: bp, wallet: user, notes: fx.scanned, amount: amount ?? BigInt(q.units), maker: terms, asset: '0x' + ASSET_ID, hAnchor: 1000, root: fx.root, usedScripts: new Set() });
  const { payloadHex } = await bp.prove(r.spend, standIn);
  return {
    quoteId: q.quoteId, payload: payloadHex,
    offer: { exitOpening: { value: r.offer.exitOpening.value.toString(), blinding: r.offer.exitOpening.blinding }, payoutScriptPubKey: r.offer.payoutScriptPubKey },
    r,
  };
}

await test('maker key is derived from the faucet key and differs from it', () => {
  const k = makerKeyFor({ deps: { secp, hexToBytes } }, '11'.repeat(32));
  assert.equal(k.pub.length, 33);
  assert.notEqual(hex(k.pub), hex(secp.getPublicKey(hexToBytes('11'.repeat(32)), true)));
  assert.equal(hex(makerKeyFor({ deps: { secp, hexToBytes } }, '11'.repeat(32)).pub), hex(k.pub));
});

await test('quote: the sale rate less the spread, the faucet script, distinct bind coins per quote', async () => {
  const b = buildMaker();
  const q = await b.faucet.makerQuote({ units: '10000', ip: '1.1.1.1' });
  assert.equal(q.sats, 950, '10,000 units at 1,000 sats per 10,000 less 5%');
  assert.equal(q.units, '10000');
  assert.equal(q.asset, ASSET_ID);
  assert.equal(q.makerSpk, MAIN_SPK, 'exit notes pay the faucet key, not the maker coin key');
  assert.deepEqual([q.exitVout, q.wantVout], [0, 1]);
  assert.deepEqual(q.bind, { txid: 'c1'.repeat(32), vout: 0 }, 'the smallest maker coin binds');
  assert.equal(q.expiry, b.clock.t + 1200);
  const q2 = await b.faucet.makerQuote({ units: '4000', ip: '2.2.2.2' });
  assert.notEqual(`${q2.bind.txid}:${q2.bind.vout}`, `${q.bind.txid}:${q.bind.vout}`);
  assert.equal(q2.sats, 380);
  const st = b.faucet.status().maker;
  assert.equal(st.enabled, true);
  assert.equal(st.sats_per_lot, 950);
  assert.equal(st.min_units, '3474');
  assert.equal(st.open_quotes, 2);
  assert.equal(st.sats_left_today, 50_000 - 950 - 380);
});

await test('quote: rejects junk, too small, above the per-swap max, and an empty maker', async () => {
  const b = buildMaker();
  for (const u of ['', 'abc', '-5', '1.5', '0', null]) await assert.rejects(b.faucet.makerQuote({ units: u, ip: '1.1.1.1' }), (e) => e.status === 400, String(u));
  await assert.rejects(b.faucet.makerQuote({ units: '3473', ip: '1.1.1.1' }), (e) => e.status === 400 && /at least 3474/.test(e.message));
  await b.faucet.makerQuote({ units: '3474', ip: '1.1.1.1' });
  await assert.rejects(b.faucet.makerQuote({ units: '50001', ip: '2.2.2.2' }), (e) => e.status === 400 && /at most/.test(e.message));
  const poor = buildMaker({ ctl: makerCtl({ coins: [{ txid: 'c1'.repeat(32), vout: 0, value: 3_000 }] }) });
  await assert.rejects(poor.faucet.makerQuote({ units: '10000', ip: '1.1.1.1' }), (e) => e.status === 503);
  const off = build({ store: makerStore() });
  await assert.rejects(off.faucet.makerQuote({ units: '10000', ip: '1.1.1.1' }), (e) => e.status === 404);
  const disabled = buildMaker({ env: { FAUCET_MAKER: 'off' } });
  await assert.rejects(disabled.faucet.makerQuote({ units: '10000', ip: '1.1.1.1' }), (e) => e.status === 404);
  assert.equal(disabled.faucet.status().maker.enabled, false);
});

await test('fill: a valid offer is checked natively and carried from the maker coins; the exit note joins the inventory', async () => {
  const b = buildMaker();
  const q = await b.faucet.makerQuote({ units: '10000', ip: '1.1.1.1' });
  const o = await userOffer(q);
  const r = await b.faucet.makerFill({ ...o, ip: '1.1.1.1' });
  assert.equal(r.sats, 950);
  assert.equal(b.sent.length, 2, 'commit then carrier');
  const [commit, reveal] = b.sent;
  assert.equal(r.txid, b.tacit.txid(reveal));
  assert.equal(r.commitTxid, b.tacit.txid(commit));
  // Commit: funded from maker coins other than the bind, signed with the maker key; change back to it.
  for (const i of commit.inputs) assert.ok(['c2'.repeat(32), 'c3'.repeat(32)].includes(i.txid));
  assert.ok(commit.inputs.every((i) => hex(i.witness[0]) === hex(MAKER_PUB)));
  assert.equal(hex(commit.outputs[0].script).slice(0, 4), '5120');
  if (commit.outputs[1]) assert.equal(hex(commit.outputs[1].script), MAKER_SPK);
  // Carrier: vin[0] the commit, vin[1] the bind; vout[0] the exit to the faucet key, vout[1] the want in full.
  assert.deepEqual(reveal.inputs.map((i) => [i.txid, i.vout]), [[r.commitTxid, 0], [q.bind.txid, q.bind.vout]]);
  assert.equal(reveal.outputs.length, 2);
  assert.deepEqual([reveal.outputs[0].value, hex(reveal.outputs[0].script)], [546, MAIN_SPK]);
  assert.deepEqual([reveal.outputs[1].value, '0x' + hex(reveal.outputs[1].script)], [950, o.r.payout.scriptPubKey]);
  const outSum = reveal.outputs.reduce((s, x) => s + x.value, 0);
  assert.ok(commit.outputs[0].value + 3_000 > outSum, 'the carrier pays its outputs and a fee');
  // The pool was asked about the anchor root and every nullifier; the proof was checked.
  assert.ok(b.ctl.calls.includes('/btc-pool/root/1000'));
  assert.equal(b.ctl.calls.filter((p) => p.startsWith('/btc-pool/nullifier/')).length, o.r.spend.nullifiers.length);
  const s = b.store.peek();
  assert.equal(Object.keys(s.makerQuotes).length, 0, 'the quote is used up');
  assert.equal(s.makerNotes.length, 1);
  const note = s.makerNotes[0];
  assert.deepEqual([note.txid, note.vout, note.amount, note.status], [r.txid, 0, '10000', 'pending']);
  const C = bp.commitXY(10_000n, BigInt('0x' + note.blinding));
  assert.deepEqual([C.cx, C.cy], [o.r.spend.exit.cx, o.r.spend.exit.cy], 'the stored opening opens the exit');
  assert.equal(b.faucet.status().maker.fills_total, 1);
  assert.ok(!JSON.stringify(s).includes('1.1.1.1'), 'client IPs are stored hashed');
  await assert.rejects(b.faucet.makerFill({ ...o, ip: '1.1.1.1' }), (e) => e.status === 404, 'a quote fills once');
});

await test('fill: a want above the quote, the wrong exit script, amount or bind, and a bad proof are rejected before any sats move', async () => {
  const b = buildMaker({ env: { FAUCET_MAKER_IP_FILLS: '9' } });
  const q = await b.faucet.makerQuote({ units: '10000', ip: '1.1.1.1' });
  const reject = async (o, status, re) => { await assert.rejects(b.faucet.makerFill({ ...o, ip: '1.1.1.1' }), (e) => e.status === status && re.test(e.message), re.source); };
  await reject(await userOffer(q, { maker: { sats: BigInt(q.sats) + 1n } }), 400, /want asks more/);
  await reject(await userOffer(q, { maker: { spk: '0x' + '0014' + '11'.repeat(20) } }), 400, /exit does not pay the maker/);
  await reject(await userOffer(q, { amount: 9_999n }), 400, /exit amount/);
  await reject(await userOffer(q, { maker: { bind: { txid: 'c2'.repeat(32), vout: 0 } } }), 400, /bind/);
  await reject(await userOffer(q, { maker: { bind: null } }), 400, /bind/);
  await reject(await userOffer(q, { maker: { vout: 2, exitVout: 0 } }), 400, /want is not at the agreed output/);
  const good = await userOffer(q);
  await reject({ ...good, offer: { ...good.offer, exitOpening: { ...good.offer.exitOpening, blinding: '0x' + '01'.repeat(32) } } }, 400, /exit opening/);
  await reject({ ...good, offer: { ...good.offer, payoutScriptPubKey: '0x5120' + '22'.repeat(32) } }, 400, /payout script/);
  await reject({ ...good, payload: good.r.spend.bodyHex }, 400, /pool spend|carries no proof/);
  b.ctl.proofOk = false;
  await reject(good, 400, /proof does not verify/);
  b.ctl.proofOk = true;
  b.ctl.retained = false;
  await reject(good, 400, /no root/);
  b.ctl.retained = true;
  b.ctl.spent.add(good.r.spend.nullifiers[0].replace(/^0x/, ''));
  await reject(good, 409, /already spent/);
  b.ctl.spent.clear();
  b.ctl.sys = { id: 'groth16-bn254', vkHash: '97'.repeat(32) };
  await reject(good, 503, /proof system/);
  b.ctl.sys = { ...SYS };
  await reject({ ...good, offer: null }, 400, /offer/);
  await reject({ ...good, payload: 'zz' }, 400, /hex/);
  assert.equal(b.sent.length, 0, 'nothing was broadcast');
  const r = await b.faucet.makerFill({ ...good, ip: '1.1.1.1' });
  assert.match(r.txid, /^[0-9a-f]{64}$/, 'the quote stays usable after rejected offers');
});

await test('fill: an expired quote is refused and its bind released', async () => {
  const b = buildMaker();
  const q = await b.faucet.makerQuote({ units: '10000', ip: '1.1.1.1' });
  const o = await userOffer(q);
  b.clock.t += 1201;
  await assert.rejects(b.faucet.makerFill({ ...o, ip: '1.1.1.1' }), (e) => e.status === 410);
  const q2 = await b.faucet.makerQuote({ units: '10000', ip: '1.1.1.1' });
  assert.deepEqual(q2.bind, q.bind, 'the lapsed quote freed its bind');
  assert.equal(b.sent.length, 0);
});

await test('budgets: daily sats (open quotes count), fills per client, open quotes per client', async () => {
  const b = buildMaker({ env: { FAUCET_MAKER_DAILY_SATS: '1500' } });
  await b.faucet.makerQuote({ units: '10000', ip: '1.1.1.1' });
  await assert.rejects(b.faucet.makerQuote({ units: '10000', ip: '2.2.2.2' }), (e) => e.status === 429 && /budget/.test(e.message));
  b.clock.t += 1201;
  assert.equal(b.faucet.status().maker.sats_left_today, 1500, 'a lapsed quote returns its sats');

  const c = buildMaker({ env: { FAUCET_MAKER_IP_FILLS: '1' }, ctl: makerCtl({ coins: Array.from({ length: 6 }, (_, i) => ({ txid: `a${i}`.repeat(32), vout: 0, value: 20_000 })) }) });
  const q = await c.faucet.makerQuote({ units: '10000', ip: '1.1.1.1' });
  await c.faucet.makerFill({ ...(await userOffer(q)), ip: '1.1.1.1' });
  await assert.rejects(c.faucet.makerQuote({ units: '10000', ip: '1.1.1.1' }), (e) => e.status === 429 && /per client/.test(e.message));
  await c.faucet.makerQuote({ units: '10000', ip: '3.3.3.3' });
  c.clock.t += 86_401;
  await c.faucet.makerQuote({ units: '10000', ip: '1.1.1.1' });

  const d = buildMaker({ ctl: makerCtl({ coins: Array.from({ length: 6 }, (_, i) => ({ txid: `d${i}`.repeat(32), vout: 0, value: 20_000 })) }) });
  await d.faucet.makerQuote({ units: '10000', ip: '1.1.1.1' });
  await d.faucet.makerQuote({ units: '10000', ip: '1.1.1.1' });
  await assert.rejects(d.faucet.makerQuote({ units: '10000', ip: '1.1.1.1' }), (e) => e.status === 429 && /open quotes/.test(e.message));
});

await test('lock: concurrent fills and drips never overlap or reuse a coin', async () => {
  const coins = Array.from({ length: 6 }, (_, i) => ({ txid: `e${i}`.repeat(32), vout: 0, value: 4_000 + i * 1000 }));
  const b = buildMaker({ ctl: makerCtl({ coins }), broadcastMs: 15 });
  const q1 = await b.faucet.makerQuote({ units: '10000', ip: '1.1.1.1' });
  const q2 = await b.faucet.makerQuote({ units: '10000', ip: '2.2.2.2' });
  const [o1, o2] = [await userOffer(q1), await userOffer(q2)];
  const rs = await Promise.all([
    b.faucet.makerFill({ ...o1, ip: '1.1.1.1' }),
    b.faucet.drip({ address: ADDR_Q, ip: '3.3.3.3' }),
    b.faucet.makerFill({ ...o2, ip: '2.2.2.2' }),
  ]);
  assert.equal(new Set(rs.map((r) => r.txid)).size, 3);
  assert.equal(b.maxActive(), 1);
  const used = b.sent.flatMap((tx) => tx.inputs.map((i) => `${i.txid}:${i.vout}`));
  assert.equal(new Set(used).size, used.length, 'an outpoint was spent twice');
  const concurrent = buildMaker();
  const q = await concurrent.faucet.makerQuote({ units: '10000', ip: '1.1.1.1' });
  const o = await userOffer(q);
  const both = await Promise.allSettled([concurrent.faucet.makerFill({ ...o, ip: '1.1.1.1' }), concurrent.faucet.makerFill({ ...o, ip: '1.1.1.1' })]);
  assert.equal(both.filter((x) => x.status === 'fulfilled').length, 1, 'one quote, one carrier');
  assert.equal(concurrent.sent.length, 2);
});

await test('tick: tops up the maker coins from the faucet key above its floor, and relists bought-back lots', async () => {
  const ctl = makerCtl({ coins: [] });
  const published = [];
  const b = buildMaker({ ctl, utxos: [utxo('1', 100_000)] });
  b.tacit.publishPreauthSale = async (a) => { published.push(a); return { sale_id: `s${published.length}` }; };
  b.tacit.fetchPreauthSale = async () => ({ sale_id: 'x' });
  assert.equal(await b.faucet.tick(), true);
  const top = b.sent.find((tx) => tx.outputs.some((o) => hex(o.script) === MAKER_SPK));
  assert.ok(top, 'a top-up was sent');
  assert.equal(top.outputs.filter((o) => hex(o.script) === MAKER_SPK && o.value === 10_000).length, 4);
  // Below the faucet key's floor, no top-up.
  const low = buildMaker({ ctl: makerCtl({ coins: [] }), utxos: [utxo('1', 70_000)] });
  await low.faucet.tick();
  assert.equal(low.sent.length, 0);

  // A fill's exit note, once the pool records it, joins the lots and is listed.
  const f = buildMaker({ env: { FAUCET_MAKER_IP_FILLS: '9' }, ctl: makerCtl({ coins: Array.from({ length: 5 }, (_, i) => ({ txid: `f${i}`.repeat(32), vout: 0, value: 20_000 })) }) });
  f.tacit.publishPreauthSale = async (a) => { published.push(a); return { sale_id: `s${published.length}` }; };
  f.tacit.fetchPreauthSale = async () => ({ sale_id: 'x' });
  const q = await f.faucet.makerQuote({ units: '10000', ip: '1.1.1.1' });
  const r = await f.faucet.makerFill({ ...(await userOffer(q)), ip: '1.1.1.1' });
  const q2 = await f.faucet.makerQuote({ units: '4000', ip: '1.1.1.1' });
  const r2 = await f.faucet.makerFill({ ...(await userOffer(q2)), ip: '1.1.1.1' });
  await f.faucet.tick();
  assert.equal(f.store.peek().makerNotes.filter((x) => x.status === 'pending').length, 2, 'not before the pool records the exit');
  f.ctl.exits.add(`${r.txid}:0`).add(`${r2.txid}:0`);
  published.length = 0;
  await f.faucet.tick();
  const s = f.store.peek();
  assert.equal(s.makerNotes.find((x) => x.txid === r.txid).status, 'listed');
  assert.equal(s.makerNotes.find((x) => x.txid === r2.txid).status, 'ready', 'a part lot waits for the next split');
  const lot = s.lots.find((l) => l.txid === r.txid);
  assert.ok(lot && lot.saleId, 'the lot-sized note is listed');
  assert.equal(published[0].utxoTxid, r.txid);
  assert.equal(published[0].preResolvedTarget.amount, 10_000n);
});

await test('HTTP: maker quote and fill behind the origin allow-list, fill body limit, JSON errors', async () => {
  const b = buildMaker();
  const server = createServer(makeHandler(b.faucet, { corsOrigins: ['https://tacit.finance'], logger: () => {} }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    let r = await fetch(`${base}/faucet/maker/quote?units=10000`, { headers: { Origin: 'https://evil.example' } });
    assert.equal(r.status, 403);
    r = await fetch(`${base}/faucet/maker/quote?units=10000`, { headers: { Origin: 'https://tacit.finance', 'X-Forwarded-For': '6.6.6.6, 1.2.3.4' } });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('access-control-allow-origin'), 'https://tacit.finance');
    const q = await r.json();
    assert.equal(q.sats, 950);
    r = await fetch(`${base}/faucet/maker/fill`, { method: 'OPTIONS', headers: { Origin: 'https://tacit.finance', 'Access-Control-Request-Method': 'POST' } });
    assert.equal(r.status, 204);
    assert.match(r.headers.get('access-control-allow-methods'), /POST/);
    r = await fetch(`${base}/faucet/maker/fill`);
    assert.equal(r.status, 405);
    r = await fetch(`${base}/faucet/maker/quote?units=10000`, { method: 'POST' });
    assert.equal(r.status, 405);
    r = await fetch(`${base}/faucet/maker/fill`, { method: 'POST', body: 'x'.repeat(300_000) });
    assert.equal(r.status, 413);
    r = await fetch(`${base}/faucet/maker/fill`, { method: 'POST', body: JSON.stringify({ quoteId: 'f'.repeat(32), payload: 'aa', offer: { exitOpening: { value: '1', blinding: '0x01' }, payoutScriptPubKey: '00' } }) });
    assert.equal(r.status, 404);
    assert.match((await r.json()).error, /no such quote/);
    const o = await userOffer(q);
    r = await fetch(`${base}/faucet/maker/fill`, { method: 'POST', headers: { Origin: 'https://tacit.finance' }, body: JSON.stringify({ quoteId: o.quoteId, payload: o.payload, offer: o.offer }) });
    assert.equal(r.status, 200);
    assert.match((await r.json()).txid, /^[0-9a-f]{64}$/);
    r = await fetch(`${base}/faucet/status`);
    assert.equal((await r.json()).maker.fills_total, 1);
  } finally {
    server.close();
  }
});

console.log(`\n${passed} passed`);
