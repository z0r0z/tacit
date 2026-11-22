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
