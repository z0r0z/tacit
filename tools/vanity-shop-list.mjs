#!/usr/bin/env node
// Turns the salt pool's market bank into the calls that stock the vanity shop (contracts/src/VanityShop.sol): the best salts are kept back (`keep`, minted to
// an address of ours) and the rest are listed for sale at a price in TAC (`list`). It sends nothing: it prints the plan and the calls (to, value, data) for
// whoever owns the shop (the ops multisig: each call goes through its queue) to make, and can write them to a file.
//
//   node tools/vanity-shop-list.mjs --shop 0x… --tac-usd 0.05 [--bank <url|file>] [--rpc <url>] [--keep 8] [--keep-to 0x…] [--min-bits 40]
//        [--usd-hour 0.45] [--rate 1.43e9] [--markup 1] [--min-price 1] [--chunk 40] [--out plan.json]
//
// The price is what the salt would cost to grind, in TAC: 2^bits tries at --rate per second on a card rented at --usd-hour dollars an hour, times --markup,
// at --tac-usd dollars a TAC, never under --min-price TAC, rounded up to two significant figures. Every extra bit doubles it. The default rate is the one
// measured for createXcrunch on an RTX 4090 against CreateX, which is slower than a miner that tries a salt's nonces for one hash each: a lower --rate prices
// higher, a higher one lower. The plan prints each price in dollars too.
//
// Without --rpc nothing is checked against the chain: pass it, so that a salt already minted or already listed, or an address the market computes
// differently, is left out. The bank keeps only the best 64 salts, so stock the shop before a better find pushes an unsold one out.
import { readFileSync, writeFileSync } from 'node:fs';
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { marketAddress, SALT_POOL } from '../worker/src/salt-pool.js';

const OPS = '0x006CD14F36F65eCbB29b2519cCBe63A0DC8549F2';
const BANK_URL = 'https://api.tacit.finance/prover/salt/bank';
const ADDR = /^0x[0-9a-fA-F]{40}$/;
const SALT = /^0x[0-9a-f]{64}$/;
const U128 = (1n << 128n) - 1n;

// ---- price ----

// The price of a salt of `bits` zero bits, in TAC wei (a BigInt).
export function priceTac({ bits, tacUsd, usdPerHour = 0.45, rate = 1.43e9, markup = 1, minPrice = 1 }) {
  if (!(tacUsd > 0) || !(rate > 0) || !(usdPerHour >= 0) || !(markup > 0) || !(minPrice > 0)) throw new Error('tacUsd, rate, markup and minPrice must be positive');
  const usd = (2 ** bits / rate / 3600) * usdPerHour * markup;
  let tac = Math.max(usd / tacUsd, minPrice);
  // up to two significant figures, so a price reads as a price
  const mag = 10 ** (Math.floor(Math.log10(tac)) - 1);
  tac = Math.ceil(Math.round(tac / mag * 1e6) / 1e6) * mag;
  const wei = BigInt(Math.round(tac * 1e6)) * 10n ** 12n;
  if (wei > U128) throw new Error(`a ${bits}-bit salt would cost more than a listing can hold`);
  return wei;
}
const tacOf = (wei) => Number(wei / 10n ** 12n) / 1e6;

// ---- calldata (the shop's ABI; tests/vanity-shop-list.test.mjs and contracts/test/VanityShop.t.sol hold the same strings) ----

const sel = (sig) => bytesToHex(keccak_256(new TextEncoder().encode(sig)).slice(0, 4));
const word = (n) => BigInt(n).toString(16).padStart(64, '0');
const addrWord = (a) => a.toLowerCase().replace(/^0x/, '').padStart(64, '0');
const idWord = (id) => id.replace(/^0x/, '').padStart(64, '0');

// list((uint256 id, uint128 price, uint8 nonce)[])
export function encodeList(items) {
  return '0x' + sel('list((uint256,uint128,uint8)[])') + word(32) + word(items.length) + items.map((i) => idWord(i.id) + word(i.price) + word(i.nonce)).join('');
}
// keep(uint256 id, uint8 nonce, address to)
export function encodeKeep({ id, nonce, to }) {
  return '0x' + sel('keep(uint256,uint8,address)') + idWord(id) + word(nonce) + addrWord(to);
}

