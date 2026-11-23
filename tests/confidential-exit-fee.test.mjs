// A TAC note's relayed exit is priced as cTAC (the pool row), not the public TAC row that shares its asset id, and a
// fee the relay refuses at submit is quoted once more at twice the floor before the user hears about it.
import { test } from 'node:test';
import assert from 'node:assert';
import { createHash } from 'node:crypto';
import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { hmac } from '../node_modules/@noble/hashes/hmac.js';
import { sha256 as nobleSha256 } from '../node_modules/@noble/hashes/sha2.js';
import { makeConfidentialPoolUx } from '../dapp/confidential-pool-ux.js';

const _cat = (arrs) => { const t = arrs.reduce((s, a) => s + a.length, 0); const o = new Uint8Array(t); let p = 0; for (const a of arrs) { o.set(a, p); p += a.length; } return o; };
secp.etc.hmacSha256Sync = (key, ...m) => hmac(nobleSha256, key, _cat(m));
const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const deps = { secp, keccak256: keccak_256, sha256, network: 'mainnet' };
const walletPriv = '0x' + '44'.repeat(32);
const TAC_FLOOR = 200000000n; // 2 TAC, the cTAC static floor in in-system units

// A relay that refuses any fee below `need` (as the live gate does) and records each submitted fee. Gas reads 0, so
// the client quotes the static floor.
function stubRelay(need) {
  const fees = [];
  const fetchImpl = async (url, opts) => {
    const body = opts && opts.body ? JSON.parse(opts.body) : {};
    if (String(url).endsWith('/confidential/submit')) {
      const fee = BigInt(body.op.fee);
      fees.push(fee);
      if (fee < need) return { ok: false, status: 400, statusText: 'Bad Request', text: async () => JSON.stringify({ error: 'submitJob: relay fee below the current floor — re-quote higher or self-settle' }) };
      return { ok: true, status: 200, text: async () => JSON.stringify({ jobId: 'j' + fees.length, status: 'pending' }) };
    }
    return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, result: '0x0' }), text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x0' }) };
  };
  return { fees, fetchImpl };
}

function tacNote(ux) {
  const w = ux.buildWrap({ walletPriv, amountWei: (250n * 10n ** 18n).toString(), ticker: 'cTAC', index: 0 });
  const events = [{ type: 'LeavesInserted', firstLeafIndex: 0, leaves: [w.leaf], memos: [w.memo] }];
  return ux.indexer.recover(events, walletPriv)[0];
}

test('a TAC note prices as the pool row: cTAC, with its relay floor', () => {
  const ux = makeConfidentialPoolUx({ ...deps, fetchImpl: async () => {} });
  const id = ux.assetByTicker.cTAC.assetId;
  assert.equal(ux.assetByTicker.TAC.assetId.toLowerCase(), id.toLowerCase(), 'the two rows share one asset id');
  assert.equal(ux.tickerOf(id), 'TAC', 'display keeps the first row');
  assert.equal(ux.poolTickerOf(id), 'cTAC', 'fees take the row the relay prices');
  assert.equal(ux.poolTickerOf(ux.assetByTicker.cETH.assetId), 'cETH');
});

test('a TAC exit is quoted the cTAC floor, not zero, and the relay takes it', async () => {
  const relay = stubRelay(TAC_FLOOR);
  const ux = makeConfidentialPoolUx({ ...deps, fetchImpl: relay.fetchImpl });
  const note = tacNote(ux);
  const r = await ux.unwrap({ note, walletPriv, wait: false });
  assert.equal(relay.fees.length, 1, 'accepted first time');
  assert.ok(relay.fees[0] >= TAC_FLOOR, `fee ${relay.fees[0]} covers the 2 TAC floor`);
  assert.equal(r.jobId, 'j1');
});

