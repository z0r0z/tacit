#!/usr/bin/env node
// Build a Render-ready env file for the tacit-api service WITHOUT printing any
// secret value. Reads the existing local env files, remaps their key names to
// the names worker/src/index.js expects, and writes .env.tacit-api-render
// (gitignored, mode 600). Keys not stored locally are emitted as commented
// FILL lines for you to paste by hand.
//
//   node scripts/render-env-build.mjs
//
// Then review/fill .env.tacit-api-render and drag it into Render's
// service -> Environment -> "Add from .env".

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, '.env.tacit-api-render');

// crude but sufficient .env reader: KEY=VALUE, optional `export `, optional
// surrounding quotes; # comment lines and blanks ignored.
function parseEnv(rel) {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) return null;
  const out = {};
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let v = m[2];
    if (!/^["']/.test(v)) v = v.replace(/\s+#.*$/, '').trim();
    else if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[m[1]] = v;
  }
  return out;
}

const SRC = {
  '.env': parseEnv('.env'),
  '.env.mainnet': parseEnv('.env.mainnet'),
  'discord/.env': parseEnv('discord/.env'),
};

// workerKey, sourceFile, localKey, optional verify-note
const MAP = [
  ['DEBUG_TOKEN',            '.env',         'DEBUG_TOKEN'],
  ['PROVER_HEARTBEAT_TOKEN', '.env.mainnet', 'PROVER_HEARTBEAT_TOKEN'],
  ['DISCORD_BOT_TOKEN',      'discord/.env', 'DISCORD_TOKEN'],
  ['DISCORD_BOT_SECRET',     'discord/.env', 'DISCORD_BOT_SECRET'],
  ['DISCORD_APPLICATION_ID', 'discord/.env', 'DISCORD_CLIENT_ID'],
  ['TAC_ROLE_ID',            'discord/.env', 'TAC_ROLE_ID'],
  ['DAPP_URL',               'discord/.env', 'DAPP_URL'],
  ['FAUCET_PRIV',            '.env',         'SIGNET_PRIVKEY', 'verify this is the live faucet key'],
];

// not derivable from local files — fill before importing
const FILL = [
  ['PINATA_JWT',           'Pinata dashboard'],
  ['DISCORD_PUBLIC_KEY',   'Discord dev portal -> your app -> General Information'],
  ['VERIFY_SERVICE_URL',   'the tacit-verify Render service URL'],
  ['VERIFY_SERVICE_TOKEN', 'read off the tacit-verify service env (must MATCH it)'],
  ['CEREMONY_INIT_TOKEN',  'any value; both ceremonies finalized so effectively inert'],
];

const lines = [];
const filled = [];
const missingSource = [];

lines.push('# tacit-api secret bundle for Render "Add from .env" (the flip / cutover step).');
lines.push('# Generated locally by scripts/render-env-build.mjs. Real secret values — never commit.');
lines.push('# Do NOT add CRON_DISABLED here: at the flip you REMOVE it so Render begins scanning.');
lines.push('');
lines.push('TRUST_PROXY=1');
lines.push('');

for (const [workerKey, file, localKey, note] of MAP) {
  const v = SRC[file] ? SRC[file][localKey] : undefined;
  if (v) {
    if (note) lines.push(`# ${workerKey}: ${note} (mapped from ${file}:${localKey})`);
    lines.push(`${workerKey}=${v}`);
    filled.push(`${workerKey}  <-  ${file}:${localKey}${note ? '   [VERIFY: ' + note + ']' : ''}`);
  } else {
    lines.push(`# ${workerKey} — source ${file}:${localKey} not found; fill manually`);
    lines.push(`# ${workerKey}=`);
    missingSource.push(`${workerKey}  (expected ${file}:${localKey})`);
  }
}

const proxyKey = crypto.randomBytes(32).toString('hex');
lines.push('');
lines.push('# PROXY_TRUST_KEY: generated here. Set the SAME value on worker/proxy at cutover');
lines.push('# (cd worker/proxy && npx wrangler secret put PROXY_TRUST_KEY).');
lines.push(`PROXY_TRUST_KEY=${proxyKey}`);

lines.push('');
lines.push('# --- FILL THESE IN (not stored locally), then uncomment the KEY= line ---');
for (const [k, hint] of FILL) {
  lines.push(`# ${k} — ${hint}`);
  lines.push(`# ${k}=`);
}
lines.push('');

fs.writeFileSync(OUT, lines.join('\n'), { mode: 0o600 });

// summary: KEY NAMES ONLY — never values
console.log(`wrote ${path.relative(ROOT, OUT)}  (mode 600, gitignored by .env.*)\n`);
console.log('filled from local files:');
for (const f of filled) console.log('  ' + f);
if (missingSource.length) {
  console.log('\nEXPECTED locally but not found (fill manually):');
  for (const m of missingSource) console.log('  ' + m);
}
console.log('\ngenerated:');
console.log('  PROXY_TRUST_KEY   (also set the same value on worker/proxy at cutover)');
console.log('\nstill to fill by hand (commented in the file):');
for (const [k, hint] of FILL) console.log(`  ${k}  — ${hint}`);
console.log('\nnext: open the file, fill the commented keys, then Render -> tacit-api');
console.log('      -> Environment -> "Add from .env" (do this at the flip, not now).');
