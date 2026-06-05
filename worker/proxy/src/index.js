// Pass-through for the legacy workers.dev API origin: every request forwards
// to ORIGIN unchanged. The two x-tacit-* headers carry the real client IP to
// the origin's rate-limit buckets; the origin honors them only when the key
// matches its PROXY_TRUST_KEY (see server/harness.mjs clientIpFrom) and
// strips them from all other callers.

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const origin = new URL(env.ORIGIN || 'https://api.tacit.finance');
    url.protocol = origin.protocol;
    url.hostname = origin.hostname;
    url.port = origin.port;

    const fwd = new Request(url, req);
    if (env.PROXY_TRUST_KEY) {
      fwd.headers.set('x-tacit-proxy-key', env.PROXY_TRUST_KEY);
      fwd.headers.set('x-tacit-forwarded-ip', req.headers.get('CF-Connecting-IP') || '');
    }
    return fetch(fwd);
  },
};
