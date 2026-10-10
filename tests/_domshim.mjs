// Minimal DOM and storage stand-ins for tests that import dapp modules which touch document/window/localStorage at load.
const store = new Map();
const el = () => ({ style:{}, classList:{add(){},remove(){},toggle(){},contains(){return false}},
  setAttribute(){}, getAttribute(){return null}, removeAttribute(){}, appendChild(){}, remove(){},
  addEventListener(){}, removeEventListener(){}, querySelector(){return null}, querySelectorAll(){return []},
  insertAdjacentHTML(){}, focus(){}, blur(){}, click(){}, dataset:{}, children:[], textContent:'', innerHTML:'', value:'' });
globalThis.localStorage = { getItem:(k)=>store.has(k)?store.get(k):null, setItem:(k,v)=>store.set(k,String(v)),
  removeItem:(k)=>store.delete(k), clear:()=>store.clear(), key:()=>null, get length(){return store.size} };
globalThis.sessionStorage = globalThis.localStorage;
globalThis.document = { createElement: el, createElementNS: el, createTextNode:()=>({}),
  getElementById:()=>null, querySelector:()=>null, querySelectorAll:()=>[], addEventListener(){}, removeEventListener(){},
  body: el(), documentElement: el(), head: el(), readyState:'complete', cookie:'' };
globalThis.window = { location:{ hostname:'localhost', origin:'http://localhost', href:'http://localhost/', protocol:'http:' },
  localStorage: globalThis.localStorage, document: globalThis.document, addEventListener(){}, removeEventListener(){},
  matchMedia:()=>({matches:false,addEventListener(){},removeEventListener(){}}),
  navigator:{ userAgent:'node' }, dispatchEvent(){}, CustomEvent: class {} };
globalThis.location = globalThis.window.location;
Object.defineProperty(globalThis, "navigator", { value: globalThis.window.navigator, configurable: true, writable: true });
globalThis.CustomEvent = globalThis.window.CustomEvent;
// Keep the module from starting any background work or network I/O at import time.
globalThis.setInterval = () => 0;
globalThis.setTimeout = (fn) => 0;
globalThis.requestAnimationFrame = () => 0;
globalThis.fetch = async () => { throw new Error('offline (shim)'); };
globalThis.__TACIT_NO_INIT__ = true;
globalThis.localStorage.setItem('tacit-network-v1', 'mainnet');
