#!/usr/bin/env node
// Turns per-token holder snapshots into one allocation list for the airdrop tree.
//
// Each token gets a share of the pool set by its rank weight. Inside a token every eligible holder takes a share equal to its
// balance over the token's eligible supply, so ERC20 balances at any decimals and ERC721 token counts are all reduced to the same
// dimensionless fraction before they are added. An address's allocation is the sum over tokens of (token pool x its share).
// Blacklisted addresses are removed from every denominator, so nothing is diluted by their balances and nothing is
// redistributed to them.
//
// After the sum, an optional floor drops allocations that are too small to be worth a claim and an optional cap limits a single
// address; both re-normalise the rest to the full pool. The result is rounded down to the pool's unit and the remainder is handed
// out one unit at a time by largest fractional remainder, so the list adds up to the pool exactly.
//
// Usage: node tools/airdrop-weights.mjs --snapshot <dir> --total <TAC> [--weights linear|geometric:<r>|<w1,w2,...>]
//          [--floor <TAC>] [--cap <fraction>] [--blacklist <file>] [--exclude 0x..,0x..] [--out list.json] [--report report.json]
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

export const UNIT = 10n ** 10n;            // the pool's value unit in wei
const SCALE = 10n ** 36n;                   // fixed-point scale for the fractional arithmetic
const ADDR = /^0x[0-9a-f]{40}$/;

export function parseTac(s) {
  const m = /^(\d+)(?:\.(\d{1,18}))?$/.exec(String(s).trim());
  if (!m) throw new Error(`bad TAC amount: ${s}`);
  return BigInt(m[1]) * 10n ** 18n + BigInt((m[2] || '').padEnd(18, '0'));
}
export const formatTac = (wei) => { const w = BigInt(wei); const f = (w % 10n ** 18n).toString().padStart(18, '0').replace(/0+$/, ''); return `${w / 10n ** 18n}${f ? '.' + f : ''}`; };

// Rank weights, as integers over a common scale. Token 1 is the highest priority.
export function rankWeights(n, spec = 'linear') {
  if (spec === 'linear') return Array.from({ length: n }, (_, i) => BigInt(n - i) * SCALE);
  if (spec.startsWith('geometric:')) {
    const r = Number(spec.slice(10));
    if (!(r > 0 && r < 1)) throw new Error('geometric ratio must be between 0 and 1');
    return Array.from({ length: n }, (_, i) => BigInt(Math.round(r ** i * 1e12)) * (SCALE / 10n ** 12n));
  }
  const parts = spec.split(',').map((x) => x.trim());
  if (parts.length !== n) throw new Error(`expected ${n} weights, got ${parts.length}`);
  return parts.map((x) => { if (!/^\d+(\.\d+)?$/.test(x) || Number(x) <= 0) throw new Error(`bad weight ${x}`); return BigInt(Math.round(Number(x) * 1e12)) * (SCALE / 10n ** 12n); });
}

