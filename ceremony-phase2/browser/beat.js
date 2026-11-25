// Keeps a place in the queue: polls /slot on a timer inside a worker. A page's timers are slowed to about once a minute once its tab has
// been in the background for a while, and the coordinator reads that silence as someone leaving; a worker's timers are not slowed that way.
//   post {api, token, every(ms)} to start, {stop: true} to end; it posts {state} on each answer and {lost: true} if the place is gone.
let timer = null, stopped = false;
self.onmessage = (e) => {
  const m = e.data;
  if (m.stop) { stopped = true; clearTimeout(timer); return; }
  const { api, token, every } = m;
  const tick = async () => {
    if (stopped) return;
    try {
      const r = await fetch(`${api}/slot`, { headers: { 'X-Ceremony-Token': token } });
      if (r.status === 404) { self.postMessage({ lost: true }); return; }
      if (r.ok) self.postMessage({ state: await r.json() });
    } catch { /* the next beat tries again */ }
    if (!stopped) timer = setTimeout(tick, every);
  };
  tick();
};
