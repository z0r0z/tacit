// Build script. `npm run build` refreshes the cache-bust tokens, CSP hashes and
// service-worker cache version from the files in ../dapp/ and prints SHA-384
// hashes for the vendor bundle, index.html, and tacit.js. It reads the vendor
// bundles as committed.
//
// `npm run build:vendor` (--vendor) first re-bundles ../dapp/vendor/*.min.js
// from the npm-installed noble + scure + sats-connect + snarkjs + poseidon
// packages, then does the rest. Run it when a bundled dependency or an entry
// file changes. The output depends on the installed esbuild version.
//
// `npm run build:verify` (--verify-only) checks the fingerprints and writes nothing.
//
// The classic app's source is split: ../dapp/classic.html (markup + meta-CSP) loads
// ../dapp/tacit.js (the application module), which imports from
// ./vendor/tacit-deps.min.js.

import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { brotliCompressSync, brotliDecompressSync, constants as zlibConst } from 'node:zlib';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE       = dirname(fileURLToPath(import.meta.url));
const ROOT       = resolve(HERE, '..');                     // /Users/z/tacit
const DAPP_DIR   = join(ROOT, 'dapp');                      // production output (pin this)
const VENDOR_DIR = join(DAPP_DIR, 'vendor');
const BUNDLE_OUT = join(VENDOR_DIR, 'tacit-deps.min.js');
const MIXER_OUT  = join(VENDOR_DIR, 'tacit-mixer.min.js'); // separate bundle, lazy-loaded
const SATSCONNECT_OUT = join(VENDOR_DIR, 'tacit-satsconnect.min.js'); // separate bundle, lazy-loaded
const POSEIDON_OUT = join(VENDOR_DIR, 'tacit-poseidon.min.js'); // separate bundle, lazy-loaded (Bitcoin pool)
const HTML       = join(DAPP_DIR, 'classic.html');                // the classic app, at /classic.html
const APP_JS     = join(DAPP_DIR, 'tacit.js');               // app code (extracted from inline)
const PREBOOT    = join(DAPP_DIR, 'preboot.js');             // head-loaded, SW-cached like tacit.js
const PRF_WALLET = join(DAPP_DIR, 'prf-wallet.js');          // passkey/PRF key derivation, SW-cached like tacit.js
const SW_JS      = join(DAPP_DIR, 'sw.js');
const VERIFY_HTML = join(DAPP_DIR, 'verify.html');   // self-contained verifier; its inline module is CSP-hash-pinned
const WELD_HTML  = join(DAPP_DIR, 'index.html');             // the front page (tacit weld, formerly /weld/): one file, its inline module CSP-hash-pinned
const WELD_STATS_HTML = join(DAPP_DIR, 'weld', 'stats', 'index.html');   // weld stats: public reads only, its inline module CSP-hash-pinned
const WELD_KEEPER_HTML = join(DAPP_DIR, 'weld', 'keeper', 'index.html'); // community ops: permissionless keeper actions (advanceTip etc.), its inline module CSP-hash-pinned
const PAY_HTML = join(DAPP_DIR, 'pay', 'index.html');         // tacit pay: BTC and TAC payments, one file, its inline module CSP-hash-pinned
const PAY_ETH_HTML = join(DAPP_DIR, 'pay', 'eth', 'index.html');   // tacit pay's private ETH, likewise (served at /pay/eth/ and /pay/wei/)
const OUT_DIR    = join(HERE, 'out');                        // build artifacts (gitignored)
const BR_OUT     = join(OUT_DIR, 'tacit.js.br');             // brotli-q11 copy for the edge route

const verifyOnly = process.argv.includes('--verify-only');
const rebundle = process.argv.includes('--vendor') && !verifyOnly;

async function bundleVendor() {
  if (!rebundle) {
    if (!existsSync(BUNDLE_OUT)) throw new Error(`bundle missing: ${BUNDLE_OUT}`);
    return readFileSync(BUNDLE_OUT);
  }
  await build({
    entryPoints: [join(HERE, 'entry.mjs')],
    bundle: true,
    format: 'esm',
    target: 'es2020',
    minify: true,
    legalComments: 'inline',  // keep MIT/ISC notices from noble + scure
    outfile: BUNDLE_OUT,
    logLevel: 'info',
  });
  return readFileSync(BUNDLE_OUT);
}

