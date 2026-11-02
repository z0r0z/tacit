// The user's side of a provider's API: the `counter` the Bitcoin-locker machine talks to, and the two reads a page makes before a
// swap starts (the provider's terms and a quote). A counter is made over a transport, a function (method, path, body) ->
// { status, body }: this file has the transport of a provider that serves HTTP, fastbridge-mailbox.js the one of a provider
// reached through a board.
//
// A reply that says no is an answer: { ok: false, retry, why }. A reply that cannot be had (the network, a server error)
// is thrown, and the machine tries again until its own wait runs out.

export function makeCounter(call) {
  const fail = (r, what) => Object.assign(new Error(`${what}: ${r.status}${r.body && r.body.error ? ' ' + r.body.error : ''}`), { status: r.status });
  const answered = (r, what) => {
    if (r.status === 200 && r.body && typeof r.body.ok === 'boolean') return r.body;
    if (r.status === 429) return { ok: false, retry: true, why: 'the liquidity provider is busy' };
    if (r.status >= 400 && r.status < 500) return { ok: false, retry: false, why: (r.body && r.body.error) || `refused (${r.status})` };
    throw fail(r, what);
  };

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
    // what a request that can be answered no says: { ok, retry?, why? }; one that cannot be answered is thrown
    async sendOffer({ quoteId, offer }) { return answered(await call('POST', '/offer', { quoteId, offer }), 'the offer was not answered'); },
    async reserve({ quoteId }) { return answered(await call('POST', '/reserve', { quoteId }), 'the reservation was not answered'); },
    async extend({ quoteId, txid }) { return answered(await call('POST', '/extend', { quoteId, txid }), 'the reservation was not extended'); },
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

export function makeHttpCounter({ base, fetchImpl = (...a) => fetch(...a), timeoutMs = 15000 }) {
  const root = () => String(typeof base === 'function' ? base() : base).replace(/\/$/, '');
  return makeCounter(async (method, path, body) => {
    const r = await fetchImpl(root() + path, {
      method, headers: body === undefined ? undefined : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    let json = null;
    try { json = await r.json(); } catch { /* not JSON */ }
    return { status: r.status, body: json };
  });
}
