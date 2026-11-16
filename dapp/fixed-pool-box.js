// The deposit address of a name: the address that takes plain ETH from any wallet, bridge, exchange or paymaster and
// moves it into the owner's private balance (a receive box of the pool's router).
//
// A name publishes it as a second record, next to its Tacit address: `<n>:<ns>`, where `n` is the box's note key and
// `ns` the owner's signature of it under the view key inside the pool address the name points to. A payer derives the
// address from `n` and checks `ns` against that pool address, so a record that was swapped, copied from another name or
// made up names no address and pays no one. Nothing here sends anything.

import { poolKeysOf } from '/tacit-address.js?cb=00000000';
import { receiveBoxAddress, RECEIVE_FEE_BPS, EVM_POOL_ROUTER } from '/evm-pool-gateway.js?cb=00000000';
import { hex64, boxDigest, signBox, boxSigOk } from '/box-record.js?cb=00000000';

// The signature itself (what is signed, how it is made and checked) lives in box-record.js, which the Pay page's payment links share.
export { boxDigest, signBox, boxSigOk };

// The record's text for box key `n` (a bigint or 64 hex) and its signature.
export const boxValue = (n, ns) => `${hex64(typeof n === 'bigint' ? n : BigInt('0x' + String(n).replace(/^0x/, '')))}:${String(ns).replace(/^0x/, '')}`;

// A name's deposit address, checked: { name, pool, n, box }, `pool` being the pool address the name points to. `names` is
// a confidential-names instance. Throws, with a `code` of 'no-box' when the name has published none, 'bad-sig' when what
// it published is not signed by its own key.
export async function depositAddressOfName(names, name, router = EVM_POOL_ROUTER) {
  const r = await names.resolveName(name);
  if (!r.pool) throw Object.assign(new Error(`${r.name} points to an address with no pool key, so it has no deposit address to check.`), { code: 'no-pool' });
  const rec = await names.readBox(r.name);
  if (!rec) throw Object.assign(new Error(`${r.name} has not published a deposit address. They can publish it from Pay (Deposit, From an exchange), or give you the address.`), { code: 'no-box' });
  const V = poolKeysOf(r.pool).slice(0, 33);
  if (!boxSigOk(V, rec.n, rec.ns)) throw Object.assign(new Error(`The deposit address in ${r.name}'s record is not signed by ${r.name}'s own key, so it is not used.`), { code: 'bad-sig' });
  return { name: r.name, pool: r.pool, n: rec.n, box: receiveBoxAddress(BigInt('0x' + rec.n), RECEIVE_FEE_BPS, router) };
}
