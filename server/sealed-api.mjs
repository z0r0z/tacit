// The private route for the relay's API (worker-relay/src/lib/evm-pool-keeper-sealed.js, docs/EVM-POOL.md "Private route"): POST /sealed takes a request sealed to this
// service's gateway key, runs it through the API's own handler, and seals the answer. A forwarder carries it, so the API (and the host that serves it) sees the forwarder's
// address, not the person's.
//
// The API counts callers by address (rate limits, daily budgets, how a queue is shared out between senders). Behind a forwarder that address would be the forwarder's for every
// person. A listed forwarder therefore sends a token for each caller, made from the caller's network and the day with a key only it holds (worker-relay/src/lib/evm-pool-forwarder.js
// senderToken), and the API counts the envelope under an address made from that token: the same network is one sender for a day, nothing in it is an address, and a caller cannot
// be followed from one day to the next. A token is believed only from a listed forwarder; anyone else is counted under the address they came from.
//
// Only what a page asks of the relay is carried: its quote, its status and its list of open jobs, a job's submission and landing, a bridge mint's arming. What the relay's own services call
// (the job queue, acknowledgements, refresh) is not reachable this way.
import { randomBytes } from 'node:crypto';
import { Writable } from 'node:stream';
import { makeServiceGateway } from '../worker-relay/src/lib/evm-pool-keeper-sealed.js';
import { clientIpFrom } from './harness.mjs';

export const API_CARRIED = [
  ['GET', /^\/confidential\/(status|quote|relay|open|index|armed)$/],
  ['POST', /^\/confidential\/(submit|landed|arm)$/],
  ['POST', /^\/prover\/pool\/hold$/],
];
const TOKEN = /^[0-9a-f]{12}$/;
const NOSTR_ROAD = '127.0.0.9';   // what evm-pool-keeper-nostr.js reports as the address of every envelope it carries
const json = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };

// The address a token stands for: in the first 64 bits, which is what the API counts an IPv6 caller by.
export const senderAddress = (token) => `fd00:${token.slice(0, 4)}:${token.slice(4, 8)}:${token.slice(8, 12)}::1`;

// → (nodeReq, nodeRes, handle) => true when the request was for the gateway. `forwarders`: the addresses of the forwarders whose tokens are believed.
export function makeApiSealed({ env = {}, secret, forwarders = [], ratePerMin = 20, log = () => {} }) {
  if (!secret) return null;
  // What the API compares to before it believes a forwarded address (server/harness.mjs): a key no one outside knows, since these requests are made here.
  process.env.PROXY_TRUST_KEY ||= randomBytes(24).toString('hex');
  const listed = new Set(forwarders.map((a) => String(a).trim()).filter(Boolean));
  const fromListed = (outer) => listed.has(clientIpFrom(outer, env));
  const innerHeaders = (outer) => {
    const token = String(outer.headers['x-tacit-sender'] || '');
    // An envelope that came by the Nostr road (worker-relay/src/lib/evm-pool-keeper-nostr.js) has no sender at all: it is counted under an address made for it alone, and the road's own
    // limits (a proof of work on each request, one allowance for the road) bind it.
    const road = outer.socket?.remoteAddress === NOSTR_ROAD;
    const ip = road ? senderAddress(randomBytes(6).toString('hex')) : fromListed(outer) && TOKEN.test(token) ? senderAddress(token) : clientIpFrom(outer, env);
    return { 'x-tacit-proxy-key': env.PROXY_TRUST_KEY || process.env.PROXY_TRUST_KEY, 'x-tacit-forwarded-ip': ip };
  };
  // The API's handler answers by piping a response into a stream; the gateway collects an answer through writeHead/write/end. This is the stream between them.
  const serveVia = (handle) => (inner, collector) => {
    const out = new Writable({ write(chunk, _enc, cb) { collector.write(chunk); cb(); }, final(cb) { collector.end(); cb(); } });
    out.headersSent = false;
    out.writeHead = (code, headers) => { out.headersSent = true; collector.writeHead(code, headers); return out; };
    out.setHeader = () => out;
    return handle(inner, out);
  };
  let take = null;
  return (nodeReq, nodeRes, handle) => {
    take ||= makeServiceGateway({ secret, serve: serveVia(handle), json, forwarders: [...listed], ratePerMin, log, idPrefixed: false, carried: API_CARRIED, innerHeaders });
    return take(nodeReq, nodeRes);
  };
}
