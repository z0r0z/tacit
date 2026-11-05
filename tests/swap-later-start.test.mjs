// dapp/swap/later.js, start and startHop with a pool wallet that is not a chain: a deposit that landed is a deposit even when the read after it fails.
//   node --test tests/swap-later-start.test.mjs
import { test } from 'node:test';
import assert from 'node:assert';
import { register } from 'node:module';

register('data:text/javascript,' + encodeURIComponent(`const D = ${JSON.stringify(new URL('../dapp', import.meta.url).href)};
export async function resolve(spec, ctx, next) { if (spec.startsWith('/') && !spec.startsWith('//')) return next(D + spec.split('?')[0], ctx); return next(spec, ctx); }`));
const { makeLater } = await import('../dapp/swap/later.js');

const PAYER = '0x' + '0a'.repeat(20), DEST = '0x' + '0d'.repeat(20), HASH = '0x' + 'ab'.repeat(32);
const TAC = '0xa1313eb9f3a445606d9583bcac3ebeb56a858279', USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const HOP = { token: USDC, pool: '0x' + '51'.repeat(20), router: '0x' + '52'.repeat(20), id: '1-xa0b86991c6', from: 1, state: { pool: true, router: true } };

// the token reads a deposit into a token pool makes (balance, allowances, nonce) as one Multicall3 answer: each is a large number, so the router already has its allowance
const w32 = (v) => BigInt(v).toString(16).padStart(64, '0');
const multicall = (n) => '0x' + w32(32) + w32(n) + Array.from({ length: n }, (_, i) => w32(n * 32 + i * 128)).join('') + Array.from({ length: n }, () => w32(1) + w32(64) + w32(32) + w32(2n ** 200n)).join('');
const ethCall = async (to) => (String(to).toLowerCase() === '0xca11bde05977b3631167028862be2a173976ca11' ? multicall(4) : '0x');

// a pool wallet whose first read (before the deposit) answers and whose later ones fail when `lateFails`; the deposit lands (or throws `depositErr`)
function setup({ lateFails = false, depositErr = null } = {}) {
  const mem = new Map(), store = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)) };
  const M = { syncs: 0, deposits: [] };
  const pool = {
    sync: async () => { if (++M.syncs > 1 && lateFails) throw new Error('request rejected by the node'); return { leaves: 10, balance: 0n }; },
    deposit: async (a) => { M.deposits.push(a); if (depositErr) throw depositErr; return HASH; },
  };
  const L = makeLater({ keyHex: async () => '11'.repeat(32), signer: { address: PAYER }, ethCall, store, walletOf: async () => pool, prove: async () => ({}), chain: { chainId: 1, rpc: ['http://127.0.0.1:1'] } });
  return { L, M };
}
const args = { swapWei: 10n ** 17n, extraWei: 10n ** 16n, token: TAC, sym: 'TAC', dec: 18, to: DEST, depositWei: 2n * 10n ** 17n };

test('a deposit that landed is not called an error because the read after it failed', async () => {
  const { L, M } = setup({ lateFails: true });
  const plan = await L.start(args);
  assert.strictEqual(M.deposits.length, 1);
  assert.strictEqual(plan.state, 'waiting');
  assert.strictEqual(plan.depositTx, HASH);
  assert.ok(plan.depositedAt > 0 && plan.err === null);
  assert.strictEqual(plan.leaves0, 10, 'the count from before the deposit stands');
  assert.deepStrictEqual([L.plans()[0].id, L.plans()[0].state], [plan.id, 'waiting'], 'and so does the kept plan');
});

test('a deposit through a token pool is the same', async () => {
  const { L } = setup({ lateFails: true });
  const plan = await L.start({ ...args, token: USDC, sym: 'USDC', dec: 6, hop: HOP, pay: { sym: 'USDC', dec: 6 } });
  assert.strictEqual(plan.state, 'waiting');
  assert.ok(plan.depositedAt > 0 && plan.err === null);
  assert.strictEqual(plan.leaves0, 10);
});

test('a deposit that did not go through still stops the plan, and one in doubt stays in doubt', async () => {
  const a = setup({ depositErr: new Error('User rejected the request.') });
  await assert.rejects(a.L.start(args), /rejected/);
  assert.strictEqual(a.L.plans()[0].state, 'stopped');
  const b = setup({ depositErr: new Error('socket hang up') });
  await assert.rejects(b.L.start(args), /socket hang up/);
  assert.strictEqual(b.L.plans()[0].state, 'unsure');
});

// USDT's allowance is set to zero before it is raised, a transaction of its own: an error from the step after it says that reset was sent.
const USDT = '0xdac17f958d2ee523a2206206994597c13d831ec7';
const multicallOf = (vals) => '0x' + w32(32) + w32(vals.length) + vals.map((_, i) => w32(vals.length * 32 + i * 128)).join('') + vals.map((v) => w32(1) + w32(64) + w32(32) + w32(v)).join('');
function approving({ token, allowed, failAt }) {
  const mem = new Map(), store = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)) }, sent = [];
  const call = async (to) => (String(to).toLowerCase() === '0xca11bde05977b3631167028862be2a173976ca11' ? multicallOf([2n ** 200n, allowed, 0n, 0n]) : '0x');
  const signer = {
    address: PAYER, receipt: async () => ({ status: '0x1' }),
    send: async (tx) => { sent.push(tx); if (sent.length === failAt) throw Object.assign(new Error('User rejected the request.'), { code: 4001 }); return HASH; },
  };
  const pool = { sync: async () => ({ leaves: 10, balance: 0n }), deposit: async () => HASH };
  const L = makeLater({ keyHex: async () => '11'.repeat(32), signer, ethCall: call, store, walletOf: async () => pool, prove: async () => ({}), chain: { chainId: 1, rpc: ['http://127.0.0.1:1'] } });
  return { L, sent, hop: { ...HOP, token } };
}

test('a decline after USDT\'s allowance was reset says the reset was sent', async () => {
  const { L, sent, hop } = approving({ token: USDT, allowed: 5n, failAt: 2 });
  const err = await L.start({ ...args, hop, pay: { sym: 'USDT', dec: 6 } }).catch((e) => e);
  assert.strictEqual(sent.length, 2, 'the reset went, the raise was asked for and refused');
  assert.strictEqual(err.zeroed, 'USDT');
  assert.match(err.message, /allowance was set to zero first; nothing else was sent/);
  assert.match(err.message, /rejected/, 'and what it was still says what it was');
  assert.strictEqual(L.plans().length, 0, 'no plan: nothing was deposited');
});

test('a reset that is declined itself sent nothing, and a token with no reset has nothing to add', async () => {
  const a = approving({ token: USDT, allowed: 5n, failAt: 1 });
  const e1 = await a.L.start({ ...args, hop: a.hop, pay: { sym: 'USDT', dec: 6 } }).catch((e) => e);
  assert.strictEqual(e1.zeroed, undefined);
  assert.doesNotMatch(e1.message, /set to zero/);
  const b = approving({ token: USDC, allowed: 5n, failAt: 1 });
  const e2 = await b.L.start({ ...args, hop: b.hop, pay: { sym: 'USDC', dec: 6 } }).catch((e) => e);
  assert.strictEqual(e2.zeroed, undefined);
  assert.strictEqual(b.sent.length, 1, 'USDC is raised straight away, with no reset');
});
