// What the relay registry's `list(chainId, start, max)` returns, as ABI bytes: `entries` is [{ relayer, stake, url }] and `next` where to go on.
// The decoder (dapp/evm-pool-open-relays.js) is tested on this and on the registry's own answer.
const word = (n) => BigInt(n).toString(16).padStart(64, '0');

export function encodeList(entries, next) {
  const arr = (vals) => word(vals.length) + vals.join('');
  const relayers = arr(entries.map((e) => e.relayer.slice(2).toLowerCase().padStart(64, '0')));
  const stakes = arr(entries.map((e) => word(e.stake)));
  const strs = entries.map((e) => { const b = Buffer.from(e.url); return word(b.length) + b.toString('hex').padEnd(Math.ceil(b.length / 32) * 64, '0'); });
  let off = 32 * entries.length;
  const heads = strs.map((s) => { const h = word(off); off += s.length / 2; return h; });
  const urls = word(entries.length) + heads.join('') + strs.join('');
  const hA = 128, hS = hA + relayers.length / 2, hU = hS + stakes.length / 2;
  return '0x' + word(hA) + word(hS) + word(hU) + word(next) + relayers + stakes + urls;
}
