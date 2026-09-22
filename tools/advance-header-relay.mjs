// Push the on-chain Bitcoin header relay's tip forward yourself, instead of waiting for Tacit's own
// header-relay cron to get there on its own lean, gas-batched schedule.
// BitcoinLightRelay.advanceTip is permissionless — anyone can
// submit real headers and pay their own gas — so this needs no Tacit credentials at all, only your own key.
//
// This only advances the HEADER RELAY. A block being past the relay's tip is necessary but not sufficient
// for reflection to fold it: reflection still needs its own attest (a real SP1 proof), which this tool does
// not build. See the runbook for that half — today it is an operator action (trigger tacit-reflection's
// Render cron on demand), not yet a public self-serve path, since a valid proof needs SP1 proving capacity.
//
// Usage:
//   PRIV=0x<a key with a little ETH> node tools/advance-header-relay.mjs [--to HEIGHT] [--run]
//
//   --to HEIGHT    advance the relay's tip to at least this Bitcoin height. Omit to advance to the live
//                  Bitcoin tip minus 2 (a small reorg margin) — as far as the relay can safely go right now.
//                  For a cBTC lock, pass its block height + 24 (REFLECTION_CONFIRMATIONS on this deployment) —
//                  that is the height the relay's own tip must clear before reflection can attest the lock.
//   --rpc URL      Ethereum RPC (default: a public endpoint).
//   --esplora URL  Bitcoin esplora, comma-separated for fallbacks (default: blockstream.info).
//   --run          actually broadcast. Without it, this prints the plan and sends nothing.
//
// Batches at most 40 headers per transaction (a gas-bounding choice mirroring header-relay.js's own default,
// not a contract limit — advanceTip accepts any nonzero multiple of 80 bytes). If the relay's on-chain tip is
// not the canonical block at its own height (a fork, or a branch someone else submitted), this refuses rather
// than attempting recovery — that needs the same care header-relay.js's own findResumeHeight gives it; ask an
// operator with Render access instead.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import { hmac } from '../node_modules/@noble/hashes/hmac.js';
import { sha256 as nobleSha256 } from '../node_modules/@noble/hashes/sha2.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { makeEvmTx } from '../dapp/evm-tx.js';

const _cat = (arrs) => { const t = arrs.reduce((s, a) => s + a.length, 0); const o = new Uint8Array(t); let p = 0; for (const a of arrs) { o.set(a, p); p += a.length; } return o; };
secp.etc.hmacSha256Sync = (key, ...m) => hmac(nobleSha256, key, _cat(m));

const HEADER_RELAY = '0x20A6ddc2C6E620c6248B5A34E85996516FDd19D0'; // docs/DEPLOYMENTS.md — BitcoinLightRelay
const MAX_BATCH = 40;

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const RUN = argv.includes('--run');
const RPC = arg('--rpc', 'https://ethereum-rpc.publicnode.com');
const ESPLORAS = arg('--esplora', 'https://blockstream.info/api').split(',').map((s) => s.trim()).filter(Boolean);
const TO = arg('--to', null);

const hexToBytes = (h) => { const s = String(h).replace(/^0x/, ''); const o = new Uint8Array(s.length / 2); for (let i = 0; i < o.length; i++) o[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16); return o; };
const bytesToHex = (b) => '0x' + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const sel = (sig) => bytesToHex(keccak_256(new TextEncoder().encode(sig)).slice(0, 4));
// Explorer hashes are displayed byte-reversed; the relay keys blocks by the header's internal byte order.
// Same convention as header-relay.js's own relayKey/sameBlock — reused here rather than re-derived.
const reverseHex = (h) => h.replace(/^0x/, '').toLowerCase().match(/../g).reverse().join('');

if (!process.env.PRIV) throw new Error('set PRIV=0x<key with a little ETH>');
const privBytes = hexToBytes(process.env.PRIV);
const evmTx = makeEvmTx({ secp, keccak256: keccak_256 });
const pub = secp.getPublicKey(privBytes, false);
const address = bytesToHex(keccak_256(pub.slice(1)).slice(-20));

