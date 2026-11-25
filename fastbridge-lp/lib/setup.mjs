// The logic of fastbridge-lp/setup.mjs, the one-command start of a Bitcoin-for-ETH provider. Everything that touches the world (the chain, the
// explorers, the pool module, the clock) comes in through an `io` object, so each step is tried here with a mock: the key and its file mode, the
// config, the sums of what to send, the watch for deposits, the shield that can be stopped at any point and picked up again, and the self-test.

import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, statSync, renameSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { pairConfig } from './pair.mjs';

export const MIN_SWAP_SATS = 50000n;                          // the least a swap takes (the example config's minimum; the daemon refuses under 20,000)
export const SIZES = {                                        // the most one swap takes, by size of start
  small: { maxSats: 100000n, note: 'a first try: swaps up to 0.001 BTC' },
  medium: { maxSats: 500000n, note: 'swaps up to 0.005 BTC' },
  large: { maxSats: 2500000n, note: 'swaps up to 0.025 BTC' },
};
export const GAS_RESERVE_WEI = 10n ** 16n;                    // 0.01 ETH stays at the pool account: the deposit's gas and the settles it sends itself when the relay is busy
export const DEFAULT_TERMS = { feeBps: 30, flatFee: '1000' }; // 0.30% of the amount, plus 1,000 sats
const UNIT = 10n ** 10n;                                      // wei per pool unit (8 places)
const big = (v) => BigInt(v);

export const fmtSats = (s) => `${big(s).toLocaleString('en-US')} sats`;
export const fmtBtc = (s) => `${(Number(big(s)) / 1e8).toFixed(5)} BTC`;
export const fmtEth = (wei) => `${(Number(big(wei) / UNIT) / 1e8).toFixed(4)} ETH`;
export const unitsToWei = (u) => big(u) * UNIT;

// ---- the key ---------------------------------------------------------------------------------------------------------------------------------

const KEY_RE = /^[0-9a-f]{64}$/i;
export function keyPath(dataDir) { return join(dataDir, 'provider.key'); }

// FB_LP_KEY in the environment wins and is never written anywhere. Otherwise the key lives in <dataDir>/provider.key, mode 600, and is made once:
// a file that is there is read (and its mode tightened), never replaced, and one that is not a key stops the setup rather than being overwritten.
export function ensureKey({ dataDir, env = process.env, rand = randomBytes }) {
  const fromEnv = String(env.FB_LP_KEY || '').trim().replace(/^0x/, '');
  if (fromEnv) {
    if (!KEY_RE.test(fromEnv)) throw new Error('FB_LP_KEY must be 64 hex characters');
    return { keyHex: fromEnv.toLowerCase(), created: false, source: 'env', path: null };
  }
  const path = keyPath(dataDir);
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  if (existsSync(path)) {
    const text = readFileSync(path, 'utf8').trim().replace(/^0x/, '');
    if (!KEY_RE.test(text)) throw new Error(`${path} is there but is not a key (64 hex characters): it was not touched; move it away or fix it`);
    let tightened = false;
    if ((statSync(path).mode & 0o077) !== 0) { chmodSync(path, 0o600); tightened = true; }
    return { keyHex: text.toLowerCase(), created: false, source: 'file', path, tightened };
  }
  const keyHex = Buffer.from(rand(32)).toString('hex');
  writeFileSync(path, keyHex + '\n', { flag: 'wx', mode: 0o600 });          // wx: never over a file that appeared in between
  chmodSync(path, 0o600);
  return { keyHex, created: true, source: 'file', path };
}

export function backupNotice(keyHex, path) {
  return [
    '',
    '  BACK THIS UP NOW. This key is your provider: its Bitcoin wallet, its pool account and its swap secrets.',
    '  Anyone who has it can move the funds; if it is lost, so are the funds. Nobody at Tacit can recover it.',
    '',
    `    ${keyHex}`,
    '',
    path ? `  It is also kept in ${path} (readable by you only). This is the only time setup prints it; \`setup show-key\` prints it again on request.` : '',
    '',
  ].filter((l, i, a) => l !== '' || a[i - 1] !== '').join('\n');
}

// ---- the state (what setup did, so a second run picks up where the first stopped) ------------------------------------------------------------

