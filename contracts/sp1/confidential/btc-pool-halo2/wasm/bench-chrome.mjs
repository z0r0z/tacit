// Headless Chrome benchmark: node wasm/bench-chrome.mjs [threads|single] [runs] [threads]
// Serves the crate with COOP/COEP (SharedArrayBuffer) and collects results posted by wasm/web/bench.html.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [mode = 'threads', runs = '3', threads = '0'] = process.argv.slice(2);
const chrome = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const types = { '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm', '.bin': 'application/octet-stream' };

let chromeProc;
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'POST' && url.pathname === '/log') {
    let body = '';
    for await (const c of req) body += c;
    res.end();
    const msg = JSON.parse(body);
    console.log(msg.line);
    if (msg.done) { chromeProc.kill(); server.close(); process.exitCode = msg.error ? 1 : 0; }
    return;
  }
  try {
    // workerHelpers.js imports the package directory ('../../..'); a bundler maps it to the entry module.
    let file = path.join(root, decodeURIComponent(url.pathname));
    if (url.pathname.endsWith('/')) file = path.join(file, 'btc_pool_halo2.js');
    if (!file.startsWith(root)) throw new Error('path');
    const data = await readFile(file);
    res.writeHead(200, {
      'Content-Type': types[path.extname(file)] || 'application/octet-stream',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    });
    res.end(data);
  } catch {
    res.writeHead(404); res.end();
  }
});
server.listen(0, '127.0.0.1', () => {
  const { port } = server.address();
  const page = `http://127.0.0.1:${port}/wasm/web/bench.html?mode=${mode}&runs=${runs}&threads=${threads}`;
  chromeProc = spawn(chrome, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'btcpool-chrome-'))}`, '--enable-logging=stderr', '--v=0', page], { stdio: ['ignore', 'ignore', 'pipe'] });
  chromeProc.stderr.on('data', (d) => { for (const l of String(d).split('\n')) if (process.env.CHROME_LOG && l.includes('CONSOLE')) console.error(l); });
});
setTimeout(() => { console.error('timeout'); chromeProc?.kill(); process.exit(2); }, Number(process.env.TIMEOUT_S || 900) * 1000).unref();
