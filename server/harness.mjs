// Node harness for worker/src/index.js. Bridges node:http to the Web
// Request/Response pair the worker already speaks, builds `env` from
// wrangler.toml [vars] + process.env + KV/cache shims, and replaces the two
// platform services: ctx.waitUntil (floating promises on a long-lived
// process, tracked so shutdown can drain them) and the 5-minute cron
// (wall-clock-aligned so the worker's every-Nth-tick cadence matches
// Cloudflare's scheduler).

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { createKVNamespace } from './kv-store.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const WRANGLER_TOML = path.join(__dirname, '..', 'worker', 'wrangler.toml');

// Minimal parser for the worker's wrangler.toml: [vars] KEY = "value" lines
// (the config only uses single-line quoted strings) and [[kv_namespaces]]
// binding/id pairs, which the KV export script reuses.
export function parseWranglerConfig(tomlPath = WRANGLER_TOML) {
  const vars = {};
  const kvNamespaces = [];
  let section = '';
  let current = null;
  for (const raw of fs.readFileSync(tomlPath, 'utf8').split('\n')) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const sec = /^\[+([^\]]+)\]+$/.exec(line);
    if (sec) {
      section = sec[1];
      if (section === 'kv_namespaces') { current = {}; kvNamespaces.push(current); }
      continue;
    }
    const kv = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"((?:[^"\\]|\\.)*)"$/.exec(line);
    if (!kv) continue;
    if (section === 'vars') vars[kv[1]] = kv[2];
    else if (section === 'kv_namespaces' && current) current[kv[1]] = kv[2];
  }
  return { vars, kvNamespaces };
}

export function buildEnv(driver, { tomlPath = WRANGLER_TOML, extra = {} } = {}) {
  const { vars } = parseWranglerConfig(tomlPath);
  return {
    ...vars,            // wrangler [vars] as defaults…
    ...process.env,     // …overridden by real env (Render env vars, secrets)
    ...extra,
    REGISTRY_KV: createKVNamespace(driver, 'REGISTRY_KV'),
    UPLOAD_KV: createKVNamespace(driver, 'UPLOAD_KV'),
    ANALYTICS: { writeDataPoint() {} },
  };
}

// --- client IP ------------------------------------------------------------
// The worker reads CF-Connecting-IP for rate-limit bucketing. Off Cloudflare
// that header is attacker-writable, so it is always stripped from inbound
// requests and re-derived here:
//   1. x-tacit-forwarded-ip, only when x-tacit-proxy-key matches
//      PROXY_TRUST_KEY — set by the legacy workers.dev pass-through proxy so
//      old clients keep per-user rate-limit identity.
//   2. First hop of X-Forwarded-For when TRUST_PROXY=1 (Render).
//   3. Socket peer address (direct/local).
export function clientIpFrom(nodeReq, env) {
  const h = nodeReq.headers;
  const trustKey = env.PROXY_TRUST_KEY || process.env.PROXY_TRUST_KEY;
  if (trustKey && h['x-tacit-proxy-key'] === trustKey && h['x-tacit-forwarded-ip']) {
    return String(h['x-tacit-forwarded-ip']).trim();
  }
  if ((env.TRUST_PROXY ?? process.env.TRUST_PROXY) === '1' && h['x-forwarded-for']) {
    return String(h['x-forwarded-for']).split(',')[0].trim();
  }
  return nodeReq.socket?.remoteAddress || 'anon';
}

const STRIPPED_HEADERS = new Set(['cf-connecting-ip', 'x-tacit-proxy-key', 'x-tacit-forwarded-ip']);

export function toWebRequest(nodeReq, env) {
  const proto = (env.TRUST_PROXY ?? process.env.TRUST_PROXY) === '1'
    ? (nodeReq.headers['x-forwarded-proto'] || 'https')
    : 'http';
  const host = nodeReq.headers.host || 'localhost';
  const url = `${proto}://${host}${nodeReq.url}`;

  const headers = new Headers();
  for (const [name, value] of Object.entries(nodeReq.headers)) {
    if (STRIPPED_HEADERS.has(name)) continue;
    headers.set(name, Array.isArray(value) ? value.join(', ') : String(value));
  }
  headers.set('CF-Connecting-IP', clientIpFrom(nodeReq, env));

  const init = { method: nodeReq.method, headers };
  if (nodeReq.method !== 'GET' && nodeReq.method !== 'HEAD') {
    init.body = Readable.toWeb(nodeReq);
    init.duplex = 'half';
  }
  return new Request(url, init);
}