export function makeStateFile(dataDir) {
  const path = join(dataDir, 'setup-state.json');
  return {
    path,
    load() { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return {}; } },
    save(s) { mkdirSync(dataDir, { recursive: true, mode: 0o700 }); const tmp = path + '.tmp'; writeFileSync(tmp, JSON.stringify(s, null, 2)); renameSync(tmp, path); },
  };
}

// ---- terms and config ------------------------------------------------------------------------------------------------------------------------

export function validateTerms({ feeBps, flatFee }) {
  const b = Number(feeBps);
  if (!Number.isInteger(b) || b < 0 || b > 500) throw new Error('the fee share must be a whole number of hundredths of a percent, 0 to 500 (30 is 0.30%)');
  if (!/^\d{1,9}$/.test(String(flatFee))) throw new Error('the flat fee must be a whole number of sats');
  return { feeBps: b, flatFee: String(flatFee) };
}

// What the fee means, in words, with the sums for a swap of the size the provider will take most.
export function explainFee({ feeBps, flatFee }, exampleSats = 500000n) {
  const share = (big(exampleSats) * big(feeBps)) / 10000n, total = share + big(flatFee);
  const pct = (Number(total) / Number(exampleSats) * 100).toFixed(2);
  return [
    `Your fee is what you keep from each swap: ${(feeBps / 100).toFixed(2)}% of the amount, plus a flat ${fmtSats(flatFee)}. It is added to the market price.`,
    `The flat part pays your Bitcoin network fees; the share is your margin for tying up capacity. On a swap of ${fmtSats(exampleSats)} (${fmtBtc(exampleSats)}) you earn ${fmtSats(total)} (${pct}%).`,
    'Pages ask the providers with the lowest fees first, so a fee under the others fills more, and one over them fills less.',
  ].join('\n');
}

// Pool units (1e-8 ETH) per sat, from the price feed's { num, den }
export const satsToUnits = (sats, rate) => (big(sats) * big(rate.num)) / big(rate.den);
export const unitsToSats = (units, rate) => (big(units) * big(rate.den)) / big(rate.num);

// What to send for a size: ETH for two swaps at the most at once (they can overlap) plus the gas reserve, and the sats for the reverse side
// (the most one swap sells, plus two locks' fees).
export function planAmounts(size, rate) {
  const s = SIZES[size];
  if (!s) throw new Error(`size must be small, medium or large (got "${size}")`);
  const ethUnits = satsToUnits(s.maxSats * 2n, rate);
  const ethWei = unitsToWei(ethUnits) + GAS_RESERVE_WEI;
  return { size, maxSats: s.maxSats, ethWei, shieldWei: unitsToWei(ethUnits), btcSats: s.maxSats + 40000n, note: s.note };
}

// The terms that follow from what is funded: the most a swap takes is half the private ETH (two can be out at once), capped by the size asked for.
// The reverse side turns on only with confirmed coins: its most is what the coins can lock after a fee reserve.
export function deriveLimits({ privUnits, btcSats, rate, cap = SIZES.large.maxSats, minSats = MIN_SWAP_SATS, lockFeeReserve = 20000n }) {
  const fundedSats = unitsToSats(privUnits, rate);
  let max = fundedSats / 2n;
  if (max > big(cap)) max = big(cap);
  const out = { minSats: big(minSats), maxSats: max, forward: max >= big(minSats), reverse: null, rate };
  const free = big(btcSats) - big(lockFeeReserve) * 2n;
  if (free >= big(minSats)) {
    const rmax = free < max ? free : max;
    out.reverse = { maxSats: free, minAmount: String(satsToUnits(minSats, rate)), maxAmount: String(satsToUnits(rmax, rate)) };
  }
  return out;
}

