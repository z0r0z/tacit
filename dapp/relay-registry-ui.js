// What a page needs to show and manage the relay registry (contracts/src/RelayRegistry.sol): the calls, their answers, and what each entry is in plain terms.
// No page code here (dapp/prove/pay-relays.js draws it), so the encoding and the reading are tested alone.
//
// `call(to, data)` → the hex an eth_call returns, as everywhere else on a page.

import { RELAY_REGISTRY } from './evm-pool-open-relays.js';

export { RELAY_REGISTRY };
export const TAC = '0xA1313eb9f3A445606D9583bcAc3ebeB56a858279';
const SEL = {
  count: '0x06661abd', minStake: '0x375b3c0a', unstakeDelay: '0x3222012f', relays: '0xe1137f19', urlOf: '0xcf5ad6e6',
  topUp: '0xde643a71', startExit: '0x06f3a401', finishExit: '0xa89b9144', setUrl: '0xaef95098',
  approve: '0x095ea7b3', allowance: '0xdd62ed3e', balanceOf: '0x70a08231',
};
const word = (n) => BigInt(n).toString(16).padStart(64, '0');
const addr = (a) => String(a).toLowerCase().replace(/^0x/, '').padStart(64, '0');
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

// the calls (each is { to, data }, ready for eth_call or a transaction)
export const calls = {
  count: () => ({ to: RELAY_REGISTRY, data: SEL.count }),
  minStake: () => ({ to: RELAY_REGISTRY, data: SEL.minStake }),
  unstakeDelay: () => ({ to: RELAY_REGISTRY, data: SEL.unstakeDelay }),
  relays: (id) => ({ to: RELAY_REGISTRY, data: SEL.relays + word(id) }),
  urlOf: (id) => ({ to: RELAY_REGISTRY, data: SEL.urlOf + word(id) }),
  topUp: (id, amount) => ({ to: RELAY_REGISTRY, data: SEL.topUp + word(id) + word(amount) }),
  startExit: (id) => ({ to: RELAY_REGISTRY, data: SEL.startExit + word(id) }),
  finishExit: (id) => ({ to: RELAY_REGISTRY, data: SEL.finishExit + word(id) }),
  setUrl: (id, url) => {
    const b = [...new TextEncoder().encode(url)].map((x) => x.toString(16).padStart(2, '0')).join('');
    return { to: RELAY_REGISTRY, data: SEL.setUrl + word(id) + word(64) + word(b.length / 2) + b.padEnd(Math.ceil(b.length / 64) * 64, '0') };
  },
  approve: (amount) => ({ to: TAC, data: SEL.approve + addr(RELAY_REGISTRY) + word(amount) }),
  allowance: (owner) => ({ to: TAC, data: SEL.allowance + addr(owner) + addr(RELAY_REGISTRY) }),
  balanceOf: (owner) => ({ to: TAC, data: SEL.balanceOf + addr(owner) }),
};

const num = (hex) => (typeof hex === 'string' && /^0x[0-9a-fA-F]{1,}$/.test(hex) && hex.length <= 66 ? BigInt(hex) : null);

// relays(id) → { relayer, chainId, pos, owner, exitAt, stake }, or null for an entry that does not exist (relayer zero) or an answer of another shape
export function decodeRelay(hex) {
  if (typeof hex !== 'string' || !/^0x[0-9a-fA-F]{384}$/.test(hex)) return null;
  const w = (i) => hex.slice(2 + i * 64, 2 + (i + 1) * 64);
  const a = (i) => `0x${w(i).slice(24)}`;
  if (BigInt(`0x${w(0)}`) === 0n) return null;
  return { relayer: a(0), chainId: Number(BigInt(`0x${w(1)}`)), pos: Number(BigInt(`0x${w(2)}`)), owner: a(3), exitAt: Number(BigInt(`0x${w(4)}`)), stake: BigInt(`0x${w(5)}`) };
}
// urlOf(id) → the string
export function decodeString(hex) {
  if (typeof hex !== 'string' || !/^0x(?:[0-9a-fA-F]{2})*$/.test(hex) || hex.length < 2 + 128) return null;
  const off = Number(BigInt(`0x${hex.slice(2, 66)}`));
  if (off !== 32) return null;
  const len = Number(BigInt(`0x${hex.slice(66, 130)}`));
  const body = hex.slice(130, 130 + len * 2);
  if (len > 256 || body.length !== len * 2) return null;
  let s = '';
  for (let i = 0; i < body.length; i += 2) s += String.fromCharCode(parseInt(body.slice(i, i + 2), 16));
  return s;
}

