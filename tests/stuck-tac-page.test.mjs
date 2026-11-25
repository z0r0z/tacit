import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASE_UNIT, runAllScenarios } from './stuck-tac-harness/scenarios.js';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT || 'playwright-core');
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HARNESS = join(ROOT, 'tests', 'stuck-tac-harness');
const FONTS = join(ROOT, 'dapp', 'fonts');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.woff2': 'font/woff2' };
const server = createServer((req, res) => {
  const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
  let root = null, relative = null;
  if (pathname === '/stuck-tac-review/') { root = HARNESS; relative = 'index.html'; }
  else if (pathname === '/stuck-tac-review/app.js' || pathname === '/stuck-tac-review/scenarios.js') { root = HARNESS; relative = pathname.split('/').pop(); }
  else if (/^\/fonts\/[a-z0-9-]+\.woff2$/.test(pathname)) { root = FONTS; relative = pathname.slice('/fonts/'.length); }
  if (!root) { res.writeHead(404); return res.end('not found'); }
  const file = normalize(join(root, relative));
  if (!file.startsWith(root) || !existsSync(file) || !statSync(file).isFile()) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
  res.end(readFileSync(file));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const origin = `http://127.0.0.1:${port}`;
const chrome = [process.env.CHROME, process.env.CHROME_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium'].find((path) => path && existsSync(path));
const browser = await chromium.launch({ headless: true, ...(chrome ? { executablePath: chrome } : {}), args: ['--no-sandbox'] });
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const errors = [];
const remoteRequests = [];
let context;

function expectedBatch(config) {
  const results = runAllScenarios(config);
  return {
    passed: results.reduce((total, result) => total + result.assertions.filter((assertion) => assertion.pass).length, 0),
    total: results.reduce((total, result) => total + result.assertions.length, 0),
  };
}

async function load(page) {
  await page.goto(`${origin}/stuck-tac-review/`, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
}

async function noOverflow(page, width) {
  await page.setViewportSize({ width, height: 900 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `horizontal overflow at ${width}px`);
}

test('initial page exposes gross accounting, exclusions, six exposure metrics and local fonts only', async (page) => {
  assert.equal(await page.locator('#scenario option').count(), 8);
  assert.equal(await page.locator('.metric').count(), 6);
  assert.equal(await page.locator('.clock-register > div').count(), 6);
  assert.equal(await page.locator('.exclusion-register > div').count(), 3);
  assert.equal(await page.locator('body').textContent().then((text) => /lendable/i.test(text)), false);
  assert.match(await page.locator('.balance-baseline').textContent(), /Baseline gross private Ethereum TAC/);
  assert.match(await page.locator('.balance-rebalanced').textContent(), /Rebalanced gross private Ethereum TAC/);
  assert.match(await page.locator('.exclusion-register').textContent(), /Pool note-cut fees \+ reserves/);
  assert.match(await page.locator('.exclusion-register').textContent(), /Actual quotable capacity/);
  assert.match(await page.locator('.method-note').textContent(), /not production state-machine evidence/);
  assert.equal(await page.evaluate(() => document.fonts.check('12px "IBM Plex Mono Local"')), true);
  assert.equal(await page.evaluate(() => document.fonts.check('32px "Instrument Serif Local"')), true);
  assert.equal(await page.locator('#assertions-body .fail').count(), 0);
});

test('Run all and B-06 show sale-aware funding, timed gate, completion and refund evidence', async (page) => {
  const expected = expectedBatch({});
  await page.locator('#run-all').click();
  assert.equal(await page.locator('#run-all-body tr').count(), 8);
  assert.equal(await page.locator('#run-all-body .table-fail').count(), 0);
  assert.equal(await page.locator('#run-all-count').textContent(), `${expected.passed} / ${expected.total} checks passing`);
  await page.locator('#scenario').selectOption('stalled-recovery');
  assert.equal(await page.locator('#result-title').textContent(), 'Sale-aware stall / intake gate');
  assert.equal(await page.locator('#last-sale').textContent(), 't=180s');
  assert.equal(await page.locator('#last-refund').textContent(), 't=300s');
  assert.equal(await page.locator('#assertions-body .fail').count(), 0);
  const ledger = await page.locator('#events-body').textContent();
  assert.match(ledger, /Funding move selected · daily cap charged/);
  assert.match(ledger, /Forward intake gate opened · no completed sale/);
  assert.match(ledger, /Reverse sale completed · exact E received/);
  assert.match(ledger, /Reverse sale refunded · exposure remains/);
  assert.doesNotMatch(ledger, /three polls|poll 1|poll 2|poll 3/i);
});

test('N=100 runs every scenario and the published long-history balance is literal in the UI', async (page) => {
  await page.locator('#bridge-count').fill('100');
  const config = { bridgeCount: 100 };
  const expected = expectedBatch(config);
  await page.locator('#run-all').click();
  assert.equal(await page.locator('#form-error').isVisible(), false);
  assert.equal(await page.locator('#run-all-body tr').count(), 8);
  assert.equal(await page.locator('#run-all-body .table-fail').count(), 0);
  assert.equal(await page.locator('#run-all-count').textContent(), `${expected.passed} / ${expected.total} checks passing`);
  await page.locator('#scenario').selectOption('long-history');
  await page.locator('#starting-inventory').fill('10000');
  await page.locator('#daily-cap').fill('10000');
  await page.locator('#stuck-ceiling').fill('10000');
  await page.locator('#run-scenario').click();
  assert.match(await page.locator('#run-context').textContent(), /100 \/ 100 forwards completed/);
  assert.equal(await page.locator('#baseline-gross').textContent(), '40.00');
  assert.equal(await page.locator('#rebalanced-gross').textContent(), '10,080.120361');
  assert.equal(await page.locator('#assertions-body .fail').count(), 0);
});

test('keyboard focus and N/floor validation remain accessible', async (page) => {
  await page.locator('#run-scenario').focus();
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'run-all');
  assert.equal(await page.locator('#run-all').evaluate((node) => getComputedStyle(node).outlineWidth), '2px');
  await page.locator('#bridge-count').fill('101');
  await page.locator('#run-scenario').click();
  assert.equal(await page.locator('#form-error').isVisible(), true);
  assert.equal(await page.locator('#bridge-count').getAttribute('aria-invalid'), 'true');
  await page.locator('#bridge-count').fill('12');
  await page.locator('#recovery-floor').fill('99');
  await page.locator('#run-scenario').click();
  assert.equal(await page.locator('#form-error').isVisible(), true);
  assert.equal(await page.locator('#recovery-floor').getAttribute('aria-invalid'), 'true');
  await page.locator('#recovery-floor').fill('100');
  await page.locator('#run-scenario').click();
  assert.equal(await page.locator('#form-error').isVisible(), false);
});

test('mobile layouts and the batch register do not overflow the page', async (page) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  for (const width of [320, 375, 680, 1024, 1440]) await noOverflow(page, width);
  await page.setViewportSize({ width: 320, height: 900 });
  await page.locator('#bridge-count').fill('100');
  await page.locator('#run-all').click();
  assert.equal(await page.locator('#run-all-body tr').count(), 8);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.locator('#reset').click();
  assert.equal(await page.locator('#bridge-count').inputValue(), '12');
  assert.equal(await page.locator('#run-all-board').isVisible(), false);
});

let browserFailed = false;
try {
  context = await browser.newContext();
  await context.route('**/*', (route) => {
    const url = route.request().url();
    if (/^https?:/.test(url) && !url.startsWith(`${origin}/`)) {
      remoteRequests.push(url);
      return route.abort();
    }
    return route.continue();
  });
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  let passed = 0;
  for (const [name, fn] of tests) {
    try {
      await load(page);
      await fn(page);
      passed += 1;
      console.log(`  ok - ${name}`);
    } catch (error) {
      console.log(`  FAIL - ${name}\n${error.stack}`);
      process.exitCode = 1;
    }
  }
  assert.deepEqual(remoteRequests, [], 'a browser request attempted to leave the loopback origin');
  assert.deepEqual(errors, [], 'the page emitted browser errors');
  console.log(`\n${passed}/${tests.length} stuck TAC page suites passed; no remote requests or page errors`);
} catch (error) {
  browserFailed = true;
  console.error(error.stack);
  process.exitCode = 1;
} finally {
  if (context) await context.close();
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}

process.exit(process.exitCode || (browserFailed ? 1 : 0));
