// "To sats" sale keys (dapp/sats/secret.js saleKey, saleKeys, exitToSaleKey): shielded TAC leaves the pool through the
// relay to a new P2WPKH key of the pool wallet, so the wallet's own Bitcoin address never funds or signs anything.
// The relay, the explorer and the prover are stubbed; a post from the wallet's address is seen as tacit.wallet.xonly()
// being reached, which broadcastCarrier calls first.
//   node tests/tac-sats-sale-key.test.mjs

import assert from 'node:assert/strict';
import { secp, sha256, ripemd160, bech32, bytesToHex, hexToBytes } from '../dapp/vendor/tacit-deps.min.js';

const realTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...a) => realTimeout(fn, 0, ...a);       // the relay's five-minute wait, at once
const store = new Map();
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };

const secret = await import('../dapp/sats/secret.js');
const { pool } = secret;
const client = secret.poolClientFor('mainnet');
const ASSET = secret.TAC_ASSET_MAINNET;
const pw = secret.poolWalletFor(new Uint8Array(32).fill(7), 'mainnet');
const relayAddr = secret.poolWalletFor(new Uint8Array(32).fill(8), 'mainnet').addressString;

// ── saleKey: a P2WPKH key the wallet can recover, and an address that pays its script ──
const k0 = secret.saleKey(pw, 0), k1 = secret.saleKey(pw, 1);
assert.equal(k0.pub, bytesToHex(secp.getPublicKey(hexToBytes(k0.priv), true)), 'pub is the priv’s point');
assert.equal(k0.scriptPubKey, '0014' + bytesToHex(ripemd160(sha256(hexToBytes(k0.pub)))), 'P2WPKH of that point');
const dec = bech32.decode(k0.address);
assert.equal(dec.prefix, 'bc'); assert.equal(dec.words[0], 0, 'witness version 0, bech32 (not bech32m)');
assert.equal(bytesToHex(bech32.fromWords(dec.words.slice(1))), k0.scriptPubKey.slice(4), 'the address pays the script');
assert.notEqual(k0.address, k1.address, 'one key per counter');
assert.deepEqual(secret.saleKey(pw, 0), k0, 'the same counter gives the same key: recoverable from the backup');
assert.equal(pool.deriveExitKey(pw, 0, 'p2tr').priv.replace(/^0x/, ''), k0.priv, 'P2TR and P2WPKH of one counter share a secret, so a counter serves one script only');
const tbKey = secret.saleKey(secret.poolWalletFor(new Uint8Array(32).fill(7), 'signet'), 0);
assert.ok(tbKey.address.startsWith('tb1q'), 'signet keys are tb1q');

// ── saleKeys: walks the chain for used keys, opens the exits at them, finds the first free counter ──
const API = 'https://esplora.test/api';
const p2trAddr = (c) => secret.p2trAddress(pool.deriveExitKey(pw, c, 'p2tr').scriptPubKey, 'mainnet');
function chain({ wpkh = {}, tr = new Set() } = {}) {
  const seen = [];
  globalThis.fetch = async (url) => {
    const p = String(url).slice(API.length);
    let m;
    const ok = (j) => ({ ok: true, status: 200, json: async () => j });
    if ((m = p.match(/^\/address\/([^/]+)\/utxo$/))) return ok(Object.entries(wpkh).find(([c]) => secret.saleKey(pw, +c).address === m[1])?.[1] || []);
    if ((m = p.match(/^\/address\/([^/]+)$/))) {
      seen.push(m[1]);
      const c = Object.keys(wpkh).find((c) => secret.saleKey(pw, +c).address === m[1]);
      const hit = c != null || [...tr].some((t) => p2trAddr(t) === m[1]);
      return ok({ chain_stats: { tx_count: hit ? 1 : 0 }, mempool_stats: { tx_count: 0 } });
    }
    throw new Error('unexpected fetch ' + url);
  };
  return seen;
}
const recorded = [];
const tx = (id, opcode) => ({ id, opcode });
const tacitScan = {
  NET: { api: API },
  getTx: async (id) => tx(id, id.startsWith('ee') ? 0x6d : 0x39),
  txOutputEnvelope: (t) => ({ opcode: t.opcode, payload: new Uint8Array([1]) }),
  recordOpening: (...a) => recorded.push(a),
};
let wantAddrs = [relayAddr], failOpen = false;
pool.recoverExit = (wallet, payload, notes, opts) => { if (failOpen && payload[0] === 2) throw new Error('btc-pool: exit opening not recovered'); assert.equal(wallet, pw); assert.ok(Array.isArray(notes)); assert.deepEqual(opts?.addresses, wantAddrs, 'the relay’s address opens the fee note'); return { exitVout: 1, value: '250000000', blinding: '0x' + '05'.padStart(64, '0') }; };

