// replenishOnce, run for real against a stub RPC, asserting on the transactions it actually SIGNS.
//
// relay-self-funding.test.mjs pins the shape of the source; this pins the behaviour, because the property
// that matters — fee income earned on the settle wallet ends up as gas on BOTH wallets and as PROVE
// deposited by the RELAY wallet — is about who signs what and where each swap is delivered. A regex cannot
// see that, and an earlier bug in this same area (a wallet the monitor never looked at) passed every regex.
//
// Run: node tests/replenish-flow.test.mjs
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { startStub } from './helpers/replenish-rpc-stub.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(ROOT, 'worker-relay/package.json'));
const { privateKeyToAccount } = await import(require.resolve('viem/accounts'));

let pass = 0, fail = 0;
const ok = (c, m) => { if (!c) throw new Error(m); };
const test = async (label, fn) => {
  try { await fn(); console.log(`  PASS  ${label}`); pass++; }
  catch (e) { console.log(`  FAIL  ${label}: ${e.message}`); fail++; }
};

const RELAY_PK = '0x' + '11'.repeat(32), SETTLE_PK = '0x' + '22'.repeat(32);
const relay = privateKeyToAccount(RELAY_PK).address.toLowerCase();
const settle = privateKeyToAccount(SETTLE_PK).address.toLowerCase();
const A = {
  zQuoter: '0x000000a7dfdd39f4d74c7b201501ead119f8b86c', zRouter: '0x000000000000fb114709235f1ccbffb925f600e4',
  prove: '0x6bef15d938d4e72056ac92ea4bdd0d76b1c4ad29', vApp: '0x5ad5bc4b18f7c173dce17a57682cb0dc8788951f',
  usdc: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', usdt: '0xdac17f958d2ee523a2206206994597c13d831ec7', wsteth: '0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0', eth: '0x0000000000000000000000000000000000000000',
};
const ETH = (n) => BigInt(Math.round(n * 1e18));
const show = (x) => JSON.stringify(x, (_, v) => (typeof v === 'bigint' ? v.toString() : v));

// Pull the real ABI out of chain.js so the stub encodes exactly what the code decodes.
const chainSrc = (await import('node:fs')).readFileSync(join(ROOT, 'worker-relay/src/lib/chain.js'), 'utf8');
const abiSrc = chainSrc.slice(chainSrc.indexOf('export const ZQUOTER_ABI'), chainSrc.indexOf('];', chainSrc.indexOf('export const ZQUOTER_ABI')) + 2)
  .replace('export const ZQUOTER_ABI =', 'return');
const zQuoterAbi = new Function(abiSrc)();

async function run({ splitKeys = true, opts = { roles: ['settle'] }, feeAssets, balances, tokenBalances, extraEnv = {}, nonceRaceFor = [], badProveQuoteFactor = 0, badEthOutFactor = 0, badGasCostFactor = 0, fn = 'replenishOnce', fnArgs = null }) {
  const stub = await startStub({ balances, tokenBalances, zQuoterAbi, addr: A, nonceRaceFor, badProveQuoteFactor, badEthOutFactor, badGasCostFactor });
  const script = `const r = await import('${join(ROOT, 'worker-relay/src/replenish.js')}'); await r.${fn}(${JSON.stringify(fnArgs ?? opts)});`;
  const env = {
    PATH: process.env.PATH, WORKER_BASE: 'http://x', BOX_TOKEN: 't', RELAY_KEY: RELAY_PK,
    RPC_URL: stub.url, RPC_URLS_FALLBACK: stub.url, SETTLE_RPC_URL: stub.url, SETTLE_RPC_URLS: stub.url, SETTLE_ALLOW_PUBLIC: '0',
    FEE_ASSETS: feeAssets, ETH_GAS_BUFFER_WEI: String(ETH(0.01)),
    ...(splitKeys ? { SETTLE_KEY: SETTLE_PK } : {}), ...extraEnv,
  };
  // ASYNC spawn, deliberately: the stub server lives in THIS process, so a synchronous spawn would block the
  // event loop that has to answer the child's requests and deadlock the pair.
  const r = await new Promise((resolve) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { cwd: join(ROOT, 'worker-relay'), env });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => (stdout += d)); child.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve({ status: 'timeout', stdout, stderr }); }, 45_000);
    child.on('close', (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
  });
  await stub.close();
  if (r.status !== 0) throw new Error(`replenish exited ${r.status}: ${(r.stderr || r.stdout).split('\n').slice(-6).join(' | ')}`);
  return { sent: stub.sent, log: r.stdout };
}