const execFileP = promisify(execFile);
async function curlGet(url) { const { stdout } = await execFileP('curl', ['-sS', '--max-time', '20', url]); return stdout.trim(); }
async function esplora(path) {
  let err;
  for (const base of ESPLORAS) { try { return await curlGet(base + path); } catch (e) { err = e; } }
  throw new Error(`esplora ${path}: ${err?.message}`);
}
async function rpc(method, params) {
  const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }).then((r) => r.json());
  if (r.error) throw new Error(`${method}: ${r.error.message}`);
  return r.result;
}
async function ethCall(data) { return rpc('eth_call', [{ to: HEADER_RELAY, data }, 'latest']); }

console.log('signer', address, RUN ? '(will broadcast)' : '(dry run — pass --run to broadcast)');

const tipHeight = Number(BigInt(await ethCall(sel('tipHeight()'))));
const tipHash = (await ethCall(sel('tip()'))).toLowerCase();
const btcTipHeight = Number(await esplora('/blocks/tip/height'));
console.log('relay tip', tipHeight, tipHash, '| live BTC tip', btcTipHeight, '| relay lag', btcTipHeight - tipHeight, 'blocks');

// Refuse rather than guess if the relay's own tip is not the canonical block at that height.
const explorerHashAtTip = await esplora(`/block-height/${tipHeight}`);
if ('0x' + reverseHex(explorerHashAtTip) !== tipHash) {
  throw new Error(`relay tip ${tipHeight} does not match the canonical chain (relay=${tipHash}, explorer=0x${reverseHex(explorerHashAtTip)}) — this needs fork recovery, not a plain advance; ask an operator`);
}

const target = TO != null ? Number(TO) : btcTipHeight - 2;
if (target <= tipHeight) { console.log('relay is already at or past', target, '— nothing to do'); process.exit(0); }
console.log('target', target, `(${target - tipHeight} headers needed, in batches of <=${MAX_BATCH})`);

async function headerAt(height) {
  const hash = await esplora(`/block-height/${height}`);
  const hex = await esplora(`/block/${hash}/header`);
  if (!/^[0-9a-fA-F]{160}$/.test(hex)) throw new Error(`bad header @${height} (${hex.slice(0, 16)}…)`);
  return hexToBytes(hex);
}

let nonce = BigInt(await rpc('eth_getTransactionCount', [address, 'pending']));
const gasPrice = BigInt(await rpc('eth_gasPrice', []));
const maxFeePerGas = gasPrice * 2n;
const balance = BigInt(await rpc('eth_getBalance', [address, 'latest']));
console.log('signer ETH', Number(balance) / 1e18, '| nonce', nonce.toString(), '| gas price', Number(gasPrice) / 1e9, 'gwei');

let from = tipHeight + 1;
let batches = 0;
while (from <= target) {
  const to = Math.min(target, from + MAX_BATCH - 1);
  console.log(`fetching headers ${from}..${to}`);
  const headers = [];
  for (let h = from; h <= to; h++) headers.push(await headerAt(h));
  const flat = new Uint8Array(headers.length * 80);
  headers.forEach((h, i) => flat.set(h, i * 80));
  const calldata = sel('advanceTip(bytes)') + bytesToHex(new Uint8Array([
    ...hexToBytes('0000000000000000000000000000000000000000000000000000000000000020'), // offset
    ...hexToBytes(BigInt(flat.length).toString(16).padStart(64, '0')), // length
  ])).slice(2) + bytesToHex(flat).slice(2) + '00'.repeat((32 - (flat.length % 32)) % 32);

  console.log(`  batch ${++batches}: ${headers.length} headers, ${calldata.length / 2 - 1} bytes calldata`);
  if (RUN) {
    const gasLimit = 300000n + BigInt(headers.length) * 60000n;
    const tx = { chainId: 1n, nonce, maxPriorityFeePerGas: gasPrice, maxFeePerGas, gasLimit, to: HEADER_RELAY, value: 0n, data: calldata };
    const signed = evmTx.signEip1559(tx, privBytes);
    const res = await rpc('eth_sendRawTransaction', [signed.raw]);
    console.log('  sent', res);
    nonce += 1n;
  }
  from = to + 1; // always advance, dry run or not — a dry run must still terminate
}

if (!RUN) { console.log('DRY RUN — nothing sent. Re-run with --run to broadcast.'); process.exit(0); }
console.log('done —', batches, 'transaction(s) submitted. Poll tipHeight() or /reflection/status to confirm.');
