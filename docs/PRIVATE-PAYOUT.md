# Paying an address from a shielded balance

Pay a plain 0x address an exact amount out of your own shielded balance: deposit into the pool, find your notes from your key, and have the pool pay the address through a relayed send-and-unwrap. The recipient needs no Tacit key and no setup.

**This hides the sender only, and weakly.** The address and the amount are public on-chain, the pool is small, and anyone who can match the payout to a recent deposit can tie it to the address that made the deposit. Section 5 says what to tell a user.

Names below are the SDK object from `makeConfidentialPoolUx` (`tacit`), as in [`BUILD-A-TACIT-DAPP.md`](./BUILD-A-TACIT-DAPP.md). Amounts are in-system units (ETH has 8 decimals: 1 unit is 1e-8 ETH, `unitScale` 1e10) unless a name says Wei. The dapp's send tab does all of this when the recipient field holds a 0x address (section 3). The arithmetic, note selection and confirmation poll are in [`dapp/confidential-payout.js`](../dapp/confidential-payout.js); use them rather than rewriting them.

---

## 1. What it is

One relayed settle (`OP_SEND_AND_UNWRAP`, relay type `sendunwrap`) spends **one** of your notes and does three things at once: pays `payout` to the recipient, pays `fee` to the relay, and mints the rest of the note back to you as a hidden change note. You sign nothing on-chain and need no ETH: the relay pays the gas and takes its fee out of the amount.

