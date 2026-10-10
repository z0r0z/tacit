// The question the Secret Sats mainnet panel puts to the wallet's owner before a payment is posted from their own Bitcoin
// address (payPrivately's `askSelf`): a yes, a no, the relay posting it meanwhile (abort) and no answer at all.
//   node tests/secret-ask-self-ui.test.mjs
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><body><span id="host"></span></body>');
globalThis.document = dom.window.document;
const { askSelfIn } = await import('../dapp/sats/secret.js');

const host = () => { const h = document.createElement('span'); document.body.append(h); return h; };
const buttons = (h) => [...h.querySelectorAll('button')];
const click = (h, label) => buttons(h).find((b) => b.textContent === label).click();
const YES = 'Post it from my Bitcoin address', NO = 'Not now';

// A yes.
{
  const h = host(), p = askSelfIn(h)('no-relay');
  assert.match(h.textContent, /The relay didn’t take this payment\. Post it from your Bitcoin address instead\? Your Bitcoin address shows as the sender\./);
  assert.deepEqual(buttons(h).map((b) => b.textContent), [YES, NO]);
  click(h, YES);
  assert.equal(await p, true);
  assert.equal(h.children.length, 0, 'the question leaves the page once answered');
}
// A no.
{
  const h = host(), p = askSelfIn(h)('relay-slow', { timedOut: true });
  assert.match(h.textContent, /The relay hasn’t posted it in five minutes\./);
  click(h, NO);
  assert.equal(await p, false);
  assert.equal(h.children.length, 0);
}
// The relay posts it while the question is open: the question ends as a no, and the caller takes the relay's carrier.
{
  const h = host(), ctl = new AbortController(), p = askSelfIn(h)('relay-slow', { timedOut: true, signal: ctl.signal });
  assert.equal(buttons(h).length, 2);
  ctl.abort();
  assert.equal(await p, false);
  assert.equal(h.children.length, 0);
  // A click after that changes nothing.
  assert.equal(buttons(h).length, 0);
}
// Already aborted before it is asked.
{
  const h = host(), ctl = new AbortController(); ctl.abort();
  assert.equal(await askSelfIn(h)('relay-slow', { signal: ctl.signal }), false);
  assert.equal(h.children.length, 0, 'no question is left behind');
}
// No answer: ten minutes pass.
{
  const real = globalThis.setTimeout; let ms = null;
  globalThis.setTimeout = (fn, t, ...a) => { ms = t; return real(fn, 0, ...a); };
  const h = host();
  try { assert.equal(await askSelfIn(h)('no-relay'), false); } finally { globalThis.setTimeout = real; }
  assert.equal(ms, 10 * 60e3);
  assert.equal(h.children.length, 0);
}

console.log('secret-ask-self-ui: all checks passed');
process.exit(0);
