// /amm/farm-receipt (worker/src/index.js): the note an applied T_LP_UNBOND / T_LP_HARVEST / T_FARM_REFUND minted,
// from the receipt the scan writes before the op's farm update, served with the scan cursor. The dapp validator
// credits a farm-minted output only against it.
//
// Run: node tests/amm-farm-receipt-worker.test.mjs

import worker from '../worker/src/index.js';

function kv(entries = []) {
  const m = new Map(entries);
  return {
    m,
    async get(k, type) { if (!m.has(k)) return null; const v = m.get(k); return type === 'json' ? JSON.parse(v) : v; },
    async put(k, v) { m.set(k, String(v)); }, async delete(k) { m.delete(k); },
    async list({ prefix = '' } = {}) { return { keys: [...m.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name })), list_complete: true }; },
  };
}
async function call(env, network, txid) {
  const r = await worker.fetch(new Request(`https://api.tacit.finance/amm/farm-receipt?network=${network}&txid=${txid}`, { headers: { Origin: 'https://tacit.finance' } }), env, { waitUntil() {} });
  return { status: r.status, body: await r.json() };
}

let fails = 0;
const ok = (c, m, d = '') => { console.log((c ? 'ok   ' : 'FAIL ') + m + (c || !d ? '' : ` — ${d}`)); if (!c) fails++; };

const UNBOND = 'ab'.repeat(32), HARVEST = 'cd'.repeat(32), OTHER = 'ef'.repeat(32), FARM = '11'.repeat(32);
const C = '02' + '22'.repeat(32), R = '33'.repeat(32), LP = '44'.repeat(32), RW = '55'.repeat(32);

{
  const env = { REGISTRY_KV: kv([
    ['meta:last_scanned:mainnet', '900110'],
    [`ammfarmreceipt:mainnet:${UNBOND}`, JSON.stringify({ unbond_txid: UNBOND, farm_id: FARM, bond_id: '66'.repeat(32), kind: 'unbond',
      lp_return: { asset_id: LP, commitment: C, amount: '5000', r: R, vout: 1 } })],
    [`ammfarmreceipt:mainnet:${HARVEST}`, JSON.stringify({ unbond_txid: HARVEST, farm_id: FARM, bond_id: '66'.repeat(32), kind: 'harvest',
      reward: { asset_id: RW, commitment: C, amount: '70', r: R, vout: 1 } })],
  ]) };
  const a = await call(env, 'mainnet', UNBOND);
  ok(a.status === 200 && a.body.found === true && a.body.kind === 'unbond' && a.body.farm_id === FARM
    && a.body.note?.asset_id === LP && a.body.note?.commitment === C && a.body.note?.amount === '5000' && a.body.note?.r === R
    && a.body.note?.vout === 1 && a.body.scanned_height === 900110, 'an unbond: its lp_return note and the cursor', JSON.stringify(a.body));
  const b = await call(env, 'mainnet', HARVEST);
  ok(b.status === 200 && b.body.found === true && b.body.kind === 'harvest' && b.body.note?.asset_id === RW && b.body.note?.amount === '70',
    'a harvest: its reward note', JSON.stringify(b.body));
  const c = await call(env, 'mainnet', OTHER);
  ok(c.status === 200 && c.body.found === false && c.body.note === null && c.body.scanned_height === 900110,
    'no receipt: not found, with the cursor', JSON.stringify(c.body));
  const d = await call(env, 'signet', UNBOND);
  ok(d.status === 200 && d.body.found === false, 'a mainnet receipt is not read on signet', JSON.stringify(d.body));
  const e = await call(env, 'mainnet', UNBOND.toUpperCase());
  ok(e.status === 200 && e.body.found === true, 'txid is case-insensitive');
  const f = await call(env, 'mainnet', 'xyz');
  ok(f.status === 400, 'malformed txid → 400');
}

{
  // A KV read error is a 500, never a negative answer.
  const env = { REGISTRY_KV: { async get() { throw new Error('kv down'); }, async put() {}, async list() { return { keys: [], list_complete: true }; } } };
  const r = await call(env, 'mainnet', UNBOND);
  ok(r.status === 500 && r.body.found === undefined, 'a storage error is a 500, not found:false', JSON.stringify(r.body));
}

console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
