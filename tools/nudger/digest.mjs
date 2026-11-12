#!/usr/bin/env node
// node tools/nudger/digest.mjs --out DIR [--day YYYY-MM-DD] [--post]
// node tools/nudger/digest.mjs --ping            posts one "connected" line to the review channel (it records nothing)
//
// Reads DIR/commits.json (from select.mjs) and, for each commit n, DIR/findings-<n>.json (the reviewer's reply) and DIR/verdicts-<n>.json (the verifier's array),
// pairs them, and writes DIR/digest.json. (A DIR/verdicts.json of ready-made records, { commit, file, line, claim, severity, verdict, evidence }, is used instead if present.) Without --post it prints the messages as the channel would show them; with --post it sends the digest to the review channel's
// route with NUDGER_SECRET (NUDGER_API is the host, default https://api.tacit.finance). The bot token never leaves the server.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { buildDigest, mergeFindings } from './lib.mjs';
import { renderFinding, renderQuiet } from '../../worker/src/nudger.js';

const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? dflt : process.argv[i + 1]; };
const host = process.env.NUDGER_API || 'https://api.tacit.finance';
if (process.argv.includes('--ping')) {
  if (!process.env.NUDGER_SECRET) { console.error('NUDGER_SECRET is not set'); process.exit(2); }
  const res = await fetch(`${host}/nudger/digest`, { method: 'POST', headers: { Authorization: `Bearer ${process.env.NUDGER_SECRET}`, 'Content-Type': 'application/json' }, body: '{"ping":true}', signal: AbortSignal.timeout(60_000) });
  console.log(`ping: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  process.exit(res.ok ? 0 : 1);
}
const out = arg('out');
if (!out) { console.error('usage: digest.mjs --out DIR [--day YYYY-MM-DD] [--post]'); process.exit(2); }
const day = arg('day', new Date().toISOString().slice(0, 10));
const { commits } = JSON.parse(readFileSync(`${out}/commits.json`, 'utf8'));
// verdicts.json if there is one; otherwise each commit's findings-<n>.json (the reviewer's reply) paired with its verdicts-<n>.json (the verifier's)
const readJson = (f) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; } };
let verdicts = existsSync(`${out}/verdicts.json`) ? readJson(`${out}/verdicts.json`) : null;
if (!Array.isArray(verdicts)) verdicts = commits.flatMap((c) => mergeFindings(c.sha, readJson(`${out}/findings-${c.n}.json`)?.findings, readJson(`${out}/verdicts-${c.n}.json`)));
const digest = buildDigest(verdicts, commits, { day });
writeFileSync(`${out}/digest.json`, JSON.stringify(digest, null, 1));

if (!process.argv.includes('--post')) {
  console.log(`digest ${day}: ${digest.findings.length} finding(s) from ${digest.reviewed} commit(s); not posted (--post sends it)\n`);
  const show = (m) => console.log(m.content + '\n' + (m.components ? `   [ ${m.components[0].components.map((b) => b.label).join(' ] [ ')} ]\n` : '\n'));
  if (!digest.findings.length) show(renderQuiet(day, digest.reviewed));
  for (const f of digest.findings) show(renderFinding(f));
} else {
  const secret = process.env.NUDGER_SECRET;
  if (!secret) { console.error('NUDGER_SECRET is not set'); process.exit(2); }
  const res = await fetch(`${host}/nudger/digest`, { method: 'POST', headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' }, body: JSON.stringify(digest), signal: AbortSignal.timeout(60_000) });
  const text = await res.text();
  console.log(`posted: HTTP ${res.status} ${text.slice(0, 300)}`);
  process.exit(res.ok ? 0 : 1);
}