{
  const seen = chain({
    wpkh: { 0: [
      { txid: 'ee'.repeat(32), vout: 1, value: 546, status: { confirmed: true } },   // a take-out
      { txid: 'ee'.repeat(31) + 'ef', vout: 0, value: 546, status: { confirmed: false } },   // an exit at another output than the one it opens
      { txid: '39'.repeat(32), vout: 1, value: 546, status: { confirmed: true } },   // not a pool exit
    ] },
    tr: new Set([1]),
  });
  recorded.length = 0;
  const r = await secret.saleKeys(tacitScan, pw, [], ASSET, { addresses: [relayAddr] });
  assert.equal(r.keys.length, 1);
  assert.equal(r.keys[0].counter, 0);
  assert.deepEqual(r.keys[0].notes, [{ txid: 'ee'.repeat(32), vout: 1, value: 250000000n, blinding: 5n, confirmed: true }]);
  assert.deepEqual(recorded, [['ee'.repeat(32), 1, ASSET, 250000000n, 5n]], 'the opening is recorded for the holdings scan');
  assert.equal(r.free, 2, 'counter 1 is skipped: its P2TR key has history');
  assert.ok(seen.includes(secret.saleKey(pw, 7).address) && !seen.includes(secret.saleKey(pw, 8).address), 'six quiet counters end the walk');
  assert.deepEqual(r.unread, [], 'another output of an exit and a coin that is no exit are nothing to report');
}
{
  chain();
  const r = await secret.saleKeys(tacitScan, pw, [], ASSET);
  assert.deepEqual(r, { keys: [], free: 0, unread: [] }, 'a new wallet starts at counter 0');
}
// an output at a sale key the read cannot open is named as unread, never dropped: a transaction that did not load, and a pool
// exit whose opening cannot be rebuilt (its fee note unreadable); the output that does open is still found
{
  chain({ wpkh: { 0: [
    { txid: 'ee'.repeat(32), vout: 1, value: 546, status: { confirmed: true } },
    { txid: 'aa'.repeat(32), vout: 0, value: 546, status: { confirmed: true } },
    { txid: 'bb'.repeat(32), vout: 1, value: 546, status: { confirmed: true } },
    { txid: '39'.repeat(32), vout: 1, value: 546, status: { confirmed: true } },
  ] } });
  const scan = {
    ...tacitScan,
    getTx: async (id) => { if (id.startsWith('aa')) throw new Error('explorer 429'); return tx(id, /^(ee|bb)/.test(id) ? 0x6d : 0x39); },
    txOutputEnvelope: (t) => ({ opcode: t.opcode, payload: new Uint8Array([t.id.startsWith('bb') ? 2 : 1]) }),
  };
  failOpen = true;
  const r = await secret.saleKeys(scan, pw, [], ASSET, { addresses: [relayAddr] });
  failOpen = false;
  assert.deepEqual(r.keys[0].notes.map((n) => n.txid), ['ee'.repeat(32)], 'the output that opens is found');
  assert.deepEqual(r.unread, [{ txid: 'aa'.repeat(32), vout: 0 }, { txid: 'bb'.repeat(32), vout: 1 }], 'the two it could not open are named');
}