// tokens: [{ holders: [{ address, balance }] }] in priority order. Returns { entries, report }.
export function allocate(tokens, { totalWei, weights = 'linear', floorWei = 0n, cap = null, blacklist = [] } = {}) {
  if (totalWei % UNIT !== 0n || totalWei <= 0n) throw new Error('total must be a positive multiple of the pool unit');
  const bad = new Set(blacklist.map((a) => a.toLowerCase()));
  const w = rankWeights(tokens.length, weights);
  // eligible supply per token
  const elig = tokens.map((t) => {
    const m = new Map();
    for (const h of t.holders) {
      const a = String(h.address).toLowerCase();
      if (!ADDR.test(a)) throw new Error(`bad holder address ${h.address}`);
      const b = BigInt(h.balance);
      if (b <= 0n || bad.has(a) || BigInt(a) === 0n) continue;
      m.set(a, (m.get(a) || 0n) + b);
    }
    let sum = 0n; for (const b of m.values()) sum += b;
    return { m, sum };
  });
  const live = elig.map((e, i) => (e.sum > 0n ? i : -1)).filter((i) => i >= 0);
  if (!live.length) throw new Error('no eligible holders in any token');
  let W = 0n; for (const i of live) W += w[i];
  // allocation of the whole pool, fixed point (fractions of totalWei, scaled by SCALE)
  let frac = new Map();
  const perToken = tokens.map(() => 0n);
  for (const i of live) {
    const pool = (w[i] * SCALE) / W;                                    // this token's fraction of the pool
    perToken[i] = pool;
    for (const [a, b] of elig[i].m) frac.set(a, (frac.get(a) || 0n) + (pool * b) / elig[i].sum);
  }
  const notes = { floorDropped: 0, capped: 0, rounds: 0 };
  const floorFrac = floorWei > 0n ? (floorWei * SCALE) / totalWei : 0n;
  const capFrac = cap === null ? null : BigInt(Math.round(cap * 1e12)) * (SCALE / 10n ** 12n);
  for (let round = 0; round < 100; round++) {
    notes.rounds = round + 1;
    let changed = false;
    if (floorFrac > 0n) {
      for (const [a, f] of frac) if (f < floorFrac) { frac.delete(a); notes.floorDropped++; changed = true; }
    }
    let sum = 0n; for (const f of frac.values()) sum += f;
    if (sum === 0n) throw new Error('the floor removes every recipient');
    // scale everyone so the list adds to the whole pool
    const next = new Map();
    for (const [a, f] of frac) next.set(a, (f * SCALE) / sum);
    frac = next;
    if (capFrac !== null) {
      let excess = 0n, free = 0n;
      for (const [a, f] of frac) { if (f > capFrac) { excess += f - capFrac; frac.set(a, capFrac); } else if (f < capFrac) free += f; }
      if (excess > 0n) {
        if (free === 0n) throw new Error('the cap is too low to hold the whole pool');
        for (const [a, f] of frac) if (f < capFrac) frac.set(a, f + (excess * f) / free);
        notes.capped++; changed = true;
      }
    }
    if (!changed) break;
  }
  // exact units: floor, then largest remainder
  const units = totalWei / UNIT;
  const rows = [];
  let used = 0n;
  for (const [a, f] of frac) {
    const scaled = f * units;                          // units x SCALE
    const u = scaled / SCALE;
    rows.push({ address: a, units: u, rem: scaled % SCALE });
    used += u;
  }
  rows.sort((x, y) => (y.rem === x.rem ? (BigInt(x.address) < BigInt(y.address) ? -1 : 1) : (y.rem > x.rem ? 1 : -1)));
  let left = units - used;
  for (let i = 0; left > 0n; i = (i + 1) % rows.length, left--) rows[i].units += 1n;
  const entries = rows.filter((r) => r.units > 0n).map((r) => ({ address: r.address, amountWei: (r.units * UNIT).toString() }))
    .sort((a, b) => (BigInt(a.address) < BigInt(b.address) ? -1 : 1));
  const total = entries.reduce((s, e) => s + BigInt(e.amountWei), 0n);
  if (total !== totalWei) throw new Error(`allocation adds to ${total}, not ${totalWei}`);
  const amounts = entries.map((e) => BigInt(e.amountWei)).sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
  const q = (p) => amounts[Math.min(amounts.length - 1, Math.floor((amounts.length * p) / 100))];
  const report = {
    recipients: entries.length,
    totalWei: total.toString(),
    perTokenShareOfPool: perToken.map((f) => Number(f) / Number(SCALE)),
    eligibleHolders: elig.map((e) => e.m.size),
    eligibleSupply: elig.map((e) => e.sum.toString()),
    largest: amounts.slice(0, 10).map((x) => formatTac(x)),
    median: formatTac(q(50)), p90: formatTac(q(10)), p99: formatTac(q(1)), smallest: formatTac(amounts[amounts.length - 1]),
    ...notes,
  };
  return { entries, report };
}

function arg(name, args) { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; }

function main() {
  const args = process.argv.slice(2);
  const fail = (m) => { console.error('airdrop-weights: ' + m); process.exit(1); };
  const dir = arg('--snapshot', args), total = arg('--total', args);
  if (!dir || !total) fail('usage: --snapshot <dir> --total <TAC> [--weights linear|geometric:<r>|w1,w2,..] [--floor <TAC>] [--cap <fraction>] [--blacklist <file>] [--exclude a,b] [--out list.json] [--report r.json]');
  const files = readdirSync(dir).filter((f) => /^\d+-0x[0-9a-fA-F]{40}\.json$/.test(f)).sort((a, b) => parseInt(a) - parseInt(b));
  if (!files.length) fail(`no <n>-<address>.json snapshot files in ${dir}`);
  const tokens = files.map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')));
  const meta = existsSync(join(dir, 'meta.json')) ? JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')) : null;
  const blPath = arg('--blacklist', args) || fileURLToPath(new URL('./airdrop-blacklist.json', import.meta.url));
  if (!existsSync(blPath)) fail(`cannot read the blacklist ${blPath}`);
  let bl = JSON.parse(readFileSync(blPath, 'utf8')); if (!Array.isArray(bl)) bl = bl.addresses;
  const blacklist = [...bl, ...(arg('--exclude', args) || '').split(',').filter(Boolean)];
  const cap = arg('--cap', args);
  let result;
  try {
    result = allocate(tokens, { totalWei: parseTac(total), weights: arg('--weights', args) || 'linear', floorWei: arg('--floor', args) ? parseTac(arg('--floor', args)) : 0n, cap: cap === undefined ? null : Number(cap), blacklist });
  } catch (e) { fail(e.message); }
  const out = arg('--out', args);
  if (out) writeFileSync(out, JSON.stringify(result.entries.map((e) => ({ address: e.address, amountWei: e.amountWei })), null, 2) + '\n');
  const rep = { snapshotBlock: meta && meta.block, tokens: tokens.map((t, i) => ({ n: i + 1, address: t.address, type: t.type, symbol: t.symbol, holders: t.holderCount })), ...result.report };
  if (arg('--report', args)) writeFileSync(arg('--report', args), JSON.stringify(rep, null, 2) + '\n');
  console.log(JSON.stringify(rep, null, 2));
  if (!out) console.log('(no --out: list not written)');
}

if (import.meta.url === `file://${process.argv[1]}`) main();
