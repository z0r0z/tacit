// Name lookup for private sends. A person publishes their Tacit address as the `finance.tacit` text record
// of a name they own, and a sender types the name instead of the tacit1… string.
//
// Three name services are read, always on Ethereum mainnet regardless of the network the page is on:
//   .wei   WNS  registry and resolver in one contract
//   .gwei  GNS  same contract shape as WNS
//   .eth   ENS  registry → resolver, direct for the name's own node, ENSIP-10 resolve() for an ancestor's
//               wildcard resolver; a resolver that answers with an off-chain lookup is refused (no CCIP-read)
//
// The record value is the tacit1… address, trimmed and otherwise untouched. A decoded address must be the
// unified layout [0x00][flags][spend 33][scan 33][Ethereum lane 33] with the Ethereum-lane bit set; the
// Ethereum-lane key is what a private send pays. Resolutions are never cached: each call reads the chain.
//
// Everything on the wire goes through `call({ to, data, from? })` (an eth_call that throws CallRevert on a
// revert) and, for writes, `send({ from, to, data })` supplied by the caller's wallet.

import { decodeBech32m } from './tacit-address.js';

export const RECORD_KEY = 'finance.tacit';
export const WNS = '0x0000000000696760E15f265e828DB644A0c242EB';
export const GNS = '0x9D51D507BC7264d4fE8Ad1cf7Fe191933A0a81d6';
export const ENS_REGISTRY = '0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e';
export const MAINNET_RPCS = [
  'https://ethereum-rpc.publicnode.com',
  'https://1rpc.io/eth',
  'https://eth.llamarpc.com',
  'https://eth.drpc.org',
];

const SEL = {
  text: '59d1d43c',            // text(bytes32,string)
  setTextId: '3fb24782',       // setText(uint256,string,string)     WNS / GNS
  setTextNode: '10f13a8c',     // setText(bytes32,string,string)     ENS resolver
  resolverOf: '0178b8bf',      // resolver(bytes32)                  ENS registry
  resolveWild: '9061b923',     // resolve(bytes,bytes)               ENSIP-10
  reverseResolve: '9af8b7aa',  // reverseResolve(address)            WNS / GNS
  resolveId: '4f896d4f',       // resolve(uint256)                   WNS / GNS forward
  addr: '3b3b57de',            // addr(bytes32)
  name: '691f3431',            // name(bytes32)
  offchainLookup: '556f1830',  // OffchainLookup(address,string[],bytes,bytes4,bytes)
  errorString: '08c379a0',     // Error(string)
};

export class NameError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'NameError';
    this.code = code;
    Object.assign(this, extra);
  }
}

// A reverted eth_call. `data` is the revert payload (hex) when the node returned one.
export class CallRevert extends Error {
  constructor(message = 'execution reverted', data = null) {
    super(message);
    this.name = 'CallRevert';
    this.data = data;
  }
}

const enc = new TextEncoder();
const dec = new TextDecoder('utf-8', { fatal: true });
const hexOf = (u8) => Array.from(u8, (x) => x.toString(16).padStart(2, '0')).join('');
const bytesOf = (hex) => Uint8Array.from((String(hex).replace(/^0x/, '').match(/../g) || []).map((h) => parseInt(h, 16)));
const word = (hex) => String(hex).replace(/^0x/, '').toLowerCase().padStart(64, '0');
const numWord = (n) => BigInt(n).toString(16).padStart(64, '0');
const padTo32 = (hex) => hex + '0'.repeat((64 - (hex.length % 64)) % 64);
const ZERO_ADDR = /^0{40}$/;

// ABI string / bytes tail: length word then the data padded to a word boundary.
const tail = (u8) => numWord(u8.length) + padTo32(hexOf(u8));

// ABI-decode a `string` or `bytes` return: [offset][len][data] with the offset pointing at the length word.
function decodeDynamic(out, at = 0) {
  const h = String(out || '').replace(/^0x/, '');
  if (h.length < 64 * (at + 1)) throw new NameError('bad-response', 'short reply from the name service');
  const off = Number(BigInt('0x' + h.slice(64 * at, 64 * (at + 1))));
  const lenAt = off * 2;
  if (!Number.isSafeInteger(off) || h.length < lenAt + 64) throw new NameError('bad-response', 'malformed reply from the name service');
  const len = Number(BigInt('0x' + h.slice(lenAt, lenAt + 64)));
  if (!Number.isSafeInteger(len) || h.length < lenAt + 64 + len * 2) throw new NameError('bad-response', 'truncated reply from the name service');
  return bytesOf(h.slice(lenAt + 64, lenAt + 64 + len * 2));
}
const decodeString = (out) => {
  try { return dec.decode(decodeDynamic(out)); } catch (e) {
    if (e instanceof NameError) throw e;
    throw new NameError('bad-response', 'the name service returned text that is not valid UTF-8');
  }
};
function decodeAddressWord(out) {
  const h = String(out || '').replace(/^0x/, '');
  if (h.length < 64) return null;
  const a = h.slice(24, 64);
  return ZERO_ADDR.test(a) ? null : '0x' + a;
}