// ── a take-out past six unused keys in a row (failed tries each set a key aside for a day) is found from the wallet's own
// spends: the transactions behind its internal notes (change and padding), an exit there to one of its sale keys ──
{
  const realParse = pool.parseSpend;
  pool.parseSpend = (payload) => { if (payload[0] !== 3) throw new Error('btc-pool: not a spend envelope'); return { exit: { exitVout: payload[1] } }; };
  const walletPub = secp.getPublicKey(new Uint8Array(32).fill(9), true);
  const ownSpk = '0014' + bytesToHex(ripemd160(sha256(walletPub)));
  const FAR = 9, spends = {
    ['d1'.repeat(32)]: { opcode: 0x6d, exitVout: 0, vout: [{ scriptpubkey: secret.saleKey(pw, FAR).scriptPubKey }, { scriptpubkey: '0014' + '22'.repeat(20) }] },   // a take-out to key 9
    ['d2'.repeat(32)]: { opcode: 0x6d, exitVout: 1, vout: [{ scriptpubkey: '0014' + '22'.repeat(20) }, { scriptpubkey: ownSpk }] },   // To Bitcoin, to the wallet's own address
    ['d3'.repeat(32)]: { opcode: 0x6e, exitVout: 0, vout: [{ scriptpubkey: secret.saleKey(pw, 12).scriptPubKey }] },   // no exit: not a take-out, whatever it pays
  };
  const utxoReads = [];
  const scan = (fail = null) => ({
    ...tacitScan,
    wallet: { pub: walletPub },
    p2wpkhScript: (pub) => hexToBytes('0014' + bytesToHex(ripemd160(sha256(pub)))),
    getTx: async (id) => {
      if (id === fail) return null;
      const s = spends[id];
      return s ? { id, opcode: s.opcode, payload: new Uint8Array([s.opcode === 0x6d ? 3 : 0, s.exitVout]), vout: s.vout } : tx(id, id.startsWith('ee') ? 0x6d : 0x39);
    },
    txOutputEnvelope: (t) => ({ opcode: t.opcode, payload: t.payload || new Uint8Array([1]) }),
  });
  const watch = () => { const inner = globalThis.fetch; globalThis.fetch = async (url) => { const m = String(url).match(/\/address\/([^/]+)\/utxo$/); if (m) utxoReads.push(m[1]); return inner(url); }; };
  const notes = [
    { nf: '0x01', spent: true, txid: 'aa'.repeat(32), value: 98700000000n },                 // a shield's note, spent
    { nf: '0x02', spent: false, internal: true, txid: 'd1'.repeat(32), value: 0n },           // the take-out's padding
    { nf: '0x03', spent: false, internal: true, txid: 'd1'.repeat(32), value: 0n },
    { nf: '0x04', spent: false, internal: true, txid: 'd2'.repeat(32), value: 0n },
    { nf: '0x05', spent: false, internal: true, txid: 'd3'.repeat(32), value: 5n },
  ];
  const takeout = { txid: 'ee'.repeat(32), vout: 1, value: 546, status: { confirmed: true } };

  chain({ wpkh: { [FAR]: [takeout] } }); watch(); utxoReads.length = 0;
  const r = await secret.saleKeys(scan(), pw, notes, ASSET, { addresses: [relayAddr] });
  assert.deepEqual(r.keys.map((k) => k.counter), [FAR], 'key 9 is read though the walk stopped at key 5');
  assert.deepEqual(r.keys[0].notes, [{ txid: 'ee'.repeat(32), vout: 1, value: 250000000n, blinding: 5n, confirmed: true }], 'and its TAC is found');
  assert.equal(r.free, 0, 'the next take-out still uses the first free key');
  assert.deepEqual(utxoReads, [secret.saleKey(pw, FAR).address], 'only that key is read: an exit to the wallet’s own address and a spend with no exit are not looked for');
  assert.deepEqual(r.unread, []);

  // the page's balance read: the same lot from the spends alone, with no walk over the keys
  const walked = chain({ wpkh: { [FAR]: [takeout] } }); watch(); utxoReads.length = 0;
  const f = await secret.saleKeysFromSpends(scan(), pw, notes, ASSET, { addresses: [relayAddr] });
  assert.deepEqual(f.keys.map((k) => k.counter), [FAR]);
  assert.deepEqual(f.keys[0].notes, r.keys[0].notes, 'the same lot');
  assert.deepEqual(f.unread, []);
  assert.deepEqual(walked, [], 'no key is asked about one by one');
  assert.deepEqual(utxoReads, [secret.saleKey(pw, FAR).address], 'only the key a spend paid is read');
  let fetched = 0;
  const none = chain(); { const inner = globalThis.fetch; globalThis.fetch = async (u) => { fetched++; return inner(u); }; }
  assert.deepEqual(await secret.saleKeysFromSpends({ ...scan(), getTx: async () => { fetched++; return null; } }, pw, [notes[0]], ASSET), { keys: [], unread: [] }, 'a wallet that never spent in the pool has none');
  assert.equal(fetched, 0, 'and asks nothing to find that out'); assert.deepEqual(none, []);

  // a take-out the walk reaches is read once, not twice
  chain({ wpkh: { 2: [takeout] } }); watch();
  spends['d1'.repeat(32)] = { ...spends['d1'.repeat(32)], vout: [{ scriptpubkey: secret.saleKey(pw, 2).scriptPubKey }] };
  const r2 = await secret.saleKeys(scan(), pw, notes, ASSET, { addresses: [relayAddr] });
  assert.deepEqual(r2.keys.map((k) => k.counter), [2], 'key 2 once');

  // a spend that does not load is a failed read, never "nothing there"
  chain(); watch();
  await assert.rejects(secret.saleKeys(scan('d2'.repeat(32)), pw, notes, ASSET), /Could not read the pool spend d2d2d2d2/, 'a spend that did not load fails the read');
  // a wallet with no internal notes fetches no transaction
  let txReads = 0;
  chain(); watch();
  const quietScan = { ...scan(), getTx: async () => { txReads++; return null; } };
  assert.deepEqual(await secret.saleKeys(quietScan, pw, [notes[0]], ASSET), { keys: [], free: 0, unread: [] });
  assert.equal(txReads, 0, 'no transaction is fetched for a wallet that has made no pool spend');
  pool.parseSpend = realParse;
}

// ── a first explorer that is down or erroring: the dapp's second explorer answers; both down is a failure, not "none" ──
{
  const two = { ...tacitScan, NET: { api: 'https://down.test/api', api2: API } };
  for (const kind of ['throws', '503']) {
    chain();
    const inner = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      if (String(url).startsWith('https://down.test')) {
        if (kind === 'throws') throw new TypeError('fetch failed');
        return { ok: false, status: 503, json: async () => ({}) };
      }
      return inner(url, init);
    };
    assert.deepEqual(await secret.saleKeys(two, pw, [], ASSET, { addresses: [relayAddr] }), { keys: [], free: 0, unread: [] }, `first explorer ${kind}: the second one answers`);
  }
  globalThis.fetch = async () => { throw new TypeError('fetch failed'); };
  await assert.rejects(secret.saleKeys(two, pw, [], ASSET), /fetch failed/, 'no explorer answering is a failed read, never "no take-outs"');
}

