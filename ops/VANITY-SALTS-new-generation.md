# CreateX vanity salts — new generation (deployer 0x42E7b9E9007A43Cc62E1ef3117C301da4F55483c)

Mined for `DeployV1SuiteCreateX.s.sol` (4 leading zero bytes each, permissioned salt form:
`salt[0:20] = deployer`, `salt[20] = 0x00`, remaining 11 bytes = mined entropy). Set as env vars
`SALT_<NAME>` before running the CreateX deploy script. Predicted address = what
`predict(salt)` in the script will compute; the script itself re-verifies this on-chain via
`deployCreate3(...) == predicted` (fails closed on any mismatch) and `_requireFourZeroBytes`.

| Contract | SALT | Predicted address |
|---|---|---|
| pool | `0x42e7b9e9007a43cc62e1ef3117c301da4f55483c00762d899106d7340aacbadf` | `0x000000009f2ada33ac8de85cf9f4140646994c8b` |
| engine | `0x42e7b9e9007a43cc62e1ef3117c301da4f55483c0007bad945bc638ad56e6386` | `0x00000000da8f3748a2fb61b02a52b0922a194437` |
| factory | `0x42e7b9e9007a43cc62e1ef3117c301da4f55483c005e8e382411089402488e00` | `0x000000007e9a9e9d67351587cf4935665edbca8f` |
| router | `0x42e7b9e9007a43cc62e1ef3117c301da4f55483c009c2fd15d318d7da3b89ee5` | `0x0000000038bd48ed631d597cdcdc0424b866c120` |
| relayer | `0x42e7b9e9007a43cc62e1ef3117c301da4f55483c000fedd29404268612e3796c` | `0x0000000045f7d0d1ed996347b961a9886b122a7d` |
| btcCallExecutor | `0x42e7b9e9007a43cc62e1ef3117c301da4f55483c003374b30ba2861a714bc43b` | `0x00000000579f626051b131149b30c982e3dea4ab` |
| ethCallOutbox | `0x42e7b9e9007a43cc62e1ef3117c301da4f55483c0033645f5196e2a63e48fb5e` | `0x00000000526e89e1b461ca5631f0d3489a65ccb9` |

Mined with a standalone Rust CPU miner (tiny-keccak + rayon, no OpenCL needed — 4 zero bytes is
only a 2^32 search space) against the real CreateX CREATE3 formula: `guardedSalt =
keccak256(abi.encode(deployer, salt))`, `proxy = CREATE2(CREATEX, guardedSalt,
keccak256(PROXY_INITCODE))`, `final = keccak256(0xd6 0x94 <proxy> 0x01)[12:]` — verified against
this repo's own `MockCreateX` test mirror (`contracts/test/DeployV1SuiteCreateX.t.sol`) before
mining. `adapter` and `publicAmm` are NOT vanity-gated (no `_requireFourZeroBytes` call for them)
so they need no salt here.

Not yet exported as env vars in any `.env` file — set `SALT_POOL`, `SALT_ENGINE`, `SALT_FACTORY`,
`SALT_ROUTER`, `SALT_RELAYER`, `SALT_BTC_CALL_EXECUTOR`, `SALT_ETH_CALL_OUTBOX` from this table
immediately before the real broadcast.
