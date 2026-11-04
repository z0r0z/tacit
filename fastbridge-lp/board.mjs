#!/usr/bin/env node
// The board for fast bridge providers and users: ads that providers sign, sealed requests for a provider and its sealed answers.
// It holds nothing that has to be trusted (dapp/fastbridge-board.js) and keeps everything in memory: ads and messages for ten minutes,
// the wants of users waiting for a provider for a day.
//
//   FB_BOARD_PORT=8788  FB_BOARD_ORIGINS=https://tacit.finance,https://www.tacit.finance  FB_BOARD_TRUST_PROXY=1
//   node fastbridge-lp/board.mjs        (Node 22; run from the repository root)

import { makeBoard } from '../dapp/fastbridge-board.js';
import { makeBoardHandler, boardKindOf } from './lib/board-http.mjs';
import { makeHttpServer } from './lib/http.mjs';
process.on('unhandledRejection', (e) => console.log(JSON.stringify({ ts: new Date().toISOString(), level: 'error', msg: 'unhandled rejection', error: String((e && e.message) || e).slice(0, 200) })));

const port = Number(process.env.FB_BOARD_PORT || 8788);
const origins = String(process.env.FB_BOARD_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
const board = makeBoard();
const server = makeHttpServer({
  handle: makeBoardHandler(board), origins, maxBody: 131072, trustProxy: !!process.env.FB_BOARD_TRUST_PROXY, kindOf: boardKindOf,
  limits: { default: [120, 60], write: [240, 60], want: [30, 3600] },
});
server.listen(port, () => console.log(JSON.stringify({ ts: new Date().toISOString(), level: 'info', msg: 'fast bridge board', port, origins })));
setInterval(() => console.log(JSON.stringify({ ts: new Date().toISOString(), level: 'info', msg: 'board', ...board.stats() })), 600000).unref();