// A swap the stub built is a marker + the recipient it was asked to deliver to.
const swaps = (sent) => sent.filter((t) => t.to === A.zRouter && t.data.startsWith('0xa11ce000')).map((t) => ({
  signer: t.from, exactOut: t.data.slice(10, 12) === '01', recipient: '0x' + t.data.slice(-40), value: t.value,
}));

console.log('replenish flow (real code, stub RPC):\n');

await test('split keys: fee income becomes gas for BOTH wallets and PROVE for the sink', async () => {
  const { sent } = await run({
    feeAssets: A.usdc,
    balances: { [settle]: ETH(0.001), [relay]: ETH(0.002) },
    tokenBalances: { [A.usdc]: { [settle]: 1_000_000_000n }, [A.prove]: { [relay]: 100n * 10n ** 18n } },
  });
  const s = swaps(sent);
  const gasEarner = s.find((x) => x.exactOut && x.recipient === settle);
  const gasSink = s.find((x) => x.exactOut && x.recipient === relay);
  const prove = s.find((x) => !x.exactOut && x.recipient === relay);
  ok(gasEarner, `no exact-out gas swap delivering to the settle wallet. swaps: ${show(s)}`);
  ok(gasSink, 'no exact-out gas swap delivering to the RELAY wallet (it earns nothing and would drain)');
  ok(prove, 'no PROVE swap delivering to the relay wallet');
  for (const x of s) ok(x.signer === settle, `a swap was signed by ${x.signer}, not the earner — fee assets live on the settle wallet`);
  ok(!s.some((x) => !x.exactOut && x.recipient === settle), 'PROVE was delivered to the settle wallet, where it cannot fund proving');
});

await test('split keys: the RELAY wallet, not the settle wallet, deposits to the vApp', async () => {
  const { sent } = await run({
    feeAssets: A.usdc,
    balances: { [settle]: ETH(0.001), [relay]: ETH(0.002) },
    tokenBalances: { [A.usdc]: { [settle]: 1_000_000_000n }, [A.prove]: { [relay]: 100n * 10n ** 18n } },
  });
  const toVapp = sent.filter((t) => t.to === A.vApp);
  ok(toVapp.length === 1, `expected exactly one vApp deposit, saw ${toVapp.length}`);
  ok(toVapp[0].from === relay, `the vApp deposit was signed by ${toVapp[0].from}, not the relay wallet — it would credit the wrong account`);
  ok(!sent.some((t) => t.to === A.vApp && t.from === settle), 'the settle wallet must never touch the vApp');
  // The approval PROVE -> vApp is the sink's, and must come before the deposit.
  const approve = sent.findIndex((t) => t.to === A.prove && t.from === relay);
  const deposit = sent.findIndex((t) => t.to === A.vApp);
  ok(approve > -1 && approve < deposit, 'the sink must approve PROVE to the vApp before depositing');
});

await test('split keys: native ETH is forwarded to the sink, and only genuine excess becomes PROVE', async () => {
  const { sent } = await run({
    feeAssets: A.eth, extraEnv: { ETH_SWEEP_ABOVE_WEI: String(ETH(0.02)) },
    balances: { [settle]: ETH(0.05), [relay]: ETH(0.002) },
    tokenBalances: { [A.prove]: { [relay]: 100n * 10n ** 18n } },
  });
  const xfer = sent.find((t) => t.from === settle && t.to === relay && t.value > 0n);
  ok(xfer, 'the earner never sent ETH to the sink');
  ok(xfer.value === ETH(0.008), `expected to top the sink up to the buffer (0.008), sent ${Number(xfer.value) / 1e18}`);
  const prove = swaps(sent).find((x) => !x.exactOut && x.recipient === relay);
  ok(prove, 'the excess over the sweep threshold was not converted to PROVE for the sink');
  // 0.05 - 0.008 forwarded = 0.042 left; only what exceeds the 0.02 float is converted.
  ok(prove.value === ETH(0.042) - ETH(0.02), `should convert only the excess over the float (0.022), converted ${Number(prove.value) / 1e18}`);
});

