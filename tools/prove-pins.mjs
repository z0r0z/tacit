#!/usr/bin/env node
// Points dapp/prove.sh at a tacit-prover release. The script installs the one release it pins and refuses a download whose sha256 is not the pinned one,
// so cutting a release (.github/workflows/tacit-prover-release.yml publishes each archive with its .sha256) means changing three lines in it: the tag and
// the two pins. This reads the sums the release publishes and writes them.
//
//   node tools/prove-pins.mjs tacit-prover-v0.2.1    pin that release
//   node tools/prove-pins.mjs                        check the script's pins are what its own release publishes (exit 1 if not)
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const SCRIPT = new URL('../dapp/prove.sh', import.meta.url).pathname;
const RELEASES = 'https://github.com/src-company/tacit/releases/download';
export const ASSETS = [['PIN_MACOS_ARM64', 'macos-arm64'], ['PIN_LINUX_X86_64', 'linux-x86_64']];
const TAG = /^tacit-prover-v\d+\.\d+\.\d+$/;
const SUM = /^[0-9a-f]{64}$/;

// The script's text with the tag and the sums written in: `sums` maps a PIN_ name to its sha256.
export function rewrite(text, tag, sums) {
  if (!TAG.test(tag)) throw new Error(`"${tag}" is not a release tag (tacit-prover-vX.Y.Z)`);
  let out = text.replace(/^PIN_TAG=\S+$/m, `PIN_TAG=${tag}`);
  for (const [name] of ASSETS) {
    if (!SUM.test(sums[name] || '')) throw new Error(`no sha256 for ${name}`);
    out = out.replace(new RegExp(`^${name}=\\S+$`, 'm'), `${name}=${sums[name]}`);
  }
  return out;
}

// The pins as they stand in the script's text: { PIN_TAG, PIN_MACOS_ARM64, PIN_LINUX_X86_64 }.
export const pinsIn = (text) => Object.fromEntries([...text.matchAll(/^(PIN_[A-Z0-9_]+)=(\S+)$/gm)].map((m) => [m[1], m[2]]));

// What a release publishes: the first word of each archive's .sha256 file.
async function published(tag) {
  const sums = {};
  for (const [name, plat] of ASSETS) {
    const url = `${RELEASES}/${tag}/tacit-prover-${plat}.tar.gz.sha256`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url} answered ${res.status}`);
    const sum = (await res.text()).trim().split(/\s+/)[0].toLowerCase();
    if (!SUM.test(sum)) throw new Error(`${url} does not hold a sha256`);
    sums[name] = sum;
  }
  return sums;
}

async function main() {
  const text = readFileSync(SCRIPT, 'utf8');
  const have = pinsIn(text), tag = process.argv[2];
  if (!tag) {
    const sums = await published(have.PIN_TAG);
    const wrong = ASSETS.filter(([name]) => have[name] !== sums[name]).map(([name]) => name);
    if (wrong.length) { console.error(`dapp/prove.sh pins ${have.PIN_TAG}, but ${wrong.join(' and ')} differ from what the release publishes.`); process.exit(1); }
    console.log(`dapp/prove.sh pins ${have.PIN_TAG}, and both sums are the ones the release publishes.`);
    return;
  }
  const next = rewrite(text, tag, await published(tag));
  writeFileSync(SCRIPT, next);
  console.log(`dapp/prove.sh now pins ${tag}.`);
  for (const [name, plat] of ASSETS) console.log(`  ${plat.padEnd(13)} ${pinsIn(next)[name]}`);
  console.log('Run: node --test tests/prove-installer.test.mjs (LIVE=1 checks the sums against the release again), then push.');
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main().catch((e) => { console.error(e.message || e); process.exit(1); });
