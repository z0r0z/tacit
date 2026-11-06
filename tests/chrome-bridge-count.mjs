// The header's bridge count (dapp/chrome.js) says a bridge waits on its holder exactly when /bridge/track.js does (inDue, outDue): one case for each stage
// and each way a stage can differ (an error, three or six, a relay wait, a day's limit, a fee wait, a plan that sends the burn, an armed mint, a miner kept
// waiting), read in a page against the bridge page's own rows. The menu's dot and tag then follow a moved note that waits for its burn.
//   node tests/chrome-bridge-count.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { chromium } from 'playwright-core';

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(here, '..', 'dapp', p), 'utf8');
let fails = 0;
const ok = (c, m) => { console.log(`${c ? 'ok' : 'FAIL'} - ${m}`); if (!c) fails++; };

const PUB = '02' + 'ab'.repeat(32), TAC = 'f0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b', TETH = '3cba71e1114af183cdeacc6b8457a474d17529fd28704480ca799d0d03126f34';
const IN_KEY = 'tacit-burndep-bridge-v1:mainnet:' + PUB, OUT_KEY = 'tacit-crossout-bridge-v1:mainnet:' + PUB, PLAN_KEY = 'tacit-lite-bridge-plan-v1';
const inRec = (o) => ({ id: 'aa'.repeat(32) + ':0', network: 'mainnet', walletPub: PUB, path: 'deposit', stage: 'traced', createdAt: 1, source: { txid: 'aa'.repeat(32), vout: 0, assetId: TAC, ticker: 'TAC', amount: { __big: '4900000000' } }, ...o });
const outRec = (o) => ({ id: '0x' + 'dd'.repeat(32), network: 'mainnet', walletPub: PUB, stage: 'settled', createdAt: 1, source: { amount: '150000000', assetId: '0x' + TETH, ticker: 'tETH' }, settle: { txHash: 'ee'.repeat(32), claimIdVerified: true }, ...o });

// Each stage a bridge in has, with the ways a record of it can differ; each plan state of the front page (none, or one that sends the burn).
const IN_STAGES = ['rburn-signed', 'rburn-sent', 'rburn-mined', 'rfolded', 'migrate-signed', 'migrate-sent', 'migrate-confirmed', 'traced', 'burn-signed', 'burn-submitted', 'burn-mined',
  'registered', 'folded', 'stopped', 'not-recorded', 'recovering', 'recovered', 'reclaim-sent', 'reclaimed', 'minted'];
const err = (extra = {}) => ({ lastError: { message: 'x', at: 1, ...extra }, errorCount: 1 });
const IN_VARIANTS = [
  {}, err(), { ...err(), errorCount: 2 }, { ...err(), errorCount: 3 }, { ...err(), errorCount: 3, feeWait: { rate: 5, max: 3 } }, err({ relay: true }), err({ until: 'DAY' }), err({ until: 1 }),
  { checkWait: { at: 1, go: true } }, { checkWait: { at: 1, go: false } }, { ...err(), checkWait: { at: 1, go: true } }, { feeWait: { rate: 5, max: 3 } },
  { arm: { ok: true } }, { arm: { ok: false } }, { submittedAt: 'OLD' }, { submittedAt: 'FRESH' }, { updatedAt: 'OLD' },
  { path: 'reflected' }, { path: 'reflected', source: { assetId: TAC, ticker: 'TAC', p2tr: true } }, { path: 'reflected', source: { assetId: '0x' + TETH, ticker: 'tETH' } },
  { path: 'reflected', source: { assetId: '0x' + TAC } },
];
const OUT_STAGES = ['settling', 'settled', 'covered', 'mint-signed', 'mint-submitted', 'mint-confirmed', 'mint-rejected', 'minted'];
const OUT_VARIANTS = [
  {}, err(), { ...err(), errorCount: 5 }, { ...err(), errorCount: 6 }, { ...err(), errorCount: 6, feeWait: { rate: 5, max: 3 } }, err({ fundWait: true }),
  { settle: { claimIdVerified: false } }, { settle: { claimIdVerified: true } }, { attempts: [1, 2] }, { attempts: [1] },
];
const cases = [];
for (const stage of IN_STAGES) for (const v of IN_VARIANTS) for (const plan of [null, { burn: { maxRate: 10 } }]) cases.push({ dir: 'in', rec: inRec({ ...v, stage }), plan });
for (const stage of OUT_STAGES) for (const v of OUT_VARIANTS) cases.push({ dir: 'out', rec: outRec({ ...v, stage }), plan: null });