| | |
|---|---|
| Public | the recipient's address, the amount they receive, the relay's fee, the time; and, from the deposit, the address that made it, its amount and its time |
| Hidden from people reading the chain | which deposit funded the payment; the value of the note that was spent; the change amount and its owner |
| Told to the relay | which note it spends (it holds that note's nullifier key), the recipient, the payout and the fee. With change it is not given the note's value or the change amount. It is never given your key |

A relayed send-and-unwrap has settled on the gen5 pool for cETH ([`0xa08346db…6ad8`](https://etherscan.io/tx/0xa08346db67a1c9af16e86017b5521d0c3b9c43564d610a6512273986f9a06ad8)) and for cUSDT ([`0xabd3d77f…a01f`](https://etherscan.io/tx/0xabd3d77f99771e811145ea447d85c1297cb5a82694d05887414d8f1f6fbca01f)). The second paid 0.56 USDT to the recipient and 0.44 USDT to the relay out of one 1.00 USDT amount.

## 2. The four steps

### Step 1. Deposit into your own shielded balance

```js
const me = tacit.identity(walletPriv);
// 0.02 ETH. amount is in-system units: amountWei / unitScale = 2e16 / 1e10.
await tacit.wrapAndSend({
  walletPriv, amountWei: 2n * 10n ** 16n, ticker: 'cETH', recipientPubHex: me.pubHex, amount: 2_000_000n,
});
```

`wrapAndSend` to your own key wraps and settles in one transaction, so there is never a pending deposit. The relay proves first (`relay.prove`, a minute or several), then one router transaction is sent from the wallet's derived Ethereum account, `tacit.account(walletPriv).address`, which must hold the amount plus gas. It needs the router (`tacit.routerConfigured()`) and refuses any recipient but you. The note appears in your balance once that transaction is mined.

A plain `wrap` or `routerWrap` only registers a pending deposit. It is not spendable until `submitWrapSettle({ built })` settles it (see "Turn the deposit into a note" in the dapp guide).

The deposit is public: the derived account, the amount and the time are on-chain. Fund that account from somewhere you are content to link to the deposit.

### Step 2. Find the balance from the key alone

```js
const { notes, byAsset, poolStats } = await tacit.balance(walletPriv);
const held = byAsset[tacit.assetByTicker.cETH.assetId.toLowerCase()];   // { value: BigInt, notes: [...] }, or undefined
```

`balance` reads the pool's logs and derives your notes from the key: wrap notes by index, memo-sealed notes such as change. It is cheap enough to poll. `recover({ walletPriv })` is the full pass and also finds notes that only the settle calldata explains; run it when a balance looks short (section 6). Every note carries `value` (a `BigInt`), `asset`, `leafIndex`, `path` and `root`. Take every input of one operation from one scan.

### Step 3. Pay, with the recipient's amount exact

`sendUnwrap` debits `amount` from the note and the recipient receives `amount − fee`. To pay an exact figure, debit the **gross**: the least amount whose fee leaves exactly what you want them to get. `planPayout` computes it and picks the note.

```js
import { makeConfidentialPoolUx } from './dapp/confidential-pool-ux.js';
import { parseRecipient, parseUnits, planPayout, makeBalanceReader, waitForPayout, underlyingUnits } from './dapp/confidential-payout.js';
import * as secp from '@noble/secp256k1';
import { keccak_256 as keccak256 } from '@noble/hashes/sha3';
import { sha256 } from '@noble/hashes/sha256';

const tacit = makeConfidentialPoolUx({ secp, keccak256, sha256, network: 'mainnet' });
const ETH = tacit.assetByTicker.cETH;

async function payEth({ walletPriv, to: rawTo, amountEth }) {
  const to = parseRecipient(rawTo, { keccak256 });                       // EIP-55 checked when mixed-case
  if (!to.ok) throw new Error(to.message);
  const net = parseUnits(amountEth, ETH.tacitDecimals);                   // what the recipient receives, exactly

  const { notes } = await tacit.balance(walletPriv);
  const minFee = BigInt(await tacit.quoteOpFee('cETH', 'sendunwrap'));    // the relay's floor for this op, live
  const feeOf = (gross) => tacit.quoteUnwrapFee(gross, 'cETH', { minFee }).fee;
  const plan = planPayout({ notes, asset: ETH.assetId, net, feeOf, minFee });
  if (!plan.ok) throw new Error(`cannot pay yet: ${plan.code}`);           // no-balance | insufficient | no-single-note

  const readBalance = makeBalanceReader({ rpc: tacit.rpc, ethCall: tacit.ethCall, address: to.address });
  const baseline = await readBalance();                                    // before submitting

  const job = await tacit.sendUnwrap({
    note: plan.note, walletPriv, recipient: to.address, amount: plan.gross, feeOpts: { minFee }, wait: false,
  });

  return waitForPayout({                                                   // step 4
    readBalance, baseline, expected: underlyingUnits(net, ETH.unitScale),
    readJob: () => tacit.relay.status(job.jobId),
  });
}
```

- `plan` on success: `{ net, fee, gross, note, change, wholeNote, total }`. Show `net`, `fee` and `gross` before anything is sent: they are what the recipient gets, what the relay takes, and what leaves the balance.
- **Pin the floor** with `feeOpts: { minFee }`, the value the fee was computed from. Without it `sendUnwrap` quotes again at submit time, and a fee that has moved since would leave the recipient short of what you promised. Quote again just before submitting and go back to the user if the fee rose.
- `wait: false` returns as soon as the relay has queued the job: `{ jobId, status, fee, payout, change, recipient }`. `payout` is what the recipient will receive; check it equals `net`.
- The fee is bound in the proof. The relay cannot raise it or change the recipient.
- A note exactly the size of `gross` has no change, so `sendUnwrap` exits the whole note (`unwrap`) with the same fee, and the result carries `net` instead of `payout`.
- For a token, read `balanceOf` instead: `makeBalanceReader({ rpc, ethCall, token: meta.underlying, address })`, and `expected` is `net × meta.unitScale` (a token with `unitScale` 1 pays `net` itself).
- The op carries its amounts as JSON numbers, so one payout is limited to 2^53 − 1 in-system units. `planPayout` refuses more.

### Step 4. Confirm from the recipient's balance

`waitForPayout` polls the recipient's public balance and returns:

| `status` | meaning |
|---|---|
| `paid` | the balance rose by at least `expected` since `baseline` |
| `timeout` | not seen within the window (12 minutes by default). Say "submitted, not yet confirmed" and show `job.jobId` |
| `failed` | the relay gave up. Nothing moved and the note is unspent |
| `lost` | the relay no longer knows the job. Rescan before trying again |

Only `paid` is success. A relay's `settled` is not final (see the trustless checklist in [`INTEGRATOR-PLAYBOOK.md`](./INTEGRATOR-PLAYBOOK.md)): the poll reads the job for progress and to stop early on a failure, and even then it reads the balance first.

If the recipient is an account that receives or spends often, its balance can move for other reasons. The job status carries the settle `txHash` once the relay has one; check that transaction's receipt as well.

### If no single note covers it: consolidate

A payout spends one note. When the total covers `plan.gross` but no note does (`plan.code === 'no-single-note'`), merge notes with a relayed self-transfer, which pays a flat relay fee, then plan again from a fresh scan:

```js
import { planMerge, notesOf } from './dapp/confidential-payout.js';

const mergeFee = await tacit.quoteTransferFee(plan.total, 'cETH');
const merge = planMerge({ notes: notesOf(notes, ETH.assetId), need: plan.gross, mergeFee });   // largest notes first, at most 16
if (merge.ok) {
  await tacit.transfer({
    walletPriv, notes: merge.notes, recipientPubHex: tacit.identity(walletPriv).pubHex, amount: merge.merged, fee: merge.fee,
  });
}
// merge.covers says whether the merged note reaches plan.gross; scan again either way.
```

A merge tells the relay that those notes belong together. `plan.code === 'insufficient'` means the total is short: deposit more or pay less.

## 3. In the dapp

On the EVM pool send tab, paste a 0x address into **To**. The note-send controls give way to a panel titled "Pay this address publicly from your shielded balance":

1. The address is checked: EIP-55 when mixed-case (a wrong checksum is refused), and the zero address, the pool, the router and the token contracts are refused. An all-lower or all-upper address has no checksum, and the review says so.
2. An asset picker lists the assets that can be paid out to an address, with the shielded balance found from the key.
3. **They receive** is the amount the recipient gets. **Review** rescans the balance, quotes the fee live and shows the recipient, the amount, the fee (with a dollar estimate when priced), the total debited, the note that will be spent and the change that comes back, and the privacy note in section 5. It warns on a whole-note payout, a fee larger than the amount, and a contract recipient.
4. With no shielded balance for the asset, or too little, **Deposit first** hands over to the send tab's own-address flow (wrap and settle in one transaction), with the recipient and asset filled in and "Always pay from my wallet" ticked.
5. With enough in total but no single note, a **Merge** button runs the self-transfer above and reviews again.
6. **Confirm** re-checks the fee (a rise sends you back to review), reads the recipient's balance, submits with `wait: false`, and polls. The result line says "Paid" only after the balance rose. On timeout it says "Submitted, not yet confirmed" with the job id.

There is no self-settle option: `sendUnwrap` is always relayed, so its fee is always charged.

## 4. Fees

The relay's fee on a payout is `max(0.30% of gross, floor)`, rounded up to at most two significant digits (the settle guest rejects a fee that is not), in the asset's own units, and capped at the amount.

- The floor is `tacit.quoteOpFee(ticker, 'sendunwrap')`: the larger of the static floor and a gas-priced one, live. `GET /confidential/quote?asset=<ticker>` returns the relay's own numbers (`staticFloorUnits`, `gasAwareFloorUnits`, in in-system units); the relay refuses an offer below its floor. Read on 2026-09-22: cETH static 10,000 units (0.0001 ETH), gas-aware 3,436; cUSD static 30,000,000 units ($0.30), gas-aware 9,550,250. Both move with gas.
- Only assets the relay can take a fee in can be paid out this way (`tacit.relayFeeEligible(ticker)`): cETH, cUSDC, cUSDT, cUSD, cBTC and cTAC.

Paying an exact amount, at the static floors (a higher live floor raises the fee):

| asset | recipient gets | floor | fee | debited |
|---|---|---|---|---|
| ETH | 0.5 | 0.0001 | 0.0016 | 0.5016 |
| ETH | 10 | 0.0001 | 0.031 | 10.031 |
| tacUSD | 1.00 | $0.30 | $0.30 | 1.30 |
| USDC | 10.00 | $0.30 | $0.30 | 10.30 |

The ladder exists because an odd-valued fee is a fingerprint: it lands in a public fee payment, and a unique value would link the payer across settles.

An amount so small that the fee would swallow it is refused (`below-fee`). A payment smaller than its fee is allowed and the dapp warns.

**Self-settled.** `sendUnwrap` has no self-settle mode: it always submits to the relay, so a partial payout always pays the relay's fee. (The settle guest accepts a payout with fee 0, but the SDK has no prove-and-submit path for this op.) A whole note can be exited with no fee if you settle it yourself, from the derived account, which then needs ETH for gas:

```js
const built = tacit.buildUnwrap({ note, walletPriv, recipient, selfSettle: true });   // fee 0, the whole note
const proven = await tacit.relay.prove({ type: 'unwrap', op: built.op, memos: [] });
await tacit.submitSettle({ settlerPriv: walletPriv, publicValues: proven.publicValues, proof: proven.proof, memos: [] });
```

To pay an exact amount this way, first make a note of exactly that value (`tacit.ensureExactNote`, a relayed self-transfer that pays its own fee). The relay still receives the witness and proves it; only the fee and the relay's address on the transaction go away. See the ETH guide, section 3 step D and section 4, for the prove-then-settle path.

## 5. Privacy: what to tell the user

- **It hides who sent the payment from people reading the chain, and nothing else.** The recipient, the amount and the fee are public. The relay is told which note it spends.
- **The crowd is small.** A payout of `gross` can only come from a note worth at least `gross`, and a note made directly from a deposit is worth what was deposited, which is public. So the candidates are the unspent notes of that asset at least that large. Say how few there are: `poolStats.outstandingNotes` counts every live note of every asset, and `coverSince({ note, poolStats })` counts the notes added since the one being spent.
- **Do not pay an amount that matches a deposit.** A payout equal to a deposit's size points straight at it. Paying part of a note leaves change and breaks the match; a payout that takes the whole note (payout plus fee equal to its value) does not. The dapp warns.
- **Wait between depositing and paying.** More activity in between means more candidates. There is no safe number of minutes.
- **The deposit is public and so is its funding.** The derived account that made it is on-chain. Anything linking that account to you links the payment to you once the payout is matched to the deposit.
- **Do not present this as anonymous.** The dapp shows the text exported as `PRIVACY_POINTS` in `dapp/confidential-payout.js`: it hides who sent it, the address and the amount are public, the pool is small, do not treat it as anonymous, pay an amount that does not match a recent deposit and wait between depositing and paying. Reuse it or say something as plain.

## 6. Errors and edge cases

| symptom | cause | do |
|---|---|---|
| `sendUnwrap: amount exceeds the note (merge notes first)` | `amount` is larger than the note | pick a note that covers `gross`, or consolidate |
| `sendUnwrap: amount too small for the relay fee` | the fee is at least the amount | pay more |
| `relay 4xx` on submit | fee below the floor, a rate limit or a full queue | quote again and retry; a rejected submit is backpressure |
| `status: 'failed'` | the proof or the settle failed | nothing moved; scan again and retry with a fresh quote |
| `status: 'unknown'` | the relay lost the job (a restart) | rescan: the note may or may not have been spent. An identical retry within the same ten-minute window is de-duplicated by the relay |
| `timeout`, not confirmed | slow proving, or the settle has not landed | keep the job id and check the recipient's balance again. The op expires about an hour after it was built, after which the note stays yours |
| the recipient is the zero address or the pool | the pool refuses it (`ZeroAddress`) | refuse it in your UI |
| the recipient is a token contract | the pool does not stop it and the tokens are normally unrecoverable | refuse it in your UI (the dapp does) |
| a token refuses the recipient | the transfer reverts, so the settle reverts | the job fails and the note is unchanged |
| the recipient is a contract without a payable receive | native ETH is force-sent, so it still arrives | none |
| the remaining balance looks short after a payout | with `wait: false` the check that the chain emitted the change memo you sealed does not run | scan again; if the change note is missing, run `recover({ walletPriv })`, which re-derives it from the settle |
| a note spent elsewhere | two processes share a key, and a scan returns every note sealed to it | give each process its own key, or keep an explicit leaf list |

## 7. Limits

- Weak privacy, sender only, as above. A single relay operator settles it: it can decline or delay a payout, and cannot redirect it or raise its fee.
- One note per payout, and no batch of payouts. The recipient is an address: a name is not resolved here.
- Assets are those the relay prices. A payout in a token needs that token to be a payable pool asset (native ETH, or an ERC20 underlying).
- The op is valid for about an hour. A payout that is not settled by then can be built again from the same note.

See also: [`BUILD-A-TACIT-DAPP.md`](./BUILD-A-TACIT-DAPP.md) sections 5 and 6 (the flows and the relay API), [`INTEGRATOR-PLAYBOOK.md`](./INTEGRATOR-PLAYBOOK.md) section 3a (paying another person with a note) and [`RECOVERY.md`](./RECOVERY.md).
