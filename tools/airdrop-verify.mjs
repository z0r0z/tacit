#!/usr/bin/env node
// Read-only eligibility check against a deployed (or forked) TacAirdrop. Sends no transaction.
//
//   node tools/airdrop-verify.mjs --contract 0x.. --address 0x.. --proofs <file | dir | url> [--root 0x..] [--rpc <url>]
//
// --proofs is any of: a proofs file from airdrop-tree.mjs (`claims` map), a per-recipient file, a directory holding
// <address>.json files (the --out-dir layout) or <xx>.json shards by leading address byte (the --out-shards layout), or an http(s) URL of
// either a file or such a directory. The published shards are the directory dapp/airdrop/v1/proofs in this repo, served at
// https://tacit.finance/airdrop/v1/proofs.
// Checks, in order: the entry's proof recomputes to its root locally; that root equals --root (when given) and the contract's
// MERKLE_ROOT; the contract's own `verify` accepts the proof; the leaf is not claimed; claims are not paused and the window is open;
// whether the amount can be shielded. On chain 1 the guardian is also compared with the ops multisig in contracts/deployments/1.json.
// Exit code 0 only when every check passes and the leaf is claimable.

import { readFileSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { leafHash, verifyProof, normalizeAddress, formatTac } from './airdrop-tree.mjs';

const args = process.argv.slice(2);
const arg = (n) => { const i = args.indexOf(n); return i < 0 ? undefined : args[i + 1]; };
const die = (m) => { console.error('airdrop-verify: ' + m); process.exit(2); };

const contract = arg('--contract'), addrArg = arg('--address'), proofsArg = arg('--proofs'), wantRoot = arg('--root');
const RPC = arg('--rpc') || process.env.RPC || 'https://ethereum-rpc.publicnode.com';
if (!contract || !addrArg || !proofsArg) die('usage: --contract 0x.. --address 0x.. --proofs <file|dir|url> [--root 0x..] [--rpc url]\n  published shards: dapp/airdrop/v1/proofs or https://tacit.finance/airdrop/v1/proofs');
const to = normalizeAddress(contract);
const who = normalizeAddress(addrArg);

// ── ABI helpers ──
const sel = (sig) => Buffer.from(keccak_256(Buffer.from(sig))).toString('hex').slice(0, 8);
const w32 = (v) => BigInt(v).toString(16).padStart(64, '0');
async function rpc(method, params) {
  const r = await (await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json();
  if (r.error) throw new Error(`${method}: ${r.error.message}`);
  return r.result;
}
const call = (target, data) => rpc('eth_call', [{ to: target, data: '0x' + data }, 'latest']);
const word = (h, i = 0) => h.slice(2 + i * 64, 2 + (i + 1) * 64);
const asAddr = (h) => '0x' + word(h).slice(24);

// ── proof entry ──
async function loadEntry() {
  const pick = (j) => {
    if (j.claims) { const c = j.claims[who]; return c ? { root: j.root, address: who, ...c } : null; }
    return j.address && normalizeAddress(j.address) === who ? j : null;
  };
  if (/^https?:\/\//.test(proofsArg)) {
    const isFile = /\.json(\?|$)/.test(proofsArg);
    const base = proofsArg.replace(/\/$/, '');
    // a directory is either one file per recipient (<address>.json) or shards by leading address byte (<xx>.json)
    for (const url of isFile ? [proofsArg] : [`${base}/${who}.json`, `${base}/${who.slice(2, 4)}.json`]) {
      const res = await fetch(url);
      if (res.status === 404 && !isFile) continue;
      if (!res.ok) die(`fetch ${url}: ${res.status}`);
      const e = pick(await res.json());
      if (e) return e;
      if (isFile) return null;
    }
    return null;
  }
  if (!existsSync(proofsArg)) die(`no such path: ${proofsArg}`);
  if (statSync(proofsArg).isDirectory()) {
    const base = proofsArg.replace(/\/$/, '');
    for (const f of [`${base}/${who}.json`, `${base}/${who.slice(2, 4)}.json`]) {
      if (!existsSync(f)) continue;
      const e = pick(JSON.parse(readFileSync(f, 'utf8')));
      if (e) return e;
    }
    return null;
  }
  return pick(JSON.parse(readFileSync(proofsArg, 'utf8')));
}

let failed = false;
const ok = (m) => console.log('  ok    ' + m);
const bad = (m) => { failed = true; console.log('  FAIL  ' + m); };
const info = (m) => console.log('  info  ' + m);

const entry = await loadEntry();
if (!entry) { console.log(`${who} has no entry in ${proofsArg}: not in the recipient list.`); process.exit(1); }
const index = BigInt(entry.index), amount = BigInt(entry.amount), proof = entry.proof;
console.log(`recipient ${entry.address}  index ${index}  amount ${formatTac(amount)} TAC (${amount} wei)  proof words ${proof.length}`);

// local recomputation
if (verifyProof(proof, entry.root, leafHash(index, who, amount))) ok('proof recomputes to the file root');
else bad('proof does NOT recompute to the file root');
if (wantRoot) { if (wantRoot.toLowerCase() === entry.root.toLowerCase()) ok('file root equals --root'); else bad(`file root ${entry.root} differs from --root ${wantRoot}`); }

// chain
const chainId = parseInt(await rpc('eth_chainId', []), 16);
info(`chain ${chainId} via ${RPC}`);
if ((await rpc('eth_getCode', [to, 'latest'])) === '0x') die(`no contract code at ${to} on chain ${chainId}`);
const getAddr = async (name) => asAddr(await call(to, sel(`${name}()`)));
const onRoot = '0x' + word(await call(to, sel('MERKLE_ROOT()')));
if (onRoot.toLowerCase() === entry.root.toLowerCase()) ok('contract MERKLE_ROOT equals the file root'); else bad(`contract MERKLE_ROOT ${onRoot} differs from the file root ${entry.root}`);
if (wantRoot && onRoot.toLowerCase() !== wantRoot.toLowerCase()) bad(`contract MERKLE_ROOT ${onRoot} differs from --root ${wantRoot}`);

const token = await getAddr('TOKEN'), guardian = await getAddr('GUARDIAN'), pool = await getAddr('POOL');
const deadline = BigInt(await call(to, sel('CLAIM_DEADLINE()')));
const scale = BigInt(await call(to, sel('UNIT_SCALE()')));
const paused = BigInt(await call(to, sel('paused()'))) !== 0n;
info(`token ${token}  pool ${pool}  guardian ${guardian}`);
info(`claim deadline ${new Date(Number(deadline) * 1000).toISOString()}`);
if (chainId === 1 || chainId === 31337) {
  const dep = fileURLToPath(new URL('../contracts/deployments/1.json', import.meta.url));
  if (!existsSync(dep)) bad(`cannot read ${dep}: guardian, token and pool cannot be checked`);
  else {
    const d = JSON.parse(readFileSync(dep, 'utf8'));
    const secs = Number(deadline) - Math.floor(Date.now() / 1000);
    if (secs > 0 && secs <= 400 * 86400) ok(`claim deadline is ${(secs / 86400).toFixed(1)} days away`); else bad(`claim deadline is ${(secs / 86400).toFixed(1)} days away: expected a date in the next 400 days`);
    if (guardian.toLowerCase() === d.engineAdmin.toLowerCase()) ok('guardian is the ops multisig'); else bad(`guardian ${guardian} is not the ops multisig ${d.engineAdmin}`);
    if (token.toLowerCase() === d.tacToken.toLowerCase()) ok('token is the public TAC'); else bad(`token ${token} is not the public TAC ${d.tacToken}`);
    if (pool.toLowerCase() === d.pool.toLowerCase()) ok('pool is the live pool'); else bad(`pool ${pool} is not the live pool ${d.pool}`);
  }
}

const enc = `${sel('verify(uint256,address,uint256,bytes32[])')}${w32(index)}${w32(BigInt(who))}${w32(amount)}${w32(0x80)}${w32(proof.length)}${proof.map((p) => p.replace(/^0x/, '')).join('')}`;
if (BigInt(await call(to, enc)) === 1n) ok('contract verify() accepts the proof'); else bad('contract verify() REJECTS the proof');
const claimed = BigInt(await call(to, sel('isClaimed(uint256)') + w32(index))) !== 0n;
if (claimed) bad('already claimed'); else ok('not yet claimed');
if (paused) bad('claims are paused'); else ok('claims are not paused');
const block = await rpc('eth_getBlockByNumber', ['latest', false]);
const now = BigInt(block.timestamp);
if (now > deadline) bad('the claim window is closed'); else ok(`claim window open for another ${(deadline - now) / 3600n} hours`);
const bal = BigInt(await call(token, sel('balanceOf(address)') + w32(BigInt(to))));
if (bal >= amount) ok(`contract holds ${formatTac(bal)} TAC (enough for this claim)`); else bad(`contract holds only ${formatTac(bal)} TAC, less than this claim`);
if (amount % scale === 0n) info('amount is a multiple of the pool unit: claimAndShield is available'); else info('amount has sub-unit dust: claim / claimTo only (claimAndShield would revert)');

console.log(failed ? '\nNOT claimable / mismatch found' : '\nclaimable');
process.exit(failed ? 1 : 0);
