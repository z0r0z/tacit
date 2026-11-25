#!/usr/bin/env node
// One command to become a provider of Bitcoin for ETH on Tacit's bridge. Node 22, run from the repository root:
//
//   node fastbridge-lp/setup.mjs                 set up, wait for the deposits, check everything, start, and say where it shows
//   node fastbridge-lp/setup.mjs run             start the daemon (what a restart, or the container's `run`, does)
//   node fastbridge-lp/setup.mjs status          read its health, terms and the board's ad, and say what they mean
//   node fastbridge-lp/setup.mjs show-key        print the key again (to back it up)
//
//   flags (or the same in the environment): --name <name> (FB_LP_NAME)  --fee-bps <n> (FB_LP_FEE_BPS)  --flat-fee <sats> (FB_LP_FLAT_FEE)
//     --size small|medium|large (FB_LP_SIZE)  --data <dir> (FB_LP_DATA_DIR, default fastbridge-lp/data-btc-eth)  --port <n> (PORT)
//     --yes   take every default, ask nothing      --no-start   stop after the checks (a container does, then `run`)      --wait-mins <n>   how long to wait for the ETH (180)
//
// It can be run again at any point, and stopped with Ctrl-C at any point: the key is made once and kept, the deposit is written down before it is
// sent, and each run first finds out what an earlier one finished. The key is never printed except once at creation (and by `show-key`).

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createInterface } from 'node:readline/promises';
import * as S from './lib/setup.mjs';

const argv = process.argv.slice(2);
const cmd = ['run', 'status', 'show-key'].includes(argv[0]) ? argv[0] : 'setup';
const flag = (n, env) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] != null ? argv[i + 1] : (env && process.env[env]) || null; };
const has = (n) => argv.includes('--' + n);
const say = (t = '') => console.log(t);
const die = (m) => { console.error('\n' + m + '\n'); process.exit(1); };
const dataDir = resolve(flag('data', 'FB_LP_DATA_DIR') || 'fastbridge-lp/data-btc-eth');
const cfgPath = resolve(dataDir, 'config.json');
const baseCfg = JSON.parse(readFileSync(new URL('./config.btc-eth.example.json', import.meta.url), 'utf8'));
const port = Number(flag('port', 'PORT') || baseCfg.port);
const INTERACTIVE = process.stdin.isTTY && !has('yes');
const rl = INTERACTIVE ? createInterface({ input: process.stdin, output: process.stdout }) : null;
const ask = async (q, d) => { if (!rl) return d; const a = (await rl.question(`${q} [${d}] `)).trim(); return a || d; };
process.on('SIGINT', () => { say('\nstopped. Nothing is lost: run the same command again and it picks up where it was.'); process.exit(130); });

const spawnServer = ({ keyHex, dry, p }) => spawn(process.execPath, ['fastbridge-lp/server.mjs', ...(dry ? ['--dry-run'] : [])], {
  stdio: dry ? ['ignore', 'ignore', 'ignore'] : 'inherit', env: { ...process.env, FB_LP_KEY: keyHex, FB_LP_CONFIG: cfgPath, PORT: String(p) },
});
const freePort = () => new Promise((ok) => { const s = createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => ok(p)); }); });
const until = async (fn, ms, every = 3000) => { const t0 = Date.now(); for (;;) { try { const v = await fn(); if (v) return v; } catch { /* not yet */ } if (Date.now() - t0 > ms) return null; await new Promise((r) => setTimeout(r, every)); } };
const getJson = async (u) => { const r = await fetch(u, { signal: AbortSignal.timeout(8000) }); return r.ok ? r.json() : null; };

if (cmd === 'show-key') {
  const k = S.ensureKey({ dataDir: dataDir, env: { ...process.env } });
  if (k.source === 'file' && k.created) die('no key existed: it was just made. Run `setup` to continue.');
  say(k.keyHex); process.exit(0);
}