test('the farm reward (wTAC) exits at TAC\'s fee: the 2 TAC floor, not the ETH floor an unknown asset fell back to', async () => {
  const relay = stubRelay(TAC_FLOOR);
  const ux = makeConfidentialPoolUx({ ...deps, fetchImpl: relay.fetchImpl });
  const rid = ux.cfg.farm.rewardAsset;
  assert.equal(ux.poolTickerOf(rid), 'cTAC', 'fees take the TAC row');
  assert.equal(ux.relayFeeEligible(ux.poolTickerOf(rid)), true);
  assert.equal(ux.tickerOf(rid) === 'TAC' || ux.tickerOf(rid) === 'cTAC', false, 'display does not call it TAC');
  const wtac = { ...tacNote(ux), asset: rid };
  const r = await ux.unwrap({ note: wtac, walletPriv, wait: false });
  assert.equal(relay.fees.length, 1, 'accepted first time at the TAC floor');
  assert.ok(relay.fees[0] >= TAC_FLOOR, `fee ${relay.fees[0]} covers the 2 TAC floor`);
  assert.equal(r.jobId, 'j1');
  // A small reward is not exited below the floor: the fee is a floor, so a note under it cannot be relayed.
  const small = { ...wtac, value: '100000000' };
  await assert.rejects(ux.unwrap({ note: small, walletPriv, wait: false }), /./, 'a reward under the floor is refused before anything is sent');
});

test('a refused fee is quoted once more at twice the floor; refused again, the user gets plain words', async () => {
  const twice = stubRelay(TAC_FLOOR * 2n);
  const ux = makeConfidentialPoolUx({ ...deps, fetchImpl: twice.fetchImpl });
  const note = tacNote(ux);
  const r = await ux.unwrap({ note, walletPriv, wait: false });
  assert.deepEqual(twice.fees, [TAC_FLOOR, TAC_FLOOR * 2n], 'second try at twice the floor');
  assert.equal(r.jobId, 'j2');

  const never = stubRelay(10n ** 12n);
  const ux2 = makeConfidentialPoolUx({ ...deps, fetchImpl: never.fetchImpl });
  await assert.rejects(ux2.unwrap({ note: tacNote(ux2), walletPriv, wait: false }), (e) => e.code === 'FEE_MOVED' && /network fee rose/.test(e.message));
  assert.equal(never.fees.length, 2, 'no more than one retry');

  // A floor the caller set is never raised behind its back.
  const pinned = stubRelay(TAC_FLOOR * 2n);
  const ux3 = makeConfidentialPoolUx({ ...deps, fetchImpl: pinned.fetchImpl });
  await assert.rejects(ux3.unwrap({ note: tacNote(ux3), walletPriv, wait: false, feeOpts: { minFee: TAC_FLOOR } }), /fee below the current floor/);
  assert.equal(pinned.fees.length, 1);
});

test('send-out (part of a note) retries the same way', async () => {
  const relay = stubRelay(TAC_FLOOR * 2n);
  const ux = makeConfidentialPoolUx({ ...deps, fetchImpl: relay.fetchImpl });
  const note = tacNote(ux);
  const r = await ux.sendUnwrap({ note, walletPriv, recipient: '0x' + '12'.repeat(20), amount: BigInt(note.value) / 2n, wait: false });
  assert.equal(relay.fees.length, 2);
  assert.equal(relay.fees[1], TAC_FLOOR * 2n);
  assert.ok(r.jobId);
});

