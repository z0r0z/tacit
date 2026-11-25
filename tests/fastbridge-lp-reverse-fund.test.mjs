// The tool that funds the reverse side from the provider's main address (tools/fastbridge-lp-reverse-fund.mjs): what it exposes to the wallet and what it refuses, that the
// wallet's view of the address holds only the outputs named, which note it spends, what the confirm token covers, and what a silent and a plain send are built as. A fake
// wallet module and a fake explorer record what they are asked; no network, no key.
//   node tests/fastbridge-lp-reverse-fund.test.mjs        (Node 22)

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseTac, parseOutpoint, exposeOutpoints, viewFetch, planFund, fundToken, executeFund, describeFund, tacText, TAC, COIN_MIN, COIN_MAX } from '../tools/fastbridge-lp-reverse-fund.mjs';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const ONE = 10n ** 8n;
const HOUSE = 'bc1qhouse', OTHER = 'bc1qother';
const id = (c) => c.repeat(64);
const N1 = { txid: id('a'), vout: 0 }, N2 = { txid: id('b'), vout: 1 }, COIN = { txid: id('c'), vout: 3 };

// a fake explorer: txs by id
function explorer(txs, spent = {}) {
  const calls = [];
  const getJson = async (p) => {
    calls.push(p);
    let m = /^\/tx\/([0-9a-f]{64})\/outspend\/(\d+)$/.exec(p);
    if (m) { const k = `${m[1]}:${m[2]}`; return k in spent ? spent[k] : { spent: false }; }
    m = /^\/tx\/([0-9a-f]{64})$/.exec(p);
    return m ? txs[m[1]] || null : null;
  };
  return { getJson, calls };
}
const tx = (outs, confirmed = true) => ({ vout: outs.map(([value, address]) => ({ value, scriptpubkey_address: address })), status: confirmed ? { confirmed: true, block_height: 900000, block_hash: 'h', block_time: 1700000000 } : { confirmed: false } });
const world = (over = {}) => explorer({ [N1.txid]: tx([[546, HOUSE]]), [N2.txid]: tx([[0, 'x'], [546, HOUSE]]), [COIN.txid]: tx([[1, 'x'], [1, 'x'], [1, 'x'], [3546, HOUSE]]), ...over });

test('amounts and outpoints are read strictly: TAC to eight places and at most 25, outpoints as a 64-hex id and an output number', () => {
  assert.equal(parseTac('3'), 3n * ONE); assert.equal(parseTac('2.5'), 250000000n); assert.equal(parseTac('0.00000001'), 1n); assert.equal(parseTac('25'), 25n * ONE);
  for (const bad of ['', 'x', '0', '0.0', '-1', '1,5', '26', '1000', '1.123456789', ' 3', null, undefined]) assert.throws(() => parseTac(bad), /--tac/, String(bad));
  assert.deepEqual(parseOutpoint(`${id('a')}:2`, '--note'), { txid: id('a'), vout: 2 }); assert.deepEqual(parseOutpoint(`${id('A')}:0`, '--note'), { txid: id('a'), vout: 0 }, 'lower case');
  for (const bad of ['', id('a'), `${id('a')}:`, `${id('a')}:x`, `xyz:0`, `${id('a')}:1:2`, null]) assert.throws(() => parseOutpoint(bad, '--coin'), /--coin must be/, String(bad));
  assert.equal(tacText(String(3n * ONE)), '3'); assert.equal(tacText('150000000'), '1.5');
});

