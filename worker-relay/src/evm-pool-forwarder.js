// Runs a forwarder for the private route (src/lib/evm-pool-forwarder.js): wallets send it sealed requests, it hands them to a keeper's
// /sealed and returns the sealed answers. It holds no key and keeps nothing.
//
// FORWARDER_GATEWAYS  JSON, { "<chainId>": "<the keeper's /sealed URL>" }, e.g. { "1": "https://…/1/evm-pool/keeper/sealed" }
// PORT                default 10000
// FORWARDER_RATE_PER_MIN  default 60 per caller address
// FORWARDER_RPC_URL   an Ethereum node: with it the forwarder also carries POST /r/<chainId>/<relayer> to the relays the relay registry lists (FORWARDER_REGISTRY
//                     names another registry); without it those routes answer 404
// Disabled (exits 0) while FORWARDER_GATEWAYS is unset.

import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { makeForwarder } from './lib/evm-pool-forwarder.js';
import { makeRegistryReader } from './lib/relay-registry-reader.js';
import { safeRequest } from './lib/safe-https.js';

const log = (...a) => console.log(`[evm-pool-forwarder ${new Date().toISOString()}]`, ...a);

export function gatewaysOf(raw) {
  let g;
  try { g = JSON.parse(raw); } catch { throw new Error('FORWARDER_GATEWAYS is not JSON'); }
  if (!g || typeof g !== 'object' || Array.isArray(g)) throw new Error('FORWARDER_GATEWAYS is an object of chain id → URL');
  for (const [id, url] of Object.entries(g)) {
    if (!/^[0-9A-Za-z_-]{1,40}$/.test(id)) throw new Error(`FORWARDER_GATEWAYS: "${id}" is not an id (a chain's "1", a pool's "1-xdac17f958d", or a service's "k")`);
    const u = new URL(url);
    if (u.protocol !== 'https:' && !/^(127\.0\.0\.1|localhost)$/.test(u.hostname)) throw new Error(`FORWARDER_GATEWAYS: the URL for ${id} must be https`);
  }
  return g;
}

function main() {
  if (!process.env.FORWARDER_GATEWAYS) { log('FORWARDER_GATEWAYS is not set: no forwarder to run'); return; }
  const gateways = gatewaysOf(process.env.FORWARDER_GATEWAYS);
  const port = Number(process.env.PORT || 10000);
  const ratePerMin = Number(process.env.FORWARDER_RATE_PER_MIN || 60);
  const reader = process.env.FORWARDER_RPC_URL ? makeRegistryReader({ rpcUrl: process.env.FORWARDER_RPC_URL, ...(process.env.FORWARDER_REGISTRY ? { registry: process.env.FORWARDER_REGISTRY } : {}) }) : null;
  const community = reader ? { find: reader.find, request: safeRequest } : null;
  createServer(makeForwarder({ gateways, ratePerMin, community })).listen(port, () => log(`listening on ${port}: chains ${Object.keys(gateways).join(', ')}${community ? '; relays the registry lists are carried too' : ''}`));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(); } catch (e) { log('failed:', e.message); process.exit(1); }
}
