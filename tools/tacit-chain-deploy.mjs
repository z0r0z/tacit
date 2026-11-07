#!/usr/bin/env node
// Deploys the tacit chain's two contracts, TacitSeats then TacitBlocks, from the relay wallet 0x68575b07 (the deployer their CreateX salts
// are bound to), with the kit the admin page uses (dapp/admin/tacit-chain/kit.json). The wallet's key is read from Render, from the env group
// the relay services share, when it is needed; it is never printed or written anywhere.
//
// The same wallet sends the header relay's and the reflection's transactions, so each deploy waits until nothing of the wallet's is pending,
// goes out through a public RPC (where the relay's own reads see the nonce taken), and is sent again with the next nonce if the relay took
// that one first. The relay retries a nonce it lost the same way (worker-relay/src/lib/nonce-retry.js).
//
//   node tools/tacit-chain-deploy.mjs                  what it would send, the gas now, the wallet's balance and nonce (sends nothing)
//   node tools/tacit-chain-deploy.mjs --send           deploy
//   --rpc <url>        reads and sends (default https://ethereum-rpc.publicnode.com)
//   --max-gwei <n>     refuse while the base fee is above this (default 1)
//   --tip-gwei <n>     the priority fee (default 0.02: a node's suggestion is often far above what inclusion needs, and the wallet is lean)
//   --unlocked         send with eth_sendTransaction from the deployer, no key (a fork that impersonates it, for a dry run)
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { keccak_256 } from '@noble/hashes/sha3';
import { makeRpc, addressOf, send } from '../tacit-leader/rpc.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const SEND = process.argv.includes('--send'), UNLOCKED = process.argv.includes('--unlocked');
const RPC_URL = arg('rpc', 'https://ethereum-rpc.publicnode.com');
const MAX_GWEI = Number(arg('max-gwei', '1'));
const TIP = BigInt(Math.round(Number(arg('tip-gwei', '0.02')) * 1e9));
const ENV_GROUP = 'evg-d9eb08bbc2fs73fkm850'; // tacit-relay-shared: RELAY_KEY
const kit = JSON.parse(readFileSync(new URL('../dapp/admin/tacit-chain/kit.json', import.meta.url), 'utf8'));
const rpc = makeRpc(RPC_URL);
const say = (...a) => console.log(...a);
const fail = (m) => { console.error(`tacit-chain-deploy: ${m}`); process.exit(1); };
const hex = (b) => '0x' + Buffer.from(b).toString('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const gwei = (w) => (Number(w) / 1e9).toFixed(4);

// CreateX deployCreate3(bytes32 salt, bytes initCode)
const calldata = (s) => {
  const i = s.initCode.slice(2), n = i.length / 2;
  return kit.deploySelector + s.salt.slice(2) + (0x40).toString(16).padStart(64, '0') + n.toString(16).padStart(64, '0') + i + '0'.repeat((64 - (i.length % 64)) % 64);
};
const checksOf = async (s) => Promise.all(s.checks.map(async (c) => ({ name: c.name, ok: String(await rpc.call('eth_call', [{ to: s.expected, data: c.sel }, 'latest']).catch(() => '')).toLowerCase() === c.want.toLowerCase() })));
const nonces = async () => Promise.all(['latest', 'pending'].map(async (t) => Number(BigInt(await rpc.call('eth_getTransactionCount', [kit.deployer, t])))));

// The relay wallet's key, from the env group the relay services share (Render API key from this Mac's keychain); RELAY_KEY in the
// environment instead, if set. Checked to be the deployer's.
async function relayKey() {
  let key = process.env.RELAY_KEY;
  if (!key) {
    const token = execFileSync('security', ['find-generic-password', '-s', 'tacit-render-api-key', '-w'], { encoding: 'utf8' }).trim();
    const r = await fetch(`https://api.render.com/v1/env-groups/${ENV_GROUP}`, { headers: { authorization: `Bearer ${token}`, accept: 'application/json' } });
    if (!r.ok) fail(`Render did not give the env group (${r.status})`);
    const g = await r.json();
    key = (g.envVars || g.envGroup?.envVars || []).find((v) => (v.envVar?.key ?? v.key) === 'RELAY_KEY');
    key = key?.envVar?.value ?? key?.value;
    if (!key) fail('RELAY_KEY is not in the relay services\' env group');
  }
  key = key.startsWith('0x') ? key : '0x' + key;
  if (addressOf(key).toLowerCase() !== kit.deployer.toLowerCase()) fail('the key Render holds is not the deployer\'s');
  return key;
}

// Waits until nothing of the wallet's is pending (the relay's last send mined), then a block more, and checks again
async function quiet() {
  for (let i = 0; i < 200; i++) {
    const [latest, pending] = await nonces();
    if (latest === pending) {
      await sleep(12_000);
      const [l2, p2] = await nonces();
      if (l2 === p2 && l2 === latest) return latest;
    } else if (i % 10 === 0) say(`  the relay has a transaction pending (nonce ${latest} → ${pending}); waiting`);
    await sleep(3_000);
  }
  fail('the wallet did not go quiet in 10 minutes');
}

async function deploy(s, key) {
  const data = calldata(s);
  for (let attempt = 1; attempt <= 5; attempt++) {
    const nonce = await quiet();
    const block = await rpc.call('eth_getBlockByNumber', ['latest', false]);
    const base = BigInt(block.baseFeePerGas);
    if (Number(base) / 1e9 > MAX_GWEI) fail(`the base fee is ${gwei(base)} gwei, over --max-gwei ${MAX_GWEI}`);
    say(`  ${s.name}: nonce ${nonce}, base fee ${gwei(base)} gwei`);
    try {
      let r;
      if (UNLOCKED) {
        const tip = TIP;
        const est = BigInt(await rpc.call('eth_estimateGas', [{ from: kit.deployer, to: kit.factory, data }]));
        const h = await rpc.call('eth_sendTransaction', [{ from: kit.deployer, to: kit.factory, data, gas: '0x' + ((est * 125n) / 100n).toString(16), maxFeePerGas: '0x' + (base * 2n + tip).toString(16), maxPriorityFeePerGas: '0x' + tip.toString(16) }]);
        for (let i = 0; i < 90 && !(r = await rpc.call('eth_getTransactionReceipt', [h])); i++) await sleep(2000);
        if (!r || r.status !== '0x1') throw new Error(`tx ${h} did not succeed`);
      } else {
        // send() takes the calldata as bytes
        r = await send(rpc, key, kit.factory, Buffer.from(data.slice(2), 'hex'), { chainId: kit.chainId, tip: TIP });
      }
      return r;
    } catch (e) {
      const m = String(e?.message || e);
      if (!/nonce too low|underpriced|already known|replacement|nonce.*(used|expired)/i.test(m)) throw e;
      say(`  the relay took that nonce first (${m.slice(0, 80)}); trying again`);
    }
  }
  fail(`${s.name}: lost the nonce five times`);
}

// the kit is what the admin page deploys: each init code hashes to the kit's initHash
for (const s of kit.steps) if (hex(keccak_256(Buffer.from(s.initCode.slice(2), 'hex'))) !== s.initHash.toLowerCase()) fail(`${s.name}: the init code does not hash to the kit's initHash`);
const chainId = Number(BigInt(await rpc.call('eth_chainId', [])));
if (chainId !== kit.chainId) fail(`the RPC is chain ${chainId}, the kit is for ${kit.chainId}`);

const [latest, pending] = await nonces();
const balance = BigInt(await rpc.call('eth_getBalance', [kit.deployer, 'latest']));
const base = BigInt((await rpc.call('eth_getBlockByNumber', ['latest', false])).baseFeePerGas);
say(`deployer ${kit.deployer}: ${(Number(balance) / 1e18).toFixed(6)} ETH, nonce ${latest}${pending !== latest ? ` (${pending - latest} pending)` : ''}; base fee ${gwei(base)} gwei`);
say(`about 5.0M gas for both (TacitSeats ~0.93M, TacitBlocks ~4.07M, measured on a fork): ~${(5.0e6 * Number(base + TIP) / 1e18).toFixed(6)} ETH at this base fee and a ${gwei(TIP)} gwei tip`);

const todo = [];
for (const s of kit.steps) {
  const code = await rpc.call('eth_getCode', [s.expected, 'latest']);
  if (code && code !== '0x') {
    const c = await checksOf(s);
    if (!c.every((x) => x.ok)) fail(`${s.name} at ${s.expected} has code that fails ${c.filter((x) => !x.ok).map((x) => x.name).join(', ')}`);
    say(`${s.name} is already at ${s.expected} and checks out`);
  } else {
    todo.push(s);
    say(`${s.name} → ${s.expected}`);
  }
}
if (!todo.length) { say('nothing to deploy'); process.exit(0); }
if (!SEND) { say('\nnothing sent: run with --send to deploy'); process.exit(0); }

const key = UNLOCKED ? null : await relayKey();
let landed = null;
for (const s of todo) {
  const r = await deploy(s, key);
  const c = await checksOf(s);
  say(`${s.name} deployed at ${s.expected} in block ${Number(BigInt(r.blockNumber))}, tx ${r.transactionHash}, gas ${Number(BigInt(r.gasUsed))}: ${c.every((x) => x.ok) ? 'checks out' : 'FAILS ' + c.filter((x) => !x.ok).map((x) => x.name).join(', ')}`);
  if (!c.every((x) => x.ok)) process.exit(1);
  if (s.name === 'TacitBlocks') landed = Number(BigInt(r.blockNumber));
}
const left = BigInt(await rpc.call('eth_getBalance', [kit.deployer, 'latest']));
say(`\nTacitBlocks ${kit.steps.find((s) => s.name === 'TacitBlocks').expected}${landed ? `, deployed in block ${landed} (the leader's FROM_BLOCK)` : ''}; the relay wallet has ${(Number(left) / 1e18).toFixed(6)} ETH left`);
