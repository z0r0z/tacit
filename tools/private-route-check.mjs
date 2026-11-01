// Checks a private route that has been set up, from outside, before a page is pointed at it (docs/EVM-POOL.md "Private route"):
//   node tools/private-route-check.mjs --service https://tacit-evm-pool-keepers.onrender.com --gateway <33-byte public key, hex> \
//        --forwarder https://fwd-a.example [--forwarder https://fwd-b.example] [--id k] [--origin https://tacit.finance]
// For the service: that a pool's /info names the key the page will pin. For each forwarder: that it answers /health, allows a page's origin to
// call it, carries a burst of reads for several pools as one sealed envelope and gives the same answers as the service does directly, refuses
// a path that is not a relay's inside the envelope, and how long a round trip takes against a direct one. Exits 1 if anything fails.
// It makes only reads and one refused write; it sends nothing a wallet's key or funds could be read from.
import { makeSealedFetch } from '../dapp/sealed-request.js';

const args = process.argv.slice(2), opt = (k) => { const out = []; args.forEach((a, i) => { if (a === `--${k}`) out.push(args[i + 1]); }); return out; };
const service = (opt('service')[0] || '').replace(/\/+$/, ''), gateway = (opt('gateway')[0] || '').replace(/^0x/, ''), forwarders = opt('forwarder').map((f) => f.replace(/\/+$/, ''));
const id = opt('id')[0] || 'k', origin = opt('origin')[0] || 'https://tacit.finance', pools = (opt('pools')[0] || '1,8453').split(',');
if (!service || !/^0[23][0-9a-f]{64}$/i.test(gateway) || !forwarders.length) {
  console.error('usage: node tools/private-route-check.mjs --service <https://…> --gateway <33-byte key, hex> --forwarder <https://…> [--forwarder …] [--id k] [--origin https://tacit.finance] [--pools 1,8453]');
  process.exit(2);
}

let failed = 0;
const ok = (m) => console.log(`  ok    ${m}`), bad = (m) => { failed++; console.log(`  FAIL  ${m}`); };
const check = (cond, pass, fail) => (cond ? ok(pass) : bad(fail));
const ms = async (fn) => { const t = performance.now(); const v = await fn(); return [v, Math.round(performance.now() - t)]; };
const json = async (r) => { try { return await r.json(); } catch { return null; } };

console.log(`the service ${service}`);
const info = {};
for (const p of pools) {
  const r = await fetch(`${service}/${p}/evm-pool/keeper/info`).catch(() => null);
  const j = r?.ok ? await json(r) : null;
  info[p] = j;
  if (!j) { bad(`pool ${p}: /info did not answer${r ? ` (${r.status})` : ''}`); continue; }
  if (!j.sealed) bad(`pool ${p}: the private route is off (no gateway key set, or the service has not been deployed with it)`);
  else check(j.sealed.key.toLowerCase() === gateway.toLowerCase(), `pool ${p}: the key it holds is the key the page will pin (id ${j.sealed.kid})`, `pool ${p}: it holds ${j.sealed.key}, not ${gateway}`);
}

for (const fw of forwarders) {
  console.log(`\nthe forwarder ${fw}`);
  const h = await fetch(`${fw}/health`).catch(() => null);
  check(h?.ok && (await json(h))?.ok === true, '/health answers', `/health did not answer${h ? ` (${h.status})` : ''}`);
  const pre = await fetch(`${fw}/f/${id}`, { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' } }).catch(() => null);
  const allow = pre?.headers.get('access-control-allow-origin');
  check(pre && pre.status < 300 && (allow === '*' || allow === origin), `a page at ${origin} may call it (preflight ${pre?.status}, allow-origin ${allow})`, `a page at ${origin} may not call it (preflight ${pre?.status}, allow-origin ${allow})`);

  const sf = makeSealedFetch({ keeper: service, chainId: id, gateway, forwarders: [fw], batchMs: 50 });
  const paths = pools.flatMap((p) => [`/${p}/evm-pool/keeper/info`, `/${p}/evm-pool/keeper/head`, `/${p}/evm-pool/keeper/quote`]);
  const [sealed, tSealed] = await ms(() => Promise.allSettled(paths.map((p) => sf(`${service}${p}`).then(async (r) => [r.status, await json(r)]))));
  const failedReads = sealed.map((r, i) => [r, paths[i]]).filter(([r]) => r.status !== 'fulfilled' || r.value[0] !== 200);
  check(!failedReads.length, `${paths.length} reads for ${pools.length} pools came back sealed in ${tSealed} ms`,
    `reads failed: ${failedReads.map(([r, p]) => `${p} ${r.status === 'fulfilled' ? r.value[0] : r.reason?.message}`).join('; ')}`);
  for (const [i, p] of paths.entries()) {
    if (!/\/info$/.test(p) || sealed[i].status !== 'fulfilled' || !info[pools[Math.floor(i / 3)]]) continue;
    const a = sealed[i].value[1], b = info[pools[Math.floor(i / 3)]];
    check(a && a.pool === b.pool && a.sealed?.key === b.sealed?.key, `${p} through the route is the answer the service gives directly`, `${p} through the route differs from the direct answer`);
  }
  const [direct, tDirect] = await ms(() => fetch(`${service}/${pools[0]}/evm-pool/keeper/head`).then((r) => r.arrayBuffer()).catch((e) => e));
  const [one, tOne] = await ms(() => sf(`${service}/${pools[0]}/evm-pool/keeper/head`).then((r) => r.arrayBuffer()).catch((e) => e));
  if (one instanceof Error) bad(`one read through it failed: ${one.message}`);
  else ok(`one read: ${tOne} ms through it, ${direct instanceof Error ? 'the service did not answer directly' : `${tDirect} ms directly`}`);
  const refused = await sf(`${service}/${pools[0]}/evm-pool/keeper/reserve`, { method: 'POST', body: '{}' }).then((r) => r.status).catch((e) => e.message);
  check(refused === 403, 'a reserve is refused inside the envelope, as the route does not carry it', `a reserve got ${refused}, not 403`);
  const health = await sf(`${service}/health`).then((r) => r.status).catch((e) => e.message);
  check(health === 403, 'a path that is not a relay\'s is refused inside the envelope', `/health got ${health}, not 403`);
}
console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
