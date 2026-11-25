// The prober's only way out to an operator's node: https, to a public address only, the address it resolved recorded, the answer bounded.
// A name that resolves to a private, loopback or link-local address is refused at connect time (the lookup is the check, so a name that
// changes its answer between a check and the request is caught too), and nothing is followed.
import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';

const toN = (s) => s.split('.').reduce((a, x) => ((a << 8) | +x) >>> 0, 0);
const NETS = [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]];
export function publicIp(ip) {
  if (net.isIPv4(ip)) {
    const n = toN(ip);
    return !NETS.some(([b, bits]) => { const m = (~0 << (32 - bits)) >>> 0; return (n & m) === (toN(b) & m); });
  }
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    if (l === '::' || l === '::1' || /^fe[89ab]/.test(l) || /^f[cd]/.test(l) || l.startsWith('ff')) return false;
    const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(l);
    return m ? publicIp(m[1]) : true;
  }
  return false;
}

export function guardedLookup(hostname, opts, cb) {
  dns.lookup(hostname, { ...opts, all: true }, (err, addrs) => {
    if (err) return cb(err);
    const ok = addrs.filter((a) => publicIp(a.address));
    if (!ok.length) return cb(Object.assign(new Error('the name resolves to no public address'), { code: 'EBLOCKED' }));
    if (opts && opts.all) return cb(null, ok);
    cb(null, ok[0].address, ok[0].family);
  });
}

// -> { status, text, ip, ms }; rejects on a refused name, a timeout or an answer past maxBytes
export function httpsFetch(url, { method = 'GET', headers = {}, body = null, timeoutMs = 20_000, maxBytes = 4 << 20, lookup = guardedLookup } = {}) {
  return new Promise((resolve, reject) => {
    let u; try { u = new URL(url); } catch (e) { return reject(e); }
    if (u.protocol !== 'https:') return reject(new Error('https only'));
    const t0 = Date.now();
    const req = https.request(u, { method, headers: { ...headers, ...(body != null ? { 'content-length': Buffer.byteLength(body) } : {}) }, lookup, timeout: timeoutMs, agent: false }, (res) => {
      const chunks = []; let n = 0;
      res.on('data', (c) => { n += c.length; if (n > maxBytes) req.destroy(new Error('answer too large')); else chunks.push(c); });
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8'), ip: res.socket?.remoteAddress || null, ms: Date.now() - t0, headers: res.headers }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', reject);
    if (body != null) req.write(body);
    req.end();
  });
}

// the origin's AS number by Team Cymru's DNS service; null when it cannot be had (then the /24 stands in)
export async function asnOf(ip, resolveTxt = dns.promises.resolveTxt) {
  try {
    if (!net.isIPv4(ip)) return null;
    const r = await resolveTxt(ip.split('.').reverse().join('.') + '.origin.asn.cymru.com');
    const m = /^(\d+)/.exec(r?.[0]?.[0] || '');
    return m ? m[1] : null;
  } catch { return null; }
}
