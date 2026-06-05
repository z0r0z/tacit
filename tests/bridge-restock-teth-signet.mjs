// Restock signet tETH for the TETH/TAC pilot pool (fast-settlement Phase 0).
//
// The 2026-05-31 round-trip burned its own mint, leaving signet tETH
// circulation at ~0. This harness re-mints headlessly:
//
//   Phase A: batch-deposit 2 × 0.001 ETH into the signet-bridge Sepolia
//            mixer (deployer key from .env via `cast send`)
//   Phase B: mint each deposit on signet (T_BRIDGE_DEPOSIT — mixer-ceremony
//            Groth16 proof, ~1-3 min each)
//   Phase C: poll founder holdings until the tETH credits land
//
// The deposit secrets derive from the FOUNDER signet wallet's privkey, so
// the founder mints (and later pools) the tETH directly — no transfer leg.
// Resumable via .local/bridge-restock-teth-state.json.
//
// Run:  node tests/bridge-restock-teth-signet.mjs

import { JSDOM } from 'jsdom';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
globalThis.location = dom.window.location;
globalThis.navigator = dom.window.navigator;
if (!globalThis.crypto) { try { globalThis.crypto = dom.window.crypto; } catch {} }
globalThis.prompt = () => null;
globalThis.alert = () => {};
globalThis.confirm = () => false;
globalThis.__TACIT_NO_INIT__ = true;
globalThis.localStorage.setItem('tacit-network-v1', 'signet');

import * as secp from '@noble/secp256k1';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const STATE_DIR = path.join(ROOT, '.local');
const STATE_FILE = path.join(STATE_DIR, 'bridge-restock-teth-state.json');
const WALLETS_FILE = path.join(STATE_DIR, 'amm-e2e-signet-wallets.json');

// ── env: Sepolia deployer key (never printed) ──
const envText = readFileSync(path.join(ROOT, '.env'), 'utf8');
const envVal = (k) => (envText.match(new RegExp(`^${k}=(.*)$`, 'm')) || [])[1]?.trim();
const ETH_KEY = envVal('DEPLOYER_PRIVATE_KEY');
const ETH_ADDR = envVal('SEPOLIA_DEPLOYER_ADDR');
if (!ETH_KEY || !ETH_ADDR) { console.error('✗ .env missing DEPLOYER_PRIVATE_KEY / SEPOLIA_DEPLOYER_ADDR'); process.exit(1); }
const CAST = existsSync(`${process.env.HOME}/.foundry/bin/cast`) ? `${process.env.HOME}/.foundry/bin/cast` : 'cast';
const SEPOLIA_RPCS = [
  'https://ethereum-sepolia-rpc.publicnode.com',
  'https://1rpc.io/sepolia',
  'https://sepolia.drpc.org',
];

