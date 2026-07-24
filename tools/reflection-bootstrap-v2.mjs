// Mainnet reflection bootstrap driver for the live ConfidentialPool.
//
// Advances the pool's reflected Bitcoin state forward from the deployed empty resume seed
// (REFLECTION_RESUME_DIGEST @ REFLECTION_GENESIS_HEIGHT) toward a matured tip, one batch at a time.
// Reuses the worker's buildScanReflectionAttester for all block parsing / esplora fetching / assembly
// (splitBlockTxs, classifyConfidentialTx, assembleReflectionScanInput) and drives it via the public
// assembleJob/ackJob, injecting:
//   prove  — scp the assembled input to the RunPod box, run the persisted network-prove `exec`, read back pv+proof
//   attest — buildAttestTx (deployer key) + eth_sendRawTransaction
//
// MODES:
//   --dry-run           assemble batch 1 only; assert prior digest == seed; print unsupportedEnvelopes; NO prove/attest
//   --batches=N         drive up to N batches (prove+attest each). Default 1.
//   --to=HEIGHT         stop once attested >= HEIGHT (else runs to matured tip)
//
// Safe increments: run --dry-run first (no funds), then --batches=1 to land one real attest, then loop.

import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import { sha256 as nobleSha256 } from '../node_modules/@noble/hashes/sha2.js';
import { hmac } from '../node_modules/@noble/hashes/hmac.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { buildScanReflectionAttester } from '../worker/src/reflection-attest.js';
import { makeScanReflectionIndexer } from '../dapp/confidential-reflection-scan-indexer.js';
import { SWAP_BATCH_VK } from '../dapp/confidential-swapbatch-vk.js';
import { classifyConfidentialTx } from '../dapp/burn-deposit-bitcoin.js';
import { makeBtcRelay } from '../dapp/confidential-btc-relay.js';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';

const sha256 = (b) => nobleSha256(b instanceof Uint8Array ? b : Uint8Array.from(b));
// noble-secp needs a sync HMAC for deterministic ECDSA signing (the attest tx signature).
if (secp.etc && !secp.etc.hmacSha256Sync) {
  secp.etc.hmacSha256Sync = (key, ...msgs) => hmac(nobleSha256, key, secp.etc.concatBytes(...msgs));
}
const deps = { secp, keccak256: keccak_256, sha256 };

// ── config ──
const POOL = '0x00000000000f5DE1295Ab2F0649fDE3855b66020';   // V2 pool (2026-07-24)
const GENESIS_HEIGHT = 958151;                 // resume anchor (TAC-seeded, NOT empty)
const RESUME_DIGEST = '0x64b3ae2abd94812c8a139f93d7da049cfee12354a9116a01444d5a7c05fb3825';
const GENESIS_ANCHOR = '0x4db866736b671463a25b32f1d8c8c534b7056159522201000000000000000000';
const CONFIRMATIONS = 6;
const CHAIN_ID = 1;
const MRPC = process.env.MRPC || 'https://ethereum-rpc.publicnode.com';
const ESPLORA = process.env.ESPLORA || 'https://mempool.space/api';
const BATCH_SIZE = parseInt(process.env.REFLECTION_BATCH_SIZE || '6', 10);
const BOX = { key: process.env.BOX_KEY || '/Users/z/.ssh/runpod_prover', port: process.env.BOX_PORT || '1948', host: process.env.BOX_HOST || 'root@193.183.22.54' };
const STATE_DIR = '/private/tmp/claude-501/-Users-z-tacit/218e951b-c019-470f-a2bb-2d938e3c5ef4/scratchpad/refl-v2';
const KV_FILE = `${STATE_DIR}/kv.json`;

const argv = process.argv.slice(2);
const DRY = argv.includes('--dry-run');
const MAX_BATCHES = parseInt((argv.find(a => a.startsWith('--batches=')) || '=1').split('=')[1], 10) || 1;
const STOP_AT = parseInt((argv.find(a => a.startsWith('--to=')) || '=0').split('=')[1], 10) || 0;

if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });

