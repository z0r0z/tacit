// Static dev server for the V1 launch surface.
//
// launch-v1-mock/app.js imports `../dapp/*`, so the document and the engine modules have to be same-origin
// siblings — serving launch-v1-mock/ on its own leaves every import 404ing. This serves the repo root and
// maps / to the launch page.
//
// Binds loopback deliberately: passkeys (WebAuthn PRF) and injected wallets need a secure context, and
// http://localhost qualifies while http://<lan-ip> does not.
//
// It also reverse-proxies /confidential/* to the relay. getConfidentialDeployment() rewrites relayBase to the
// page origin on localhost (the production relay only allows the tacit.finance origin), so without this proxy
// every prove/settle would post to a 404 here.
//
//   node scripts/serve-launch-mock.mjs [--port 8787] [--network signet]
import { createServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = normalize(join(fileURLToPath(new URL('.', import.meta.url)), '..'));
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const PORT = Number(arg('port', 8787));
// The testnet deployment is keyed `signet` in confidential-deployments.js; accept the chain's own name too,
// since that is what anyone pointing a wallet at it will type.
const NET_ALIAS = { sepolia: 'signet', testnet: 'signet', signet: 'signet', mainnet: 'mainnet' };
const NETWORK = NET_ALIAS[String(arg('network', 'signet')).toLowerCase()] || 'signet';
const RELAY = 'https://api.tacit.finance';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
  '.zkey': 'application/octet-stream',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  let path = decodeURIComponent(url.pathname);

  // Relay passthrough — /confidential/submit and /confidential/status.
  if (path.startsWith('/confidential/')) {
    try {
      const body = req.method === 'GET' || req.method === 'HEAD' ? undefined
        : Buffer.concat(await collect(req));
      const up = await fetch(RELAY + path + url.search, {
        method: req.method,
        headers: { 'content-type': req.headers['content-type'] || 'application/json' },
        body,
      });
      const buf = Buffer.from(await up.arrayBuffer());
      res.writeHead(up.status, {
        'content-type': up.headers.get('content-type') || 'application/json',
        'cache-control': 'no-store',
      });
      return res.end(buf);
    } catch (e) {
      res.writeHead(502, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: 'relay proxy failed: ' + e.message }));
    }
  }
  if (path === '/') {
    // Carry the network choice into the page so a local session can't silently point at mainnet funds.
    res.writeHead(302, { location: `/launch-v1-mock/index.html?network=${encodeURIComponent(NETWORK)}` });
    return res.end();
  }

  // Contain the served tree to the repo — `..` in a request path must not escape ROOT.
  const abs = normalize(join(ROOT, path));
  if (!abs.startsWith(ROOT + sep)) { res.writeHead(403); return res.end('forbidden'); }

  let st;
  try { st = statSync(abs); } catch { res.writeHead(404); return res.end('not found'); }
  if (st.isDirectory()) { res.writeHead(404); return res.end('not found'); }

  res.writeHead(200, {
    'content-type': TYPES[extname(abs).toLowerCase()] || 'application/octet-stream',
    'content-length': st.size,
    // Never cache in dev — a stale module is the single most confusing failure mode here.
    'cache-control': 'no-store, must-revalidate',
  });
  createReadStream(abs).pipe(res);
}).listen(PORT, '127.0.0.1', () => {
  console.log(`Tacit V1 launch surface  →  http://localhost:${PORT}/   (network: ${NETWORK})`);
  console.log(`serving ${ROOT}`);
  console.log(`relay proxy   /confidential/*  →  ${RELAY}`);
  console.log(NETWORK === 'mainnet'
    ? '\n  ⚠  MAINNET — every confirmed action moves real funds.\n     Testnet:  node scripts/serve-launch-mock.mjs --network signet\n'
    : '\n  Testnet (signet deployment on Sepolia, chainId 11155111) — point your wallet at Sepolia.\n');
});

// Buffer a request body without pulling in a body-parser.
function collect(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(chunks));
    req.on('error', reject);
  });
}
