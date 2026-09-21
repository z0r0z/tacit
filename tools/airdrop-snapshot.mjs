#!/usr/bin/env node
// Holder-list reconstruction for a fixed set of mainnet tokens at ONE pinned block, for the TAC airdrop weighting step.
//
//   node tools/airdrop-snapshot.mjs [--block N] [--only 1,3] [--repin] [--no-etherscan] [--rpc url,url] [--out-dir D] [--cache-dir D]
//
// The explorer holder list is a paid endpoint and its CSV export is blocked, so the lists are rebuilt from chain data:
//   1. pin N (latest finalized, cross-checked on every reachable node, or --block) and record its hash + timestamp;
//   2. scan every Transfer log from the token's creation block to N. Logs are cached on disk per accepted window, so a
//      rerun resumes; windows adapt per source (shrunk on a range/result error, grown when sparse);
//   3. replay to balances (ERC20 balance map; ERC721 owner-by-tokenId, counted per owner). A token that is the ERC20 face of one id in a
//      multi-token singleton (TOKENS[].singleton) is replayed from the singleton's id-filtered Transfer instead, since its own logs miss
//      transfers made through the singleton interface;
//   4. verify hard: ERC20 replayed sum + balanceOf(0x0) == totalSupply() at N (burn() lowers supply, a plain transfer to zero does
//      not, and both emit the same log); ERC721 owned tokens == totalSupply() (or an ownerOf sample when the token has none); then
//      balanceOf at N of EVERY address that ever appeared in a Transfer must equal the replay (this also covers the 50 largest and
//      100 random holders, which are reported separately), and ownerOf on real tokens for ERC721. A dropped transfer between two
//      holders keeps the supply sum intact, so the per-address pass is what proves completeness. A token that fails a check gets no
//      output file. A token whose replay breaks (non-standard semantics) is retried with balanceOf(candidate) at N as the holder
//      source, and that result must sum to totalSupply.
//   5. flag holders that are contracts at N (bytecode probe at N; an EIP-7702 delegation stub is an account, not a contract) and
//      holders on tools/airdrop-blacklist.json. Blacklisted holders stay in the lists, flagged.
//
// Data sources: public JSON-RPC nodes (fallback + retry, per-node cooldowns) and, when ETHERSCAN_KEY is set in the environment,
// the Etherscan V2 API for logs and creation blocks. The key is read from the environment only and never written anywhere.
//
// Output (scratchpad/airdrop-snapshot/): <n>-<address>.json per token, meta.json, summary.md. Cache under cache/.
// Progress: scratchpad/airdrop-snapshot-progress.txt

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, renameSync, appendFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { keccak_256 } from '@noble/hashes/sha3.js';

export const TOOL_VERSION = '1.0.0';
const sig = (s) => Buffer.from(keccak_256(new TextEncoder().encode(s))).toString('hex');
export const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
// Transfer(address caller, address indexed from, address indexed to, uint256 indexed id, uint256 amount): the multi-token singleton's event.
export const TRANSFER_6909_TOPIC = '0x' + sig('Transfer(address,address,address,uint256,uint256)');
export const ZERO = '0x' + '00'.repeat(20);
const MULTICALL3 = '0xca11bde05977b3631167028862be2a173976ca11';
const ROOT = fileURLToPath(new URL('..', import.meta.url));

// Owner's priority order. Do not reorder: the weighting downstream depends on it.
// `singleton`: the token is the ERC20 face of one id in a multi-token singleton (a minimal-proxy clone whose balances live in the
// singleton). The clone's own Transfer events only cover transfers made through the ERC20 interface; the singleton's Transfer event
// filtered to id = uint160(token) covers every balance change, so that stream is what is replayed. Nothing is taken on trust: the
// result must still match the token's own totalSupply() and balanceOf() for every address.
export const TOKENS = [
  { n: 1, type: 'erc20', address: '0x00a6ba94bbb5474725515de88fe04f854f2dcb12' },
  { n: 2, type: 'erc20', address: '0xe9b1cfea55baa219e34301f2f31b9fd0921664ed', singleton: '0x0000000000009710cd229bf635c4500029651ee8' },
  { n: 3, type: 'erc721', address: '0x00000000008835cef3e0d2333695f288ee6b63a6' },
  { n: 4, type: 'erc20', address: '0x00000000000007c8612ba63df8ddefd9e6077c97' },
  { n: 5, type: 'erc721', address: '0x0000000000696760e15f265e828db644a0c242eb' },
  { n: 6, type: 'erc20', address: '0xf142cfa6ca3dfa4a131f12aacef4890e390d70d6' },
  { n: 7, type: 'erc20', address: '0x883d646d0c8202aa23f01d4af45e4e73804c3a49' },
];

const RPC_URLS = ['https://ethereum-rpc.publicnode.com', 'https://eth.drpc.org', 'https://eth.merkle.io', 'https://rpc.flashbots.net'];
const ES_URL = 'https://api.etherscan.io/v2/api';
const ES_PAGE = 1000; // rows per Etherscan page; page * offset must stay <= 10000
const ES_MAX_PAGES = 10;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const strip0x = (h) => (h.startsWith('0x') || h.startsWith('0X') ? h.slice(2) : h);
const hexToInt = (h) => (h === undefined || h === null || h === '' || h === '0x' ? 0 : Number(BigInt(h)));
const toHex = (n) => '0x' + n.toString(16);
const redact = (s) => { const k = process.env.ETHERSCAN_KEY; return k ? String(s).split(k).join('***') : String(s); };

// ─────────────────────────── pure replay + verification (unit-tested) ───────────────────────────

export class ReplayError extends Error {}
export class VerificationError extends Error {
  constructor(message, detail = {}) { super(message); this.detail = detail; }
}

export function topicAddr(t) {
  const h = strip0x(String(t)).toLowerCase();
  if (h.length !== 64 || !/^[0-9a-f]+$/.test(h) || !/^0{24}/.test(h)) throw new ReplayError(`bad address topic ${t}`);
  return '0x' + h.slice(24);
}

// A normalized log is { b: blockNumber, i: logIndex, t: [topic0, ...indexed], d: data }. ERC20 carries the value in data
// (3 topics); ERC721 indexes the tokenId (4 topics). Either shape is read for either declared type; the wrong shape is counted.
export function parseTransfer(log, type) {
  const t = log.t;
  if (!Array.isArray(t) || String(t[0]).toLowerCase() !== TRANSFER_TOPIC || (t.length !== 3 && t.length !== 4)) {
    throw new ReplayError(`unexpected Transfer log shape at block ${log.b} index ${log.i}: ${Array.isArray(t) ? t.length : 'no'} topics`);
  }
  const from = topicAddr(t[1]);
  const to = topicAddr(t[2]);
  let value;
  let shape;
  if (t.length === 4) {
    value = BigInt(t[3]);
    shape = 'indexed';
  } else {
    const d = strip0x(log.d || '');
    if (d.length !== 64) throw new ReplayError(`Transfer data is ${d.length / 2} bytes, expected 32, at block ${log.b} index ${log.i}`);
    value = BigInt('0x' + d);
    shape = 'data';
  }
  const anomalous = (type === 'erc20') !== (shape === 'data');
  return { from, to, value, anomalous };
}

// Singleton event for one id: topics [Transfer, from, to, id], data = caller ++ amount. Any other id or shape is refused.
export const idTopic = (token) => '0x' + '00'.repeat(12) + strip0x(token).toLowerCase();
export function parseTransfer6909(log, id) {
  const t = log.t;
  if (!Array.isArray(t) || t.length !== 4 || String(t[0]).toLowerCase() !== TRANSFER_6909_TOPIC) {
    throw new ReplayError(`unexpected singleton Transfer log shape at block ${log.b} index ${log.i}`);
  }
  if (String(t[3]).toLowerCase() !== id) throw new ReplayError(`singleton Transfer for another id at block ${log.b} index ${log.i}`);
  const d = strip0x(log.d || '');
  if (d.length !== 128) throw new ReplayError(`singleton Transfer data is ${d.length / 2} bytes, expected 64, at block ${log.b} index ${log.i}`);
  return { from: topicAddr(t[1]), to: topicAddr(t[2]), value: BigInt('0x' + d.slice(64)), anomalous: false };
}

