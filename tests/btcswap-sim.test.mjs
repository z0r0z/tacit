// The Bitcoin-to-Bitcoin swap (dapp/btcswap*.js) against a simulated Bitcoin on one virtual clock: real transactions, the
// real note validator. The reflection's fold of the desk's lock and the holder's claim is tests/btcswap-reflect.test.mjs.
// The whole swap, and what happens when a side is absent, slow, short of TAC, or not what it says.
//   node tests/btcswap-sim.test.mjs        (Node 22)

import assert from 'node:assert/strict';
import * as X from '../dapp/adaptor-xswap.js';
import * as S from '../dapp/btcswap.js';
import { pedersenCommit } from '../dapp/bulletproofs.js';
import { hexToBytes } from '../dapp/vendor/tacit-deps.min.js';
import { partyKeys } from './lib/chain-sim.mjs';
import { world, HELD } from './lib/btcswap-world.mjs';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('the whole swap: the holder ends with a tracked note, the desk with the holder\'s note, and t is the holder\'s', async () => {
  const w = world();
  await w.start();
  await w.run(async () => (await w.h())?.phase === 'done' && (await w.d())?.phase === 'done');
  const h = await w.h(), d = await w.d();
  const out = HELD - (HELD * 30n) / 10000n - 10n;
  assert.equal(h.deskOffer.lock.amount, String(out), 'the desk locked the amount less its fee');
  const mine = await w.noteOf(h.claim.txid, 0);
  assert.ok(mine, 'the holder\'s claimed note is valid');
  assert.equal(String(mine.assetIdHex).replace(/^0x/, ''), w.asset);
  assert.ok(await w.noteOf(d.take.txid, 0), 'the desk\'s taken note is valid');
  const sec = X.deriveSwapSecrets({ seed: partyKeys('holder').seed, swapId: hexToBytes(h.id) });
  assert.equal(BigInt('0x' + d.t), sec.t, 'the desk read the holder\'s t from the claim');
  // the claim is a one-signature key-path spend of the desk's lock (the reflection's fold of one: tests/btcswap-reflect.test.mjs)
  assert.equal(w.reveals.get(h.claim.txid).inputs[1].witness.length, 1);
  assert.equal(d.sessions.length, 1);
  assert.equal(d.sessions[0].sec, null, 'the desk\'s secret nonce is wiped once used');
});

test('the holder claims ahead of the proof: the desk\'s lock is not tracked yet, but every note it spends is and binds its outputs', async () => {
  const w = world();
  w.trackingOf = { holder: (k) => (w.follows.has(k) ? 'tracked' : 'new') };
  await w.start();
  await w.run(async () => (await w.h())?.phase === 'done');
  const h = await w.h();
  assert.ok(!w.follows.has(`${h.deskOffer.lock.txid}:0`), 'claimed while the lock was still new to the proof');
});

test('a desk that pays with TAC the proof does not follow is refused: the holder never claims and refunds', async () => {
  const w = world({ holder: { offerWaitSecs: 2 * 3600 } });
  w.trackingOf = { holder: (k) => 'untracked', desk: (k) => 'tracked' };
  await w.start();
  await w.run(async () => (await w.h())?.phase === 'refund-wait');
  const h = await w.h();
  assert.match(h.why, /does not follow/);
  assert.ok(!h.claim, 'no claim was ever built');
  await w.run(async () => (await w.h())?.phase === 'refunded');
  assert.ok(await w.noteOf((await w.h()).refund.txid, 0), 'the refund is a valid note');
  await w.run(async () => (await w.d())?.phase === 'refunded');
});

test('the desk is unreachable: the holder takes its note back once the timelock runs', async () => {
  const w = world();
  w.deskUp = false; w.deskOnline = false;
  await w.start();
  await w.run(async () => (await w.h())?.phase === 'refunded');
  assert.match((await w.h()).why, /could not be reached|timelock/);
});

