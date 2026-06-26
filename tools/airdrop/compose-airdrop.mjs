// Airdrop strategy composer: turn N source-token holder snapshots into one merged TAC allocation snapshot,
// applying a per-source rate (multiplier) and merging duplicate accounts into a single leaf. Output feeds
// build-merkle.mjs unchanged.
//
//   pipeline:  fetch-holders.mjs (per source) → compose-airdrop.mjs (this) → build-merkle.mjs → deploy
//
// Per-source allocation (all exact BigInt, floor-rounded):
//   ERC20  rate R, source decimals d:  tac_raw = balance_raw · Rnum · 10^tacDec / (Rden · 10^d)
//          ("whole tokens held" × R, re-scaled to TAC's 18 decimals — so R is "TAC per 1 whole source token")
//   ERC721 rate R:                     tac_raw = nft_count · Rnum · 10^tacDec / Rden
//          (R is "TAC per NFT")
//   flat   amount A:                   tac_raw = A · 10^tacDec  for every qualifying holder, balance-blind
//
// R is given as a decimal string ("1000", "0.01", "1000.5") and parsed to an exact num/den fraction, so any
// multiple — large or fractional — is lossless. Optional per-source `minTokens` (drop dust holders),
// `cap` (max TAC per account), `exclude` (addresses to drop; zero + 0xdead + the source contract itself are
// auto-excluded). Accounts appearing in multiple sources are SUMMED into one leaf (one claim per account).
//
// Budget: if `budget` is set and the merged total exceeds it, the run FAILS unless `scaleToBudget:true`, in
// which case every allocation is scaled by budget/total (last holder takes the remainder, dust-safe) so the
// distributed sum is EXACTLY the budget.
//
// CLI:  node tools/airdrop/compose-airdrop.mjs <config.json> [snapshot.json]
//       (writes the snapshot array for build-merkle.mjs, prints total + per-source breakdown)
//
// Config shape — see tools/airdrop/airdrop.config.example.json.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fetchHolders } from './fetch-holders.mjs';

const ZERO = '0x0000000000000000000000000000000000000000';
const DEAD = '0x000000000000000000000000000000000000dead';

function rateFraction(r) {
  const s = String(r).trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`bad rate '${r}' (use a non-negative decimal like 1000 or 0.01)`);
  const [int, frac = ''] = s.split('.');
  const num = BigInt(int + frac);
  const den = 10n ** BigInt(frac.length);
  if (num === 0n) throw new Error(`rate '${r}' is zero`);
  return { num, den };
}

const pow10 = (n) => 10n ** BigInt(n);

async function loadSource(src, { tacDec, apiKey, cacheDir }) {
  let snap;
  if (src.raw) {
    snap = JSON.parse(readFileSync(resolve(src.raw), 'utf8'));
  } else if (src.address) {
    const cache = src.cache || `${cacheDir}/${src.address.toLowerCase()}.json`;
    if (existsSync(cache) && !src.refetch) {
      snap = JSON.parse(readFileSync(cache, 'utf8'));
    } else {
      process.stderr.write(`fetching ${src.type} ${src.address} …\n`);
      snap = await fetchHolders({
        address: src.address,
        type: src.type,
        chainId: src.chain || 1,
        fromBlock: src.fromBlock || 0,
        toBlock: src.toBlock,
        apiKey,
        decimals: src.decimals,
        onProgress: (n) => process.stderr.write(`\r  …${n} transfers replayed`),
      });
      process.stderr.write('\n');
      mkdirSync(dirname(cache), { recursive: true });
      writeFileSync(cache, JSON.stringify(snap, null, 2));
    }
  } else {
    throw new Error(`source '${src.name}' needs either "raw" or "address"`);
  }

  const isNft = (src.type || snap.type) === 'erc721';
  const srcDec = isNft ? 0 : (src.decimals ?? snap.decimals);
  if (!isNft && (srcDec == null)) {
    throw new Error(`source '${src.name}' is erc20 but no decimals known — set "decimals" in the config (snapshot didn't carry it)`);
  }

  const excl = new Set([ZERO, DEAD, src.address?.toLowerCase()].filter(Boolean));
  for (const e of src.exclude || []) excl.add(String(e).toLowerCase());

  const mode = src.mode || (src.flat != null ? 'flat' : 'rate');
  const frac = mode === 'flat' ? null : rateFraction(src.rate ?? '1');
  const flatRaw = mode === 'flat' ? BigInt(String(src.flat)) * pow10(tacDec) : 0n;
  const minTokensRaw = src.minTokens != null
    ? (isNft ? BigInt(String(src.minTokens)) : BigInt(Math.round(Number(src.minTokens) * 1e6)) * pow10(srcDec) / 1_000_000n)
    : 0n;
  const capRaw = src.cap != null ? BigInt(String(src.cap)) * pow10(tacDec) : 0n;

  const out = new Map();
  let groupTotal = 0n;
  for (const [acctRaw, balStr] of Object.entries(snap.holders)) {
    const acct = acctRaw.toLowerCase();
    if (excl.has(acct)) continue;
    const bal = BigInt(balStr); // erc20: raw units; erc721: nft count
    if (bal < minTokensRaw) continue;
    if (minTokensRaw === 0n && bal === 0n) continue;

    let tac;
    if (mode === 'flat') {
      tac = flatRaw;
    } else if (isNft) {
      tac = (bal * frac.num * pow10(tacDec)) / frac.den;
    } else {
      tac = (bal * frac.num * pow10(tacDec)) / (frac.den * pow10(srcDec));
    }
    if (capRaw > 0n && tac > capRaw) tac = capRaw;
    if (tac === 0n) continue;
    out.set(acct, tac);
    groupTotal += tac;
  }
  return { name: src.name || src.address || src.raw, count: out.size, total: groupTotal, alloc: out };
}