// Any thrown error that carries revert data, or is a CallRevert, is a contract revert; everything else is a
// transport failure and is not swallowed into "no record".
const isRevert = (e) => e instanceof CallRevert || (e && (e.code === 3 || (typeof e.data === 'string' && /^0x/i.test(e.data))));
const revertData = (e) => String((e && e.data) || '').replace(/^0x/, '').toLowerCase();
const isOffchainRevert = (e) => revertData(e).startsWith(SEL.offchainLookup);

// eth_call over a list of mainnet RPCs. A revert is definitive and thrown as CallRevert; a transport or node
// error moves on to the next endpoint. `from` is set only for simulating a write.
//
// An answer must be given IDENTICALLY by `agree` endpoints before it is returned. What these calls decide is the
// key a private send pays, so a single endpoint that lies about one text record sends the money to whoever wrote
// the lie, with nothing on screen to show for it — and a public endpoint is exactly the party in a position to do
// that. Endpoints are read in order until two match, so the usual cost is two requests. No majority, a set that
// disagrees, or too few endpoints answering is a refusal, never a resolution: a name that cannot be looked up is
// recoverable (retry, or paste the address), a payment to the wrong key is not. A revert stays definitive on the
// first endpoint that reports one — it yields no address, so the worst a faked revert can do is refuse the name.
export function makeMainnetCall({ fetchImpl, rpcs = MAINNET_RPCS, timeoutMs = 10000, agree = 2 } = {}) {
  const f = fetchImpl || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
  // A caller that configures a single endpoint has nothing to compare against and gets that endpoint's word.
  const need = Math.max(1, Math.min(agree, rpcs.length));
  return async function call({ to, data, from }) {
    if (!f) throw new NameError('rpc', 'no fetch implementation');
    const tx = { to: String(to).toLowerCase(), data };
    if (from) tx.from = String(from).toLowerCase();
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [tx, 'latest'] });
    const answers = new Map(); // normalized reply -> how many endpoints returned it
    let lastErr = null, replies = 0;
    for (const url of rpcs) {
      let out;
      try {
        const r = await f(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(timeoutMs) });
        if (!r.ok) { lastErr = new Error(`rpc ${r.status}`); continue; }
        const j = await r.json();
        if (j && j.error) {
          const d = j.error.data;
          if (j.error.code === 3 || (typeof d === 'string' && /^0x/i.test(d))) throw new CallRevert(j.error.message, typeof d === 'string' ? d : null);
          lastErr = new Error(j.error.message || 'rpc error');
          continue;
        }
        out = j ? j.result : '0x';
      } catch (e) {
        if (e instanceof CallRevert) throw e;
        lastErr = e;
        continue;
      }
      replies++;
      const key = String(out == null ? '' : out).toLowerCase();
      const seen = (answers.get(key) || 0) + 1;
      answers.set(key, seen);
      if (seen >= need) return out;
    }
    if (answers.size > 1) {
      throw new NameError('rpc-disagreement', `Ethereum endpoints returned ${answers.size} different answers for this lookup, so it cannot be trusted. Try again, or paste the recipient's tacit1… address.`);
    }
    throw new NameError('rpc', `could not reach ${need} Ethereum endpoints that agree (${replies} answered; ${(lastErr && lastErr.message) || 'all endpoints failed'})`);
  };
}