// ── exitToSaleKey ──
const NOT_NOW = 'The relay can’t take this one right now. Nothing was sent. Try again in a few minutes.';
const SLOW = 'The relay hasn’t posted it yet and may still. Nothing else was sent; once it posts, the TAC shows here, ready to list.';
const TOTAL = 10_000_000_000n;   // 100 TAC: the 2.5 TAC taken out, the 15 TAC fee and the change
const notes = [{ asset: '0x' + ASSET, value: TOTAL.toString(), nf: '0x01', txid: 'aa'.repeat(32), leafIndex: 0 }];
const FEE = 1500000000n;
let log;
function stub({ fee = FEE, quoteFee = fee, quote = 'ok', submit = [], status = (n) => (n === 2 ? { carrier: 'cc'.repeat(32) } : { state: 'queued' }), wait = null, prove = 'ok' } = {}) {
  log = { quotes: [], submits: 0, statuses: 0, proofs: 0, builds: [], posts: 0, opened: [] };
  client.relayInfo = async () => (fee == null ? null : { fees: { ['0x' + ASSET]: fee.toString() } });
  client.quote = async (body) => {
    log.quotes.push(body);
    if (quote === 'fail') throw new Error('quote table full');
    return { fee: quoteFee.toString(), address: relayAddr, bind: { txid: 'bb'.repeat(32), vout: 0 }, quoteId: 'q' + log.quotes.length, exitVout: 0 };
  };
  client.submit = async () => { const e = submit[log.submits++]; if (e) throw e; return { id: 's1' }; };
  client.relayStatus = async () => status(++log.statuses);
  client.walletNotes = async () => notes;
  client.anchorAndPaths = async (inputs) => (wait ? { wait, tip: 900010 } : { hAnchor: 900000, root: '0x00', notes: inputs, tip: 900010 });
  secret.poolClient.artifactBytes = async () => 0;
  secret.poolClient.system = async () => ({});
  pool.selectInputs = (live) => ({ inputs: live, total: live.reduce((t, x) => t + BigInt(x.value), 0n) });
  pool.buildSpendBody = (a) => { log.builds.push(a); return { exit: { exitVout: a.exit.exitVout, blinding: '0x' + '09'.padStart(64, '0') } }; };
  pool.prove = async () => { log.proofs++; if (prove === 'fail') throw new Error('out of memory while proving'); return { payload: new Uint8Array(4), payloadHex: '00000000' }; };
}
const tacit = { DUST: 546, recordOpening: (...a) => log.opened.push(a), wallet: { pub: new Uint8Array(33), xonly() { log.posts++; throw new Error('SELF_POST'); } } };
const key = secret.saleKey(pw, 3);
const out = (opts = {}) => secret.exitToSaleKey(tacit, { poolWallet: pw, amount: 250000000n, asset: ASSET, key, ...opts });
const declined = (p, msg) => assert.rejects(p, (e) => e.relayDeclined === true && e.said === true && e.message === msg);
const conflict = (exitVout) => Object.assign(new Error('exit_vout is not free in the open carrier; re-sign with exitVout'), { status: 409, body: { exitVout } });

// The relay takes it out: the exit pays the sale key, the relay's fee is a pool output, the bind is the quote's.
stub();
store.clear();
let r = await out();
assert.deepEqual(r, { revealTxid: 'cc'.repeat(32), exitVout: 0, amount: 250000000n, fee: FEE });
assert.deepEqual(log.quotes, [{ asset: '0x' + ASSET, exitScriptPubKey: key.scriptPubKey }], 'the quote names the sale key’s script');
const b = log.builds[0];
assert.deepEqual(b.exit, { exitVout: 0, scriptPubKey: '0x' + key.scriptPubKey, value: 250000000n });
assert.equal(b.outputs.length, 3, 'padded to three pool outputs');
assert.deepEqual(b.outputs[0], { address: relayAddr, value: FEE }, 'the relay’s fee, paid in the pool');
assert.deepEqual(b.outputs.slice(1), [{ address: pw.internalAddress, network: 'mainnet', value: TOTAL - 250000000n - FEE }, { address: pw.internalAddress, network: 'mainnet', value: 0n }], 'change and padding to the internal address');
assert.equal(b.outputs.reduce((t, o) => t + o.value, 0n) + b.exit.value, TOTAL, 'outputs plus the exit are the inputs, exactly');
assert.deepEqual(b.bind, { txid: 'bb'.repeat(32), vout: 0 });
assert.equal(b.wallet, pw, 'change and padding go to the pool wallet');
assert.deepEqual(log.opened, [['cc'.repeat(32), 0, ASSET, 250000000n, 9n]], 'the exit’s opening is recorded under its outpoint');
assert.equal(log.posts, 0, 'nothing from the wallet’s address');
assert.ok(JSON.parse(store.get('tacit-pool-sale-keys-v1'))[pw.addressString.slice(-16)][3] > 0, 'the counter is held');
{
  chain();
  const r2 = await secret.saleKeys(tacitScan, pw, [], ASSET);
  assert.equal(r2.free, 0, 'counters below a held one stay free');
  stub(); store.clear();
  await secret.exitToSaleKey(tacit, { poolWallet: pw, amount: 250000000n, asset: ASSET, key: secret.saleKey(pw, 0) });
  chain();
  assert.equal((await secret.saleKeys(tacitScan, pw, [], ASSET)).free, 1, 'a held counter is skipped until its take-out shows on chain');
}

// No relay, a quote that fails twice, a fee far above the listed one: nothing is proved or posted.
stub({ fee: null }); await declined(out(), NOT_NOW);
assert.equal(log.proofs, 0); assert.equal(log.posts, 0); assert.equal(log.quotes.length, 0);
stub({ quote: 'fail' }); await declined(out(), NOT_NOW);
assert.equal(log.quotes.length, 2, 'asked once more after a moment'); assert.equal(log.proofs, 0); assert.equal(log.posts, 0);
stub({ quoteFee: FEE * 2n }); await assert.rejects(out(), (e) => e.feeMoved === FEE * 2n);
assert.equal(log.proofs, 0);