test('what it exposes: the named outputs as the explorer shows them, only if they are the main address\'s, unspent, confirmed, and the right kind', async () => {
  const w = world();
  const e = await exposeOutpoints({ getJson: w.getJson, address: HOUSE, notes: [N1, N2], coin: COIN });
  assert.deepEqual(e.utxos.map((u) => [u.txid.slice(0, 1), u.vout, u.value]), [['a', 0, 546], ['b', 1, 546], ['c', 3, 3546]]);
  assert.deepEqual(e.utxos[0].status, { confirmed: true, block_height: 900000, block_hash: 'h', block_time: 1700000000 }); assert.deepEqual(e.coin, e.utxos[2]);
  const refused = async (over, o = {}) => exposeOutpoints({ getJson: explorer({ [N1.txid]: tx([[546, HOUSE]]), [COIN.txid]: tx([[1, 'x'], [1, 'x'], [1, 'x'], [3546, HOUSE]]), ...over.txs }, over.spent).getJson, address: HOUSE, notes: [N1], coin: COIN, ...o }).then(() => null, (x) => x.message);
  assert.match(await refused({ txs: { [N1.txid]: tx([[546, OTHER]]) } }), /note aaaaaaaaaaaa….* is not at the main address/);
  assert.match(await refused({ txs: { [COIN.txid]: tx([[1, 'x'], [1, 'x'], [1, 'x'], [3546, OTHER]]) } }), /coin cccccccccccc….* is not at the main address/);
  assert.match(await refused({ spent: { [`${N1.txid}:0`]: { spent: true, txid: 'z' } } }), /note aaaaaaaaaaaa….* is already spent/);
  assert.match(await refused({ spent: { [`${COIN.txid}:3`]: null } }), /coin cccccccccccc….* is not known to be unspent/);
  assert.match(await refused({ txs: { [N1.txid]: tx([[546, HOUSE]], false) } }), /note aaaaaaaaaaaa….* has not confirmed yet/);
  assert.match(await refused({ txs: { [N1.txid]: tx([[5000, HOUSE]]) } }), /is 5000 sats: a TAC note is note-sized/);
  assert.match(await refused({ txs: { [N1.txid]: null } }), /not an output of that transaction/);
  assert.match(await refused({}, { notes: [{ txid: N1.txid, vout: 7 }] }), /not an output of that transaction/);
  assert.match(await refused({}, { notes: [] }), /name at least one TAC note/);
  assert.match(await refused({}, { notes: [{ txid: COIN.txid, vout: 3 }] }), /(is 3546 sats: a TAC note is note-sized|also named as a note)/, 'a coin cannot be a note');
});

test('the second explorer read requires literal confirmation, integer values and an integer confirmation height', async () => {
  const malformed = async (change, expected) => {
    const bad = tx([[546, HOUSE]]); change(bad);
    const w = explorer({ [N1.txid]: bad, [COIN.txid]: tx([[1, 'x'], [1, 'x'], [1, 'x'], [3546, HOUSE]]) });
    await assert.rejects(() => exposeOutpoints({ getJson: w.getJson, address: HOUSE, notes: [N1], coin: COIN }), expected);
  };
  await malformed((t) => { t.vout[0].value = '546'; }, /invalid output value/);
  await malformed((t) => { t.vout[0].value = -1; }, /invalid output value/);
  await malformed((t) => { t.status.confirmed = 1; }, /has not confirmed yet/);
  await malformed((t) => { t.status.block_height = '900000'; }, /no valid confirmation height/);
  await malformed((t) => { delete t.status.block_height; }, /no valid confirmation height/);
});

test('the coin that pays the fee must be a leftover one: not a swap\'s 2,046, not the maker\'s 48k or 1.2M', async () => {
  for (const [value, ok] of [[2046, false], [COIN_MIN - 1, false], [COIN_MIN, true], [3546, true], [COIN_MAX, true], [COIN_MAX + 1, false], [48438, false], [1213436, false], [546, false]]) {
    const w = explorer({ [N1.txid]: tx([[546, HOUSE]]), [COIN.txid]: tx([[1, 'x'], [1, 'x'], [1, 'x'], [value, HOUSE]]) });
    const r = await exposeOutpoints({ getJson: w.getJson, address: HOUSE, notes: [N1], coin: COIN }).then(() => 'ok', (e) => e.message);
    assert.equal(r === 'ok', ok, `${value} sats: ${r}`);
    if (!ok) assert.match(r, /fee coin must be 3000 to 20000/);
  }
});

