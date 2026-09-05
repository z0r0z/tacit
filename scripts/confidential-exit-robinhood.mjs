// Privacy-preserving ETH -> Robinhood Chain exit, ops tooling. See ops/DESIGN-confidential-robinhood-exit.md.
//
// Same flow as scripts/confidential-exit-base.mjs (wrap into the shielded pool -> dwell -> unwrap to a
// recipe-bound escrow -> the escrow atomically bridges out), but Robinhood Chain is an Arbitrum Orbit
// chain, not an OP-Stack one, and its deposit mechanism is a different, more dangerous shape:
//
// Inbox.depositEth() from a CONTRACT caller (our escrow) SUCCEEDS and silently credits the contract's L2
// ALIAS (L1_addr + 0x1111000000000000000000000000000000001111) — an address nobody holds a key for.
// There is no revert to catch this, unlike OP-Stack's onlyEOA. The only safe path is
// Inbox.createRetryableTicket, which lets the escrow name the real L2 recipient explicitly, and both
// refund addresses must ALSO be l2Recipient (never the escrow) for the same reason. See
// dapp/confidential-router.js's buildArbitrumBridgeExit for the full explanation.
//
// This script deliberately duplicates confidential-exit-base.mjs's shared plumbing (state model, note
// discovery, pin-verification framework, sendTx) rather than refactoring it into a shared lib — safer to
// keep two proven, independent scripts than to risk already-working fund-handling code while adding new,
// less-tested territory (live gas estimation, Arbitrum's retryable-ticket fee model).
//
// PRIVACY BOUNDARY: identical to the Base script's — the exit amount, l2Recipient, and timing are all
// public on L1 once activateExit lands. Shielded accumulation, then exit anywhere — not a private
// cross-chain transfer.
//
// Subcommands:
//   plan                 print resolved config, derived addresses, live pin checks — no side effects
//   wrap   --amount <eth> [--index N]         deposit into the pool, wait for the note to settle
//   status [--exit-id ID]                     dwell/readiness, anonymity-set proxy, escrow state
//   exit   --exit-id ID --l2-recipient 0x.. [--self-submit] [--i-understand-low-anonymity]
//   activate --exit-id ID                     permissionless: fire the pinned recipe's retryable ticket
//   reclaim  --exit-id ID                     post-deadline rescue (funds -> L1 finalRecipient)
//
// Env: NETWORK (default mainnet), WALLET_PRIV, ACTIVATOR_PRIV, STATE_DIR — same meanings as the Base
// script. State files hold no secret material, same as the Base script.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import { hmac } from '../node_modules/@noble/hashes/hmac.js';
import { sha256 as nobleSha256 } from '../node_modules/@noble/hashes/sha2.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { makeConfidentialPoolUx } from '../dapp/confidential-pool-ux.js';
import { makeEvmAccount } from '../dapp/evm-account.js';
import { parseEnvFile } from './env.mjs';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const _cat = (a) => { let n = 0; for (const x of a) n += x.length; const o = new Uint8Array(n); let i = 0; for (const x of a) { o.set(x, i); i += x.length; } return o; };
secp.etc.hmacSha256Sync = (k, ...m) => hmac(nobleSha256, k, _cat(m));

Object.assign(process.env, parseEnvFile(path.join(process.cwd(), '.env')) || {});

const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const utf8 = (s) => new TextEncoder().encode(s);
const selector = (sig) => '0x' + hex(keccak_256(utf8(sig)).subarray(0, 4));
const word = (v) => BigInt(v).toString(16).padStart(64, '0');
const addrWord = (a) => String(a).replace(/^0x/, '').toLowerCase().padStart(64, '0');
const ZERO_ADDR = '0x0000000000000000000000000000000000000000';
const ROBINHOOD_CHAIN_ID = 4663;
const ROBINHOOD_L2_RPC = 'https://rpc.mainnet.chain.robinhood.com';
// Standard Arbitrum precompile — a virtual contract intercepted by the node, not real deployed bytecode;
// only reachable via eth_call/eth_estimateGas, same on every Arbitrum/Orbit chain.
const NODE_INTERFACE = '0x' + 'C8'.padStart(40, '0');

const evm = makeEvmAccount({ secp, keccak256: keccak_256, sha256 });
const network = process.env.NETWORK || 'mainnet';
const ux = makeConfidentialPoolUx({ secp, keccak256: keccak_256, sha256, fetchImpl: fetch, network });