const html = '<!doctype html><html><head><meta charset="utf-8"></head><body><nav class="sn"><details class="sm"><summary aria-label="More pages">Menu</summary><div class="sm-p"><a href="/bridge/">Bridges</a></div></details></nav></body></html>';
const browser = await chromium.launch();
try {
  const page = await (await browser.newContext()).newPage();
  await page.route('https://count.test/**', (route) => {
    const p = new URL(route.request().url()).pathname;
    if (p === '/chrome.js' || p === '/bridge/track.js') return route.fulfill({ status: 200, contentType: 'text/javascript', body: read(p.slice(1)) });
    return route.fulfill({ status: 200, contentType: 'text/html', body: html });
  });
  await page.goto('https://count.test/');
  await page.addScriptTag({ url: '/chrome.js' });
  await page.waitForFunction(() => typeof window.tacitBridges === 'function');

  const out = await page.evaluate(async ({ cases, keys }) => {
    const T = await import('/bridge/track.js');
    const now = Date.now(), at = (v) => (v === 'OLD' ? now - 13 * 3600e3 : v === 'FRESH' ? now - 3600e3 : v === 'DAY' ? now + 3600e3 : v);
    const fix = (o) => JSON.parse(JSON.stringify(o), (k, v) => (k === 'submittedAt' || k === 'updatedAt' || k === 'until' ? at(v) : v));
    const bad = [];
    let needed = 0, quiet = 0;
    for (const c of cases) {
      localStorage.clear();
      localStorage.setItem(c.dir === 'in' ? keys.in : keys.out, JSON.stringify([fix(c.rec)]));
      if (c.plan) localStorage.setItem(keys.plan, JSON.stringify({ [keys.pub]: { [c.rec.id]: c.plan } }));
      const rows = T.readBridges(localStorage, Date.now()).filter((r) => !r.done && !r.back);
      const want = { under: rows.length, needs: rows.filter((r) => r.due).length }, got = window.tacitBridges();
      if (want.needs) needed++; else quiet++;
      if (want.under !== got.under || want.needs !== got.needs) bad.push(`${c.dir} ${c.rec.stage} ${JSON.stringify({ ...c.rec, source: undefined, settle: c.rec.settle })} plan ${JSON.stringify(c.plan)}: the page says ${JSON.stringify(want)}, the header ${JSON.stringify(got)}`);
    }
    return { bad, needed, quiet };
  }, { cases, keys: { in: IN_KEY, out: OUT_KEY, plan: PLAN_KEY, pub: PUB } });
  ok(out.bad.length === 0, `the header and the bridge page agree on what waits for its holder in all ${cases.length} cases${out.bad.length ? `\n  ${out.bad.slice(0, 8).join('\n  ')}` : ''}`);
  ok(out.needed > 60 && out.quiet > 60, `the cases hold both answers (${out.needed} wait, ${out.quiet} do not)`);

  // The menu: a note moved to its burn address waits for its burn, and stops waiting once the front page's plan sends it.
  const menu = () => page.evaluate(() => {
    const s = document.querySelector('.sm summary'), t = document.querySelector('.sm-p a[href="/bridge/"]'), d = s.querySelector(':scope > .bd');
    return { dot: !!d && !d.hidden, label: s.getAttribute('aria-label'), tag: t?.lastElementChild && !t.lastElementChild.hidden ? t.lastElementChild.textContent : '' };
  });
  const seed = (rec, plan) => page.evaluate(([inKey, planKey, pub, r, p]) => {
    localStorage.clear();
    localStorage.setItem(inKey, JSON.stringify([r]));
    if (p) localStorage.setItem(planKey, JSON.stringify({ [pub]: { [r.id]: p } }));
    window.dispatchEvent(new StorageEvent('storage', { key: planKey }));
  }, [IN_KEY, PLAN_KEY, PUB, rec, plan]);
  await seed(inRec({ stage: 'traced' }), null);
  let m = await menu();
  ok(m.dot && m.tag === '1 needs you' && /1 bridge under way, 1 needs you/.test(m.label), `a moved note with no plan to send its burn calls for its holder (${JSON.stringify(m)})`);
  await seed(inRec({ stage: 'traced' }), { burn: { maxRate: 10 } });
  m = await menu();
  ok(m.dot && m.tag === '1 under way' && /1 bridge under way$/.test(m.label), `and is only under way once the plan sends the burn (${JSON.stringify(m)})`);
  await seed(inRec({ stage: 'stopped' }), null);
  m = await menu();
  ok(m.dot && m.tag === '1 needs you', `a bridge that paused before its burn calls for its holder (${JSON.stringify(m)})`);
  await seed(inRec({ stage: 'migrate-confirmed' }), null);
  m = await menu();
  ok(m.dot && m.tag === '1 under way', `a move that is being checked is under way (${JSON.stringify(m)})`);
} finally {
  await browser.close();
}
console.log(fails ? `${fails} FAILED` : 'all passed');
process.exit(fails ? 1 : 0);
