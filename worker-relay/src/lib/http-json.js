// A request body read as JSON, at most `max` bytes: a larger one ends the request and fails with status 413, one that is not JSON
// with status 400.
export function readJson(req, max = 65536) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0, done = false;
    const fail = (message, status) => { if (!done) { done = true; reject(Object.assign(new Error(message), { status })); } };
    req.on('data', (c) => {
      n += c.length;
      if (n > max) {                                  // stop taking the body in, so the refusal can be sent before the connection closes
        chunks.length = 0;
        req.removeAllListeners('data');
        req.pause();
        fail('too large', 413);
      } else chunks.push(c);
    });
    req.on('end', () => {
      if (done) return;
      try { done = true; resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { done = false; fail('not JSON', 400); }
    });
    req.on('error', (e) => fail(e?.message || 'unreadable', 400));
  });
}