// ERC20: mint = from zero, burn = to zero (kept in zeroBalance). A holder can never send more than it holds.
export function replayErc20(logs, parse = (l) => parseTransfer(l, 'erc20')) {
  const bal = new Map();
  let minted = 0n;
  let anomalies = 0;
  let transfers = 0;
  for (const log of logs) {
    const tr = parse(log);
    if (tr.anomalous) anomalies++;
    transfers++;
    if (tr.from === ZERO) minted += tr.value;
    else {
      const cur = bal.get(tr.from) ?? 0n;
      if (cur < tr.value) throw new ReplayError(`balance underflow: ${tr.from} holds ${cur} but sends ${tr.value} at block ${log.b} index ${log.i}`);
      bal.set(tr.from, cur - tr.value);
    }
    bal.set(tr.to, (bal.get(tr.to) ?? 0n) + tr.value);
  }
  const zeroBalance = bal.get(ZERO) ?? 0n;
  bal.delete(ZERO);
  for (const [a, v] of [...bal]) if (v === 0n) bal.delete(a);
  return { balances: bal, zeroBalance, minted, transfers, anomalies };
}

// ERC721: owner-by-tokenId. A move must come from the current owner, a mint must be of an unowned id, a burn (to zero) removes it.
export function replayErc721(logs) {
  const owners = new Map();
  const counts = new Map();
  let anomalies = 0;
  let transfers = 0;
  for (const log of logs) {
    const tr = parseTransfer(log, 'erc721');
    if (tr.anomalous) anomalies++;
    transfers++;
    const id = tr.value.toString();
    const cur = owners.get(id);
    if (tr.from === ZERO) {
      if (cur !== undefined) throw new ReplayError(`mint of token ${id} that is already owned by ${cur} at block ${log.b} index ${log.i}`);
    } else {
      if (cur === undefined) throw new ReplayError(`token ${id} moved from ${tr.from} but has no owner at block ${log.b} index ${log.i}`);
      if (cur !== tr.from) throw new ReplayError(`token ${id} moved from ${tr.from} but is owned by ${cur} at block ${log.b} index ${log.i}`);
      counts.set(cur, counts.get(cur) - 1);
    }
    if (tr.to === ZERO) owners.delete(id);
    else {
      owners.set(id, tr.to);
      counts.set(tr.to, (counts.get(tr.to) ?? 0) + 1);
    }
  }
  for (const [a, v] of [...counts]) if (v === 0) counts.delete(a);
  return { owners, counts, owned: owners.size, transfers, anomalies };
}

// Supply identity: totalSupply == sum of holder balances + the balance the token itself reports for the zero address. A burn() lowers
// supply while a plain transfer to zero leaves it counted, and both emit the same Transfer, so the event-side zero balance cannot
// decide the identity; zeroChain (balanceOf(0x0) at N) does. When it is unreadable only the two extreme readings are accepted.
export function verifyErc20Supply(replay, supply, zeroChain = null) {
  let sum = 0n;
  for (const v of replay.balances.values()) sum += v;
  const base = { replayedSum: sum.toString(), zeroAddressEventBalance: replay.zeroBalance.toString(), zeroAddressChainBalance: zeroChain === null ? null : zeroChain.toString(), totalSupply: supply.toString() };
  if (zeroChain !== null) {
    if (sum + zeroChain === supply) return { ok: true, semantics: zeroChain > 0n ? 'zero-address-holds' : replay.zeroBalance === 0n ? 'exact' : 'burn-reduces-supply', ...base };
    return { ok: false, reason: `replayed sum ${sum} + balanceOf(zero address) ${zeroChain} != totalSupply ${supply} (difference ${sum + zeroChain - supply})`, ...base };
  }
  if (sum === supply) return { ok: true, semantics: replay.zeroBalance === 0n ? 'exact' : 'burn-reduces-supply', ...base };
  if (sum + replay.zeroBalance === supply) return { ok: true, semantics: 'zero-address-counted', ...base };
  return { ok: false, reason: `replayed sum ${sum} (+ zero address ${replay.zeroBalance}) != totalSupply ${supply} (difference ${sum - supply})`, ...base };
}

// supply === null means the token exposes no totalSupply(); the caller must then rely on the ownerOf sample.
export function verifyErc721Supply(replay, supply) {
  if (supply === null) return { ok: null, ownedTokens: replay.owned, totalSupply: null };
  if (BigInt(replay.owned) === supply) return { ok: true, ownedTokens: replay.owned, totalSupply: supply.toString() };
  return { ok: false, reason: `replayed owned tokens ${replay.owned} != totalSupply ${supply}`, ownedTokens: replay.owned, totalSupply: supply.toString() };
}

// ─────────────────────────── chunk bookkeeping ───────────────────────────

// Uncovered sub-ranges of [from, to] given already-cached windows.
export function computeGaps(chunks, from, to) {
  const sorted = [...chunks].sort((a, b) => a.from - b.from);
  const gaps = [];
  let cur = from;
  for (const c of sorted) {
    if (c.to < cur) continue;
    if (cur > to) break;
    if (c.from > cur) gaps.push({ from: cur, to: Math.min(c.from - 1, to) });
    cur = Math.max(cur, c.to + 1);
  }
  if (cur <= to) gaps.push({ from: cur, to });
  return gaps;
}

// Concatenate cached windows into one ordered log list; refuses gaps, overlaps and repeated (block, index) pairs.
export function assembleLogs(chunks, from, to) {
  const sorted = [...chunks].sort((a, b) => a.from - b.from);
  const gaps = computeGaps(sorted, from, to);
  if (gaps.length) throw new Error(`log scan has gaps: ${gaps.slice(0, 3).map((g) => `${g.from}-${g.to}`).join(', ')}`);
  for (let k = 1; k < sorted.length; k++) if (sorted[k].from <= sorted[k - 1].to) throw new Error(`overlapping log windows ${sorted[k - 1].from}-${sorted[k - 1].to} and ${sorted[k].from}-${sorted[k].to}`);
  const out = [];
  for (const c of sorted) {
    const logs = [...c.logs].sort((x, y) => x.b - y.b || x.i - y.i);
    for (const l of logs) {
      if (l.b < c.from || l.b > c.to) throw new Error(`log at block ${l.b} outside its window ${c.from}-${c.to}`);
      if (l.b >= from && l.b <= to) out.push(l);
    }
  }
  for (let k = 1; k < out.length; k++) if (out[k].b === out[k - 1].b && out[k].i === out[k - 1].i) throw new Error(`duplicate log at block ${out[k].b} index ${out[k].i}`);
  return out;
}

export function normalizeLog(raw) {
  return { b: hexToInt(raw.blockNumber), i: hexToInt(raw.logIndex), t: raw.topics.map((x) => x.toLowerCase()), d: raw.data || '0x' };
}

// ─────────────────────────── ABI helpers ───────────────────────────

const word = (h) => strip0x(h).toLowerCase().padStart(64, '0');
export const addrWord = (a) => word(a);
export const uintWord = (n) => BigInt(n).toString(16).padStart(64, '0');
export const callData = (selector, ...words) => '0x' + selector + words.join('');

// Multicall3 aggregate3((address,bool,bytes)[]) with allowFailure = true for every call.
export function encodeAggregate3(calls) {
  const elems = calls.map((c) => {
    const d = strip0x(c.data);
    const len = d.length / 2;
    return addrWord(c.target) + uintWord(1) + uintWord(96) + uintWord(len) + d.padEnd(Math.ceil(len / 32) * 64, '0');
  });
  let off = calls.length * 32;
  const offs = elems.map((e) => { const o = off; off += e.length / 2; return uintWord(o); });
  return '0x82ad56cb' + uintWord(32) + uintWord(calls.length) + offs.join('') + elems.join('');
}

export function decodeAggregate3(ret) {
  const h = strip0x(ret);
  const w = (pos) => BigInt('0x' + h.slice(pos * 2, pos * 2 + 64));
  const base = Number(w(0));
  const n = Number(w(base));
  const out = [];
  for (let k = 0; k < n; k++) {
    const es = base + 32 + Number(w(base + 32 + k * 32));
    const success = w(es) !== 0n;
    const bo = Number(w(es + 32));
    const bl = Number(w(es + bo));
    out.push({ success, data: '0x' + h.slice((es + bo + 32) * 2, (es + bo + 32 + bl) * 2) });
  }
  return out;
}