// The config setup owns (`managedBy`): rewritten on each run from the base example, the terms and the limits. A file without the mark is the
// operator's own and is left alone.
export function buildConfig({ base, name, terms, limits, dataDir, port, origins }) {
  const C = JSON.parse(JSON.stringify(base));
  C.managedBy = 'fastbridge-lp/setup.mjs';
  C.dataDir = dataDir;
  if (port) C.port = port;
  if (name) C.name = String(name).slice(0, 40);
  if (origins) C.origins = origins;
  C.quote = { ...C.quote, feeBps: terms.feeBps, flatFee: String(terms.flatFee), minAmount: String(limits.minSats), maxAmount: String(limits.forward ? limits.maxSats : 0n) };
  C.reverse = { ...C.reverse, enabled: !!limits.reverse };
  if (limits.reverse) {
    C.reverse = { ...C.reverse, enabled: true, minAmount: limits.reverse.minAmount, maxAmount: limits.reverse.maxAmount, maxSats: String(limits.reverse.maxSats), flatFee: String(satsToUnits(terms.flatFee, limits.rate || { num: 1n, den: 1n })), feeBps: terms.feeBps };
  }
  pairConfig(C);                                              // the daemon's own check: a config it would refuse is refused here, in a sentence
  return C;
}

export function writeConfigIfOwned(path, C) {
  if (existsSync(path)) {
    let have = null;
    try { have = JSON.parse(readFileSync(path, 'utf8')); } catch { /* not ours to judge */ }
    if (!have || have.managedBy !== C.managedBy) return { written: false, reason: `${path} is your own config (it has no setup mark): left as it is` };
  }
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(C, null, 2) + '\n', { mode: 0o600 });
  return { written: true };
}

// ---- the shield: ETH at the pool account into private notes, safe to stop and run again -------------------------------------------------------
//
// One deposit is a transaction and then a settle (the pool turns it into notes). Either can stop: the machine goes off between them, the relay is
// busy and the settle reverts, a settle races the relay's own. So the deposit is written down before it is sent and again once it has a hash, and
// every run first asks "did this one finish?": it reads the chain for the deposit and the pool for the notes, and only sends what is missing.
//
// io: { publicEth(), nextIndex(), deposit({ index, amountWei }) -> { txHash }, depositRegistered({ index, amountWei }) -> bool,
//       receipt(txHash) -> null | { ok }, settle(pending) (throws on failure), notesLanded(pending) -> bool, privateUnits() -> bigint,
//       sleep(ms), say(text) }
export async function shieldStep({ io, state, save, backoffMs = [5000, 15000, 30000, 60000], waitMinedMs = 6 * 60000, pollMs = 4000 }) {
  let p = state.pending || null;
  if (p) {
    if (!p.depositTx && !(await io.depositRegistered(p))) { io.say('an earlier deposit was never sent: starting it again'); delete state.pending; save(state); p = null; }
  }
  if (p) {
    if (p.depositTx) {
      let r = null;
      for (let waited = 0; !r && waited <= waitMinedMs; waited += pollMs) { r = await io.receipt(p.depositTx); if (!r) await io.sleep(pollMs); }
      if (!r) { io.say(`the deposit ${p.depositTx} has no receipt yet: it may have been dropped. Run setup again in a few minutes.`); return { status: 'waiting', pending: p }; }
      if (!r.ok) { io.say(`the deposit ${p.depositTx} reverted: nothing was moved. Starting it again.`); delete state.pending; save(state); p = null; }
    }
  }
  if (p) return settleIt({ io, state, save, p, backoffMs });
  return { status: 'idle' };
}

export async function startDeposit({ io, state, save, amountWei }) {
  const index = await io.nextIndex();
  const privBefore = await io.privateUnits();
  state.pending = { index: String(index), amountWei: String(amountWei), privBefore: String(privBefore), depositTx: null, at: new Date().toISOString() };
  save(state);                                               // written before the send: a stop in between is found by depositRegistered
  const sent = await io.deposit({ index, amountWei: big(amountWei) });
  state.pending.depositTx = sent.txHash; save(state);
  io.say(`deposit sent: ${sent.txHash}`);
  return state.pending;
}