// The newest note is too young: { wait }, nothing proved.
stub({ wait: 2 });
assert.deepEqual(await out(), { wait: 2, tip: 900010 });
assert.equal(log.proofs, 0);

// The relay's carrier filled the assigned output first: the same spend, re-signed for the output it names.
stub({ submit: [conflict(2)] });
r = await out();
assert.equal(r.exitVout, 2);
assert.deepEqual(log.builds.map((x) => x.exit.exitVout), [0, 2]);
assert.equal(log.proofs, 2); assert.equal(log.submits, 2);
assert.deepEqual(log.opened[0].slice(0, 2), ['cc'.repeat(32), 2]);

// The quote ran out while proving: asked once more, with the same notes.
stub({ submit: [new Error('quote expired')] });
r = await out();
assert.equal(log.quotes.length, 2); assert.equal(log.proofs, 2); assert.equal(r.revealTxid, 'cc'.repeat(32));
assert.equal(log.builds[1].inputs, log.builds[0].inputs, 'the same notes');

// The relay never posts it: ends after its sixty polls, and never from the wallet.
stub({ status: () => ({ state: 'queued' }) });
await declined(out(), SLOW);
assert.equal(log.statuses, 60); assert.equal(log.posts, 0); assert.equal(log.opened.length, 0);

// The relay drops it because the notes are spent elsewhere, or for another reason.
stub({ status: () => ({ state: 'rejected', reason: 'nullifier already spent' }) });
await assert.rejects(out(), /already being spent by another payment/);
stub({ status: () => ({ state: 'dropped', reason: 'anchor expired' }) });
await assert.rejects(out(), /could not post it \(anchor expired\)\. Nothing was sent\./);
assert.equal(log.posts, 0);

// Confirmed with no carrier reported: done, and saleKeys finds the note from the chain.
stub({ status: () => ({ state: 'confirmed' }) });
r = await out();
assert.equal(r.revealTxid, null); assert.equal(log.opened.length, 0);

// A try that sent nothing gives its key back, so the next take-out uses it and the keys stay in order; a try the relay may
// still post, and one that went through, keep it.
{
  const heldNow = () => JSON.parse(store.get('tacit-pool-sale-keys-v1') || '{}')[pw.addressString.slice(-16)]?.[3] != null;
  const busy = Object.assign(new Error('carrier full'), { status: 503, body: { error: 'carrier full' } });
  for (const [what, opts, keeps] of [
    ['a proof that failed', { prove: 'fail' }, false],
    ['the relay refusing it before taking it', { submit: [busy] }, false],
    ['a submit the relay turned down', { submit: [Object.assign(new Error('bad payload'), { status: 400 })] }, false],
    ['a second proof that failed after a conflict', { submit: [conflict(2)], prove: 'fail' }, false],
    ['the quote running out twice', { submit: [new Error('quote expired'), Object.assign(new Error('quote expired'), { status: 410 })] }, false],
    ['the relay dropping it', { status: () => ({ state: 'dropped', reason: 'anchor expired' }) }, false],
    ['its notes spent by another payment', { status: () => ({ state: 'rejected', reason: 'nullifier already spent' }) }, false],
    ['no answer to the submit', { submit: [new TypeError('fetch failed')] }, true],
    ['a server error on the submit', { submit: [Object.assign(new Error('internal error'), { status: 500 })] }, true],
    ['no post within sixty polls', { status: () => ({ state: 'queued' }) }, true],
  ]) {
    stub(opts); store.clear();
    await assert.rejects(out());
    assert.equal(heldNow(), keeps, `${what}: the key is ${keeps ? 'kept' : 'given back'}`);
  }
  stub(); store.clear();
  await out();
  assert.equal(heldNow(), true, 'a take-out that went through keeps its key');
  // giving one key back leaves the others held
  stub(); store.clear();
  await secret.exitToSaleKey(tacit, { poolWallet: pw, amount: 250000000n, asset: ASSET, key: secret.saleKey(pw, 1) });
  stub({ prove: 'fail' });
  await assert.rejects(out());
  const left = JSON.parse(store.get('tacit-pool-sale-keys-v1'))[pw.addressString.slice(-16)];
  assert.deepEqual(Object.keys(left), ['1'], 'key 1, taken, stays held; key 3 is given back');
}

// ── payoutScriptFor: bc1q / bc1p with their own checksums; everything else refused ──
{
  const wpkh = secret.saleKey(pw, 0);
  assert.equal(bytesToHex(secret.payoutScriptFor(wpkh.address)), wpkh.scriptPubKey, 'bc1q… → its P2WPKH script');
  assert.equal(bytesToHex(secret.payoutScriptFor(wpkh.address.toUpperCase())), wpkh.scriptPubKey, 'upper case reads the same');
  const trSpk = pool.deriveExitKey(pw, 0, 'p2tr').scriptPubKey.replace(/^0x/, '');
  assert.equal(bytesToHex(secret.payoutScriptFor(secret.p2trAddress(trSpk, 'mainnet'))), trSpk, 'bc1p… → its P2TR script');
  const wsh = bech32.encode('bc', [0, ...bech32.toWords(new Uint8Array(32).fill(4))]);
  const bad = wpkh.address.slice(0, -1) + (wpkh.address.endsWith('q') ? 'p' : 'q');
  for (const [addr, re] of [[wsh, /bc1q… or bc1p…/], [bad, /did not check out/], [wpkh.address.slice(0, 10) + wpkh.address.slice(10).toUpperCase(), /mixes upper and lower/],
    [tbKey.address, /bc1q… or bc1p…/], ['1BoatSLRHtKNngkdXEeobR76b53LETtpyT', /bc1q… or bc1p…/], ['', /bc1q… or bc1p…/]]) {
    assert.throws(() => secret.payoutScriptFor(addr), re, `refused: ${addr.slice(0, 14)}`);
  }
}

