// dapp/header-relay-advance.js — the plan/canonical-check/batching/orchestration a browser wallet or the CLI
// uses to push BitcoinLightRelay.advanceTip forward. Pure logic is exercised directly; network calls go
// through a tiny stubbed fetch keyed by URL, so these run with no RPC, no esplora and no wallet.
//
// Run: node tests/header-relay-advance.test.mjs
import assert from 'node:assert';
import { makeHeaderRelayAdvance } from '../dapp/header-relay-advance.js';

let n = 0; const ok = (s) => { console.log('  ok -', s); n++; };

// ── plan(): pure, no network ────────────────────────────────────────────────────────────────────────────────
{
  const advance = makeHeaderRelayAdvance({ fetchImpl: async () => { throw new Error('plan() must not touch the network'); } });

  assert.deepStrictEqual(
    advance.plan({ relayTip: 1000, btcTip: 1000, attested: null, confirmations: 24 }),
    { action: 'idle', pending: 0, useless: false },
  );
  ok('relay already at the (reorg-margin-adjusted) tip is idle');

  const oneNew = advance.plan({ relayTip: 1000, btcTip: 1003, attested: null, confirmations: 24 });
  assert.deepStrictEqual(oneNew, { action: 'advance', from: 1001, to: 1001, pending: 1, useless: false });
  ok('one new block (past the 2-block reorg margin) is advanced');

  const backlog = advance.plan({ relayTip: 1000, btcTip: 1200, attested: null, confirmations: 24 });
  assert.strictEqual(backlog.to, 1198); // btcTip - 2, no reflection number to cap against
  ok('with no reflection status, the cap is just the reorg margin');

  const capped = advance.plan({ relayTip: 1000, btcTip: 2000, attested: 1000, confirmations: 24 });
  assert.strictEqual(capped.to, 1000 + 24 + 110); // attested + confirmations + HEADER_LEAD
  ok('a live reflection caps the advance to attested+confirmations+lead, not the full backlog');

  const needMet = advance.plan({ relayTip: 1000, btcTip: 1200, attested: 900, confirmations: 24, need: 950 });
  assert.deepStrictEqual(needMet, { action: 'idle', pending: 0, useless: true });
  ok('a need already at or below the relay tip is idle and flagged useless');

  const needBeyond = advance.plan({ relayTip: 1000, btcTip: 1200, attested: 900, confirmations: 24, need: 1050 });
  assert.strictEqual(needBeyond.action, 'advance');
  assert.strictEqual(needBeyond.to, 1050);
  assert.strictEqual(needBeyond.useless, false);
  ok('a need beyond the tip drives the target directly, not just the lead cap');

  const aheadOfReflection = advance.plan({ relayTip: 1000, btcTip: 1200, attested: 900, confirmations: 24 });
  assert.strictEqual(aheadOfReflection.useless, true); // relayTip(1000) - confirmations(24) = 976 > attested(900)
  ok('advancing further while the relay already leads the reflection is flagged useless, not blocked');
}

// ── checkCanonical(): refuses on a mismatched tip, passes on a match ───────────────────────────────────────────
{
  const HASH = '11'.repeat(32); // internal byte order, as the relay stores it
  const REVERSED = HASH.match(/../g).reverse().join(''); // as an explorer would display it
  const fetchImpl = async (url) => {
    if (url.endsWith('/block-height/500')) return { ok: true, text: async () => REVERSED };
    throw new Error(`unexpected fetch: ${url}`);
  };
  const advance = makeHeaderRelayAdvance({ fetchImpl });

  await advance.checkCanonical({ relayTip: 500, relayTipHash: '0x' + HASH });
  ok('a matching canonical tip passes');

  await assert.rejects(
    () => advance.checkCanonical({ relayTip: 500, relayTipHash: '0x' + 'ff'.repeat(32) }),
    /needs fork recovery, not a plain advance/,
  );
  ok('a mismatched tip refuses with a clear message, not a guess');
}

