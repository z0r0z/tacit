// Which leader a spend goes to. Every spend pays its fee to one leader's chain address, proved into it, so a spend is made for the leader whose turn
// it will land in: the seats contract names that leader for each slot (SLOT_BLOCKS blocks), and a seat holder says where it takes spends by
// announcing an endpoint (TacitSeats.announce, the Endpoint event). A slot nobody has an endpoint for goes to the house leader, as before.
//
//   const route = makeLeaderRoute({ seats, house: cfg.leader, from: seatsDeployBlock, rpcCall });
//   const t = await route.target();   → { base, leader (address or null), slot, until (ms: the proof is good for this leader until then), routed }
//
// A leader builds a block when its turn has begun, so a spend handed over a little early for the next slot waits there until the slot starts. Within
// HANDOVER_SECONDS of a slot's end a spend is made for the next slot's leader; the proof is good for its leader until that slot ends less the same.
import { keccak_256 } from './vendor/tacit-deps.min.js';

const te = new TextEncoder();
const hx = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const sel = (sig) => hx(keccak_256(te.encode(sig)).slice(0, 4));
const topic = (sig) => '0x' + hx(keccak_256(te.encode(sig)));
const strip = (h) => String(h).replace(/^0x/, '').toLowerCase();
const num = (h) => Number(BigInt('0x' + (strip(h) || '0')));

export const SLOT_SECONDS = 12;
export const HANDOVER_SECONDS = 120;
const ENDPOINT_TOPIC = topic('Endpoint(address,string)');
const MISS_MS = 5 * 60e3, HOLD_MS = 60e3;

/// An announced endpoint as the base URL to talk to, or null: an https origin (a path is dropped), no credentials, a DNS name (no address literal), nothing long.
export function endpointBase(url) {
  if (typeof url !== 'string' || url.length > 200) return null;
  let u;
  try { u = new URL(url.trim()); } catch { return null; }
  if (u.protocol !== 'https:' || u.username || u.password || !/^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z][a-z0-9-]*$/i.test(u.hostname)) return null;
  return u.origin;
}

/// The string an Endpoint log carries (its data is one ABI-encoded string), or null.
export function endpointOf(data) {
  const d = strip(data);
  if (d.length < 128 || Number('0x' + d.slice(0, 64)) !== 32) return null;
  const n = Number('0x' + d.slice(64, 128));
  if (!Number.isSafeInteger(n) || n > 200 || d.length < 128 + 2 * n) return null;
  try { return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(d.slice(128, 128 + 2 * n).match(/../g) || [], (x) => parseInt(x, 16))); } catch { return null; }
}

export function makeLeaderRoute({ seats, house, rpcCall, from = 0, handover = HANDOVER_SECONDS, now = () => Date.now() }) {
  if (!seats || !house) throw new Error('tacit chain: a seats contract and a house leader');
  const call = async (sig, args = '') => strip(await rpcCall('eth_call', [{ to: seats, data: '0x' + sel(sig) + args }, 'latest']));
  const ends = new Map();                                          // address → { base | null, at }
  let slotBlocks = null, held = null;

  async function endpoint(address) {
    const key = strip(address), hit = ends.get(key);
    if (hit && now() - hit.at < (hit.base ? 10 * 60e3 : MISS_MS)) return hit.base;
    let base = hit?.base ?? null;
    try {
      const logs = await rpcCall('eth_getLogs', [{ address: seats, topics: [ENDPOINT_TOPIC, '0x' + key.padStart(64, '0')], fromBlock: '0x' + from.toString(16), toBlock: 'latest' }]);
      // the latest announcement stands (a holder moves its endpoint by announcing again); one that is not a plain https origin is none
      const last = (logs || []).slice().sort((a, b) => num(a.blockNumber) - num(b.blockNumber) || num(a.logIndex) - num(b.logIndex)).pop();
      base = last ? endpointBase(endpointOf(last.data)) : null;
    } catch { /* a node that refuses logs: the last answer stands, else the house */ }
    ends.set(key, { base, at: now() });
    return base;
  }

  /// Where a spend made now goes. Anything that cannot be read is the house leader, with no end to its proof.
  async function target() {
    const houseT = { base: house, leader: null, slot: null, until: Infinity, routed: false };
    if (held && now() < held.valid) return held.t;
    try {
      slotBlocks ??= num(await call('SLOT_BLOCKS()'));
      if (!(slotBlocks > 0)) { slotBlocks = null; return houseT; }
      const blk = await rpcCall('eth_getBlockByNumber', ['latest', false]);
      const n = num(blk.number), seen = num(blk.timestamp) * 1000;
      const slot = Math.floor(n / slotBlocks);
      // seconds to this slot's end, from the latest block's own time
      const left = Math.max(0, (slotBlocks - (n % slotBlocks)) * SLOT_SECONDS - Math.max(0, now() - seen) / 1000);
      const next = left < handover, at = next ? (slot + 1) * slotBlocks : n;
      const who = '0x' + (await call('leaderAt(uint256)', at.toString(16).padStart(64, '0'))).slice(24);
      const zero = /^0x0{40}$/.test(who);
      const base = zero ? null : await endpoint(who);
      // the target stands until the slot's end less the handover (a spend made for the next slot's leader, until that slot's end less it)
      const until = now() + (left + (next ? slotBlocks * SLOT_SECONDS : 0) - handover) * 1000;
      const t = { ...houseT, base: base || house, leader: zero ? null : who, slot: slot + (next ? 1 : 0), routed: !!base, ...(base ? { until } : {}) };
      // read again at the most in a minute, and when the target is to change (the handover begins)
      held = { t, valid: Math.min(now() + HOLD_MS, next ? until : now() + (left - handover) * 1000) };
      return t;
    } catch { return houseT; }
  }
  return { target, endpoint };
}
