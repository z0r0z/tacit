// The message a wallet signs to derive a Tacit identity. The key is a hash of the signature, and the signature is
// deterministic for a given account and message, so the same account always derives the same key and any change to
// these bytes derives a different one.
//
// The bytes are the same in every Tacit app and on every origin, so one wallet recovers the same notes wherever it
// signs in. That also means no wallet can tie the request to a site: the text itself says what the signature is
// worth and where to sign it. Ethereum and Bitcoin wallets sign the same text.

const NETWORKS = new Set(['mainnet', 'signet']);

export function identityMessage({ netName }) {
  if (!NETWORKS.has(netName)) throw new Error(`identity message: unknown network ${netName}`);
  return [
    'Tacit identity',
    '',
    'Signing this creates your Tacit private key. Anyone who has this signature controls all of your Tacit funds.',
    '',
    'Sign it only in a Tacit app you trust. Every Tacit app asks for exactly this message.',
    '',
    `network: ${netName}`,
    'version: 1',
  ].join('\n');
}