// ── saleQuote: 2% under the cheapest live ask, or under the mark with an empty book ──
{
  const now = Math.floor(Date.now() / 1000);
  const sale = (amountTac, sats, extra = {}) => ({ asset_opening: { amount: String(Math.round(amountTac * 1e8)) }, min_price_sats: sats, expiry: now + 3600, expired: false, ...extra });
  const serve = (sales, mark, ts) => { globalThis.fetch = async (u) => {
    const s = String(u);
    if (s.includes('/preauth-sales')) return { ok: sales != null, json: async () => ({ sales }) };
    return { ok: mark != null, json: async () => ({ mark_price: { unit: mark, ...(ts != null ? { ts } : {}) } }) };
  }; };
  serve([sale(100, 20000), sale(10, 1680), sale(10, 1500, { expired: true }), sale(10, 1000, { expiry: now - 5 })], 170);
  let q = await secret.saleQuote(100000n);
  assert.equal(q.ask, 168, 'the cheapest LIVE ask: expired ones are left out');
  assert.ok(Math.abs(q.unit - 168 * 0.98) < 1e-9, '2% under it');
  assert.equal(q.units, BigInt(Math.ceil(100000 * 1e8 / (168 * 0.98))), 'TAC that sells for exactly the sats');
  serve([], 170);
  q = await secret.saleQuote(100000n);
  assert.equal(q.ask, null); assert.ok(Math.abs(q.unit - 170 * 0.98) < 1e-9, 'an empty book prices off the mark');
  serve(null, null);
  assert.equal(await secret.saleQuote(100000n), null, 'no price, no quote');
  // Faster: under the last trade when that is below the cheapest ask and recent
  serve([sale(10, 1680)], 150, now - 3600);
  q = await secret.saleQuote(100000n, { fast: true });
  assert.ok(Math.abs(q.unit - 150 * 0.98) < 1e-9 && q.basis === 'trade', 'under the last trade, below the cheapest ask');
  assert.equal(q.units, BigInt(Math.ceil(100000 * 1e8 / (150 * 0.98))), 'and it takes more TAC for the same sats');
  q = await secret.saleQuote(100000n);
  assert.ok(Math.abs(q.unit - 168 * 0.98) < 1e-9 && q.basis === 'ask', 'standard is unchanged: under the cheapest ask');
  serve([sale(10, 1680)], 180, now - 3600);
  q = await secret.saleQuote(100000n, { fast: true });
  assert.ok(Math.abs(q.unit - 168 * 0.98) < 1e-9 && q.basis === 'ask', 'a last trade above the cheapest ask leaves it under the ask');
  serve([sale(10, 1680)], 150, now - 8 * 86400);
  q = await secret.saleQuote(100000n, { fast: true });
  assert.ok(Math.abs(q.unit - 168 * 0.98) < 1e-9 && q.basis === 'ask', 'a last trade older than a week is left out');
  serve([sale(10, 1680)], 150);
  q = await secret.saleQuote(100000n, { fast: true });
  assert.equal(q.basis, 'ask', 'a last trade with no time is left out');
  serve([], 150, now - 3600);
  q = await secret.saleQuote(100000n, { fast: true });
  assert.ok(Math.abs(q.unit - 150 * 0.98) < 1e-9 && q.basis === 'trade', 'an empty book prices off the recent trade');
}

// ── lotsToBuy: live, not our own, within the budget, cheapest per TAC first, one of each size and price ──
{
  const now = Math.floor(Date.now() / 1000);
  const mine = new Uint8Array(33).fill(3);
  const lot = (id, tac, sats, extra = {}) => ({ sale_id: id, asset_opening: { amount: String(Math.round(tac * 1e8)) }, min_price_sats: sats, expiry: now + 7200, expired: false, seller_pubkey: '02' + 'aa'.repeat(32), ...extra });
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ sales: [
    lot('a', 145, 30_160), lot('b', 145, 30_160), lot('c', 48, 8_064), lot('d', 4285, 745_714),
    lot('e', 10, 1_000, { expired: true }), lot('f', 10, 1_100, { expiry: now + 60 }), lot('g', 10, 1_200, { seller_pubkey: bytesToHex(mine) }),
  ] }) });
  let r = await secret.lotsToBuy({ wallet: { pub: mine } }, { budget: 90_000 });
  assert.deepEqual(r.lots.map((x) => x.sale_id), ['c', 'a'], 'cheapest per TAC first, within the budget, one of each size and price');
  assert.ok(Math.abs(r.lots[0].unit - 168) < 1e-9);
  assert.equal(r.smallest.sale_id, 'c', 'expired, expiring and our own listings are left out');
  r = await secret.lotsToBuy({ wallet: { pub: mine } }, { budget: 5_000 });
  assert.equal(r.lots.length, 0); assert.equal(r.smallest.sale_id, 'c', 'with nothing affordable it still names the smallest lot');
  r = await secret.lotsToBuy({ wallet: { pub: mine } });
  assert.deepEqual(r.lots.map((x) => x.sale_id), ['c', 'd', 'a'], 'with no budget, the three cheapest per TAC');
  globalThis.fetch = async () => ({ ok: false, json: async () => ({}) });
  assert.equal(await secret.lotsToBuy({ wallet: { pub: mine } }), null, 'no answer from the market, no list');
}

