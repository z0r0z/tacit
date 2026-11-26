#!/usr/bin/env node
// The glyph field (dapp/glyphs.js) with the window zoomed out. A browser zoomed out has a device pixel ratio below 1, and the field was cleared in
// scaled space: only that fraction of the canvas, at the top left, was wiped each frame, and the glyphs on the rest piled up until it was ten to twenty
// times denser than the corner (a page looked half empty and half smeared). Here the same page is drawn at four ratios and every region of the canvas
// must be about as dense as every other.
//
//   node tests/glyph-field-zoom.test.mjs        (PLAYWRIGHT=<path to playwright-core>)
import { createRequire } from 'node:module';
import http from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT || 'playwright-core');
const DAPP = new URL('../dapp/', import.meta.url).pathname;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
const server = http.createServer((req, res) => {
  let f = join(DAPP, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (existsSync(f) && statSync(f).isDirectory()) f = join(f, 'index.html');
  if (!existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': TYPES[extname(f)] || 'application/octet-stream' });
  res.end(readFileSync(f));
}).listen(0);
await new Promise((r) => server.on('listening', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

let fails = 0;
const b = await chromium.launch();
// [css width, css height, device pixel ratio]: a retina window, a plain one, and the window zoomed out to 67% and 50%
for (const [vw, vh, dsf] of [[1470, 920, 2], [2940, 1840, 1], [4400, 2760, 0.67], [5880, 3680, 0.5]]) {
  const ctx = await b.newContext({ viewport: { width: vw, height: vh }, deviceScaleFactor: dsf, colorScheme: 'dark' });
  const page = await ctx.newPage();
  await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.abort());
  await page.goto(`${BASE}/praxis/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('canvas.gx-field', { timeout: 20000 });
  await page.waitForTimeout(5000);      // long enough for glyphs that are never wiped to pile up
  const m = await page.evaluate(() => {
    const c = document.querySelector('canvas.gx-field'), x = c.getContext('2d'), W = c.width, H = c.height;
    const mean = (x0, y0, w, h) => { const d = x.getImageData(Math.floor(x0), Math.floor(y0), Math.floor(w), Math.floor(h)).data; let s = 0; for (let i = 3; i < d.length; i += 4) s += d[i]; return s / (d.length / 4); };
    return [mean(0, H * 0.05, W * 0.15, H * 0.3), mean(0, H * 0.82, W * 0.15, H * 0.15), mean(W * 0.85, H * 0.05, W * 0.12, H * 0.3)];
  });
  const ratio = Math.max(...m) / Math.max(0.05, Math.min(...m));
  const good = ratio < 4;
  if (!good) fails++;
  console.log(`${good ? '  ok  ' : 'FAIL  '} ratio ${dsf}: the top left, bottom left and far right are as dense as each other (${m.map((v) => v.toFixed(2)).join(', ')}; ${ratio.toFixed(1)}x apart)`);
  await ctx.close();
}
await b.close();
server.close();
process.exit(fails ? 1 : 0);