// ── esplora fetchers (api / apiRawBytes shapes the worker expects) ──
async function api(_env, path, _opts = {}, _network = 'mainnet') {
  const r = await fetch(ESPLORA + path);
  if (!r.ok) throw new Error(`esplora ${path} -> ${r.status}`);
  return (await r.text());
}
async function apiRawBytes(_env, path, _network = 'mainnet') {
  const r = await fetch(ESPLORA + path);
  if (!r.ok) throw new Error(`esplora raw ${path} -> ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}

// ── file-backed KV shim (worker storage: REGISTRY_KV.get/put) ──
const fileKV = {
  get: async (k) => { try { return (JSON.parse(readFileSync(KV_FILE, 'utf8')))[k] ?? null; } catch { return null; } },
  put: async (k, v) => { let o = {}; try { o = JSON.parse(readFileSync(KV_FILE, 'utf8')); } catch {} o[k] = v; writeFileSync(KV_FILE, JSON.stringify(o)); },
};

const env = {
  REFLECTION_ATTEST: '1',
  REFLECTION_GENESIS_HEIGHT: String(GENESIS_HEIGHT),
  REFLECTION_BATCH_SIZE: String(BATCH_SIZE),
  REGISTRY_KV: fileKV,
  REFLECTION_PROVE_URL: 'http://unused.local',   // never called (we use assembleJob path)
};

// ── correctness gate: empty state @ genesis must digest to the deployed resume seed ──
function assertSeedDigest() {
  const idx = makeScanReflectionIndexer({ ...deps, swapBatchVk: SWAP_BATCH_VK });
  // Non-empty TAC-seeded resume: load the persisted seed snapshot (@GENESIS_HEIGHT) and verify ITS digest
  // equals the pool's deployed resumeDigest — an empty state would digest differently and revert on attest.
  const seedKv = JSON.parse(readFileSync(KV_FILE, 'utf8'));
  const snap = JSON.parse(seedKv['reflection:scan:mainnet']).snapshot;
  idx.load(snap);
  const d = idx.digest();
  const got = (d.startsWith('0x') ? d : '0x' + d).toLowerCase();
  const want = RESUME_DIGEST.toLowerCase();
  console.log(`seed digest: got ${got}`);
  console.log(`             want ${want}  (deployed reflectionResumeDigest)`);
  if (got !== want) throw new Error(`SEED DIGEST MISMATCH — first attest would revert StaleReflectionDigest. Do NOT proceed.`);
  console.log('✓ seed digest matches — forward fold will chain cleanly from the deployed state');
}

async function maturedTip() {
  const h = parseInt(await api(env, '/blocks/tip/height'), 10);
  return h - CONFIRMATIONS;
}

// ── prove on the box: input JSON -> exec network prove -> {vkey, publicValues, proofBytes} ──
function proveOnBox(input, tag) {
  const local = `${STATE_DIR}/${tag}_input.json`;
  writeFileSync(local, JSON.stringify(input));
  const ssh = (cmd) => execFileSync('ssh', ['-o','BatchMode=yes','-o','StrictHostKeyChecking=no','-o','UserKnownHostsFile=/dev/null','-o','IdentitiesOnly=yes','-i',BOX.key,'-p',BOX.port,BOX.host,cmd], { encoding: 'utf8', maxBuffer: 64*1024*1024 });
  execFileSync('ssh', ['-o','StrictHostKeyChecking=no','-o','UserKnownHostsFile=/dev/null','-o','IdentitiesOnly=yes','-i',BOX.key,'-p',BOX.port,BOX.host,'mkdir -p /workspace/refl-fixtures /workspace/refl-out']);
  execFileSync('scp', ['-o','StrictHostKeyChecking=no','-o','UserKnownHostsFile=/dev/null','-o','IdentitiesOnly=yes','-i',BOX.key,'-P',BOX.port,local,`${BOX.host}:/workspace/refl-fixtures/${tag}_input.json`]);
  // bitcoin_prove (reflection guest → bitcoin_relay_vkey 0x00580f84) reads REFLECT_FIXTURE, PROOF_MODE=groth16,
  // PROVE_BACKEND=network; writes bitcoin_pv.hex + bitcoin_proof_bytes.hex (raw hex, no 0x) in cwd.
  const cmd = `source /workspace/netenv.sh; cd /workspace/refl-out; rm -f bitcoin_pv.hex bitcoin_proof_bytes.hex; `
    + `PROOF_MODE=groth16 PROVE_BACKEND=network ELF_VKEY_PIN=/workspace/tacit/contracts/sp1/confidential/elf-vkey-pin.json `
    + `REFLECT_FIXTURE=/workspace/refl-fixtures/${tag}_input.json /workspace/bin/bitcoin_prove 2>&1 | tail -4; `
    + `O=/root/work/prover-host/out; echo PV=$(cat $O/bitcoin_pv.hex bitcoin_pv.hex 2>/dev/null | head -1); echo PB=$(cat $O/bitcoin_proof_bytes.hex bitcoin_proof_bytes.hex 2>/dev/null | head -1)`;
  const out = ssh(cmd);
  let pv = (out.match(/PV=([0-9a-fA-Fx]+)/) || [])[1];
  let pb = (out.match(/PB=([0-9a-fA-Fx]+)/) || [])[1];
  if (!pv || !pb) throw new Error('box prove: missing pv/proof in output:\n' + out);
  if (!pv.startsWith('0x')) pv = '0x' + pv;
  if (!pb.startsWith('0x')) pb = '0x' + pb;
  return { vkey: null, publicValues: pv, proofBytes: pb, raw: out };
}

async function main() {
  console.log(`pool ${POOL}  genesis ${GENESIS_HEIGHT}  batchSize ${BATCH_SIZE}  ${DRY ? 'DRY-RUN' : `LIVE up to ${MAX_BATCHES} batch(es)`}`);
  assertSeedDigest();

  const att = buildScanReflectionAttester(env, { deps, api, apiRawBytes, network: 'mainnet', classifyTx: ({ rawHex }) => classifyConfidentialTx(rawHex) });
  if (!att) throw new Error('attester build returned null — check env');

  const tip = await maturedTip();
  console.log(`matured tip (chain tip - ${CONFIRMATIONS}) = ${tip}`);
  await att.setTip(tip);

  if (DRY) {
    console.log('assembling batch 1 (read-only)...');
    const job = await att.assembleJob();
    if (!job) { console.log('caught up — nothing to assemble'); return; }
    console.log(`batch: blocks ${job.blocks}, attestedTo ${job.attestedTo}, newDigest ${job.input.newDigest}`);
    console.log(`anchorHeight ${job.input.anchorHeight}, headers ${job.input.headers?.length}, blocks[] ${job.input.blocks?.length}`);
    const unsup = job.input.unsupportedEnvelopes || [];
    console.log(`unsupportedEnvelopes: ${unsup.length}${unsup.length ? ' -> ' + JSON.stringify(unsup.slice(0,3)) : ' (clean)'}`);
    // scan this batch's decoded txs for our note commit
    const NOTE = '01937ae0aa74eb802dce0bd98592fee624d9782b1865be6783552d852d89b3d0';
    const hit = JSON.stringify(job.input).toLowerCase().includes(NOTE);
    console.log(`note commit ${NOTE.slice(0,12)}… present in this batch: ${hit}`);
    console.log('DRY-RUN OK — no prove, no attest. Re-run with --batches=1 to land one real attest.');
    return;
  }

  const relay = makeBtcRelay(deps);
  const OPERATOR = '0x68575b073de49a94e3e3acf6f3a0d6e3b66267c7';   // pool operator = deployer
  const DEPLOYER_KEY = process.env.DEPLOYER_KEY;
  if (!DEPLOYER_KEY) throw new Error('set DEPLOYER_KEY (pool operator private key) to attest');
  const rpc = async (method, params = []) => {
    const r = await fetch(MRPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    const j = await r.json(); if (j.error) throw new Error(`${method}: ${j.error.message}`); return j.result;
  };
  let done = 0;
  while (done < MAX_BATCHES) {
    if (STOP_AT) { const s = await att.loadState(); if (s.attestedHeight >= STOP_AT) { console.log(`reached --to=${STOP_AT}.`); break; } }
    const job = await att.assembleJob();
    if (!job) { console.log('caught up.'); break; }
    console.log(`\n=== batch ${done+1}: heights ${job.input.anchorHeight}..${job.attestedTo} (${job.blocks} blks) newDigest ${job.input.newDigest} ===`);
    const tag = `bootstrap_${job.input.anchorHeight}_${job.attestedTo}`;
    console.log('proving on box (network groth16)...');
    const { publicValues, proofBytes } = proveOnBox(job.input, tag);
    console.log(`  proved: pv ${publicValues.length} chars, proof ${proofBytes.length} chars`);
    const nonce = parseInt(await rpc('eth_getTransactionCount', [OPERATOR, 'pending']), 16);
    const gp = BigInt(await rpc('eth_gasPrice'));
    const fees = { chainId: CHAIN_ID, nonce, maxPriorityFeePerGas: 100000000n, maxFeePerGas: gp * 2n + 200000000n, gasLimit: 1200000n };
    const { raw, hash } = relay.buildAttestTx(DEPLOYER_KEY, POOL, publicValues, proofBytes, fees);
    console.log(`  attest tx ${hash} — broadcasting...`);
    await rpc('eth_sendRawTransaction', [raw]);
    let rcpt = null;
    for (let i = 0; i < 60; i++) { rcpt = await rpc('eth_getTransactionReceipt', [hash]); if (rcpt) break; await new Promise(r => setTimeout(r, 5000)); }
    if (!rcpt) throw new Error(`attest receipt timeout: ${hash}`);
    if (parseInt(rcpt.status, 16) !== 1) throw new Error(`attest REVERTED: ${hash} (block ${parseInt(rcpt.blockNumber,16)})`);
    console.log(`  ✓ attested to height ${job.attestedTo} (block ${parseInt(rcpt.blockNumber, 16)}, digest ${job.input.newDigest})`);
    await att.ackJob(job.attestedTo, job.newSnapshot);
    done++;
  }
  console.log(`\ndone: ${done} batch(es) attested.`);
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
