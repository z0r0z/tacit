// The keeper's side of the private route (dapp/sealed-request.js, docs/EVM-POOL.md "Private route"). POST /sealed opens a
// request sealed to the gateway key, runs it through the handler a direct request reaches, as if from the address that sent
// the envelope, and seals the answer. A forwarder in front hides the caller's address from the keeper, and the envelope
// hides the request from the forwarder and from whatever hosts the keeper.
//
// Nothing here widens what the handler accepts: the caller's address is the envelope's sender's, so every limit applies
// to it as to a direct request, and a reservation is not carried (the private route sends without one).

import { Readable } from 'node:stream';
import { gzip } from 'node:zlib';
import { promisify } from 'node:util';
import { bytesToHex } from '../../../dapp/vendor/tacit-deps.min.js';
import { makeTokenBucket, ipKey, clientKey } from './token-bucket.js';
import { safeErr } from './safe-err.js';
import { gatewayKeys, openRequest, SealedError, MAX_REQUEST, MAX_REPLY } from '../../../dapp/sealed-request.js';

const gzipped = promisify(gzip);

// What a wallet asks of a keeper, less /reserve and /cancel.
const CARRIED = [
  ['GET', /^\/(info|head|quote|events|point|totals)$/],
  ['GET', /^\/status\/0x[0-9a-fA-F]{40}$/],
  ['POST', /^\/(relay|receive|deposit|wrap)$/],
];
// A gateway in front of several keepers (the multi-keeper service) carries paths that name the keeper: /<id>/evm-pool/keeper/events.
const KEEPER_PATH = /^(?:\/\d+(?:-x[0-9a-f]+)?)?\/evm-pool\/keeper(?=\/)/;
const FORWARDED = ['cf-connecting-ip', 'x-forwarded-for'];
const MAX_SEEN = 100_000;
const JSON_TYPE = { 'content-type': 'application/json' };
const ALONE = { status: 502, headers: { ...JSON_TYPE, 'x-sealed': 'alone' }, body: Buffer.from('{"error":"the answer is too large to share an envelope"}'), gzip: false };

function readBytes(req, max) {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > max) { req.resume(); return Promise.reject(new Error('too large')); }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => { size += c.length; if (size <= max) chunks.push(c); });
    req.on('end', () => (size > max ? reject(new Error('too large')) : resolve(Buffer.concat(chunks))));
    req.on('error', reject);
  });
}

// Runs `inner` through the keeper's handler and collects its answer: { status, headers, body }.
function run(handle, inner, timeoutMs) {
  return new Promise((resolve) => {
    const chunks = [];
    let status = 200, headers = {}, done = false;
    const finish = (r) => { if (done) return; done = true; clearTimeout(timer); resolve(r); };
    const timer = setTimeout(() => finish({ status: 504, headers: JSON_TYPE, body: Buffer.from('{"error":"the keeper did not answer in time"}') }), timeoutMs);
    const res = {
      writeHead(code, h = {}) {
        status = code;
        headers = {};
        for (const [k, v] of Object.entries(h)) if (/^(content-type|retry-after)$/i.test(k)) headers[k.toLowerCase()] = String(v);
      },
      write(d) { chunks.push(Buffer.from(d)); },
      end(d) { if (d) chunks.push(Buffer.from(d)); finish({ status, headers, body: Buffer.concat(chunks) }); },
    };
    Promise.resolve(handle(inner, res)).catch(() => finish({ status: 500, headers: JSON_TYPE, body: Buffer.from('{"error":"internal error"}') }));
  });
}