export function decodeUint(hex) {
  const h = strip0x(hex || '');
  return h.length === 64 ? BigInt('0x' + h) : null;
}

export function decodeAddress(hex) {
  const h = strip0x(hex || '');
  return h.length === 64 ? '0x' + h.slice(24).toLowerCase() : null;
}

// string return, or a bytes32 for the older tokens that return one.
export function decodeString(hex) {
  const h = strip0x(hex || '');
  if (h.length === 64) return Buffer.from(h, 'hex').toString('utf8').replace(/\0+$/, '');
  if (h.length < 128) return null;
  const off = Number(BigInt('0x' + h.slice(0, 64)));
  const len = Number(BigInt('0x' + h.slice(off * 2, off * 2 + 64)));
  return Buffer.from(h.slice(off * 2 + 64, off * 2 + 64 + len * 2), 'hex').toString('utf8');
}

// Reads extcodesize of every 32-byte calldata word and returns the sizes packed as words (runtime code, used via a state override).
export const CODESIZE_PROBE = '0x5f5b3681101560145780353b81526020016001565b365ff3';
// Same loop, returning the first 32 code bytes of each address (EXTCODECOPY) so a 23-byte account can be told from a contract.
export const CODEHEAD_PROBE = '0x5f5b3681101560165760205f8283353c6020016001565b365ff3';
const PROBE_ADDR = '0x00000000000000000000000000000000000c0de5';

// ─────────────────────────── formatting + sampling ───────────────────────────

export function formatUnits(v, decimals) {
  const neg = v < 0n;
  const s = (neg ? -v : v).toString().padStart(decimals + 1, '0');
  const whole = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).replace(/0+$/, '');
  return (neg ? '-' : '') + whole + (frac ? '.' + frac : '');
}
const commas = (s) => s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
export const fmtAmount = (v, decimals) => { const [w, f] = formatUnits(v, decimals).split('.'); return commas(w) + (f ? '.' + f : ''); };

export function pctOf(part, total) {
  if (total === 0n) return '0.0000%';
  const x = (part * 1000000n) / total;
  return `${x / 10000n}.${(x % 10000n).toString().padStart(4, '0')}%`;
}

