#!/usr/bin/env node
// Which sides a swap link makes private (dapp/swap/link.js): the private= flag decides as it always did, a coin named by its private name adds to it,
// and a link that names cUSD or cBTC alone still opens on the public token those names once belonged to.
//
// Run: node tests/swap-link.test.mjs

import assert from 'node:assert';
import { linkName, nameKind, linkSides } from '../dapp/swap/link.js';

let n = 0;
const ok = (s) => { console.log('  ok -', s); n++; };

const ETH = '0x0000000000000000000000000000000000000000', TAC = '0xa1313eb9f3a445606d9583bcac3ebeb56a858279', USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const isEth = (k) => k === ETH;
const NOTES = new Set(['cusd', 'cbtc']);
// a link as the card reads it: the names it carries, the private flag, and the From coin as the card resolved it
const key = { eth: ETH, teth: 'teth', tac: TAC, usdc: USDC, ceth: 'teth', ctac: TAC };
const sides = (q) => {
  const p = new URLSearchParams(q), f = p.get('from');
  const resolved = f ? key[linkName(f)] || null : null;
  return linkSides({ pv: p.get('private'), fromName: f, toName: p.get('to'), fromKey: resolved }, { notes: NOTES, isEth });
};

// ── names ──
{
  assert.strictEqual(linkName('cETH'), 'teth'); assert.strictEqual(linkName(' tETH '), 'teth'); assert.strictEqual(linkName('cTAC'), 'tac');
  assert.strictEqual(linkName('USDC'), 'usdc'); assert.strictEqual(linkName(null), ''); assert.strictEqual(linkName(undefined), '');
  for (const v of ['tETH', 'teth', 'cETH', 'cTAC', 'ctac']) assert.strictEqual(nameKind(v, NOTES), 'private', v);
  for (const v of ['cUSD', 'cusd', 'cBTC']) assert.strictEqual(nameKind(v, NOTES), 'note', v);
  for (const v of ['ETH', 'TAC', 'USDC', 'tacUSD', 'tacBTC', 'WBTC', '', null, undefined]) assert.strictEqual(nameKind(v, NOTES), null, String(v));
  ok('tETH / cETH / cTAC are private names, cUSD / cBTC are note names, every public name is neither');
}

// ── the grammar that already existed, unchanged ──
{
  assert.strictEqual(sides('from=ETH&to=TAC&amt=1'), null, 'no flag, public names: the link says nothing about privacy');
  assert.deepStrictEqual(sides('from=ETH&to=TAC&private=to'), { inP: false, outP: true });
  assert.deepStrictEqual(sides('from=ETH&to=TAC&private=from'), { inP: true, outP: false });
  assert.deepStrictEqual(sides('from=TAC&to=ETH&private=both'), { inP: true, outP: true });
  assert.deepStrictEqual(sides('to=TAC&private'), { inP: false, outP: true }, 'a bare private with no From: the Get side');
  assert.deepStrictEqual(sides('from=ETH&to=TAC&private'), { inP: false, outP: true }, 'a bare private with ETH to pay: ETH is made private on the way, the Pay side stays the wallet');
  assert.deepStrictEqual(sides('from=TAC&to=cBTC&private'), { inP: true, outP: true }, 'a bare private with a token to pay: it is paid from the private balance');
  assert.deepStrictEqual(sides('from=USDC&to=TAC&private=1'), { inP: false, outP: true }, 'any value but from/both reads as to');
  ok('private=to|from|both and the bare private flag decide exactly as before');
}

// ── old links keep their meaning ──
{
  for (const q of ['to=cusd', 'from=USDC&to=cusd&amt=150', 'to=cBTC', 'from=ETH&to=cBTC&amt=0.01', 'from=cUSD&to=cBTC', 'from=TAC&to=cUSD']) {
    assert.strictEqual(sides(q), null, `${q}: a cUSD / cBTC with no private name beside it and no flag is still the public token`);
  }
  ok('a link naming cUSD / cBTC alone, without a flag, still opens on the public token (the old ?to=cusd links)');
}

// ── a private name carries its side ──
{
  assert.deepStrictEqual(sides('from=tETH'), { inP: true, outP: undefined }, 'tETH: the Pay side is private; the Get side is left alone');
  assert.deepStrictEqual(sides('from=cETH&to=TAC'), { inP: true, outP: undefined }, 'cETH is tETH');
  assert.deepStrictEqual(sides('from=ETH&to=cTAC'), { inP: undefined, outP: true }, 'cTAC: the Get side is private TAC');
  assert.deepStrictEqual(sides('from=tETH&to=USDC&amt=0.01'), { inP: true, outP: undefined }, 'a private coin paid for a public token: out of the pool');
  ok('tETH / cETH / cTAC make their own side private with no flag, and leave the other side alone');
}

// ── a note name beside a private name is a swap in the pool ──
{
  assert.deepStrictEqual(sides('from=tETH&to=cBTC&amt=0.01'), { inP: true, outP: true }, 'the tETH/cBTC pool');
  assert.deepStrictEqual(sides('from=tETH&to=cUSD'), { inP: true, outP: true });
  assert.deepStrictEqual(sides('from=cBTC&to=tETH'), { inP: true, outP: true }, 'either direction');
  assert.deepStrictEqual(sides('from=cUSD&to=cTAC'), { inP: true, outP: true }, 'cTAC counts as a private name too');
  assert.deepStrictEqual(sides('from=ETH&to=cBTC&private'), { inP: false, outP: true }, 'ETH from the wallet into private cBTC takes the flag, as it always did');
  assert.deepStrictEqual(sides('from=ETH&to=cBTC&private=to'), { inP: false, outP: true });
  ok('tETH beside cBTC / cUSD is a pool swap with no flag; ETH from the wallet into cBTC still takes private');
}

// ── a flag and a name that disagree: the private reading wins ──
{
  assert.deepStrictEqual(sides('from=tETH&to=TAC&private=to'), { inP: true, outP: true }, 'private=to with a tETH Pay side: tETH is private');
  assert.deepStrictEqual(sides('from=ETH&to=cTAC&private=from'), { inP: true, outP: true });
  assert.deepStrictEqual(sides('from=TAC&to=ETH&private=from&amt=2'), { inP: true, outP: false }, 'a flag alone is untouched by names that carry nothing');
  ok('where a flag and a private name disagree the side is private');
}

console.log(`\n${n} swap link checks passed.`);