// Mixer bundle (snarkjs + ffjavascript). Built as a separate file so users
// who never visit the Mixer tab don't pay the ~800 KB cost — tacit.js
// loads it lazily via dynamic import inside verifyMixerProof.
async function bundleMixer() {
  if (!rebundle) {
    if (!existsSync(MIXER_OUT)) throw new Error(`bundle missing: ${MIXER_OUT}`);
    return readFileSync(MIXER_OUT);
  }
  await build({
    entryPoints: [join(HERE, 'entry-mixer.mjs')],
    bundle: true,
    format: 'esm',
    target: 'es2020',
    minify: true,
    legalComments: 'inline',
    outfile: MIXER_OUT,
    logLevel: 'info',
    // snarkjs uses Node-style dynamic imports for ceremony files we don't
    // need at verify-time. Mark them external so the bundler doesn't try to
    // resolve them — anything load-bearing (groth16.verify, ffjavascript)
    // gets bundled; ceremony helpers like fastfile / ejs error at runtime
    // only if a non-verify path tries to use them.
    external: ['fastfile', 'ejs', 'logplease', 'r1csfile', 'web-worker', 'fs', 'os', 'crypto', 'readline', 'path'],
    platform: 'browser',
  });
  return readFileSync(MIXER_OUT);
}

// Sats-Connect bundle (Xverse / Leather / OKX). Split like the mixer so
// burner/passkey sessions — which never connect an external BTC wallet —
// don't pay its cost on the eager critical path. tacit.js lazy-imports it
// via ensureSatsConnect() on first external-wallet use.
async function bundleSatsConnect() {
  if (!rebundle) {
    if (!existsSync(SATSCONNECT_OUT)) throw new Error(`bundle missing: ${SATSCONNECT_OUT}`);
    return readFileSync(SATSCONNECT_OUT);
  }
  await build({
    entryPoints: [join(HERE, 'entry-satsconnect.mjs')],
    bundle: true,
    format: 'esm',
    target: 'es2020',
    minify: true,
    legalComments: 'inline',
    outfile: SATSCONNECT_OUT,
    logLevel: 'info',
    platform: 'browser',
  });
  return readFileSync(SATSCONNECT_OUT);
}

// Poseidon bundle for the Bitcoin shielded pool (dapp/btc-pool-zk.js). Loaded only by pool pages.
async function bundlePoseidon() {
  if (!rebundle) {
    if (!existsSync(POSEIDON_OUT)) throw new Error(`bundle missing: ${POSEIDON_OUT}`);
    return readFileSync(POSEIDON_OUT);
  }
  await build({
    entryPoints: [join(HERE, 'entry-poseidon.mjs')],
    bundle: true,
    format: 'esm',
    target: 'es2020',
    minify: true,
    legalComments: 'inline',
    outfile: POSEIDON_OUT,
    logLevel: 'info',
    platform: 'neutral',
  });
  return readFileSync(POSEIDON_OUT);
}

const sha384b64 = buf => 'sha384-' + createHash('sha384').update(buf).digest('base64');

// Rewrite the `?cb=<token>` cache-bust handle on tacit.js URLs in
// classic.html so it tracks the current bytes of dapp/tacit.js. iOS Safari
// serves stale modulepreloaded ESM to long-lived tabs even with
// max-age=0; bumping the URL forces all clients to fetch fresh on next
// load. Token is a short sha256 prefix of tacit.js — idempotent (no-op
// if tacit.js bytes haven't changed) and impossible to forget because
// it runs on every build. Returns true if classic.html changed.
function updateCacheBust(htmlBytes, appJsBytes, prebootBytes) {
  const token = createHash('sha256').update(appJsBytes).digest('hex').slice(0, 8);
  // preboot.js is cached cache-first by the service worker exactly like
  // tacit.js, so it needs its own content-derived handle — sharing tacit.js's
  // would leave it stale whenever only preboot changed.
  const prebootToken = createHash('sha256').update(prebootBytes).digest('hex').slice(0, 8);
  const before = htmlBytes.toString('utf8');
  const after = before
    .replace(/(\.\/tacit\.js\?cb=)[A-Za-z0-9_-]+/g, `$1${token}`)
    .replace(/(\.\/preboot\.js\?cb=)[A-Za-z0-9_-]+/g, `$1${prebootToken}`);
  if (before === after) return { changed: false, token, prebootToken };
  writeFileSync(HTML, after);
  return { changed: true, token, prebootToken };
}