export function makeRng(seedHex) {
  let a = parseInt(strip0x(seedHex).slice(0, 8), 16) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// n distinct items, uniformly, from arr (all of arr when it is shorter than n).
export function sampleN(arr, n, rng) {
  const idx = arr.map((_, k) => k);
  const take = Math.min(n, idx.length);
  for (let k = 0; k < take; k++) {
    const j = k + Math.floor(rng() * (idx.length - k));
    [idx[k], idx[j]] = [idx[j], idx[k]];
  }
  return idx.slice(0, take).map((k) => arr[k]);
}

// ─────────────────────────── holder rows + summary (unit-tested) ───────────────────────────

// balances: Map(address -> bigint > 0). codeInfo: Map(address -> { contract, delegated }). Sorted by balance desc, then address.
export function buildHolderRows(balances, { blacklist = new Set(), codeInfo = new Map() } = {}) {
  const entries = [...balances].sort((a, b) => (a[1] === b[1] ? (a[0] < b[0] ? -1 : 1) : a[1] > b[1] ? -1 : 1));
  return entries.map(([address, b]) => {
    const ci = codeInfo.get(address);
    const row = { address, balance: b.toString(), isContract: !!(ci && ci.contract), blacklisted: blacklist.has(address) };
    if (ci && ci.delegated) row.delegated = true;
    return row;
  });
}

export function tokenStats(file, tokenAddress) {
  const supply = BigInt(file.totalSupply);
  let contractSum = 0n; let contractCount = 0; let blSum = 0n; let blCount = 0; let contractNonBlSum = 0n; let contractNonBlCount = 0;
  let self = 0n;
  for (const h of file.holders) {
    const b = BigInt(h.balance);
    if (h.isContract) { contractSum += b; contractCount++; }
    if (h.blacklisted) { blSum += b; blCount++; }
    if (h.isContract && !h.blacklisted) { contractNonBlSum += b; contractNonBlCount++; }
    if (h.address === tokenAddress) self = b;
  }
  return { supply, contractSum, contractCount, blSum, blCount, contractNonBlSum, contractNonBlCount, self };
}

export function renderSummary(files, meta) {
  const L = [];
  L.push('# Airdrop holder snapshot', '');
  L.push(`Snapshot block ${meta.snapshotBlock} (${meta.snapshotBlockHash}), ${meta.snapshotTimeIso}.`);
  L.push(`Blacklist: ${meta.blacklistCount} addresses (tools/airdrop-blacklist.json); blacklisted holders stay in the lists, flagged. "Contract" = code at the snapshot block (an EIP-7702 delegation stub counts as an account).`, '');
  for (const f of files) {
    const dec = f.decimals;
    const st = tokenStats(f, f.address);
    const fmt = (v) => fmtAmount(v, dec);
    L.push(`## ${f.n}. ${f.symbol ?? '?'} (${f.name ?? 'unnamed'}), ${f.type.toUpperCase()}`, '');
    L.push(`- address \`${f.address}\`, decimals ${dec}, verified by ${f.method}`);
    L.push(`- holders: ${f.holderCount}; total supply ${fmt(st.supply)} (raw ${f.totalSupply})`);
    L.push(`- held by contracts: ${fmt(st.contractSum)} (${pctOf(st.contractSum, st.supply)}) across ${st.contractCount} holders`);
    L.push(`- held by blacklisted addresses: ${fmt(st.blSum)} (${pctOf(st.blSum, st.supply)}) across ${st.blCount} holders`);
    L.push(`- balance of the token contract itself: ${fmt(st.self)} (${pctOf(st.self, st.supply)})`);
    L.push(`- held by contracts that are not blacklisted: ${fmt(st.contractNonBlSum)} (${pctOf(st.contractNonBlSum, st.supply)}) across ${st.contractNonBlCount} holders`, '');
    const row = (h, k) => `| ${k} | \`${h.address}\` | ${fmt(BigInt(h.balance))} | ${pctOf(BigInt(h.balance), st.supply)} | ${h.isContract ? 'contract' : h.delegated ? 'account (7702)' : 'account'} | ${h.blacklisted ? 'yes' : ''} |`;
    L.push('Top 25 holders', '', '| # | holder | balance | share | type | blacklisted |', '|---|---|---:|---:|---|---|');
    f.holders.slice(0, 25).forEach((h, k) => L.push(row(h, k + 1)));
    L.push('');
    const cands = f.holders.filter((h) => h.isContract && !h.blacklisted).slice(0, 15);
    L.push('Largest non-blacklisted contract holders (candidates for the blacklist)', '');
    if (!cands.length) L.push('none', '');
    else {
      L.push('| holder | balance | share | rank |', '|---|---:|---:|---:|');
      for (const h of cands) L.push(`| \`${h.address}\` | ${fmt(BigInt(h.balance))} | ${pctOf(BigInt(h.balance), st.supply)} | ${f.holders.indexOf(h) + 1} |`);
      L.push('');
    }
  }
  return L.join('\n') + '\n';
}

// ─────────────────────────── RPC error classification (unit-tested) ───────────────────────────

// kind: revert | big (range or result cap; hint = block span when the message states one) | rate | noarchive | unsupported | fatal | other
export function classifyError(message, code) {
  const m = String(message || '');
  if (/invalid api key|api key.*(missing|invalid)/i.test(m)) return { kind: 'fatal' };
  if (/execution reverted|\brevert/i.test(m) || code === 3) return { kind: 'revert' };
  if (/block range|ranges? over|range (is )?too|too many (results|logs|events)|more than \d[\d,]* (results|logs|events)|response (size )?(is )?too (big|large)|query returned more|result window is too large|limit exceeded|exceeds? (the )?(max|limit)|query timeout|smaller result|10,?000 (results|logs)/i.test(m)) {
    const mentionsBlocks = /block/i.test(m) && !/(results|logs|events|records)/i.test(m);
    const num = m.match(/(?:max(?:imum)? block range|range (?:of|is|limit)?|over|than)\D{0,12}(\d[\d,]{2,})/i);
    return { kind: 'big', hint: mentionsBlocks && num ? Number(num[1].replace(/,/g, '')) : undefined };
  }
  if (/rate.?limit|too many requests|\b429\b|error code: 1015|throttl|capacity|max calls per sec|exceeded.*(rps|requests|credits|quota)|compute units|daily request/i.test(m)) return { kind: 'rate' };
  if (/archive|missing trie node|header not found|block not found|unknown block|historical state|state .*(not available|pruned)|pruned|distance to target block|can't route|cannot route/i.test(m)) return { kind: 'noarchive' };
  if (/method not found|not whitelisted|is not supported|does not exist|unsupported|-32601/i.test(m)) return { kind: 'unsupported' };
  return { kind: 'other' };
}

// ─────────────────────────── network layer ───────────────────────────

class NetError extends Error {
  constructor(kind, message, hint, suggest) { super(message); this.kind = kind; this.hint = hint; this.suggest = suggest; }
}

const NET = { providers: [], es: null, pool: [], counter: 0, stats: {} };
let PROGRESS_FILE = null;

function progress(msg) {
  const line = `${new Date().toISOString()} ${redact(msg)}`;
  console.log(line);
  if (PROGRESS_FILE) appendFileSync(PROGRESS_FILE, line + '\n');
}

// Measured behaviour of the default public nodes for eth_getLogs over old ranges: the flashbots relay answers a wide range with an empty
// list instead of an error, drpc's free tier refuses any range past a few hundred blocks, merkle has no eth_getLogs. None of them is used
// as a log source. Nodes passed with --rpc are trusted for logs.
const NO_LOG_HOSTS = new Set(['rpc.flashbots.net', 'eth.drpc.org', 'eth.merkle.io']);

function mkProvider(name, url, kind, gap, logs) {
  return { name, url, kind, gap, logs, nextAt: 0, cooldownUntil: 0, unsupported: new Set(), minBlock: {}, fails: 0, rateHits: 0, span: Infinity, spanCap: Infinity, retired: false,
    stats: { ok: 0, rate: 0, big: 0, noarchive: 0, unsupported: 0, transient: 0, other: 0, logWindows: 0, logRows: 0 } };
}

function initNet({ rpcUrls, useEtherscan, custom }) {
  NET.providers = rpcUrls.map((u) => { const host = new URL(u).host; return mkProvider(host, u, 'rpc', 60, custom || !NO_LOG_HOSTS.has(host)); });
  NET.es = useEtherscan && process.env.ETHERSCAN_KEY ? mkProvider('etherscan', ES_URL, 'es', 230, true) : null;
  NET.pool = [...NET.providers, ...(NET.es ? [NET.es] : [])];
}

async function throttle(p) {
  const now = Date.now();
  const at = Math.max(now, p.nextAt);
  p.nextAt = at + p.gap;
  if (at > now) await sleep(at - now);
}

async function rpcSend(p, method, params) {
  await throttle(p);
  let res; let text;
  try {
    res = await fetch(p.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(60000) });
    text = await res.text();
  } catch (e) {
    throw new NetError('transient', `${p.name}: ${e.cause?.code || e.name}`);
  }
  let j;
  try { j = JSON.parse(text); } catch {
    const c = classifyError(text, res.status);
    throw new NetError(res.status === 429 || c.kind === 'rate' ? 'rate' : 'transient', `${p.name}: http ${res.status} ${text.slice(0, 80)}`);
  }
  if (Array.isArray(j)) j = j[0];
  if (j.error) {
    const c = classifyError(j.error.message, j.error.code);
    throw new NetError(c.kind, `${p.name}: ${j.error.message}`, c.hint);
  }
  if (j.result === undefined) throw new NetError('transient', `${p.name}: empty response`);
  return j.result;
}

async function esFetch(params) {
  await throttle(NET.es);
  const qs = new URLSearchParams({ chainid: '1', ...params, apikey: process.env.ETHERSCAN_KEY });
  let res; let text;
  try {
    res = await fetch(`${ES_URL}?${qs}`, { signal: AbortSignal.timeout(60000) });
    text = await res.text();
  } catch (e) {
    throw new NetError('transient', `etherscan: ${e.cause?.code || e.name}`);
  }
  try { return JSON.parse(text); } catch {
    throw new NetError(res.status === 429 ? 'rate' : 'transient', `etherscan: http ${res.status}`);
  }
}

function esFail(j) {
  const msg = typeof j.result === 'string' ? j.result : j.error?.message || j.message || 'unknown';
  const c = classifyError(msg, j.error?.code);
  return new NetError(c.kind, `etherscan: ${msg}`, c.hint);
}

async function esProxy(method, params) {
  let j;
  if (method === 'eth_call') {
    if (params.length > 2) throw new NetError('skip', 'etherscan: state override');
    if (params[0].data.length > 6000) throw new NetError('skip', 'etherscan: calldata too long for a GET');
    j = await esFetch({ module: 'proxy', action: 'eth_call', to: params[0].to, data: params[0].data, tag: params[1] });
  } else if (method === 'eth_getCode') j = await esFetch({ module: 'proxy', action: 'eth_getCode', address: params[0], tag: params[1] });
  else if (method === 'eth_getBlockByNumber') j = await esFetch({ module: 'proxy', action: 'eth_getBlockByNumber', tag: params[0], boolean: 'false' });
  else throw new NetError('unsupported', `etherscan: ${method}`);
  if (j.error || j.status === '0') throw esFail(j);
  if (j.result === undefined || j.result === null) throw new NetError('transient', 'etherscan: empty response');
  return j.result;
}

const send = (p, method, params) => (p.kind === 'es' ? esProxy(method, params) : rpcSend(p, method, params));

function noteError(p, e, block, method) {
  p.stats[e.kind in p.stats ? e.kind : 'other']++;
  p.lastError = redact(e.message).slice(0, 200);
  if (e.kind === 'rate') {
    p.rateHits++;
    p.cooldownUntil = Date.now() + Math.min(60000, 1000 * 2 ** Math.min(p.rateHits, 6));
  } else if (e.kind === 'noarchive') p.minBlock[method] = Math.max(p.minBlock[method] ?? 0, (block ?? 0) + 1);
  else if (e.kind === 'unsupported') p.unsupported.add(method);
  else if (e.kind === 'transient' || e.kind === 'other') {
    p.fails++;
    p.cooldownUntil = Date.now() + Math.min(30000, 1000 * 2 ** Math.min(p.fails, 5));
  }
}

// One JSON-RPC call with fallback across nodes. `block` is the block the call reads state at, so nodes that have pruned it are skipped.
// Rate limits and outages are waited out (about ten minutes in total) before giving up; the final error names what each node said.
async function rpc(method, params, { block = null, noEs = false } = {}) {
  const lastErr = new Map();
  for (let round = 0; round < 60; round++) {
    const now = Date.now();
    const cands = NET.pool.filter((p) => !p.retired && !(noEs && p.kind === 'es') && !p.unsupported.has(method) && p.cooldownUntil <= now && (block === null || block >= (p.minBlock[method] ?? 0)));
    for (let k = 0; k < cands.length; k++) {
      const p = cands[(NET.counter + k) % cands.length];
      try {
        const r = await send(p, method, params);
        p.stats.ok++; p.fails = 0; p.rateHits = Math.max(0, p.rateHits - 1);
        NET.counter++;
        return r;
      } catch (e) {
        if (!(e instanceof NetError)) throw e;
        lastErr.set(p.name, e.message);
        if (e.kind === 'revert') throw e;
        if (e.kind === 'fatal') throw new Error(e.message);
        if (e.kind !== 'skip') noteError(p, e, block, method);
      }
    }
    await sleep(Math.min(10000, 600 * (round + 1)));
  }
  throw new Error(`no node could serve ${method}: ${[...lastErr.values()].join(' | ') || 'none available'}`);
}

async function pMap(items, fn, concurrency) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      const k = next++;
      if (k >= items.length) return;
      out[k] = await fn(items[k], k);
    }
  }));
  return out;
}

// ─────────────────────────── pin + token metadata ───────────────────────────

