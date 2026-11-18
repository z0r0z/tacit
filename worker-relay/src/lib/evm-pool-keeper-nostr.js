// The keeper's side of the private route over Nostr (docs/PRIVATE-ROUTE-NOSTR.md, dapp/route-nostr.js). It listens on public relays for request
// events addressed to its gateway key id, hands each envelope to the same gateway `POST /sealed` reaches (so every rule that applies there
// applies here: the single-use memory, the five-minute window, what is carried, the per-request limits), and publishes the sealed answer as a
// reply event on the relays it hears them on. It sees the relays' addresses and the request, never the sender's address.
//
// `take(req, res)` is the service gateway (makeServiceGateway): it takes a POST to /sealed and returns true when the request was for it. Each
// envelope is counted against one sender, the Nostr road itself, since the events are signed with keys made for them alone.
import { Readable } from 'node:stream';
import { readRequest, makeReplyEvent, REQ_KIND, REQ_BITS, MAX_REPLY } from '../../../dapp/route-nostr.js';

const ROAD = '127.0.0.9';   // the sender every envelope on this road is counted under (never a caller's address)

export function makeNostrRoad({ take, kidHex, relays, WS, minBits = REQ_BITS, now = () => Math.floor(Date.now() / 1000), log = () => {}, maxInFlight = 16, seenMax = 50_000, reconnectMs = 2000 }) {
  if (typeof take !== 'function' || !/^[0-9a-f]{8}$/.test(String(kidHex))) throw new Error('nostr road: needs the gateway and its key id');
  if (!relays?.length) throw new Error('nostr road: needs a relay');
  const open = new Map();              // url → socket, while connected
  const seen = new Map();              // request event id → until when it is remembered
  let inflight = 0, stopped = false, sub = 'kr' + Math.random().toString(36).slice(2, 8);
  const stats = { heard: 0, answered: 0, dropped: 0, tooBig: 0 };

  const remember = (id) => {
    if (seen.has(id)) return false;
    if (seen.size >= seenMax) { const t = now(); for (const [k, u] of seen) if (u <= t) seen.delete(k); if (seen.size >= seenMax) { let d = Math.floor(seenMax / 10); for (const k of seen.keys()) { if (d-- <= 0) break; seen.delete(k); } } }
    seen.set(id, now() + 600);
    return true;
  };

  // The envelope through the gateway as a POST /sealed from the road → { status, body }.
  const runTake = (bytes) => new Promise((resolve) => {
    const req = Readable.from([Buffer.from(bytes)]);
    req.method = 'POST'; req.url = '/sealed'; req.headers = { 'content-length': String(bytes.length) }; req.socket = { remoteAddress: ROAD };
    const chunks = []; let status = 200, done = false;
    const end = (d) => { if (done) return; done = true; if (d) chunks.push(Buffer.from(d)); resolve({ status, body: Buffer.concat(chunks) }); };
    const res = { headersSent: false, setHeader() {}, writeHead(code) { status = code; this.headersSent = true; }, write(d) { chunks.push(Buffer.from(d)); }, end };
    try { if (!take(req, res)) end(); } catch { status = 500; end(); }
  });

  const publish = (ev) => { for (const ws of open.values()) { try { ws.send(JSON.stringify(['EVENT', ev])); } catch { /* that relay is gone; it reconnects */ } } };

  async function onEvent(ev) {
    const bytes = readRequest(ev, { kidHex, nowSec: now(), minBits });
    if (!bytes) return;
    if (!remember(ev.id)) return;
    stats.heard++;
    if (inflight >= maxInFlight) { stats.dropped++; return; }
    inflight++;
    try {
      const out = await runTake(bytes);
      if (out.status !== 200) { stats.dropped++; return; }          // refused (rate limit, bad envelope, replay): no answer is sent, the caller moves on
      if (out.body.length > MAX_REPLY) { stats.tooBig++; return; }  // too large for relays: the caller asks another road
      publish(makeReplyEvent(new Uint8Array(out.body), ev.id, { nowSec: now() }));
      stats.answered++;
    } catch (e) { log(`nostr road: ${String(e?.message || e).slice(0, 120)}`); }
    finally { inflight--; }
  }

  function connect(url, delay = reconnectMs) {
    if (stopped) return;
    let ws, opened = false;
    const again = () => { open.delete(url); if (!stopped) setTimeout(() => connect(url, Math.min(delay * 2, 60_000)), opened ? reconnectMs : delay).unref?.(); };
    try { ws = new WS(url); } catch { again(); return; }
    ws.onopen = () => {
      opened = true; open.set(url, ws);
      try { ws.send(JSON.stringify(['REQ', sub, { kinds: [REQ_KIND], '#x': [kidHex], since: now() - 60 }])); } catch { /* closes below */ }
      log(`nostr road: listening on ${url}`);
    };
    ws.onmessage = (m) => {
      let x; try { x = JSON.parse(typeof m.data === 'string' ? m.data : ''); } catch { return; }
      if (x[0] === 'EVENT' && x[1] === sub) onEvent(x[2]).catch(() => {});
    };
    ws.onerror = () => {};
    ws.onclose = again;
  }

  return {
    start() { for (const u of relays) connect(u); return this; },
    stop() { stopped = true; for (const ws of open.values()) { try { ws.close(); } catch { /* gone */ } } open.clear(); },
    stats: () => ({ ...stats, relays: [...open.keys()], inflight }),
  };
}
