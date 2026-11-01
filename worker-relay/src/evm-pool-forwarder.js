// Runs a forwarder for the private route (src/lib/evm-pool-forwarder.js): wallets send it sealed requests, it hands them to a keeper's
// /sealed and returns the sealed answers. It holds no key and keeps nothing.
//
// FORWARDER_GATEWAYS  JSON, { "<chainId>": "<the keeper's /sealed URL>" }, e.g. { "1": "https://…/1/evm-pool/keeper/sealed" }
// PORT                default 10000
// FORWARDER_RATE_PER_MIN  default 60 per caller address
// Disabled (exits 0) while FORWARDER_GATEWAYS is unset.

import { createServer } from 'node:http';
import { makeForwarder } from './lib/evm-pool-forwarder.js';

const log = (...a) => console.log(`[evm-pool-forwarder ${new Date().toISOString()}]`, ...a);

function gatewaysOf(raw) {
  let g;
  try { g = JSON.parse(raw); } catch { throw new Error('FORWARDER_GATEWAYS is not JSON'); }
  if (!g || typeof g !== 'object' || Array.isArray(g)) throw new Error('FORWARDER_GATEWAYS is an object of chain id → URL');
  for (const [id, url] of Object.entries(g)) {
    if (!/^\d+$/.test(id)) throw new Error(`FORWARDER_GATEWAYS: "${id}" is not a chain id`);
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
  createServer(makeForwarder({ gateways, ratePerMin })).listen(port, () => log(`listening on ${port}: chains ${Object.keys(gateways).join(', ')}`));
}

try { main(); } catch (e) { log('failed:', e.message); process.exit(1); }
