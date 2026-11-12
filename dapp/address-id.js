import { sha256, concatBytes } from './vendor/tacit-deps.min.js';

const te = new TextEncoder();
const TAG = te.encode('tacit-address-id-v1\0');

export function addressId(address) {
  const h = sha256(concatBytes(TAG, te.encode(String(address).toLowerCase().replace(/\s/g, ''))));
  const x = Array.from(h.subarray(0, 8), (b) => b.toString(16).padStart(2, '0')).join('');
  return `${x.slice(0, 4)}·${x.slice(4, 8)}·${x.slice(8, 12)}·${x.slice(12)}`;
}
