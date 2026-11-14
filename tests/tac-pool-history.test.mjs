// A wallet's own history in the Bitcoin pool (dapp/sats/secret.js poolHistory): each transaction behind its notes as the change
// it made to the shielded balance, read from the notes (spent ones too), the transactions and their spend envelopes. The chain
// and the envelope parser are stubbed; the wallet and its sale keys are real.
//   node tests/tac-pool-history.test.mjs

import assert from 'node:assert/strict';
import { secp, sha256, ripemd160, bytesToHex } from '../dapp/vendor/tacit-deps.min.js';

const store = new Map();
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
const secret = await import('../dapp/sats/secret.js');
const { pool } = secret;
const pw = secret.poolWalletFor(new Uint8Array(32).fill(7), 'mainnet');
const walletPub = secp.getPublicKey(new Uint8Array(32).fill(9), true);
const ownSpk = '0014' + bytesToHex(ripemd160(sha256(walletPub)));
const RELAY_FUND = 'bc1q7zscdfnead28xh3cryrdzjd4ehawwmp9hh4qj8';
const sale = secret.saleKey(pw, 3);
const id = (c) => c.repeat(32);

// The reporter's day, and four more: two notes shielded; 987 withdrawn home, 0.07564851 kept as change; 987 shielded again; all
// of it taken out for sale through the relay (fee 15); a payment of 20 received; 5 sent through the relay (fee 1.5, outputs: the
// fee, the payee, the change); 1 shielded; the change and that 1 combined from the wallet's own address (three outputs, all its own).
const T = {
  [id('a1')]: { h: 973487, op: 0x6c },
  [id('a2')]: { h: 973488, op: 0x6c },
  [id('b1')]: { h: 973494, op: 0x6d, nfs: ['0a', '0b'], outs: 3, exit: 0, vout: [{ scriptpubkey: ownSpk, scriptpubkey_address: 'bc1qsedwallet' }] },
  [id('c1')]: { h: 973499, op: 0x6c },
  [id('d1')]: { h: 973509, op: 0x6d, nfs: ['0d', '0c'], outs: 3, exit: 0, relayed: true, vout: [{ scriptpubkey: sale.scriptPubKey, scriptpubkey_address: sale.address }] },
  [id('e1')]: { h: 973600, op: 0x6d, nfs: ['ff'], outs: 3, exit: null },
  [id('e2')]: { h: 973700, op: 0x6d, nfs: ['0e'], outs: 3, exit: null, relayed: true },
  [id('g1')]: { h: 973750, op: 0x6c },
  [id('f1')]: { h: 973800, op: 0x6d, nfs: ['0h', '0g'], outs: 3, exit: null },
};
const note = (txid, value, o = {}) => ({ txid, value, height: T[txid].h, asset: '0x' + secret.TAC_ASSET_MAINNET, ...o });
const notes = [
  note(id('a1'), 50000000000n, { nf: '0x0a', spent: true }),
  note(id('a2'), 48707564851n, { nf: '0x0b', spent: true }),
  note(id('b1'), 7564851n, { nf: '0x0c', spent: true, internal: true }),
  note(id('b1'), 0n, { nf: '0x0z1', internal: true }),
  note(id('c1'), 98700000000n, { nf: '0x0d', spent: true }),
  note(id('d1'), 0n, { nf: '0x0z2', internal: true }),
  note(id('d1'), 0n, { nf: '0x0z3', internal: true }),
  note(id('e1'), 2000000000n, { nf: '0x0e', spent: true }),
  note(id('e2'), 1350000000n, { nf: '0x0h', spent: true, internal: true }),
  note(id('g1'), 100000000n, { nf: '0x0g', spent: true }),
  note(id('f1'), 1450000000n, { nf: '0x0i', internal: true }),
  note(id('f1'), 0n, { nf: '0x0j', internal: true }),
  note(id('f1'), 0n, { nf: '0x0k', internal: true }),
];

