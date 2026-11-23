// The tool that moves TAC paid privately to the reverse side's tacit1 address onto its plain address (tools/fastbridge-lp-reverse-normalize.mjs): which notes it finds
// and which it leaves, what it refuses and says, that its confirm token covers what is spent and where it goes, and that nothing is sent without the token. A fake wallet
// module records what it is asked; no network, no key.
//   node tests/fastbridge-lp-reverse-normalize.test.mjs        (Node 22)

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { planMove, moveToken, executeMove, describePlan, tacText, TAC } from '../tools/fastbridge-lp-reverse-normalize.mjs';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const ONE = 10n ** 8n;
const T1 = 'a1'.repeat(32), T2 = 'b2'.repeat(32), DEST = '02' + 'cd'.repeat(32);
const hexOf = (b) => Buffer.from(b).toString('hex');
const note = (txid, vout, amount, { stealth = true, confirmed = true } = {}) => ({ utxo: { txid, vout, value: 546, status: { confirmed } }, amount: BigInt(amount) * ONE, blinding: 7n, ...(stealth ? { stealthTweakedSk: 'ee'.repeat(32) } : {}) });

function fake({ notes = [], coins = [{ txid: 'c0'.repeat(32), vout: 1, value: 17686, status: { confirmed: true } }], discover = async () => ({}), pub = DEST } = {}) {
  const calls = { discover: [], scans: 0, built: [], invalidated: 0 };
  return {
    calls,
    wallet: { pub: Uint8Array.from(Buffer.from(pub, 'hex')), address: () => 'bc1qreverse' },
    DUST: 546,
    discoverStealthFromTxid: async (t, o) => { calls.discover.push([t, o]); return discover(t, o); },
    invalidateHoldingsCache: () => { calls.invalidated++; },
    scanHoldings: async (force) => { calls.scans++; assert.equal(force, true, 'a forced scan: a cached one would miss the new notes'); return new Map([[TAC, { utxos: notes }]]); },
    getUtxos: async () => coins,
    selectSatsUtxosSafe: (utxos) => utxos,
    buildAndBroadcastCXferMulti: async (a) => { calls.built.push(a); return { revealTxid: 'ff'.repeat(32) }; },
  };
}

test('it finds the private notes of that transaction and no others: not another transaction\'s, not a plain note, not another asset\'s', async () => {
  const t = fake({ notes: [note(T1, 0, 3), note(T2, 0, 50), note(T1, 2, 4, { stealth: false })] });
  const plan = await planMove({ tacit: t, txid: T1, destPubHex: DEST });
  assert.deepEqual(plan.inputs, [{ txid: T1, vout: 0, value: 546, amount: String(3n * ONE) }], 'only the private note of the transaction named');
  assert.equal(plan.total, String(3n * ONE)); assert.equal(plan.destPubHex, DEST); assert.equal(plan.entries.length, 1);
  assert.deepEqual(t.calls.discover, [[T1, { merge: true }]], 'the transaction was read as a private payment, once');
  assert.equal(t.calls.scans, 1); assert.equal(t.calls.invalidated, 1);
  assert.deepEqual(plan.fee, { coins: 1, sats: 17686 }); assert.equal(plan.pending, 0);
  assert.equal(t.calls.built.length, 0, 'planning sends nothing');
});

test('several private notes of one transaction are moved together, and one not confirmed yet is left alone and said', async () => {
  const t = fake({ notes: [note(T1, 0, 3), note(T1, 1, 2), note(T1, 3, 9, { confirmed: false })] });
  const plan = await planMove({ tacit: t, txid: T1, destPubHex: DEST });
  assert.equal(plan.total, String(5n * ONE)); assert.equal(plan.inputs.length, 2); assert.equal(plan.pending, 1);
  assert.match(describePlan(plan, 'bc1qreverse'), /1 more note from that transaction not confirmed yet, left alone/);
});

test('what it refuses, in words: a txid that is not one, a transaction that cannot be read, nothing found, an already plain note, and one not confirmed', async () => {
  const msg = async (o, txid = T1) => (await planMove({ tacit: fake(o), txid, destPubHex: DEST }).then(() => null, (e) => e.message));
  assert.match(await msg({}, 'xyz'), /64-hex id/); assert.match(await msg({}, T1.toUpperCase()), /64-hex id/, 'lower case, as ids are written');
  assert.match(await msg({ discover: async () => { throw new Error('tx not found'); } }), /could not be read as a private payment to this key: tx not found/);
  assert.match(await msg({ notes: [note(T2, 0, 5)] }), /no TAC from that transaction was found for this key/);
  assert.match(await msg({ notes: [note(T1, 0, 5, { stealth: false })] }), /already a plain note at the reverse address: there is nothing to move/);
  assert.match(await msg({ notes: [note(T1, 0, 5, { confirmed: false })] }), /has not confirmed yet/);
  assert.match(await msg({ notes: [{ ...note(T1, 0, 0) }] }), /hold no TAC/);
});

