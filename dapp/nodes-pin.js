// What a page believes about community nodes, in a file with no imports so that a page which only asks "is anything pinned?" loads nothing else.
// PROBER_PUBS is the prober's public key (33-byte hex), made with `node tools/nodes-keygen.mjs` and pinned here by a normal deploy; it is rotated the
// same way. Empty until then: with none pinned no list ever verifies, the pages keep their built-in lists and never ask the prober for anything.
export const PROBER_PUBS = Object.freeze([]);
// where the pages reach the signed list and the allowlisted relay: the site's API origin, which every page's connect-src already names
export const NODES_API = 'https://api.tacit.finance/nodes';