await test('an operator top-up is NOT swept into PROVE by default', async () => {
  // 0.05 ETH is above the 0.03 buffer, but it is a deliberate gas float, not revenue. The default sweep
  // threshold (0.1 ETH) must leave it alone — converting it would silently eat the operator's gas.
  const { sent } = await run({
    feeAssets: A.eth,
    balances: { [settle]: ETH(0.05), [relay]: ETH(0.05) },
    tokenBalances: { [A.prove]: { [relay]: 0n } },
  });
  ok(swaps(sent).length === 0, `converted an operator's gas float to PROVE: ${show(swaps(sent))}`);
  ok(!sent.some((t) => t.value > 0n), 'moved ETH around even though both wallets were already above the buffer');
});

await test('dust is held, not swapped (the 0.81 USDT case)', async () => {
  const { sent, log } = await run({
    feeAssets: A.usdc,
    balances: { [settle]: ETH(0.05), [relay]: ETH(0.05) },
    tokenBalances: { [A.usdc]: { [settle]: 810_000n }, [A.prove]: { [relay]: 0n } },
  });
  ok(swaps(sent).length === 0, `swapped dust: ${show(swaps(sent))}`);
  ok(/dust floor/.test(log), 'the hold must be logged so it is visible, not silent');
});

await test('a quote that is 100x off is refused, not sent', async () => {
  // An aggregator quote can be wildly off for a small amount (e.g. many multiples of fair value); the code
  // must catch an implausible quote itself, not depend on the transaction reverting at simulation.
  const { sent, log } = await run({
    feeAssets: A.usdc, badProveQuoteFactor: 100,
    balances: { [settle]: ETH(0.05), [relay]: ETH(0.05) },
    tokenBalances: { [A.usdc]: { [settle]: 1_000_000_000n }, [A.prove]: { [relay]: 0n } },
  });
  ok(!swaps(sent).some((x) => !x.exactOut), 'sent a PROVE swap on an implausible quote');
  ok(/REFUSING/.test(log) && /implausible/.test(log), 'the refusal must be logged');
});

await test('a sane quote on the same balance IS converted (the guard is not just refusing everything)', async () => {
  const { sent } = await run({
    feeAssets: A.usdc,
    balances: { [settle]: ETH(0.05), [relay]: ETH(0.05) },
    tokenBalances: { [A.usdc]: { [settle]: 1_000_000_000n }, [A.prove]: { [relay]: 0n } },
  });
  ok(swaps(sent).some((x) => !x.exactOut && x.recipient === relay), 'a plausible $1000 USDC balance was not converted to PROVE');
});

await test('wstETH is valued from its on-chain rate, not from an aggregator quote', async () => {
  // The valuation must not depend on the aggregator it is checking: a bad wstETH->ETH quote for a small
  // amount can appear worth orders of magnitude more than it is, wrongly refusing a good PROVE swap.
  const { sent, log } = await run({
    feeAssets: A.wsteth, badEthOutFactor: 100000, // the aggregator's wstETH->ETH quote is garbage
    balances: { [settle]: ETH(0.05), [relay]: ETH(0.05) },
    tokenBalances: { [A.wsteth]: { [settle]: ETH(0.5) }, [A.prove]: { [relay]: 0n } }, // ~0.6 ETH ~ $1100
  });
  ok(!/REFUSING/.test(log), `a sane wstETH balance was refused: ${log.split('\n').filter((l) => /REFUSING/.test(l))[0]}`);
  ok(swaps(sent).some((x) => !x.exactOut && x.recipient === relay), 'a wstETH balance worth ~$1100 must be converted to PROVE for the sink');
});

await test('an asset with no exact valuation is held, never guessed at', async () => {
  const { sent, log } = await run({
    feeAssets: '0x' + 'cd'.repeat(20),
    balances: { [settle]: ETH(0.05), [relay]: ETH(0.05) },
    tokenBalances: { ['0x' + 'cd'.repeat(20)]: { [settle]: 10n ** 20n } },
  });
  ok(swaps(sent).length === 0, 'swapped an asset it cannot value');
  ok(/cannot value/.test(log), 'the hold must be logged');
});