const fetched = [];
const tacit = {
  wallet: { pub: walletPub },
  p2wpkhScript: (pub) => Uint8Array.from(Buffer.from('0014' + bytesToHex(ripemd160(sha256(pub))), 'hex')),
  getTx: async (txid) => {
    fetched.push(txid);
    const t = T[txid];
    if (!t) return null;
    return { txid, op: t.op, status: { confirmed: true, block_height: t.h, block_time: 1761600000 + (t.h - 973487) * 600 },
      vin: [{ prevout: { scriptpubkey_address: t.relayed ? RELAY_FUND : 'bc1qsedwallet' } }], vout: t.vout || [], payload: t };
  },
  txOutputEnvelope: (tx) => ({ opcode: tx.op, payload: tx.payload }),
};
const realParse = pool.parseSpend;
pool.parseSpend = (t) => {
  if (t.op !== 0x6d) throw new Error('btc-pool: not a spend envelope');
  return { nullifiers: t.nfs.map((x) => '0x' + x), outputs: Array.from({ length: t.outs }, () => ({})), exit: t.exit == null ? null : { exitVout: t.exit } };
};

const rows = await secret.poolHistory(tacit, pw, notes, { relayFund: RELAY_FUND });
const brief = rows.map((r) => [r.txid.slice(0, 2), r.kind, r.delta]);
assert.deepEqual(brief, [
  ['f1', 'combined', 0n],
  ['g1', 'shielded', 100000000n],
  ['e2', 'sent', 1350000000n - 2000000000n],
  ['e1', 'received', 2000000000n],
  ['d1', 'for-sale', -98707564851n],
  ['c1', 'shielded', 98700000000n],
  ['b1', 'withdrawn-home', -98700000000n],
  ['a2', 'shielded', 48707564851n],
  ['a1', 'shielded', 50000000000n],
], 'newest first, each with what it did to the balance');
const d1 = rows.find((r) => r.kind === 'for-sale');
assert.equal(d1.to, sale.address, 'a take-out names the sale key it went to');
assert.equal(d1.time, 1761600000 + 22 * 600, 'and when, from its block');
assert.equal(rows.find((r) => r.kind === 'withdrawn-home').to, 'bc1qsedwallet');
assert.equal(new Set(fetched).size, fetched.length, 'each transaction is read once');

// read without the wallet's own address, a withdrawal home is still a withdrawal, not a sale
assert.equal((await secret.poolHistory({ ...tacit, wallet: {} }, pw, notes, { relayFund: RELAY_FUND })).find((r) => r.txid === id('b1')).kind, 'withdrawn');
// combined through the relay: its three outputs are the relay's fee and two of the wallet's own, so it is told from a send by the
// carrier the relay paid for; without the relay's address it would read as one
T[id('f1')].relayed = true;
const relayedCombine = notes.filter((n) => n.nf !== '0x0k');
assert.equal((await secret.poolHistory(tacit, pw, relayedCombine, { relayFund: RELAY_FUND })).find((r) => r.txid === id('f1')).kind, 'combined', 'a relayed combine is a combine');
assert.equal((await secret.poolHistory(tacit, pw, relayedCombine, {})).find((r) => r.txid === id('f1')).kind, 'sent', 'unless the relay’s carrier is unknown');
T[id('f1')].relayed = false;
// a transaction that did not load: a spend of the wallet's is said as not read, with no amount; an incoming one keeps its amount
const lossy = { ...tacit, getTx: async (t) => (t === id('d1') || t === id('e1') ? null : tacit.getTx(t)) };
const lr = await secret.poolHistory(lossy, pw, notes, { relayFund: RELAY_FUND });
assert.deepEqual([lr.find((r) => r.txid === id('d1')).kind, lr.find((r) => r.txid === id('d1')).delta], ['unread', null]);
assert.deepEqual([lr.find((r) => r.txid === id('e1')).kind, lr.find((r) => r.txid === id('e1')).delta], ['received', 2000000000n]);
assert.deepEqual(await secret.poolHistory(tacit, pw, [], {}), [], 'no notes, no history');
pool.parseSpend = realParse;
console.log('tac-pool-history: all checks passed');
