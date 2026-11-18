// Starts the relay service (src/evm-pool-keepers.js) the way a laptop needs it: whatever the service asks of the project's own relay (the pool's history, to seed a new store) goes
// through the private route, sealed and carried by a forwarder, so the relay that answers sees a forwarder and not this machine. Everything else is the service as it is.
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join, dirname } from 'node:path';
import { ROUTE } from '../../dapp/private-route.js';
import { makeSealedFetch } from '../../dapp/sealed-request.js';

const service = join(dirname(fileURLToPath(import.meta.url)), '../src/evm-pool-keepers.js');
const real = globalThis.fetch.bind(globalThis);
let sealed = null;
globalThis.fetch = (url, init) => {
  if (!String(url).startsWith(`${ROUTE.keeper}/`)) return real(url, init);
  sealed ||= makeSealedFetch({ keeper: ROUTE.keeper, chainId: ROUTE.id, gateway: ROUTE.gateway, forwarders: ROUTE.forwarders });
  return sealed(String(url), init);
};
process.argv[1] = service;                        // the service starts itself only when it is the script that was run
await import(pathToFileURL(service).href);