// ── CLI plumbing (identical to confidential-exit-base.mjs) ──
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next != null && !next.startsWith('--')) { out[key] = next; i++; } else { out[key] = true; }
    } else out._.push(a);
  }
  return out;
}
const args = parseArgs(process.argv.slice(2));
const cmd = args._[0];

function die(msg) { console.error('error: ' + msg); process.exit(1); }

function requireEnvKey(name) {
  const v = (process.env[name] || '').replace(/\s+/g, '');
  if (!/^0x?[0-9a-fA-F]{64}$/.test(v)) die(`set ${name} to a 32-byte hex key`);
  return v.startsWith('0x') ? v : '0x' + v;
}

function parseEth(s) {
  const m = String(s).trim().match(/^(\d+)(?:\.(\d+))?$/);
  if (!m) die(`bad amount "${s}" — expected a decimal ETH value like 0.01`);
  const whole = m[1], frac = (m[2] || '').padEnd(18, '0').slice(0, 18);
  return BigInt(whole) * 10n ** 18n + BigInt(frac || '0');
}

function fmtEth(wei) {
  const s = wei.toString().padStart(19, '0');
  const whole = s.slice(0, -18), frac = s.slice(-18).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
}

// ── state (same shape/dir as the Base script, but its own exitId namespace via a distinct fp tag below) ──
const STATE_DIR = process.env.STATE_DIR || path.join(os.homedir(), '.local', 'state', 'tacit', 'exits-robinhood');
function walletFingerprint(walletPriv) { return hex(sha256(utf8('tacit-exit-fp-v1:' + walletPriv))).slice(0, 16); }
function exitIdFor(fp, index) { return hex(sha256(utf8('tacit-exit-id-robinhood-v1:' + fp + ':' + index))).slice(0, 16); }
function statePath(exitId) { return path.join(STATE_DIR, `${exitId}.json`); }

function loadState(exitId) {
  const p = statePath(exitId);
  if (!fs.existsSync(p)) die(`no state for exit ${exitId} (run \`wrap\` first) — ${p}`);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}
function saveState(exitId, state) {
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  const p = statePath(exitId);
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, p);
}
function findLatestExitId(fp) {
  if (!fs.existsSync(STATE_DIR)) return null;
  const rows = fs.readdirSync(STATE_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => { try { return JSON.parse(fs.readFileSync(path.join(STATE_DIR, f), 'utf8')); } catch { return null; } })
    .filter((s) => s && s.walletFingerprint === fp)
    .sort((a, b) => (b.wrap?.wrappedAt || 0) - (a.wrap?.wrappedAt || 0));
  return rows[0]?.exitId || null;
}
function nextIndex(fp) {
  if (!fs.existsSync(STATE_DIR)) return 0;
  const used = fs.readdirSync(STATE_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => { try { return JSON.parse(fs.readFileSync(path.join(STATE_DIR, f), 'utf8')); } catch { return null; } })
    .filter((s) => s && s.walletFingerprint === fp)
    .map((s) => s.index);
  return used.length ? Math.max(...used) + 1 : 0;
}

function deriveExitNonce(fp, index) {
  return BigInt('0x' + hex(sha256(utf8(`tacit-exit-nonce-robinhood-v1:${fp}:${index}`))));
}
function bucketedDeadline(hoursOut = 48) {
  const day = 86400;
  return BigInt((Math.floor(Date.now() / 1000 / day) + Math.ceil(hoursOut / 24) + 1) * day);
}
// A fresh, seed-recoverable L1 dust-catcher — only matters for the pool-exit's OWN residue sweep
// insurance here (not for anything Arbitrum-specific: there is no L1-side leftover on the bridge-call
// side the way Base could strand dust, since the retryable's own leftovers refund on L2 to l2Recipient).
function deriveDustAccount(walletPriv, index) {
  return evm.deriveEvmAccount(walletPriv, `tacit-exit-dust-robinhood-v1:${network}:${index}`);
}

const TRANCHES_WEI = [0.01, 0.1, 1, 10].map((e) => BigInt(Math.round(e * 1e18)));
function trancheAdvisory(wei) {
  let nearest = TRANCHES_WEI[0], best = wei > nearest ? wei - nearest : nearest - wei;
  for (const t of TRANCHES_WEI) { const d = wei > t ? wei - t : t - wei; if (d < best) { best = d; nearest = t; } }
  return { nearest, exact: wei === nearest };
}