// ── listFromSaleKey: the sale key signs, the wallet's key comes back, the sale key's bytes are wiped ──
{
  const mainPriv = new Uint8Array(32).fill(9), mainPub = new Uint8Array(33).fill(2);
  const k = secret.saleKey(pw, 4), script = secret.payoutScriptFor(secret.saleKey(pw, 5).address);
  let seen = null, invalidated = 0;
  const t = { wallet: { priv: mainPriv, pub: mainPub }, invalidateHoldingsCache: () => { invalidated++; },
    publishPreauthSale: async (o) => { seen = { ...o, pub: bytesToHex(t.wallet.pub), privRef: t.wallet.priv, priv: bytesToHex(t.wallet.priv) }; return { sale_id: 'ab'.repeat(16) }; } };
  const r = await secret.listFromSaleKey(t, { key: k, note: { txid: 'ee'.repeat(32), vout: 1 }, sats: 3300n, expiry: 1234567890, payoutScript: script });
  assert.equal(r.sale_id, 'ab'.repeat(16));
  assert.deepEqual([seen.pub, seen.priv], [k.pub, k.priv], 'signed by the sale key');
  assert.deepEqual([seen.utxoTxid, seen.utxoVout, seen.minPriceSats, seen.expiry], ['ee'.repeat(32), 1, 3300, 1234567890]);
  assert.equal(seen.sellerPayoutScript, script);
  assert.equal(t.wallet.priv, mainPriv); assert.equal(t.wallet.pub, mainPub);
  assert.ok(seen.privRef.every((x) => x === 0), 'the sale key bytes are wiped'); assert.ok(invalidated >= 2);
  t.publishPreauthSale = async () => { throw new Error('market said no'); };
  await assert.rejects(secret.listFromSaleKey(t, { key: k, note: { txid: 'ee'.repeat(32), vout: 1 }, sats: 3300n, expiry: 1, payoutScript: script }), /market said no/);
  assert.equal(t.wallet.priv, mainPriv, 'the key comes back after a refusal too');
}

// ── saleSettlement: unspent, paid to the recipient, or spent some other way ──
{
  const script = secret.payoutScriptFor(secret.saleKey(pw, 6).address), note = { txid: 'ee'.repeat(32), vout: 0 };
  let spend = { spent: false };
  globalThis.fetch = async (u) => ({ ok: true, status: 200, json: async () => spend });
  const t = { NET: { api: API }, getTx: async () => ({ vout: [{ scriptpubkey: '0014' + '11'.repeat(20), value: 546 }, { scriptpubkey: bytesToHex(script), value: 3300 }], status: { confirmed: true } }) };
  assert.equal(await secret.saleSettlement(t, { note, payoutScript: script, sats: 3300n }), null, 'unspent: not yet');
  spend = { spent: true, txid: 'aa'.repeat(32), status: { confirmed: false } };
  assert.deepEqual(await secret.saleSettlement(t, { note, payoutScript: script, sats: 3300n }), { txid: 'aa'.repeat(32), paid: true, confirmed: false });
  assert.equal((await secret.saleSettlement(t, { note, payoutScript: script, sats: 3301n })).paid, false, 'less than the price is not paid');
  assert.equal((await secret.saleSettlement(t, { note, payoutScript: secret.payoutScriptFor(secret.saleKey(pw, 7).address), sats: 1n })).paid, false, 'another script is not paid');
}

