// The performance and cross-origin isolation headers of the `tacit` static site on Render (tools/site-isolation-headers.mjs adds them), kept in one place so the tests can serve
// the dapp the way the site does. The front page and its build copies (TAC's page, /spx/) are isolated (COOP same-origin + COEP credentialless) for the threaded
// prover, and so are the front page's readable paths (/lock, /buy/eth, ...: dapp/front-route.js VIEWS), which the catch-all serves the front page at. Any other path
// the catch-all serves it at is sent on to '/' by front-route.js when the page is not isolated. Pages that embed cross-origin frames are left out.
//
// A dedicated worker started by an isolated page must itself be sent with COEP, or the browser refuses to load it (its `error` event carries no message): so every
// worker script those pages start needs a rule of its own, unless it sits under a path that has one.
const COOP = 'Cross-Origin-Opener-Policy', COEP = 'Cross-Origin-Embedder-Policy', CACHE = 'Cache-Control';
// front-route.js VIEWS less 'farm' and 'airdrop', which are also directories of other pages
export const FRONT_VIEWS = ['lock', 'borrow', 'leaderboard', 'bitcoin', 'private', 'device', 'buy', 'sell', 'activity', 'asset'];

export const ISOLATION_RULES = [
  ['/fonts/*', CACHE, 'public, max-age=31536000, immutable'],
  ['/btc-pool/*', COEP, 'credentialless'],
  ['/', COOP, 'same-origin'], ['/', COEP, 'credentialless'],
  ['/index.html', COOP, 'same-origin'], ['/index.html', COEP, 'credentialless'],
  ['/tac/*', COOP, 'same-origin'], ['/tac/*', COEP, 'credentialless'],
  ['/spx/*', COOP, 'same-origin'], ['/spx/*', COEP, 'credentialless'],
  ...FRONT_VIEWS.flatMap((v) => [`/${v}`, `/${v}/*`]).flatMap((p) => [[p, COOP, 'same-origin'], [p, COEP, 'credentialless']]),
  ['/evm-pool-prove-worker.js', COEP, 'credentialless'],
  ['/evm-pool-sync-worker.js', COEP, 'credentialless'],
  ['/holding-prove-worker.js', COEP, 'credentialless'],
  ['/btc-pool-scan-worker.js', COEP, 'credentialless'],
  ['/confidential-bridge-worker.js', COEP, 'credentialless'],
  ['/confidential-chain-memo-worker.js', COEP, 'credentialless'],
  ['/confidential-memo-worker.js', COEP, 'credentialless'],
  ['/confidential-tree-worker.js', COEP, 'credentialless'],
  ['/stealth-scan-worker.js', COEP, 'credentialless'],
];

const covers = (pattern, path) => (pattern.endsWith('*') ? path.startsWith(pattern.slice(0, -1)) : path === pattern);

// the response headers (lower-cased names) the rules put on `path`
export const isolationHeaders = (path, rules = ISOLATION_RULES) => Object.fromEntries(rules.filter(([p]) => covers(p, path)).map(([, name, value]) => [name.toLowerCase(), value]));
