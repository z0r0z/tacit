# Confidential pool dapp UI — build plan (verified 2026-06-12)

The settle-relay BACKEND is done + validated on-chain (queue at api.tacit.finance + the vast `cps`
loop; a real wrap→transfer→settle round-tripped on Sepolia — see [[project_confidential_pool_sepolia]]).
What remains is the dapp frontend. This plan is verified against the current code (a prior Explore pass
had the right structure but a wrong selector — corrected below). Build it in a focused session.

## Live deployment (Sepolia)
- ConfidentialPool: `0xdd08be04b9831115dD8c7B50A26C36B333a72E2a`
- cETH assetId: `0x2a0f3cb492f4add38bada8b7ef18de79445846ce7c5b7dc1c4b0d768467a04c2` (native ETH, unitScale 1, 18 dec)
- CHAIN_BINDING: `0x2dded84a3bbe3f9571366ed251d86b996c465abb8c57ff4d2d955bb508d9a43c`
- vkey `0x009cb098`, SP1 verifier `0x6F9a1D26`, chainId 11155111

## Verified building blocks (exist today)
- EVM wallet/tx: `dapp/tacit.js` `_ethProvider()` (57209), `_ethRpcCall(method, params)` (9994, wallet-then-public-RPC fallback), `_ETH_PUBLIC_RPCS[11155111]` (9953), `_pad32(hex)` (10128). Send pattern: `provider.request({method:'eth_sendTransaction', params:[{from,to,value,data}]})` (see tETH bridge ~10256).
- Wallet seed: `wallet.priv` (32-byte secp scalar, unlocked from localStorage) — feed it to `deriveNote`.
- Confidential crypto: `dapp/confidential-pool.js` (`commitXY/deriveNote/leaf/nullifier/depositId/Tree/verifyPath`), `dapp/confidential-transfer.js` (`buildTransfer` → `{inC,outC,rangeProof,kernel:{R,z}}`), `dapp/confidential-indexer.js` (`makeConfidentialIndexer().index/recover`), `dapp/confidential-memo.js` (`sealMemo/openMemo/scan`), `dapp/confidential-relay.js` (`makeConfidentialRelay({base:'https://api.tacit.finance'}).submitOp/waitForSettle`).
- Op-builder reference: `tests/e2e-confidential-settle.mjs` builds + self-verifies a real wrap/transfer pair — the UI does the same in-browser.

## Verified specifics (corrections)
- `wrap(bytes32,uint256,bytes32)` selector = **`0x8be3ad21`** — the third arg is `commit = keccak(Cx‖Cy‖owner)`; the raw coords/owner stay off-chain (in the OP_WRAP witness), so the deposit note's nullifier is not publicly computable. `settle(bytes,bytes,bytes[])` = `0x717fd7f2`.
- Events: `Wrap(bytes32 indexed depositId, bytes32 indexed assetId, uint256 amount, bytes32 cx, bytes32 cy, bytes32 owner)`; `Settled(bytes32 indexed newRoot, uint256 leavesInserted, uint256 nullifiersSpent)`; `LeavesInserted(uint256 indexed firstLeafIndex, bytes32[] leaves, bytes[] memos)`; `NullifiersSpent(bytes32[] nullifiers)` (ConfidentialPool.sol:285-291).
- `settle()` requires exactly ONE memo per inserted leaf (else `MemoLeafMismatch` 0x2763eb74) — every op the UI submits carries `memos.length == #output leaves`.

## The deposit→consume reality (decides the on-ramp)
`wrap()` only records a PENDING deposit; the note is spendable only after an OP_WRAP settle consumes it.
OP_WRAP's witness needs the depositor's blinding `r` (the guest proves `C` opens to `(value,r)`), so a
box daemon CANNOT auto-consume from the Wrap event (it never learns `r`). Therefore the depositor must
drive the consume: **add `'wrap'` as a relay queue type** so the client submits `{type:'wrap', op, memos:[memo]}`
and the box loop proves it with `exec-wrap.rs` (already written + on the box). Backend edits:
- `worker/src/confidential-settle.js:29` — add `'wrap'` to the allowed types. (worker change → manual Render redeploy)
- `scripts/confidential-settle-loop.sh` `harness_for()` — add `wrap) echo "exec-wrap.rs";;`.
- The box harness `exec-wrap.rs` builds the OP_WRAP stdin from the same op JSON `tests/e2e-confidential-settle.mjs` emits.

## UI surface
Add a top-level **Confidential** (Shielded) tab to `dapp/index.html` (mirror the `.tab[data-tab]` pattern,
panel `#tab-confidential`) with sub-views Deposit / Transfer / Withdraw. Wire init in `tacit.js`
`_activateTab()` (~47590): `if (name === 'confidential') renderConfidential();`. Gate it to Sepolia.

## Slices
1. **Deposit + balance** — connect wallet; derive note from `wallet.priv` via `deriveNote`; `commitXY`; `eth_sendTransaction` `wrap()` (selector `0x8be3ad21`, value = amount wei); on receipt submit `{type:'wrap', op, memos:[sealMemo(...)]}` to the relay; poll `waitForSettle`; show balance from the indexer (scan Wrap/LeavesInserted/NullifiersSpent via `eth_getLogs` → `makeConfidentialIndexer().recover(events, wallet.priv)`). Persist notes under `tacit-confidential-notes:<net>:<asset>` AND make them recoverable from the seed alone (the indexer rebuilds from chain + `deriveNote`).
2. **Transfer** — pick input note(s) from the indexer; `buildTransfer({inputs,outputs})`; submit `{type:'transfer', op, memos}`; poll.
3. **Withdraw/unwrap** — OP_UNWRAP op → `settle` releases ETH to the recipient. (Confirm the unwrap op JSON shape from the guest `OP_UNWRAP` handler + add an `exec-unwrap` harness if the queue should carry it.)
4. **Swap / LP** — `confidential-swap.js` / `confidential-lp.js` assemblers + the existing swap/lp queue types.

## Risks
- Editing the live 30k-line `tacit.js` (concurrent sessions) — land edits in a quiet window, keep the module self-contained.
- Indexer balance correctness — verify `recover()` against the on-chain leaves for a known deposit before trusting it.
- Memo decrypt — the owner field must be the recipient's scanning pubkey so `openMemo` recovers the note; confirm the owner derivation.
- GPU shared with live tETH — every relay prove restarts the gpu-server (already handled in the loop); user deposits add prove load.
