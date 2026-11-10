// requireUnspent, the look shieldNote takes at the note it is about to spend: a note the explorer says is spent (in a block or waiting for one) stops the
// shield before a proof is made and again before anything goes out, so the commit transaction is never sent for a reveal Bitcoin would refuse. A note the
// explorer says nothing about (404, no answer) goes on, as buyAndShield's lot does. Stubbed explorer, no proofs.
//   node tests/secret-shield-unspent.test.mjs

import assert from 'node:assert/strict';

const mem = new Map();
globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };

const { requireUnspent } = await import('../dapp/sats/secret.js');
const tacit = { NET: { api: 'http://esplora.test', api2: null } };
const note = { txid: 'ab'.repeat(32), vout: 1 };
const asked = [];
const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const stub = (fn) => { globalThis.fetch = async (url) => { asked.push(url); return fn(url); }; };

stub(() => reply(200, { spent: true, txid: 'cd'.repeat(32), vin: 0, status: { confirmed: false } }));
await assert.rejects(() => requireUnspent(tacit, note), (e) => e.spent === true && e.said === true && /spent already/.test(e.message), 'a spend waiting in the mempool stops it');
assert.deepEqual(asked, [`http://esplora.test/tx/${note.txid}/outspend/1`], 'it asks about this note\'s output');

stub(() => reply(200, { spent: false }));
await requireUnspent(tacit, note);

stub(() => reply(404, null));
await requireUnspent(tacit, note);

stub(() => { throw new Error('offline'); });
await requireUnspent(tacit, note);

stub(() => reply(500, null));
await requireUnspent(tacit, note);

console.log('secret shield unspent: all passed');
