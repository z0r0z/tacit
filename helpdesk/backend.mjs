// Gateway-side LLM client. Talks to one or more OpenAI-compatible backends (a local llama-server, or any server that speaks the same API) with
// a per-attempt timeout, retry, a short circuit-breaker for dead backends, model-id discovery and an in-flight cap.
// Why it exists: a hard-killed mesh node can leave requests hanging for 30+ s before the mesh retries them itself, so the
// gateway must bound every attempt and move on.
export class BusyError extends Error {}

export function makeBackend({ urls, timeoutMs = 10000, maxAttempts = 3, maxInflight = 8, modelId = process.env.MODEL_ID, cooldownMs = 20000, now = () => Date.now() }) {
  const bs = urls.map((u) => ({ url: u.replace(/\/$/, ''), fails: 0, downUntil: 0, ok: 0, err: 0, lat: [], lastError: '', model: null, modelAt: 0 }));
  let inflight = 0;

  async function discover(b) {
    if (b.model && now() - b.modelAt < 60000) return b.model;
    try {
      const r = await fetch(`${b.url}/v1/models`, { signal: AbortSignal.timeout(3000) });
      const ids = ((await r.json()).data || []).map((m) => m.id);
      b.model = (modelId && ids.includes(modelId) && modelId) || ids.find((i) => i.startsWith('local-gguf')) || ids.find((i) => i !== 'mesh') || 'local';
    } catch { b.model = b.model || 'local'; }
    b.modelAt = now(); return b.model;
  }
  // healthy backends first, in configured order; backends in cooldown last (still tried if nothing else is left)
  const order = () => [...bs].sort((a, b) => (a.downUntil > now()) - (b.downUntil > now()));

  async function chat(messages, { temperature = 0.2, max_tokens = 300 } = {}) {
    if (!bs.length) throw new Error('no backends configured');
    if (inflight >= maxInflight) throw new BusyError('busy');
    inflight++;
    try {
      let last;
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const list = order(); const b = list[attempt % list.length]; const t0 = now();
        try {
          const model = await discover(b);
          const r = await fetch(`${b.url}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(timeoutMs),
            // Qwen3.5 thinks by default; with thinking on, the whole token budget can go to reasoning and content comes back empty
            body: JSON.stringify({ model, temperature, max_tokens, chat_template_kwargs: { enable_thinking: false }, messages }) });
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          const j = await r.json(); const text = (j.choices?.[0]?.message?.content ?? '').trim();
          if (!text) throw new Error('empty answer');
          b.ok++; b.fails = 0; b.lat.push(now() - t0); if (b.lat.length > 50) b.lat.shift();
          return { text, backend: b.url, attempts: attempt + 1 };
        } catch (e) {
          last = e; b.err++; b.fails++; b.lastError = String(e.message || e).slice(0, 80); b.model = null;
          if (b.fails >= 2) b.downUntil = now() + cooldownMs;
        }
      }
      throw new Error('all backends failed: ' + (last?.message || last));
    } finally { inflight--; }
  }
  const p50 = (a) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : null);
  const stats = () => ({ inflight, backends: bs.map((b) => ({ url: b.url, ok: b.ok, err: b.err, up: b.downUntil <= now(), p50ms: p50(b.lat), lastError: b.lastError, model: b.model })) });
  return { chat, stats };
}
