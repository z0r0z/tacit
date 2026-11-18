#!/usr/bin/env node
// Runs a Pay relay from a laptop or a server with one command: it makes the relay's key, waits for the stake and a little ETH to arrive at that key's address, starts the
// relay, opens a public address for it, lists it in the relay registry, and keeps the listed address current.
//
//   cd worker-relay && npm ci
//   node scripts/pay-relay.mjs --tunnel
//
//   --owner     who holds the stake and gets it back, if you want it to be an address of yours (default: a fresh address it makes, its key kept in --dir as owner.key;
//               an owner is public on chain, so a wallet that is known as yours ties the relay to you)
//   --url       the relay's public https address, if you have one (a server with a name); otherwise --tunnel
//   --tunnel    open one with cloudflared (installed, `brew install cloudflared`): wallets reach it by the tunnel's name, and the tunnel's provider, not the wallets, sees your connection
//   --dir       where it keeps its keys and store (default ~/.tacit-relay); the keys are files that only you can read
//   --port      the port the relay listens on (default 10000)
//   --rpc       the Ethereum node it reads and sends through: your own, or a provider's (default: free public nodes)
//   --seed      where a new relay reads the pool's history from: the project's relay, through the private route (the default), another relay's feed (a url ending /evm-pool/keeper),
//               or none. Free public nodes do not serve history that old, so a relay with no feed cannot start; the feed is checked against the chain's own root, nothing is taken on trust
//   --dry-run   say what it would do, and touch nothing
//   --local     start the relay and nothing else (no funds wait, no address, no listing): a check that it runs
//
// It asks for 1,000 TAC (the registry's minimum stake, plus a little) and 0.01 ETH (gas for a few thousand relayed spends; each spend's fee pays its gas) to be sent
// to the relay's address, and prints it. Send from wherever you like: out of a private balance, the address is not linked to you. A relay earns while it is on, and
// wallets pass over it while it is off. The relay's key and the stake owner's address are the only things on chain about you; this program sends nothing anywhere else.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, createWriteStream, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createPublicClient, createWalletClient, http, parseAbi, formatEther, formatUnits, keccak256, encodeAbiParameters, parseGwei } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { mainnet } from 'viem/chains';
import { newGatewayKey } from '../../dapp/sealed-request.js';
import { ROUTE } from '../../dapp/private-route.js';
import { readRegistry, RELAY_REGISTRY } from '../../dapp/evm-pool-open-relays.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER = join(HERE, '..');
const TAC = '0xA1313eb9f3A445606D9583bcAc3ebeB56a858279';
const MIN_ETH = 5n * 10n ** 15n;

export const loadDefaults = () => JSON.parse(readFileSync(join(WORKER, 'pay-relay-defaults.json'), 'utf8'));
// --rpc: the Ethereum node this relay reads and sends through (your own, or a provider's), in place of the free public ones
export const withRpc = (defaults, rpc) => (rpc ? { ...defaults, EVM_POOL_RPC_URL_1: rpc, EVM_POOL_RPC_URLS_FALLBACK_1: rpc } : defaults);

// the keys, made once and kept as files only the user can read
export function ensureSecrets(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { chmodSync(dir, 0o700); } catch { /* not ours to change */ }
  const keep = (name, make) => {
    const p = join(dir, name);
    if (!existsSync(p)) { writeFileSync(p, make() + '\n', { mode: 0o600 }); chmodSync(p, 0o600); }
    return readFileSync(p, 'utf8').trim();
  };
  const key = keep('relay.key', () => generatePrivateKey());
  const gateway = keep('gateway.key', () => newGatewayKey());
  return { key, gateway, address: privateKeyToAccount(key).address };
}

// who holds the stake when no --owner is named: a fresh address, its key kept beside the relay's. An owner is public on chain, so a fresh one keeps the relay from being tied
// to a wallet someone knows; its key is what takes the stake back (startExit, then finishExit)
export function ensureOwner(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const p = join(dir, 'owner.key');
  if (!existsSync(p)) { writeFileSync(p, generatePrivateKey() + '\n', { mode: 0o600 }); chmodSync(p, 0o600); }
  return privateKeyToAccount(readFileSync(p, 'utf8').trim()).address;
}