// ── buildBatches(): ABI encoding and the 40-header batch bound ─────────────────────────────────────────────────
{
  const oneHeader = '11'.repeat(80); // an arbitrary fixed 80-byte header fixture
  const fetchImpl = async (url) => {
    if (/\/block-height\/\d+$/.test(url)) return { ok: true, text: async () => 'deadbeef' };
    if (/\/block\/deadbeef\/header$/.test(url)) return { ok: true, text: async () => oneHeader };
    throw new Error(`unexpected fetch: ${url}`);
  };
  const advance = makeHeaderRelayAdvance({ fetchImpl });

  const [single] = await advance.buildBatches({ from: 100, to: 100 });
  // Decode the calldata independently of the module's own construction (word-slicing, not string-building the
  // same way buildBatches does) — a hand-built "expected" string using the identical formula would silently
  // reproduce the same mistake it's meant to catch, which is exactly what an earlier draft of this test did.
  assert.strictEqual(single.data.slice(0, 10), '0xb09e9e05', 'advanceTip(bytes) selector');
  const words = single.data.slice(10);
  assert.strictEqual(words.length % 64, 0, 'every ABI word after the selector must be exactly 32 bytes');
  const offset = parseInt(words.slice(0, 64), 16);
  assert.strictEqual(offset, 32, 'the single dynamic `bytes` arg starts right after its own offset word');
  const length = parseInt(words.slice(64, 128), 16);
  assert.strictEqual(length, 80, 'one 80-byte header');
  const headerBytes = words.slice(128, 128 + length * 2);
  assert.strictEqual(headerBytes, oneHeader, 'the header bytes are carried through unmodified');
  const padding = words.slice(128 + length * 2);
  assert.strictEqual(padding.length, 32, '80 bytes pads by 16 zero bytes to the next 32-byte boundary');
  assert.ok(/^0+$/.test(padding), 'padding is zero, not garbage');
  assert.strictEqual(single.count, 1);
  ok('a single header decodes back to a well-formed advanceTip(bytes) call');

  const batches = await advance.buildBatches({ from: 1, to: 85 });
  assert.strictEqual(batches.length, 3); // 40 + 40 + 5
  assert.deepStrictEqual(batches.map((b) => b.count), [40, 40, 5]);
  assert.strictEqual(batches[0].from, 1);
  assert.strictEqual(batches[2].to, 85);
  ok('a backlog splits into batches of at most 40 headers');
}

// ── estimateGas(): a real RPC estimate with margin, never a hardcoded formula ───────────────────────────────────
{
  const fetchImpl = async (url, opts) => {
    const body = JSON.parse(opts.body);
    assert.strictEqual(body.method, 'eth_estimateGas');
    return { ok: true, json: async () => ({ result: '0x186a0' }) }; // 100000
  };
  const advance = makeHeaderRelayAdvance({ fetchImpl });
  const gas = await advance.estimateGas({ data: '0xdead', fromAddress: '0x' + '11'.repeat(20) });
  assert.strictEqual(gas, 125000n); // 100000 * 1.25
  ok('gas is a live estimate with a 25% margin, not a per-header formula');
}

// ── status(): shapes the three sources into one view, and derives behind/lag ────────────────────────────────────
{
  const RELAY_TIP_HEX = '0x' + (969315).toString(16).padStart(64, '0');
  const RELAY_TIP_HASH = '0x' + 'ab'.repeat(32);
  const fetchImpl = async (url, opts) => {
    if (opts?.body) {
      const body = JSON.parse(opts.body);
      if (body.method === 'eth_call' && body.params[0].data === '0x1fd4827a') return { ok: true, json: async () => ({ result: RELAY_TIP_HEX }) };
      if (body.method === 'eth_call' && body.params[0].data === '0x2755cd2d') return { ok: true, json: async () => ({ result: RELAY_TIP_HASH }) };
      throw new Error(`unexpected rpc: ${body.method} ${JSON.stringify(body.params)}`);
    }
    if (url.endsWith('/blocks/tip/height')) return { ok: true, text: async () => '969331' };
    if (url.includes('reflection/status')) return { ok: true, json: async () => ({ attestedHeight: 969291, confirmations: 24, burnDeposits: 1 }) };
    throw new Error(`unexpected fetch: ${url}`);
  };
  const advance = makeHeaderRelayAdvance({ fetchImpl });
  const st = await advance.status();
  assert.strictEqual(st.relayTip, 969315);
  assert.strictEqual(st.relayTipHash, RELAY_TIP_HASH);
  assert.strictEqual(st.btcTip, 969331);
  assert.strictEqual(st.behind, 16);
  assert.strictEqual(st.attested, 969291);
  assert.strictEqual(st.reflectionLag, 969315 - 24 - 969291); // 0, matching the live number this plan was written against
  assert.strictEqual(st.burnDeposits, 1);
  ok('status() reproduces the live relay/reflection numbers this feature was designed against');
}

