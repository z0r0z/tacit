// What a Docker build of a worker-relay image gets to see, as Render builds it (context = the repo root): the tracked files that the root .dockerignore lets through,
// and what each Dockerfile COPY line takes from them. The ignore rules follow moby/patternmatcher, which BuildKit uses: `*` stays inside one path segment, `**` does not,
// a later pattern overrides an earlier one, `!` lets a path back in, and a pattern that matches a parent directory matches what is under it.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const ROOT = new URL('../../../', import.meta.url).pathname;

function compile(p) {
  let re = '^';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*') {
      if (p[i + 1] === '*') { i++; if (p[i + 1] === '/') { i++; re += '(.*/)?'; } else re += '.*'; } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if ('.+()|{}$^[]\\'.includes(c)) re += `\\${c}`;
    else re += c;
  }
  return new RegExp(`${re}$`);
}
export function ignoreRules(text) {
  return text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map((l) => {
    const negate = l.startsWith('!');
    const p = (negate ? l.slice(1) : l).replace(/^\/+/, '').replace(/\/+$/, '');
    return { negate, dirs: p.split('/'), re: compile(p) };
  });
}
// true when the build leaves `file` out
export function ignored(rules, file) {
  const parent = file.includes('/') ? file.slice(0, file.lastIndexOf('/')).split('/') : null;
  let matched = false;
  for (const r of rules) {
    if (r.negate !== matched) continue;                       // an ignore already matched is not tried again, and a `!` has nothing to undo yet
    let hit = r.re.test(file);
    if (!hit && parent && r.dirs.length <= parent.length) hit = r.re.test(parent.slice(0, r.dirs.length).join('/'));
    if (hit) matched = !r.negate;
  }
  return matched;
}
export function contextFiles(root = ROOT) {
  const rules = ignoreRules(readFileSync(join(root, '.dockerignore'), 'utf8'));
  return execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28 }).split('\n').filter(Boolean).filter((f) => !ignored(rules, f));
}
// the COPY lines of a Dockerfile: { sources: [...], dest } in order (a multi-stage `--from` copy takes from another image, not the context)
export function copyLines(dockerfile, root = ROOT) {
  const out = [];
  for (const line of readFileSync(join(root, 'worker-relay', dockerfile), 'utf8').split('\n')) {
    const t = line.trim();
    if (!t.startsWith('COPY') || t.includes('--from')) continue;
    const parts = t.split(/\s+/).slice(1);
    out.push({ sources: parts.slice(0, -1), dest: parts[parts.length - 1] });
  }
  return out;
}
// the context files a COPY source takes: a glob stays inside one directory, a directory takes everything under it, a file is itself
export function takenBy(source, files) {
  const re = compile(source.replace(/\/+$/, ''));
  return files.filter((f) => re.test(f) || f.startsWith(`${source.replace(/\/+$/, '')}/`));
}