// The other relayed operations take the same self-settle: the relay proves, the caller's function sends the settle.
test('a note split (transfer) can be settled by the caller: proof only, no relay fee', async () => {
  const subs = [], sent = [];
  const fetchImpl = async (url, opts) => {
    const body = opts && opts.body ? JSON.parse(opts.body) : null;
    let obj;
    if (String(url).endsWith('/confidential/submit')) { subs.push(body); obj = { jobId: 'p1', status: 'pending' }; }
    else if (String(url).includes('/confidential/status')) obj = { jobId: 'p1', mode: 'prove', status: 'proven', publicValues: '0x03', proof: '0x04', memos: subs.at(-1).memos };
    else obj = { jsonrpc: '2.0', id: 1, result: '0x0' };
    return { ok: true, status: 200, json: async () => obj, text: async () => JSON.stringify(obj) };
  };
  const ux = makeConfidentialPoolUx({ ...deps, fetchImpl });
  // the relay's proof carries the op's leaves in its public values (PublicValues.leaves), as the pool emits them
  const w32 = (n) => BigInt(n).toString(16).padStart(64, '0'), pvOf = (leaves) => '0x' + w32(32) + w32(0).repeat(4) + w32(160) + w32(leaves.length) + leaves.map((l) => String(l).replace(/^0x/, '').padStart(64, '0')).join('');
  const realProve = ux.relay.prove;
  let pv = null;
  ux.relay.prove = async (spec, w) => { const p = await realProve(spec, w); pv = pvOf(spec.leaves); return { ...p, publicValues: pv }; };
  const note = tacNote(ux);
  const selfSettle = async (x) => { sent.push(x); return { txHash: '0x' + 'cd'.repeat(32) }; };
  const r = await ux.transfer({ walletPriv, notes: [note], recipientPubHex: ux.identity(walletPriv).pubHex, amount: BigInt(note.value) / 2n, fee: 0n, selfSettle, waitOpts: { intervalMs: 0, sleep: async () => {} } });
  assert.equal(subs.length, 1);
  assert.equal(subs[0].mode, 'prove', 'the relay is asked for the proof only');
  assert.equal(BigInt(subs[0].op.transfer?.fee ?? subs[0].op.fee ?? 0), 0n, 'no relay fee in the op');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].publicValues, pv); assert.equal(sent[0].proof, '0x04');
  assert.equal(r.txHash, '0x' + 'cd'.repeat(32));
});

test('the cETH floor follows the gas price, and is held to a thousand times the static floor however high a node says gas is', async () => {
  const at = (gwei) => {
    const fetchImpl = async (url, opts) => {
      const body = opts && opts.body ? JSON.parse(opts.body) : {};
      const one = (b) => ({ jsonrpc: '2.0', id: b.id ?? 1, result: b.method === 'eth_gasPrice' ? '0x' + (gwei * 10n ** 9n).toString(16) : '0x0' });
      const obj = Array.isArray(body) ? body.map(one) : one(body);
      return { ok: true, status: 200, json: async () => obj, text: async () => JSON.stringify(obj) };
    };
    return makeConfidentialPoolUx({ ...deps, fetchImpl });
  };
  const low = at(1n), scale = BigInt(low.assetByTicker.cETH.unitScale), cap = (10n ** 14n * 1000n) / scale;
  const f1 = await low.quoteOpFee('cETH', 'unwrap');
  assert.ok(f1 > 10n ** 14n / scale && f1 < cap, `at 1 gwei the floor (${f1}) is the gas cost, under the cap`);
  const huge = await at(1_000_000n).quoteOpFee('cETH', 'sendunwrap');
  assert.ok(huge >= cap && huge <= cap + cap / 10n, `at a million gwei the floor (${huge}) is held near ${cap}`);
});

