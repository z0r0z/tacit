#!/usr/bin/env node
// Sends the settle of a job the relay has proved and left for its owner to send (status `proven`, no transaction): a wrap or any other op whose
// proof was asked for alone because the relay was not sending settles at the time. The settle is open to any account, and the proof fixes whose
// notes it makes, so the account that sends it only pays the gas. Without --send it checks and simulates, and sends nothing.
//
//   node tools/settle-proven-job.mjs <jobId>                          check the job and run its settle as a call
//   SETTLER_KEY=<64 hex> node tools/settle-proven-job.mjs <jobId> --send
//
//   SETTLER_KEY   the account that pays the gas (read from the environment, never printed); with none the call is made from a stand-in address
//   RELAY         the relay's address (default https://api.tacit.finance)
//   RPC           an Ethereum JSON-RPC address for the reads and the call (default https://rpc.mevblocker.io); the send goes where the pool module sends
//
// Node 22; run from the repository root.

import { makeFileStorage } from '../fastbridge-lp/lib/storage.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const SEND = args.includes('--send');
const jobId = args.find((a) => /^0x[0-9a-fA-F]{64}$/.test(a));
const die = (m) => { console.error(m); process.exit(1); };
if (!jobId) die('usage: [SETTLER_KEY=<64 hex>] node tools/settle-proven-job.mjs <jobId> [--send]');
const RELAY = String(process.env.RELAY || 'https://api.tacit.finance').replace(/\/$/, '');
const RPC = process.env.RPC || 'https://rpc.mevblocker.io';
const keyHex = String(process.env.SETTLER_KEY || '').trim().replace(/^0x/, '');
if (keyHex && !/^[0-9a-f]{64}$/i.test(keyHex)) die('SETTLER_KEY must be 64 hex characters');
if (SEND && !keyHex) die('--send needs SETTLER_KEY (the account that pays the gas)');

globalThis.localStorage = makeFileStorage(join(tmpdir(), 'tacit-settle-proven-cache.json'));
const { secp, sha256, keccak_256, hmac } = await import('../dapp/vendor/tacit-deps.min.js');
secp.etc.hmacSha256Sync = (k, ...m) => hmac(sha256, k, secp.etc.concatBytes(...m));
const { makeConfidentialPoolUx } = await import('../dapp/confidential-pool-ux.js');
const { setActiveNetwork } = await import('../dapp/confidential-deployments.js');
setActiveNetwork('mainnet');
const ux = makeConfidentialPoolUx({ secp, keccak256: keccak_256, sha256, fetchImpl: (u, o) => globalThis.fetch(u, o), network: 'mainnet' });

const rpc = async (method, params) => {
  const r = await (await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json();
  if (r.error) throw Object.assign(new Error(String(r.error.message || 'rpc error')), { data: r.error.data });
  return r.result;
};

const res = await fetch(`${RELAY}/confidential/status?id=${encodeURIComponent(jobId)}`);
if (!res.ok) die(`the relay does not know this job (${res.status})`);
const job = await res.json();
console.log(JSON.stringify({ job: jobId, type: job.type, status: job.status, txHash: job.txHash || null, mode: job.mode || null }));
if (job.status === 'settled') die(`this job is already settled${job.txHash ? ': ' + job.txHash : ''}: nothing to send`);
if (job.status !== 'proven' || !job.publicValues || !job.proof) die(`this job is not one that was proved and left to send (status ${job.status}): nothing was done`);
if (job.txHash) die(`this job already has a transaction (${job.txHash}): nothing was done`);

const settler = keyHex ? ux.account(Uint8Array.from(keyHex.match(/../g).map((x) => parseInt(x, 16)))) : null;
const from = settler ? settler.address : '0x000000000000000000000000000000000000dEaD';
const data = ux.settleCalldata({ publicValues: job.publicValues, proof: job.proof, memos: job.memos || [] });
try { await rpc('eth_call', [{ from, to: ux.cfg.pool, data }, 'latest']); console.log('the settle runs as a call from', settler ? 'the settler' : 'a stand-in address', ': the pool would take it'); }
catch (e) { die(`the pool would refuse this settle, so nothing was sent: ${String((e && e.message) || e).slice(0, 200)}${e && e.data ? ' (' + String(e.data).slice(0, 10) + ')' : ''}`); }
let gas = 1_200_000n;
try { gas = (BigInt(await rpc('eth_estimateGas', [{ from, to: ux.cfg.pool, data }])) * 13n) / 10n; } catch { /* the helper's own limit stands */ }
const price = BigInt(await rpc('eth_gasPrice', []));
console.log(`gas about ${gas} at ${(Number(price) / 1e9).toFixed(3)} gwei: at most ${(Number(gas * price) / 1e18).toFixed(6)} ETH`);
if (settler) {
  const bal = BigInt(await rpc('eth_getBalance', [settler.address, 'latest']));
  console.log(`the settler ${settler.address} holds ${(Number(bal) / 1e18).toFixed(6)} ETH`);
  if (SEND && bal < gas * price * 2n) die('the settler holds less than twice the gas: nothing was sent');
}
if (!SEND) { console.log('checked only; add --send (and SETTLER_KEY) to send it'); process.exit(0); }
const sent = await ux.settleFromAccount({ settlerPriv: Uint8Array.from(keyHex.match(/../g).map((x) => parseInt(x, 16))), publicValues: job.publicValues, proof: job.proof, memos: job.memos || [] });
console.log('settle sent and mined:', sent.txHash);
process.exit(0);
