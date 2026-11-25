// Minimal S3 client (SigV4, path-style) for the transcript mirror: list, head, put a stream. No dependencies.
import crypto from 'node:crypto';
import https from 'node:https';

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const hmac = (k, s) => crypto.createHmac('sha256', k).update(s).digest();

export function s3(cfg) {
  const { endpoint, region = 'us-east-1', key, secret } = cfg;
  const host = new URL(endpoint).host;

  function sign(method, path, query, headers) {
    const now = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
    const day = now.slice(0, 8);
    const h = { ...headers, host, 'x-amz-date': now };
    h['x-amz-content-sha256'] ??= 'UNSIGNED-PAYLOAD';
    const names = Object.keys(h).map((n) => n.toLowerCase()).sort();
    const lower = Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), String(v).trim()]));
    const canon = [method, path, query, names.map((n) => `${n}:${lower[n]}\n`).join(''), names.join(';'), lower['x-amz-content-sha256']].join('\n');
    const scope = `${day}/${region}/s3/aws4_request`;
    const toSign = ['AWS4-HMAC-SHA256', now, scope, sha(canon)].join('\n');
    const k = hmac(hmac(hmac(hmac('AWS4' + secret, day), region), 's3'), 'aws4_request');
    lower.authorization = `AWS4-HMAC-SHA256 Credential=${key}/${scope}, SignedHeaders=${names.join(';')}, Signature=${hmac(k, toSign).toString('hex')}`;
    return lower;
  }

  function req(method, path, { query = '', headers = {}, body } = {}) {
    const enc = path.split('/').map(encodeURIComponent).join('/');
    const h = sign(method, enc, query, headers);
    return new Promise((resolve, reject) => {
      const r = https.request({ host, method, path: enc + (query ? '?' + query : ''), headers: h, timeout: 600_000 }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
      });
      r.on('timeout', () => r.destroy(new Error('s3 timeout')));
      r.on('error', reject);
      if (body && typeof body.pipe === 'function') body.on('error', (e) => r.destroy(e)).pipe(r);
      else r.end(body);
    });
  }

  return {
    list: (bucket, prefix = '') => req('GET', `/${bucket}`, { query: `list-type=2&prefix=${encodeURIComponent(prefix)}` }),
    head: (bucket, k) => req('HEAD', `/${bucket}/${k}`),
    get: (bucket, k) => req('GET', `/${bucket}/${k}`),
    del: (bucket, k) => req('DELETE', `/${bucket}/${k}`),
    // body: Buffer/string, or a readable stream with its exact length.
    put: (bucket, k, body, length, extra = {}) =>
      req('PUT', `/${bucket}/${k}`, { headers: { 'content-length': length, ...extra }, body }),
    createBucket: (bucket) => req('PUT', `/${bucket}`),
  };
}