// A token the pool holds by registration (SPX): the relay prices it through the pool that pairs it with tETH (the ratio of the reserves, less 20%) and refuses a relayed route or
// withdrawal that offers less than the gas floor. The page used to quote such a token 0 (it is in no fee table), so a person's SPX swap was combined, then turned back at submit:
// "relay fee below the current floor". Found by swapping a real SPX note to ETH with a real wallet on 2026-11-23.
const SPX_ID = '0x45addc633189749428e8fc36ea4ca067fcb4b0c7abc186a095360db10dbe0b48', SPX_ADDR = '0xe0f63a424a4439cbe457d80e4f4b51ad25b2c56c';
const R_ETH = 231_430_000n, R_SPX = 1_397_460_000_000n;                                  // 2.3143 tETH against 13,974.6 SPX, in pool units (the pool the live card quoted)
const word = (n) => BigInt(n).toString(16).padStart(64, '0');
// the pools(bytes32) read the SDK makes: init, assetA, assetB, reserveA, reserveB, feeBps, totalShares
const poolHex = (ux, rEth, rTok, feeBps) => {
  const eth = ux.assetByTicker.cETH.assetId.toLowerCase(), spxLow = BigInt(SPX_ID) <= BigInt(eth), [a, b] = spxLow ? [SPX_ID, eth] : [eth, SPX_ID], [ra, rb] = spxLow ? [rTok, rEth] : [rEth, rTok];
  return '0x' + word(1) + a.replace(/^0x/, '') + b.replace(/^0x/, '') + word(ra) + word(rb) + word(feeBps) + word(10n ** 12n);
};
function tokenUx({ pools = {}, need = 0n } = {}) {
  const fees = [], ref = {};
  const fetchImpl = async (url, opts) => {
    const body = opts && opts.body ? JSON.parse(opts.body) : {};
    if (String(url).endsWith('/confidential/submit')) {
      const fee = BigInt(body.op.fee); fees.push(fee);
      if (fee < need) return { ok: false, status: 400, statusText: 'Bad Request', text: async () => JSON.stringify({ error: 'submitJob: relay fee below the current floor — re-quote higher or self-settle' }) };
      return { ok: true, status: 200, text: async () => JSON.stringify({ jobId: 'j' + fees.length, status: 'pending' }) };
    }
    const one = (b) => {
      let result = '0x0';
      if (b.method === 'eth_call') {
        const data = String(b.params?.[0]?.data || '');
        if (data.length === 74) {                                                         // pools(bytes32): the selector and one word
          const id = ('0x' + data.slice(10)).toLowerCase();
          for (const [tier, st] of Object.entries(pools)) if (id === ref.ux.routePoolId(SPX_ID, ref.ux.assetByTicker.cETH.assetId, Number(tier)).toLowerCase()) result = poolHex(ref.ux, st[0], st[1], Number(tier));
        }
      }
      return { jsonrpc: '2.0', id: b.id ?? 1, result };
    };
    const obj = Array.isArray(body) ? body.map(one) : one(body);
    return { ok: true, status: 200, json: async () => obj, text: async () => JSON.stringify(obj) };
  };
  const ux = makeConfidentialPoolUx({ ...deps, fetchImpl });
  ref.ux = ux;
  ux.addAsset({ ticker: ux.tokenTicker(SPX_ADDR), assetId: SPX_ID, unitScale: '10000000000', decimals: 18 });
  return { ux, fees, ticker: ux.tokenTicker(SPX_ADDR) };
}
const ladder = (x) => { let d = 0n, t = x; while (t > 0n) { t /= 10n; d++; } if (d <= 2n) return x; const s = 10n ** (d - 2n); return ((x + s - 1n) / s) * s; };

test('a registered token is quoted a relay fee in the token, worth the tETH fee after the relay\'s 20% off a pool price', async () => {
  const { ux, ticker } = tokenUx({ pools: { 30: [R_ETH, R_SPX] } });
  const ethFee = await ux.quoteOpFee('cETH', 'route');                                  // gas reads 0 here: the static floor
  for (const kind of ['route', 'unwrap', 'sendunwrap']) {
    const fee = await ux.quoteOpFee(ticker, kind), tETH = await ux.quoteOpFee('cETH', kind);
    assert.ok(fee > 0n, `${kind}: the token's fee is not the 0 it was`);
    assert.ok(fee * R_ETH * 8000n >= BigInt(tETH) * R_SPX * 10000n, `${kind}: ${fee} units of the token are worth the ${tETH} units of tETH even at the relay's 20% haircut`);
    assert.ok(fee <= ladder((BigInt(tETH) * R_SPX * 10000n + R_ETH * 8000n - 1n) / (R_ETH * 8000n)), `${kind}: and no more than that, to the ladder's rounding`);
  }
  assert.equal(ethFee, 10000n, 'the static cETH floor the others are built on');
});

