// dapp/fixed-pool-pay.js, the parts that need no page: the address checksum, how a provider is put together from the
// page's own node and the wallet, and what is kept of a note.
//
// Run: node tests/fixed-pool-pay.test.mjs

import { register } from 'node:module';
// the page's modules import each other by site path ("/x.js?cb="); this maps those to dapp/
register('data:text/javascript,' + encodeURIComponent(`const D = ${JSON.stringify(new URL('../dapp', import.meta.url).href)};
export async function resolve(spec, ctx, next) {
  if (spec.startsWith('/') && !spec.startsWith('//')) return next(D + spec.split('?')[0], ctx);
  return next(spec, ctx);
}`));

const { checksumOk, composeProvider, readNotes, writeNotes, metaOf, planExit } = await import('../dapp/fixed-pool-pay.js');
const { FIXED_POOLS } = await import('../dapp/fixed-pool-notes.js');

let pass = 0, fail = 0;
const test = async (label, fn) => {
  try { await fn(); console.log(`  PASS  ${label}`); pass++; }
  catch (e) { console.log(`  FAIL  ${label}: ${e.message}`); fail++; }
};
const eq = (a, b, what = '') => { if (a !== b) throw new Error(`${what} expected ${b}, got ${a}`); };

console.log('checksum');
await test('the EIP-55 examples pass, in any capitalization that is all one case', () => {
  for (const a of ['0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed', '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359', '0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB', '0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb']) {
    eq(checksumOk(a), true, a); eq(checksumOk(a.toLowerCase()), true, 'lower'); eq(checksumOk('0x' + a.slice(2).toUpperCase()), true, 'upper');
  }
});
await test('a mixed-case address with one letter flipped fails', () => {
  const a = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
  for (let i = 2; i < a.length; i++) {
    if (!/[a-f]/i.test(a[i])) continue;
    const flipped = a.slice(0, i) + (a[i] === a[i].toUpperCase() ? a[i].toLowerCase() : a[i].toUpperCase()) + a.slice(i + 1);
    eq(checksumOk(flipped), false, `flip at ${i}`);
  }
});

console.log('provider');
const calls = [];
const read = async () => async (method, params) => { calls.push(['read', method]); return `read:${method}`; };
await test('reads go to the page\'s node, never to the wallet', async () => {
  const p = composeProvider({ read, wallet: () => { throw new Error('the wallet was asked'); } });
  for (const m of ['eth_call', 'eth_getLogs', 'eth_blockNumber', 'eth_getCode', 'eth_feeHistory', 'eth_getTransactionReceipt', 'eth_getBalance']) eq(await p.request({ method: m, params: [] }), `read:${m}`);
});
await test('signing, sending and batches go to the wallet, never to the node', async () => {
  const seen = [];
  const wallet = () => ({ request: async ({ method }) => { seen.push(method); return `wallet:${method}`; } });
  const p = composeProvider({ read: async () => { throw new Error('the node was asked'); }, wallet });
  for (const m of ['eth_signTypedData_v4', 'eth_sendTransaction', 'wallet_sendCalls', 'wallet_getCallsStatus', 'wallet_getCapabilities']) eq(await p.request({ method: m, params: [] }), `wallet:${m}`);
  eq(seen.length, 5);
});
await test('a wallet method with no wallet connected is an error, not a silent read', async () => {
  const p = composeProvider({ read, wallet: () => null });
  let msg = null; try { await p.request({ method: 'eth_sendTransaction', params: [] }); } catch (e) { msg = e.message; }
  eq(msg, 'Connect your wallet first.');
});

console.log('kept notes');
const mem = () => { const m = new Map(); return { get: (k) => m.get(k) ?? null, set: (k, v) => m.set(k, v), m }; };
const pool = FIXED_POOLS[1][1];
const secrets = { commitment: 123n, nullifierHash: 456n };
await test('what is kept names the note and opens nothing: nonce, pool, commitment, nullifier hash', () => {
  const m = metaOf({ nonce: 4, pool, secrets: { ...secrets, nullifier: new Uint8Array(31), secret: new Uint8Array(31), preimage: new Uint8Array(62) } });
  eq(Object.keys(m).sort().join(), 'c,nh,nonce,pool'); eq(m.pool, pool.address); eq(m.c, '0x' + (123n).toString(16).padStart(64, '0')); eq(m.nh, '0x' + (456n).toString(16).padStart(64, '0'));
});
await test('notes are kept per chain and account, without duplicates, and survive nothing worse than empty', () => {
  const s = mem();
  const a = { nonce: 0, pool: pool.address, c: '0x1', nh: '0x2' };
  writeNotes(s, 1, '0xAbC', [a, a, { ...a, nonce: 1 }]);
  eq(readNotes(s, 1, '0xabc').length, 2, 'the account is read in any case');
  eq(readNotes(s, 8453, '0xabc').length, 0, 'another chain has none');
  s.set('tacit-fixed-notes:1:0xdef', '{not json'); eq(readNotes(s, 1, '0xdef').length, 0, 'bad data');
  s.set('tacit-fixed-notes:1:0x123', '{"a":1}'); eq(readNotes(s, 1, '0x123').length, 0, 'not a list');
});
await test('a store that throws does not break writing', () => {
  const s = { get: () => null, set: () => { throw new Error('quota'); } };
  eq(writeNotes(s, 1, '0xabc', [{ nonce: 0, pool: pool.address }]).length, 1);
});

console.log('whole notes for a withdrawal');
const E = 10n ** 18n, T = E / 10n;
const sum = (dens, picks) => picks.reduce((t, i) => t + dens[i], 0n);
await test('the notes pay up to the amount and never past it: largest first, each only if it still fits', () => {
  eq(planExit(5n * E / 2n, [E, E, E]).total, 2n * E, '2.5 with three 1 ETH notes');
  eq(planExit(E / 2n, [E, E]).total, 0n, 'less than a note takes none');
  eq(planExit(E, [E, E]).total, E, 'exactly one');
  eq(planExit(3n * E, [E, E]).total, 2n * E, 'more than the notes hold takes them all');
  eq(planExit(12n * E + E / 2n, [10n * E, E, E, E]).total, 12n * E, 'a 10 ETH note first, then 1 ETH notes');
  eq(planExit(9n * E + E / 2n, [10n * E, E, E, E]).total, 3n * E, 'a note that does not fit is skipped, the smaller ones are used');
});
await test('mixed sizes: the picks are indices into the list, the larger sizes first, and the total is their sum', () => {
  const dens = [T, E, T, 10n * E, E];
  const r = planExit(11n * E + 3n * T, dens);
  eq(r.total, sum(dens, r.picks), 'the total is what the picks add up to');
  eq(r.total, 11n * E + 2n * T, '10 + 1 + 1 + 0.1 + 0.1 fits, a third 0.1 would not exist');
  eq(new Set(r.picks).size, r.picks.length, 'no note twice');
  eq(dens[r.picks[0]], 10n * E, 'largest first');
});
await test('nothing to pay, nothing held, a zero-size note: no picks', () => {
  eq(planExit(0n, [E]).picks.length, 0); eq(planExit(E, []).picks.length, 0); eq(planExit(E, [0n]).picks.length, 0);
});
await test('the same sizes give the same picks, whatever order the notes are listed in', () => {
  const a = planExit(2n * E + T, [E, T, E, T, E]), b = planExit(2n * E + T, [T, E, E, E, T]);
  eq(a.total, b.total); eq(a.picks.length, b.picks.length);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