// ---- reads (the market's and the shop's) ----

export function makeChain({ rpc, market, shop, fetchImpl = fetch }) {
  const call = async (to, data) => {
    const r = await (await fetchImpl(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] }) })).json();
    if (r.error) throw new Error(`${to.slice(0, 10)}: ${r.error.message}`);
    return r.result.replace(/^0x/, '');
  };
  return {
    tokenData: async (id) => { const h = await call(market, '0x' + sel('getTokenData(uint256)') + idWord(id)); return { minted: BigInt('0x' + h.slice(0, 64)) === 1n }; },
    listing: async (id) => { const h = await call(shop, '0x' + sel('listings(uint256)') + idWord(id)); return { price: BigInt('0x' + h.slice(0, 64)), nonce: Number(BigInt('0x' + h.slice(64, 128))) }; },
    computeAddress: async (id, nonce) => '0x' + (await call(market, '0x' + sel('computeAddress(bytes32,uint8)') + idWord(id) + word(nonce))).slice(24),
  };
}

// ---- the plan ----

// entries: the bank's market list [{ salt, address, bits, nonce, miner, at }]. chain: makeChain(...) or null. → [{ id, nonce, address, bits, action, ... }]
export async function buildPlan(entries, { shop, keep = 0, minBits = 40, price }, chain = null) {
  const shopHex = shop.toLowerCase().replace(/^0x/, '');
  const live = [], plan = [];
  const skip = (e, reason) => plan.push({ id: e.salt, nonce: e.nonce, address: e.address, bits: e.bits, action: 'skip', reason });
  for (const raw of entries) {
    const e = { ...raw, salt: String(raw.salt || '').toLowerCase(), nonce: Number(raw.nonce ?? 0), address: String(raw.address || '').toLowerCase() };
    if (!SALT.test(e.salt)) { skip(e, 'not a salt'); continue; }
    if (e.salt.slice(2, 42) !== shopHex) { skip(e, 'not a salt of this shop'); continue; }
    if (!Number.isInteger(e.nonce) || e.nonce < 0 || e.nonce > 254) { skip(e, 'nonce out of range (0 to 254)'); continue; }
    const mine = marketAddress(e.salt, e.nonce);
    if (mine.address !== e.address || mine.bits !== e.bits) { skip(e, 'the bank\'s address is not the one the market derives'); continue; }
    let listed = null;
    if (chain) {
      if ((await chain.computeAddress(e.salt, e.nonce)).toLowerCase() !== e.address) { skip(e, 'the market on chain computes another address'); continue; }
      if ((await chain.tokenData(e.salt)).minted) { skip(e, 'already a token'); continue; }
      const l = await chain.listing(e.salt);
      if (l.price > 0n) listed = l;
    }
    live.push({ ...e, listed });
  }
  live.sort((a, b) => b.bits - a.bits || (a.at || 0) - (b.at || 0));
  live.forEach((e, i) => {
    const base = { id: e.salt, nonce: e.nonce, address: e.address, bits: e.bits, miner: e.miner, at: e.at };
    if (i < keep) plan.push({ ...base, action: 'keep', ...(e.listed ? { note: `listed at ${tacOf(e.listed.price)} TAC: keeping it takes it off the shelf` } : {}) });
    else if (e.listed) plan.push({ ...base, action: 'skip', reason: `already listed at ${tacOf(e.listed.price)} TAC${e.listed.nonce === e.nonce ? '' : ` (nonce ${e.listed.nonce})`}` });
    else if (e.bits < minBits) plan.push({ ...base, action: 'skip', reason: `under the listing bar (${e.bits} bits, the bar is ${minBits})` });
    else plan.push({ ...base, action: 'list', priceWei: price(e.bits) });
  });
  return plan;
}

export const chunks = (a, n) => { const out = []; for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n)); return out; };