// Every entry the registry has made, with its url: `count()` entries read a few at a time. An entry that has left (its stake was paid out) is not there. Never throws:
// an entry that cannot be read is left out.
export async function readEntries({ call, limit = 300, width = 6 }) {
  const n = Math.min(limit, Number(num(await call(...Object.values(calls.count()))) ?? 0n));
  const ids = Array.from({ length: n }, (_, i) => i + 1);
  const out = [];
  for (let i = 0; i < ids.length; i += width) {
    const got = await Promise.all(ids.slice(i, i + width).map(async (id) => {
      try {
        const r = decodeRelay(await call(...Object.values(calls.relays(id))));
        if (!r) return null;
        return { id, ...r, url: decodeString(await call(...Object.values(calls.urlOf(id)))) ?? '' };
      } catch { return null; }
    }));
    out.push(...got.filter(Boolean));
  }
  return out;
}

// What an entry is, in plain terms, at `now` (unix seconds) with the registry's `minStake`:
//   listed   wallets may use it
//   below    its stake is under the minimum (a raised one): it is not shown to wallets until it is topped up
//   leaving  it has asked to leave and is waiting out the delay: `exitAt` says until when
//   ready    the wait is over: its owner can take the stake back
export function stateOf(e, { now, minStake }) {
  if (e.exitAt !== 0) return now >= e.exitAt ? 'ready' : 'leaving';
  return e.stake < minStake ? 'below' : 'listed';
}
export const mine = (entries, account) => (ADDRESS.test(String(account)) ? entries.filter((e) => e.owner.toLowerCase() === account.toLowerCase()) : []);

// The contract's rule for a url (a change of url is checked here before a transaction is asked for): https, a host that starts with a letter or a digit, then letters,
// digits and -._:/, ending /evm-pool/keeper, 25 to 128 bytes.
export function urlProblem(url) {
  const u = String(url ?? '');
  if (u.length < 25 || u.length > 128) return 'A relay address is 25 to 128 characters.';
  if (!u.startsWith('https://')) return 'It has to start with https://.';
  if (!u.endsWith('/evm-pool/keeper')) return 'It has to end with /evm-pool/keeper.';
  if (!/^[0-9A-Za-z]/.test(u.slice(8))) return 'The host has to start with a letter or a number.';
  if (!/^[0-9A-Za-z:.\-/_]+$/.test(u.slice(8))) return 'Only letters, numbers and - . _ : / are allowed after https://.';
  return null;
}

// "1,000 TAC" style amounts: wei (18 decimals) ↔ text
export const tacText = (wei) => {
  const w = BigInt(wei), whole = w / 10n ** 18n, frac = (w % 10n ** 18n).toString().padStart(18, '0').slice(0, 2).replace(/0+$/, '');
  return `${whole.toLocaleString('en-US')}${frac ? `.${frac}` : ''}`;
};
export function parseTac(text) {
  const t = String(text ?? '').trim().replace(/,/g, '');
  if (!/^\d+(?:\.\d{1,18})?$/.test(t)) return null;
  const [whole, frac = ''] = t.split('.');
  return BigInt(whole) * 10n ** 18n + BigInt(frac.padEnd(18, '0'));
}
