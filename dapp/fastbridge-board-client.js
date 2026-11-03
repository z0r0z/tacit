// A board (fastbridge-board.js) reached over HTTP: the same calls as a Board object, for a provider or a user's page.
// Calls that cannot be answered are thrown; a call the board answers with an error carries its status.

const b64 = (bytes) => { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = (text) => { const s = atob(text), out = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i); return out; };

export function makeBoardClient({ base, fetchImpl = (...a) => fetch(...a), timeoutMs = 15000 }) {
  const root = String(base).replace(/\/$/, '');
  async function call(method, path, body) {
    const r = await fetchImpl(root + path, {
      method, headers: body === undefined ? undefined : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    let json = null;
    try { json = await r.json(); } catch { /* not JSON */ }
    return { status: r.status, body: json };
  }
  const must = (r, what) => {
    if (r.status >= 200 && r.status < 300 && r.body) return r.body;
    throw Object.assign(new Error(`${what}: ${r.status}${r.body && r.body.error ? ' ' + r.body.error : ''}`), { status: r.status });
  };
  return {
    async ads() { return must(await call('GET', '/ads'), 'the board did not list its ads').ads; },
    async putAd(ad) { return must(await call('PUT', '/ad', ad), 'the ad was not taken'); },
    async wants() { return must(await call('GET', '/wants'), 'the board did not list its wants').wants; },
    async putWant(want) { return must(await call('PUT', '/want', want), 'the want was not taken'); },
    async post(gateway, bytes) { return must(await call('POST', `/m/${gateway}`, { b: b64(bytes) }), 'the request was not taken'); },
    async inbox(gateway, after = 0) {
      const r = must(await call('GET', `/m/${gateway}/${after}`), 'the inbox could not be read');
      return { next: r.next, items: r.items.map((x) => ({ seq: x.seq, id: x.id, bytes: unb64(x.b) })) };
    },
    async putReply(id, bytes, sig) { return must(await call('PUT', `/r/${id}`, { b: b64(bytes), sig }), 'the answer was not taken'); },
    async reply(id) {
      const r = await call('GET', `/r/${id}`);
      if (r.status === 404) return null;
      return unb64(must(r, 'the answer could not be read').b);
    },
  };
}