export async function writeWebResponse(resp, nodeRes) {
  const headers = {};
  for (const [k, v] of resp.headers) headers[k] = v;
  nodeRes.writeHead(resp.status, headers);
  if (!resp.body) { nodeRes.end(); return; }
  await new Promise((resolve, reject) => {
    const body = Readable.fromWeb(resp.body);
    body.on('error', reject);
    nodeRes.on('error', reject);
    nodeRes.on('finish', resolve);
    body.pipe(nodeRes);
  });
}

// --- waitUntil tracking -----------------------------------------------------
export function createCtxFactory() {
  const pending = new Set();
  const track = (p) => {
    const tracked = Promise.resolve(p)
      .catch((e) => console.error('[waitUntil]', e?.stack || e))
      .finally(() => pending.delete(tracked));
    pending.add(tracked);
    return tracked;
  };
  return {
    pending,
    makeCtx() {
      const own = new Set();
      return {
        waitUntil(p) { own.add(track(p)); },
        passThroughOnException() {},
        // Settle this invocation's waitUntil chain, including promises
        // registered while draining — Cloudflare keeps the invocation alive
        // the same way. Used by the cron loop's overlap guard.
        async _drain() {
          while (own.size) {
            const batch = [...own];
            await Promise.allSettled(batch);
            for (const p of batch) own.delete(p);
          }
        },
      };
    },
    async drainAll(timeoutMs = 10_000) {
      const deadline = Date.now() + timeoutMs;
      while (pending.size && Date.now() < deadline) {
        await Promise.race([
          Promise.allSettled([...pending]),
          new Promise((r) => setTimeout(r, 250)),
        ]);
      }
      return pending.size;
    },
  };
}

// --- HTTP server ------------------------------------------------------------
export function createTacitServer({ workerModule, env, driver, ctxFactory }) {
  return http.createServer(async (nodeReq, nodeRes) => {
    try {
      if (nodeReq.url === '/healthz') {
        await driver.get('REGISTRY_KV', '__health__'); // cheap PK probe; throws if storage is down
        nodeRes.writeHead(200, { 'Content-Type': 'application/json' });
        nodeRes.end(JSON.stringify({ ok: true, pending: ctxFactory.pending.size }));
        return;
      }
      const req = toWebRequest(nodeReq, env);
      const resp = await workerModule.fetch(req, env, ctxFactory.makeCtx());
      await writeWebResponse(resp, nodeRes);
    } catch (e) {
      console.error('[harness]', nodeReq.method, nodeReq.url, e?.stack || e);
      if (!nodeRes.headersSent) nodeRes.writeHead(500, { 'Content-Type': 'application/json' });
      if (!nodeRes.writableEnded) nodeRes.end(JSON.stringify({ error: 'internal error' }));
    }
  });
}

// --- cron -------------------------------------------------------------------
export const CRON_INTERVAL_MS = 5 * 60 * 1000;

export const nextTickDelay = (now = Date.now(), interval = CRON_INTERVAL_MS) =>
  interval - (now % interval);

export function startCron({ workerModule, env, driver, ctxFactory, intervalMs = CRON_INTERVAL_MS }) {
  let timer = null;
  let running = false;
  let stopped = false;

  async function tick() {
    if (running) { console.warn('[cron] previous tick still running, skipping'); return; }
    running = true;
    const ctx = ctxFactory.makeCtx();
    try {
      await workerModule.scheduled({ scheduledTime: Date.now(), cron: '*/5 * * * *' }, env, ctx);
      await ctx._drain();
      const swept = await driver.sweepExpired();
      if (swept > 0) console.log(`[cron] swept ${swept} expired kv rows`);
    } catch (e) {
      console.error('[cron]', e?.stack || e);
    } finally {
      running = false;
    }
  }

  function arm() {
    if (stopped) return;
    timer = setTimeout(() => { arm(); tick(); }, nextTickDelay(Date.now(), intervalMs));
  }
  arm();

  return {
    stop() { stopped = true; if (timer) clearTimeout(timer); },
    isRunning: () => running,
    tick, // exposed for a manual kick (`/scan`-style unstick, tests)
  };
}
