// One grinding thread of the tab miner (tabmine.js): it grinds salts for the page that started it, on a core or (started with gpu) on the GPU, and reports each chunk. Between chunks it lets a message through
// (a stop, a new share size) by way of a message to itself, which a browser does not slow down in a tab left in the background as it does a timer.
import { makeGpuGrinder } from '/prove/saltgpu.js?cb=184cb3fb';
import { makeGrindLoop } from '/prove/tabmine.js?cb=df5187cf';

const ch = typeof MessageChannel === 'function' ? new MessageChannel() : null;
const rest = ch ? () => new Promise((r) => { ch.port1.onmessage = () => r(); ch.port2.postMessage(0); }) : () => new Promise((r) => setTimeout(r, 0));
const loop = makeGrindLoop({ post: (m) => postMessage(m), rest, gpuGrinderOf: (o) => makeGpuGrinder(o) });
onmessage = (e) => loop.message(e.data);