test('the desk holds too little tracked TAC: it locks nothing, says so, and the holder refunds', async () => {
  const w = world({ desk: { acceptWaitSecs: 3600 } });
  await w.start();
  w.deskNotes = [];
  await w.run(async () => (await w.d())?.phase === 'aborted');
  assert.ok(w.alerts.some((a) => /too little tracked TAC/.test(a.msg)));
  await w.run(async () => (await w.h())?.phase === 'refunded');
});

test('the holder goes silent once the desk has locked: the desk refunds its lock, and a late claim is refused', async () => {
  const w = world();
  await w.start();
  await w.run(async () => (await w.d())?.phase === 'offered');
  w.holderOnline = false;
  await w.run(async () => (await w.d())?.phase === 'refunded');
  const d = await w.d();
  const r = await w.desk.handle({ method: 'POST', path: `/swap/${d.id}/nonce`, body: { msg: '11'.repeat(32), pubnonce: '02'.repeat(66), auth: '00'.repeat(64) } });
  assert.equal(r.status, 403, 'unsigned');
  w.holderOnline = true;
  await w.run(async () => ['refunded', 'refund-wait'].includes((await w.h())?.phase));
  assert.ok(!(await w.h()).claim?.sent, 'the holder never sent a claim');
  await w.run(async () => (await w.h())?.phase === 'refunded');
});

test('signing sessions: only the holder\'s key opens one, a session signs once, and a second half for it is refused', async () => {
  const w = world();
  await w.start();
  await w.run(async () => (await w.h())?.psig);
  const h = await w.h();
  const body = { pubnonce: h.nonce.pub, psig: h.psig };
  const forged = { msg: h.claim.sighash, pubnonce: h.nonce.pub, auth: S.signRequest(hexToBytes('11'.repeat(32)), h.id, 'nonce', { msg: h.claim.sighash, pubnonce: h.nonce.pub }) };
  assert.equal((await w.desk.handle({ method: 'POST', path: `/swap/${h.id}/nonce`, body: forged })).status, 403);
  const other = { pubnonce: h.nonce.pub, psig: '01'.repeat(32) };
  const first = await w.desk.handle({ method: 'POST', path: `/swap/${h.id}/sign`, body: { ...body, auth: S.signRequest(w.hW.prims.wallet.priv, h.id, 'sign', body) } });
  assert.equal(first.status, 200);
  const again = await w.desk.handle({ method: 'POST', path: `/swap/${h.id}/sign`, body: { ...body, auth: S.signRequest(w.hW.prims.wallet.priv, h.id, 'sign', body) } });
  assert.deepEqual(again.body, first.body, 'the same half again, not a new one');
  const second = await w.desk.handle({ method: 'POST', path: `/swap/${h.id}/sign`, body: { ...other, auth: S.signRequest(w.hW.prims.wallet.priv, h.id, 'sign', other) } });
  assert.equal(second.status, 409);
  await w.run(async () => (await w.h())?.phase === 'done' && (await w.d())?.phase === 'done');
});

test('the desk\'s key differs per swap, so two swaps\' locks never share an output key', () => {
  const seed = partyKeys('desk').seed;
  const a = S.deskSwapSecrets({ seed, swapId: X.swapIdOf('aa'.repeat(32), 0) }), b = S.deskSwapSecrets({ seed, swapId: X.swapIdOf('aa'.repeat(32), 1) });
  assert.notEqual(Buffer.from(a.pub).toString('hex'), Buffer.from(b.pub).toString('hex'));
});

