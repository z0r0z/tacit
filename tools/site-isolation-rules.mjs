// The cross-origin isolation headers of the `tacit` static site on Render (tools/site-isolation-headers.mjs adds them), kept in one place so the tests can serve
// the dapp the way the site does. The front page and TAC's page are isolated (COOP same-origin + COEP credentialless) for the threaded prover.
//
// A dedicated worker started by an isolated page must itself be sent with COEP, or the browser refuses to load it (its `error` event carries no message): so every
// worker script those pages start needs a rule of its own, unless it sits under a path that has one.
const COOP = 'Cross-Origin-Opener-Policy', COEP = 'Cross-Origin-Embedder-Policy';

export const ISOLATION_RULES = [
  ['/btc-pool/*', COEP, 'credentialless'],
  ['/', COOP, 'same-origin'], ['/', COEP, 'credentialless'],
  ['/index.html', COOP, 'same-origin'], ['/index.html', COEP, 'credentialless'],
  ['/tac/*', COOP, 'same-origin'], ['/tac/*', COEP, 'credentialless'],
  ['/evm-pool-prove-worker.js', COEP, 'credentialless'],
  ['/evm-pool-sync-worker.js', COEP, 'credentialless'],
  ['/holding-prove-worker.js', COEP, 'credentialless'],
];

const covers = (pattern, path) => (pattern.endsWith('*') ? path.startsWith(pattern.slice(0, -1)) : path === pattern);

// the response headers (lower-cased names) the rules put on `path`
export const isolationHeaders = (path, rules = ISOLATION_RULES) => Object.fromEntries(rules.filter(([p]) => covers(p, path)).map(([, name, value]) => [name.toLowerCase(), value]));
