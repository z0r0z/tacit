// payPrivately's two fallbacks to posting from the wallet's own Bitcoin address: unasked without `askSelf`, and only on
// a yes with it. The pool client, the prover and the carrier are stubbed; a carrier post is seen as tacit.wallet.xonly()
// being reached, which broadcastCarrier calls first.
//   node tests/secret-pay-ask-self.test.mjs

import assert from 'node:assert/strict';

const realTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...a) => realTimeout(fn, 0, ...a);       // the relay's five-minute wait, at once

const secret = await import('../dapp/sats/secret.js');
const { pool } = secret;
const client = secret.poolClientFor('mainnet');
const ASSET = secret.TAC_ASSET_MAINNET;
const pw = secret.poolWalletFor(new Uint8Array(32).fill(7), 'mainnet');
const to = secret.poolWalletFor(new Uint8Array(32).fill(8), 'mainnet').addressString;
const notes = [{ asset: '0x' + ASSET, value: '100000000', nf: '0x01', txid: 'aa'.repeat(32), leafIndex: 0 }];

let log;
function stub({ fee = 1000n, quote = true, submit = true, status = () => null } = {}) {
  log = { quotes: 0, submits: 0, statuses: 0, proofs: 0, posts: 0, asks: [] };
  client.relayInfo = async () => (fee == null ? null : { fees: { ['0x' + ASSET]: fee.toString() } });
  client.quote = async () => { log.quotes++; if (!quote) throw new Error('quote table full'); return { fee: fee.toString(), address: to, bind: { txid: 'bb'.repeat(32), vout: 0 }, quoteId: 'q1' }; };
  client.submit = async () => { log.submits++; if (submit !== true) throw new Error(submit); return { id: 's1' }; };
  client.relayStatus = async () => status(++log.statuses);
  client.walletNotes = async () => notes;
  client.anchorAndPaths = async (inputs) => ({ hAnchor: 900000, root: '0x00', notes: inputs, tip: 900010 });
  secret.poolClient.artifactBytes = async () => 0;
  secret.poolClient.system = async () => ({});
  pool.selectInputs = (live) => ({ inputs: live, total: live.reduce((t, x) => t + BigInt(x.value), 0n) });
  pool.buildSpendBody = () => ({});
  pool.prove = async () => { log.proofs++; return { payload: new Uint8Array(4), payloadHex: '00000000' }; };
}
const tacit = { DUST: 546, p2wpkhScript: () => new Uint8Array(22), wallet: { pub: new Uint8Array(33), xonly() { log.posts++; throw new Error('SELF_POST'); } } };
const pay = (opts = {}) => secret.payPrivately(tacit, { poolWallet: pw, to, amount: 5000n, asset: ASSET, ...opts });
const asker = (answer) => async (why, d) => { log.asks.push([why, d?.timedOut ?? null]); return typeof answer === 'function' ? answer(why, d) : answer; };
const posted = (p) => assert.rejects(p, /SELF_POST/);
const declined = (p, msg) => assert.rejects(p, (e) => e.relayDeclined === true && e.said === true && e.message === msg);
const NO_RELAY = 'The relay isn’t taking payments right now. Nothing was sent.';
const SLOW = 'The relay hasn’t posted it yet and may still. Nothing else was sent; check your balance before paying again.';

// (a) The relay cannot quote: no fee listed, or the quote fails.
stub({ fee: null }); await posted(pay());
assert.equal(log.posts, 1, 'no askSelf: posted from the Bitcoin address, as before');
stub({ quote: false }); await posted(pay());
assert.equal(log.posts, 1);
stub({ fee: null }); await declined(pay({ askSelf: asker(false) }), NO_RELAY);
assert.deepEqual(log.asks, [['no-relay', null]]);
assert.equal(log.posts, 0, 'a no posts nothing');
assert.equal(log.proofs, 0, 'and proves nothing');
stub({ quote: false }); await declined(pay({ askSelf: asker(false) }), NO_RELAY);
assert.equal(log.posts, 0);
stub({ quote: false }); await posted(pay({ askSelf: asker(true) }));
assert.deepEqual(log.asks, [['no-relay', null]]);
assert.equal(log.posts, 1, 'a yes posts it');
stub({ fee: null }); await posted(pay({ noRelay: true, askSelf: asker(false) }));
assert.deepEqual(log.asks, [], 'a payment chosen to go from the Bitcoin address is not asked about');
assert.equal(log.posts, 1);