async function pinBlock(cacheDir, override, repin) {
  const file = join(cacheDir, 'pin.json');
  if (override === undefined && !repin && existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'));
  let number = override;
  if (number === undefined) {
    const seen = [];
    for (const p of NET.providers) {
      try { seen.push(hexToInt((await rpcSend(p, 'eth_getBlockByNumber', ['finalized', false])).number)); } catch { /* node skipped */ }
    }
    if (!seen.length) {
      for (const p of NET.providers) {
        try { seen.push(hexToInt(await rpcSend(p, 'eth_blockNumber', [])) - 64); break; } catch { /* next node */ }
      }
    }
    if (!seen.length) throw new Error('could not read the chain head from any node');
    number = Math.min(...seen);
  }
  const heads = [];
  for (const p of NET.providers) {
    try {
      const b = await rpcSend(p, 'eth_getBlockByNumber', [toHex(number), false]);
      if (b) heads.push({ node: p.name, hash: b.hash, timestamp: hexToInt(b.timestamp) });
    } catch { /* node skipped */ }
  }
  if (!heads.length && NET.es) {
    const b = await esProxy('eth_getBlockByNumber', [toHex(number)]);
    heads.push({ node: 'etherscan', hash: b.hash, timestamp: hexToInt(b.timestamp) });
  }
  if (!heads.length) throw new Error(`no node returned block ${number}`);
  if (new Set(heads.map((h) => h.hash)).size !== 1) throw new Error(`nodes disagree on block ${number}: ${JSON.stringify(heads)}`);
  const pin = { number, hash: heads[0].hash, timestamp: heads[0].timestamp, confirmedBy: heads.map((h) => h.node) };
  writeJsonAtomic(file, pin);
  return pin;
}

function writeJsonAtomic(file, obj) {
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(obj));
  renameSync(tmp, file);
}

async function readTokenMeta(tok, pin) {
  const blockHex = toHex(pin.number);
  const call = async (data) => {
    try { return await rpc('eth_call', [{ to: tok.address, data }, blockHex], { block: pin.number }); } catch (e) {
      if (e instanceof NetError && e.kind === 'revert') return null;
      throw e;
    }
  };
  const meta = { name: decodeString(await call('0x06fdde03')), symbol: decodeString(await call('0x95d89b41')) };
  const supply = decodeUint(await call('0x18160ddd'));
  meta.totalSupply = supply;
  if (tok.type === 'erc20') {
    const dec = decodeUint(await call('0x313ce567'));
    if (dec === null) throw new VerificationError('decimals() is not readable at the snapshot block');
    meta.decimals = Number(dec);
    if (supply === null) throw new VerificationError('totalSupply() is not readable at the snapshot block');
  } else {
    meta.decimals = 0;
    const si = await call(callData('01ffc9a7', '80ac58cd'.padEnd(64, '0')));
    meta.erc721Interface = si === null ? null : decodeUint(si) === 1n;
  }
  return meta;
}

// ─────────────────────────── creation block ───────────────────────────

async function creationBlock(tok, pin, cacheDir) {
  const file = join(cacheDir, 'creation.json');
  const cache = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  if (cache[tok.address] !== undefined) return cache[tok.address];
  let block = null;
  if (NET.es) {
    for (let a = 0; a < 6 && block === null; a++) {
      try {
        const j = await esFetch({ module: 'contract', action: 'getcontractcreation', contractaddresses: tok.address });
        if (j.status === '1' && Array.isArray(j.result) && j.result[0]) block = Number(j.result[0].blockNumber);
        else throw esFail(j);
      } catch (e) {
        if (!(e instanceof NetError) || e.kind === 'fatal') throw e;
        await sleep(1500);
      }
    }
  }
  if (block === null) {
    // No explorer: binary search the first block that has code (needs a node that keeps historical state); else scan from genesis.
    try {
      let lo = 0; let hi = pin.number;
      while (lo < hi) {
        const mid = Math.floor((lo + hi) / 2);
        const code = await rpc('eth_getCode', [tok.address, toHex(mid)], { block: mid });
        if (code && code !== '0x') hi = mid; else lo = mid + 1;
      }
      block = lo;
    } catch { block = 0; }
  }
  cache[tok.address] = block;
  writeJsonAtomic(file, cache);
  return block;
}

// ─────────────────────────── log scan ───────────────────────────

function loadChunkIndex(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).map((f) => f.match(/^c-(\d+)-(\d+)\.json$/)).filter(Boolean).map((m) => ({ from: Number(m[1]), to: Number(m[2]), file: m[0] }));
}

function saveChunk(dir, from, to, logs, src, topic0) {
  const rows = logs.map((l) => [l.b, l.i, l.t.slice(1), l.d]);
  writeJsonAtomic(join(dir, `c-${from}-${to}.json`), { from, to, src, topic0, logs: rows });
}

function loadChunk(dir, c) {
  const j = JSON.parse(readFileSync(join(dir, c.file), 'utf8'));
  return { from: j.from, to: j.to, logs: j.logs.map(([b, i, t, d]) => ({ b, i, t: [j.topic0 ?? TRANSFER_TOPIC, ...t], d })) };
}

// Which logs to ask for: the token's own Transfer, or for a singleton-backed token the singleton's Transfer filtered to its id.
export function logFilter(tok) {
  if (tok.singleton) return { address: tok.singleton, topic0: TRANSFER_6909_TOPIC, topic3: idTopic(tok.address), key: `${tok.n}-${tok.address}-singleton` };
  return { address: tok.address, topic0: TRANSFER_TOPIC, topic3: null, key: `${tok.n}-${tok.address}` };
}

const sameAddress = (raw, filter) => String(raw.address).toLowerCase() === filter.address;

async function esGetLogs(filter, from, to) {
  const all = [];
  for (let page = 1; page <= ES_MAX_PAGES; page++) {
    const q = { module: 'logs', action: 'getLogs', address: filter.address, topic0: filter.topic0, fromBlock: String(from), toBlock: String(to), page: String(page), offset: String(ES_PAGE) };
    if (filter.topic3) Object.assign(q, { topic0_3_opr: 'and', topic3: filter.topic3 });
    const j = await esFetch(q);
    let rows;
    if (j.status === '1' && Array.isArray(j.result)) rows = j.result;
    else if (/no records found/i.test(`${j.message} ${j.result}`)) rows = [];
    else throw esFail(j);
    if (!rows.every((r) => sameAddress(r, filter))) throw new NetError('other', 'etherscan: a log from another contract came back');
    all.push(...rows);
    if (rows.length < ES_PAGE) return all.map(normalizeLog);
    if (page === 1 && to > from) {
      // Full first page: rows come in block order, so its last block gives the density. A window that would clearly overflow the
      // page cap is refused now, with a size that should fit, instead of after ten pages.
      const last = Math.max(...rows.map((r) => hexToInt(r.blockNumber)));
      const fit = Math.floor(((last - from + 1) * 7000) / ES_PAGE);
      if (fit < to - from + 1) throw new NetError('big', 'etherscan: window too dense', undefined, Math.max(1, fit));
    }
  }
  throw new NetError('big', 'etherscan: result window is too large');
}

async function rpcGetLogs(p, filter, from, to) {
  const topics = filter.topic3 ? [filter.topic0, null, null, filter.topic3] : [filter.topic0];
  const r = await rpcSend(p, 'eth_getLogs', [{ address: filter.address, fromBlock: toHex(from), toBlock: toHex(to), topics }]);
  const rows = r.filter((x) => !x.removed);
  if (!rows.every((x) => sameAddress(x, filter))) throw new NetError('other', `${p.name}: a log from another contract came back`);
  return rows.map(normalizeLog);
}

