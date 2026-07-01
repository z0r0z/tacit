// Minimal LIVE EVM confidential settle on the deployed vanity ConfidentialPool (Sepolia).
// Proves the newly-deployed pool + re-proven PROGRAM_VKEY process a REAL settle end-to-end:
//   wrap cETH (pool.wrap) -> transfer the note (box proves OP_TRANSFER) -> pool.settle() -> currentRoot advances.
// The box settle loop (already polling api.tacit.finance) claims + Groth16-proves + submits settle().
//
// Run: SETTLE_KEY=0x<deployer> node tests/live-evm-settle-sepolia.mjs
import { createHash } from 'node:crypto';
import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { hmac } from '../node_modules/@noble/hashes/hmac.js';
import { sha256 as nobleSha256 } from '../node_modules/@noble/hashes/sha2.js';
import { makeConfidentialPoolUx } from '../dapp/confidential-pool-ux.js';
import { getConfidentialDeployment } from '../dapp/confidential-deployments.js';

const _cat = (a) => { const t = a.reduce((s, x) => s + x.length, 0); const o = new Uint8Array(t); let p = 0; for (const x of a) { o.set(x, p); p += x.length; } return o; };
secp.etc.hmacSha256Sync = (key, ...m) => hmac(nobleSha256, key, _cat(m));
const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const hexToBytes = (h) => Uint8Array.from((h.replace(/^0x/, '').match(/../g) || []).map((x) => parseInt(x, 16)));

const NETWORK = process.env.NETWORK || 'signet';
const C = getConfidentialDeployment(NETWORK);
const RPC = process.env.SEPOLIA_RPC || 'https://ethereum-sepolia-rpc.publicnode.com';
const ux = makeConfidentialPoolUx({ secp, keccak256: keccak_256, sha256, network: NETWORK });
const cfg = ux.cfg || {};

const rpc = async (method, params = []) => {
  let lastErr;
  for (let i = 0; i < 5; i++) {
    try {
      const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
      const j = await r.json(); if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`); return j.result;
    } catch (e) { lastErr = e; await new Promise((r) => setTimeout(r, 1500)); }
  }
  throw lastErr;
};
const currentRoot = () => rpc('eth_call', [{ to: C.pool, data: '0x' + keccakSel('currentRoot()') }, 'latest']);
function keccakSel(sig) { return Buffer.from(keccak_256(new TextEncoder().encode(sig))).toString('hex').slice(0, 8); }

// A deterministic test wallet key (NOT the deployer — the confidential account is domain-separated anyway).
const WALLET_PRIV = process.env.WALLET_PRIV || '0x' + 'a5'.repeat(32);
const walletPriv = hexToBytes(WALLET_PRIV);

console.log(`=== LIVE EVM confidential settle — ${NETWORK} pool ${C.pool} ===`);
console.log(`  cETH assetId: ${C.assets.find((a) => a.ticker === 'cETH')?.assetId}`);
console.log(`  relayBase: ${cfg.relayBase}   rpc: ${RPC}`);

const acct = ux.account(walletPriv);
console.log(`  confidential EVM account: ${acct.address}`);
const bal = BigInt(await rpc('eth_getBalance', [acct.address, 'latest']));
console.log(`  account balance: ${bal} wei (${Number(bal) / 1e18} ETH)`);

const MODE = process.env.STAGE || 'info';
if (MODE === 'info') {
  console.log(`\n  next: fund ${acct.address} with ~0.05 ETH, then STAGE=wrap ... STAGE=settle`);
  process.exit(0);
}

const root0 = await currentRoot();
console.log(`\n  currentRoot (pre): ${root0}`);

if (MODE === 'wrap' || MODE === 'all') {
  const amountWei = BigInt(process.env.WRAP_WEI || '10000000000000000'); // 0.01 ETH
  console.log(`\n[wrap] pool.wrap ${amountWei} wei cETH from ${acct.address}…`);
  const w = await ux.wrap({ walletPriv, amountWei, ticker: 'cETH' });
  console.log(`  wrap tx: ${w.txHash}`);
  console.log(`  note commit: ${w.commit || (w.note && w.note.commit) || '?'}`);
  console.log(`  waiting for confirmation…`);
  for (let i = 0; i < 40; i++) { await new Promise((r) => setTimeout(r, 6000)); const rc = await rpc('eth_getTransactionReceipt', [w.txHash]); if (rc) { console.log(`  wrap confirmed block ${parseInt(rc.blockNumber, 16)} status ${rc.status}`); break; } }
  console.log(`  currentRoot (post-wrap): ${await currentRoot()}`);
}

if (MODE === 'wrapsend' || MODE === 'all') {
  const amountWei = BigInt(process.env.WRAP_WEI || '10000000000000000'); // 0.01 ETH
  const CETH_SCALE = BigInt(C.assets.find((a) => a.ticker === 'cETH').unitScale);
  const inSys = amountWei / CETH_SCALE;
  const idn = ux.identity(walletPriv);
  console.log(`\n[wrapAndSend] atomic wrap ${amountWei} wei -> settle ${inSys} cETH to self (${idn.pubHex.slice(0, 22)}…)`);
  console.log(`  (box proves OP_WRAP_TRANSFER in the loop; router does wrap+settle atomically)`);
  const index = Number(process.env.WRAP_INDEX || 1); // fresh deposit index (0 may already be a pending deposit)
  const r = await ux.wrapAndSend({ walletPriv, amountWei, ticker: 'cETH', recipientPubHex: idn.pubHex, amount: inSys, fee: 0n, index });
  console.log(`  router wrapAndSettle tx: ${r.txHash}   jobId: ${r.jobId}`);
  for (let i = 0; i < 60; i++) { await new Promise((r) => setTimeout(r, 6000)); const rc = await rpc('eth_getTransactionReceipt', [r.txHash]); if (rc) { console.log(`  SETTLE confirmed block ${parseInt(rc.blockNumber, 16)} status ${rc.status}`); break; } }
  const root1 = await currentRoot();
  console.log(`  currentRoot (post-settle): ${root1}`);
  console.log(root1 !== root0 ? `\n  ✓✓ LIVE EVM SETTLE CONFIRMED — root advanced ${root0.slice(0, 14)}… → ${root1.slice(0, 14)}…` : `\n  ⚠ root unchanged — settle may not have applied`);
}
