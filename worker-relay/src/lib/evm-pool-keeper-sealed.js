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
import { gatewayKeys, openRequest, SealedError, MAX_REQUEST } from '../../../dapp/sealed-request.js';

const gzipped = promisify(gzip);

// What a wallet asks of a keeper, less /reserve and /cancel.
const CARRIED = [
  ['GET', /^\/(info|head|quote|events|point|totals)$/],
  ['GET', /^\/status\/0x[0-9a-fA-F]{40}$/],
  ['POST', /^\/(relay|receive|deposit|wrap)$/],
];
const FORWARDED = ['cf-connecting-ip', 'x-forwarded-for'];
const MAX_SEEN = 100_000;
const JSON_TYPE = { 'content-type': 'application/json' };

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
// the handler's way of answering with JSON.
export function makeSealedGateway({ secret, handle, prefix, now = () => Math.floor(Date.now() / 1000), timeoutMs = 200_000, maxSeen = MAX_SEEN }) {
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
      const answer = async (out) => {
        const zip = out.body.length > 1024;
        let sealed;
        try { sealed = await opened.reply(out.status, out.headers, zip ? await gzipped(out.body) : out.body, { gzip: zip }); } catch (e) {
          if (!(e instanceof SealedError)) throw e;
          sealed = await opened.reply(502, JSON_TYPE, Buffer.from('{"error":"the answer is too large for the private route"}'));
        }
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
        res.end(Buffer.from(sealed));
      };
      const { method, path, body } = opened;
      const route = path.split('?')[0];
      if (path.length > 512 || !CARRIED.some(([m, re]) => m === method && re.test(route))) {
        return answer({ status: 403, headers: JSON_TYPE, body: Buffer.from('{"error":"this request is not carried on the private route"}') });
      }
      const json = body == null ? null : Buffer.from(JSON.stringify(body));
      const inner = Readable.from(json ? [json] : []);
      inner.method = method;
      inner.url = `${prefix}${path}`;
      inner.socket = req.socket;
      inner.headers = { ...(json ? { 'content-type': 'application/json', 'content-length': String(json.length) } : {}) };
      for (const h of FORWARDED) if (req.headers[h] !== undefined) inner.headers[h] = req.headers[h];
      return answer(await run(handle, inner, timeoutMs));
    },
  };
}
