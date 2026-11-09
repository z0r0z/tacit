// The update line (dapp/chrome.js) and the flow picture's reads (dapp/weld/flow/viz.js), in a real browser with the clock moved on:
// a page says it was updated once its ETag changes, asks at most every ten minutes and never while hidden; the picture asks the
// explorer and the feed nothing while its page is hidden, and asks again when it is shown. Served from memory through routes.
//   node tests/chrome-update-line.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { chromium } from 'playwright-core';

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(here, '..', 'dapp', p), 'utf8');
let fails = 0;
const ok = (c, m) => { console.log(`${c ? 'ok' : 'FAIL'} - ${m}`); if (!c) fails++; };
// Hidden or shown, as a browser would say it, with the event a real switch sends.
const showAs = (page, hidden) => page.evaluate((h) => {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => h });
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (h ? 'hidden' : 'visible') });
  document.dispatchEvent(new Event('visibilitychange'));
}, hidden);

const browser = await chromium.launch();
try {
  {
    const page = await (await browser.newContext()).newPage();
    const html = '<!doctype html><html><head><meta charset="utf-8"><script>window.__tacitUpd = true;</script><script src="/chrome.js" defer></script></head><body><p>page</p></body></html>';
    let etag = 'W/"one"', heads = 0, gets = 0;
    await page.route('https://upd.test/**', (route) => {
      const req = route.request(), url = new URL(req.url());
      if (url.pathname === '/chrome.js') return route.fulfill({ status: 200, contentType: 'text/javascript', body: read('chrome.js') });
      if (req.method() === 'HEAD') { heads++; return route.fulfill({ status: 200, headers: { etag, 'content-type': 'text/html' }, body: '' }); }
      // only the page itself is a page load: its other files (the help launcher's module, for one) are not
      if (url.pathname !== '/bridge/') return route.fulfill({ status: 404, body: '' });
      gets++;
      return route.fulfill({ status: 200, headers: { etag, 'content-type': 'text/html' }, body: html });
    });
    await page.clock.install();
    await page.goto('https://upd.test/bridge/');
    await page.waitForFunction(() => document.readyState === 'complete');
    await page.clock.runFor(1000);
    const lines = () => page.locator('[role=status]').count();
    ok(heads === 1 && (await lines()) === 0, 'the page reads its own ETag once on load, and says nothing');
    etag = '"one"';
    await page.clock.runFor(11 * 60e3);
    ok(heads === 2 && (await lines()) === 0, 'ten minutes on, the same ETag (strong now, as a compressed answer carries it): still nothing');
    etag = 'W/"two"';
    await showAs(page, true);
    await page.clock.runFor(30 * 60e3);
    ok(heads === 2, 'a hidden page asks nothing');
    await showAs(page, false);
    await page.waitForFunction(() => document.querySelector('[role=status]'));
    ok(heads === 3 && (await lines()) === 1, 'shown again after a deploy, it looks once and shows the line');
    ok((await page.locator('[role=status]').innerText()).includes('This page has been updated.'), 'in its words');
    await page.clock.runFor(30 * 60e3);
    ok(heads === 3, 'once said, it asks no more');
    const before = gets;
    await page.locator('[role=status] button').click();
    await page.waitForFunction(() => document.readyState === 'complete');
    ok(gets === before + 1, 'Reload loads the page again');
  }
  {
    const page = await (await browser.newContext()).newPage();
    const html = '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="v" style="width:600px;height:300px"></div>'
      + '<script type="module">import { mountFlow } from "/viz.js"; window.flow = mountFlow(document.getElementById("v"), { api: "https://feed.test", tipUrl: "https://tip.test/height" });</script></body></html>';
    const asked = { feed: 0, tip: 0 };
    await page.route('https://viz.test/**', (route) => {
      const url = new URL(route.request().url());
      return route.fulfill(url.pathname === '/viz.js' ? { status: 200, contentType: 'text/javascript', body: read('weld/flow/viz.js') } : { status: 200, contentType: 'text/html', body: html });
    });
    await page.route('https://feed.test/**', (route) => { asked.feed++; return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ asOf: 1, windowSec: 86400, now: { btc: 970000 }, series: [], events: {} }) }); });
    await page.route('https://tip.test/**', (route) => { asked.tip++; return route.fulfill({ status: 200, contentType: 'text/plain', body: '970001' }); });
    await page.clock.install();
    await page.goto('https://viz.test/');
    await page.waitForFunction(() => window.flow);
    await page.clock.runFor(5000);
    ok(asked.feed === 1 && asked.tip === 1, 'the picture reads its feed and the tip when it is mounted');
    await showAs(page, true);
    const was = { ...asked };
    await page.clock.runFor(10 * 60e3);
    ok(asked.feed === was.feed && asked.tip === was.tip, 'and nothing at all while its page is hidden');
    await showAs(page, false);
    await page.waitForTimeout(100);
    ok(asked.feed === was.feed + 1 && asked.tip === was.tip + 1, 'shown again, each read runs at once');
  }
} finally {
  await browser.close();
}
console.log(fails ? `${fails} FAILED` : 'all passed');
process.exit(fails ? 1 : 0);