// → [{ label, to, value, data }]
export function buildCalls(plan, { shop, keepTo, chunk = 40 }) {
  const calls = [];
  for (const p of plan.filter((x) => x.action === 'keep')) calls.push({ label: `keep ${p.address} (${p.bits} bits) to ${keepTo}`, to: shop, value: '0', data: encodeKeep({ id: p.id, nonce: p.nonce, to: keepTo }) });
  const listed = plan.filter((x) => x.action === 'list');
  chunks(listed, chunk).forEach((c, i, all) => calls.push({ label: `list ${c.length} salts (${i + 1} of ${all.length})`, to: shop, value: '0', data: encodeList(c.map((p) => ({ id: p.id, price: p.priceWei, nonce: p.nonce }))) }));
  return calls;
}

// ---- command line ----

async function readBank(src) {
  const text = /^https?:\/\//.test(src) ? await (await fetch(src)).text() : readFileSync(src, 'utf8');
  const j = JSON.parse(text);
  const list = Array.isArray(j) ? j : j.marketBank;
  if (!Array.isArray(list)) throw new Error('that bank has no marketBank: the pool is not taking market salts yet (SALT_SCHEMES, SALT_SHOP)');
  return list;
}

export async function main(argv, out = console.log) {
  const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
  const shop = opt('shop');
  if (!shop || !ADDR.test(shop)) throw new Error('--shop <the shop\'s address> is required');
  const tacUsd = Number(opt('tac-usd'));
  if (!(tacUsd > 0)) throw new Error('--tac-usd <dollars per TAC> is required');
  const keep = Number(opt('keep', 8)), minBits = Number(opt('min-bits', 40)), chunk = Number(opt('chunk', 40));
  const keepTo = opt('keep-to', OPS);
  if (!ADDR.test(keepTo)) throw new Error('--keep-to must be an address');
  const pricing = { tacUsd, usdPerHour: Number(opt('usd-hour', 0.45)), rate: Number(opt('rate', 1.43e9)), markup: Number(opt('markup', 1)), minPrice: Number(opt('min-price', 1)) };
  const rpc = opt('rpc');
  const entries = await readBank(opt('bank', BANK_URL));
  const chain = rpc ? makeChain({ rpc, market: opt('market', SALT_POOL.market), shop }) : null;
  if (!chain) out('WARNING: no --rpc, so nothing is checked against the chain (a salt already minted or listed would be listed again).');
  const plan = await buildPlan(entries, { shop, keep, minBits, price: (bits) => priceTac({ bits, ...pricing }) }, chain);
  const calls = buildCalls(plan, { shop, keepTo, chunk });

  out(`\n${entries.length} salts in the bank, ${plan.filter((p) => p.action === 'keep').length} to keep, ${plan.filter((p) => p.action === 'list').length} to list, ${plan.filter((p) => p.action === 'skip').length} left out\n`);
  for (const p of plan) {
    const dollars = p.priceWei ? ` ≈ $${(tacOf(p.priceWei) * tacUsd).toFixed(2)}` : '';
    out(`${p.action.padEnd(5)} ${String(p.bits).padStart(2)} bits  ${p.address}  nonce ${p.nonce}${p.priceWei ? `  ${tacOf(p.priceWei)} TAC${dollars}` : ''}${p.reason ? `  (${p.reason})` : ''}${p.note ? `  (${p.note})` : ''}`);
  }
  out(`\n${calls.length} call${calls.length === 1 ? '' : 's'} for the shop's owner to make (to ${shop}, value 0):`);
  calls.forEach((c, i) => out(`  ${i + 1}. ${c.label}`));
  const file = opt('out');
  if (file) {
    writeFileSync(file, JSON.stringify({ shop, generatedAt: new Date().toISOString(), params: { keep, keepTo, minBits, chunk, ...pricing }, plan: plan.map((p) => ({ ...p, priceWei: p.priceWei?.toString() })), calls }, null, 2));
    out(`\nwritten to ${file}`);
  }
  return { plan, calls };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main(process.argv.slice(2)).catch((e) => { console.error(`error: ${e.message}`); process.exit(1); });
}
