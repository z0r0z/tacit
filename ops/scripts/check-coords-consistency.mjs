#!/usr/bin/env node
// Diagnostic: every entry in a reflection snapshot's `liveTriples` (the committed live-note set) should
// have a matching `coords` entry (the off-chain (cx,cy) opening needed to actually spend it). `coords` is
// NOT part of digest() — a state assembled from a partial or hand-built snapshot can pass every on-chain
// check while silently missing it for some notes, surfacing only much later as "live spend has no known
// coords" the moment someone tries to spend that exact note. Run this against a fresh /reflection/dump
// after any manual snapshot reconstruction, migration, or generation cutover to catch the gap early.
//
// Usage: BOX_TOKEN=<token> node ops/scripts/check-coords-consistency.mjs [--network=mainnet] [dump.json]
//   - With a dump.json path, checks that file directly (no network calls).
//   - Without one, fetches https://api.tacit.finance/reflection/dump?network=<network> using BOX_TOKEN.
//
// A missing note's (cx,cy) is usually still recoverable from its OWN creation envelope on Bitcoin (a
// crossout-mint or CXFER reveal script carries them in cleartext) — decode that reveal tx with
// `classifyConfidentialTx` (dapp/burn-deposit-bitcoin.js) rather than guessing or leaving the note unspendable.

const args = process.argv.slice(2);
const fileArg = args.find((a) => !a.startsWith('--'));
const network = (args.find((a) => a.startsWith('--network='))?.split('=')[1]) || 'mainnet';

async function loadDump() {
  if (fileArg) {
    const { readFileSync } = await import('node:fs');
    return JSON.parse(readFileSync(fileArg, 'utf8'));
  }
  const token = process.env.BOX_TOKEN;
  if (!token) throw new Error('set BOX_TOKEN, or pass a dump.json path directly');
  const res = await fetch(`https://api.tacit.finance/reflection/dump?network=${network}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`dump fetch failed: ${res.status} ${await res.text()}`);
  return res.json();
}

const dump = await loadDump();
const snap = dump.snapshot || {};
const coordKeys = new Set((snap.coords || []).map(([k]) => String(k).toLowerCase()));
const live = snap.liveTriples || [];
const missing = live.filter(([key]) => !coordKeys.has(String(key).toLowerCase()));

console.log(`attestedHeight=${dump.attestedHeight} live=${live.length} coords=${snap.coords?.length ?? 0}`);
if (!missing.length) {
  console.log('OK — every live note has a matching coords entry.');
  process.exit(0);
}
console.log(`FOUND ${missing.length} live note(s) with NO coords entry (unspendable until recovered):`);
for (const [key, , asset, authKey, bound] of missing) {
  console.log(`  key=${key} asset=${asset} authKey=${authKey} bound=${bound}`);
}
process.exit(1);
