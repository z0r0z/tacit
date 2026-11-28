// Takes the relay API's private-route fetch for this page: a page that calls the relay loads this once (dapp/private-route.js apiFetch). What it fetches is read at each call by the
// code that talks to the relay, so a call made before this has loaded is a plain fetch, as it always was.
import { apiFetch } from '/private-route.js?cb=d9ec9e79';
globalThis.__tacitRelayFetch ||= apiFetch();
