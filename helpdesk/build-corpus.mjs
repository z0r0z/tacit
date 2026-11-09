#!/usr/bin/env node
// node build-corpus.mjs OUT.json [ref]   -- reads ONLY from git (default origin/main), never the working tree.
// Set REPO to the checkout whose history to read (default: the current directory).
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const REPO = process.env.REPO || '.', OUT = process.argv[2], REF = process.argv[3] || 'origin/main', CHUNK_MAX = 1800;
// Public, user-facing pages only. Dev guides, runbooks, task lists and unlaunched-feature docs are left out on purpose.
export const MANIFEST = ['README.md', 'SECURITY.md', 'audit/AUDITS.md',
  'docs/TAC.md', 'docs/RECOVERY.md', 'docs/AIRDROP.md', 'docs/FARMS.md', 'docs/VIRTUAL-FARMS.md', 'docs/PRIVATE-PAYOUT.md', 'docs/VERIFY-LIVE.md', 'docs/CEREMONY.md',
  'docs/EVM-POOL.md', 'docs/DEPLOYMENTS.md', 'docs/AMM.md', 'docs/ASSOC-POOL.md', 'docs/BRIDGE.md', 'docs/FAST-BRIDGE.md',
  'docs/COMMUNITY-OPS.md', 'docs/OPEN-RELAYER.md', 'docs/RUN-A-RELAY.md', 'docs/POOL-BLOCKS.md', 'docs/TACIT-BLOCKS.md',
  'dapp/prove/index.html'];
const show = (p) => execFileSync('git', ['-C', REPO, 'show', `${REF}:${p}`], { encoding: 'utf8', maxBuffer: 64 << 20 });
const htmlToText = (t) => t.replace(/<(script|style)[\s\S]*?<\/\1>/gi, '').replace(/<h([1-3])[^>]*>/gi, (_, n) => '\n' + '#'.repeat(+n) + ' ')
  .replace(/<(br|\/p|\/li|\/div|\/section|\/h[1-6])[^>]*>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n');

function chunkText(text, name) {
  const out = []; let heads = [], buf = [], inFence = false;
  const flush = () => {
    const body = buf.join('\n').trim(); buf = []; if (!body) return;
    const title = `${name} > ${heads.filter(Boolean).join(' > ')}`; let cur = '';
    const push = () => { if (cur.trim()) out.push({ title, text: `[${title}]\n${cur.trim()}` }); cur = ''; };
    for (const para of body.split(/\n\s*\n/)) for (const piece of para.length > CHUNK_MAX ? para.split('\n') : [para]) { if (cur.length + piece.length > CHUNK_MAX) push(); cur += piece + '\n\n'; }
    push();
  };
  for (const line of text.split('\n')) {
    if (/^```/.test(line)) inFence = !inFence;
    const m = !inFence && /^(#{1,3})\s+(.*)$/.exec(line);
    if (m) { flush(); const d = m[1].length; heads = heads.slice(0, d - 1); heads[d - 1] = m[2].trim(); } else buf.push(line);
  }
  flush(); return out;
}
if (process.argv[1].endsWith('build-corpus.mjs')) {
  const sha = execFileSync('git', ['-C', REPO, 'rev-parse', '--short', REF], { encoding: 'utf8' }).trim();
  const chunks = [], per = {};
  for (const p of MANIFEST) { const raw = show(p); const c = chunkText(p.endsWith('.html') ? htmlToText(raw) : raw, p.split('/').pop()); per[p] = c.length; chunks.push(...c); }
  writeFileSync(OUT, JSON.stringify({ ref: REF, commit: sha, builtAt: new Date().toISOString(), files: per, chunks }));
  console.log(`corpus from ${REF} @ ${sha}: ${chunks.length} chunks, ${Math.round(chunks.reduce((a, c) => a + c.text.length, 0) / 1024)} KB`);
}