if (cmd === 'run') {
  if (!existsSync(cfgPath)) die(`no config at ${cfgPath}: run \`setup\` first`);
  const k = S.ensureKey({ dataDir });
  if (k.created) die('there was no key, so one was made. This is a new, empty provider: run `setup` to see what to fund, and back the key up (`setup show-key`).');
  const child = spawnServer({ keyHex: k.keyHex, dry: false, p: port });
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill('SIGTERM'));
  child.on('exit', (c) => process.exit(c ?? 0));
} else if (cmd === 'status') {
  const cfg = existsSync(cfgPath) ? JSON.parse(readFileSync(cfgPath, 'utf8')) : baseCfg;
  const base = `http://localhost:${port}`;
  const health = await getJson(base + '/health').catch(() => null);
  const info = await getJson(base + '/info').catch(() => null);
  if (!health) die(`nothing answers at ${base}: it is not running. \`node fastbridge-lp/setup.mjs run\` starts it.`);
  say(`health: ${health.ok ? 'ok' : 'NOT ok, its loop failed: ' + (health.error || 'see the log')}`);
  if (info) {
    say(`quotes ${S.fmtSats(info.minAmount)} to ${S.fmtSats(info.maxAmount)}, fee ${(info.feeBps / 100).toFixed(2)}% + ${S.fmtSats(info.flatFee)}`);
    say(info.available == null ? 'available: not read yet' : `available: ${S.fmtSats(info.available)} (${BigInt(info.available) < BigInt(info.minAmount) ? 'under the minimum: "full right now", shield more ETH' : 'it can lend this now'})`);
    if (info.stats) say('stats: ' + JSON.stringify(info.stats));
    let found = null;
    for (const b of cfg.boards || []) { try { const ads = await (await fetch(b + '/ads', { signal: AbortSignal.timeout(8000) })).json(); found = (ads.ads || []).find((a) => a.claimPub === info.claimPub) || found; } catch { /* board down */ } }
    say(found ? `on the board as "${found.name}": it shows at https://tacit.finance/btc/ under Providers online` : 'its ad is not on the board yet (it is posted a minute after start; the first start reads the pool for two minutes or so)');
  }
  say('\n' + S.statusHelp({ port }));
  process.exit(0);
} else {
  // ---- setup ----
  say('Tacit swap provider setup (Bitcoin <-> ETH)\n');
  const k = (() => { try { return S.ensureKey({ dataDir }); } catch (e) { return die(String(e.message)); } })();
  if (k.created) say(S.backupNotice(k.keyHex, k.path));
  else say(k.source === 'env' ? 'Using the key in FB_LP_KEY (it is not written anywhere).' : `Using the key in ${k.path}${k.tightened ? ' (its mode was loose: set to 600)' : ''}.`);
  const store = S.makeStateFile(dataDir), state = store.load(), save = (s) => store.save(s);

  // the terms: flags, then the last run's, then prompts with defaults
  const name = flag('name', 'FB_LP_NAME') || state.name || await ask('Name shown on the provider list', 'Provider');
  say('\n' + S.explainFee({ feeBps: state.terms?.feeBps ?? S.DEFAULT_TERMS.feeBps, flatFee: state.terms?.flatFee ?? S.DEFAULT_TERMS.flatFee }));
  const terms = (() => { try { return S.validateTerms({ feeBps: flag('fee-bps', 'FB_LP_FEE_BPS') ?? state.terms?.feeBps ?? S.DEFAULT_TERMS.feeBps, flatFee: flag('flat-fee', 'FB_LP_FLAT_FEE') ?? state.terms?.flatFee ?? S.DEFAULT_TERMS.flatFee }); } catch (e) { return die(e.message); } })();
  if (INTERACTIVE && !flag('fee-bps', 'FB_LP_FEE_BPS') && !state.terms) {
    terms.feeBps = S.validateTerms({ feeBps: await ask('Fee share, in hundredths of a percent (30 = 0.30%)', terms.feeBps), flatFee: terms.flatFee }).feeBps;
    terms.flatFee = S.validateTerms({ feeBps: terms.feeBps, flatFee: await ask('Flat fee per swap, in sats', terms.flatFee) }).flatFee;
  }
  const size = flag('size', 'FB_LP_SIZE') || state.size || await ask('Size of your start (small, medium, large)', 'small');
  if (!S.SIZES[size]) die('size must be small, medium or large');
  save({ ...state, name, terms, size });

  say('\nLoading the pool module and reading the price…');
  const { loadEnv } = await import('./lib/setup-env.mjs');
  const env = await loadEnv({ keyHex: k.keyHex, dataDir, baseConfig: baseCfg, say: (t) => say('  ' + t) }).catch((e) => die(`could not start: ${e.message}`));
  const rate = await env.io.rate().catch((e) => die(`no price for Bitcoin against ETH (${e.message}): the provider cannot quote without one. Check this machine reaches Ethereum nodes, Coinbase and Kraken, then run setup again.`));
  const eth = await env.io.publicEth(), plans = Object.keys(S.SIZES).map((s) => S.planAmounts(s, rate));

  say('\nYour provider\'s two addresses (public, safe to share; both are derived from the key):');
  say(`  Ethereum pool account   ${env.poolAccount}`);
  say(`  Bitcoin reverse address ${env.reverseAddress}`);
  say('\nWhat to send (swap prices follow the market, so this is for today\'s price). Only the ETH is needed to start; the Bitcoin turns on ETH -> BTC:');
  for (const p of plans) say(`  ${p.size.padEnd(7)} ${p.note.padEnd(36)} ${S.fmtEth(p.ethWei)} to the pool account, ${S.fmtBtc(p.btcSats)} to the Bitcoin address${p.size === size ? '   <- your choice' : ''}`);
  say(`  Smallest swap it takes: ${S.fmtSats(S.MIN_SWAP_SATS)}. About ${S.fmtEth(S.GAS_RESERVE_WEI)} of what you send stays at the account for gas.`);
  say('  Send ETH on Ethereum mainnet only; Bitcoin needs one confirmation to count.');
  say('\n' + S.earnRiskText());

  const plan = plans.find((p) => p.size === size);
  const minPrivUnits = S.satsToUnits(S.MIN_SWAP_SATS * 2n, rate);
  const minDepositWei = S.unitsToWei(minPrivUnits) > 2n * 10n ** 15n ? S.unitsToWei(minPrivUnits) : 2n * 10n ** 15n;
  say(`\nWatching for your ETH (${S.fmtEth(eth)} at the account now). Ctrl-C any time; run this command again to continue.`);
  const waitMs = Number(flag('wait-mins') || 180) * 60000;
  const w = await S.watchDeposits({ io: env.io, state: store.load(), save, rate, minPrivUnits, minDepositWei, timeoutMs: waitMs });
  if (w.eth !== 'shielded') die(w.eth === 'timeout' ? `No ETH arrived in time. Send it to ${env.poolAccount} and run this command again.` : `The ETH is not private yet (${w.eth}). Nothing is lost: run this command again in a few minutes and it finishes.`);

  const limits = S.deriveLimits({ privUnits: w.privUnits, btcSats: w.btcConfirmed, rate, cap: plan.maxSats });
  say(`\nPrivate ETH in the pool: ${S.fmtEth(S.unitsToWei(w.privUnits))}. Bitcoin confirmed at the reverse address: ${S.fmtSats(w.btcConfirmed)}.`);
  say(`Limits: BTC -> ETH swaps from ${S.fmtSats(limits.minSats)} to ${S.fmtSats(limits.maxSats)}${limits.reverse ? `; ETH -> BTC is on (up to ${S.fmtSats(limits.reverse.maxSats)} of coins out)` : '; ETH -> BTC stays off until Bitcoin is confirmed at the reverse address (run setup again after sending it)'}.`);
  if (!limits.forward) die('That is less ETH than two minimum swaps. Send more, then run setup again.');
  const C = S.buildConfig({ base: baseCfg, name, terms, limits, dataDir, port });
  const wr = S.writeConfigIfOwned(cfgPath, C);
  say(wr.written ? `Config written to ${cfgPath}.` : wr.reason);

  // the self-test: the checks that read the world, then the daemon in a dry run answering real requests
  say('\nChecking everything the provider depends on:');
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  const checks = [
    S.rpcQuorumCheck({ nodes: cfg.agreeRpcs || env.agreeNodes, fetchImpl: env.fetchImpl }),
    S.explorerCheck({ bases: cfg.btcBases, fetchImpl: env.fetchImpl }),
    { name: 'the relay', required: false, fix: 'if the relay is busy the provider sends its own settles from the pool account: keep the gas ETH there', async run() { const s = await env.io.relayState(); return { ok: s === 'ok', detail: s }; } },
    { name: 'the board', required: true, fix: 'the board posts the ad; check this machine\'s outbound HTTPS', async run() { const r = await fetch((cfg.boards || [])[0] + '/health', { signal: AbortSignal.timeout(8000) }); return { ok: r.ok, detail: r.ok ? 'reachable' : 'answered ' + r.status }; } },
  ];
  let res = await S.runChecks(checks, say);
  if (res.ok) {
    say('  starting a dry run to try the quote path (the first read of the pool takes about two minutes)…');
    const p = await freePort(), child = spawnServer({ keyHex: k.keyHex, dry: true, p }), base = `http://localhost:${p}`;
    try {
      const up = await until(async () => (await getJson(base + '/health'))?.ok, 8 * 60000);
      if (!up) res = { ok: false, results: [{ name: 'dry run', required: true, ok: false }] }, say('  FAIL  the dry run did not come up in eight minutes: run it by hand (`node fastbridge-lp/server.mjs --dry-run`) to see why');
      else {
        const origin = (cfg.origins || ['https://tacit.finance'])[0];
        const r2 = await S.runChecks([S.corsCheck({ base, origin, fetchImpl: env.fetchImpl }), S.quoteCheck({ base, minSats: limits.minSats, fetchImpl: env.fetchImpl })], say);
        res = { ok: r2.ok };
      }
    } finally { child.kill('SIGTERM'); }
  }
  if (!res.ok) die('Not starting: a required check failed (above). Fix it and run this command again: nothing is lost, and the shielded ETH stays yours.');
  say('\nAll required checks passed.');
  say('\nHow to see it is healthy:\n' + S.statusHelp({ port }));
  if (has('no-start')) { say('\nSet up. Start it with `run` (a container: `docker run ... tacit-lp run`). Keep it running: it must finish each swap within about a day.'); process.exit(0); }
  say('\nStarting the provider. It posts its ad about a minute after it starts; a first start reads the pool for two minutes or so. Keep this running (Ctrl-C stops it; open swaps are read back and finished on the next start).\n');
  const child = spawnServer({ keyHex: k.keyHex, dry: false, p: port });
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill('SIGTERM'));
  child.on('exit', (c) => process.exit(c ?? 0));
  until(async () => {
    const info = await getJson(`http://localhost:${port}/info`);
    if (!info) return false;
    for (const b of cfg.boards || []) { const ads = (await (await fetch(b + '/ads')).json()).ads || []; if (ads.some((a) => a.claimPub === info.claimPub)) return true; }
    return false;
  }, 15 * 60000, 10000).then((ok) => say(ok ? `\nYour provider is live: "${name}" shows at https://tacit.finance/btc/ under Providers online.` : '\nIts ad is not on the board after 15 minutes: read the log above, then `node fastbridge-lp/setup.mjs status`.'));
}