// ── runAdvance(): the shared orchestration loop ─────────────────────────────────────────────────────────────────
{
  let tip = 1000;
  const HASH = '0x' + '11'.repeat(32);
  const REVERSED = '11'.repeat(32); // symmetric fixture: reversed form equals the forward form
  const oneHeader = '22'.repeat(80);
  const fetchImpl = async (url, opts) => {
    if (opts?.body) {
      const body = JSON.parse(opts.body);
      if (body.method === 'eth_call' && body.params[0].data === '0x1fd4827a') return { ok: true, json: async () => ({ result: '0x' + tip.toString(16).padStart(64, '0') }) };
      if (body.method === 'eth_call' && body.params[0].data === '0x2755cd2d') return { ok: true, json: async () => ({ result: HASH }) };
      if (body.method === 'eth_estimateGas') return { ok: true, json: async () => ({ result: '0x186a0' }) };
      throw new Error(`unexpected rpc: ${body.method}`);
    }
    if (url.endsWith(`/block-height/${tip}`)) return { ok: true, text: async () => REVERSED };
    if (/\/block-height\/\d+$/.test(url)) return { ok: true, text: async () => 'deadbeef' };
    if (/\/block\/deadbeef\/header$/.test(url)) return { ok: true, text: async () => oneHeader };
    if (url.endsWith('/blocks/tip/height')) return { ok: true, text: async () => '1003' }; // fixed: Bitcoin's tip doesn't move just because the relay does
    if (url.includes('reflection/status')) return { ok: false };
    throw new Error(`unexpected fetch: ${url}`);
  };
  const advance = makeHeaderRelayAdvance({ fetchImpl });

  const sentTxs = [];
  const progress = [];
  const heard = [];
  const result = await advance.runAdvance({
    fromAddress: '0x' + '11'.repeat(20),
    send: async (tx) => { const h = '0xtx' + sentTxs.length; sentTxs.push({ ...tx, h }); tip += 1; return h; }, // sending also advances the fixture's tip, like a real send would
    waitReceipt: async () => ({ status: '0x1' }),
    onProgress: (p) => progress.push(p),
    onPlan: (p) => heard.push(['plan', p]),
    onBatches: (b) => heard.push(['batches', b]),
  });

  assert.strictEqual(result.sent.length, 1); // btcTip-2 gives exactly one new header at the start
  assert.strictEqual(sentTxs.length, 1);
  assert.strictEqual(sentTxs[0].data.slice(0, 10), '0xb09e9e05');
  ok('runAdvance checks the canonical tip, plans, builds and sends exactly the pending headers');

  assert.deepStrictEqual(heard.map(([k]) => k), ['plan', 'batches']);
  assert.strictEqual(heard[0][1].action, 'advance');
  assert.strictEqual(heard[0][1].pending, 1);
  assert.strictEqual(heard[1][1].length, 1);
  assert.strictEqual(heard[1][1][0].data, sentTxs[0].data);
  ok('onPlan hears the plan and onBatches the exact batches this run then sends');

  // A second run against the now-advanced tip should find nothing left to do.
  const again = await advance.runAdvance({
    fromAddress: '0x' + '11'.repeat(20),
    send: async () => { throw new Error('should not send when there is nothing pending'); },
    waitReceipt: async () => ({ status: '0x1' }),
  });
  assert.strictEqual(again.action, 'idle');
  ok('a caught-up relay sends nothing on the next run');
}

// ── runAdvance(): a reverted receipt surfaces as an error, not a silent skip ─────────────────────────────────────
{
  const HASH = '0x' + '11'.repeat(32);
  const oneHeader = '22'.repeat(80);
  const fetchImpl = async (url, opts) => {
    if (opts?.body) {
      const body = JSON.parse(opts.body);
      if (body.method === 'eth_call' && body.params[0].data === '0x1fd4827a') return { ok: true, json: async () => ({ result: '0x' + (1000).toString(16).padStart(64, '0') }) };
      if (body.method === 'eth_call' && body.params[0].data === '0x2755cd2d') return { ok: true, json: async () => ({ result: HASH }) };
      if (body.method === 'eth_estimateGas') return { ok: true, json: async () => ({ result: '0x186a0' }) };
    }
    if (url.endsWith('/block-height/1000')) return { ok: true, text: async () => '11'.repeat(32) };
    if (/\/block-height\/\d+$/.test(url)) return { ok: true, text: async () => 'deadbeef' };
    if (/\/block\/deadbeef\/header$/.test(url)) return { ok: true, text: async () => oneHeader };
    if (url.endsWith('/blocks/tip/height')) return { ok: true, text: async () => '1003' };
    if (url.includes('reflection/status')) return { ok: false };
    throw new Error(`unexpected fetch: ${url}`);
  };
  const advance = makeHeaderRelayAdvance({ fetchImpl });
  await assert.rejects(
    () => advance.runAdvance({
      fromAddress: '0x' + '11'.repeat(20),
      send: async () => '0xtx0',
      waitReceipt: async () => ({ status: '0x0' }),
    }),
    /advanceTip reverted/,
  );
  ok('a reverted receipt throws instead of being reported as sent');
}

console.log(`\n${n} checks passed`);