// A note still settling returns { wait } before anything is asked.
stub({ fee: null });
client.anchorAndPaths = async () => ({ wait: 2, tip: 900010 });
assert.deepEqual(await pay({ askSelf: asker(false) }), { wait: 2, tip: 900010 });
assert.deepEqual(log.asks, []);

// The relay posts it: nothing is asked.
stub({ status: (n) => (n === 3 ? { carrier: 'cc'.repeat(32) } : { state: 'queued' }) });
const ok = await pay({ askSelf: asker(false) });
assert.equal(ok.relayed, true); assert.equal(ok.revealTxid, 'cc'.repeat(32));
assert.deepEqual(log.asks, []); assert.equal(log.posts, 0);

// (b) The relay has not posted it after its sixty polls.
stub({ status: () => ({ state: 'queued' }) }); await posted(pay());
assert.equal(log.statuses, 60); assert.equal(log.posts, 1, 'no askSelf: posted from the Bitcoin address, as before');
stub({ status: () => ({ state: 'queued' }) }); await declined(pay({ askSelf: asker(false) }), SLOW);
assert.deepEqual(log.asks, [['relay-slow', true]]);
assert.equal(log.posts, 0, 'a no posts nothing');
assert.equal(log.proofs, 1, 'the relayed proof only');
stub({ status: () => ({ state: 'queued' }) }); await posted(pay({ askSelf: asker(true) }));
assert.deepEqual(log.asks, [['relay-slow', true]], 'asked once: the rebuild goes from the Bitcoin address unasked');
assert.equal(log.posts, 1); assert.equal(log.proofs, 2, 'rebuilt and proved again without the bind');

// The relay reports it dropped, or the hand-off fails: asked, not timed out.
stub({ status: () => ({ state: 'dropped', reason: 'carrier not confirmed' }) }); await declined(pay({ askSelf: asker(false) }), SLOW);
assert.deepEqual(log.asks, [['relay-slow', false]]);
stub({ submit: 'HTTP 502' }); await declined(pay({ askSelf: asker(false) }), SLOW);
assert.deepEqual(log.asks, [['relay-slow', false]]); assert.equal(log.posts, 0);
stub({ status: () => ({ state: 'dropped' }) }); await posted(pay());
assert.equal(log.posts, 1, 'no askSelf: posted from the Bitcoin address, as before');

// Notes another payment is spending are refused before anything is asked.
for (const status of [() => ({ state: 'rejected', reason: 'nullifier already spent' }), () => ({ state: 'replayed-elsewhere' })]) {
  stub({ status }); await assert.rejects(pay({ askSelf: asker(true) }), /already being spent/);
  assert.deepEqual(log.asks, []); assert.equal(log.posts, 0);
}
stub({ submit: 'conflict: nullifier held by another payload' }); await assert.rejects(pay({ askSelf: asker(true) }), /already being spent/);
assert.deepEqual(log.asks, []);

// The relay posts it while the question is open: the question ends and the payment counts as relayed.
let aborted = false;
stub({ status: (n) => (n > 62 ? { carrier: 'dd'.repeat(32) } : { state: 'queued' }) });
const late = await pay({ askSelf: asker((why, d) => new Promise((res) => d.signal.addEventListener('abort', () => { aborted = true; res(true); }))) });
assert.equal(late.relayed, true); assert.equal(late.revealTxid, 'dd'.repeat(32));
assert.equal(aborted, true, 'the question is told it is over'); assert.equal(log.posts, 0);

// An answer ends the watch on the relay.
stub({ status: () => ({ state: 'queued' }) });
await declined(pay({ askSelf: asker((why, d) => new Promise((res) => realTimeout(() => res(false), 20))) }), SLOW);
const polls = log.statuses;
await new Promise((r) => realTimeout(r, 50));
assert.ok(log.statuses <= polls + 1, 'no polling after the answer');

console.log('secret-pay-ask-self: all checks passed');