async function scanLogs(tok, filter, from, to, dir) {
  mkdirSync(dir, { recursive: true });
  const queue = computeGaps(loadChunkIndex(dir), from, to);
  const total = to - from + 1;
  const ctx = { queue, inflight: 0, fatal: null, done: total - queue.reduce((s, g) => s + g.to - g.from + 1, 0), rows: 0, lastReport: 0, started: Date.now() };
  if (!queue.length) return;
  progress(`token ${tok.n}: scanning ${from}..${to} (${queue.length} gap(s), ${((total - ctx.done) / 1e6).toFixed(2)}M blocks to fetch)`);
  const lane = async (p) => {
    let failsInRow = 0;
    while (!ctx.fatal) {
      if (p.retired || p.unsupported.has('eth_getLogs')) return;
      const wait = p.cooldownUntil - Date.now();
      if (wait > 0) { await sleep(Math.min(wait, 1000)); continue; }
      const qi = ctx.queue.findIndex((iv) => iv.from >= (p.minBlock.eth_getLogs ?? 0));
      if (qi < 0) {
        if (ctx.queue.length === 0 && ctx.inflight > 0) { await sleep(250); continue; }
        return;
      }
      const iv = ctx.queue[qi];
      const end = Math.min(iv.to, Number.isFinite(p.span) ? iv.from + Math.max(1, Math.floor(p.span)) - 1 : iv.to);
      ctx.queue.splice(qi, 1, ...(end < iv.to ? [{ from: iv.from, to: end }, { from: end + 1, to: iv.to }] : [{ from: iv.from, to: end }]));
      const [win] = ctx.queue.splice(qi, 1);
      ctx.inflight++;
      try {
        const logs = p.kind === 'es' ? await esGetLogs(filter, win.from, win.to) : await rpcGetLogs(p, filter, win.from, win.to);
        for (const l of logs) if (l.b < win.from || l.b > win.to) throw new NetError('other', `${p.name}: log at block ${l.b} outside ${win.from}-${win.to}`);
        logs.sort((a, b) => a.b - b.b || a.i - b.i);
        saveChunk(dir, win.from, win.to, logs, p.name, filter.topic0);
        p.stats.ok++; p.stats.logWindows++; p.stats.logRows += logs.length; p.fails = 0; failsInRow = 0; p.rateHits = Math.max(0, p.rateHits - 1);
        ctx.done += win.to - win.from + 1; ctx.rows += logs.length;
        const len = win.to - win.from + 1;
        const target = p.kind === 'es' ? 8000 : 3000;
        if (logs.length * 2 < target) p.span = Math.min(p.spanCap, Math.max(len, Math.floor(len * Math.min(8, logs.length ? target / logs.length : 8))));
        else if (logs.length > target) p.span = Math.max(1, Math.floor((len * target) / logs.length));
        if (Date.now() - ctx.lastReport > 20000) {
          ctx.lastReport = Date.now();
          progress(`token ${tok.n}: ${(100 * ctx.done / total).toFixed(1)}% of blocks, ${ctx.rows} logs this run, ${Math.round((Date.now() - ctx.started) / 1000)}s`);
        }
      } catch (e) {
        ctx.queue.splice(qi, 0, win);
        if (!(e instanceof NetError)) throw e;
        if (e.kind === 'fatal') { ctx.fatal = new Error(e.message); }
        else if (e.kind === 'big') {
          p.stats.big++;
          const len = win.to - win.from + 1;
          if (e.suggest) p.span = Math.max(1, Math.min(len - 1, e.suggest));
          else if (e.hint && e.hint < len) { p.spanCap = Math.min(p.spanCap, e.hint); p.span = p.spanCap; }
          else p.span = Math.max(1, Math.floor(len / 2));
          if (len === 1 && !e.suggest) { p.retired = true; progress(`${p.name}: retired from log scanning, one block exceeds its limits`); }
        } else {
          if (e.kind === 'noarchive') { p.minBlock.eth_getLogs = Math.max(p.minBlock.eth_getLogs ?? 0, win.to + 1); p.stats.noarchive++; }
          else { noteError(p, e, win.to, 'eth_getLogs'); if (e.kind !== 'rate') failsInRow++; }
          if (failsInRow >= 10) { p.retired = true; progress(`${p.name}: retired from log scanning after repeated failures (${redact(e.message)})`); }
        }
      } finally { ctx.inflight--; }
    }
  };
  await Promise.all(NET.pool.filter((p) => p.logs && !p.retired).map(lane));
  if (ctx.fatal) throw ctx.fatal;
  const left = computeGaps(loadChunkIndex(dir), from, to);
  if (left.length) throw new Error(`log scan incomplete after all sources gave up: ${left.slice(0, 3).map((g) => `${g.from}-${g.to}`).join(', ')}`);
  progress(`token ${tok.n}: scan complete, ${ctx.rows} logs fetched this run`);
}

function readLogs(dir, from, to) {
  const chunks = loadChunkIndex(dir).filter((c) => c.to >= from && c.from <= to).map((c) => loadChunk(dir, c));
  return assembleLogs(chunks, from, to);
}

// ─────────────────────────── state queries at N ───────────────────────────

async function multicall(calls, pin, { size = 250, concurrency = 4 } = {}) {
  const batches = [];
  for (let k = 0; k < calls.length; k += size) batches.push(calls.slice(k, k + size));
  const blockHex = toHex(pin.number);
  const res = await pMap(batches, async (batch) => {
    const ret = await rpc('eth_call', [{ to: MULTICALL3, data: encodeAggregate3(batch) }, blockHex], { block: pin.number });
    const dec = decodeAggregate3(ret);
    if (dec.length !== batch.length) throw new Error(`multicall returned ${dec.length} results for ${batch.length} calls`);
    return dec;
  }, concurrency);
  return res.flat();
}

const balanceOfCall = (token, a) => ({ target: token, data: callData('70a08231', addrWord(a)) });
const ownerOfCall = (token, id) => ({ target: token, data: callData('6352211e', uintWord(BigInt(id))) });

async function codeInfoFor(addresses, pin, cacheFile) {
  const info = new Map();
  if (existsSync(cacheFile)) {
    const c = JSON.parse(readFileSync(cacheFile, 'utf8'));
    if (c.block === pin.number && c.hash === pin.hash) for (const [a, s] of Object.entries(c.sizes)) info.set(a, s);
  }
  const todo = addresses.filter((a) => !info.has(a));
  if (todo.length) {
    const blockHex = toHex(pin.number);
    const batches = [];
    for (let k = 0; k < todo.length; k += 400) batches.push(todo.slice(k, k + 400));
    let probeOk = true;
    await pMap(batches, async (batch) => {
      let sizes = null;
      if (probeOk) {
        try {
          const ret = strip0x(await rpc('eth_call', [{ to: PROBE_ADDR, data: '0x' + batch.map(addrWord).join('') }, blockHex, { [PROBE_ADDR]: { code: CODESIZE_PROBE } }], { block: pin.number, noEs: true }));
          if (ret.length === batch.length * 64) sizes = batch.map((_, k) => Number(BigInt('0x' + ret.slice(k * 64, k * 64 + 64))));
        } catch { probeOk = false; }
      }
      if (!sizes) {
        sizes = await pMap(batch, async (a) => { const c = strip0x(await rpc('eth_getCode', [a, blockHex], { block: pin.number })); return c.length / 2; }, 6);
      }
      batch.forEach((a, k) => info.set(a, sizes[k]));
    }, 3);
    writeJsonAtomic(cacheFile, { block: pin.number, hash: pin.hash, sizes: Object.fromEntries(info) });
  }
  const out = new Map();
  const stubs = [];
  for (const [a, size] of info) {
    if (size === 0) out.set(a, { contract: false, delegated: false });
    else if (size === 23) stubs.push(a);
    else out.set(a, { contract: true, delegated: false });
  }
  // 23 bytes may be a 7702 delegation stub (0xef0100 ++ address): read the first code bytes before calling it an account.
  if (stubs.length) {
    const blockHex = toHex(pin.number);
    const batches = [];
    for (let k = 0; k < stubs.length; k += 400) batches.push(stubs.slice(k, k + 400));
    await pMap(batches, async (batch) => {
      let heads = null;
      try {
        const ret = strip0x(await rpc('eth_call', [{ to: PROBE_ADDR, data: '0x' + batch.map(addrWord).join('') }, blockHex, { [PROBE_ADDR]: { code: CODEHEAD_PROBE } }], { block: pin.number, noEs: true }));
        if (ret.length === batch.length * 64) heads = batch.map((_, k) => ret.slice(k * 64, k * 64 + 6).toLowerCase());
      } catch { /* fall back to eth_getCode */ }
      if (!heads) heads = await pMap(batch, async (a) => strip0x(await rpc('eth_getCode', [a, blockHex], { block: pin.number })).slice(0, 6).toLowerCase(), 6);
      batch.forEach((a, k) => { const delegated = heads[k] === 'ef0100'; out.set(a, { contract: !delegated, delegated }); });
    }, 3);
  }
  return out;
}

