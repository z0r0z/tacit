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
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE       = dirname(fileURLToPath(import.meta.url));
const ROOT       = resolve(HERE, '..');                     // /Users/z/tacit
const DAPP_DIR   = join(ROOT, 'dapp');                      // production output (pin this)
const VENDOR_DIR = join(DAPP_DIR, 'vendor');
const BUNDLE_OUT = join(VENDOR_DIR, 'tacit-deps.min.js');
const MIXER_OUT  = join(VENDOR_DIR, 'tacit-mixer.min.js'); // separate bundle, lazy-loaded
const HTML       = join(DAPP_DIR, 'index.html');
const APP_JS     = join(DAPP_DIR, 'tacit.js');               // app code (extracted from inline)

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

const sha384b64 = buf => 'sha384-' + createHash('sha384').update(buf).digest('base64');

// Rewrite the `?cb=<token>` cache-bust handle on tacit.js URLs in
// index.html so it tracks the current bytes of dapp/tacit.js. iOS Safari
// serves stale modulepreloaded ESM to long-lived tabs even with
// max-age=0; bumping the URL forces all clients to fetch fresh on next
// load. Token is a short sha256 prefix of tacit.js — idempotent (no-op
// if tacit.js bytes haven't changed) and impossible to forget because
// it runs on every build. Returns true if index.html changed.
function updateCacheBust(htmlBytes, appJsBytes) {
  const token = createHash('sha256').update(appJsBytes).digest('hex').slice(0, 8);
  const before = htmlBytes.toString('utf8');
  const after = before.replace(/(\.\/tacit\.js\?cb=)[A-Za-z0-9_-]+/g, `$1${token}`);
  if (before === after) return { changed: false, token };
  writeFileSync(HTML, after);
  return { changed: true, token };
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

  if (!existsSync(HTML)) throw new Error(`source not found: ${HTML}`);
  if (!existsSync(APP_JS)) throw new Error(`source not found: ${APP_JS}`);
  let html = readFileSync(HTML);
  const appJs = readFileSync(APP_JS);

  if (!verifyOnly) {
    const cb = updateCacheBust(html, appJs);
    console.log(`• Cache-bust token: ?cb=${cb.token}${cb.changed ? ' (updated)' : ' (unchanged)'}`);
    if (cb.changed) html = readFileSync(HTML);
  }

  console.log(`  ${HTML}`);
  console.log(`  ${html.length.toLocaleString()} bytes · ${sha384b64(html)}`);
  console.log(`  ${APP_JS}`);
  console.log(`  ${appJs.length.toLocaleString()} bytes · ${sha384b64(appJs)}`);

  console.log('\nDone. Pin /Users/z/tacit/dapp/ to IPFS:');
  console.log('  ipfs add -r /Users/z/tacit/dapp');
  console.log('\nIntegrity hashes (publish in release notes):');
  console.log(`  vendor/tacit-deps.min.js   ${sha384b64(bundle)}`);
  console.log(`  vendor/tacit-mixer.min.js  ${sha384b64(mixerBundle)}`);
  console.log(`  tacit.js                   ${sha384b64(appJs)}`);
  console.log(`  index.html                 ${sha384b64(html)}`);
}

main().catch(e => { console.error(e); process.exit(1); });