export async function settleIt({ io, state, save, p, backoffMs }) {
  // the notes may be there already (a settle of the relay's, a first run that stopped after it): nothing to send then
  if (await io.notesLanded(p)) return finished(state, save, p, io, 'the notes were already in the pool');
  let last = null;
  for (let i = 0; i <= backoffMs.length; i++) {
    try { await io.settle(p); }
    catch (e) { last = e; }
    // after a try that failed too: a revert can be the relay's settle winning the race, which leaves the notes there
    if (await io.notesLanded(p)) return finished(state, save, p, io, last ? 'the relay settled it first' : 'settled');
    if (!last) { io.say('settled; waiting for the notes to show in the pool…'); }
    else io.say(`the settle did not go through (${String((last && last.message) || last).slice(0, 140)}); trying again${i < backoffMs.length ? '' : ' later'}`);
    if (i < backoffMs.length) await io.sleep(backoffMs[i]);
    last = null;
  }
  io.say(`the deposit is on the chain (${p.depositTx || 'index ' + p.index}) and its settle is still open. Nothing is lost: run setup again and it finishes it.`);
  return { status: 'settle-open', pending: p };
}

function finished(state, save, p, io, how) {
  (state.shields ||= []).push({ ...p, doneAt: new Date().toISOString() });
  delete state.pending; save(state);
  io.say(`shielded: ${how}`);
  return { status: 'shielded' };
}

// ---- watching for the deposits ---------------------------------------------------------------------------------------------------------------
//
// io adds: btcConfirmed() -> sats, now(). Returns when the ETH is private (the Bitcoin side is read at that moment and may be zero: the other
// direction is simply off until a later run finds the coins), or at the timeout.
export async function watchDeposits({ io, state, save, rate, minPrivUnits, minDepositWei, timeoutMs = 3 * 3600_000, pollMs = 15000, stablePolls = 2 }) {
  const step = await shieldStep({ io, state, save });
  if (step.status === 'waiting' || step.status === 'settle-open') return { eth: step.status, btcConfirmed: await io.btcConfirmed().catch(() => 0n), privUnits: await io.privateUnits().catch(() => 0n) };
  let priv = await io.privateUnits();
  const t0 = io.now();
  let last = -1n, steady = 0, said = false;
  while (priv < big(minPrivUnits)) {
    const eth = await io.publicEth();
    const spendable = eth - GAS_RESERVE_WEI;
    if (spendable >= big(minDepositWei)) {
      steady = eth === last ? steady + 1 : 1; last = eth;
      if (steady >= stablePolls) {                                     // the same balance twice: a send in two parts has landed, and it is shielded as one
        const amountWei = (spendable / UNIT) * UNIT;
        io.say(`${fmtEth(eth)} arrived: shielding ${fmtEth(amountWei)} (the rest stays for gas)`);
        const p = await startDeposit({ io, state, save, amountWei });
        const r = await shieldStep({ io, state, save });
        if (r.status !== 'shielded') return { eth: r.status, btcConfirmed: await io.btcConfirmed().catch(() => 0n), privUnits: priv };
        priv = await io.privateUnits();
        void p;
        continue;
      }
    } else if (!said || eth > 0n && last !== eth) {
      io.say(eth > 0n ? `${fmtEth(eth)} is at the pool account; ${fmtEth(big(minDepositWei) + GAS_RESERVE_WEI)} is needed to start` : 'waiting for ETH at the pool account…'); said = true; last = eth;
    }
    if (io.now() - t0 > timeoutMs) return { eth: 'timeout', btcConfirmed: await io.btcConfirmed().catch(() => 0n), privUnits: priv };
    await io.sleep(pollMs);
  }
  return { eth: 'shielded', btcConfirmed: await io.btcConfirmed().catch(() => 0n), privUnits: priv };
}

// ---- the self-test ---------------------------------------------------------------------------------------------------------------------------

// A check is { name, required, run() -> { ok, detail } }; one that throws has failed with the error as its detail. Each is said plainly with what to do.
export async function runChecks(checks, say = () => {}) {
  const results = [];
  for (const c of checks) {
    let r;
    try { r = await c.run(); } catch (e) { r = { ok: false, detail: String((e && e.message) || e).slice(0, 200) }; }
    const res = { name: c.name, required: c.required !== false, ok: !!r.ok, detail: r.detail || '', fix: r.ok ? '' : c.fix || '' };
    results.push(res);
    say(`  ${res.ok ? 'ok  ' : res.required ? 'FAIL' : 'warn'}  ${res.name}${res.detail ? ': ' + res.detail : ''}${res.fix ? '\n        -> ' + res.fix : ''}`);
  }
  return { ok: results.every((r) => r.ok || !r.required), results };
}