test('the wallet\'s view of the address is exactly the outputs named: its utxo list is replaced, every other read goes through', async () => {
  const seen = [];
  const real = async (input) => { seen.push(String((input && input.url) || input)); return new Response('"real"', { status: 200 }); };
  const utxos = [{ txid: id('a'), vout: 0, value: 546, status: { confirmed: true } }];
  const f = viewFetch(real, HOUSE, utxos);
  for (const url of [`https://mempool.space/api/address/${HOUSE}/utxo`, `https://blockstream.info/api/address/${HOUSE}/utxo?x=1`]) { const r = await f(url); assert.deepEqual(await r.json(), utxos, url); assert.equal(r.status, 200); }
  assert.equal(seen.length, 0, 'the list was answered here, not by an explorer');
  for (const url of [`https://mempool.space/api/address/${OTHER}/utxo`, `https://mempool.space/api/address/${HOUSE}/txs`, `https://mempool.space/api/address/${HOUSE}`, `https://mempool.space/api/tx/${id('a')}`, `https://mempool.space/api/address/${HOUSE}/utxo/extra`, `https://x/${HOUSE}/utxo`]) assert.equal(await (await f(url)).json(), 'real', url);
  assert.equal(seen.length, 6, 'all of those went through');
  assert.equal(await (await f(new Request(`https://mempool.space/api/address/${HOUSE}/utxo`))).json().then((j) => j.length), 1, 'a Request object is read the same way');
  // the history pages of a script, which the wallet reads for its cBTC lock reservations, are answered empty; other scripthash reads are not
  const h = 'ab'.repeat(32), seenBefore = seen.length;
  for (const url of [`https://mempool.space/api/scripthash/${h}/txs`, `https://mempool.space/api/scripthash/${h}/txs/chain/${id('c')}`, `https://blockstream.info/api/scripthash/${h}/txs?x=1`]) assert.deepEqual(await (await f(url)).json(), [], url);
  assert.equal(seen.length, seenBefore, 'those were answered here');
  for (const url of [`https://mempool.space/api/scripthash/${h}/utxo`, `https://mempool.space/api/scripthash/${h}`, `https://mempool.space/api/scripthash/${h}/txs/mempool`, `https://mempool.space/api/scripthash/zz/txs`, `https://mempool.space/api/address/${HOUSE}/txs`]) assert.equal(await (await f(url)).json(), 'real', url);
});

// a fake wallet module whose scan finds the notes it is given
const entry = (n, amount, extra = {}) => ({ utxo: { txid: n.txid, vout: n.vout, value: 546, status: { confirmed: true } }, amount: BigInt(amount) * ONE, blinding: 5n, ...extra });
function walletFake(found, { failScans = 0 } = {}) {
  const calls = { scans: 0, built: [], invalidated: 0 };
  return { calls, wallet: { pub: Uint8Array.from([2, 1]) },
    invalidateHoldingsCache: () => { calls.invalidated++; },
    scanHoldings: async (force) => { calls.scans++; assert.equal(force, true); if (calls.scans <= failScans) throw new Error('Holdings scan exceeded 90s'); return new Map([[TAC, { utxos: found }]]); },
    buildAndBroadcastCXferMulti: async (a) => { calls.built.push(a); return { revealTxid: 'ee'.repeat(32) }; } };
}
const exposedOf = async (notes = [N1, N2]) => exposeOutpoints({ getJson: world().getJson, address: HOUSE, notes, coin: COIN });

test('it spends the smallest named note that covers the amount, and only a named one that is a plain, valid TAC note; the rest of it is change', async () => {
  const ex = await exposedOf();
  const other = { txid: id('d'), vout: 0 };
  const t = walletFake([entry(N1, 30), entry(N2, 12), entry(other, 4), entry({ txid: id('e'), vout: 0 }, 50, {})]);
  const plan = await planFund({ tacit: t, amount: 5n * ONE, exposed: ex, destination: 'tcs1xyz', mode: 'silent', houseAddress: HOUSE });
  assert.deepEqual(plan.note, { txid: N2.txid, vout: 1, amount: String(12n * ONE) }, 'the 12 (not the 30; not the 4, which is not named; not the 50, which is not named)');
  assert.equal(plan.change, String(7n * ONE)); assert.equal(plan.amount, String(5n * ONE)); assert.deepEqual(plan.coin, { txid: COIN.txid, vout: COIN.vout, value: 3546 });
  assert.equal(t.calls.built.length, 0, 'planning sends nothing');
  // a note that is NOT named is never spent, even when it is the smallest that covers the amount
  const sneaky = await planFund({ tacit: walletFake([entry(N1, 30), entry(N2, 12), entry({ txid: id('f'), vout: 0 }, 6)]), amount: 5n * ONE, exposed: ex, destination: 'd', mode: 'plain', houseAddress: HOUSE });
  assert.deepEqual([sneaky.note.txid, sneaky.note.amount], [N2.txid, String(12n * ONE)], 'the unnamed 6 would cover it and is not used');
  for (const skipped of [[entry(N1, 30, { stealthTweakedSk: 'ee' })], [entry(N1, 0)], []]) {
    const r = await planFund({ tacit: walletFake(skipped), amount: ONE, exposed: ex, destination: 'd', mode: 'plain', houseAddress: HOUSE }).then(() => null, (e) => e.message);
    assert.match(r, /none of the named outputs is a TAC note/);
  }
  assert.match(await planFund({ tacit: walletFake([entry(N1, 3)]), amount: 5n * ONE, exposed: ex, destination: 'd', mode: 'plain', houseAddress: HOUSE }).then(() => null, (e) => e.message), /none of the named notes holds 5 TAC \(the largest holds 3\)/);
});

