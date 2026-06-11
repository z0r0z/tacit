// Minimal .env reader shared by the local ops scripts: KEY=VALUE pairs with
// optional `export ` prefix and optional surrounding quotes; # comment lines
// and blanks ignored. Returns null when the file doesn't exist.

import fs from 'node:fs';

export function parseEnvFile(p) {
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
