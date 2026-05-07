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

const sha384b64 = buf => 'sha384-' + createHash('sha384').update(buf).digest('base64');

async function main() {
  mkdirSync(VENDOR_DIR, { recursive: true });

  console.log(verifyOnly ? '• Reading existing bundle...' : '• Bundling vendor deps...');
  const bundle = await bundleVendor();
  console.log(`  ${BUNDLE_OUT}`);
  console.log(`  ${bundle.length.toLocaleString()} bytes · ${sha384b64(bundle)}`);

  if (!existsSync(HTML)) throw new Error(`source not found: ${HTML}`);
  if (!existsSync(APP_JS)) throw new Error(`source not found: ${APP_JS}`);
  const html = readFileSync(HTML);
  const appJs = readFileSync(APP_JS);
  console.log(`  ${HTML}`);
  console.log(`  ${html.length.toLocaleString()} bytes · ${sha384b64(html)}`);
  console.log(`  ${APP_JS}`);
  console.log(`  ${appJs.length.toLocaleString()} bytes · ${sha384b64(appJs)}`);

  console.log('\nDone. Pin /Users/z/tacit/dapp/ to IPFS:');
  console.log('  ipfs add -r /Users/z/tacit/dapp');
  console.log('\nIntegrity hashes (publish in release notes):');
  console.log(`  vendor/tacit-deps.min.js  ${sha384b64(bundle)}`);
  console.log(`  tacit.js                  ${sha384b64(appJs)}`);
  console.log(`  index.html                ${sha384b64(html)}`);
}

main().catch(e => { console.error(e); process.exit(1); });