// ── L1 chain reads ──
async function ethCallDecoded(to, data, overrides) {
  const params = overrides ? [{ to, data }, 'latest', overrides] : [{ to, data }, 'latest'];
  return ux.rpc('eth_call', params);
}
function lastAddress(hexWord) { return '0x' + String(hexWord).replace(/^0x/, '').slice(-40); }
async function waitReceipt(txHash, { intervalMs = 4000, timeoutMs = 6 * 60 * 1000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = await ux.rpc('eth_getTransactionReceipt', [txHash]);
    if (r) {
      if (r.status !== '0x1') die(`tx ${txHash} REVERTED (status ${r.status}) — nothing after this should be trusted as having happened`);
      return r;
    }
    if (Date.now() > deadline) die(`timed out waiting for ${txHash} to mine`);
    await new Promise((res) => setTimeout(res, intervalMs));
  }
}

// ── L2 (Robinhood Chain) reads, for retryable-ticket gas quoting ──
async function l2Rpc(method, params) {
  const res = await fetch(ROBINHOOD_L2_RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j = await res.json();
  if (j.error) throw new Error(`robinhood rpc ${method}: ${j.error.message}`);
  return j.result;
}

async function findFreeIndex(walletPriv, amountWei, startIndex) {
  for (let index = startIndex; index < startIndex + 1000; index++) {
    const built = ux.buildWrap({ walletPriv, amountWei, ticker: 'cETH', index });
    const status = await ethCallDecoded(ux.cfg.pool, selector('depositStatus(bytes32)') + built.depositId.replace(/^0x/, ''));
    if (BigInt(status) === 0n) return index;
  }
  throw new Error('could not find a free note index in 1000 tries');
}

// Live-pin checks for BOTH chains: the L1 Inbox (never trust a hardcoded address) and the L2 chain id
// (protects against ever pointing this script at the wrong network by an env/config slip).
async function verifyLivePins() {
  const router = ux.cfg.router, pool = ux.cfg.pool;
  const executorImpl = lastAddress(await ethCallDecoded(router, selector('executorImpl()')));
  const inbox = ux.router.ARBITRUM_ORBIT_INBOX[ROBINHOOD_CHAIN_ID];
  const bridgeFromInbox = lastAddress(await ethCallDecoded(inbox, selector('bridge()')));
  const expectedBridge = '0xdf8755334ce7a73ccf6b581c02ea649ae3e864b3';
  if (bridgeFromInbox.toLowerCase() !== expectedBridge) {
    die(`Robinhood Chain Inbox.bridge() mismatch (got ${bridgeFromInbox}, expected ${expectedBridge}) — refusing to proceed`);
  }
  const l2ChainId = parseInt(await l2Rpc('eth_chainId', []), 16);
  if (l2ChainId !== ROBINHOOD_CHAIN_ID) die(`Robinhood Chain RPC reports chainId ${l2ChainId}, expected ${ROBINHOOD_CHAIN_ID}`);
  const assetId = ux.assetByTicker.cETH?.assetId;
  if (!assetId) die('cETH assetId not resolved from confidential-deployments — check network config');
  const assetsRaw = await ethCallDecoded(pool, selector('assets(bytes32)') + assetId.replace(/^0x/, ''));
  const words = assetsRaw.replace(/^0x/, '').match(/.{1,64}/g) || [];
  const registered = BigInt('0x' + (words[0] || '0')) === 1n;
  const underlying = lastAddress('0x' + (words[1] || '0'));
  if (!registered || underlying !== ZERO_ADDR) {
    die(`cETH asset ${assetId} not registered as native ETH on the live pool (registered=${registered}, underlying=${underlying})`);
  }
  return { executorImpl, assetId, router, pool, inbox };
}

async function anonSetProxy() {
  const pool = ux.cfg.pool;
  const nextLeaf = BigInt(await ethCallDecoded(pool, selector('nextLeafIndex()')));
  const poolEthWei = BigInt(await ux.rpc('eth_getBalance', [pool, 'latest']));
  return { nextLeaf, poolEthWei };
}

// Live-quote the three retryable-ticket gas parameters. No guessing: gasLimit comes from Robinhood
// Chain's own NodeInterface precompile (the standard Arbitrum way to size a retryable's L2 execution),
// maxSubmissionCost from the Inbox's own pricing function using the current L1 base fee, maxFeePerGas
// from the L2's own gas price. A safety margin is applied to each independently.
async function quoteRetryableGas({ pins, sender, l2Recipient, l2CallValue }) {
  const SIG = 'estimateRetryableTicket(address,uint256,address,uint256,address,address,bytes)';
  const head = addrWord(sender) + word(l2CallValue) + addrWord(l2Recipient) + word(l2CallValue)
    + addrWord(l2Recipient) + addrWord(l2Recipient) + word(7n * 32n);
  const calldata = selector(SIG) + head + word(0n); // empty `data` tail
  const gasEstimate = BigInt(await l2Rpc('eth_estimateGas', [{ to: NODE_INTERFACE, data: calldata }]));
  const gasLimit = (gasEstimate * 3n) / 2n; // 1.5x margin, matching this codebase's gasAwareMinFee convention

  const l1Base = BigInt(await ux.rpc('eth_gasPrice', []));
  const submissionCalldata = selector('calculateRetryableSubmissionFee(uint256,uint256)') + word(0n) + word(l1Base * 2n);
  const maxSubmissionCost = BigInt(await ethCallDecoded(pins.inbox, submissionCalldata));

  const l2GasPrice = BigInt(await l2Rpc('eth_gasPrice', []));
  const maxFeePerGas = l2GasPrice * 2n;

  return { gasLimit, maxSubmissionCost, maxFeePerGas };
}

function buildRecipe({ pins, fp, index, walletPriv, l2CallValue, gas, l2Recipient, deadline }) {
  const nonce = deriveExitNonce(fp, index);
  const dust = deriveDustAccount(walletPriv, index).address;
  const recipe = ux.router.buildArbitrumBridgeExit({
    exitedAsset: pins.assetId,
    l2Recipient,
    chainId: ROBINHOOD_CHAIN_ID,
    inbox: pins.inbox,
    l2CallValue,
    maxSubmissionCost: gas.maxSubmissionCost,
    gasLimit: gas.gasLimit,
    maxFeePerGas: gas.maxFeePerGas,
    finalRecipient: dust,
    deadline,
    nonce,
    feeAsset: ZERO_ADDR,
  });
  return { recipe, dust };
}

async function escrowFor(pins, recipe) {
  const local = ux.router.exitRecipeEscrow(pins.executorImpl, recipe, pins.router);
  const onchain = lastAddress(await ethCallDecoded(pins.router, ux.router.escrowAddressForCalldata(recipe)));
  if (local.toLowerCase() !== onchain.toLowerCase()) {
    die(`escrow address mismatch: local=${local} on-chain=${onchain} — ABORTING, do not build a proof against this recipe`);
  }
  return local;
}

async function simulateActivate(pins, recipe, escrow, escrowWei) {
  const data = ux.router.activateExitCalldata(recipe);
  const res = await ux.rpc('eth_call', [
    { to: pins.router, data },
    'latest',
    { [escrow]: { balance: '0x' + escrowWei.toString(16) } },
  ]).catch((e) => { throw new Error(`simulate: activateExit reverted under the funded override — ${e.message}`); });
  if (res !== '0x') throw new Error(`simulate: unexpected activateExit return data ${res}`);
}

async function sendTx({ priv, to, value = 0n, data = '0x', gasLimit }) {
  const from = evm.addressFromPriv(priv);
  const nonce = BigInt(await ux.rpc('eth_getTransactionCount', [from, 'pending']));
  const tip = 1500000000n;
  const base = BigInt((await ux.rpc('eth_gasPrice', [])) || '0x3b9aca00');
  const tx = { chainId: BigInt(ux.cfg.chainId), nonce, maxPriorityFeePerGas: tip, maxFeePerGas: base * 2n + tip, gasLimit, to, value, data };
  const signed = ux.evmTx.signEip1559(tx, priv);
  const txHash = await ux.rpc('eth_sendRawTransaction', [signed.raw]);
  return { txHash, from, nonce };
}

// ── subcommands ──
async function cmdPlan() {
  const pins = await verifyLivePins();
  const anon = await anonSetProxy();
  console.log(`network:        ${network}`);
  console.log(`pool:           ${pins.pool}`);
  console.log(`router:         ${pins.router}`);
  console.log(`executorImpl:   ${pins.executorImpl}  (live-read, not hardcoded)`);
  console.log(`cETH assetId:   ${pins.assetId}`);
  console.log(`Robinhood Chain Inbox: ${pins.inbox}  (chain id ${ROBINHOOD_CHAIN_ID}, cross-checked live)`);
  console.log('');
  console.log(`anonymity-set proxy: nextLeafIndex=${anon.nextLeaf}  poolEthBalance=${fmtEth(anon.poolEthWei)} ETH`);
  if (anon.nextLeaf < 20n) {
    console.log('*** WARNING: the pool has almost no activity. An exit today buys ~zero privacy — it is');
    console.log('*** trivially linkable by elimination. Treat any run right now as a FUNCTIONAL smoke test,');
    console.log('*** not a privacy demonstration. See ops/DESIGN-confidential-robinhood-exit.md.');
  }
  console.log('');
  console.log('tranches (advisory only, not enforced): ' + TRANCHES_WEI.map(fmtEth).join(' / ') + ' ETH');
  console.log('note: Arbitrum retryable tickets prepay L2 execution gas out of the escrow — the amount');
  console.log('      actually credited on Robinhood Chain is smaller than the wrapped amount by that');
  console.log('      prepaid budget (submission fee + gas*maxFeePerGas), unlike the Base exit.');
  if (process.env.WALLET_PRIV) {
    const wp = requireEnvKey('WALLET_PRIV');
    const acct = ux.account(wp);
    console.log('');
    console.log(`Tacit wallet EVM signing address (fund THIS for the wrap deposit): ${acct.address}`);
  }
  if (process.env.ACTIVATOR_PRIV) {
    const ap = requireEnvKey('ACTIVATOR_PRIV');
    console.log(`Activator EOA address (fund THIS for gas — activate/reclaim/self-submit): ${evm.addressFromPriv(ap)}`);
  }
}

async function cmdWrap() {
  const walletPriv = requireEnvKey('WALLET_PRIV');
  const amountWei = parseEth(args.amount || die('pass --amount <eth>'));
  const fp = walletFingerprint(walletPriv);
  const startIndex = args.index != null ? Number(args.index) : nextIndex(fp);
  console.log(`checking on-chain for a free note index from ${startIndex}...`);
  const index = await findFreeIndex(walletPriv, amountWei.toString(), startIndex);
  if (index !== startIndex) console.log(`index ${startIndex} was already used by this key on-chain — using ${index} instead`);
  const exitId = exitIdFor(fp, index);
  if (fs.existsSync(statePath(exitId))) die(`exit ${exitId} (index ${index}) already exists — pass --index to pick a fresh one`);

  const { exact } = trancheAdvisory(amountWei);
  console.log(`wrapping ${fmtEth(amountWei)} ETH at index ${index}` + (exact ? '' : ' (not a round tranche — advisory only, proceeding)'));

  const acct = ux.account(walletPriv);
  console.log(`funding address: ${acct.address}`);
  const bal = BigInt(await ux.rpc('eth_getBalance', [acct.address, 'latest']));
  if (bal < amountWei) die(`funding address ${acct.address} holds ${fmtEth(bal)} ETH, need >= ${fmtEth(amountWei)} ETH (+ gas)`);

  const sent = await ux.routerWrap({ walletPriv, amountWei: amountWei.toString(), ticker: 'cETH', index });
  console.log(`deposit tx: ${sent.txHash} — waiting for it to mine...`);
  await waitReceipt(sent.txHash);

  console.log('deposit mined — submitting the OP_WRAP settle to the relay...');
  const settled = await ux.submitWrapSettle({ built: sent, waitOpts: { timeoutMs: 20 * 60 * 1000, onUpdate: (s) => console.log(`  relay: ${s.status}`) } });
  const settleTxHash = settled.txHash || (await ux.relay.status(settled.jobId)).txHash || null;

  saveState(exitId, {
    v: 1, exitId, network, walletFingerprint: fp, index, ticker: 'cETH',
    amountWei: amountWei.toString(),
    wrap: { txHash: sent.txHash, jobId: settled.jobId, settleTxHash, wrappedAt: Math.floor(Date.now() / 1000) },
  });
  console.log(`state saved: ${statePath(exitId)}`);
  console.log(`exit id: ${exitId}  (pass --exit-id ${exitId} to status/exit/activate/reclaim)`);
}

async function locateNote(walletPriv, state) {
  const built = ux.buildWrap({ walletPriv, amountWei: state.amountWei, ticker: state.ticker, index: state.index });
  const { notes } = await ux.balance(walletPriv);
  const mine = notes.find((n) => n.cx === built.note.cx && n.cy === built.note.cy);
  return { built, note: mine };
}

async function cmdStatus() {
  const walletPriv = requireEnvKey('WALLET_PRIV');
  const fp = walletFingerprint(walletPriv);
  const exitId = args['exit-id'] || findLatestExitId(fp) || die('no exits found for this wallet — run `wrap` first');
  const state = loadState(exitId);

  const anon = await anonSetProxy();
  console.log(`exit id:       ${exitId}  (index ${state.index}, ${fmtEth(BigInt(state.amountWei))} ETH)`);
  console.log(`wrapped at:    ${new Date(state.wrap.wrappedAt * 1000).toISOString()}`);
  console.log(`anon-set proxy: nextLeafIndex=${anon.nextLeaf}  poolEthBalance=${fmtEth(anon.poolEthWei)} ETH`);

  const { note } = await locateNote(walletPriv, state);
  if (!note) { console.log('note not yet visible on-chain (settle still pending / indexing lag)'); return; }
  console.log(`note visible:  leafIndex=${note.leafIndex}  value=${note.value} units`);

  if (state.exit?.recipe) {
    const pins = await verifyLivePins();
    const escrow = state.exit.escrow;
    const escrowWei = BigInt(await ux.rpc('eth_getBalance', [escrow, 'latest']));
    console.log(`recipe pinned: escrow=${escrow}  balance=${fmtEth(escrowWei)} ETH`);
    console.log(`l2Recipient:   ${state.exit.l2Recipient}`);
    console.log(`l2CallValue (what actually lands on Robinhood Chain): ${fmtEth(BigInt(state.exit.l2CallValue))} ETH`);
    console.log(`deadline:      ${new Date(Number(state.exit.deadline) * 1000).toISOString()}`);
    const needed = BigInt(state.exit.recipe.calls[0].value);
    if (escrowWei >= needed) console.log('READY: escrow funded — run `activate`');
    else console.log(`waiting on settle: escrow needs >= ${fmtEth(needed)} ETH`);
  } else {
    console.log('no exit recipe pinned yet — run `exit --l2-recipient <addr>`');
  }
}

async function cmdExit() {
  const walletPriv = requireEnvKey('WALLET_PRIV');
  const fp = walletFingerprint(walletPriv);
  const exitId = args['exit-id'] || die('pass --exit-id <id> (see `status` or the `wrap` output)');
  const state = loadState(exitId);
  const l2Recipient = args['l2-recipient'] || die('pass --l2-recipient 0x...');
  if (!/^0x[0-9a-fA-F]{40}$/.test(l2Recipient)) die('--l2-recipient must be a 20-byte 0x address');

  const anon = await anonSetProxy();
  if (anon.nextLeaf < 20n && !args['i-understand-low-anonymity']) {
    die('anonymity set is effectively empty (nextLeafIndex=' + anon.nextLeaf + ') — this exit buys ~zero ' +
      'privacy today. Re-run with --i-understand-low-anonymity to proceed as a functional smoke test only.');
  }

  const { note } = await locateNote(walletPriv, state);
  if (!note) die('note not visible on-chain yet — wait for the wrap settle, then retry');

  const pins = await verifyLivePins();

  if (state.exit?.recipe) {
    console.log('reusing the already-pinned recipe (recipes are immutable once built)');
  } else {
    const selfSubmit = !!args['self-submit'];
    let noteNetWei;
    if (selfSubmit) {
      noteNetWei = BigInt(note.value) * BigInt(ux.assetByTicker.cETH.unitScale);
    } else {
      const minFee = await ux.quoteOpFee('cETH', 'unwrap');
      const { fee, net } = ux.quoteUnwrapFee(note.value, 'cETH', { feeBps: 0n, minFee });
      noteNetWei = net * BigInt(ux.assetByTicker.cETH.unitScale);
      const feeBps = (fee * 10000n) / BigInt(note.value || 1n);
      console.log(`quoted relay fee: ${fee} units (~${(Number(feeBps) / 100).toFixed(2)}% of note value)`);
      if (feeBps > 300n) die(`fee is ${(Number(feeBps) / 100).toFixed(2)}% of the note — an outlier fee is itself ` +
        'a fingerprint. Wait for lower gas and retry.');
    }

    // Quote retryable gas against a plausible escrow-shaped sender (the estimate doesn't depend on the
    // exact sender address for a plain ETH-credit ticket with no L2 contract call).
    const gas = await quoteRetryableGas({ pins, sender: pins.router, l2Recipient, l2CallValue: noteNetWei / 2n || 1n });
    const overhead = gas.maxSubmissionCost + gas.gasLimit * gas.maxFeePerGas;
    if (overhead >= noteNetWei) die(`retryable-ticket overhead (${fmtEth(overhead)} ETH) exceeds the note's net value ` +
      `(${fmtEth(noteNetWei)} ETH) — wrap a larger amount or wait for cheaper L1/L2 gas`);
    const l2CallValue = noteNetWei - overhead;

    console.log(`retryable overhead: submission=${fmtEth(gas.maxSubmissionCost)} ETH  ` +
      `gas=${gas.gasLimit}@${gas.maxFeePerGas}wei (${fmtEth(gas.gasLimit * gas.maxFeePerGas)} ETH)`);
    console.log(`l2CallValue (what lands on Robinhood Chain): ${fmtEth(l2CallValue)} ETH of ${fmtEth(noteNetWei)} ETH unwrapped`);

    const deadline = bucketedDeadline(48);
    const { recipe, dust } = buildRecipe({ pins, fp, index: state.index, walletPriv, l2CallValue, gas, l2Recipient, deadline });
    const escrow = await escrowFor(pins, recipe);

    // If l2Recipient has L1 contract code (a Safe/4337 wallet, an EIP-7702 delegation, etc.), the Inbox
    // aliases both retryable refund addresses — confirmed live: a real run left a small unused-gas
    // refund stranded at the ALIASED address, not at l2Recipient itself. Not a fund-loss bug (the main
    // l2CallValue is never aliased), but worth surfacing before proving rather than discovering after.
    const l1Code = await ux.rpc('eth_getCode', [l2Recipient, 'latest']);
    if (l1Code && l1Code !== '0x') {
      console.log(`*** NOTE: ${l2Recipient} has L1 contract code (${(l1Code.length - 2) / 2} bytes) — Arbitrum`);
      console.log('*** will alias both retryable refund addresses. Any unused prepaid gas budget will land');
      console.log('*** at the ALIASED address on Robinhood Chain, not at l2Recipient directly. The main');
      console.log('*** deposit (l2CallValue below) is unaffected.');
    }

    console.log('');
    console.log('=== REVIEW BEFORE PROVING (unrecoverable if wrong) ===');
    console.log(`  l2Recipient (Robinhood Chain, ALSO both retryable refund addrs): ${l2Recipient}`);
    console.log(`  finalRecipient (L1 dust, derived, NOT l2Recipient): ${dust}`);
    console.log(`  escrow:                  ${escrow}`);
    console.log(`  l2CallValue:             ${fmtEth(l2CallValue)} ETH`);
    console.log(`  total escrow spend:      ${fmtEth(BigInt(recipe.calls[0].value))} ETH`);
    console.log(`  deadline:                ${new Date(Number(deadline) * 1000).toISOString()}`);
    console.log('=======================================================');
    console.log('');

    const totalCallValue = BigInt(recipe.calls[0].value);
    if (totalCallValue !== l2CallValue + gas.maxSubmissionCost + gas.gasLimit * gas.maxFeePerGas) {
      die('internal error: recipe call value does not match l2CallValue + maxSubmissionCost + gasLimit*maxFeePerGas — aborting before a proof is built');
    }

    await simulateActivate(pins, recipe, escrow, totalCallValue).then(
      () => console.log('dry-run OK: the funded batch (clone deploy + retryable-ticket creation + residue sweep) succeeds against live state'),
    );

    state.exit = {
      l2Recipient, l2CallValue: l2CallValue.toString(), deadline: deadline.toString(), dust, escrow,
      recipe: { ...recipe, deadline: recipe.deadline.toString(), nonce: recipe.nonce.toString(),
        calls: recipe.calls.map((c) => ({ ...c, value: c.value.toString(), amount: c.amount.toString() })),
        minOuts: recipe.minOuts.map(String) },
      selfSubmit, noteNetWei: noteNetWei.toString(),
    };
    saveState(exitId, state);
  }

  const recipe = reviveRecipe(state.exit.recipe);

  if (state.exit.selfSubmit) {
    console.log('proving (mode: prove) for a self-submitted exitAndExecute...');
    const built2 = ux.buildUnwrap({ note, walletPriv, recipient: state.exit.escrow, selfSettle: true });
    const proven = await ux.relay.prove({ type: 'unwrap', op: built2.op, memos: [] },
      { onJob: (id) => console.log(`  proof job: ${id}`), onUpdate: (s) => console.log(`  relay: ${s.status}`) });
    if (!proven.publicValues || !proven.proof) die('relay did not return a proof (unexpected status ' + proven.status + ')');
    const calldata = ux.router.exitAndExecuteCalldata({ publicValues: proven.publicValues, proof: proven.proof, memos: [], recipe });
    const activatorPriv = requireEnvKey('ACTIVATOR_PRIV');
    // Same headroom lesson learned on the Base script: proof verification + clone deploy + the bridge
    // call + sweep in one atomic tx needs well past a naive gas estimate.
    const sent = await sendTx({ priv: activatorPriv, to: pins.router, data: calldata, gasLimit: 2000000n });
    console.log(`exitAndExecute sent: ${sent.txHash} — waiting for it to mine...`);
    await waitReceipt(sent.txHash);
    console.log('confirmed on-chain');
    state.exit.selfSubmitTxHash = sent.txHash;
  } else {
    console.log('submitting the relayed unwrap (settle mode — the relay pays gas, your wallet never signs the exit)...');
    const result = await ux.unwrap({
      note, walletPriv, recipient: state.exit.escrow,
      feeOpts: { feeBps: 0n, minFee: await ux.quoteOpFee('cETH', 'unwrap') },
      waitOpts: { timeoutMs: 20 * 60 * 1000, onUpdate: (s) => console.log(`  relay: ${s.status}`) },
    });
    console.log(`settled: ${result.status}${result.txHash ? ' (' + result.txHash + ')' : ''}`);
    console.log('next: run `activate --exit-id ' + exitId + '` (permissionless — any funded EOA can send it)');
  }
  saveState(exitId, state);
}

function reviveRecipe(r) {
  return {
    ...r,
    deadline: BigInt(r.deadline),
    nonce: BigInt(r.nonce),
    calls: r.calls.map((c) => ({ ...c, value: BigInt(c.value), amount: BigInt(c.amount) })),
    minOuts: r.minOuts.map(BigInt),
  };
}

async function cmdActivate() {
  const exitId = args['exit-id'] || die('pass --exit-id <id>');
  const state = loadState(exitId);
  if (!state.exit?.recipe) die('no recipe pinned for this exit yet — run `exit` first');
  const recipe = reviveRecipe(state.exit.recipe);
  const pins = await verifyLivePins();

  const escrowWei = BigInt(await ux.rpc('eth_getBalance', [state.exit.escrow, 'latest']));
  const needed = recipe.calls[0].value;
  if (escrowWei < needed) die(`escrow ${state.exit.escrow} holds ${fmtEth(escrowWei)} ETH, needs >= ${fmtEth(needed)} ETH — settle first`);

  // Cap the dry-run at the same limit the real tx uses — an uncapped eth_call succeeds regardless and
  // would miss an out-of-gas revert (confirmed live on the Base script's equivalent path: 400k reverted
  // at 92% usage against real state, 800k cleared it).
  const ACTIVATE_GAS_LIMIT = 1000000n;
  const data = ux.router.activateExitCalldata(recipe);
  const dryRun = await ux.rpc('eth_call', [{ to: pins.router, data, gas: '0x' + ACTIVATE_GAS_LIMIT.toString(16) }, 'latest']).catch((e) => { throw e; });
  if (dryRun !== '0x') die(`activateExit dry-run returned unexpected data ${dryRun}`);

  const activatorPriv = requireEnvKey('ACTIVATOR_PRIV');
  const sent = await sendTx({ priv: activatorPriv, to: pins.router, data, gasLimit: ACTIVATE_GAS_LIMIT });
  console.log(`activateExit sent: ${sent.txHash} — waiting for it to mine...`);
  await waitReceipt(sent.txHash);
  console.log('confirmed on-chain — the retryable ticket has been created (~10 min to land on Robinhood Chain)');
  state.exit.activateTxHash = sent.txHash;
  saveState(exitId, state);
}

async function cmdReclaim() {
  const exitId = args['exit-id'] || die('pass --exit-id <id>');
  const state = loadState(exitId);
  if (!state.exit?.recipe) die('no recipe pinned for this exit');
  const recipe = reviveRecipe(state.exit.recipe);
  const pins = await verifyLivePins();

  const now = BigInt(Math.floor(Date.now() / 1000));
  if (now <= recipe.deadline) die(`deadline hasn't passed yet (${new Date(Number(recipe.deadline) * 1000).toISOString()})`);

  const data = ux.router.reclaimExitCalldata(recipe, []);
  const activatorPriv = requireEnvKey('ACTIVATOR_PRIV');
  const sent = await sendTx({ priv: activatorPriv, to: pins.router, data, gasLimit: 400000n });
  console.log(`reclaimExit sent: ${sent.txHash} — waiting for it to mine...`);
  await waitReceipt(sent.txHash);
  console.log(`confirmed on-chain — funds returned to L1 finalRecipient ${state.exit.dust}`);
  state.exit.reclaimTxHash = sent.txHash;
  saveState(exitId, state);
}

const HANDLERS = { plan: cmdPlan, wrap: cmdWrap, status: cmdStatus, exit: cmdExit, activate: cmdActivate, reclaim: cmdReclaim };
if (!HANDLERS[cmd]) {
  console.error('usage: node scripts/confidential-exit-robinhood.mjs <plan|wrap|status|exit|activate|reclaim> [flags]');
  process.exit(1);
}
HANDLERS[cmd]().catch((e) => { console.error(e.stack || e.message || e); process.exit(1); });
