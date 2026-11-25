// Serves dapp/ and the isolated stuck TAC review harness on this machine only (127.0.0.1), so a page can be opened from
// http://localhost before or without its live copy: `npm run serve`, then open /splitter/, /relay/ or /stuck-tac-review/.
// It is a plain static server: no proxy, no build, nothing written.
//
//   PORT=8787 node tools/serve-dapp.mjs

import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';

const DAPP = new URL('../dapp/', import.meta.url).pathname;
const STUCK_TAC_REVIEW = '/stuck-tac-review/';
const STUCK_TAC_HARNESS = new URL('../tests/stuck-tac-harness/', import.meta.url).pathname;
const PORT = Number(process.env.PORT || 8787);
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8',
};
const server = createServer((req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`);
  const review = u.pathname.startsWith(STUCK_TAC_REVIEW);
  const root = review ? STUCK_TAC_HARNESS : DAPP;
  const pathname = review ? u.pathname.slice(STUCK_TAC_REVIEW.length - 1) : u.pathname;
  let f = normalize(join(root, decodeURIComponent(pathname)));
  if (!f.startsWith(root)) { res.writeHead(403); return res.end('forbidden'); }
  if (existsSync(f) && statSync(f).isDirectory()) {
    if (!u.pathname.endsWith('/')) { res.writeHead(301, { location: `${u.pathname}/${u.search}` }); return res.end(); }
    f = join(f, 'index.html');
  }
  if (!existsSync(f)) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('not found'); }
  res.writeHead(200, { 'content-type': TYPES[extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' });
  res.end(readFileSync(f));
});
server.on('error', (e) => { console.error(e.code === 'EADDRINUSE' ? `port ${PORT} is already in use: set PORT=<another>` : e.message); process.exit(1); });
server.listen(PORT, '127.0.0.1', () => {
  console.log(`serving ${DAPP} on this machine only`);
  console.log(`  splitter  http://localhost:${PORT}/splitter/`);
  console.log(`  relay     http://localhost:${PORT}/relay/`);
  console.log(`  review    http://localhost:${PORT}/stuck-tac-review/`);
});