test('a transfer of the token stays free, as the relay carries a fee-less one', async () => {
  const { ux, ticker } = tokenUx({ pools: { 30: [R_ETH, R_SPX] } });
  assert.equal(await ux.quoteOpFee(ticker, 'transfer'), 0n);
});

test('a token no pool pairs with tETH keeps the 0 it had: there is nothing to value it by, for the relay either', async () => {
  const { ux, ticker } = tokenUx({ pools: {} });
  assert.equal(await ux.quoteOpFee(ticker, 'route'), 0n);
  assert.equal(await ux.quoteOpFee(ticker, 'unwrap'), 0n);
});

test('where several fee tiers hold the pair, the lowest tETH-per-token reading sets the fee, as the relay takes the lowest', async () => {
  const one = tokenUx({ pools: { 30: [R_ETH, R_SPX] } }), two = tokenUx({ pools: { 30: [R_ETH, R_SPX], 5: [R_ETH, R_SPX * 3n] } });   // the 5 bps pool pays three times the tokens per tETH
  const f1 = await one.ux.quoteOpFee(one.ticker, 'route'), f2 = await two.ux.quoteOpFee(two.ticker, 'route');
  assert.ok(f2 > f1 * 2n, `the cheaper reading (${f2}) is used, not the first (${f1})`);
});

test('a relay that holds the token to the gas floor takes the first submit: a withdrawal of a small SPX note is no longer turned back', async () => {
  const need = (10000n * R_SPX * 10000n + R_ETH * 8000n - 1n) / (R_ETH * 8000n);        // the floor in the token: 10,000 units of tETH at the pool's price less 20%
  const { ux, fees } = tokenUx({ pools: { 30: [R_ETH, R_SPX] }, need });
  const ticker = ux.tokenTicker(SPX_ADDR);
  const value = 5_435_491_969n;                                                          // the 54.35 SPX note: its old 0.3% fee (16.3 million units) is under the floor (75 million)
  assert.ok((value * 30n + 9999n) / 10000n < need, 'the fee it was given before is under the floor');
  const w = ux.buildWrap({ walletPriv, amountWei: (value * 10n ** 10n).toString(), ticker, index: 0 });
  const note = ux.indexer.recover([{ type: 'LeavesInserted', firstLeafIndex: 0, leaves: [w.leaf], memos: [w.memo] }], walletPriv)[0];
  const r = await ux.unwrap({ note, walletPriv, wait: false });
  assert.equal(fees.length, 1, 'accepted first time');
  assert.ok(fees[0] >= need, `the fee (${fees[0]}) clears the floor (${need})`);
  assert.ok(r.jobId);
});

// The floor comes from the gas price and the prove cost, which move a little every few seconds: quoted twice a moment apart it came out a ladder step or two different (0.00019 to 0.00024 ETH
// inside an hour on 2026-11-23) with nothing changed, so a press that held the fee it was shown against a fresh quote stopped on the difference ("the relay's fee moved … press once more"),
// about one withdrawal in two. A quote now stays where it was while the fresh figure is within a tenth of it (three minutes at most); a real move is followed at once.
const gasUx = (wei, need = 0n) => {
  const ref = { wei }, fees = [];
  const fetchImpl = async (url, opts) => {
    const body = opts && opts.body ? JSON.parse(opts.body) : {};
    if (String(url).endsWith('/confidential/submit')) {
      const fee = BigInt(body.op.fee); fees.push(fee);
      if (fee < need) return { ok: false, status: 400, statusText: 'Bad Request', text: async () => JSON.stringify({ error: 'submitJob: relay fee below the current floor — re-quote higher or self-settle' }) };
      return { ok: true, status: 200, text: async () => JSON.stringify({ jobId: 'j' + fees.length, status: 'pending' }) };
    }
    const one = (b) => ({ jsonrpc: '2.0', id: b.id ?? 1, result: b.method === 'eth_gasPrice' ? '0x' + ref.wei.toString(16) : '0x0' });
    const obj = Array.isArray(body) ? body.map(one) : one(body);
    return { ok: true, status: 200, json: async () => obj, text: async () => JSON.stringify(obj) };
  };
  return { ux: makeConfidentialPoolUx({ ...deps, fetchImpl }), ref, fees };
};
const withClock = async (fn) => { const real = Date.now; let t = real(); Date.now = () => t; try { return await fn({ advance: (ms) => { t += ms; } }); } finally { Date.now = real; } };
const GWEI = 10n ** 9n;

