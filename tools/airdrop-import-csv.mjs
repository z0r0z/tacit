#!/usr/bin/env node
// Turns Etherscan token-holder CSV exports into the per-token snapshot files airdrop-weights.mjs reads.
//
// The token order (which sets the weighting) is given by --tokens, a JSON list of { address, type: "erc20" | "erc721" } in priority order. Each
// address is matched to its CSV in --dir by the address in the file name. ERC20 balances are decimal strings with thousands separators and are
// converted to exact integers at the token's own decimals (read from the chain, or --decimals 18); ERC721 quantities are integer counts.
// Every file is checked for malformed rows, duplicates and a total that matches the token's totalSupply where the token exposes it.
//
// --reread replaces each balance with the token's balanceOf at the latest block, which fixes an export that lags the chain; a holder that is
// missing from the export cannot be found this way, so the supply check still applies.
// Usage: node tools/airdrop-import-csv.mjs --dir v1-drop --tokens tokens.json --out snapshot-dir [--rpc <url>] [--allow-supply-drift <fraction>] [--reread]
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const ADDR = /^0x[0-9a-f]{40}$/;

// "1,234.5" at 18 decimals -> 1234500000000000000000n. Rejects more fractional digits than the token has.
export function parseDecimal(str, decimals) {
  const s = String(str).replace(/,/g, '').trim();
  const m = /^(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) throw new Error(`bad number "${str}"`);
  const frac = m[2] || '';
  if (frac.length > decimals) throw new Error(`"${str}" has more than ${decimals} decimals`);
  return BigInt(m[1]) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, '0') || '0');
}

// Minimal CSV parser for Etherscan exports: quoted fields, commas inside quotes, \r\n or \n.
export function parseCsv(text) {
  const rows = []; let row = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n') { row.push(f.replace(/\r$/, '')); rows.push(row); row = []; f = ''; }
    else f += c;
  }
  if (f.length || row.length) { row.push(f.replace(/\r$/, '')); rows.push(row); }
  return rows.filter((r) => r.length > 1 || (r[0] || '').trim());
}

