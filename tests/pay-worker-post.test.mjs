// dapp/pay/eth/index.html hands the sync worker its chain with postMessage: everything in it must survive the structured clone (a function in it
// throws DataCloneError, and the page then reads the whole pool on its own thread). Checks the message's text for an arrow or a function.
//   node tests/pay-worker-post.test.mjs
import { readFileSync } from 'node:fs';
const page = readFileSync(new URL('../dapp/pay/eth/index.html', import.meta.url), 'utf8');
const at = page.indexOf('w.postMessage({ id, priv:');
if (at < 0) { console.log('FAIL  the worker post is not where this test looks'); process.exit(1); }
let depth = 0, end = at + 'w.postMessage('.length;
for (; end < page.length; end++) { const ch = page[end]; if (ch === '{' || ch === '(') depth++; else if (ch === '}' || ch === ')') { if (depth === 0) break; depth--; } }
const msg = page.slice(at, end);
const bad = /=>|\bfunction\b/.test(msg);
console.log(bad ? `FAIL  the worker message holds a function: ${msg}` : 'ok    the worker message holds no function');
process.exit(bad ? 1 : 0);