test('a scan that runs out of time is asked again, and given up on after its tries', async () => {
  const ex = await exposedOf(), sleeps = [];
  const slow = walletFake([entry(N1, 10)], { failScans: 2 });
  const plan = await planFund({ tacit: slow, amount: ONE, exposed: ex, destination: 'd', mode: 'plain', houseAddress: HOUSE, sleep: async (ms) => { sleeps.push(ms); } });
  assert.equal(plan.note.amount, String(10n * ONE)); assert.equal(slow.calls.scans, 3); assert.deepEqual(sleeps, [20000, 20000]); assert.equal(slow.calls.invalidated, 3);
  const never = walletFake([entry(N1, 10)], { failScans: 99 });
  const r = await planFund({ tacit: never, amount: ONE, exposed: ex, destination: 'd', mode: 'plain', houseAddress: HOUSE, scanTries: 3, sleep: async () => {} }).then(() => null, (e) => e.message);
  assert.match(r, /the notes could not be read: Holdings scan exceeded 90s/); assert.equal(never.calls.scans, 3);
});

test('the token covers the note, the amount, the destination, the mode and the fee coin: any change is another token', async () => {
  const ex = await exposedOf();
  const plan = await planFund({ tacit: walletFake([entry(N1, 10)]), amount: 3n * ONE, exposed: ex, destination: 'tcs1abc', mode: 'silent', houseAddress: HOUSE });
  const t0 = fundToken(plan); assert.match(t0, /^[0-9a-f]{10}$/); assert.equal(fundToken(plan), t0);
  const other = (o) => fundToken({ ...plan, ...o });
  assert.notEqual(other({ amount: String(4n * ONE) }), t0); assert.notEqual(other({ destination: 'tcs1abd' }), t0); assert.notEqual(other({ mode: 'plain' }), t0);
  assert.notEqual(other({ note: { ...plan.note, vout: 1 } }), t0); assert.notEqual(other({ note: { ...plan.note, amount: '1' } }), t0); assert.notEqual(other({ coin: { ...plan.coin, vout: 0 } }), t0);
  assert.notEqual(other({ houseAddress: OTHER }), t0);
  assert.equal(other({ change: '1', entry: {} }), t0, 'the change and the opened entry follow from the rest');
  assert.match(describeFund(plan), /spend the note aaaaaaaaaaaa….*\n.*send 3 TAC silently, to the reverse tcs1 address.*\nreturn 7 TAC to the main address as change\npay the miner fee from the coin cccccccccccc…:3 \(3546 sats/);
});

test('sending: only with the token, only from the provider key; silent is a send to the tcs1 address and plain a send to the key, both spending exactly the planned note', async () => {
  const ex = await exposedOf();
  const mk = async (mode, destination) => { const t = walletFake([entry(N1, 10)]); return { t, plan: await planFund({ tacit: t, amount: 3n * ONE, exposed: ex, destination, mode, houseAddress: HOUSE }) }; };
  const run = (t, plan, o) => executeFund({ tacit: t, plan, ownPubHex: '0201', expectPubHex: '0201', ...o }).then((v) => ({ ok: v }), (e) => ({ err: e.message }));
  let { t, plan } = await mk('silent', 'tcs1abc');
  for (const bad of [undefined, '', 'nope', fundToken(plan).toUpperCase()]) assert.match((await run(t, plan, { token: bad })).err, /confirm token is not the one for this plan/, String(bad));
  assert.match((await run(t, plan, { token: fundToken(plan), ownPubHex: '0309' })).err, /open wallet is not the provider key: nothing was sent/);
  assert.equal(t.calls.built.length, 0, 'nothing built without the token and the key');
  assert.equal((await run(t, plan, { token: fundToken(plan) })).ok, 'ee'.repeat(32));
  assert.deepEqual(t.calls.built[0].recipients, [{ stealthAddress: 'tcs1abc', amount: 3n * ONE }]); assert.equal(t.calls.built[0].assetIdHex, TAC);
  assert.deepEqual(t.calls.built[0].forceUtxos.map((u) => [u.utxo.txid, u.utxo.vout]), [[N1.txid, 0]]);
  ({ t, plan } = await mk('plain', '02' + 'cd'.repeat(32)));
  assert.equal((await run(t, plan, { token: fundToken(plan) })).ok, 'ee'.repeat(32));
  assert.deepEqual(t.calls.built[0].recipients, [{ pubHex: '02' + 'cd'.repeat(32), amount: 3n * ONE }]);
});

test('executeFund forwards an exact accepted rate and ceiling, while legacy plans add no fee arguments', async () => {
  const ex = await exposedOf([N1]);
  const boundedWallet = walletFake([entry(N1, 10)]);
  const bounded = await planFund({ tacit: boundedWallet, amount: 3n * ONE, exposed: ex, destination: '02' + 'cd'.repeat(32), mode: 'plain', houseAddress: HOUSE });
  bounded.feeRate = 3.25; bounded.maxFeeRate = 4;
  await executeFund({ tacit: boundedWallet, plan: bounded, token: fundToken(bounded), ownPubHex: '0201', expectPubHex: '0201' });
  assert.equal(boundedWallet.calls.built[0].feeRate, 3.25);
  assert.equal(boundedWallet.calls.built[0].maxFeeRate, 4);
  const legacyWallet = walletFake([entry(N1, 10)]);
  const legacy = await planFund({ tacit: legacyWallet, amount: 3n * ONE, exposed: ex, destination: '02' + 'cd'.repeat(32), mode: 'plain', houseAddress: HOUSE });
  await executeFund({ tacit: legacyWallet, plan: legacy, token: fundToken(legacy), ownPubHex: '0201', expectPubHex: '0201' });
  assert.equal('feeRate' in legacyWallet.calls.built[0], false);
  assert.equal('maxFeeRate' in legacyWallet.calls.built[0], false);
});

test('the source: nothing is sent before --send, the destination is never taken from the command line, silent is the default, and the key is not kept in the environment', () => {
  const src = readFileSync(new URL('../tools/fastbridge-lp-reverse-fund.mjs', import.meta.url), 'utf8');
  const main = src.slice(src.indexOf('async function main()'));
  assert.ok(main.indexOf("process.argv.includes('--send')") > -1 && main.indexOf("process.argv.includes('--send')") < main.indexOf('executeFund({'), 'the send comes after the --send check, which exits for a plan');
  assert.match(main, /nothing was sent\. To send it/);
  assert.doesNotMatch(main, /arg\('--(to|dest|address|pub|recipient)/);
  assert.match(main, /arg\('--mode'\) \|\| 'silent'/); assert.match(main, /delete process\.env\.FB_LP_KEY/);
  assert.match(main, /destination = mode === 'plain' \? bytesToHex\(rev\.wallet\.pub\) : tacit\.encodeStealthAddress\(\{ network: 'mainnet', recipientPub: rev\.wallet\.pub \}\)/, 'from the reverse key itself');
  assert.match(main, /globalThis\.fetch = viewFetch\(/);
});

let passed = 0;
for (const [name, fn] of tests) { try { await fn(); passed++; console.log(`  ok - ${name}`); } catch (e) { console.log(`  FAIL - ${name}\n${e.stack}`); process.exitCode = 1; } }
console.log(`\n${passed}/${tests.length} reverse funding checks passed`);
process.exit(process.exitCode || 0);
