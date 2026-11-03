// A request line that is no URL (`//`, `/\`, `//[`) throws in `new URL(req.url, base)`. In a handler that is async, or runs in the server's request
// listener, that ends the whole process and every route with it: these answer it instead.
export function parseUrl(req, base = 'http://localhost') {
  try { return new URL(req.url, base); } catch { return null; }
}
export function badRequest(res) {
  try {
    res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
    res.end('{"error":"bad request"}');
  } catch { /* the socket is gone */ }
}