// { key, handle(req, res, send) }: `handle` is the keeper's own request handler, `prefix` the path its routes live under, `send`
// the handler's way of answering with JSON. `idPrefixed` is for a gateway in front of several keepers: the paths it carries name
// the keeper (/<id>/evm-pool/keeper/…), and it hands them to `handle` as they are.
export function makeSealedGateway({ secret, handle, prefix, now = () => Math.floor(Date.now() / 1000), timeoutMs = 200_000, maxSeen = MAX_SEEN, idPrefixed = false }) {
  const keys = gatewayKeys(secret);
  const seen = new Map();   // one-time key and nonce → until when the gateway remembers it
  // A request seen before is refused. The memory is bounded: when full it drops what has expired and then its oldest tenth, and does not
  // refuse new requests (anyone can make a valid one, so refusing would let a flood shut real callers out). A request replayed after it was
  // dropped gets a new keystream for its answer, and is the keeper's to dedupe as it dedupes any resend.
  const fresh = (id, until) => {
    if (seen.has(id)) return false;
    if (seen.size >= maxSeen) {
      const t = now();
      for (const [k, u] of seen) if (u <= t) seen.delete(k);
      let drop = seen.size - Math.floor(maxSeen * 0.9);
      for (const k of seen.keys()) { if (drop-- <= 0) break; seen.delete(k); }
    }
    seen.set(id, until);
    return true;
  };
  return {
    key: { kid: bytesToHex(keys.kid), key: bytesToHex(keys.pub) },
    async handle(req, res, send) {
      let bytes;
      try { bytes = await readBytes(req, MAX_REQUEST); } catch { return send(413, { error: 'body too large' }); }
      let opened;
      try { opened = await openRequest(keys, bytes, { now, seen: fresh }); } catch (e) {
        if (!(e instanceof SealedError)) throw e;
        return send(400, { error: 'bad request', t: now() });
      }
      const respond = (sealed) => {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
        res.end(Buffer.from(sealed));
      };
      const carried = (method, path) => {
        if (path.length > 512) return false;
        let route = path.split('?')[0];
        if (idPrefixed) { if (!KEEPER_PATH.test(route)) return false; route = route.replace(KEEPER_PATH, ''); }
        return CARRIED.some(([m, re]) => m === method && re.test(route));
      };
      // One request, run through the handler as if from the envelope's sender → { status, headers, body }.
      const runOne = ({ method, path, body }) => {
        if (!carried(method, path)) return { status: 403, headers: JSON_TYPE, body: Buffer.from('{"error":"this request is not carried on the private route"}') };
        const json = body == null ? null : Buffer.from(JSON.stringify(body));
        const inner = Readable.from(json ? [json] : []);
        inner.method = method;
        inner.url = `${prefix}${path}`;
        inner.socket = req.socket;
        inner.headers = { ...(json ? { 'content-type': 'application/json', 'content-length': String(json.length) } : {}) };
        for (const h of FORWARDED) if (req.headers[h] !== undefined) inner.headers[h] = req.headers[h];
        return run(handle, inner, timeoutMs);
      };
      const pack = async (out) => {
        const zip = out.body.length > 1024;
        return { status: out.status, headers: out.headers, body: zip ? await gzipped(out.body) : out.body, gzip: zip };
      };
      if (!opened.batch) {
        const out = await pack(await runOne(opened.requests[0]));
        let sealed;
        try { sealed = await opened.reply(out.status, out.headers, out.body, { gzip: out.gzip }); } catch (e) {
          if (!(e instanceof SealedError)) throw e;
          sealed = await opened.reply(502, JSON_TYPE, Buffer.from('{"error":"the answer is too large for the private route"}'));
        }
        return respond(sealed);
      }
      const parts = await Promise.all((await Promise.all(opened.requests.map(runOne))).map(pack));
      // The answers must fit one envelope: the largest are told to come alone (the caller asks for them again by themselves).
      let total = 4 + 64 + parts.reduce((a, x) => a + x.body.length + 160, 0);
      while (total > MAX_REPLY && parts.length > 1) {
        let big = 0;
        parts.forEach((x, i) => { if (x.body.length > parts[big].body.length) big = i; });
        total -= parts[big].body.length - ALONE.body.length;
        parts[big] = ALONE;
      }
      return respond(await opened.replyMany(parts));
    },
  };
}

// The private route of a service that serves several keepers under /<id>/evm-pool/keeper (evm-pool-keepers.js): `serve` is the
// service's own request handler, `json(res, code, body)` its way of answering with JSON. The result takes POST /sealed and returns
// true when the request was for it. One gateway key and one forwarder target carry every pool, so a wallet's burst of reads for a
// dozen pools is one envelope. An envelope is counted against its sender before it is opened, as a keeper counts its own reads (an
// address in `forwarders` may send ten times as much); each request inside it is counted by the keeper it names, as if the sender
// had made it alone.
export function makeServiceGateway({ secret, serve, json, forwarders = [], ratePerMin = 20, log = () => {}, now }) {
  let gateway;
  try { gateway = makeSealedGateway({ secret, handle: serve, prefix: '', idPrefixed: true, ...(now ? { now } : {}) }); } catch (e) { throw new Error(`EVM_POOL_KEEPER_GATEWAY_KEY: ${e.message}`); }
  const v4 = (k) => String(k).replace(/^::ffff:/, '');
  const listed = new Set(forwarders.map((a) => v4(ipKey(a))));
  const burst = Math.max(1, Math.min(30, ratePerMin * 3));
  const one = makeTokenBucket({ perMin: ratePerMin * 6, burst }), many = makeTokenBucket({ perMin: ratePerMin * 60, burst: burst * 10 });
  const allowed = (req) => { const key = clientKey(req); return listed.has(v4(key)) ? many(key) : one(key); };
  const take = (req, res) => {
    if ((req.url || '').split('?')[0] !== '/sealed') return false;
    if (req.method !== 'POST') { json(res, 404, { error: 'not found' }); return true; }
    if (!allowed(req)) { res.setHeader('Retry-After', '10'); json(res, 429, { error: 'rate limited' }); return true; }
    gateway.handle(req, res, (code, body) => json(res, code, body)).catch((e) => {
      log(`private route: ${safeErr(e)}`);
      if (!res.headersSent) json(res, 500, { error: 'internal error' }); else res.end();
    });
    return true;
  };
  take.key = gateway.key;
  return take;
}