// the settings the relay service starts with: the public ones, this relay's own two keys, and where it keeps its store
export function relayEnv({ defaults, key, gateway, port, dir, seed = null, reset = false }) {
  if (!defaults?.EVM_POOL_ADDR || !defaults?.EVM_POOL_ZKEY || !key || !gateway) throw new Error('the relay settings are incomplete');
  return {
    ...defaults,
    EVM_POOL_KEEPER_PRIV_1: key,
    EVM_POOL_KEEPER_GATEWAY_KEY: gateway,
    EVM_POOL_KEEPER_DB: join(dir, 'keeper.db'),
    EVM_POOL_KEEPER_DB_1: join(dir, 'keeper-1.db'),
    EVM_POOL_ARTIFACT_DIR: join(dir, 'artifacts'),         // the ceremony files it downloads (the service's own default is under /var/lib, which a laptop cannot write)
    PORT: String(port),
    ...(seed ? { EVM_POOL_SEED_FEED_1: seed } : {}),
    ...(seed && reset ? { EVM_POOL_SEED_RESET_1: '1' } : {}),     // a store that has fallen behind is emptied and read again from the feed
  };
}

// a store that has not been written for a while (a laptop that slept) is older than free nodes can catch up from: it is read again from the feed
export const staleStore = (path, now = Date.now(), maxAgeMs = 20 * 60_000) => { try { return now - statSync(path).mtimeMs > maxAgeMs; } catch { return false; } };

// the public name cloudflared prints
export const parseTunnelUrl = (line) => /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(String(line))?.[0] ?? null;