await test('gas top-up has hysteresis: a wallet only a little under the buffer is left alone', async () => {
  // buffer is 0.01 ETH in these tests; 0.007 is under it but not clearly low, so no swap should be sent.
  const { sent } = await run({
    feeAssets: A.usdc,
    balances: { [settle]: ETH(0.007), [relay]: ETH(0.007) },
    tokenBalances: { [A.usdc]: { [settle]: 1_000_000_000n }, [A.prove]: { [relay]: 0n } },
  });
  ok(!swaps(sent).some((x) => x.exactOut), `topped up gas although the wallets were not clearly low: ${show(swaps(sent))}`);
});

await test('a clearly-low wallet IS refilled to the buffer (hysteresis is not "never")', async () => {
  const { sent } = await run({
    feeAssets: A.usdc,
    balances: { [settle]: ETH(0.001), [relay]: ETH(0.05) },
    tokenBalances: { [A.usdc]: { [settle]: 1_000_000_000n }, [A.prove]: { [relay]: 0n } },
  });
  ok(swaps(sent).some((x) => x.exactOut && x.recipient === settle), 'a wallet at 10% of the buffer must be refilled');
});

await test('a broken wstETH gas quote is refused (the gas leg checks every asset, not just stablecoins)', async () => {
  const { sent, log } = await run({
    feeAssets: A.wsteth, badGasCostFactor: 1000,
    balances: { [settle]: ETH(0.001), [relay]: ETH(0.05) },
    tokenBalances: { [A.wsteth]: { [settle]: ETH(5) }, [A.prove]: { [relay]: 0n } },
  });
  ok(!swaps(sent).some((x) => x.exactOut), 'sent a gas swap on an implausible wstETH quote');
  ok(/REFUSING/.test(log) && /gas top-up/.test(log), 'the refusal must be logged');
});

await test('an asset that cannot be valued is held for gas too, not swapped', async () => {
  const odd = '0x' + 'cd'.repeat(20);
  const { sent, log } = await run({
    feeAssets: odd,
    balances: { [settle]: ETH(0.001), [relay]: ETH(0.05) },
    tokenBalances: { [odd]: { [settle]: 10n ** 20n } },
  });
  ok(swaps(sent).length === 0, 'swapped an asset it cannot value');
  ok(/cannot value/.test(log), 'the hold must be logged');
});

await test('a nonce race on the sink deposit is retried, not lost', async () => {
  const { sent } = await run({
    feeAssets: A.usdc, nonceRaceFor: [relay],
    balances: { [settle]: ETH(0.02), [relay]: ETH(0.02) },
    tokenBalances: { [A.usdc]: { [settle]: 1_000_000_000n }, [A.prove]: { [relay]: 100n * 10n ** 18n } },
  });
  const deposits = sent.filter((t) => t.to === A.vApp && t.from === relay);
  ok(deposits.length === 1, `expected the deposit to land exactly once after the retry, saw ${deposits.length}`);
});

await test('a sink already at its buffer is not topped up', async () => {
  const { sent } = await run({
    feeAssets: A.usdc,
    balances: { [settle]: ETH(0.001), [relay]: ETH(0.02) },
    tokenBalances: { [A.usdc]: { [settle]: 1_000_000_000n }, [A.prove]: { [relay]: 0n } },
  });
  ok(!swaps(sent).some((x) => x.exactOut && x.recipient === relay), 'bought gas for a sink that already had plenty');
  // Not vacuous: the earner is still low, so its OWN gas swap must have happened. Otherwise this passes
  // simply because nothing was bought at all.
  ok(swaps(sent).some((x) => x.exactOut && x.recipient === settle), 'the earner was low too, so its own gas swap must still run');
});

await test('gas-only mode: no PROVE swap and no vApp deposit', async () => {
  const { sent } = await run({
    opts: { roles: ['settle'], convertToProve: false },
    feeAssets: A.usdc,
    balances: { [settle]: ETH(0.001), [relay]: ETH(0.002) },
    tokenBalances: { [A.usdc]: { [settle]: 1_000_000_000n }, [A.prove]: { [relay]: 100n * 10n ** 18n } },
  });
  ok(!swaps(sent).some((x) => !x.exactOut), 'converted to PROVE in gas-only mode');
  ok(!sent.some((t) => t.to === A.vApp), 'deposited in gas-only mode');
  ok(swaps(sent).some((x) => x.exactOut), 'gas-only mode must still buy gas');
});