export function holdersFromCsv(text, { type, decimals }) {
  const rows = parseCsv(text);
  const head = rows.shift() || [];
  if (String(head[0]).replace(/"/g, '') !== 'HolderAddress') throw new Error('not an Etherscan holder export (first column must be HolderAddress)');
  const want = type === 'erc721' ? 'Quantity' : 'Balance';
  if (String(head[1]).replace(/"/g, '') !== want) throw new Error(`expected a ${want} column for ${type}, got ${head[1]}`);
  const seen = new Set(), holders = [];
  rows.forEach((r, i) => {
    const a = String(r[0]).trim().toLowerCase();
    if (!ADDR.test(a)) throw new Error(`row ${i + 2}: bad address ${r[0]}`);
    if (seen.has(a)) throw new Error(`row ${i + 2}: duplicate holder ${a}`);
    seen.add(a);
    let bal;
    if (type === 'erc721') { if (!/^\d+$/.test(String(r[1]).replace(/,/g, ''))) throw new Error(`row ${i + 2}: bad quantity ${r[1]}`); bal = BigInt(String(r[1]).replace(/,/g, '')); }
    else bal = parseDecimal(r[1], decimals);
    if (bal > 0n) holders.push({ address: a, balance: bal.toString() });
  });
  holders.sort((x, y) => (BigInt(y.balance) > BigInt(x.balance) ? 1 : BigInt(y.balance) < BigInt(x.balance) ? -1 : x.address < y.address ? -1 : 1));
  return holders;
}

const rpc = async (url, method, params) => {
  const r = await (await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json();
  if (r.error) throw new Error(r.error.message);
  return r.result;
};
const ethCall = (url, to, data) => rpc(url, 'eth_call', [{ to, data }, 'latest']).catch(() => null);

// Re-read every holder's balance from the chain at "latest" with batched eth_call requests. Returns a Map address -> bigint, or null entries
// for calls that failed (for example the zero address on some tokens).
export async function rereadBalances(url, token, holders, { batch = 200 } = {}) {
  const out = new Map();
  for (let i = 0; i < holders.length; i += batch) {
    const part = holders.slice(i, i + batch);
    const body = part.map((h, j) => ({ jsonrpc: '2.0', id: j, method: 'eth_call', params: [{ to: token, data: '0x70a08231' + h.address.slice(2).padStart(64, '0') }, 'latest'] }));
    let res;
    for (let attempt = 0; ; attempt++) {
      try { res = await (await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json(); if (Array.isArray(res)) break; throw new Error('bad batch response'); }
      catch (e) { if (attempt >= 4) throw e; await new Promise((r) => setTimeout(r, 1000 * (attempt + 1))); }
    }
    for (const r of res) out.set(part[r.id].address, r.result && r.result !== '0x' ? BigInt(r.result) : null);
  }
  return out;
}

function arg(name, args) { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; }

async function main() {
  const args = process.argv.slice(2);
  const fail = (m) => { console.error('airdrop-import-csv: ' + m); process.exit(1); };
  const dir = arg('--dir', args), tokensFile = arg('--tokens', args), out = arg('--out', args);
  if (!dir || !tokensFile || !out) fail('usage: --dir <csv dir> --tokens <tokens.json> --out <dir> [--rpc <url>] [--allow-supply-drift <fraction>] [--reread]');
  const url = arg('--rpc', args) || 'https://ethereum-rpc.publicnode.com';
  const drift = Number(arg('--allow-supply-drift', args) || '0.001');
  const tokens = JSON.parse(readFileSync(tokensFile, 'utf8'));
  const files = readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.csv'));
  mkdirSync(out, { recursive: true });
  const summary = [];
  for (let n = 0; n < tokens.length; n++) {
    const t = tokens[n], addr = t.address.toLowerCase();
    if (!ADDR.test(addr) || !['erc20', 'erc721'].includes(t.type)) fail(`token ${n + 1}: needs a 20-byte address and type erc20 or erc721`);
    const matches = files.filter((f) => f.toLowerCase().includes(addr));
    if (matches.length !== 1) fail(`token ${n + 1} ${addr}: expected exactly one CSV in ${dir}, found ${matches.length}`);
    let decimals = 0;
    if (t.type === 'erc20') {
      const d = await ethCall(url, addr, '0x313ce567');
      decimals = d ? Number(BigInt(d)) : Number(arg('--decimals', args) || NaN);
      if (!Number.isInteger(decimals)) fail(`token ${n + 1}: cannot read decimals; pass --decimals`);
    }
    const holders = holdersFromCsv(readFileSync(join(dir, matches[0]), 'utf8'), { type: t.type, decimals });
    let rereadNote = '';
    if (args.includes('--reread')) {
      const chain = await rereadBalances(url, addr, holders);
      let changed = 0;
      for (const h of holders) { const v = chain.get(h.address); if (v === null || v === undefined) continue; if (v.toString() !== h.balance) { changed++; h.balance = v.toString(); } }
      for (let i = holders.length - 1; i >= 0; i--) if (holders[i].balance === '0') holders.splice(i, 1);
      holders.sort((x, y) => (BigInt(y.balance) > BigInt(x.balance) ? 1 : BigInt(y.balance) < BigInt(x.balance) ? -1 : x.address < y.address ? -1 : 1));
      rereadNote = `; ${changed} balance(s) replaced by the chain value`;
    }
    let sum = 0n; for (const h of holders) sum += BigInt(h.balance);
    const sup = await ethCall(url, addr, '0x18160ddd');
    const totalSupply = sup && sup !== '0x' ? BigInt(sup) : null;
    let supplyCheck = 'not available' + rereadNote;
    if (totalSupply !== null && totalSupply > 0n) {
      const diff = sum > totalSupply ? sum - totalSupply : totalSupply - sum;
      const frac = Number((diff * 10n ** 12n) / totalSupply) / 1e12;
      supplyCheck = `csv sum ${sum} vs supply ${totalSupply} (differs by ${(frac * 100).toFixed(6)}%)${rereadNote}`;
      if (frac > drift) fail(`token ${n + 1} ${addr}: ${supplyCheck} — more than the allowed ${drift * 100}%: the export is incomplete or out of date`);
    }
    const file = join(out, `${n + 1}-${t.address}.json`);
    writeFileSync(file, JSON.stringify({ address: t.address, type: t.type, symbol: t.symbol || null, decimals, source: matches[0], totalSupply: totalSupply === null ? null : totalSupply.toString(), csvSum: sum.toString(), holderCount: holders.length, holders }, null, 1) + '\n');
    summary.push({ n: n + 1, address: t.address, type: t.type, decimals, holders: holders.length, supplyCheck });
    console.log(`${n + 1}. ${t.address} ${t.type} decimals ${decimals}: ${holders.length} holders; ${supplyCheck}`);
  }
  writeFileSync(join(out, 'meta.json'), JSON.stringify({ source: 'etherscan-csv', tokens: summary }, null, 2) + '\n');
}

if (import.meta.url === `file://${process.argv[1]}`) main();