async function ethRpc(method, params) {
  let lastErr;
  for (const url of SEPOLIA_RPCS) {
    try {
      const r = await fetch(url, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
      const j = await r.json();
      if (j.error) throw new Error(j.error.message || 'rpc error');
      return j.result;
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('all sepolia rpcs failed');
}

// ── provider shim: reads forward to public RPC, sends go through cast ──
const provider = {
  async request({ method, params }) {
    if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [ETH_ADDR];
    if (method === 'eth_chainId') return '0xaa36a7';
    if (method === 'eth_sendTransaction') {
      const tx = params[0];
      const valueDec = BigInt(tx.value || '0x0').toString();
      const out = execFileSync(CAST, [
        'send', tx.to, tx.data || '0x',
        '--value', valueDec,
        '--private-key', ETH_KEY,
        '--rpc-url', SEPOLIA_RPCS[0],
        '--json',
      ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      const j = JSON.parse(out);
      const h = j.transactionHash || j.txHash;
      if (!h) throw new Error('cast send returned no transactionHash');
      return h;
    }
    return ethRpc(method, params || []);
  },
};
dom.window.ethereum = provider;
globalThis.ethereum = provider;

const dapp = await import('../dapp/tacit.js');

// Node fetch shim for the dapp's browser-relative prover artifacts.
{
  const _origFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const u = typeof input === 'string' ? input : input?.url;
    if (typeof u === 'string') {
      const m = u.match(/^\.\/vendor\/([a-z0-9_.-]+\.wasm)$/i) || u.match(/(?:^|\/)vendor\/([a-z0-9_.-]+\.wasm)$/i);
      if (m) {
        const p = path.join(ROOT, 'dapp', 'vendor', m[1]);
        if (existsSync(p)) return new Response(readFileSync(p));
      }
    }
    return _origFetch(input, init);
  };
}

if (!existsSync(WALLETS_FILE)) { console.error(`✗ ${WALLETS_FILE} missing`); process.exit(1); }
const WALLETS = JSON.parse(readFileSync(WALLETS_FILE, 'utf8'));
const FOUNDER = {
  priv: hexToBytes(WALLETS.founder.priv_hex),
  pub: secp.getPublicKey(hexToBytes(WALLETS.founder.priv_hex), true),
  addr: WALLETS.founder.address,
};
try { globalThis.localStorage.setItem('tacit-backup-ack-v1:' + bytesToHex(FOUNDER.pub), '1'); } catch {}
dapp.wallet.priv = FOUNDER.priv;
dapp.wallet.pub = FOUNDER.pub;

const TETH = 'd903de2d2a7c1958f8ab3c4b9a91175ef3885027a24af306dead9e8f671a450b';
const DEPOSIT_WEI = 2_000_000_000_000_000n; // 2 × 0.001 ETH chunks
// Configuring the bridge makes scanPools verify each bridge-deposit leaf
// STRICTLY against the Sepolia root (RPC fetch); on flaky signet a transient
// timeout truncates the local mixer tree before our leaves (the documented
// leaf-omission break). Phases A/B need the bridge; Phase C (mixer withdraw)
// does NOT — it only needs the pool tree, which the worker already backs. So
// configure the bridge lazily, only when a deposit/mint actually has to run,
// and leave scanPools on its lenient trust-the-worker path for Phase C.
function configureBridge() {
  // __TACIT_NO_INIT__ skips the dapp boot that wires the per-network bridge
  // deployment — configure the signet bridge explicitly (TETH_DEPLOYMENTS.signet).
  dapp.configureTethBridge({
    address: '0x5bAcd098E59e937A8FFaEA4D281B3097A01ad91C',
    chainId: 11155111,
    assetIdHex: TETH,
    deployBlock: '0xa7586c',
  });
}

function loadState() { try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { return {}; } }
function saveState(s) {
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}
function fail(m) { console.error(`\n✗ ${m}\n`); process.exit(1); }
function info(m) { console.log(`  ${m}`); }
function ok(m)   { console.log(`  ✓ ${m}`); }
function step(n, m) { console.log(`\n--- Phase ${n}: ${m} ---`); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const state = loadState();
console.log(`\n=== signet tETH restock ===\n`);
console.log(`  founder (mints): ${FOUNDER.addr}`);
console.log(`  sepolia payer:   ${ETH_ADDR}`);
console.log(`  deposit:         ${DEPOSIT_WEI} wei (2 × 0.001 ETH)\n`);

// ── Phase A: Sepolia batch deposit ──
step('A', 'Sepolia batch deposit');
if (state.deposit?.txHash) {
  ok(`reusing deposit ${state.deposit.txHash}`);
} else {
  configureBridge();
  const { txHash, records, dust } = await dapp.bridgeBatchDepositETH({
    provider, weiAmount: DEPOSIT_WEI,
    onProgress: (s) => info(`· ${s}`),
  });
  state.deposit = { txHash, records, dust: String(dust) };
  saveState(state);
  ok(`deposit tx ${txHash} (${records.length} chunks)`);
}
{
  info('waiting for Sepolia confirmations…');
  let confirmed = false;
  for (let i = 1; i <= 40 && !confirmed; i++) {
    const rcpt = await ethRpc('eth_getTransactionReceipt', [state.deposit.txHash]);
    if (rcpt && rcpt.status === '0x1') {
      const tip = BigInt(await ethRpc('eth_blockNumber', []));
      const conf = tip - BigInt(rcpt.blockNumber) + 1n;
      info(`receipt ok — ${conf} confirmation(s)`);
      if (conf >= 2n) { confirmed = true; break; }
    } else if (rcpt && rcpt.status === '0x0') {
      fail('Sepolia deposit tx REVERTED');
    }
    await sleep(8000);
  }
  if (!confirmed) fail('deposit not confirmed after ~5 min — re-run to resume');
  ok('Sepolia deposit confirmed');
}

// ── Phase B: mint each chunk on signet ──
step('B', 'mint deposits on signet (Groth16 per chunk)');
state.mints = state.mints || {};
for (let i = 0; i < state.deposit.records.length; i++) {
  const rec = state.deposit.records[i];
  const key = rec.ethCommitmentHex;
  if (state.mints[key]?.reveal_txid) {
    ok(`chunk ${i}: reusing mint ${String(state.mints[key].reveal_txid).slice(0, 16)}`);
    continue;
  }
  configureBridge();
  info(`chunk ${i}: building T_BRIDGE_DEPOSIT (proof takes ~1-3 min)…`);
  const r = await dapp.buildAndBroadcastBridgeDeposit({
    ethDepositRecord: rec,
    onProgress: (s) => info(`· ${s}`),
  });
  state.mints[key] = { reveal_txid: r?.revealTxid || r?.txid || true };
  saveState(state);
  ok(`chunk ${i} minted`);
  await sleep(20_000);
}

// ── Phase C: pool leaves → withdraw each note to a spendable tETH UTXO ──
//
// A bridge mint lands as a POOL NOTE (leaf in the tETH pool tree), not a
// spendable UTXO. Once the worker includes the leaf, a T_WITHDRAW converts
// it to a real tETH UTXO (mixer-ceremony Groth16 per note).
step('C', 'withdraw pool notes to spendable tETH UTXOs');
state.withdraws = state.withdraws || {};
// scanPools' per-leaf kernel re-verify breaks the local tree on any
// transient getTx timeout (the documented leaf-omission flakiness), so a
// single clean sync isn't reliable on signet. Instead retry the withdraw
// itself: buildAndBroadcastWithdraw rebuilds the merkle proof and throws
// safely (pre-broadcast, no fee) when the local tree is incomplete — so we
// loop scanPools + attempt until it lands.
for (let i = 0; i < state.deposit.records.length; i++) {
  const rec = state.deposit.records[i];
  if (state.withdraws[rec.poolLeafHex]?.done) {
    ok(`note ${i}: already withdrawn`);
    continue;
  }
  let done = false;
  for (let attempt = 1; attempt <= 30 && !done; attempt++) {
    await dapp.scanPools();
    let included = false;
    try { included = !!dapp.buildMixerMerkleProof(TETH, BigInt(rec.denomination), hexToBytes(rec.poolLeafHex)); } catch {}
    if (!included) {
      info(`note ${i}: attempt ${attempt}/30 — leaf not yet in a complete local tree`);
      await sleep(45_000);
      continue;
    }
    try {
      info(`note ${i}: withdrawing to a tETH UTXO (Groth16 ~1-3 min)…`);
      const w = await dapp.buildAndBroadcastWithdraw({
        depositRecord: {
          assetIdHex: TETH,
          denomination: rec.denomination,
          secretHex: rec.secretPoolHex,
          nullifierPreimageHex: rec.nullifierPreimagePoolHex,
          leafCommitmentHex: rec.poolLeafHex,
          nullifierHashHex: rec.nullifierHashHex,
        },
        onProgress: (s) => info(`· ${s}`),
      });
      state.withdraws[rec.poolLeafHex] = { done: true, txid: w?.revealTxid || w?.txid || true };
      saveState(state);
      ok(`note ${i} withdrawn`);
      done = true;
      await sleep(20_000);
    } catch (e) {
      const msg = String(e?.message || e);
      if (/already withdrawn|nullifier already/.test(msg)) {
        ok(`note ${i}: already spent on chain — treating as done`);
        state.withdraws[rec.poolLeafHex] = { done: true, txid: true };
        saveState(state);
        done = true;
      } else {
        info(`note ${i}: attempt ${attempt}/30 failed (${msg.slice(0, 80)}) — retrying`);
        await sleep(45_000);
      }
    }
  }
  if (!done) fail(`note ${i} could not be withdrawn after 30 attempts — re-run to resume`);
}

// ── Phase D: wait for the UTXOs to land in holdings ──
step('D', 'wait for founder tETH balance');
{
  let bal = 0n;
  for (let i = 1; i <= 40; i++) {
    dapp.invalidateHoldingsCache();
    const h = await dapp.scanHoldings();
    bal = h.get(TETH)?.balance ?? 0n;
    if (bal >= 100_000n) break;
    info(`poll ${i}/40: founder tETH = ${bal}`);
    await sleep(45_000);
  }
  if (bal < 100_000n) fail(`tETH balance ${bal} < 100000 after polling — re-run to resume`);
  ok(`founder holds ${bal} tETH base units`);
}

console.log(`\n=== restock complete — run tests/amm-teth-tac-pool-signet.mjs next ===\n`);
process.exit(0); // dapp/undici keep-alive handles otherwise hang the process
