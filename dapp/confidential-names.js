
import { decodeBech32m, poolAddressOf } from './tacit-address.js';
import { bodyType } from './rpc-body.js';
import { ETH_NODES } from './eth-nodes.js';

export const RECORD_KEY = 'finance.tacit';
export const WNS = '0x0000000000696760E15f265e828DB644A0c242EB';
export const GNS = '0x9D51D507BC7264d4fE8Ad1cf7Fe191933A0a81d6';
export const ENS_REGISTRY = '0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e';
export const MAINNET_RPCS = ETH_NODES;

const SEL = {
  text: '59d1d43c',
  setTextId: '3fb24782',
  setTextNode: '10f13a8c',
  resolverOf: '0178b8bf',
  resolveWild: '9061b923',
  reverseResolve: '9af8b7aa',
  resolveId: '4f896d4f',
  addr: '3b3b57de',
  name: '691f3431',
  offchainLookup: '556f1830',
  errorString: '08c379a0',
};

export class NameError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'NameError';
    this.code = code;
    Object.assign(this, extra);
  }
}

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

const tail = (u8) => numWord(u8.length) + padTo32(hexOf(u8));

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

const isRevert = (e) => e instanceof CallRevert || (e && (e.code === 3 || (typeof e.data === 'string' && /^0x/i.test(e.data))));
const revertData = (e) => String((e && e.data) || '').replace(/^0x/, '').toLowerCase();
const isOffchainRevert = (e) => revertData(e).startsWith(SEL.offchainLookup);

export function makeMainnetCall({ fetchImpl, rpcs = MAINNET_RPCS, timeoutMs = 10000, agree = 2 } = {}) {
  const f = fetchImpl || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
  const need = Math.max(1, Math.min(agree, rpcs.length));
  return function call({ to, data, from }) {
    if (!f) return Promise.reject(new NameError('rpc', 'no fetch implementation'));
    const tx = { to: String(to).toLowerCase(), data };
    if (from) tx.from = String(from).toLowerCase();
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [tx, 'latest'] });

    return new Promise((resolve, reject) => {
      const answers = new Map();
      let lastErr = null, replies = 0, settled = 0, done = false;

      const finishIfExhausted = () => {
        if (done || settled < rpcs.length) return;
        done = true;
        if (answers.size > 1) {
          reject(new NameError('rpc-disagreement', `Ethereum endpoints returned ${answers.size} different answers for this lookup, so it cannot be trusted. Try again, or paste the recipient's tacit1… address.`));
        } else {
          reject(new NameError('rpc', `could not reach ${need} Ethereum endpoints that agree (${replies} answered; ${(lastErr && lastErr.message) || 'all endpoints failed'})`));
        }
      };

      rpcs.forEach((url) => {
        (async () => {
          try {
            const r = await f(url, { method: 'POST', headers: { 'content-type': bodyType(url) }, body, signal: AbortSignal.timeout(timeoutMs) });
            if (!r.ok) { lastErr = new Error(`rpc ${r.status}`); return; }
            const j = await r.json();
            if (j && j.error) {
              const d = j.error.data;
              if (j.error.code === 3 || (typeof d === 'string' && /^0x/i.test(d))) {
                if (!done) { done = true; reject(new CallRevert(j.error.message, typeof d === 'string' ? d : null)); }
                return;
              }
              lastErr = new Error(j.error.message || 'rpc error');
              return;
            }
            const out = j ? j.result : '0x';
            replies++;
            const key = String(out == null ? '' : out).toLowerCase();
            const seen = (answers.get(key) || 0) + 1;
            answers.set(key, seen);
            if (seen >= need && !done) { done = true; resolve(out); }
          } catch (e) {
            lastErr = e;
          } finally {
            settled++;
            finishIfExhausted();
          }
        })();
      });
    });
  };
}

