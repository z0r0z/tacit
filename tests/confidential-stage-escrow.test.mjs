// The stage's exit escrow: the address the router names for a recipe is checked against the address its recipe gives, computed in the page.
//
// Run: node tests/confidential-stage-escrow.test.mjs
import assert from 'node:assert/strict';
import { makeConfidentialStage } from '../dapp/confidential-stage.js';

const ETH_ID = '0x' + '3c'.repeat(32), ROUTER = '0x000000005dA3E3B73726af3c774Deeb9472D4992', ESC = '0x' + 'ab'.repeat(20);
const mkUx = ({ named }) => ({
  cfg: { router: ROUTER },
  assetByTicker: { cETH: { assetId: ETH_ID } },
  router: { escrowAddressForCalldata: () => '0xcall', exitRecipeEscrow: () => named, activateExitCalldata: () => '0x12345678' },
  ethCall: async () => '0x' + '00'.repeat(12) + ESC.slice(2),
  rpc: async () => '0xb2d05e00',
  quoteOpFee: async () => 1000n,
  quoteUnwrapFee: () => ({ net: 100n }),
  nextWrapIndex: async () => 0,
  buildWrap: () => ({ commit: '0x' + '11'.repeat(32), depositId: '0xd' }),
});
const args = { note: { asset: ETH_ID, value: 1000n }, walletPriv: '0x' + '22'.repeat(32), minFee: 1n };

let pass = 0;
const test = async (label, fn) => { await fn(); console.log(`  PASS  ${label}`); pass++; };

await test('an escrow the router names that is not the one its recipe gives: nothing is built', async () => {
  const st = makeConfidentialStage({ ux: mkUx({ named: '0x' + 'ba'.repeat(20) }) });
  await assert.rejects(st.buildStage(args), /does not match its recipe/);
});

await test('an escrow the recipe gives is taken, and the stage goes on past it', async () => {
  const st = makeConfidentialStage({ ux: mkUx({ named: ESC }) });
  // the stub has no unwrap builder, so the stage stops there: after the escrow check, not at it
  await assert.rejects(st.buildStage(args), (e) => !/does not match its recipe/.test(e.message) && !/could not be read/.test(e.message));
});

console.log(`\n${pass} passed`);
