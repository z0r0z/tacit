// The message an external wallet signs to derive a Tacit identity. The key is a hash of the signature, and the
// signature is deterministic for a given account and message, so the same account always derives the same key and
// any change to these bytes derives a different one. Every derivation site builds its message here.
//
// The Ethereum form is a Sign-In with Ethereum (EIP-4361) message bound to tacit.finance: wallets that check
// sign-in domains show it cleanly on tacit.finance and warn on any other origin. The nonce and issue time are
// fixed because the message must be identical on every sign-in. The Bitcoin form carries the same instruction as
// text, since Bitcoin wallets have no sign-in domain check.

export const IDENTITY_DOMAIN = 'tacit.finance';
export const IDENTITY_URI = 'https://tacit.finance';
const CHAIN_ID = { mainnet: 1, signet: 11155111 };
const NONCE = 'tacitidentity';
const ISSUED_AT = '2026-09-22T00:00:00Z';

// EIP-55 mixed-case checksum of a 20-byte address given as hex (with or without 0x).
export function eip55(address, keccak256) {
  const hex = String(address).toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]{40}$/.test(hex)) throw new Error('eip55: expected a 20-byte hex address');
  const h = keccak256(new TextEncoder().encode(hex));
  let out = '0x';
  for (let i = 0; i < 40; i++) {
    const nibble = (h[i >> 1] >> (i % 2 === 0 ? 4 : 0)) & 0xf;
    out += nibble >= 8 ? hex[i].toUpperCase() : hex[i];
  }
  return out;
}

export function ethIdentityMessage({ address, netName, keccak256 }) {
  const chainId = CHAIN_ID[netName];
  if (!chainId) throw new Error(`identity message: unknown network ${netName}`);
  return [
    `${IDENTITY_DOMAIN} wants you to sign in with your Ethereum account:`,
    eip55(address, keccak256),
    '',
    `Derive your Tacit identity on ${netName}. Sign this only on ${IDENTITY_URI}; it sends no transaction and moves no funds.`,
    '',
    `URI: ${IDENTITY_URI}`,
    'Version: 1',
    `Chain ID: ${chainId}`,
    `Nonce: ${NONCE}`,
    `Issued At: ${ISSUED_AT}`,
  ].join('\n');
}

export function btcIdentityMessage({ netName }) {
  if (!CHAIN_ID[netName]) throw new Error(`identity message: unknown network ${netName}`);
  return [
    `${IDENTITY_DOMAIN}: derive your Tacit identity on ${netName}.`,
    '',
    `Sign this only on ${IDENTITY_URI}. It sends no transaction and moves no funds.`,
  ].join('\n');
}
