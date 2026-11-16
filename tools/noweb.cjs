// Cuts a test suite off from the internet: preloaded with `node --require tools/noweb.cjs` by
// tools/run-js-suites.mjs --offline, which is how CI runs the worker and relay suites.
//
// WHY: a suite that quietly reaches a public node or a live endpoint passes on a good day and fails on a bad one, and a
// gate that fails for reasons unrelated to the diff is a gate people learn to ignore. Blocking the internet makes that
// dependence a loud, immediate failure at authoring time instead. Localhost stays reachable, because several suites
// legitimately spawn a local server and drive it.
const http = require('node:http'), https = require('node:https'), net = require('node:net');
const LOCAL = /^(localhost|127\.0\.0\.1|::1|0\.0\.0\.0)$/i;
const blocked = (host) => host && !LOCAL.test(String(host));

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  let host = '';
  try { host = new URL(typeof url === 'string' ? url : (url && url.url) || '').hostname; } catch { host = ''; }
  if (blocked(host)) throw new Error(`NOWEB: blocked fetch to ${host}`);
  return realFetch(url, init);
};

for (const mod of [http, https]) {
  const req = mod.request.bind(mod), get = mod.get.bind(mod);
  const guard = (fn) => function (a, b, c) {
    const host = typeof a === 'string' ? (() => { try { return new URL(a).hostname; } catch { return ''; } })() : (a && (a.hostname || a.host)) || '';
    if (blocked(host)) throw new Error(`NOWEB: blocked request to ${host}`);
    return fn(a, b, c);
  };
  mod.request = guard(req);
  mod.get = guard(get);
}

const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (opts, ...rest) {
  const host = typeof opts === 'object' && opts ? opts.host : rest[0];
  if (typeof opts === 'object' && blocked(host)) throw new Error(`NOWEB: blocked socket to ${host}`);
  return connect.call(this, opts, ...rest);
};
