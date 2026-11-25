import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const upstream = path.resolve(process.argv[2] || 'tacit-upstream');
const deployments = await readFile(path.join(upstream, 'dapp/confidential-deployments.js'), 'utf8');
const deskConfig = await readFile(path.join(upstream, 'btcswap-desk/config.example.json'), 'utf8');

function objectBody(source, marker) {
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `missing config marker: ${marker}`);
  const open = source.indexOf('{', start);
  assert.notEqual(open, -1, `missing object after: ${marker}`);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}' && --depth === 0) return source.slice(open, i + 1);
  }
  throw new Error(`unterminated config object: ${marker}`);
}

const signet = objectBody(deployments, '  signet:');
assert.match(signet, /chainId:\s*11155111/, 'Signet entry must target Sepolia');
assert.match(signet, /pool:\s*'0x[0-9a-fA-F]{40}'/, 'Signet pool address should be explicitly configured');
assert.match(deployments, /ticker:\s*'cTAC',\s*assetId:\s*null/,
  'current source should expose the missing cTAC asset ID that blocks a real test');
assert.match(deskConfig, /mainnet/i, 'example desk config should be clearly identified as mainnet-only');

const knownMainnetTacAsset = '0xf0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b';
const knownMainnetPool = '0x248497bf6f943cd2b39a04bf5841056c58dfd7ef196188cb4f0ac1fd11dc7c00';
assert.ok(!signet.toLowerCase().includes(knownMainnetTacAsset), 'Signet must not reuse mainnet TAC asset ID');
assert.ok(!signet.toLowerCase().includes(knownMainnetPool), 'Signet must not reuse a mainnet pool identifier');

console.log('ok - Signet preflight guard: Sepolia target/pool present; TAC asset ID unresolved; mainnet values excluded');
console.log('BLOCKED AS EXPECTED - no Signet transaction should be broadcast until maintainers confirm the TAC asset/pool mapping and test inventory.');