// what the registry needs done for this relay at this address
export function urlAction({ listed, url }) {
  if (!listed) return 'register';
  return listed.url.replace(/\/+$/, '').toLowerCase() === url.replace(/\/+$/, '').toLowerCase() ? 'ok' : 'setUrl';
}

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const opt = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const log = (...a) => console.log(`[relay ${new Date().toISOString().slice(11, 19)}]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const REG = parseAbi(['function setUrl(uint256 id, string url)', 'function idOf(bytes32) view returns (uint256)', 'function minStake() view returns (uint256)']);
const ERC20 = parseAbi(['function balanceOf(address) view returns (uint256)']);

async function main() {
  const dir = opt('dir', join(homedir(), '.tacit-relay')), port = Number(opt('port', '10000'));
  const owner = opt('owner'), dry = flag('dry-run'), local = flag('local'), rpc = opt('rpc');
  const defs = () => withRpc(loadDefaults(), rpc);
  if (owner && !/^0x[0-9a-fA-F]{40}$/.test(owner)) { console.error('--owner has to be an address: 0x and 40 hex digits'); return 2; }
  if (!local && !dry && !opt('url') && !flag('tunnel')) { console.error('say how wallets reach it: --url https://<your public name>, or --tunnel (cloudflared)'); return 2; }
  if (dry) {
    const addr = existsSync(join(dir, 'relay.key')) ? privateKeyToAccount(readFileSync(join(dir, 'relay.key'), 'utf8').trim()).address : '(made when you run it)';
    console.log(`DRY RUN: nothing is made, started or sent.\n  keys: ${dir} (a relay key and a gateway key, readable only by you)\n  relay address: ${addr}\n  it would ask for 1,000 TAC and 0.01 ETH to be sent to that address\n  it would start the relay on port ${port}, open ${opt('url') ? opt('url') : 'a cloudflared tunnel'}, list it with ${owner || `a fresh address it makes (its key is kept in ${dir})`} as the stake owner, and keep the address current`);
    return 0;
  }
  if (!existsSync(join(WORKER, 'node_modules'))) { console.error(`run "npm ci" in ${WORKER} first`); return 2; }
  // the tunnel program is checked now, not after the funds have been sent and the relay has started
  if (flag('tunnel') && !opt('url') && spawnSync('cloudflared', ['--version'], { stdio: 'ignore' }).status !== 0) { console.error('--tunnel needs cloudflared, and it is not installed: `brew install cloudflared` (other systems: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/), or give --url https://<your public name>'); return 2; }
  const { key, gateway, address } = ensureSecrets(dir);
  log(`relay address ${address} (keys are in ${dir})`);
  const stakeOwner = owner || (local ? null : ensureOwner(dir));
  if (!local) log(owner ? `stake owner ${owner}` : `stake owner ${stakeOwner}: a fresh address, with its key in ${join(dir, 'owner.key')}. Keep a copy: that key takes the stake back. (--owner 0x… names your own wallet instead; an owner is public on chain.)`);
  const client = createPublicClient({ chain: mainnet, transport: http(defs().EVM_POOL_RPC_URL_1) });
  const minStake = await client.readContract({ address: RELAY_REGISTRY, abi: REG, functionName: 'minStake' });
  const needTac = minStake + 10n ** 18n;

  // this relay's entry in the registry (0 when it has none): a relay that is already in has its stake there, so a restart asks for gas only
  const entryIdNow = () => client.readContract({ address: RELAY_REGISTRY, abi: REG, functionName: 'idOf', args: [keccak256(encodeAbiParameters([{ type: 'uint64' }, { type: 'address' }], [1n, address]))] });
  if (!local) {
    for (;;) {
      const [tac, eth, id] = await Promise.all([client.readContract({ address: TAC, abi: ERC20, functionName: 'balanceOf', args: [address] }), client.getBalance({ address }), entryIdNow()]);
      const stakeNeeded = id === 0n;
      if ((!stakeNeeded || tac >= needTac) && eth >= MIN_ETH) { log(stakeNeeded ? `funded: ${formatUnits(tac, 18)} TAC, ${formatEther(eth)} ETH` : `already in the registry (entry ${id}), ${formatEther(eth)} ETH for gas`); break; }
      log(stakeNeeded
        ? `waiting for funds at ${address}: has ${formatUnits(tac, 18)} TAC and ${formatEther(eth)} ETH, needs ${formatUnits(needTac, 18)} TAC and ${formatEther(MIN_ETH)} ETH. Send them from anywhere (out of a private balance, nothing links it to you); tacit.finance/to/${address}/${formatUnits(needTac, 18)} is a pay link for the TAC.`
        : `waiting for gas at ${address}: has ${formatEther(eth)} ETH, needs ${formatEther(MIN_ETH)} ETH (this relay is already in the registry, so its stake is not asked for again)`);
      await sleep(30_000);
    }
  }

  // the relay
  const seed = opt('seed') === 'none' ? null : (opt('seed') || `${ROUTE.keeper}/1/evm-pool/keeper`);
  let reset = staleStore(join(dir, 'keeper-1.db'));
  const envNow = () => ({ ...process.env, ...relayEnv({ defaults: defs(), key, gateway, port, dir, seed, reset }) });
  const out = createWriteStream(join(dir, 'relay.log'), { flags: 'a', mode: 0o600 });
  let child = null, stopping = false;
  const start = () => {
    child = spawn(process.execPath, [join(HERE, 'pay-relay-service.mjs')], { cwd: WORKER, env: envNow(), stdio: ['ignore', 'pipe', 'pipe'] });
    reset = false;
    child.stdout.pipe(out, { end: false }); child.stderr.pipe(out, { end: false });
    child.on('exit', (c) => { if (!stopping) { log(`the relay stopped (${c}); starting it again in 10 s`); setTimeout(start, 10_000); } });
  };
  start();
  const stop = () => { stopping = true; child?.kill(); tunnel?.kill(); process.exit(0); };
  let tunnel = null;
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  // however this program ends (an error included), the relay and the tunnel it started end with it: none is left running with no one watching
  process.on('exit', () => { stopping = true; child?.kill(); tunnel?.kill(); });
  log(`starting the relay (its log is ${join(dir, 'relay.log')})`);
  for (let i = 0; ; i++) {
    try { const h = await (await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(4000) })).json(); if (h.ready) break; } catch { /* not up yet */ }
    if (i > 120) { console.error('the relay did not come up in 15 minutes: see the log'); stop(); }
    await sleep(8000);
  }
  log('the relay is up');
  if (local) { log('--local: running; Ctrl-C to stop'); return new Promise(() => {}); }

  // a public address
  let url = opt('url');
  const openTunnel = () => new Promise((resolve, reject) => {
    const t = spawn('cloudflared', ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`], { stdio: ['ignore', 'ignore', 'pipe'] });
    t.on('error', () => reject(new Error('cloudflared is not installed: brew install cloudflared (or give --url)')));
    let said = false;
    t.stderr.on('data', (d) => { const u = parseTunnelUrl(d); if (u && !said) { said = true; tunnel = t; resolve(u); } });
    t.on('exit', () => { if (!stopping && said) { log('the tunnel closed; opening another'); setTimeout(() => openTunnel().then((u) => { url = u; log(`public address: ${relayUrl()}`); return sync(relayUrl()); }).catch((e) => log(e.message)), 5000); } });
    setTimeout(() => { if (!said) reject(new Error('the tunnel gave no address in 60 s')); }, 60_000);
  });
  if (!url) url = await openTunnel();
  const relayUrl = () => `${url.replace(/\/+$/, '')}/1/evm-pool/keeper`;
  log(`public address: ${relayUrl()}`);

  // the registry
  const account = privateKeyToAccount(key);
  const wallet = createWalletClient({ account, chain: mainnet, transport: http(defs().EVM_POOL_RPC_URL_1) });
  async function sync(target) {
    const entries = await readRegistry({ call: (to, data) => client.call({ to, data }).then((r) => r.data), chainId: 1 });
    const listed = entries.find((e) => e.relayer.toLowerCase() === address.toLowerCase()) ?? null;
    const action = urlAction({ listed, url: target });
    if (action === 'ok') return log(`listed at ${target}`);
    const id = await entryIdNow();
    // in the registry but not on its list (its stake is under a raised minimum, or it is leaving): listing it again would fail, the owner puts it right
    if (action === 'register' && id !== 0n) return log(`the registry has this relay (entry ${id}) but does not list it: its stake is under the minimum, or it is leaving. Its owner can top it up on the Pay relays card at tacit.finance/prove/#pay-relays`);
    if (action === 'register') {
      log('listing the relay (one transaction)…');
      const r = spawnSync(process.execPath, [join(HERE, 'register-relay.mjs'), '--url', target, '--owner', stakeOwner, '--send', ...(rpc ? ['--rpc', rpc] : [])], { env: { ...process.env, RELAY_KEY: key }, encoding: 'utf8' });
      log((r.stdout + r.stderr).trim().split('\n').slice(-3).join(' | '));
      if (r.status !== 0) throw new Error('listing did not go through: see above');
    } else {
      log(`the address changed: ${listed.url} → ${target}`);
      // the fee follows the chain (twice the base fee, a small tip), as the listing's does; a fixed cap would leave the transaction waiting, and with it the relay's own next spend
      const tip = parseGwei('0.1'), { baseFeePerGas } = await client.getBlock();
      const hash = await wallet.writeContract({ address: RELAY_REGISTRY, abi: REG, functionName: 'setUrl', args: [id, target], maxFeePerGas: baseFeePerGas * 2n + tip, maxPriorityFeePerGas: tip });
      const rc = await client.waitForTransactionReceipt({ hash, timeout: 10 * 60_000 });
      if (rc.status !== 'success') throw new Error(`the address update did not go through (${hash})`);
      log(`address updated (${hash})`);
    }
  }
  await sync(relayUrl());
  log('running. A relay earns while this is on; wallets pass over it while it is off. Ctrl-C stops it.');
  let silent = 0;
  for (;;) {
    await sleep(60_000);
    try {
      const r = await fetch(`http://127.0.0.1:${port}/1/evm-pool/keeper/quote`, { signal: AbortSignal.timeout(5000) });
      const q = await r.json();
      if (!r.ok) throw new Error(q.error || `HTTP ${r.status}`);
      silent = 0;
      const eth = await client.getBalance({ address });
      log(`quoting ${Number(q.fee) / 1e18} ETH a spend; key holds ${formatEther(eth)} ETH`);
    } catch (e) {
      log(`not answering a quote just now (${e.message})`);
      // five minutes of that, funded: the store has most likely fallen behind (the machine slept): read it again from the feed
      if (seed && ++silent >= 5) { silent = 0; reset = true; log('starting the relay again, reading the pool from the feed afresh'); child?.kill(); }
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().then((c) => { if (typeof c === 'number') process.exit(c); }, (e) => { console.error(e.message); process.exit(1); });