// dapp/sats/ is its own page with its own module graph. Every `"/<path>.js?cb=<token>"` it references
// carries a sha256 prefix of the file it names, rewritten importer-last (the join worker, mix.js and secret.js,
// then app.js, then the page that loads app.js) so each token covers bytes already final. Returns the drift it found; writes only
// when asked, so --verify-only reuses the same walk.
const SATS_CB_FILES = ['sats/join-worker.js', 'sats/mix.js', 'sats/secret.js', 'sats/eth.js', 'sats/app.js', 'sats/index.html'];
// The front page (dapp/index.html) and weld's stats and keeper pages each keep their imports in their inline module, so their tokens are rewritten before
// those modules' CSP hashes are taken (updatePinnedCsp below).
const WELD_CB_FILES = ['walletconnect.js', 'index.html', 'weld/stats/index.html', 'weld/keeper/index.html'];
// dapp/pay/ and dapp/pay/eth/ are built the same way as weld: one page each, every import in its inline module.
const PAY_CB_FILES = ['pay/index.html', 'pay/eth/index.html'];
// dapp/tac/ is the shielded-TAC page: app.js lazy-imports sats.js, so sats.js is hashed first and the page
// that loads app.js last, same importer-last order as the sats page above.
const TAC_CB_FILES = ['tac/sats.js', 'tac/market.js', 'tac/claim.js', 'tac/app.js', 'tac/index.html'];
function pageCacheBust(files, write) {
  const drift = [];
  for (const rel of files) {
    const file = join(DAPP_DIR, rel);
    if (!existsSync(file)) continue;
    const before = readFileSync(file, 'utf8');
    const after = before.replace(/(["'])(\/[\w./-]+\.js)\?cb=([A-Za-z0-9_-]+)\1/g, (m, q, path, got) => {
      const src = join(DAPP_DIR, path);
      if (!existsSync(src)) return m;
      const want = createHash('sha256').update(readFileSync(src)).digest('hex').slice(0, 8);
      if (got !== want) drift.push(`${rel} ${path} ?cb=${got} but sha256(dapp${path})=${want}`);
      return `${q}${path}?cb=${want}${q}`;
    });
    if (write && after !== before) writeFileSync(file, after);
  }
  return drift;
}

// A page's module graph is discovered one import statement at a time, so each level of it costs a round trip before
// the next level starts: the pay pages' unified-address chain was five deep. The page names its modules in a
// `<!-- preload-roots: /a.js /b.js | /c.js -->` comment. Everything the first group reaches through static imports is
// preloaded from the head, under the exact URL the page (or the module importing it) uses, so it is fetched in parallel
// from the first bytes of the HTML. The group after the bar is what the page needs right after it starts, not before:
// the module's first lines preload it, once what the page waits on has arrived, so the two do not share bandwidth.
// Generated here so it cannot go stale; --verify-only reports a block that no longer matches.
const PRELOAD_PAGES = ['index.html', 'pay/index.html', 'pay/eth/index.html'];
const STATIC_IMPORT = /(?:^|[\n;}])\s*(?:import|export)\s*(?:[^'"();]*?\sfrom\s*)?(['"])([^'"]+)\1/g;
const HEAD_BLOCK = /<!-- preload:begin -->[\s\S]*?<!-- preload:end -->/, LATER_BLOCK = /\/\/ preload-later:begin\n[\s\S]*?\/\/ preload-later:end/;
function preloadBlocks(page) {
  const spec = (/<!-- preload-roots:([^>]*?)-->/.exec(page) || [])[1];
  if (!spec) return null;
  const [roots, later = ''] = spec.split('|');
  const code = page.replace(HEAD_BLOCK, '').replace(LATER_BLOCK, '');
  const urlOf = (path) => {
    const m = new RegExp(`(["'])(${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\?cb=[A-Za-z0-9_-]+)?)\\1`).exec(code);
    if (!m) throw new Error(`preload root ${path} is not imported by the page`);
    return m[2];
  };
  const reach = (list, seen) => {
    const walk = (url) => {
      if (seen.has(url)) return;
      const path = url.split('?')[0], file = join(DAPP_DIR, path);
      if (!existsSync(file)) throw new Error(`preload: ${url} is not in dapp/`);
      seen.add(url);
      for (const m of readFileSync(file, 'utf8').matchAll(STATIC_IMPORT)) {
        if (/^[./]/.test(m[2])) walk(new URL(m[2], `https://x${path}`).pathname);
      }
    };
    for (const r of list.trim().split(/\s+/).filter(Boolean)) walk(urlOf(r));
    return seen;
  };
  const first = reach(roots, new Set()), after = [...reach(later, new Set(first))].slice(first.size);
  const head = [...first].map((u) => `<link rel="modulepreload" href="${u}"${u.startsWith('/vendor/tacit-deps') ? ' fetchpriority="high"' : ''}>`);
  return {
    head: `<!-- preload:begin -->\n${head.join('\n')}\n<!-- preload:end -->`,
    later: after.length
      ? `// preload-later:begin\nfor (const u of ${JSON.stringify(after)}) document.head.append(Object.assign(document.createElement('link'), { rel: 'modulepreload', href: u }));\n// preload-later:end`
      : `// preload-later:begin\n// preload-later:end`,
  };
}
function pagePreloads(write) {
  const drift = [];
  for (const rel of PRELOAD_PAGES) {
    const file = join(DAPP_DIR, rel);
    if (!existsSync(file)) continue;
    const before = readFileSync(file, 'utf8');
    const blocks = preloadBlocks(before);
    if (!blocks) continue;
    if (!LATER_BLOCK.test(before)) throw new Error(`${rel} has no preload-later block`);
    const after = before.replace(HEAD_BLOCK, () => blocks.head).replace(LATER_BLOCK, () => blocks.later);
    if (after !== before) { drift.push(`${rel} modulepreload links do not match the page's imports`); if (write) writeFileSync(file, after); }
  }
  return drift;
}