await test('consolidated keys: one wallet, nothing sent to itself, it deposits its own PROVE', async () => {
  const { sent } = await run({
    splitKeys: false, opts: { roles: ['settle'] },
    feeAssets: A.usdc,
    balances: { [relay]: ETH(0.001) },
    tokenBalances: { [A.usdc]: { [relay]: 1_000_000_000n }, [A.prove]: { [relay]: 100n * 10n ** 18n } },
  });
  ok(!sent.some((t) => t.to === relay), 'a consolidated wallet sent something to itself');
  const s = swaps(sent);
  ok(s.every((x) => x.signer === relay && x.recipient === relay), 'every swap must be signed by, and delivered to, the one wallet');
  ok(sent.some((t) => t.to === A.vApp && t.from === relay), 'the one wallet must deposit its own PROVE');
});

// ── key consolidation: drain the settle wallet into the relay wallet ─────────
const transfers = (sent, token) => sent.filter((t) => t.to === token && t.data.startsWith('0xa9059cbb')).map((t) => ({
  signer: t.from, to: '0x' + t.data.slice(34, 74), amount: BigInt('0x' + t.data.slice(74, 138)),
}));

await test('drain: every fee asset and the ETH move to the relay wallet, and the earner is left empty', async () => {
  const { sent } = await run({
    fn: 'drainToSink', fnArgs: { roles: ['settle'] }, feeAssets: [A.eth, A.usdc, A.usdt].join(','),
    balances: { [settle]: ETH(0.013), [relay]: ETH(0.015) },
    tokenBalances: { [A.usdc]: { [settle]: 5_000_000n }, [A.usdt]: { [settle]: 810_000n } },
  });
  const usdc = transfers(sent, A.usdc), usdt = transfers(sent, A.usdt);
  ok(usdc.length === 1 && usdc[0].amount === 5_000_000n && usdc[0].to === relay && usdc[0].signer === settle, `USDC not moved whole to the relay wallet: ${show(usdc)}`);
  ok(usdt.length === 1 && usdt[0].amount === 810_000n && usdt[0].to === relay, `USDT dust must move too: ${show(usdt)}`);
  const eth = sent.find((t) => t.from === settle && t.to === relay && t.data === '0x' && t.value > 0n);
  ok(eth, 'the ETH never moved');
  const left = ETH(0.013) - eth.value;
  ok(left > 0n && left < ETH(0.0001), `should leave only a small gas reserve, left ${Number(left) / 1e18}`);
  ok(eth.value > ETH(0.0129), 'should move nearly all of the ETH');
});

await test('drain: ERC20s go before ETH, while there is still gas to pay for them', async () => {
  const { sent } = await run({
    fn: 'drainToSink', fnArgs: { roles: ['settle'] }, feeAssets: [A.eth, A.usdc].join(','),
    balances: { [settle]: ETH(0.013), [relay]: ETH(0.015) },
    tokenBalances: { [A.usdc]: { [settle]: 5_000_000n } },
  });
  const erc = sent.findIndex((t) => t.to === A.usdc), eth = sent.findIndex((t) => t.data === '0x' && t.value > 0n);
  ok(erc > -1 && eth > -1 && erc < eth, 'the ETH transfer must come last, or the token transfers have no gas');
});

await test('drain: an ETH balance too small to cover its own transfer is left alone', async () => {
  const { sent } = await run({
    fn: 'drainToSink', fnArgs: { roles: ['settle'] }, feeAssets: A.eth,
    balances: { [settle]: 1_000_000_000n /* 1 gwei of wei — dust */, [relay]: ETH(0.015) },
    tokenBalances: {},
  });
  ok(!sent.some((t) => t.value > 0n), 'tried to send an ETH balance that cannot pay for its own transfer');
});

await test('drain: with consolidated keys there is nothing to move', async () => {
  const { sent, log } = await run({
    splitKeys: false, fn: 'drainToSink', fnArgs: { roles: ['settle'] }, feeAssets: [A.eth, A.usdc].join(','),
    balances: { [relay]: ETH(0.02) }, tokenBalances: { [A.usdc]: { [relay]: 5_000_000n } },
  });
  ok(sent.length === 0, `moved something although earner and sink are the same wallet: ${sent.length} txs`);
  ok(/already the relay wallet/.test(log), 'the no-op must say so');
});