test('the fee coins are counted as confirmed plain coins only, and said when there are none', async () => {
  const none = await planMove({ tacit: fake({ notes: [note(T1, 0, 3)], coins: [{ txid: 'c1'.repeat(32), vout: 0, value: 20000, status: { confirmed: false } }, { txid: 'c2'.repeat(32), vout: 0, value: 546, status: { confirmed: true } }] }), txid: T1, destPubHex: DEST });
  assert.deepEqual(none.fee, { coins: 0, sats: 0 }, 'an unconfirmed coin and a note-sized one are not fee coins');
  assert.match(describePlan(none, 'bc1qreverse'), /NONE: wait for the sats to confirm first/);
  const two = await planMove({ tacit: fake({ notes: [note(T1, 0, 3)], coins: [{ txid: 'c1'.repeat(32), vout: 0, value: 5000, status: { confirmed: true } }, { txid: 'c2'.repeat(32), vout: 1, value: 7000, status: { confirmed: true } }] }), txid: T1, destPubHex: DEST });
  assert.deepEqual(two.fee, { coins: 2, sats: 12000 });
  const throws = fake({ notes: [note(T1, 0, 3)] }); throws.getUtxos = async () => { throw new Error('explorer refused'); };
  assert.equal((await planMove({ tacit: throws, txid: T1, destPubHex: DEST })).fee.coins, 0, 'coins that cannot be read are none, and it still plans: the send then refuses');
});

test('the token covers the notes spent, what they hold, the asset and the destination: any change is another token', async () => {
  const base = await planMove({ tacit: fake({ notes: [note(T1, 0, 3)] }), txid: T1, destPubHex: DEST });
  const t0 = moveToken(base);
  assert.match(t0, /^[0-9a-f]{10}$/); assert.equal(moveToken(base), t0, 'the same plan, the same token');
  const other = (o) => moveToken({ ...base, ...o });
  assert.notEqual(other({ destPubHex: '03' + 'cd'.repeat(32) }), t0, 'another destination');
  assert.notEqual(other({ total: String(4n * ONE) }), t0, 'another amount');
  assert.notEqual(other({ inputs: [{ ...base.inputs[0], vout: 1 }] }), t0, 'another note');
  assert.notEqual(other({ inputs: [{ ...base.inputs[0], amount: String(4n * ONE) }] }), t0, 'another amount in a note');
  assert.notEqual(other({ asset: 'ab'.repeat(32) }), t0, 'another asset');
  assert.equal(other({ fee: { coins: 9, sats: 9 }, pending: 4 }), t0, 'the fee coins and what waits are not what is spent');
});

test('sending: only with the token, only from the reverse key, only with a fee coin; then one transfer of the whole of it to that key', async () => {
  const mk = async (o) => { const t = fake({ notes: [note(T1, 0, 3), note(T1, 1, 2)], ...o }); return { t, plan: await planMove({ tacit: t, txid: T1, destPubHex: DEST }) }; };
  const run = (t, plan, token) => executeMove({ tacit: t, plan, token, bytesToHex: hexOf }).then((v) => ({ ok: v }), (e) => ({ err: e.message }));
  let { t, plan } = await mk();
  for (const bad of [undefined, '', 'nope', moveToken(plan).toUpperCase()]) { const r = await run(t, plan, bad); assert.match(r.err, /confirm token is not the one for this plan/, String(bad)); }
  assert.equal(t.calls.built.length, 0, 'no token, nothing built');
  ({ t, plan } = await mk({ pub: '03' + 'ab'.repeat(32) }));
  assert.match((await run(t, plan, moveToken(plan))).err, /open wallet is not the reverse key: nothing was sent/); assert.equal(t.calls.built.length, 0);
  ({ t, plan } = await mk({ coins: [] }));
  assert.match((await run(t, plan, moveToken(plan))).err, /no confirmed plain-sat coin at the reverse address/); assert.equal(t.calls.built.length, 0);
  ({ t, plan } = await mk());
  const r = await run(t, plan, moveToken(plan));
  assert.equal(r.ok, 'ff'.repeat(32)); assert.equal(t.calls.built.length, 1, 'one transfer');
  const a = t.calls.built[0];
  assert.equal(a.assetIdHex, TAC); assert.deepEqual(a.recipients, [{ pubHex: DEST, amount: 5n * ONE }], 'the whole of it, to the reverse key');
  assert.deepEqual(a.forceUtxos.map((u) => [u.utxo.txid, u.utxo.vout]), [[T1, 0], [T1, 1]], 'spending exactly the notes the plan named');
});

test('what the tool says: amounts as TAC, and nothing that reads as having been sent while it is only a plan', () => {
  assert.equal(tacText(String(3n * ONE)), '3'); assert.equal(tacText(String(ONE / 2n)), '0.5'); assert.equal(tacText('1234567890'), '12.3456789');
  const src = readFileSync(new URL('../tools/fastbridge-lp-reverse-normalize.mjs', import.meta.url), 'utf8');
  const main = src.slice(src.indexOf('async function main()'));
  assert.ok(main.indexOf("process.argv.includes('--send')") > -1 && main.indexOf("process.argv.includes('--send')") < main.indexOf('executeMove({'), 'the send is only reached after the --send check, which exits for a plan');
  assert.match(main, /nothing was sent\. To move it/);
  assert.doesNotMatch(main, /arg\('--(to|dest|address|pub)/, 'the destination is never taken from the command line');
  assert.match(main, /destPubHex = bytesToHex\(prims\.wallet\.pub\)/, 'it is the reverse key\'s own public key');
});

let passed = 0;
for (const [name, fn] of tests) { try { await fn(); passed++; console.log(`  ok - ${name}`); } catch (e) { console.log(`  FAIL - ${name}\n${e.stack}`); process.exitCode = 1; } }
console.log(`\n${passed}/${tests.length} reverse normalize checks passed`);
process.exit(process.exitCode || 0);