// ─────────────────────────── per-token pipeline ───────────────────────────

const byBalanceDesc = (a, b) => (a[1] === b[1] ? (a[0] < b[0] ? -1 : 1) : a[1] > b[1] ? -1 : 1);

// Candidates whose balance at N differs from what the replay says (want(addr) -> bigint, 0n for an address the replay never saw).
export function diffBalances(onChain, want) {
  const out = [];
  for (const [a, got] of onChain) {
    const w = want(a);
    if (got !== w) out.push({ holder: a, expected: w.toString(), got: got.toString() });
  }
  return out;
}

// Every address that ever appeared in a Transfer, zero address excluded.
export function candidateAddresses(logs) {
  const cand = new Set();
  for (const l of logs) { cand.add(topicAddr(l.t[1])); cand.add(topicAddr(l.t[2])); }
  cand.delete(ZERO);
  return [...cand].sort();
}

// balanceOf(candidate) at N for every candidate (an ERC721 balanceOf is the owned count). Zero balances are kept in the map.
async function readBalances(tok, list, pin) {
  const out = new Map();
  const SLICE = 6000;
  for (let k = 0; k < list.length; k += SLICE) {
    const part = list.slice(k, k + SLICE);
    const res = await multicall(part.map((a) => balanceOfCall(tok.address, a)), pin, { size: 300, concurrency: 4 });
    part.forEach((a, j) => {
      const b = res[j].success ? decodeUint(res[j].data) : null;
      if (b === null) throw new VerificationError(`balanceOf(${a}) is not readable at the snapshot block`);
      out.set(a, b);
    });
    if (list.length > SLICE) progress(`token ${tok.n}: balanceOf ${Math.min(k + SLICE, list.length)}/${list.length}`);
  }
  return out;
}

// balanceOf(0x0) at N as the token itself reports it, or null when the token will not answer for the zero address.
async function readZeroBalance(tok, pin) {
  const [r] = await multicall([balanceOfCall(tok.address, ZERO)], pin);
  return r.success ? decodeUint(r.data) : null;
}

// Checks that do not lean on the replay's own bookkeeping: the supply identity, then balanceOf at N of EVERY candidate (a dropped
// transfer between two holders keeps the supply sum intact but cannot survive this), then ownerOf on real tokens for ERC721.
async function verifyReplay(tok, pin, replay, meta, holdersSorted, onChain, rng, zeroChain) {
  const v = { transfers: replay.transfers, shapeAnomalies: replay.anomalies };
  if (tok.type === 'erc20') {
    const s = verifyErc20Supply(replay, meta.totalSupply, zeroChain);
    v.supply = s;
    if (!s.ok) throw new VerificationError(s.reason, v);
  } else {
    const s = verifyErc721Supply(replay, meta.totalSupply);
    v.supply = s;
    if (s.ok === false) throw new VerificationError(s.reason, v);
  }
  const mism = diffBalances(onChain, (a) => (tok.type === 'erc20' ? replay.balances.get(a) ?? 0n : BigInt(replay.counts.get(a) ?? 0)));
  v.balanceOfAll = { candidates: onChain.size, mismatches: mism.length };
  if (mism.length) throw new VerificationError(`${mism.length} balanceOf mismatch(es) at the snapshot block, first: ${JSON.stringify(mism[0])}`, { ...v, mismatches: mism.slice(0, 10) });
  const addrs = holdersSorted.map((h) => h[0]);
  const top = addrs.slice(0, 50);
  const rand = sampleN(addrs.slice(50), 100, rng);
  v.spot = { topChecked: top.length, randomChecked: rand.length, mismatches: 0 };
  if (tok.type === 'erc721') {
    const first = new Map();
    for (const a of [...top, ...rand]) first.set(a, null);
    for (const [id, o] of replay.owners) if (first.get(o) === null) first.set(o, id);
    const own = [...first].filter(([, id]) => id !== null).map(([a, id]) => ({ a, id }));
    const sampleIds = sampleN([...replay.owners.keys()], 200, rng).map((id) => ({ a: replay.owners.get(id), id }));
    const checks = [...own, ...sampleIds];
    const res = await multicall(checks.map((c) => ownerOfCall(tok.address, c.id)), pin);
    let bad = 0; let firstBad = null;
    checks.forEach((c, k) => {
      const got = res[k].success ? decodeAddress(res[k].data) : null;
      if (got !== c.a) { bad++; firstBad ??= { tokenId: c.id, expected: c.a, got }; }
    });
    v.ownerOf = { holderTokensChecked: own.length, randomTokensChecked: sampleIds.length, mismatches: bad };
    if (bad) throw new VerificationError(`${bad} ownerOf mismatch(es) at the snapshot block, first: ${JSON.stringify(firstBad)}`, v);
  }
  return v;
}

async function processToken(tok, ctx) {
  const { pin, dirs, blacklist } = ctx;
  progress(`token ${tok.n} (${tok.type}) ${tok.address}: start`);
  const meta = await readTokenMeta(tok, pin);
  progress(`token ${tok.n}: ${meta.symbol ?? '?'} "${meta.name ?? ''}" decimals ${meta.decimals} totalSupply ${meta.totalSupply === null ? 'n/a' : meta.totalSupply}`);
  const start = await creationBlock(tok, pin, dirs.cache);
  const filter = logFilter(tok);
  const logDir = join(dirs.cache, 'logs', filter.key);
  await scanLogs(tok, filter, start, pin.number, logDir);
  const logs = readLogs(logDir, start, pin.number);
  const cand = candidateAddresses(logs);
  progress(`token ${tok.n}: ${logs.length} ${tok.singleton ? 'singleton ' : ''}Transfer logs assembled, ${cand.length} candidate addresses`);
  const rng = makeRng(pin.hash);
  const logSource = tok.singleton ? `singleton ${tok.singleton}, id ${idTopic(tok.address)}` : 'token';
  const verification = { snapshotBlock: pin.number, logSource, logsReplayed: logs.length, candidateAddresses: cand.length, creationBlock: start };
  if (tok.singleton) {
    // The singleton's own supply for this id must equal what the token reports: ties the token to the stream that is replayed.
    const [r] = await multicall([{ target: tok.singleton, data: callData(sig('totalSupply(uint256)').slice(0, 8), idTopic(tok.address).slice(2)) }], pin);
    const sup = r.success ? decodeUint(r.data) : null;
    verification.singletonTotalSupply = sup === null ? null : sup.toString();
    if (sup === null || sup !== meta.totalSupply) throw new VerificationError(`singleton totalSupply(id) ${sup} != token totalSupply() ${meta.totalSupply}`, verification);
  }
  let onChain = null;
  const chainBalances = async () => (onChain ??= await readBalances(tok, cand, pin));
  const zeroChain = tok.type === 'erc20' ? await readZeroBalance(tok, pin) : null;
  let balances; let method = 'replay';
  try {
    const parse = tok.singleton ? (l) => parseTransfer6909(l, idTopic(tok.address)) : undefined;
    const replay = tok.type === 'erc20' ? replayErc20(logs, parse) : replayErc721(logs);
    balances = tok.type === 'erc20' ? replay.balances : new Map([...replay.counts].map(([a, c]) => [a, BigInt(c)]));
    Object.assign(verification, await verifyReplay(tok, pin, replay, meta, [...balances].sort(byBalanceDesc), await chainBalances(), rng, zeroChain));
  } catch (e) {
    if (!(e instanceof ReplayError) && !(e instanceof VerificationError)) throw e;
    // The replay cannot be trusted for this token (non-standard mint/burn/fee semantics or a bad source): take balanceOf at N
    // for every candidate instead, and require its sum to equal totalSupply. Transport failures propagate instead.
    progress(`token ${tok.n}: replay check failed (${redact(e.message)}); using balanceOf at the snapshot block for every candidate`);
    verification.replayFailure = e.message;
    if (e.detail) verification.replayFailureDetail = e.detail;
    try {
      if (meta.totalSupply === null) throw new VerificationError('the token has no totalSupply() to verify a balanceOf fallback against');
      const oc = await chainBalances();
      balances = new Map([...oc].filter(([, b]) => b > 0n));
      const sum = sumOf(balances);
      if (sum + (zeroChain ?? 0n) !== meta.totalSupply) throw new VerificationError(`sum of balanceOf over ${oc.size} candidates ${sum} + zero address ${zeroChain ?? 0n} != totalSupply ${meta.totalSupply}`);
      verification.fallback = { candidates: oc.size, sum: sum.toString(), zeroAddressChainBalance: zeroChain === null ? null : zeroChain.toString(), totalSupply: meta.totalSupply.toString() };
    } catch (fe) {
      if (fe instanceof VerificationError) {
        fe.message = `replay failed (${e.message}); balanceOf fallback failed (${fe.message})`;
        fe.detail = { ...verification, ...fe.detail };
      }
      throw fe;
    }
    method = 'balanceOf-fallback';
  }
  verification.method = method;
  progress(`token ${tok.n}: verified via ${method}, ${balances.size} holders`);
  const addrs = [...balances].sort(byBalanceDesc).map((h) => h[0]);
  const codeInfo = await codeInfoFor(addrs, pin, join(dirs.cache, `code-${pin.number}-${tok.n}.json`));
  const rows = buildHolderRows(balances, { blacklist, codeInfo });
  const supplyFromToken = meta.totalSupply !== null;
  const file = {
    n: tok.n, address: tok.address, type: tok.type, name: meta.name, symbol: meta.symbol, decimals: meta.decimals,
    snapshotBlock: pin.number, snapshotBlockHash: pin.hash, totalSupply: supplyFromToken ? meta.totalSupply.toString() : sumOf(balances).toString(),
    totalSupplySource: supplyFromToken ? 'totalSupply()' : 'owned token count (the token has no totalSupply())',
    verified: true, method, logSource, holderCount: rows.length, holders: rows,
  };
  writeFileSync(join(dirs.out, `${tok.n}-${tok.address}.json`), JSON.stringify(file, null, 1) + '\n');
  return { meta: { address: tok.address, type: tok.type, name: meta.name, symbol: meta.symbol, decimals: meta.decimals, totalSupply: file.totalSupply, holderCount: rows.length, contractHolders: rows.filter((r) => r.isContract).length, blacklistedHolders: rows.filter((r) => r.blacklisted).length, erc721Interface: meta.erc721Interface }, verification };
}

