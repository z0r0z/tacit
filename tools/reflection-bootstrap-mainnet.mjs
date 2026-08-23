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
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { buildScanReflectionAttester } from '../worker/src/reflection-attest.js';
import { makeScanReflectionIndexer } from '../dapp/confidential-reflection-scan-indexer.js';
import { SWAP_BATCH_VK } from '../dapp/confidential-swapbatch-vk.js';
import { classifyConfidentialTx } from '../dapp/burn-deposit-bitcoin.js';
import { makeBtcRelay } from '../dapp/confidential-btc-relay.js';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';

const sha256 = (b) => nobleSha256(b instanceof Uint8Array ? b : Uint8Array.from(b));
const deps = { secp, keccak256: keccak_256, sha256 };

// ── config ──
const POOL = '0x000000000013f1C523585cd98E527c7f9285a21C';
const GENESIS_HEIGHT = 957443;                 // deploy anchor (empty seed)
const RESUME_DIGEST = '0xc520d2d4a7cbd4502c8694033479acc0686a58ef9be5807e6e995604151bd108';
const GENESIS_ANCHOR = '0xef648b3ae668a786eb1124b581449d3287f470d0155601000000000000000000';
const CONFIRMATIONS = 6;
const CHAIN_ID = 1;
const MRPC = process.env.MRPC || 'https://ethereum-rpc.publicnode.com';
const ESPLORA = process.env.ESPLORA || 'https://mempool.space/api';
const BATCH_SIZE = parseInt(process.env.REFLECTION_BATCH_SIZE || '6', 10);
const BOX = { key: '/Users/z/.ssh/runpod_prover', port: '34642', host: 'root@157.157.221.29' };
const STATE_DIR = '/private/tmp/claude-501/-Users-z-tacit/75f9c6fb-adf6-4ec0-bf4d-e7c268bc747e/scratchpad/refl-state';
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
  idx.state().setHeight(GENESIS_HEIGHT);
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
  const ssh = (cmd) => execFileSync('ssh', ['-o','BatchMode=yes','-o','StrictHostKeyChecking=no','-o','IdentitiesOnly=yes','-i',BOX.key,'-p',BOX.port,BOX.host,cmd], { encoding: 'utf8', maxBuffer: 64*1024*1024 });
  execFileSync('scp', ['-o','StrictHostKeyChecking=no','-o','IdentitiesOnly=yes','-i',BOX.key,'-P',BOX.port,local,`${BOX.host}:/workspace/work/cxfer/fixtures/${tag}_input.json`]);
  const cmd = `source /workspace/netenv.sh; ln -sfn /workspace/work /root/work; cd /workspace/work/cxfer/exec; `
    + `PROVE_BACKEND=network ELF_VKEY_PIN=/workspace/tacit/contracts/sp1/confidential/elf-vkey-pin.json `
    + `REFLECT_INPUT=/workspace/work/cxfer/fixtures/${tag}_input.json REFLECT_OUT_TAG=${tag} `
    + `./target/release/exec 2>&1 | tail -5; `
    + `echo PV=$(cat ${tag}_public_values.hex 2>/dev/null); echo PB=$(cat ${tag}_proof_bytes.hex 2>/dev/null); echo VK=$(grep -oE 'BITCOIN_RELAY_VKEY=0x[0-9a-f]+' /workspace/reflect-prove.log 2>/dev/null | tail -1)`;
  const out = ssh(cmd);
  const pv = (out.match(/PV=(0x[0-9a-fA-F]+)/) || [])[1];
  const pb = (out.match(/PB=(0x[0-9a-fA-F]+)/) || [])[1];
  if (!pv || !pb) throw new Error('box prove: missing pv/proof in output:\n' + out);
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
  let done = 0;
  while (done < MAX_BATCHES) {
    const job = await att.assembleJob();
    if (!job) { console.log('caught up.'); break; }
    console.log(`\n=== batch ${done+1}: heights ${job.input.anchorHeight}..${job.attestedTo} (${job.blocks} blks) newDigest ${job.input.newDigest} ===`);
    const tag = `bootstrap_${job.input.anchorHeight}_${job.attestedTo}`;
    console.log('proving on box (network)...');
    const { publicValues, proofBytes } = proveOnBox(job.input, tag);
    console.log(`  pv ${publicValues.length} chars, proof ${proofBytes.length} chars`);
    // TODO(next): buildAttestTx + broadcast + wait receipt, then ackJob. Held until dry-run+prove validated.
    console.log('  [attest broadcast not yet enabled in this build — validate prove first]');
    break;
  }
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