export function makeConfidentialNames({ call, send = null, secp, keccak256 }) {
  if (typeof call !== 'function') throw new Error('confidential-names: call is required');
  if (!secp || !keccak256) throw new Error('confidential-names: secp and keccak256 are required');

  const selector = (sig) => hexOf(keccak256(enc.encode(sig)).slice(0, 4));

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

  async function resolveAddress(name) {
    const c = classify(name), node = namehash(c.name);
    let out;
    if (c.source === 'ENS') ({ out } = await ensQuery(c.name, addrCalldata(node)));
    else out = await guardedCall({ to: c.contract, data: '0x' + SEL.resolveId + word(node) });
    if (emptyOut(out)) return null;
    const address = decodeAddressWord(out);
    return address ? { name: c.name, source: c.source, address: address.toLowerCase() } : null;
  }

  function decodeTacitAddress(value) {
    const s = String(value == null ? '' : value).trim();
    let d;
    try { d = decodeBech32m(s); } catch (e) {
      throw new NameError('bad-address', `Not a valid Tacit address (${e.message}).`);
    }
    if (d.hrp !== 'tacit') throw new NameError('bad-address', `Not a Tacit mainnet address (prefix "${d.hrp}").`);
    const p = d.payloadBytes;
    if (p[0] !== 0) throw new NameError('bad-address', `Unsupported Tacit address version ${p[0]}.`);
    if (!(p[1] & 0x86)) throw new NameError('bad-address', 'This Tacit address carries neither an Ethereum lane nor a pool lane, so it cannot receive a payment.');
    if ((p[1] & 0x02) && (p[1] & 0x80)) throw new NameError('bad-address', 'This Tacit address names its Ethereum-side key twice.');
    const hasEvm = !!(p[1] & 0x02), sameKey = !!(p[1] & 0x80), hasPool = !!(p[1] & 0x04);
    const want = 68 + (hasEvm ? 33 : 0) + (hasPool ? 97 : 0), unknown = p[1] & ~0x87;
    if (unknown ? p.length < want : p.length !== want) throw new NameError('bad-address', `Tacit address payload is ${p.length} bytes, expected ${want}.`);
    let key = null;
    if (hasEvm || sameKey) {
      const keyHex = hexOf(hasEvm ? p.slice(68, 101) : p.slice(2, 35));
      try { secp.ProjectivePoint.fromHex(keyHex); } catch {
        throw new NameError('bad-address', 'The Ethereum-lane key in this Tacit address is not a valid point.');
      }
      key = '0x' + keyHex;
    }
    const poolAt = 68 + (hasEvm ? 33 : 0);
    return {
      address: s,
      flags: p[1],
      spendKey: '0x' + hexOf(p.slice(2, 35)),
      scanKey: '0x' + hexOf(p.slice(35, 68)),
      ...(key ? { key } : {}),
      ...(hasPool ? { pool: poolAddressOf(p.slice(poolAt, poolAt + 97)) } : {}),
    };
  }

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
    return { name: c.name, address: d.address, ...(d.key ? { key: d.key } : {}), ...(d.pool ? { pool: d.pool } : {}), source: c.source, node: namehash(c.name) };
  }

  const normAddress = (a) => {
    const h = String(a || '').replace(/^0x/, '').toLowerCase();
    if (!/^[0-9a-f]{40}$/.test(h)) throw new NameError('bad-address', 'Not an Ethereum address.');
    return h;
  };

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

  async function resolveRecipient(raw, { local } = {}) {
    const s = String(raw == null ? '' : raw).trim();
    if (/^0x[0-9a-fA-F]{40}$/.test(s)) {
      throw new NameError('account-address', 'That is an Ethereum account address, and a private send needs a Tacit address. Ask the recipient to publish their Tacit address to their name (or send you their tacit1… address), or use a public unwrap to pay this account directly.');
    }
    if (looksLikeName(s)) {
      const r = await resolveName(s);
      if (!r.key) {
        throw new NameError('bad-record', `${r.name} has a "${RECORD_KEY}" record with no Ethereum-lane key, so it can't receive a private send. Ask them to publish one, or pay their pool address (bp1…) directly instead.`, { name: r.name, source: r.source });
      }
      return { pubHex: r.key, name: r.name, address: r.address, source: r.source, node: r.node };
    }
    if (typeof local !== 'function') throw new NameError('bad-recipient', 'Enter a Tacit address, a shielded pubkey, or a name.');
    const r = local(s);
    if (r && r.error) throw new NameError('bad-recipient', r.error);
    return { pubHex: r.pubHex };
  }

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
      try { return dec.decode(decodeDynamic('0x' + h.slice(8))); } catch { }
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

  async function publish(plan) {
    if (!plan.changed) return { skipped: true, txHash: null };
    if (typeof send !== 'function') throw new NameError('no-sender', 'No wallet is connected to send the update.');
    await simulatePublish(plan);
    const txHash = await send(plan.tx);
    return { skipped: false, txHash };
  }

  return {
    RECORD_KEY, namehash, normalizeName, classify, looksLikeName, dnsName, selector,
    readRecord, resolveName, resolveAddress, resolveRecipient, primaryName, findPrimary,
    decodeTacitAddress, planPublish, simulatePublish, publish,
  };
}