// Unlike tacit.js/preboot.js (fingerprinted via their own `?cb=` URL param),
// vendor/tacit-deps.min.js (the crypto bundle) and prf-wallet.js (passkey/PRF
// key derivation) are imported by dozens of dapp/*.js files at their bare
// path with no query string, so sw.js's cache-first STATIC_CACHE would keep
// serving an already-cached copy of either file indefinitely — the only
// refresh path is a best-effort background revalidate that can be killed
// before it completes. Folding a hash of both files' bytes into
// CACHE_VERSION forces the SW's activate handler (which purges every cache
// name not matching the current CACHE_VERSION) to invalidate STATIC_CACHE
// the moment either file's content changes, the same "impossible to forget"
// guarantee updateCacheBust gives tacit.js.
function updateCacheVersion(swBytes, vendorBundle, prfWalletBytes) {
  const token = createHash('sha256').update(Buffer.concat([vendorBundle, prfWalletBytes])).digest('hex').slice(0, 8);
  const before = swBytes.toString('utf8');
  const after = before.replace(
    /(const CACHE_VERSION = ')([^']*?)(?:-[0-9a-f]{8})?(')/,
    (_, pre, label, post) => `${pre}${label}-${token}${post}`
  );
  if (before === after) return { changed: false, token };
  writeFileSync(SW_JS, after);
  return { changed: true, token };
}


