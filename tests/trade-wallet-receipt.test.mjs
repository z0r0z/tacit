// The trade wallet's wait for a receipt: read each second for the first minute and a half, then every three seconds, until it is there or the time is up; an interval
// asked for is kept. Time is a fake clock that moves by what each wait asks for.
//   node --test tests/trade-wallet-receipt.test.mjs
import { test } from 'node:test';
import assert from 'node:assert';
import { makeWallet } from '../dapp/trade/wallet.js';

// the wallet module listens for announced wallets on the page
globalThis.addEventListener ??= () => {};
globalThis.dispatchEvent ??= () => true;

function clock() {
  const realNow = Date.now, realSet = globalThis.setTimeout, waits = [];
  let t = 1e12;
  Date.now = () => t;
  globalThis.setTimeout = (fn, ms) => { waits.push(ms); t += ms; queueMicrotask(fn); return 0; };
  return { waits, stop() { Date.now = realNow; globalThis.setTimeout = realSet; } };
}
const wallet = (read) => makeWallet({ rpc: read });
const receipt = { status: '0x1' };

test('a receipt is looked for each second at first, and every three seconds after a minute and a half', async () => {
  const c = clock();
  try {
    let n = 0;
    const read = async () => (++n > 100 ? receipt : null);
    const r = await wallet(read).receipt('0xabc', { read });
    assert.strictEqual(r, receipt);
    assert.strictEqual(n, 101, 'one read before each wait, and the last one found it');
    assert.deepStrictEqual(c.waits.slice(0, 90), Array(90).fill(1000), 'a second apart for ninety seconds');
    assert.deepStrictEqual(c.waits.slice(90), Array(10).fill(3000), 'then three');
  } finally { c.stop(); }
});

test('an interval asked for is kept, and the wait ends with the words it always had when the time is up', async () => {
  const c = clock();
  try {
    const read = async () => null;
    await assert.rejects(wallet(read).receipt('0xabc', { read, every: 5000, timeoutMs: 20_000 }), /Sent, not confirmed yet/);
    assert.ok(c.waits.length >= 4 && c.waits.every((w) => w === 5000));
  } finally { c.stop(); }
});

test('a read that fails is read again, not taken for the end', async () => {
  const c = clock();
  try {
    let n = 0;
    const read = async () => { if (++n < 3) throw new Error('node down'); return receipt; };
    assert.strictEqual(await wallet(read).receipt('0xabc', { read }), receipt);
    assert.strictEqual(n, 3);
  } finally { c.stop(); }
});
