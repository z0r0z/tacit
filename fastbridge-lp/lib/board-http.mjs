// The board (dapp/fastbridge-board.js) over HTTP: the handler a server mounts, and the client a provider or a user's page uses.
// Bodies are JSON with the sealed bytes in base64.
//
//   GET  /health   GET /ads   PUT /ad {ad}   POST /m/<gateway> {b}   GET /m/<gateway>/<after>   PUT /r/<id> {b, sig}   GET /r/<id>
//   GET  /wants    PUT /want {want}

import { BoardError } from '../../dapp/fastbridge-board.js';

const b64 = (bytes) => { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = (text) => {
  if (typeof text !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) throw new BoardError(400, 'not base64');
  const s = atob(text), out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
};
const reply = (body, status = 200) => ({ status, body });

export function makeBoardHandler(board) {
  return async function handle({ method, path, body }) {
    try {
      if (method === 'GET' && path === '/health') return reply({ ok: true, ...board.stats() });
      if (method === 'GET' && path === '/ads') return reply({ ads: board.ads() });
      if (method === 'PUT' && path === '/ad') return reply(board.putAd(body));
      if (method === 'GET' && path === '/wants') return reply({ wants: board.wants() });
      if (method === 'PUT' && path === '/want') return reply(board.putWant(body));
      let m;
      if (method === 'POST' && (m = /^\/m\/([0-9a-f]{66})$/.exec(path))) return reply(board.post(m[1], unb64(body && body.b)));
      if (method === 'GET' && (m = /^\/m\/([0-9a-f]{66})\/(\d{1,12})$/.exec(path))) {
        const r = board.inbox(m[1], Number(m[2]));
        return reply({ boot: r.boot, next: r.next, items: r.items.map((x) => ({ seq: x.seq, id: x.id, b: b64(x.bytes) })) });
      }
      if (method === 'PUT' && (m = /^\/r\/([0-9a-f]{32})$/.exec(path))) return reply(board.putReply(m[1], unb64(body && body.b), body && body.sig));
      if (method === 'GET' && (m = /^\/r\/([0-9a-f]{32})$/.exec(path))) { const r = board.reply(m[1]); return r ? reply({ b: b64(r) }) : reply({ error: 'no answer yet' }, 404); }
      return reply({ error: 'not found' }, 404);
    } catch (e) {
      return reply({ error: e instanceof BoardError ? e.message : 'the board could not answer' }, e instanceof BoardError ? e.status : 500);
    }
  };
}

// What a message costs the board to take is the dear kind of request: it gets the smaller bucket. A want is posted once per bridge a
// user waits with and costs nothing to make up, so it has its own, far smaller one.
export const boardKindOf = (method, path) => (method === 'PUT' && path === '/want' ? 'want' : method === 'POST' || method === 'PUT' ? 'write' : 'default');