const TAC = '0xa1313eb9f3a445606d9583bcac3ebeb56a858279';
const RESERVE = '0x006cd14f36f65ecbb29b2519ccbe63a0dc8549f2';
const tacTransfers = (sent) => sent.filter((t) => t.to === TAC && t.data.startsWith('0xa9059cbb'))
  .map((t) => ({ signer: t.from, to: '0x' + t.data.slice(34, 74), amount: BigInt('0x' + t.data.slice(74, 138)) }));

await test('TAC reserve: collected TAC moves whole to the reserve and is never swapped', async () => {
  const held = 526_926_800_000_000_000_000n;
  const { sent } = await run({
    feeAssets: A.usdc, extraEnv: { TAC_RESERVE_ADDR: RESERVE },
    balances: { [settle]: ETH(0.02), [relay]: ETH(0.02) },
    tokenBalances: { [TAC]: { [settle]: held } },
  });
  const t = tacTransfers(sent);
  ok(t.length === 1 && t[0].signer === settle && t[0].to === RESERVE && t[0].amount === held, `unexpected TAC transfers: ${show(t)}`);
  ok(!sent.some((x) => x.to === TAC && !x.data.startsWith('0xa9059cbb')), 'TAC must only ever be transferred, never approved for a swap');
});

await test('TAC reserve: below the threshold, or with no reserve set, TAC stays put', async () => {
  const below = await run({
    feeAssets: A.usdc, extraEnv: { TAC_RESERVE_ADDR: RESERVE },
    balances: { [settle]: ETH(0.02), [relay]: ETH(0.02) }, tokenBalances: { [TAC]: { [settle]: 99n * 10n ** 18n } },
  });
  ok(tacTransfers(below.sent).length === 0, 'swept below TAC_RESERVE_MIN_WEI');
  const unset = await run({
    feeAssets: A.usdc,
    balances: { [settle]: ETH(0.02), [relay]: ETH(0.02) }, tokenBalances: { [TAC]: { [settle]: 10n ** 24n } },
  });
  ok(tacTransfers(unset.sent).length === 0, 'swept with no TAC_RESERVE_ADDR');
});

await test('TAC reserve: runs in manual top-up mode too (FEE_ASSETS empty)', async () => {
  const { sent } = await run({
    feeAssets: '', extraEnv: { TAC_RESERVE_ADDR: RESERVE },
    balances: { [settle]: ETH(0.02), [relay]: ETH(0.02) }, tokenBalances: { [TAC]: { [settle]: 200n * 10n ** 18n } },
  });
  ok(tacTransfers(sent).length === 1, 'manual top-up mode skipped the reserve sweep');
});

const BUYBACK = '0x6919cbef0e70affa02ae02c86c532a137154f250';
const ethTo = (sent, to) => sent.filter((t) => t.to === to && t.data === '0x' && t.value > 0n);

await test('buyback share: that fraction of the ETH surplus goes to TacBuyback, before any PROVE', async () => {
  // Consolidated key, 0.6 ETH held, 0.1 ETH kept as the float -> 0.5 ETH surplus; 25% of it is 0.125 ETH.
  const { sent } = await run({
    splitKeys: false, feeAssets: A.eth, extraEnv: { BUYBACK_ADDR: BUYBACK, BUYBACK_SHARE_BPS: '2500' },
    balances: { [relay]: ETH(0.6) }, tokenBalances: {},
  });
  const t = ethTo(sent, BUYBACK);
  ok(t.length === 1 && t[0].from === relay && t[0].value === ETH(0.125), `unexpected buyback transfers: ${show(t)}`);
  const firstSwap = sent.findIndex((x) => x.to === A.zRouter);
  ok(firstSwap === -1 || sent.indexOf(t[0]) < firstSwap, 'the buyback share must leave before the surplus is swapped');
});

await test('buyback share: off by default, and nothing is sent without a real surplus', async () => {
  const off = await run({ splitKeys: false, feeAssets: A.eth, balances: { [relay]: ETH(0.6) }, tokenBalances: {} });
  ok(ethTo(off.sent, BUYBACK).length === 0, 'sent a buyback share with BUYBACK_SHARE_BPS unset');
  const float = await run({
    splitKeys: false, feeAssets: A.eth, extraEnv: { BUYBACK_ADDR: BUYBACK, BUYBACK_SHARE_BPS: '2500' },
    balances: { [relay]: ETH(0.09) }, tokenBalances: {},
  });
  ok(ethTo(float.sent, BUYBACK).length === 0, 'took a buyback share out of the gas float');
});

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