test('the quote holds still while gas jitters within a tenth, follows a real move at once, and lets go after three minutes', async () => {
  await withClock(async ({ advance }) => {
    const { ux, ref } = gasUx(50n * GWEI);
    const q0 = await ux.quoteOpFee('cETH', 'unwrap');
    for (const g of [53n, 48n, 54n, 46n, 51n]) {
      ref.wei = g * GWEI; advance(9000);                                                // the page's gas read is kept 8 s: each one is a fresh read
      assert.equal(await ux.quoteOpFee('cETH', 'unwrap'), q0, `at ${g} gwei the quote is still ${q0}`);
    }
    ref.wei = 80n * GWEI; advance(9000);
    const q1 = await ux.quoteOpFee('cETH', 'unwrap');
    assert.ok(q1 * 10n > q0 * 11n, `a real rise (${q0} to ${q1}) is followed at once`);
    ref.wei = 20n * GWEI; advance(9000);
    const q2 = await ux.quoteOpFee('cETH', 'unwrap');
    assert.ok(q2 * 10n < q1 * 9n, `and a real fall (${q1} to ${q2})`);
    ref.wei = 21_600_000_000n; advance(9000);
    assert.equal(await ux.quoteOpFee('cETH', 'unwrap'), q2, 'an 8% drift inside the three minutes holds');
    advance(181000);
    const q3 = await ux.quoteOpFee('cETH', 'unwrap');
    assert.ok(q3 > q2, `the same drift after three minutes is followed (${q2} to ${q3}): the quote does not stay behind the market for good`);
  });
});

test('each kind of op holds its own quote, and a ticker\'s other kinds are not dragged along', async () => {
  await withClock(async ({ advance }) => {
    const { ux, ref } = gasUx(50n * GWEI);
    const u0 = await ux.quoteOpFee('cETH', 'unwrap'), s0 = await ux.quoteOpFee('cETH', 'sendunwrap');
    assert.ok(s0 > u0, 'a withdrawal with change costs more than a whole note');
    ref.wei = 53n * GWEI; advance(9000);
    assert.equal(await ux.quoteOpFee('cETH', 'unwrap'), u0);
    assert.equal(await ux.quoteOpFee('cETH', 'sendunwrap'), s0);
  });
});

test('a fee the relay refuses lets go of the held quote, so the next quote is the fresh one', async () => {
  await withClock(async ({ advance }) => {
    const { ux, ref, fees } = gasUx(50n * GWEI, 3_000_000n);                           // the relay wants more than the 2.6 million the quote gives
    const q0 = await ux.quoteOpFee('cETH', 'unwrap');
    const w = ux.buildWrap({ walletPriv, amountWei: (10n ** 17n).toString(), ticker: 'cETH', index: 0 });
    const note = ux.indexer.recover([{ type: 'LeavesInserted', firstLeafIndex: 0, leaves: [w.leaf], memos: [w.memo] }], walletPriv)[0];
    ref.wei = 54n * GWEI; advance(9000);
    assert.equal(await ux.quoteOpFee('cETH', 'unwrap'), q0, 'inside the band, before any refusal, the held quote stands');
    const r = await ux.unwrap({ note, walletPriv, wait: false });
    assert.deepEqual(fees, [q0, q0 * 2n], 'refused at the held quote, then sent at twice it');
    assert.ok(r.jobId);
    advance(9000);
    const after = await ux.quoteOpFee('cETH', 'unwrap');
    assert.ok(after > q0, `after the refusal the quote is the fresh one (${after}), not the held ${q0}`);
  });
});
