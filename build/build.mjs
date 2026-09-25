// Build script: refreshes ../dapp/vendor/tacit-deps.min.js from npm-installed
// noble + scure + sats-connect packages and prints SHA-384 hashes for the
// bundle, index.html, and tacit.js. Run when bundled deps change; otherwise
// the dApp is served as-is from ../dapp/.
//
// The dApp source is split: ../dapp/index.html (markup + meta-CSP) loads
// ../dapp/tacit.js (the application module), which imports from
// ./vendor/tacit-deps.min.js. Editing either source file directly does not
// require a build — only the vendor bundle is generated.

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
const HTML       = join(DAPP_DIR, 'index.html');
const APP_JS     = join(DAPP_DIR, 'tacit.js');               // app code (extracted from inline)
const PREBOOT    = join(DAPP_DIR, 'preboot.js');             // head-loaded, SW-cached like tacit.js
const PRF_WALLET = join(DAPP_DIR, 'prf-wallet.js');          // passkey/PRF key derivation, SW-cached like tacit.js
const SW_JS      = join(DAPP_DIR, 'sw.js');
const VERIFY_HTML = join(DAPP_DIR, 'verify.html');   // self-contained verifier; its inline module is CSP-hash-pinned
const OUT_DIR    = join(HERE, 'out');                        // build artifacts (gitignored)
const BR_OUT     = join(OUT_DIR, 'tacit.js.br');             // brotli-q11 copy for the edge route

const verifyOnly = process.argv.includes('--verify-only');

async function bundleVendor() {
  if (verifyOnly) {
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
  if (verifyOnly) {
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
  if (verifyOnly) {
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
  if (verifyOnly) {
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
// index.html so it tracks the current bytes of dapp/tacit.js. iOS Safari
// serves stale modulepreloaded ESM to long-lived tabs even with
// max-age=0; bumping the URL forces all clients to fetch fresh on next
// load. Token is a short sha256 prefix of tacit.js — idempotent (no-op
// if tacit.js bytes haven't changed) and impossible to forget because
// it runs on every build. Returns true if index.html changed.
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
// carries a sha256 prefix of the file it names, rewritten importer-last (secret.js, then app.js, then the
// page that loads app.js) so each token covers bytes already final. Returns the drift it found; writes only
// when asked, so --verify-only reuses the same walk.
const SATS_CB_FILES = ['sats/secret.js', 'sats/app.js', 'sats/index.html'];
function satsCacheBust(write) {
  const drift = [];
  for (const rel of SATS_CB_FILES) {
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
function updateVerifyCsp(htmlText) {
  const digest = verifyCspDigest(htmlText);
  if (!digest) return { changed: false, digest: null };
  const after = htmlText.replace(/script-src '(?:unsafe-inline|sha256-[A-Za-z0-9+/=]+)'/, `script-src '${digest}'`);
  if (after === htmlText) return { changed: false, digest };
  writeFileSync(VERIFY_HTML, after);
  return { changed: true, digest };
}

async function main() {
  mkdirSync(VENDOR_DIR, { recursive: true });

  console.log(verifyOnly ? '• Reading existing bundle...' : '• Bundling vendor deps...');
  const bundle = await bundleVendor();
  console.log(`  ${BUNDLE_OUT}`);
  console.log(`  ${bundle.length.toLocaleString()} bytes · ${sha384b64(bundle)}`);

  console.log(verifyOnly ? '• Reading existing mixer bundle...' : '• Bundling mixer deps (snarkjs)...');
  const mixerBundle = await bundleMixer();
  console.log(`  ${MIXER_OUT}`);
  console.log(`  ${mixerBundle.length.toLocaleString()} bytes · ${sha384b64(mixerBundle)}`);

  console.log(verifyOnly ? '• Reading existing sats-connect bundle...' : '• Bundling sats-connect...');
  const satsConnectBundle = await bundleSatsConnect();
  console.log(`  ${SATSCONNECT_OUT}`);
  console.log(`  ${satsConnectBundle.length.toLocaleString()} bytes · ${sha384b64(satsConnectBundle)}`);

  console.log(verifyOnly ? '• Reading existing poseidon bundle...' : '• Bundling poseidon (Bitcoin pool)...');
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
    if (gotCb !== wantCb) drift.push(`index.html tacit.js ?cb=${gotCb} but sha256(dapp/tacit.js)=${wantCb}`);
    if (gotPreboot !== wantPreboot) drift.push(`index.html preboot.js ?cb=${gotPreboot} but sha256(dapp/preboot.js)=${wantPreboot}`);
    if (gotSw !== wantSw) drift.push(`sw.js CACHE_VERSION suffix ${gotSw} but sha256(vendor‖prf-wallet)=${wantSw}`);
    drift.push(...satsCacheBust(false));
    if (drift.length) {
      console.error('✗ cache-bust tokens are stale — run `npm run build` and commit the result:');
      for (const d of drift) console.error(`    ${d}`);
      process.exit(1);
    }
    if (existsSync(VERIFY_HTML)) {
      const vText = readFileSync(VERIFY_HTML).toString('utf8');
      const want = verifyCspDigest(vText);
      const got = (/script-src '(sha256-[A-Za-z0-9+/=]+)'/.exec(vText) || [])[1] || null;
      if (want && got !== want) {
        console.error('✗ verify.html CSP script hash is stale — run `npm run build` and commit the result:');
        console.error(`    script-src '${got}' but sha256(inline module)=${want}`);
        process.exit(1);
      }
      if (want) console.log(`• verify.html CSP hash verified: ${want}`);
    }
    console.log(`• Cache-bust tokens verified: tacit.js ${wantCb} · preboot ${wantPreboot} · SW ${wantSw}`);
  }
  if (!verifyOnly) {
    cb = updateCacheBust(html, appJs, preboot);
    console.log(`• Cache-bust token: ?cb=${cb.token}${cb.changed ? ' (updated)' : ' (unchanged)'} · preboot ?cb=${cb.prebootToken}`);
    if (cb.changed) html = readFileSync(HTML);
    const satsDrift = satsCacheBust(true);
    console.log(`• sats page cache-bust: ${satsDrift.length ? `${satsDrift.length} token(s) updated` : 'unchanged'}`);

    if (existsSync(VERIFY_HTML)) {
      const v = updateVerifyCsp(readFileSync(VERIFY_HTML).toString('utf8'));
      if (v.digest) console.log(`• verify.html CSP hash: ${v.digest}${v.changed ? ' (updated)' : ' (unchanged)'}`);
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
  console.log(`  index.html                      ${sha384b64(html)}`);
  if (brBytes && cb) {
    console.log('\nEdge-compressed copy (serve via the worker /tacit.js route):');
    console.log(`  cd ${join(ROOT, 'worker')} && npx wrangler kv key put "dapp:tacit.js.br" --path ${BR_OUT} --binding REGISTRY_KV --remote --metadata '{"cb":"${cb.token}"}'`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