// verify.html keeps its script inline on purpose (auditable in one View-Source) but must NOT fall back to
// `script-src 'unsafe-inline'`: it is served from the same origin as the key-bearing dapp, whose whole
// defence is that no inline script runs there, and CSP is per-response — one page opting out is enough.
// Pinning the exact sha256 of its own inline module keeps both properties. Recomputed on every build so an
// edit to that script can never leave a stale pin (which would simply stop the page working, loudly).
// Returns { changed, digest } or null when the page has no inline module.
function verifyCspDigest(htmlText) {
  const m = /<script type="module">([\s\S]*?)<\/script>/.exec(htmlText);
  if (!m) return null;
  return 'sha256-' + createHash('sha256').update(m[1], 'utf8').digest('base64');
}
// The pinned pages and where each keeps its hash: verify.html's script-src is the hash alone, weld's is 'self' plus
// the hash (it also imports same-origin modules).
const PINNED_PAGES = [
  { name: 'verify.html', file: VERIFY_HTML, re: /script-src '(unsafe-inline|sha256-[A-Za-z0-9+/=]+)'/, put: (d) => `script-src '${d}'` },
  { name: 'index.html', file: WELD_HTML, re: /script-src 'self' '(sha256-[A-Za-z0-9+/=]+)'/, put: (d) => `script-src 'self' '${d}'` },
  { name: 'weld/stats/index.html', file: WELD_STATS_HTML, re: /script-src 'self' '(sha256-[A-Za-z0-9+/=]+)'/, put: (d) => `script-src 'self' '${d}'` },
  { name: 'weld/keeper/index.html', file: WELD_KEEPER_HTML, re: /script-src 'self' '(sha256-[A-Za-z0-9+/=]+)'/, put: (d) => `script-src 'self' '${d}'` },
  { name: 'pay/index.html', file: PAY_HTML, re: /script-src 'self' '(sha256-[A-Za-z0-9+/=]+)'/, put: (d) => `script-src 'self' '${d}'` },
  { name: 'pay/eth/index.html', file: PAY_ETH_HTML, re: /script-src 'self' '(sha256-[A-Za-z0-9+/=]+)'/, put: (d) => `script-src 'self' '${d}'` },
];
function updatePinnedCsp(page) {
  const htmlText = readFileSync(page.file).toString('utf8');
  const digest = verifyCspDigest(htmlText);
  if (!digest) return { changed: false, digest: null };
  const after = htmlText.replace(page.re, page.put(digest));
  if (after === htmlText) return { changed: false, digest };
  writeFileSync(page.file, after);
  return { changed: true, digest };
}

