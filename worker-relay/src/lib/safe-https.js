// An https request to a host a stranger named, made so that it cannot reach anything that is not on the public internet.
//
// A forwarder (evm-pool-forwarder.js) carries a wallet's sealed request to a relay that anyone has listed in the relay registry, so the host is chosen
// by whoever listed it. The host's name is resolved here, once, and every address it gives must be a public one; the connection is then made to that
// address (the check and the connection use one answer, so a name that answers differently the second time gains nothing). Plain https on the default
// port only, no redirect is followed, and the answer is cut off at a size and a time.

import { request } from 'node:https';
import { lookup as dnsLookup } from 'node:dns';
import { BlockList, isIP } from 'node:net';

const blocked = new BlockList();
for (const [net, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) blocked.addSubnet(net, bits, 'ipv4');
for (const [net, bits] of [['::', 128], ['::1', 128], ['64:ff9b::', 96], ['100::', 64], ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8]]) blocked.addSubnet(net, bits, 'ipv6');

// true for an address on the public internet (a v4-mapped v6 address is judged as the v4 address it carries)
export function isPublicAddress(ip) {
  const fam = isIP(String(ip));
  if (!fam) return false;
  const mapped = fam === 6 ? /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(String(ip)) : null;
  if (mapped) return !blocked.check(mapped[1], 'ipv4');
  const hex = fam === 6 ? /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(String(ip)) : null;
  if (hex) { const a = parseInt(hex[1], 16), b = parseInt(hex[2], 16); return !blocked.check(`${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`, 'ipv4'); }
  return !blocked.check(String(ip), fam === 6 ? 'ipv6' : 'ipv4');
}

// A DNS name with a dot that is not a local one (the contract only lets a url through that has letters, digits and -._:/ in it)
export const publicName = (host) => /^[a-z0-9_-]+(?:\.[a-z0-9_-]+)+$/i.test(host) && !/\.\d+$/.test(host) && !/\.(?:local|localhost|internal|intranet|lan|home|corp|private|invalid|arpa)$/i.test(host);

// The url a relay's service answers at: https, a public name, no port, no credentials; null for anything else.
export function relayOrigin(url) {
  let u;
  try { u = new URL(String(url)); } catch { return null; }
  if (u.protocol !== 'https:' || u.port || u.username || u.password || !publicName(u.hostname)) return null;
  return u.origin;
}

// resolves a name and refuses it unless every address is public; the connection goes to the first
export function guardedLookup(resolve = dnsLookup) {
  return (hostname, opts, cb) => {
    resolve(hostname, { all: true }, (err, list) => {
      if (err) return cb(err);
      if (!list?.length || !list.every((a) => isPublicAddress(a.address))) return cb(Object.assign(new Error('the name does not resolve to a public address'), { code: 'EBLOCKED' }));
      return opts?.all ? cb(null, list) : cb(null, list[0].address, list[0].family);
    });
  };
}

// → { status, headers, body (Buffer) }; rejects on a bad url, a blocked address, a redirect, a timeout or an answer over `maxBytes`
export function safeRequest(url, { method = 'GET', body = null, headers = {}, timeoutMs = 20_000, maxBytes = 1 << 20, lookup = guardedLookup(), requestImpl = request } = {}) {
  return new Promise((resolve, reject) => {
    const origin = relayOrigin(url);
    if (!origin) return reject(new Error('not a public https url'));
    const u = new URL(url);
    const req = requestImpl({ protocol: 'https:', hostname: u.hostname, port: 443, path: u.pathname + u.search, method, headers, lookup, timeout: timeoutMs, agent: false }, (res) => {
      const chunks = [];
      let size = 0;
      if (res.statusCode >= 300 && res.statusCode < 400) { res.resume(); req.destroy(); return reject(new Error('a redirect is not followed')); }
      res.on('data', (c) => { size += c.length; if (size > maxBytes) { req.destroy(); reject(new Error('the answer is too large')); } else chunks.push(c); });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    const timer = setTimeout(() => req.destroy(new Error('timed out')), timeoutMs);
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', (e) => { clearTimeout(timer); reject(e); });
    req.on('close', () => clearTimeout(timer));
    if (body) req.write(body);
    req.end();
  });
}