export function makeConfidentialNames({ call, send = null, secp, keccak256 }) {
  if (typeof call !== 'function') throw new Error('confidential-names: call is required');
  if (!secp || !keccak256) throw new Error('confidential-names: secp and keccak256 are required');

  const selector = (sig) => hexOf(keccak256(enc.encode(sig)).slice(0, 4));

  // ── names ──
  function normalizeName(name) {
    const n = String(name == null ? '' : name).toLowerCase();
    if (!/^[a-z0-9.-]+$/.test(n)) throw new NameError('bad-name', 'Names may use only letters a–z, digits, hyphens and dots.');
    if (n.split('.').some((l) => l === '')) throw new NameError('bad-name', 'That name has an empty label (a leading, trailing or doubled dot).');
    return n;
  }

  function namehash(name) {
    const n = normalizeName(name);
    let node = new Uint8Array(32);
    for (const label of n.split('.').reverse()) {
      const buf = new Uint8Array(64);
      buf.set(node, 0);
      buf.set(keccak256(enc.encode(label)), 32);
      node = keccak256(buf);
    }
    return '0x' + hexOf(node);
  }

  // Which service owns a name. .base.eth names live off mainnet and are not read here.
  function classify(name) {
    const n = normalizeName(name);
    const labels = n.split('.');
    if (labels.length < 2) throw new NameError('unsupported-name', 'Enter a full name such as alice.wei, alice.gwei or alice.eth.');
    const tld = labels[labels.length - 1];
    if (tld === 'wei') return { name: n, source: 'WNS', contract: WNS };
    if (tld === 'gwei') return { name: n, source: 'GNS', contract: GNS };
    if (tld === 'eth' && n !== 'base.eth' && !n.endsWith('.base.eth')) return { name: n, source: 'ENS' };
    throw new NameError('unsupported-name', 'Only names ending in .wei, .gwei or .eth can be looked up (.base.eth is not supported).');
  }

  // A recipient field entry is name-like when it has a dot and no whitespace; hex, bech32 and 0x forms never do.
  const looksLikeName = (raw) => /^\S+$/.test(String(raw || '').trim()) && String(raw).includes('.');

  function dnsName(name) {
    const out = [];
    for (const label of normalizeName(name).split('.')) {
      const b = enc.encode(label);
      if (b.length > 63) throw new NameError('bad-name', 'A label in that name is longer than 63 characters.');
      out.push(b.length, ...b);
    }
    out.push(0);
    return Uint8Array.from(out);
  }

  // ── calldata ──
  const textCalldata = (node, key) => '0x' + SEL.text + word(node) + numWord(64) + tail(enc.encode(key));
  const addrCalldata = (node) => '0x' + SEL.addr + word(node);
  const wildCalldata = (name, inner) => {
    const dns = dnsName(name);
    const innerBytes = bytesOf(inner);
    const off2 = 64 + 32 + Math.ceil(dns.length / 32) * 32;
    return '0x' + SEL.resolveWild + numWord(64) + numWord(off2) + tail(dns) + tail(innerBytes);
  };
  const setTextIdCalldata = (tokenId, key, value) => {
    const k = enc.encode(key);
    const off2 = 96 + 32 + Math.ceil(k.length / 32) * 32;
    return '0x' + SEL.setTextId + numWord(tokenId) + numWord(96) + numWord(off2) + tail(k) + tail(enc.encode(value));
  };
  const setTextNodeCalldata = (node, key, value) => {
    const k = enc.encode(key);
    const off2 = 96 + 32 + Math.ceil(k.length / 32) * 32;
    return '0x' + SEL.setTextNode + word(node) + numWord(96) + numWord(off2) + tail(k) + tail(enc.encode(value));
  };

  // A revert with the off-chain marker is refused loudly; any other revert means "nothing there".
  async function guardedCall(req) {
    try { return await call(req); } catch (e) {
      if (!isRevert(e)) throw e;
      if (isOffchainRevert(e)) {
        throw new NameError('offchain', 'This name keeps its records off-chain, which is not supported here. Ask them to store the record on-chain.');
      }
      return null;
    }
  }
  const emptyOut = (o) => o == null || /^(0x)?$/.test(o);

  // ── ENS ──
  async function ensResolver(name) {
    const labels = normalizeName(name).split('.');
    for (let i = 0; i < labels.length; i++) {
      const anc = labels.slice(i).join('.');
      const out = await guardedCall({ to: ENS_REGISTRY, data: '0x' + SEL.resolverOf + word(namehash(anc)) });
      const r = emptyOut(out) ? null : decodeAddressWord(out);
      if (r) return { resolver: r, atName: i === 0, node: namehash(name) };
      if (anc === 'eth') break;
    }
    return null;
  }

  // Ask an ENS resolver for `inner` (text or addr calldata) about `name`: directly when it sits on the name's
  // own node, through the wildcard entry point when it sits on an ancestor. Returns the raw inner-shaped reply.
  async function ensQuery(name, inner) {
    const found = await ensResolver(name);
    if (!found) return { found: null, out: null };
    const req = found.atName
      ? { to: found.resolver, data: inner }
      : { to: found.resolver, data: wildCalldata(name, inner) };
    const raw = await guardedCall(req);
    if (emptyOut(raw)) return { found, out: null };
    if (found.atName) return { found, out: raw };
    try { return { found, out: '0x' + hexOf(decodeDynamic(raw)) }; } catch (e) {
      if (e instanceof NameError) return { found, out: null };
      throw e;
    }
  }

  // ── record reads ──
  // The raw record for a name, trimmed, or null when there is none. Never decoded here.
  async function readRecord(name) {
    const c = classify(name);
    const node = namehash(c.name);
    let out;
    if (c.source === 'ENS') {
      ({ out } = await ensQuery(c.name, textCalldata(node, RECORD_KEY)));
    } else {
      out = await guardedCall({ to: c.contract, data: textCalldata(node, RECORD_KEY) });
    }
    if (emptyOut(out)) return null;
    const value = decodeString(out).trim();
    return value === '' ? null : value;
  }

  // Strict decoder for the record value: bech32m "tacit" address, 101-byte payload, version 0, Ethereum lane
  // flagged, Ethereum-lane key (last 33 bytes) a valid secp256k1 point.
  function decodeTacitAddress(value) {
    const s = String(value == null ? '' : value).trim();
    let d;
    try { d = decodeBech32m(s); } catch (e) {
      throw new NameError('bad-address', `Not a valid Tacit address (${e.message}).`);
    }
    if (d.hrp !== 'tacit') throw new NameError('bad-address', `Not a Tacit mainnet address (prefix "${d.hrp}").`);
    const p = d.payloadBytes;
    if (p.length !== 101) throw new NameError('bad-address', `Tacit address payload is ${p.length} bytes, expected 101.`);
    if (p[0] !== 0) throw new NameError('bad-address', `Unsupported Tacit address version ${p[0]}.`);
    if (!(p[1] & 0x02)) throw new NameError('bad-address', 'This Tacit address does not carry an Ethereum lane.');
    const keyHex = hexOf(p.slice(68, 101));
    try { secp.ProjectivePoint.fromHex(keyHex); } catch {
      throw new NameError('bad-address', 'The Ethereum-lane key in this Tacit address is not a valid point.');
    }
    return {
      address: s,
      flags: p[1],
      spendKey: '0x' + hexOf(p.slice(2, 35)),
      scanKey: '0x' + hexOf(p.slice(35, 68)),
      key: '0x' + keyHex,
    };
  }

  // name → { name, address, key, source, node }. Throws NameError with a code the caller can explain.
  async function resolveName(name) {
    const c = classify(name);
    const record = await readRecord(c.name);
    if (record == null) {
      throw new NameError('no-record', `${c.name} has not published a Tacit address. Ask them to publish it to their name, or paste their tacit1… address.`, { name: c.name, source: c.source });
    }
    let d;
    try { d = decodeTacitAddress(record); } catch (e) {
      throw new NameError('bad-record', `${c.name} has a "${RECORD_KEY}" record that is not a usable Tacit address: ${e.message}`, { name: c.name, source: c.source });
    }
    return { name: c.name, address: d.address, key: d.key, source: c.source, node: namehash(c.name) };
  }

  // ── primary name ──
  const normAddress = (a) => {
    const h = String(a || '').replace(/^0x/, '').toLowerCase();
    if (!/^[0-9a-f]{40}$/.test(h)) throw new NameError('bad-address', 'Not an Ethereum address.');
    return h;
  };

  // The address a name's forward record points at, or null.
  async function forwardAddress(c) {
    const node = namehash(c.name);
    if (c.source === 'ENS') {
      const { out } = await ensQuery(c.name, addrCalldata(node));
      return emptyOut(out) ? null : decodeAddressWord(out);
    }
    const out = await guardedCall({ to: c.contract, data: '0x' + SEL.resolveId + word(node) });
    return emptyOut(out) ? null : decodeAddressWord(out);
  }

  async function reverseCandidate(source, owner) {
    if (source === 'ENS') {
      const rnode = namehash(`${owner}.addr.reverse`);
      const r = await guardedCall({ to: ENS_REGISTRY, data: '0x' + SEL.resolverOf + word(rnode) });
      const resolver = emptyOut(r) ? null : decodeAddressWord(r);
      if (!resolver) return null;
      const out = await guardedCall({ to: resolver, data: '0x' + SEL.name + word(rnode) });
      return emptyOut(out) ? null : decodeString(out);
    }
    const contract = source === 'WNS' ? WNS : GNS;
    const out = await guardedCall({ to: contract, data: '0x' + SEL.reverseResolve + word(owner) });
    return emptyOut(out) ? null : decodeString(out);
  }

  // First of WNS, GNS, ENS whose reverse record names this wallet AND whose forward record points back at it.
  async function findPrimary(address) {
    const owner = normAddress(address);
    const skipped = [];
    for (const source of ['WNS', 'GNS', 'ENS']) {
      let raw;
      try { raw = await reverseCandidate(source, owner); } catch (e) {
        if (e instanceof NameError && e.code === 'offchain') { skipped.push({ source, reason: 'offchain' }); continue; }
        throw e;
      }
      if (!raw) continue;
      let c;
      try {
        c = classify(raw);
        if (c.source !== source) throw new NameError('unsupported-name', 'wrong service');
      } catch { skipped.push({ source, name: raw, reason: 'unusable-name' }); continue; }
      let fwd;
      try { fwd = await forwardAddress(c); } catch (e) {
        if (e instanceof NameError && e.code === 'offchain') { skipped.push({ source, name: c.name, reason: 'offchain' }); continue; }
        throw e;
      }
      if (!fwd || fwd.slice(2).toLowerCase() !== owner) { skipped.push({ source, name: c.name, reason: 'forward-mismatch' }); continue; }
      return { primary: { name: c.name, source, node: namehash(c.name) }, skipped };
    }
    return { primary: null, skipped };
  }
  const primaryName = async (address) => (await findPrimary(address)).primary;

  // The recipient field: a name is looked up and pinned to the key its record decodes to; anything else goes to
  // `local` (the synchronous tacit1… / raw-key parser), which returns { pubHex } or { error }. A bare Ethereum
  // account address is never a private-send recipient.
  async function resolveRecipient(raw, { local } = {}) {
    const s = String(raw == null ? '' : raw).trim();
    if (/^0x[0-9a-fA-F]{40}$/.test(s)) {
      throw new NameError('account-address', 'That is an Ethereum account address, and a private send needs a Tacit address. Ask the recipient to publish their Tacit address to their name (or send you their tacit1… address), or use a public unwrap to pay this account directly.');
    }
    if (looksLikeName(s)) {
      const r = await resolveName(s);
      return { pubHex: r.key, name: r.name, address: r.address, source: r.source, node: r.node };
    }
    if (typeof local !== 'function') throw new NameError('bad-recipient', 'Enter a Tacit address, a shielded pubkey, or a name.');
    const r = local(s);
    if (r && r.error) throw new NameError('bad-recipient', r.error);
    return { pubHex: r.pubHex };
  }

  // ── publishing ──
  // Everything the UI needs to show before any signature: the verified primary name, what its record holds now,
  // what would be written, and the exact transaction.
  async function planPublish({ owner, tacitAddress }) {
    const from = '0x' + normAddress(owner);
    const next = decodeTacitAddress(tacitAddress).address;
    const { primary, skipped } = await findPrimary(from);
    if (!primary) {
      throw new NameError('no-primary-name', 'No verified primary name for this wallet. Set a primary name (.wei, .gwei or .eth) that points back at this address first.', { skipped });
    }
    const current = await readRecord(primary.name);
    let to, data;
    if (primary.source === 'ENS') {
      const r = await ensResolver(primary.name);
      if (!r || !r.atName) {
        throw new NameError('resolver-cannot-hold', `${primary.name} uses a resolver that cannot hold records set from here. Set the "${RECORD_KEY}" record where that name’s records are managed.`, { primary });
      }
      to = r.resolver;
      data = setTextNodeCalldata(primary.node, RECORD_KEY, next);
    } else {
      to = primary.source === 'WNS' ? WNS : GNS;
      data = setTextIdCalldata(BigInt(primary.node), RECORD_KEY, next);
    }
    return { ...primary, owner: from, current, next, changed: current !== next, tx: { from, to, data } };
  }

  function revertReason(e) {
    const h = revertData(e);
    if (h.startsWith(SEL.errorString)) {
      try { return dec.decode(decodeDynamic('0x' + h.slice(8))); } catch { /* fall through */ }
    }
    return (e && e.message) || 'reverted';
  }

  async function simulatePublish(plan) {
    try { await call(plan.tx); } catch (e) {
      if (!isRevert(e)) throw e;
      throw new NameError('simulation-failed', `The name service would reject this update (${revertReason(e)}). Nothing was sent.`);
    }
    return true;
  }

  // Skips the transaction when the record already holds the address; otherwise simulates, then sends.
  async function publish(plan) {
    if (!plan.changed) return { skipped: true, txHash: null };
    if (typeof send !== 'function') throw new NameError('no-sender', 'No wallet is connected to send the update.');
    await simulatePublish(plan);
    const txHash = await send(plan.tx);
    return { skipped: false, txHash };
  }

  return {
    RECORD_KEY, namehash, normalizeName, classify, looksLikeName, dnsName, selector,
    readRecord, resolveName, resolveRecipient, primaryName, findPrimary,
    decodeTacitAddress, planPublish, simulatePublish, publish,
  };
}
