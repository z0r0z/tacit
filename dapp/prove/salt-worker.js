// One grinding thread of the tab miner (tabmine.js): it grinds salts for the page that started it and reports each chunk. Between chunks it lets a message through
// (a stop, a new share size) by way of a message to itself, which a browser does not slow down in a tab left in the background as it does a timer.
import { makeGrindLoop } from '/prove/tabmine.js?cb=bce3cb31';

const ch = typeof MessageChannel === 'function' ? new MessageChannel() : null;
const rest = ch ? () => new Promise((r) => { ch.port1.onmessage = () => r(); ch.port2.postMessage(0); }) : () => new Promise((r) => setTimeout(r, 0));
const loop = makeGrindLoop({ post: (m) => postMessage(m), rest });
onmessage = (e) => loop.message(e.data);