export async function compose(config, { apiKey = process.env.ETHERSCAN_API_KEY, cacheDir = 'tools/airdrop/raw' } = {}) {
  const tacDec = config.tacDecimals ?? 18;
  const merged = new Map();
  const breakdown = [];
  for (const src of config.sources) {
    const g = await loadSource(src, { tacDec, apiKey, cacheDir });
    for (const [acct, tac] of g.alloc) merged.set(acct, (merged.get(acct) || 0n) + tac);
    breakdown.push({ name: g.name, holders: g.count, subtotal: g.total.toString() });
  }

  // Global floor: drop sub-threshold merged allocations (e.g. < 1 whole TAC) to keep the tree lean.
  const globalMinRaw = config.minAllocation != null ? BigInt(String(config.minAllocation)) * pow10(tacDec) : 0n;
  let entries = [...merged.entries()].filter(([, v]) => v >= globalMinRaw && v > 0n);
  entries.sort((a, b) => (a[1] < b[1] ? 1 : a[1] > b[1] ? -1 : 0)); // largest first (stable, deterministic)

  let total = entries.reduce((s, [, v]) => s + v, 0n);

  // Budget enforcement / proportional scaling.
  if (config.budget != null) {
    const budgetRaw = BigInt(String(config.budget)) * pow10(tacDec);
    if (total > budgetRaw) {
      if (!config.scaleToBudget) {
        throw new Error(`merged total ${fmt(total, tacDec)} exceeds budget ${config.budget} TAC. Lower a rate, add caps, or set "scaleToBudget": true.`);
      }
      let acc = 0n;
      for (let i = 0; i < entries.length; i++) {
        const v = i === entries.length - 1 ? budgetRaw - acc : (entries[i][1] * budgetRaw) / total;
        entries[i][1] = v;
        acc += v;
      }
      entries = entries.filter(([, v]) => v > 0n);
      total = entries.reduce((s, [, v]) => s + v, 0n);
    }
  }

  const snapshot = entries.map(([account, v], index) => ({ index, account, amount: v.toString() }));
  return { snapshot, total, tacDec, breakdown, count: snapshot.length };
}

function fmt(raw, dec) {
  const s = raw.toString().padStart(dec + 1, '0');
  const whole = s.slice(0, -dec) || '0';
  return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${s.slice(-dec).slice(0, 4)}`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const cfgPath = process.argv[2];
  if (!cfgPath) { console.error('usage: node tools/airdrop/compose-airdrop.mjs <config.json> [snapshot.json]'); process.exit(1); }
  const config = JSON.parse(readFileSync(cfgPath, 'utf8'));
  const out = process.argv[3] || config.output || 'tools/airdrop/snapshot.json';
  const { snapshot, total, tacDec, breakdown, count } = await compose(config);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(snapshot, null, 2));
  console.log('\nper-source:');
  for (const b of breakdown) console.log(`  ${b.name.padEnd(28)} ${String(b.holders).padStart(7)} holders   ${fmt(BigInt(b.subtotal), tacDec)} TAC`);
  console.log(`\nmerged recipients : ${count}`);
  console.log(`TOTAL_ALLOCATION  : ${total.toString()}  (= ${fmt(total, tacDec)} TAC)`);
  console.log(`snapshot          : ${out}`);
  console.log(`\nNEXT: node tools/airdrop/build-merkle.mjs ${out} tools/airdrop/out.json`);
}