test('a desk offer whose lock or opening is wrong is refused by the check, and one still settling is only waited on', () => {
  const w = world();
  const prims = w.hW.prims, holderPub = w.hW.wallet.pub, musig = S.deskSwapSecrets({ seed: partyKeys('desk').seed, swapId: X.swapIdOf('bb'.repeat(32), 0) });
  const offer = S.makeDeskOffer({ swapId: X.swapIdOf('bb'.repeat(32), 0), asset: w.asset, amount: 100n, rLock: 7n, txid: 'cc'.repeat(32), vout: 0, csvBlocks: 144, deskXonly: w.dW.wallet.pub.slice(1), musigPub: musig.pub });
  const lock = S.jointLock({ prims, holderPub, deskPub: musig.pub, deskXonly: w.dW.wallet.pub.slice(1), csvBlocks: 144 });
  const good = { spk: Buffer.from(lock.spk).toString('hex'), commitment: Buffer.from(pedersenCommit(100n, 7n).toRawBytes(true)).toString('hex'), validNote: true, confirmations: 3, height: 100, tip: 102, tracked: true };
  const expect = { swapId: offer.swapId, asset: w.asset, amount: '100' };
  assert.ok(S.checkDeskOffer(offer, { prims, holderPub, expect, chain: good }).ok);
  assert.match(S.checkDeskOffer(offer, { prims, holderPub, expect, chain: { ...good, commitment: Buffer.from(pedersenCommit(101n, 7n).toRawBytes(true)).toString('hex') } }).reasons.join(), /opening/);
  assert.match(S.checkDeskOffer(offer, { prims, holderPub, expect: { ...expect, amount: '99' }, chain: good }).reasons.join(), /another amount/);
  assert.match(S.checkDeskOffer(offer, { prims, holderPub, expect, chain: { ...good, spk: '5120' + '00'.repeat(32) } }).reasons.join(), /joint lock/);
  assert.match(S.checkDeskOffer(offer, { prims, holderPub, expect, chain: { ...good, tip: 100 + 143 - 5 } }).reasons.join(), /too little time/);
  const settling = S.checkDeskOffer(offer, { prims, holderPub, expect, chain: { ...good, confirmations: 1, tracked: false } });
  assert.ok(settling.reasons.every((r) => /confirmation|does not follow/.test(r)));
  assert.equal(S.checkDeskOffer({ ...offer, lock: { ...offer.lock, musigPub: Buffer.from(holderPub).toString('hex') } }, { prims, holderPub, expect, chain: good }).ok, false, 'the holder\'s own key as the desk\'s');
});

test('the binding rule matches the guest\'s: key path and P2WPKH ALL bind, a script path or SINGLE|ANYONECANPAY does not', () => {
  const der = (flag) => new Uint8Array([0x30, 0x44, 0x02, 0x20, ...new Array(32).fill(0x11), 0x02, 0x20, ...new Array(32).fill(0x22), flag]);
  const pk = new Uint8Array(33).fill(2);
  assert.ok(S.bindsAllOutputs([new Uint8Array(64)]));
  assert.ok(S.bindsAllOutputs([new Uint8Array([...new Array(64).fill(1), 0x01])]));
  assert.ok(!S.bindsAllOutputs([new Uint8Array([...new Array(64).fill(1), 0x83])]));
  assert.ok(S.bindsAllOutputs([der(0x01), pk]));
  assert.ok(S.bindsAllOutputs([der(0x81), pk]), 'ALL|ANYONECANPAY binds every output, as the guest reads it');
  assert.ok(!S.bindsAllOutputs([der(0x03), pk]));
  assert.ok(!S.bindsAllOutputs([new Uint8Array(64), new Uint8Array(40), new Uint8Array(33)]), 'a script path');
});

let failed = 0;
for (const [name, fn] of tests.filter(([n]) => !process.env.ONLY || n.includes(process.env.ONLY))) {
  const t0 = Date.now();
  try { await fn(); console.log(`ok - ${name} (${((Date.now() - t0) / 1000).toFixed(1)}s)`); } catch (e) { failed++; console.log(`not ok - ${name}\n  ${String(e.stack || e).split('\n').slice(0, 6).join('\n  ')}`); }
}
console.log(failed ? `${failed} of ${tests.length} failed` : `all ${tests.length} passed`);
process.exit(failed ? 1 : 0);
