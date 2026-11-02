// The user's side of an LP's HTTP API (fastbridge-lp/lib/service.mjs): the `counter` the Bitcoin-locker machine talks to,
// and the two reads a page makes before a swap starts (the LP's terms and a quote).
//
// A reply that says no is an answer: { ok: false, retry, why }. A reply that cannot be had (the network, a server error)
// is thrown, and the machine tries again until its own wait runs out.

export function makeHttpCounter({ base, fetchImpl = (...a) => fetch(...a), timeoutMs = 15000 }) {
  const root = () => String(typeof base === 'function' ? base() : base).replace(/\/$/, '');
  async function call(method, path, body) {
    const r = await fetchImpl(root() + path, {
      method, headers: body === undefined ? undefined : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    let json = null;
    try { json = await r.json(); } catch { /* not JSON */ }
    return { status: r.status, body: json };
  }
  const fail = (r, what) => Object.assign(new Error(`${what}: ${r.status}${r.body && r.body.error ? ' ' + r.body.error : ''}`), { status: r.status });

  return {
    async info() {
      const r = await call('GET', '/info');
      if (r.status !== 200 || !r.body) throw fail(r, 'the liquidity provider did not give its terms');
      return r.body;
    },
    async quote(amount) {
      const r = await call('POST', '/quote', { amount: String(amount) });
      if (r.status !== 200 || !r.body) throw fail(r, 'no quote');
      return r.body;
    },
    async sendOffer({ quoteId, offer }) {
      const r = await call('POST', '/offer', { quoteId, offer });
      if (r.status === 200 && r.body && typeof r.body.ok === 'boolean') return r.body;
      if (r.status === 429) return { ok: false, retry: true, why: 'the liquidity provider is busy' };
      if (r.status >= 400 && r.status < 500) return { ok: false, retry: false, why: (r.body && r.body.error) || `refused (${r.status})` };
      throw fail(r, 'the offer was not answered');
    },
    async getEvmOffer(swapIdHex) {
      const r = await call('GET', `/swap/${swapIdHex}/offer`);
      if (r.status === 404) return null;
      if (r.status !== 200 || !r.body) throw fail(r, 'the pool lock\'s offer could not be read');
      return r.body;
    },
    async swapStatus(swapIdHex) {
      const r = await call('GET', `/swap/${swapIdHex}`);
      if (r.status === 404) return null;
      if (r.status !== 200 || !r.body) throw fail(r, 'the swap could not be read');
      return r.body;
    },
  };
}