// ── shieldFromSaleKey: a sale key's note back into the pool. The sale key signs only its own input and its bytes are wiped; the carrier
// is the wallet's (its coins fund the commit, it signs them); the shield is built for the note's opening and the wallet's pool address.
// A key that does not hold the note, or a note already spent, stops it before anything is proved or sent. ──
{
  const k = secret.saleKey(pw, 8), salePub = hexToBytes(k.pub);
  const p2wpkh = (pub) => Uint8Array.from([0x00, 0x14, ...ripemd160(sha256(pub))]);
  const AMT = 97207564851n, BL = 5n;
  const xy = pool.commitXY(AMT, BL);
  const commitment = secp.ProjectivePoint.fromAffine({ x: BigInt(xy.cx), y: BigInt(xy.cy) }).toRawBytes(true);
  const note = { txid: 'e1'.repeat(32), vout: 0, value: AMT, blinding: BL, confirmed: true };
  let holder = bytesToHex(p2wpkh(salePub)), spent = false;
  globalThis.fetch = async (url) => {
    const p = String(url).slice(API.length);
    const ok = (j) => ({ ok: true, status: 200, json: async () => j });
    if (p === `/tx/${note.txid}`) return ok({ vout: [{ value: 546, scriptpubkey: holder }] });
    if (p === `/tx/${note.txid}/outspend/0`) return ok({ spent });
    throw new Error('unexpected fetch ' + url);
  };
  const walletPriv = new Uint8Array(32).fill(2), walletPub = secp.getPublicKey(walletPriv, true);
  const L = { built: [], proofs: 0, bySale: [], byWallet: [], sent: [] };
  const isCommit = (tx) => tx.outputs.some((o) => o.script.length === 34);
  pool.buildShieldEnvelope = (a) => { L.built.push(a); return { note: { value: a.inputs[0].value, npk: 1n, rho: 1n, cm: '0xcm' } }; };
  pool.prove = async () => { L.proofs++; return { payload: new Uint8Array([0x6c]), payloadHex: '6c' }; };
  secret.poolClient.artifactBytes = async () => 0;
  secret.poolClient.system = async () => ({});
  const t = {
    NET: { api: API }, DUST: 546, TAP_NUMS: new Uint8Array(32),
    wallet: { priv: walletPriv, pub: walletPub, xonly: () => new Uint8Array(32), address: () => 'bc1qwallet' },
    txOutputEnvelope: () => ({ opcode: 0x6d, payload: new Uint8Array(0) }),
    getParentEnvelopeData: async () => ({ assetIdHex: ASSET, commitment }),
    p2wpkhScript: p2wpkh,
    encodeEnvelopeScript: () => new Uint8Array(40), tapLeafHash: () => new Uint8Array(32),
    tweakedOutputKey: () => ({ Q_xonly: new Uint8Array(32), parity: 0 }), p2trScript: () => new Uint8Array(34), controlBlock: () => new Uint8Array(33),
    getFeeRate: async () => 2, feeFor: (vb, rate) => vb * rate, estCommitVb: (n) => 60 + 68 * n,
    getUtxos: async (addr) => { assert.equal(addr, 'bc1qwallet', 'the wallet’s coins fund the carrier'); return [{ txid: 'c1'.repeat(32), vout: 1, value: 20000 }]; },
    selectSatsUtxosSafe: (all) => all, scanHoldings: async () => new Map(),
    signP2wpkhInput: (tx, i) => { L.byWallet.push([isCommit(tx) ? 'commit' : 'reveal', i]); return [new Uint8Array(71), walletPub]; },
    signP2wpkhInputWithKey: (tx, i, v, priv, pub) => { L.bySale.push({ tx, i, v, priv, privHex: bytesToHex(priv), pub: bytesToHex(pub) }); return [new Uint8Array(71), pub]; },
    signTaprootScriptPathInput: () => [new Uint8Array(64)],
    txid: (tx) => (isCommit(tx) ? 'c0'.repeat(32) : 'd0'.repeat(32)),
    serializeTx: () => new Uint8Array(1),
    broadcast: async () => { L.sent.push('commit'); }, broadcastWithRetry: async () => { L.sent.push('reveal'); },
    recordPreauthTakePending: () => {},
  };
  const back = () => secret.shieldFromSaleKey(t, { key: k, note, asset: ASSET, poolWallet: pw });
  const r = await back();
  assert.equal(r.revealTxid, 'd0'.repeat(32));
  assert.deepEqual(L.sent, ['commit', 'reveal']);
  const sh = L.built[0];
  assert.equal(sh.recipientAddress, pw.addressString, 'shielded to the wallet’s own pool address');
  assert.deepEqual([sh.inputs[0].txid, sh.inputs[0].vout, sh.inputs[0].value, sh.inputs[0].blinding], [note.txid, 0, AMT, BL], 'for the note’s opening');
  assert.equal(L.bySale.length, 1, 'the sale key signs once');
  const s = L.bySale[0];
  assert.equal(s.i, 1, 'its own input, after the commit');
  assert.deepEqual([s.tx.inputs[1].txid, s.tx.inputs[1].vout, s.v], [note.txid, 0, 546]);
  assert.deepEqual([s.privHex, s.pub], [k.priv, k.pub], 'with the sale key');
  assert.ok(s.priv.every((x) => x === 0), 'whose bytes are wiped after');
  assert.deepEqual(L.byWallet, [['commit', 0]], 'the wallet signs its own coin in the commit, nothing else');
  assert.deepEqual(s.tx.outputs.map((o) => [o.value, bytesToHex(o.script)]), [[546, bytesToHex(p2wpkh(walletPub))]], 'the carrier pays dust back to the wallet');
  assert.equal(t.wallet.priv, walletPriv, 'the wallet’s key is untouched');
  assert.equal(r.poolNote.value, AMT.toString());

  L.proofs = 0; L.sent.length = 0;
  holder = '0014' + '33'.repeat(20);
  await assert.rejects(back(), /not at this sale key/, 'a key that does not hold the note is refused');
  assert.deepEqual([L.proofs, L.sent.length], [0, 0], 'before a proof or a send');
  holder = bytesToHex(p2wpkh(salePub)); spent = true;
  await assert.rejects(back(), /spent already/, 'a note already spent is refused');
  assert.deepEqual([L.proofs, L.sent.length], [0, 0], 'before a proof or a send');
}

console.log('tac-sats-sale-key: all checks passed');
