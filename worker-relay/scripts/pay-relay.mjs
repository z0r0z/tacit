#!/usr/bin/env node
// Runs a Pay relay from a laptop or a server with one command: it makes the relay's key, waits for the stake and a little ETH to arrive at that key's address, starts the
// relay, opens a public address for it, lists it in the relay registry, and keeps the listed address current.
//
//   cd worker-relay && npm ci
//   node scripts/pay-relay.mjs --owner 0x<the address that holds the stake and gets it back>
//
//   --owner     who holds the stake (required): a fresh address of your own, or your wallet's
//   --url       the relay's public https address, if you have one (a server with a name); otherwise --tunnel
//   --tunnel    open one with cloudflared (installed, `brew install cloudflared`): wallets reach it by the tunnel's name, and the tunnel's provider, not the wallets, sees your connection
//   --dir       where it keeps its keys and store (default ~/.tacit-relay); the keys are files that only you can read
//   --port      the port the relay listens on (default 10000)
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
  const owner = opt('owner'), dry = flag('dry-run'), local = flag('local');
  if (!local && !/^0x[0-9a-fA-F]{40}$/.test(owner || '')) { console.error('--owner 0x… is needed: the address that holds the stake and gets it back (a fresh address of your own is best)'); return 2; }
  if (!local && !dry && !opt('url') && !flag('tunnel')) { console.error('say how wallets reach it: --url https://<your public name>, or --tunnel (cloudflared)'); return 2; }
  if (dry) {
    const addr = existsSync(join(dir, 'relay.key')) ? privateKeyToAccount(readFileSync(join(dir, 'relay.key'), 'utf8').trim()).address : '(made when you run it)';
    console.log(`DRY RUN: nothing is made, started or sent.\n  keys: ${dir} (a relay key and a gateway key, readable only by you)\n  relay address: ${addr}\n  it would ask for 1,000 TAC and 0.01 ETH to be sent to that address\n  it would start the relay on port ${port}, open ${opt('url') ? opt('url') : 'a cloudflared tunnel'}, list it with ${owner || '--owner'} as the stake owner, and keep the address current`);
    return 0;
  }
  if (!existsSync(join(WORKER, 'node_modules'))) { console.error(`run "npm ci" in ${WORKER} first`); return 2; }
  const { key, gateway, address } = ensureSecrets(dir);
  log(`relay address ${address} (keys are in ${dir})`);
  const client = createPublicClient({ chain: mainnet, transport: http(loadDefaults().EVM_POOL_RPC_URL_1) });
  const minStake = await client.readContract({ address: RELAY_REGISTRY, abi: REG, functionName: 'minStake' });
  const needTac = minStake + 10n ** 18n;

  if (!local) {
    for (;;) {
      const [tac, eth] = await Promise.all([client.readContract({ address: TAC, abi: ERC20, functionName: 'balanceOf', args: [address] }), client.getBalance({ address })]);
      if (tac >= needTac && eth >= MIN_ETH) { log(`funded: ${formatUnits(tac, 18)} TAC, ${formatEther(eth)} ETH`); break; }
      log(`waiting for funds at ${address}: has ${formatUnits(tac, 18)} TAC and ${formatEther(eth)} ETH, needs ${formatUnits(needTac, 18)} TAC and ${formatEther(MIN_ETH)} ETH. Send them from anywhere (out of a private balance, nothing links it to you); tacit.finance/to/${address}/${formatUnits(needTac, 18)} is a pay link for the TAC.`);
      await sleep(30_000);
    }
  }

  // the relay
  const seed = opt('seed') === 'none' ? null : (opt('seed') || `${ROUTE.keeper}/1/evm-pool/keeper`);
  let reset = staleStore(join(dir, 'keeper-1.db'));
  const envNow = () => ({ ...process.env, ...relayEnv({ defaults: loadDefaults(), key, gateway, port, dir, seed, reset }) });
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
  const wallet = createWalletClient({ account, chain: mainnet, transport: http(loadDefaults().EVM_POOL_RPC_URL_1) });
  async function sync(target) {
    const entries = await readRegistry({ call: (to, data) => client.call({ to, data }).then((r) => r.data), chainId: 1 });
    const listed = entries.find((e) => e.relayer.toLowerCase() === address.toLowerCase()) ?? null;
    const action = urlAction({ listed, url: target });
    if (action === 'ok') return log(`listed at ${target}`);
    if (action === 'register') {
      log('listing the relay (one transaction)…');
      const r = spawnSync(process.execPath, [join(HERE, 'register-relay.mjs'), '--url', target, '--owner', owner, '--send'], { env: { ...process.env, RELAY_KEY: key }, encoding: 'utf8' });
      log((r.stdout + r.stderr).trim().split('\n').slice(-3).join(' | '));
      if (r.status !== 0) throw new Error('listing did not go through: see above');
    } else {
      log(`the address changed: ${listed.url} → ${target}`);
      const id = await client.readContract({ address: RELAY_REGISTRY, abi: REG, functionName: 'idOf', args: [keccak256(encodeAbiParameters([{ type: 'uint64' }, { type: 'address' }], [1n, address]))] });
      const hash = await wallet.writeContract({ address: RELAY_REGISTRY, abi: REG, functionName: 'setUrl', args: [id, target], maxFeePerGas: parseGwei('5'), maxPriorityFeePerGas: parseGwei('0.1') });
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
