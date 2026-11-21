#!/usr/bin/env node
// Checks a Pay relay from the outside, the way a wallet would reach it: does it quote with an address, does it show a private route key signed for by that address,
// does the relay registry list it, and does a sealed quote come back through Tacit's forwarders. The checks an operator runs after starting a relay and listing it.
//   node tools/relay-check.mjs https://relay.example/1/evm-pool/keeper
//   node tools/community-runner.mjs relay-check https://relay.example/1/evm-pool/keeper      (the same, as a mode of the community runner)
// Exits 0 when every step passes, 1 when one does not.

import { pathToFileURL } from 'node:url';
import { verifyDoc } from '../dapp/relay-gateway-doc.js';
import { makeSealedFetch } from '../dapp/sealed-request.js';
import { makeCommunityRoute } from '../dapp/route-community.js';
import { readRegistry, RELAY_REGISTRY } from '../dapp/evm-pool-open-relays.js';

const eq = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

// → [{ name, ok, detail }] in order; a step that needs an earlier one that failed says so
export async function checkRelay({ url, fetchImpl = globalThis.fetch.bind(globalThis), call, forwarders, registry = RELAY_REGISTRY }) {
  const steps = [];
  const step = async (name, fn) => {
    try { steps.push({ name, ok: true, detail: await fn() }); return true; } catch (e) { steps.push({ name, ok: false, detail: e.message }); return false; }
  };
  const base = String(url).replace(/\/+$/, ''), origin = new URL(base).origin;
  const json = async (u) => { const r = await fetchImpl(u, { signal: AbortSignal.timeout?.(15_000) }); if (!r.ok) throw new Error(`${u} answered ${r.status}`); return r.json(); };
  let quote = null, gateway = null, listed = null;

  await step('the relay quotes with an address', async () => {
    quote = await json(`${base}/quote`);
    if (!/^0x[0-9a-fA-F]{40}$/.test(String(quote?.relayer))) { quote = null; throw new Error('its quote names no relayer address'); }
    return `chain ${quote.chainId}, relayer ${quote.relayer}, fee ${quote.fee} wei`;
  });
  await step('it shows a private route key signed for by that address', async () => {
    if (!quote) throw new Error('needs a quote that names its address');
    const { docs } = await json(`${origin}/sealed/key`);
    gateway = (Array.isArray(docs) ? docs : []).map((d) => verifyDoc(d, quote.relayer)).find(Boolean) ?? null;
    if (!gateway) throw new Error(`${origin}/sealed/key shows no key signed for by ${quote.relayer}: start the relay with EVM_POOL_KEEPER_GATEWAY_KEY (docs/RUN-A-PAY-RELAY.md)`);
    return `key ${gateway.slice(0, 12)}…`;
  });
  await step('the relay registry lists it', async () => {
    if (!quote) throw new Error('needs a quote that names its address');
    const entries = await readRegistry({ call, chainId: Number(quote.chainId), registry });
    listed = entries.find((e) => eq(e.relayer, quote.relayer)) ?? null;
    if (!listed) throw new Error(`no relay with address ${quote.relayer} is listed for chain ${quote.chainId} (or its stake is under the minimum, or it is leaving): list it with worker-relay/scripts/register-relay.mjs`);
    if (listed.url.replace(/\/+$/, '').toLowerCase() !== base.toLowerCase()) throw new Error(`it is listed at ${listed.url}, not here: the owner can change it with setUrl`);
    return `listed with ${listed.stake / 10n ** 18n} TAC at ${listed.url}`;
  });
  await step('a sealed quote comes back through the private route', async () => {
    if (!gateway || !listed) throw new Error('needs the key and the listing above');
    const route = makeCommunityRoute({ relays: [{ chainId: Number(quote.chainId), url: base, relayer: quote.relayer }], makeSealedFetch, forwarders, fetchImpl });
    const r = await route.fetch(`${base}/quote`);
    const body = await r.json();
    if (r.status !== 200 || !eq(body.relayer, quote.relayer)) throw new Error(`the sealed quote answered ${r.status}${body.relayer ? ` naming ${body.relayer}` : ''}`);
    return `answered 200 through a forwarder, naming ${body.relayer}`;
  });
  return steps;
}

export async function main(argv = process.argv.slice(2)) {
  const url = argv.find((a) => /^https?:\/\//.test(a));
  if (!url) { console.error('usage: node tools/relay-check.mjs https://relay.example/1/evm-pool/keeper'); return 2; }
  const { ROUTE } = await import('../dapp/private-route.js');
  const rpcUrl = process.env.RPC_URL || 'https://ethereum-rpc.publicnode.com';
  const call = async (to, data) => {
    const r = await (await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] }), signal: AbortSignal.timeout(15_000) })).json();
    if (r.error) throw new Error(r.error.message);
    return r.result;
  };
  const steps = await checkRelay({ url, call, forwarders: ROUTE.forwarders });
  for (const s of steps) console.log(`${s.ok ? 'ok  ' : 'FAIL'}  ${s.name}: ${s.detail}`);
  const bad = steps.filter((s) => !s.ok).length;
  console.log(bad ? `\n${bad} of ${steps.length} checks failed: wallets cannot use this relay yet.` : '\nall checks passed: wallets can reach this relay through the private route.');
  return bad ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().then((c) => process.exit(c), (e) => { console.error(e.message); process.exit(1); });
