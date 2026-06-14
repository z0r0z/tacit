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
import { parseEnvFile } from './env.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, '.env.tacit-api-render');

const parseEnv = (rel) => parseEnvFile(path.join(ROOT, rel));

// Re-runs preserve what an earlier run generated or the user hand-filled
// (commented `# KEY=` stubs don't parse, so only real values carry over).
// Regenerating PROXY_TRUST_KEY in particular would silently desync an
// already-deployed proxy.
const prev = parseEnvFile(OUT) ?? {};

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
  ['MAESTRO_API_KEY',      'Maestro dashboard (mainnet project with the Esplora API enabled)'],
];

// Coverage: every env key the worker reads must be accounted for — mapped,
// fill-listed, a wrangler binding, or a [vars] default. Anything else comes
// up undefined on Render with no error, so report it loudly instead.
function workerEnvReads() {
  const keys = new Set();
  const srcDir = path.join(ROOT, 'worker', 'src');
  for (const f of fs.readdirSync(srcDir).filter((n) => n.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(srcDir, f), 'utf8');
    for (const m of src.matchAll(/\benv\.([A-Z][A-Z0-9_]+)\b/g)) keys.add(m[1]);
  }
  return keys;
}
function wranglerProvided() {
  const toml = fs.readFileSync(path.join(ROOT, 'worker', 'wrangler.toml'), 'utf8');
  const keys = new Set();
  for (const m of toml.matchAll(/^\s*binding\s*=\s*"([A-Z0-9_]+)"/gm)) keys.add(m[1]);
  const vars = toml.split(/^\[vars\]\s*$/m)[1]?.split(/^\[/m)[0] ?? '';
  for (const m of vars.matchAll(/^\s*([A-Z][A-Z0-9_]*)\s*=/gm)) keys.add(m[1]);
  return keys;
}

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
  const v = SRC[file]?.[localKey] ?? prev[workerKey];
  if (v) {
    const fromPrev = !SRC[file]?.[localKey];
    if (note) lines.push(`# ${workerKey}: ${note} (mapped from ${file}:${localKey})`);
    lines.push(`${workerKey}=${v}`);
    filled.push(`${workerKey}  <-  ${fromPrev ? 'previous bundle' : `${file}:${localKey}`}${note ? '   [VERIFY: ' + note + ']' : ''}`);
  } else {
    lines.push(`# ${workerKey} — source ${file}:${localKey} not found; fill manually`);
    lines.push(`# ${workerKey}=`);
    missingSource.push(`${workerKey}  (expected ${file}:${localKey})`);
  }
}

const proxyKey = prev.PROXY_TRUST_KEY || crypto.randomBytes(32).toString('hex');
lines.push('');
lines.push('# PROXY_TRUST_KEY: generated here. Set the SAME value on worker/proxy at cutover');
lines.push('# (cd worker/proxy && npx wrangler secret put PROXY_TRUST_KEY).');
lines.push(`PROXY_TRUST_KEY=${proxyKey}`);

lines.push('');
lines.push('# --- FILL THESE IN (not stored locally), then uncomment the KEY= line ---');
const unfilled = [];
for (const [k, hint] of FILL) {
  lines.push(`# ${k} — ${hint}`);
  if (prev[k]) lines.push(`${k}=${prev[k]}`);
  else { lines.push(`# ${k}=`); unfilled.push([k, hint]); }
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
console.log(prev.PROXY_TRUST_KEY ? '\npreserved from previous bundle:' : '\ngenerated:');
console.log('  PROXY_TRUST_KEY   (also set the same value on worker/proxy at cutover)');
if (unfilled.length) {
  console.log('\nstill to fill by hand (commented in the file):');
  for (const [k, hint] of unfilled) console.log(`  ${k}  — ${hint}`);
}

const accounted = new Set([
  ...MAP.map(([k]) => k), ...FILL.map(([k]) => k),
  'PROXY_TRUST_KEY', 'TRUST_PROXY', 'CRON_DISABLED',
  ...wranglerProvided(),
]);
const unmapped = [...workerEnvReads()].filter((k) => !accounted.has(k)).sort();
if (unmapped.length) {
  console.log('\nWORKER READS THESE ENV KEYS but the bundle does not account for them');
  console.log('(add to MAP or FILL, or confirm each is intentionally Render-dashboard-only):');
  for (const k of unmapped) console.log('  ' + k);
}

console.log('\nnext: open the file, fill the commented keys, then Render -> tacit-api');
console.log('      -> Environment -> "Add from .env" (do this at the flip, not now).');
