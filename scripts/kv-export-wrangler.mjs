// KV snapshot via the local wrangler OAuth login — no API token needed.
// Reads the key list produced by `wrangler kv key list --remote`, then pulls
// values 100 at a time through the REST bulk/get endpoint, paced under
// Cloudflare's API rate limit. Output is the NDJSON format kv-import.mjs
// consumes. Resumable: keys already in the output file are skipped, except
// those matching --refetch-prefixes (the delta-sync knob for mutable state).
//
//   node scripts/kv-export-wrangler.mjs \
//     --list ~/tacit-kv-export/registry-keys.json \
//     --ns REGISTRY_KV --namespace-id 0079… \
//     --out ~/tacit-kv-export/kv-export.ndjson \
//     [--refetch-prefixes meta:,cnt:,pool:]
//
// Keys carrying metadata (the dapp bundle) are fetched individually as raw
// bytes — bulk/get is text-only.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const LIST = flag('list');
const NS = flag('ns', 'REGISTRY_KV');
const NS_ID = flag('namespace-id');
const OUT = flag('out');
const REFETCH = (flag('refetch-prefixes', '') || '').split(',').filter(Boolean);
const ACCOUNT = flag('account', 'c63709e5b5d60391b8afc4296d9c532c');
const RPS = Number(flag('rps', '3.5'));
if (!LIST || !NS_ID || !OUT) {
  console.error('required: --list <keys.json> --namespace-id <id> --out <ndjson>');
  process.exit(1);
}

const WRANGLER_CONFIG = [
  path.join(os.homedir(), 'Library/Preferences/.wrangler/config/default.toml'),
  path.join(os.homedir(), '.wrangler/config/default.toml'),
  path.join(os.homedir(), '.config/.wrangler/config/default.toml'),
].find((p) => fs.existsSync(p));
if (!WRANGLER_CONFIG) { console.error('no wrangler config — run `wrangler login` first'); process.exit(1); }

const WORKER_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'worker');

function readToken() {
  const m = /oauth_token\s*=\s*"([^"]+)"/.exec(fs.readFileSync(WRANGLER_CONFIG, 'utf8'));
  if (!m) { console.error('no oauth_token in wrangler config'); process.exit(1); }
  return m[1];
}
function refreshToken() {
  // any wrangler command refreshes the OAuth token on disk
  execFileSync('npx', ['wrangler', 'whoami'], { cwd: WORKER_DIR, stdio: 'ignore' });
  return readToken();
}

let token = readToken();
const API = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/storage/kv/namespaces/${NS_ID}`;

let lastStart = 0;
const spacing = 1000 / RPS;
async function paced() {
  const wait = lastStart + spacing - Date.now();
  lastStart = Math.max(Date.now(), lastStart + spacing);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

async function bulkGet(keys, attempt = 0) {
  await paced();
  const resp = await fetch(`${API}/bulk/get`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ keys }),
  }).catch(() => null);
  if (resp?.status === 401 && attempt < 2) { token = refreshToken(); return bulkGet(keys, attempt + 1); }
  if ((!resp || resp.status === 429 || resp.status >= 500) && attempt < 8) {
    await new Promise((r) => setTimeout(r, Math.min(60_000, 2000 * 2 ** attempt)));
    return bulkGet(keys, attempt + 1);
  }
  if (!resp?.ok) throw new Error(`bulk/get ${resp?.status}: ${await resp?.text()}`);
  const body = await resp.json();
  if (!body.success) throw new Error(`bulk/get: ${JSON.stringify(body.errors)}`);
  return body.result.values || {};
}

async function rawGet(name, attempt = 0) {
  await paced();
  const resp = await fetch(`${API}/values/${encodeURIComponent(name)}`, {
    headers: { Authorization: `Bearer ${token}` },
  }).catch(() => null);
  if (resp?.status === 401 && attempt < 2) { token = refreshToken(); return rawGet(name, attempt + 1); }
  if ((!resp || resp.status === 429 || resp.status >= 500) && attempt < 8) {
    await new Promise((r) => setTimeout(r, Math.min(60_000, 2000 * 2 ** attempt)));
    return rawGet(name, attempt + 1);
  }
  if (resp?.status === 404) return null;
  if (!resp?.ok) throw new Error(`values/${name}: ${resp?.status}`);
  return Buffer.from(await resp.arrayBuffer());
}

const listing = JSON.parse(fs.readFileSync(LIST.replace(/^~/, os.homedir()), 'utf8'));
const info = new Map(listing.map((k) => [k.name, k]));

const outPath = OUT.replace(/^~/, os.homedir());
const seen = new Set();
if (fs.existsSync(outPath)) {
  const rl = readline.createInterface({ input: fs.createReadStream(outPath), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try { const { ns, key } = JSON.parse(line); if (ns === NS) seen.add(key); } catch { /* torn tail line */ }
  }
}

const wantsRefetch = (name) => REFETCH.some((p) => name.startsWith(p));
const textKeys = [];
const binaryKeys = [];
for (const k of listing) {
  if (seen.has(k.name) && !wantsRefetch(k.name)) continue;
  (k.metadata ? binaryKeys : textKeys).push(k.name);
}
console.log(`${listing.length} listed, ${seen.size} already exported, fetching ${textKeys.length} text + ${binaryKeys.length} raw`);

const out = fs.createWriteStream(outPath, { flags: 'a' });
const writeRow = (key, valueB64) => {
  const meta = info.get(key) || {};
  out.write(JSON.stringify({
    ns: NS,
    key,
    value_b64: valueB64,
    metadata: meta.metadata ?? null,
    expiration: meta.expiration ?? null,
  }) + '\n');
};

let done = 0, missed = 0;
const started = Date.now();
for (let i = 0; i < textKeys.length; i += 100) {
  const batch = textKeys.slice(i, i + 100);
  const values = await bulkGet(batch);
  for (const key of batch) {
    const v = values[key];
    if (v === undefined || v === null) { missed++; continue; } // expired between list and read
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    writeRow(key, Buffer.from(s, 'utf8').toString('base64'));
    done++;
  }
  if ((i / 100) % 50 === 0) {
    const rate = done / ((Date.now() - started) / 1000) || 1;
    const eta = Math.round((textKeys.length - i) / rate / 60);
    console.log(`${done}/${textKeys.length} (~${eta}m left, ${missed} expired)`);
  }
}

for (const key of binaryKeys) {
  const buf = await rawGet(key);
  if (buf === null) { missed++; continue; }
  writeRow(key, buf.toString('base64'));
  done++;
}

await new Promise((r) => out.end(r));
console.log(`done: ${done} exported, ${missed} expired mid-export, ${Math.round((Date.now() - started) / 60000)}m elapsed`);
