// scripts/lib/permit.mjs: the EIP-2612 permit the relay's key signs for the registry's stake, checked against viem's own typed-data hashing and a recovered signer.
//   node worker-relay/tests/permit-sign.test.mjs
import assert from 'node:assert/strict';
import { hashTypedData, hashDomain, recoverAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { permitDigest, signPermit } from '../scripts/lib/permit.mjs';

let n = 0;
const check = async (name, fn) => { await fn(); n++; console.log(`ok - ${name}`); };
const account = privateKeyToAccount('0x' + '5c'.repeat(32));
const domain = { name: 'Tacit Token', version: '1', chainId: 1, verifyingContract: '0xA1313eb9f3A445606D9583bcAc3ebeB56a858279' };
const types = { Permit: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] };
const REGISTRY = '0x00000000000299F48Fb844626ab96c6A20059a01';
const domainSeparator = hashDomain({ domain, types: { EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }] } });
const client = { readContract: async ({ functionName }) => (functionName === 'DOMAIN_SEPARATOR' ? domainSeparator : 7n) };

await check('the digest is the one an EIP-712 library makes for a Permit', () => {
  const message = { owner: account.address, spender: REGISTRY, value: 1000n * 10n ** 18n, nonce: 7n, deadline: 1_800_000_000n };
  assert.equal(permitDigest({ domainSeparator, ...message }), hashTypedData({ domain, types, primaryType: 'Permit', message }));
});
await check('the signature is the account\'s over that digest, split into v (27 or 28), r and s, and recovers to the account', async () => {
  const value = 2500n * 10n ** 18n, deadline = 1_800_000_123n;
  const p = await signPermit({ account, client, token: domain.verifyingContract, spender: REGISTRY, value, deadline });
  assert.equal(p.deadline, deadline);
  assert.ok(p.v === 27 || p.v === 28);
  assert.match(p.r, /^0x[0-9a-f]{64}$/); assert.match(p.s, /^0x[0-9a-f]{64}$/);
  const hash = hashTypedData({ domain, types, primaryType: 'Permit', message: { owner: account.address, spender: REGISTRY, value, nonce: 7n, deadline } });
  assert.equal(await recoverAddress({ hash, signature: { r: p.r, s: p.s, v: BigInt(p.v) } }), account.address);
});
await check('a different value, spender, nonce or deadline is a different digest (the permit covers exactly this stake)', () => {
  const base = { domainSeparator, owner: account.address, spender: REGISTRY, value: 1n, nonce: 0n, deadline: 5n };
  const d = permitDigest(base);
  for (const change of [{ value: 2n }, { spender: account.address }, { nonce: 1n }, { deadline: 6n }, { owner: REGISTRY }]) assert.notEqual(permitDigest({ ...base, ...change }), d);
});
console.log(`\n${n} passed`);
