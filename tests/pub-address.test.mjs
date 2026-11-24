// dapp/pub-address.js: the Bitcoin address a Tacit public key holds its TAC at, and which Activity entries another wallet made.
import { btcAddressOf, pubHexOf, madeElsewhere, elsewhere } from '../dapp/pub-address.js';

let fails = 0;
const ok = (c, m) => { if (c) console.log('ok  ', m); else { fails++; console.log('FAIL', m); } };

// A real mainnet wallet: the public key is the p2wpkh input's witness of tx 9c773219…a496, and the address is what that input and both its outputs pay.
const PUB = '02878e086970118291c482270d1b1ffa3dc4a2c1cb1e567cac1635ab8296c4f30f', ADDR = 'bc1qvjfjg8la825flpwhn8820wpmt8y2aemll8ejcn';
const OTHER = '03' + '11'.repeat(32);

ok(btcAddressOf(PUB) === ADDR, 'a public key gives the address mainnet shows for it');
ok(btcAddressOf(PUB.toUpperCase()) === ADDR && btcAddressOf('0x' + PUB) === ADDR, 'capitals and a 0x prefix read the same');
ok(btcAddressOf(PUB, 'tb').startsWith('tb1q'), 'a test network gets its own prefix');
ok([undefined, null, '', 'nope', '04' + '00'.repeat(32), '02' + '0'.repeat(63), PUB + '00'].every((v) => btcAddressOf(v) === null), 'anything that is not a compressed public key gives no address');
ok(pubHexOf(` ${PUB} `) === PUB && pubHexOf('0x' + PUB.toUpperCase()) === PUB && pubHexOf('zz') === null, 'pubHexOf trims and lowercases');

ok(madeElsewhere({ pub: PUB }, OTHER), 'an entry another key made is elsewhere');
ok(!madeElsewhere({ pub: PUB }, PUB) && !madeElsewhere({ pub: PUB }, PUB.toUpperCase()), 'an entry the open key made is not, whatever the case');
ok(!madeElsewhere({}, OTHER) && !madeElsewhere({ pub: null }, OTHER), 'an entry made with no key open belongs to every key');
ok(!madeElsewhere({ pub: PUB }, null) && !madeElsewhere({ pub: 'junk' }, OTHER), 'with no key open, or a pub that is no key, nothing is elsewhere');

const list = elsewhere([{ pub: PUB }, { pub: OTHER }, { pub: PUB.toUpperCase() }, {}, { pub: PUB }], OTHER);
ok(list.length === 1 && list[0].pub === PUB && list[0].addr === ADDR && list[0].n === 3, `the other wallets are listed once each with how many entries they made (${JSON.stringify(list)})`);
ok(elsewhere([{ pub: OTHER }, {}], OTHER).length === 0 && elsewhere(null, OTHER).length === 0, 'no entries from another wallet gives an empty list');
const two = elsewhere([{ pub: OTHER }, { pub: PUB }], '02' + '22'.repeat(32));
ok(two.length === 2 && two[0].pub === OTHER, 'newest first: the order of the entries is kept');

if (fails) { console.log(`${fails} failed`); process.exit(1); }
console.log('all passed');
