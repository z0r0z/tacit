// The proving page (dapp/prove/) in a real browser under its content-security policy, with the computer's tacit-prover and the pool and
// points services stood in by routes: nothing set up (the setup line, with the address), an older prover (the setup line again), paused,
// started from the button (the POST it sends), proving with a bar and the time left, paused mid-proof, a Windows PC, and a phone.
//   PLAYWRIGHT=<path to playwright-core> node tests/prove-page.mjs        (Node 22; SHOTS=<dir> saves screenshots)

import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { extname, join, normalize } from 'node:path';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require(process.env.PLAYWRIGHT || '/Users/z/zFi/node_modules/playwright-core')); } catch { console.log('skip - needs playwright-core (PLAYWRIGHT=<path>)'); process.exit(0); }
const DAPP = new URL('../dapp/', import.meta.url).pathname;
const SHOTS = process.env.SHOTS || null;
const TYPES = { '.js': 'text/javascript', '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };

const server = createServer((req, res) => {
  let p = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (p.endsWith('/')) p += 'index.html';
  const f = join(DAPP, p);
  if (!f.startsWith(DAPP) || !existsSync(f) || !statSync(f).isFile()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': TYPES[extname(f)] || 'application/octet-stream' });
  res.end(readFileSync(f));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const ORIGIN = `http://localhost:${server.address().port}`;

const ADDR = '0x66f5a1225e6ac772c461f2b4d8028bf9568f3db5';
const day = Math.floor(Date.now() / 86400000);
const OTHER = '0x' + 'ab'.repeat(20);
const blk = (height, o = {}) => ({ height, hash: '0x' + height.toString(16).padStart(64, '0'), prev: '0x' + (height - 1).toString(16).padStart(64, '0'), ethBlock: 26349000 + height, tx: '0x' + 'cd'.repeat(32), notes: 1, spent: 1, deposits: 0, ...o });
const chain = { blocks: [blk(9389), blk(9388, { notes: 2, spent: 0, deposits: 1, prover: ADDR, points: 20 }), blk(9387, { prover: OTHER, points: 20 }), blk(9386, { house: true })] };
let fails = 0;
const check = (ok, what, got = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${ok ? '' : ` (${got})`}`); if (!ok) fails++; };

// The stand-in prover: `local` is what it answers (null: nothing listens), and each POST /mine it was sent.
const WINDOWS_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
async function open(browser, local, { phone = false, idle = false, ua = null, hash = '' } = {}) {
  const ctx = await browser.newContext(phone ? { viewport: { width: 390, height: 800 }, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148' } : { viewport: { width: 1100, height: 900 }, ...(ua ? { userAgent: ua } : {}) });
  const page = await ctx.newPage();
  const errors = [], posts = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // a public Nostr relay that is down (the Relay tab reads several) is the outside world, not the page
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|ERR_|WebSocket connection to 'wss:\/\//.test(m.text())) errors.push(m.text()); });
  const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
  await page.route('http://127.0.0.1:47815/**', async (route) => {
    const req = route.request(), path = new URL(req.url()).pathname;
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST', 'access-control-allow-headers': 'content-type' } });
    if (!local.v) return route.abort('connectionrefused');
    if (path === '/health') return json(route, { ok: true, vkey: '0x00', busy: !!local.v.mine?.job });
    if (path === '/mine' && req.method() === 'GET') return local.v.mine ? json(route, local.v.mine) : json(route, { error: 'not found' }, 404);
    if (path === '/mine' && req.method() === 'POST') {
      const b = JSON.parse(req.postData() || '{}');
      posts.push(b);
      local.v.mine = { ...local.v.mine, on: b.on, miner: b.miner || local.v.mine.miner };
      return json(route, local.v.mine);
    }
    return json(route, { error: 'not found' }, 404);
  });
  await page.route('https://api.tacit.finance/**', (route) => {
    const u = new URL(route.request().url());
    if (u.pathname === '/prover/pool') return json(route, { ...(idle ? {} : {}), queued: idle ? 0 : 3, leased: idle ? 0 : 2, doneToday: 41, minersToday: 2, done24h: 433, miners24h: 11, top: [{ miner: ADDR, proofs: 4 }, { miner: OTHER, proofs: 1 }], terms: { pointsPerProof: 20, proofsPerMinerDay: 30 } });
    if (u.pathname === '/prover/blocks') return json(route, { head: { height: chain.blocks[0].height, hash: chain.blocks[0].hash, ethHead: chain.blocks[0].ethBlock + 25 }, blocks: chain.blocks, cross: [{ digest: '0x' + '89'.repeat(32), bitcoin: 974721, ethereum: { digest: '0x' + '54'.repeat(32), slot: 15592000 }, tx: '0x' + 'ab'.repeat(32), ethBlock: chain.blocks[0].ethBlock, at: Date.now(), by: { miner: OTHER } }] });
    if (u.pathname === '/prover/board') return json(route, { queued: 0, workers: [{ name: `c-${ADDR}`, community: true, programs: ['btc-state'], proved: 3, lastSeenSeconds: 4, racing: null }, { name: `c-${OTHER}`, community: true, programs: ['btc-state'], proved: 1, lastSeenSeconds: 2400, racing: 'btc-state' }, { name: 'c-0x' + 'cd'.repeat(20), community: true, programs: ['btc-state'], proved: 0, lastSeenSeconds: 90000, racing: null }, { name: 'c-0x' + 'ef'.repeat(20), community: true, programs: ['confidential'], proved: 5, lastSeenSeconds: 2 }, { name: 'tacit-a5000', programs: ['confidential', 'eth-state'], proved: 9, lastSeenSeconds: 0 }], pay: { pointsPerProof: 20, pointsByProgram: { 'btc-state': 1000 } } });
    if (u.pathname === '/prover/pool/recent') return json(route, { proofs: [{ at: Date.now() - 60_000, house: true, points: 0, secs: 31 }, { at: Date.now() - 120_000, miner: ADDR, points: 20, secs: 552 }] });
    if (u.pathname === '/prover/pool/credits') return json(route, { day, over: false, miners: [{ miner: ADDR, proofs: 4, points: 80 }] });
    if (u.pathname === '/pool/snapshot') return json(route, { v: 1, cid: 'bafkreia4g6iad4ec3634pd5lsfcqsmenqcc5oyn3mm2kwezybpwv6iltom', to: 26352486, checkpoint: { eth: { block: 26352486, hash: '0x' + 'e9'.repeat(32) }, tacit: { height: 9441, hash: '0xec803dcef9a1a4c0f64a919b491a226ce22e9d30be225c76a148b0a22b62eb41' }, bitcoin: { relayTip: 974739, reflection: { height: 974721 } }, ethereum: { finalizedSlot: 13450016 } } });
    if (u.pathname === '/prover/salt') return json(route, { pointsPerDay: 1500, minBits: 26, today: { miners: 2, shares: 30, weight: 40 }, top: [{ miner: ADDR, shares: 20, weight: 22 }], live: [{ miner: OTHER, at: Date.now() - 60_000 }, { miner: '0x68575b073de49a94e3e3acf6f3a0d6e3b66267c7', at: Date.now() - 30_000, house: true }], rate: 2_400_000, bank: [{ address: '0x0000000000ab12cd34ef56ab78cd90ef12ab34cd', bits: 41, miner: OTHER }, { address: '0x0000000000cd12cd34ef56ab78cd90ef12ab34cd', bits: 40, miner: '0x68575b073de49a94e3e3acf6f3a0d6e3b66267c7', house: true }] });
    return json(route, {}, 404);
  });
  await page.route('https://tacit-points.onrender.com/**', (route) => json(route, { enabled: true, endSec: Math.floor(Date.now() / 1000) + 86400 * 10, terms: { capWeiPerPoint: '10000000000000000' }, account: { creditedWei: '6000000000000000000' } }));
  await page.goto(`${ORIGIN}/prove/${hash}`);
  return { page, ctx, errors, posts };
}
const text = (page, s) => page.locator(s).innerText();
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true }); };

const browser = await chromium.launch();
try {
  // nothing on this computer
  {
    const local = { v: null };
    const { page, ctx, errors } = await open(browser, local);
    await page.waitForFunction(() => document.querySelector('#title').textContent === 'Set up this computer');
    check(await page.locator('#setup').isVisible(), 'not set up: the setup line is shown');
    check(!(await page.locator('#setup .wsl').isVisible()) && (await text(page, '#copy')) === 'Copy, then paste in Terminal', 'on a Mac, the line alone, pasted in Terminal');
    check(!(await page.locator('#go').isVisible()), 'not set up: no start button');
    await page.fill('#addr', ADDR);
    check((await text(page, '#cmd')).endsWith(ADDR), 'the setup line carries the address', await text(page, '#cmd'));
    await page.waitForFunction(() => document.querySelector('#btc-pay').textContent.includes('TAC'), null, { timeout: 8000 }).catch(() => {});
    check((await page.textContent('#btc-pay')) === ' · 10 TAC each', 'the GPU card says what a Bitcoin batch pays', await page.textContent('#btc-pay'));
    check((await text(page, '#gpu-cmd')) === `curl -fsSL https://tacit.finance/prove-gpu.sh | sh -s -- ${ADDR}`, 'with the GPU command for the address', await text(page, '#gpu-cmd'));
    await page.waitForFunction(() => document.querySelector('#gpu-n').textContent !== '—', null, { timeout: 8000 }).catch(() => {});
    check((await text(page, '#gpu-n')) === '2', 'GPUs online: one asked for work just now, one is proving a batch; one gone a day and a settle-only machine are not', await text(page, '#gpu-n'));
    check((await text(page, '#gpu-me')) === 'waiting for its turn · 3 batches', "the address's own GPU, from its board name", await text(page, '#gpu-me'));
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.click('#copy');
    await page.waitForFunction(() => document.querySelector('#title').textContent === 'Waiting for tacit-prover…', null, { timeout: 5000 }).catch(() => {});
    check((await text(page, '#title')) === 'Waiting for tacit-prover…', 'once copied, the page waits for the prover', await text(page, '#title'));
    await page.waitForFunction(() => document.querySelector('#today').textContent.includes('4 proofs'));
    check((await text(page, '#pays')).includes('0.2 TAC a proof'), 'what a proof pays is read from the services', await text(page, '#pays'));
    check((await text(page, '#paid')) === '6 TAC credited', 'what was paid', await text(page, '#paid'));
    await page.waitForFunction(() => document.querySelectorAll('#chain .blk:not(.next):not(.xc)').length === 4);
    check((await text(page, '#height')) === '#9,389', 'the tip is the newest block', await text(page, '#height'));
    check((await text(page, '#last')) === '5 min ago', 'the newest block\'s age is read from Ethereum\'s head', await text(page, '#last'));
    check((await page.locator('#chain .blk:not(.next):not(.xc) .t').first().innerText()) === '5 min ago', 'each block says how long ago it was');
    check((await page.locator('#chain .blk.won').count()) === 2, 'blocks a community prover proved are marked');
    check((await page.locator('#chain .blk.mine').count()) === 1, 'the address\'s own block is picked out');
    check((await page.locator('#pool i').count()) === 5 && (await page.locator('#pool i.on').count()) === 2, 'the waiting proofs are drawn, the leased ones lit');
    check((await text(page, '#feed')).includes('+0.2 TAC') && (await text(page, '#feed')).includes('a deposit, proved in 9 min'), 'the feed says who proved what, how fast and what it won', await text(page, '#feed'));
    check((await text(page, '#board')).includes('4 proofs · 0.8 TAC · 9 min each'), 'today\'s provers with their TAC and their speed', await text(page, '#board'));
    await page.waitForFunction(() => document.querySelector('#crowd-n').textContent === '3 online now');
    check((await page.locator('#crowd .pod').count()) === 3, 'the crowd: everyone who proved lately and every node grinding salts, Tacit GPU among them');
    check(await page.locator('#crowd .pod.me').count() === 1, 'with this address picked out');
    check((await page.locator('#chain .blk.xc').count()) === 1 && (await text(page, '#chain .blk.xc')).includes('974,721') && (await page.getAttribute('#chain .blk.xc a', 'href')).includes('etherscan.io/tx/0xabab') && (await page.locator('#chain .blk.xc .who').count()) === 1, 'a cross-chain block stands among the settles, with Bitcoin\'s height, its landing and who mined it');
    await page.waitForFunction(() => !document.querySelector('#checkpoint').hidden);
    check((await text(page, '#checkpoint')).includes('#9,441') && (await text(page, '#checkpoint')).includes('Bitcoin 974,721') && (await text(page, '#checkpoint')).includes('Ethereum slot 13,450,016'), 'the day\'s checkpoint: the block, Bitcoin\'s height and where it is kept', await text(page, '#checkpoint'));
    check((await page.locator('#feed li.me').count()) === 1 && !(await text(page, '#feed')).includes('· you'), 'its own proofs in the feed are marked by the row, the name kept short');
    check((await text(page, '#n-done')) === '433' && (await text(page, '#n-provers')) === '11', 'the headline counts are the last 24 hours, not since midnight UTC', `${await text(page, '#n-done')} ${await text(page, '#n-provers')}`);
    const kinds = await page.locator('#chain .blk:not(.next):not(.xc) .k').allInnerTexts();
    check(JSON.stringify(kinds) === JSON.stringify(['Private transfer', 'Deposit', 'Private transfer', 'Private transfer']), 'each block says what it did', JSON.stringify(kinds));
    check((await text(page, '#today')) === '4 proofs · 0.8 TAC', 'the rig says what today earned', await text(page, '#today'));
    check((await text(page, '#payout')).startsWith('after the day ends, in '), 'and when it is paid', await text(page, '#payout'));
    if (Date.now() % 86400000 >= 7200000) check((await text(page, '#pace')).includes('TAC a day ('), 'and the pace at today\'s rate', await text(page, '#pace'));
    else check(await page.locator('#pace-row').isHidden(), 'no pace in the day\'s first two hours');
    const share = await page.getAttribute('#share', 'href');
    check(await page.locator('#share').isVisible() && share.startsWith('https://x.com/intent/post?') && share.includes('4%20privacy%20proofs'), 'a share link once it has proved', share);
    check((await page.locator('#chain .blk.gpu').count()) === 1 && (await page.locator('#chain .blk.gpu').innerText()).includes('Tacit GPU'), 'a block Tacit\'s GPU proved says so');
    const gpuRow = await page.locator('#feed li').first().innerText();
    check(gpuRow.includes('Tacit GPU') && !gpuRow.includes('TAC '), 'the feed shows Tacit\'s GPU, earning nothing', gpuRow);
    check(!(await text(page, '#board')).includes('Tacit GPU'), 'Tacit\'s GPU is never on the leaderboard');
    check((await text(page, '#me')) === '0x66f5…3db5', 'the rig shows the address beside its invader, no NFT number', await text(page, '#me'));
    check(!(await page.content()).includes('zorgz #'), 'no page text names an NFT number');
    check((await text(page, '#next-o')) === '5 waiting', 'the next block says how many proofs wait', await text(page, '#next-o'));
    check((await page.locator('#chain .blk .badge img.inv').count()) === 3, 'each proved block wears its prover\'s invader');
    const loaded = await page.locator('img.inv').evaluateAll((xs) => xs.every((x) => x.complete && x.naturalWidth > 0));
    check(loaded, 'every invader image draws');
    await page.click('#chain .blk.mine button');
    const det = await text(page, '#detail');
    check(det.includes('Won') && det.includes('0.2 TAC') && det.includes('you') && det.includes('Deposit') && det.includes('2 new notes · 1 deposit') && det.includes('Make a private deposit'), 'a block opens with what it did, a link to do it, who proved it and what it won', det);
    // a new block lands at the front
    chain.blocks = [blk(9390, { notes: 0, spent: 2 }), ...chain.blocks];
    await page.waitForFunction(() => document.querySelector('#chain .blk:not(.next):not(.xc)')?.dataset.h === '9390', null, { timeout: 12000 });
    check(await page.locator('#chain .blk.new').count() === 1, 'a new block lands with the landing animation');
    check((await page.locator('#chain .blk').first().getAttribute('class')).includes('next'), 'the next block stays at the front');
    check((await text(page, '#height')) === '#9,390', 'the tip moves on');
    await shot(page, 'prove-none');
    // the prover appears (the line was pasted): the page sees it on its own
    local.v = { mine: { miner: null, on: false, job: null, proved: 0, salt: { on: false, rate: 0, minBits: 26 } } };
    await page.waitForFunction(() => document.querySelector('#title').textContent === 'Paused', null, { timeout: 8000 });
    check(!(await page.locator('#setup').isVisible()), 'once it answers, the setup line goes');
    local.v = { mine: { miner: null, on: false, job: null, proved: 0 } };
    await page.waitForFunction(() => document.querySelector('#salt-day').textContent.startsWith('Run the setup line again'), null, { timeout: 8000 });
    check(await page.locator('#setup').isVisible(), 'a node from before salt mining is shown the setup line, to update');
    check(errors.length === 0, 'no page errors', errors.join(' | '));
    await ctx.close();
  }
  // nothing queued: the stats say what the nodes do meanwhile
  {
    const { page, ctx } = await open(browser, { v: null }, { idle: true });
    await page.waitForFunction(() => document.querySelector('#l-wait').textContent === 'Mining now');
    check((await text(page, '#n-wait')) === '2' && (await page.textContent('#l-lease')) === 'Salts a second' && (await text(page, '#n-lease')) === '2.4 M', 'with nothing queued, the nodes grinding salts and how fast', `${await text(page, '#n-wait')} ${await text(page, '#n-lease')}`);
    await page.waitForFunction(() => document.querySelector('#next-o')?.textContent === 'mining salts');
    check(true, 'the next block says the nodes are mining salts meanwhile');
    await ctx.close();
  }
  // a Windows PC: Ubuntu installed first, then the same line pasted in Ubuntu; the switch goes back to Mac or Linux
  {
    const { page, ctx, errors } = await open(browser, { v: null }, { ua: WINDOWS_UA });
    await page.waitForFunction(() => document.querySelector('#title').textContent === 'Set up this computer');
    check(await page.locator('#setup .wsl').isVisible(), 'Windows: installing Ubuntu comes first');
    // drawn, not only laid out: no inherited style (such as the reward pop's opacity) hides the steps
    check(await page.evaluate(() => [...document.querySelectorAll('#setup .wsl, #setup .wsl *')].every((e) => getComputedStyle(e).opacity === '1')), 'and its steps are drawn');
    check((await page.getAttribute('#setup [data-os="win"]', 'aria-pressed')) === 'true', 'and the switch says Windows');
    check((await text(page, '#copy')) === 'Copy, then paste in Ubuntu', 'the line is pasted in Ubuntu', await text(page, '#copy'));
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.click('#wsl-copy');
    check((await page.evaluate(() => navigator.clipboard.readText())) === 'wsl --install', 'the first step copies wsl --install');
    await page.fill('#addr', ADDR);
    await page.click('#copy');
    check((await page.evaluate(() => navigator.clipboard.readText())).endsWith(ADDR), 'the second copies the setup line for the address');
    check((await text(page, '#say')).startsWith('Copied. Paste it in Ubuntu'), 'and says where to paste it', await text(page, '#say'));
    const over = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
    check(!over, 'no sideways scroll with the Windows steps');
    await shot(page, 'prove-windows');
    await page.click('#setup [data-os="unix"]');
    check(!(await page.locator('#setup .wsl').isVisible()) && (await text(page, '#copy')) === 'Copy, then paste in Terminal', 'the switch goes back to Mac or Linux');
    check(errors.length === 0, 'no page errors on Windows', errors.join(' | '));
    await ctx.close();
  }
  // an older prover: no GET /mine
  {
    const { page, ctx } = await open(browser, { v: { mine: null } });
    await page.waitForFunction(() => document.querySelector('#title').textContent.startsWith('Update'));
    check(await page.locator('#setup').isVisible(), 'an older prover is shown the setup line to update');
    await ctx.close();
  }
  // paused, then started from the button, then a proof under way, then paused mid-proof
  {
    const local = { v: { mine: { miner: ADDR, on: false, job: null, proved: 0 } } };
    const { page, ctx, errors, posts } = await open(browser, local);
    await page.waitForFunction(() => document.querySelector('#title').textContent === 'Paused');
    check((await page.inputValue('#addr')).toLowerCase() === ADDR, 'the prover\'s own address fills the field');
    check((await text(page, '#go')) === 'Start proving', 'paused: the button starts');
    await page.click('#go');
    await page.waitForFunction(() => document.querySelector('#title').textContent === 'Waiting for the next proof');
    check(posts.length === 1 && posts[0].on === true && posts[0].miner.toLowerCase() === ADDR, 'Start sends on with the address', JSON.stringify(posts));
    local.v.mine = { ...local.v.mine, salt: { on: true, rate: 2_400_000, minBits: 26 } };
    await page.waitForFunction(() => document.querySelector('#title').textContent === 'Mining salts until the next proof');
    await page.waitForFunction(() => document.querySelector('#salt').textContent.includes('M/s'));
    check((await text(page, '#salt')) === '20 shares · 8.25 TAC so far · 2.4 M/s', 'between proofs the node grinds salts: its shares, its part of the day and its speed', await text(page, '#salt'));
    check((await page.textContent('#salt-bank-h')) === 'Banked for deploys', 'the bank says what it is');
    check((await text(page, '#salt-pay')).includes('up to 15 TAC today') && (await page.locator('#salt-bank li').count()) === 2 && (await text(page, '#salt-bank')).includes('Tacit GPU'), 'the salt pot and the best addresses banked, Tacit GPU\'s named so', await text(page, '#salt-pay'));
    local.v.mine = { ...local.v.mine, job: { id: 'j1', secs: 120, stage: 'shrink', eta: 360 }, proved: 2 };
    await page.waitForFunction(() => document.querySelector('#title').textContent === 'Proving');
    const st = await text(page, '#stage'), steps = await page.locator('#forge li').evaluateAll((ls) => ls.map((l) => l.className));
    check(st === 'Compressing · about 6 min left', 'proving: the stage and the time left', st);
    check(JSON.stringify(steps) === JSON.stringify(['done', 'now spin', '', '']), 'proving: the forge shows the first stage done and the second under way', JSON.stringify(steps));
    check((await text(page, '#run')) === '2', 'proofs since it started', await text(page, '#run'));
    await shot(page, 'prove-proving');
    await page.click('#go');
    await page.waitForFunction(() => document.querySelector('#title').textContent === 'Pausing after this proof');
    check(posts[1]?.on === false, 'Pause sends off', JSON.stringify(posts));
    // the proof is taken: the reward it won pops up
    local.v.mine = { ...local.v.mine, job: null, proved: 3 };
    await page.waitForFunction(() => document.querySelector('#win').classList.contains('go'));
    check((await text(page, '#win')) === '+0.2 TAC', 'a proof taken shows what it won', await text(page, '#win'));
    check((await text(page, '#say')).includes('after the proof under way'), 'pausing mid-proof says it finishes that one', await text(page, '#say'));
    check(errors.length === 0, 'no page errors', errors.join(' | '));
    await ctx.close();
  }
  // start with no address: refused in words, nothing sent
  {
    const { page, ctx, posts } = await open(browser, { v: { mine: { miner: null, on: false, job: null, proved: 0 } } });
    await page.waitForFunction(() => document.querySelector('#title').textContent === 'Paused');
    await page.click('#go');
    check(posts.length === 0 && (await text(page, '#say')).includes('Enter the address'), 'Start without an address asks for one');
    await ctx.close();
  }
  // the node's jobs as tabs, and the old community ops address sending its visitors to them
  {
    const { page, ctx, errors } = await open(browser, { v: null });
    await page.waitForFunction(() => document.querySelector('#title').textContent === 'Set up this computer');
    check(!(await page.locator('#t-relay').isVisible()) && await page.locator('#t-prove').isVisible(), 'the Prove tab opens first');
    await page.click('#tb-relay');
    check(await page.locator('#g-board').isVisible() && !(await page.locator('#t-prove').isVisible()), 'Relay shows the open board and hides Prove');
    check(new URL(page.url()).hash === '#tab=relay', 'the tab is in the address', page.url());
    await shot(page, 'prove-relay');
    await page.keyboard.press('ArrowRight');
    check(await page.locator('#g-advance').isVisible() && (await page.getAttribute('#tb-bitcoin', 'aria-selected')) === 'true', 'the arrow keys move along the tabs to Bitcoin');
    await page.waitForTimeout(1500);
    await shot(page, 'prove-bitcoin');
    await page.click('#tb-prove');
    check(new URL(page.url()).hash === '' && await page.locator('#t-prove').isVisible(), 'back on Prove the address has no tab');
    check(await page.locator('#wallet').isVisible(), 'the wallet chip is in the header');
    check(errors.length === 0, 'no page errors', errors.join(' | '));
    for (const [from, tab, extra] of [['#need=970200&why=lock', 'bitcoin', 'need=970200&why=lock'], ['#g-board', 'relay', ''], ['', 'bitcoin', '']]) {
      await page.goto(`${ORIGIN}/weld/keeper/${from}`);
      await page.waitForURL(/\/prove\//, { timeout: 8000 });
      const h = new URLSearchParams(new URL(page.url()).hash.slice(1));
      check(h.get('tab') === tab && (!extra || `need=${h.get('need')}&why=${h.get('why')}` === extra) && await page.locator(`#t-${tab}`).isVisible(),
        `/weld/keeper/${from || ''} goes to the ${tab} tab${extra ? ', keeping what the lock needs' : ''}`, page.url());
    }
    await ctx.close();
  }
  // each card's own link (/prove/#<card>) and its Share to X
  {
    const { page, ctx, errors } = await open(browser, { v: null }, { hash: '#gpu' });
    await page.waitForTimeout(300);
    const gpu = page.locator('[data-card="gpu"]');
    check(await page.locator('#t-prove').isVisible() && await gpu.evaluate((el) => el.classList.contains('lit')), '#gpu opens the Prove tab and marks the GPU card');
    await page.waitForTimeout(1200);
    const box = await gpu.boundingBox();
    check(box && box.y >= 0 && box.y < 120, 'and brings it to the top of the window', JSON.stringify(box));
    const cards = await page.locator('[data-card]').count(), shares = await page.locator('.share-x').count();
    check(cards >= 11 && shares === cards, 'every card has its Share', `${shares} of ${cards}`);
    const href = await page.getAttribute('[data-card="gpu"] .share-x', 'href');
    const q = new URL(href).searchParams;
    check(href.startsWith('https://x.com/intent/post?') && q.get('url') === 'https://tacit.finance/prove/#gpu' && q.get('text').includes('24 GB'), "the GPU card's Share posts its own link and line", href);
    await page.evaluate(() => { location.hash = 'send'; });
    await page.waitForTimeout(400);
    check(await page.locator('#t-relay').isVisible() && await page.locator('[data-card="send"]').evaluate((el) => el.classList.contains('lit')), '#send opens the Relay tab at its card');
    await page.click('#tb-bitcoin');
    check(new URL(page.url()).hash === '#tab=bitcoin', 'a tab pressed after a card link puts the tab alone in the address', page.url());
    await page.click('#tb-prove');
    check(new URL(page.url()).hash === '', 'and Prove clears it', page.url());
    check(errors.length === 0, 'no page errors', errors.join(' | '));
    await ctx.close();
  }
  // an API answer carrying markup: dropped before anything is drawn
  {
    const saved = chain.blocks;
    chain.blocks = [{ height: '<img id=pwn src=x>', hash: '0x1', tx: '"><b id=pwn2>', ethBlock: '<i id=pwn3>', notes: 1, spent: 0 }, blk(7, { prover: '<b id=pwn4>x</b>', points: '<b id=pwn5>' })];
    const { page, ctx, errors } = await open(browser, { v: null });
    await page.waitForFunction(() => document.querySelectorAll('#chain .blk:not(.next):not(.xc)').length === 1);
    const pwned = await page.evaluate(() => ['pwn', 'pwn2', 'pwn3', 'pwn4', 'pwn5'].filter((i) => document.getElementById(i)));
    check(pwned.length === 0 && (await page.locator('#chain .blk:not(.next):not(.xc)').first().getAttribute('data-h')) === '7', 'markup in an API answer never reaches the page', JSON.stringify(pwned));
    check(errors.length === 0, 'and nothing breaks', errors.join(' | '));
    chain.blocks = saved;
    await ctx.close();
  }
  // a phone
  {
    const { page, ctx } = await open(browser, { v: null }, { phone: true });
    check(await page.locator('#phone').isVisible() && !(await page.locator('#desk').isVisible()), 'a phone is told to open it on a computer');
    const over = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    check(!over, 'no sideways scroll on a phone');
    await shot(page, 'prove-phone');
    await ctx.close();
  }
} finally {
  await browser.close();
  server.close();
}
console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
