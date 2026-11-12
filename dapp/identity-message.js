
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