function sumOf(m) { let s = 0n; for (const v of m.values()) s += v; return s; }

// ─────────────────────────── main ───────────────────────────

function parseArgs(argv) {
  const o = { block: undefined, only: null, repin: false, etherscan: true, rpc: null, outDir: join(ROOT, 'scratchpad', 'airdrop-snapshot'), cacheDir: null };
  for (let k = 0; k < argv.length; k++) {
    const a = argv[k];
    const val = () => { if (k + 1 >= argv.length) throw new Error(`${a} needs a value`); return argv[++k]; };
    if (a === '--block') { o.block = Number(val()); if (!Number.isInteger(o.block) || o.block <= 0) throw new Error('--block needs a positive integer'); }
    else if (a === '--only') o.only = val().split(',').map((x) => Number(x.trim()));
    else if (a === '--repin') o.repin = true;
    else if (a === '--no-etherscan') o.etherscan = false;
    else if (a === '--rpc') o.rpc = val().split(',').map((x) => x.trim()).filter(Boolean);
    else if (a === '--out-dir') o.outDir = val();
    else if (a === '--cache-dir') o.cacheDir = val();
    else throw new Error(`unknown argument ${a}`);
  }
  if (o.only && o.only.some((n) => !TOKENS.some((t) => t.n === n))) throw new Error(`--only takes token numbers 1-${TOKENS.length}`);
  o.cacheDir ??= join(o.outDir, 'cache');
  return o;
}

export function loadBlacklist(file) {
  const arr = JSON.parse(readFileSync(file, 'utf8'));
  if (!Array.isArray(arr)) throw new Error('blacklist must be a JSON array of addresses');
  const set = new Set();
  for (const a of arr) {
    if (!/^0x[0-9a-f]{40}$/.test(a)) throw new Error(`blacklist entry is not a lowercase address: ${a}`);
    set.add(a);
  }
  return set;
}

async function main() {
  const t0 = Date.now();
  const opts = parseArgs(process.argv.slice(2));
  PROGRESS_FILE = join(ROOT, 'scratchpad', 'airdrop-snapshot-progress.txt');
  mkdirSync(opts.outDir, { recursive: true });
  mkdirSync(opts.cacheDir, { recursive: true });
  const blacklist = loadBlacklist(join(ROOT, 'tools', 'airdrop-blacklist.json'));
  initNet({ rpcUrls: opts.rpc ?? RPC_URLS, useEtherscan: opts.etherscan, custom: !!opts.rpc });
  progress(`airdrop-snapshot ${TOOL_VERSION}: nodes ${NET.providers.map((p) => p.name).join(', ')}; etherscan ${NET.es ? 'enabled' : 'off'}; blacklist ${blacklist.size}`);
  const pin = await pinBlock(opts.cacheDir, opts.block, opts.repin);
  progress(`pinned block ${pin.number} ${pin.hash} timestamp ${pin.timestamp} (confirmed by ${pin.confirmedBy.join(', ')})`);
  const ctx = { pin, dirs: { out: opts.outDir, cache: opts.cacheDir }, blacklist };
  const selected = TOKENS.filter((t) => !opts.only || opts.only.includes(t.n));
  const metaFile = join(opts.outDir, 'meta.json');
  const prev = existsSync(metaFile) ? JSON.parse(readFileSync(metaFile, 'utf8')) : null;
  const tokensMeta = prev && prev.snapshotBlock === pin.number && prev.snapshotBlockHash === pin.hash ? prev.tokens : {};
  let failed = 0;
  for (const tok of selected) {
    const stale = join(opts.outDir, `${tok.n}-${tok.address}.json`);
    try {
      const r = await processToken(tok, ctx);
      tokensMeta[tok.n] = { ...r.meta, status: 'verified', verification: r.verification };
    } catch (e) {
      failed++;
      if (existsSync(stale)) rmSync(stale);
      progress(`token ${tok.n}: STOPPED, ${redact(e.message)}`);
      const check = e instanceof VerificationError || e instanceof ReplayError;
      tokensMeta[tok.n] = { address: tok.address, type: tok.type, status: 'failed', failureKind: check ? 'verification' : 'transport (rerun resumes from the cache)', failure: redact(e.message), verification: e.detail ?? null };
    }
  }
  const files = [];
  for (const tok of TOKENS) {
    const f = join(opts.outDir, `${tok.n}-${tok.address}.json`);
    if (existsSync(f)) {
      const j = JSON.parse(readFileSync(f, 'utf8'));
      if (j.snapshotBlock === pin.number && j.snapshotBlockHash === pin.hash) files.push(j);
    }
  }
  const meta = {
    tool: 'airdrop-snapshot', version: TOOL_VERSION, snapshotBlock: pin.number, snapshotBlockHash: pin.hash, snapshotTimestamp: pin.timestamp,
    snapshotTimeIso: new Date(pin.timestamp * 1000).toISOString(), confirmedBy: pin.confirmedBy, generatedAt: new Date().toISOString(),
    blacklistCount: blacklist.size, tokens: tokensMeta,
    sources: Object.fromEntries(NET.pool.map((p) => [p.name, { ...p.stats, spanLearned: Number.isFinite(p.spanCap) ? p.spanCap : null, unsupported: [...p.unsupported], retired: p.retired, usedForLogs: p.logs, lastError: p.lastError ?? null }])),
    runtimeSeconds: Math.round((Date.now() - t0) / 1000),
  };
  writeFileSync(metaFile, JSON.stringify(meta, null, 2) + '\n');
  writeFileSync(join(opts.outDir, 'summary.md'), renderSummary(files, meta));
  progress(`done in ${meta.runtimeSeconds}s: ${selected.length - failed} verified, ${failed} stopped`);
  process.exit(failed ? 1 : 0);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((e) => { console.error(redact(e.stack || e.message)); process.exit(2); });
}
