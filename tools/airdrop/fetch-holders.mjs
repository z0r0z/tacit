// Holder-snapshot fetcher for the EVM airdrop pipeline (feeds compose-airdrop.mjs → build-merkle.mjs).
//
// Reconstructs the full holder set + balances of any ERC20 or ERC721 from its Transfer-event log, using
// the Etherscan v2 unified API (one key, any chain via chainid). Log reconstruction works on a FREE key —
// it does not need the Pro `tokenholderlist` endpoint — and is exact: it replays every Transfer from
// deployment to a pinned block, so the snapshot is verifiable and reproducible.
//
//   ERC20  : balance[acct] = Σ incoming value − Σ outgoing value (raw token units, BigInt).
//   ERC721 : owner[tokenId] tracked through transfers; holders[acct] = count of tokenIds owned.
//
// Completeness guarantee: Etherscan getLogs caps a response at 1000 records WITHOUT signalling truncation.
// We therefore only ACCEPT a block window whose page came back < 1000 (⇒ it returned everything in range);
// any full page shrinks the window and retries, so no transfer is ever silently dropped. A single block
// with > 1000 transfers falls back to page paging and warns if even that caps.
//
// CLI:
//   node tools/airdrop/fetch-holders.mjs --address 0xTOKEN --type erc20|erc721 \
//        [--chain 1] [--from-block 0] [--to-block latest] [--out raw/<name>.json] \
//        [--api-key KEY | env ETHERSCAN_API_KEY] [--min-block-batch 1] [--decimals N]
//
//   out.json : { address, type, chainId, toBlock, decimals, totalSupplyHeld, count,
//                holders: { "0xacct": "<rawBalance|nftCount>" } }
//
// Programmatic:  import { fetchHolders } from './fetch-holders.mjs'

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const ZERO = '0x0000000000000000000000000000000000000000';
const PAGE_CAP = 1000; // Etherscan getLogs hard cap per response

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const topicToAddr = (t) => '0x' + String(t).slice(-40).toLowerCase();
const hexToBig = (h) => (h && h !== '0x' ? BigInt(h) : 0n);

async function esGet(params, { apiKey, chainId, retries = 5 }) {
  const qs = new URLSearchParams({ ...params, chainid: String(chainId), apikey: apiKey });
  const url = `https://api.etherscan.io/v2/api?${qs}`;
  for (let attempt = 0; ; attempt++) {
    let j;
    try {
      const res = await fetch(url);
      j = await res.json();
    } catch (e) {
      if (attempt >= retries) throw e;
      await sleep(500 * (attempt + 1));
      continue;
    }
    // status "1" = ok; "0" with "No records found" = legitimately empty; other "0" = rate-limit/error → retry.
    if (j.status === '1') return j.result;
    if (typeof j.message === 'string' && /no records found/i.test(j.message)) return [];
    if (attempt >= retries) {
      throw new Error(`Etherscan error: ${j.message || 'unknown'} :: ${JSON.stringify(j.result).slice(0, 200)}`);
    }
    await sleep(600 * (attempt + 1)); // back off (free tier ~5 req/s; "Max rate limit reached")
  }
}

async function latestBlock(ctx) {
  const r = await esGet({ module: 'proxy', action: 'eth_blockNumber' }, ctx);
  return Number(BigInt(r));
}

// All Transfer logs in [from,to], guaranteeing completeness by only accepting a < PAGE_CAP page.
async function* transferLogs(address, fromBlock, toBlock, ctx, minBatch) {
  let from = fromBlock;
  let window = 250_000;
  while (from <= toBlock) {
    let to = Math.min(from + window, toBlock);
    const logs = await esGet(
      { module: 'logs', action: 'getLogs', address, topic0: TRANSFER_TOPIC, fromBlock: String(from), toBlock: String(to), offset: String(PAGE_CAP), page: '1' },
      ctx
    );
    if (logs.length >= PAGE_CAP) {
      if (to > from && window > minBatch) {
        window = Math.max(minBatch, Math.floor(window / 2)); // shrink and retry the same `from`
        continue;
      }
      // Degenerate: a single (or minimal) block range still caps → page through it explicitly.
      yield* await pageThroughBlock(address, from, to, ctx);
      from = to + 1;
      continue;
    }
    for (const lg of logs) yield lg;
    from = to + 1;
    if (logs.length < PAGE_CAP / 2) window = Math.min(window * 2, 1_000_000); // grow when sparse
    await sleep(220); // gentle on the free-tier rate limit
  }
}