async function main() {
  mkdirSync(VENDOR_DIR, { recursive: true });

  console.log(rebundle ? '• Bundling vendor deps...' : '• Reading existing bundle...');
  const bundle = await bundleVendor();
  console.log(`  ${BUNDLE_OUT}`);
  console.log(`  ${bundle.length.toLocaleString()} bytes · ${sha384b64(bundle)}`);

  console.log(rebundle ? '• Bundling mixer deps (snarkjs)...' : '• Reading existing mixer bundle...');
  const mixerBundle = await bundleMixer();
  console.log(`  ${MIXER_OUT}`);
  console.log(`  ${mixerBundle.length.toLocaleString()} bytes · ${sha384b64(mixerBundle)}`);

  console.log(rebundle ? '• Bundling sats-connect...' : '• Reading existing sats-connect bundle...');
  const satsConnectBundle = await bundleSatsConnect();
  console.log(`  ${SATSCONNECT_OUT}`);
  console.log(`  ${satsConnectBundle.length.toLocaleString()} bytes · ${sha384b64(satsConnectBundle)}`);

  console.log(rebundle ? '• Bundling poseidon (Bitcoin pool)...' : '• Reading existing poseidon bundle...');
  const poseidonBundle = await bundlePoseidon();
  console.log(`  ${POSEIDON_OUT}`);
  console.log(`  ${poseidonBundle.length.toLocaleString()} bytes · ${sha384b64(poseidonBundle)}`);

  if (!existsSync(HTML)) throw new Error(`source not found: ${HTML}`);
  if (!existsSync(APP_JS)) throw new Error(`source not found: ${APP_JS}`);
  if (!existsSync(PREBOOT)) throw new Error(`source not found: ${PREBOOT}`);
  if (!existsSync(PRF_WALLET)) throw new Error(`source not found: ${PRF_WALLET}`);
  if (!existsSync(SW_JS)) throw new Error(`source not found: ${SW_JS}`);
  let html = readFileSync(HTML);
  const appJs = readFileSync(APP_JS);
  const preboot = readFileSync(PREBOOT);
  const prfWallet = readFileSync(PRF_WALLET);

  let cb = null;
  let brBytes = null;
  if (verifyOnly) {
    // --verify-only must actually VERIFY the fingerprints, not just skip writing them. It used to skip both
    // updateCacheBust and updateCacheVersion entirely, so it could not tell a committed tree whose tokens
    // match its bytes from one where someone edited dapp/ and never ran the build. Nothing else catches that:
    // no CI job touches dapp/, there is no hook, and Render autodeploys straight from git. The sharpest edge
    // is prf-wallet.js and the vendor crypto bundle — imported at bare paths, cache-first in the service
    // worker, and invalidated ONLY by CACHE_VERSION — so a skipped build leaves returning visitors on the
    // pre-fix module indefinitely. Recompute all three and fail loudly on any drift.
    const wantCb = createHash('sha256').update(appJs).digest('hex').slice(0, 8);
    const wantPreboot = createHash('sha256').update(preboot).digest('hex').slice(0, 8);
    const wantSw = createHash('sha256').update(Buffer.concat([bundle, prfWallet])).digest('hex').slice(0, 8);
    const htmlText = html.toString('utf8');
    const swText = readFileSync(SW_JS).toString('utf8');
    const found = (re, text) => { const m = re.exec(text); return m ? m[1] : null; };
    const drift = [];
    const gotCb = found(/\.\/tacit\.js\?cb=([A-Za-z0-9_-]+)/, htmlText);
    const gotPreboot = found(/\.\/preboot\.js\?cb=([A-Za-z0-9_-]+)/, htmlText);
    const gotSw = found(/const CACHE_VERSION = '[^']*?-([0-9a-f]{8})'/, swText);
    if (gotCb !== wantCb) drift.push(`classic.html tacit.js ?cb=${gotCb} but sha256(dapp/tacit.js)=${wantCb}`);
    if (gotPreboot !== wantPreboot) drift.push(`classic.html preboot.js ?cb=${gotPreboot} but sha256(dapp/preboot.js)=${wantPreboot}`);
    if (gotSw !== wantSw) drift.push(`sw.js CACHE_VERSION suffix ${gotSw} but sha256(vendor‖prf-wallet)=${wantSw}`);
    drift.push(...pageCacheBust(SATS_CB_FILES, false), ...pageCacheBust(WELD_CB_FILES, false), ...pageCacheBust(TAC_CB_FILES, false), ...pageCacheBust(PAY_CB_FILES, false));
    drift.push(...pagePreloads(false));
    if (drift.length) {
      console.error('✗ cache-bust tokens or preload links are stale — run `npm run build` and commit the result:');
      for (const d of drift) console.error(`    ${d}`);
      process.exit(1);
    }
    for (const page of PINNED_PAGES) {
      if (!existsSync(page.file)) continue;
      const vText = readFileSync(page.file).toString('utf8');
      const want = verifyCspDigest(vText);
      const got = (page.re.exec(vText) || [])[1] || null;
      if (want && got !== want) {
        console.error(`✗ ${page.name} CSP script hash is stale — run \`npm run build\` and commit the result:`);
        console.error(`    script-src '${got}' but sha256(inline module)=${want}`);
        process.exit(1);
      }
      if (want) console.log(`• ${page.name} CSP hash verified: ${want}`);
    }
    console.log(`• Cache-bust tokens verified: tacit.js ${wantCb} · preboot ${wantPreboot} · SW ${wantSw}`);
  }
  if (!verifyOnly) {
    cb = updateCacheBust(html, appJs, preboot);
    console.log(`• Cache-bust token: ?cb=${cb.token}${cb.changed ? ' (updated)' : ' (unchanged)'} · preboot ?cb=${cb.prebootToken}`);
    if (cb.changed) html = readFileSync(HTML);
    const satsDrift = pageCacheBust(SATS_CB_FILES, true);
    console.log(`• sats page cache-bust: ${satsDrift.length ? `${satsDrift.length} token(s) updated` : 'unchanged'}`);
    const weldDrift = pageCacheBust(WELD_CB_FILES, true);
    console.log(`• weld page cache-bust: ${weldDrift.length ? `${weldDrift.length} token(s) updated` : 'unchanged'}`);
    const tacDrift = pageCacheBust(TAC_CB_FILES, true);
    console.log(`• tac page cache-bust: ${tacDrift.length ? `${tacDrift.length} token(s) updated` : 'unchanged'}`);
    const payDrift = pageCacheBust(PAY_CB_FILES, true);
    console.log(`• pay page cache-bust: ${payDrift.length ? `${payDrift.length} token(s) updated` : 'unchanged'}`);
    const preDrift = pagePreloads(true);
    console.log(`• pay page preloads: ${preDrift.length ? 'updated' : 'unchanged'}`);

    for (const page of PINNED_PAGES) {
      if (!existsSync(page.file)) continue;
      const v = updatePinnedCsp(page);
      if (v.digest) console.log(`• ${page.name} CSP hash: ${v.digest}${v.changed ? ' (updated)' : ' (unchanged)'}`);
    }
    const swVer = updateCacheVersion(readFileSync(SW_JS), bundle, prfWallet);
    console.log(`• SW cache version: ${swVer.token}${swVer.changed ? ' (updated — will bust STATIC_CACHE)' : ' (unchanged)'}`);
    // Brotli-q11 copy for the edge-delivery route (worker handleDappBundle).
    // The static origin's on-the-fly brotli lands ~40% above q11 on these
    // bytes; precompressing here and uploading to KV captures the gap.
    // Emitted under build/out/ (gitignored) — a ~1MB binary that changes
    // with every dapp edit doesn't belong in git history. Round-trip
    // verified before writing so the artifact can never decode to bytes
    // other than the exact tacit.js the ?cb token was derived from.
    console.log('• Compressing tacit.js (brotli q11)...');
    mkdirSync(OUT_DIR, { recursive: true });
    brBytes = brotliCompressSync(appJs, { params: {
      [zlibConst.BROTLI_PARAM_QUALITY]: 11,
      // 16MB window (RFC 7932 max for standard streams — every browser's
      // Content-Encoding: br decoder accepts it). Node defaults to 22
      // (4MB), which leaves ratio on the table for a ~5MB input. This is
      // NOT the non-standard LARGE_WINDOW extension.
      [zlibConst.BROTLI_PARAM_LGWIN]: 24,
      [zlibConst.BROTLI_PARAM_SIZE_HINT]: appJs.length,
    } });
    if (!brotliDecompressSync(brBytes).equals(appJs)) {
      throw new Error('tacit.js.br round-trip mismatch — refusing to emit');
    }
    writeFileSync(BR_OUT, brBytes);
    console.log(`  ${BR_OUT}`);
    console.log(`  ${brBytes.length.toLocaleString()} bytes (${(100 * brBytes.length / appJs.length).toFixed(1)}% of raw) · ${sha384b64(brBytes)}`);
  }

  console.log(`  ${HTML}`);
  console.log(`  ${html.length.toLocaleString()} bytes · ${sha384b64(html)}`);
  console.log(`  ${APP_JS}`);
  console.log(`  ${appJs.length.toLocaleString()} bytes · ${sha384b64(appJs)}`);

  console.log('\nDone. Pin /Users/z/tacit/dapp/ to IPFS:');
  console.log('  ipfs add -r /Users/z/tacit/dapp');
  console.log('\nIntegrity hashes (publish in release notes):');
  console.log(`  vendor/tacit-deps.min.js        ${sha384b64(bundle)}`);
  console.log(`  vendor/tacit-mixer.min.js       ${sha384b64(mixerBundle)}`);
  console.log(`  vendor/tacit-satsconnect.min.js ${sha384b64(satsConnectBundle)}`);
  console.log(`  tacit.js                        ${sha384b64(appJs)}`);
  console.log(`  classic.html                    ${sha384b64(html)}`);
  if (brBytes && cb) {
    console.log('\nEdge-compressed copy (serve via the worker /tacit.js route):');
    console.log(`  cd ${join(ROOT, 'worker')} && npx wrangler kv key put "dapp:tacit.js.br" --path ${BR_OUT} --binding REGISTRY_KV --remote --metadata '{"cb":"${cb.token}"}'`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