export const rpcQuorumCheck = ({ nodes, fetchImpl, need = 2 }) => ({
  name: 'Ethereum nodes agree', required: true, fix: 'the provider needs two public Ethereum nodes that answer alike; check this machine\'s outbound HTTPS, or name your own in agreeRpcs / FB_LP_AGREE_RPCS',
  async run() {
    const heads = [];
    await Promise.all(nodes.map(async (u) => {
      try {
        const r = await fetchImpl(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }), signal: AbortSignal.timeout(8000) });
        const j = await r.json(); if (j && /^0x[0-9a-f]+$/i.test(j.result || '')) heads.push(Number(BigInt(j.result)));
      } catch { /* an unreachable node is one fewer */ }
    }));
    heads.sort((a, b) => a - b);
    const close = heads.filter((h) => h >= (heads[heads.length - 1] || 0) - 5);
    return { ok: close.length >= need, detail: `${close.length} of ${nodes.length} nodes answered at about the same block` };
  },
});

export const explorerCheck = ({ bases, fetchImpl }) => ({
  name: 'Bitcoin explorers', required: true, fix: 'check this machine\'s outbound HTTPS, or set FB_LP_BTC_BASES to explorers you can reach',
  async run() {
    let ok = 0;
    await Promise.all(bases.map(async (b) => { try { const r = await fetchImpl(b + '/blocks/tip/height', { signal: AbortSignal.timeout(8000) }); if (r.ok && /^\d+$/.test((await r.text()).trim())) ok++; } catch { /* not reachable */ } }));
    return { ok: ok >= 1, detail: `${ok} of ${bases.length} answer` };
  },
});

// A page at `origin` can call the provider only if the answer carries the origin back
export const corsCheck = ({ base, origin, fetchImpl }) => ({
  name: `pages at ${origin} may call it`, required: true, fix: `add ${origin} to "origins" in the config`,
  async run() {
    const r = await fetchImpl(base + '/info', { headers: { origin }, signal: AbortSignal.timeout(8000) });
    const got = r.headers.get('access-control-allow-origin');
    return { ok: r.ok && got === origin, detail: r.ok ? (got === origin ? 'CORS answer is right' : `the answer allows "${got || 'nothing'}"`) : `/info answered ${r.status}` };
  },
});

export const quoteCheck = ({ base, minSats, fetchImpl }) => ({
  name: 'a quote at the minimum', required: true, fix: 'a provider with no price quotes nothing: check the price sources (Chainlink, Coinbase, Kraken) are reachable',
  async run() {
    const r = await fetchImpl(base + '/quote', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ amount: String(minSats) }), signal: AbortSignal.timeout(15000) });
    const j = await r.json().catch(() => ({}));
    return { ok: r.ok && !!j.id, detail: r.ok ? 'a quote came back' : `answered ${r.status}: ${String(j.error || '').slice(0, 120)}` };
  },
});

// ---- what the operator is told at the end ----------------------------------------------------------------------------------------------------

export function statusHelp({ port, listUrl = 'https://tacit.finance/btc/' }) {
  return [
    `  health   curl -s http://localhost:${port}/health          { "ok": true } while its loop runs`,
    `  terms    curl -s http://localhost:${port}/info             what it quotes now`,
    '           minAmount / maxAmount  the swap sizes it takes, in sats',
    '           available              the most it can lend this moment (null: not read yet); 0 means "full right now"',
    '           feeBps / flatFee       your terms, as quoted',
    '           stats                  swaps done, fees earned and the capacity it holds (once its first swap ends)',
    `  list     ${listUrl} : "Providers online", under your name`,
    '  or       node fastbridge-lp/setup.mjs status             the same, read for you',
  ].join('\n');
}

export function earnRiskText() {
  return [
    'What you earn: the fee on each swap, a share of the amount plus a flat part.',
    'What you risk: your capacity is tied up while a swap is open (up to about 16 hours if the user disappears, then it comes back); Bitcoin and Ethereum network fees; and',
    'the price moving in that time. All of it is bounded by your limits: no swap is larger than the maximum you set. Tacit never holds your funds: the key is yours.',
  ].join('\n');
}