async function pageThroughBlock(address, from, to, ctx) {
  const out = [];
  for (let page = 1; page <= 10; page++) {
    const logs = await esGet(
      { module: 'logs', action: 'getLogs', address, topic0: TRANSFER_TOPIC, fromBlock: String(from), toBlock: String(to), offset: String(PAGE_CAP), page: String(page) },
      ctx
    );
    out.push(...logs);
    if (logs.length < PAGE_CAP) return out;
    await sleep(220);
  }
  console.warn(`WARN: blocks ${from}-${to} exceed 10k transfers; snapshot may be incomplete for this range. Narrow --from-block/--to-block or use the Pro tokenholderlist.`);
  return out;
}

export async function fetchHolders({
  address,
  type,
  chainId = 1,
  fromBlock = 0,
  toBlock,
  apiKey = process.env.ETHERSCAN_API_KEY,
  minBlockBatch = 1,
  decimals,
  onProgress,
} = {}) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address || '')) throw new Error('--address must be a 20-byte hex token address');
  if (type !== 'erc20' && type !== 'erc721') throw new Error("--type must be 'erc20' or 'erc721'");
  if (!apiKey) throw new Error('Etherscan API key required (--api-key or ETHERSCAN_API_KEY)');
  const ctx = { apiKey, chainId };
  const tip = toBlock == null || toBlock === 'latest' ? await latestBlock(ctx) : Number(toBlock);

  const erc20 = type === 'erc20';
  const balances = new Map(); // erc20: acct->BigInt balance
  const owners = new Map();   // erc721: tokenId->acct
  let seen = 0;

  for await (const lg of transferLogs(address, fromBlock, tip, ctx, minBlockBatch)) {
    const from = topicToAddr(lg.topics[1]);
    const to = topicToAddr(lg.topics[2]);
    if (erc20) {
      const v = hexToBig(lg.data);
      if (from !== ZERO) balances.set(from, (balances.get(from) || 0n) - v);
      if (to !== ZERO) balances.set(to, (balances.get(to) || 0n) + v);
    } else {
      // ERC721 Transfer: tokenId is the 4th topic (indexed); data is empty.
      const tokenId = lg.topics[3];
      if (tokenId == null) continue; // not a canonical ERC721 Transfer (e.g. ERC20 mis-typed)
      if (to === ZERO) owners.delete(tokenId);
      else owners.set(tokenId, to);
    }
    if ((++seen & 8191) === 0 && onProgress) onProgress(seen);
  }

  const holders = {};
  let total = 0n;
  let count = 0;
  if (erc20) {
    for (const [acct, bal] of balances) {
      if (bal > 0n) { holders[acct] = bal.toString(); total += bal; count++; }
    }
  } else {
    const counts = new Map();
    for (const acct of owners.values()) counts.set(acct, (counts.get(acct) || 0n) + 1n);
    for (const [acct, c] of counts) { holders[acct] = c.toString(); total += c; count++; }
  }

  return {
    address: address.toLowerCase(),
    type,
    chainId,
    toBlock: tip,
    decimals: erc20 ? (decimals ?? null) : 0,
    totalSupplyHeld: total.toString(),
    count,
    holders,
  };
}

// ---- CLI ----
function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k.startsWith('--')) { const key = k.slice(2); const nxt = argv[i + 1]; if (!nxt || nxt.startsWith('--')) a[key] = true; else { a[key] = nxt; i++; } }
  }
  return a;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const a = parseArgs(process.argv.slice(2));
  const address = a.address;
  const type = a.type;
  const out = a.out || `tools/airdrop/raw/${(address || 'token').toLowerCase()}.json`;
  const snap = await fetchHolders({
    address,
    type,
    chainId: Number(a.chain || 1),
    fromBlock: Number(a['from-block'] || 0),
    toBlock: a['to-block'],
    apiKey: a['api-key'],
    minBlockBatch: Number(a['min-block-batch'] || 1),
    decimals: a.decimals != null ? Number(a.decimals) : undefined,
    onProgress: (n) => process.stderr.write(`\r  …${n} transfers replayed`),
  });
  process.stderr.write('\n');
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(snap, null, 2));
  console.log(`${snap.count} holders, ${snap.type}, @block ${snap.toBlock} → ${out}`);
}
