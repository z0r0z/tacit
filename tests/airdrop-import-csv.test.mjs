// tools/airdrop-import-csv.mjs: Etherscan holder CSV parsing.
import { test } from 'node:test';
import assert from 'node:assert';
import { parseDecimal, parseCsv, holdersFromCsv } from '../tools/airdrop-import-csv.mjs';

const A = '0x' + '11'.repeat(20), B = '0x' + '22'.repeat(20);

test('decimal strings with thousands separators become exact integers at the token decimals', () => {
  assert.equal(parseDecimal('333,333,333', 18), 333333333n * 10n ** 18n);
  assert.equal(parseDecimal('256,898,995.316965522935596627', 18), 256898995316965522935596627n);
  assert.equal(parseDecimal('0.913606935538026085', 18), 913606935538026085n);
  assert.throws(() => parseDecimal('1.0000000000000000001', 18), /more than 18 decimals/);
  assert.throws(() => parseDecimal('abc', 18), /bad number/);
});

test('quoted fields with commas parse, and CRLF line endings are handled', () => {
  const rows = parseCsv('"HolderAddress","Balance"\r\n"0xabc","1,000"\r\n');
  assert.deepEqual(rows, [['HolderAddress', 'Balance'], ['0xabc', '1,000']]);
});

test('an ERC20 export becomes raw balances sorted from the largest, lowercase, zero balances dropped', () => {
  const csv = `"HolderAddress","Balance","PendingBalanceUpdate"\n"${A.toUpperCase().replace('0X', '0x')}","1,000","No"\n"${B}","2,500.5","No"\n"0x${'33'.repeat(20)}","0","No"\n`;
  const h = holdersFromCsv(csv, { type: 'erc20', decimals: 18 });
  assert.deepEqual(h.map((x) => x.address), [B, A]);
  assert.equal(h[0].balance, (25005n * 10n ** 17n).toString());
});

test('an ERC721 export reads the Quantity column as a count', () => {
  const csv = `"HolderAddress","Quantity","PendingBalanceUpdate"\n"${A}","285","No"\n"${B}","1","No"\n`;
  assert.deepEqual(holdersFromCsv(csv, { type: 'erc721', decimals: 0 }).map((x) => x.balance), ['285', '1']);
});

test('rejects the wrong column, duplicate holders and malformed rows', () => {
  assert.throws(() => holdersFromCsv(`"HolderAddress","Quantity"\n"${A}","1"\n`, { type: 'erc20', decimals: 18 }), /expected a Balance column/);
  assert.throws(() => holdersFromCsv(`"HolderAddress","Balance"\n"${A}","1"\n"${A}","2"\n`, { type: 'erc20', decimals: 18 }), /duplicate holder/);
  assert.throws(() => holdersFromCsv(`"HolderAddress","Balance"\n"nope","1"\n`, { type: 'erc20', decimals: 18 }), /bad address/);
  assert.throws(() => holdersFromCsv(`"Address","Balance"\n"${A}","1"\n`, { type: 'erc20', decimals: 18 }), /not an Etherscan holder export/);
});
