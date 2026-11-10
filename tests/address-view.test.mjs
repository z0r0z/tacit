import assert from 'node:assert/strict';
import { JSDOM } from './_jsdom.mjs';

const dom = new JSDOM('<!doctype html><head></head><body></body>');
globalThis.document = dom.window.document;
const { addrView, addrFlat } = await import('../dapp/address-view.js');

const A = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
const text = (s) => { const d = document.createElement('div'); d.innerHTML = s; return d; };

// the text in the markup is exactly the value, nothing added: what find-in-page reads and a copied selection holds
assert.equal(text(addrView(A, 4)).textContent, A);
assert.ok(!addrView(A, 4).includes('…'), 'the ellipsis is drawn by the stylesheet, so it is not in what is copied');
assert.match(document.getElementById('tv-css').textContent, /::after \{ content: "…"/);
// what shows when collapsed: the first n + 2 and the last n, as short(a, n) does
const v = text(addrView(A, 4)).firstChild;
assert.equal(v.children[0].textContent, A.slice(0, 6));
assert.equal(v.children[2].textContent, A.slice(-4));
assert.equal(v.querySelector('.tv-e').getAttribute('aria-hidden'), 'true', 'the ellipsis is not read out');
assert.equal(v.querySelector('.tv-e').textContent, '');
assert.equal(v.getAttribute('tabindex'), '0', 'it can be focused to open it');
// the stylesheet is added once, to the page, and an ellipsis click is not swallowed
addrView(A, 4); addrView(A, 6);
assert.equal(document.querySelectorAll('#tv-css').length, 1);
assert.match(document.getElementById('tv-css').textContent, /:focus/);
assert.doesNotMatch(document.getElementById('tv-css').textContent, /pointer-events/, 'a tap on the ellipsis reaches the value');
// a value with nothing to hide is shown whole, and a value is never trusted as markup
assert.equal(addrView('0x1234', 4), '0x1234');
assert.equal(addrView('', 4), '');
assert.equal(addrView(null, 4), '');
const evil = '0x<img src=x onerror=alert(1)>aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"\'&';
const e = text(addrView(evil, 4));
assert.equal(e.querySelector('img'), null);
assert.equal(e.textContent, evil);
// a long tacit1… address, with its own head length, splits its middle in two halves around the ellipsis
const T = 'tacit1' + 'q'.repeat(60) + 'xyz1';
const t = text(addrView(T, 12, 18)).firstChild;
assert.equal(t.children[0].textContent, T.slice(0, 18));
assert.equal(t.children[2].textContent, T.slice(-12));
assert.equal(text(addrView(T, 12, 18)).textContent, T);
// inside a link: the same text, short, with the whole value as its title and no focus of its own
const f = text(addrFlat(A, 4)).firstChild;
assert.equal(text(addrFlat(A, 4)).textContent, A);
assert.equal(f.getAttribute('tabindex'), null, 'a link cannot hold a second focus stop');
assert.equal(f.getAttribute('title'), A);
assert.ok(f.classList.contains('tv') && f.classList.contains('tv-f'));
assert.equal(f.children[0].textContent, A.slice(0, 6));
assert.equal(f.children[2].textContent, A.slice(-4));
assert.equal(addrFlat('0x1234', 4), '0x1234');
const fe = text(addrFlat(evil, 4));
assert.equal(fe.querySelector('img'), null);
assert.equal(fe.firstChild.getAttribute('title'), evil, 'the title is escaped, not trusted');
assert.equal(fe.textContent, evil);
console.log('address view checks passed');
// a view with no tail (only the start is shown) does not repeat the whole value as its tail
const s0 = text(addrView(A, 0, 18)).firstChild;
assert.equal(s0.children[0].textContent, A.slice(0, 18));
assert.equal(s0.children[2].textContent, '');
assert.equal(text(addrView(A, 0, 18)).textContent, A);
assert.equal(text(addrFlat(A, 0, 18)).textContent, A);
console.log('address view no-tail checks passed');
