// Central env + address config for the Render relay backbone.
//
// Every knob is an env var so the same image runs as the reflection worker, the
// settle worker, and the replenish/monitor crons — each Render service sets only
// the vars it needs. Secrets (keys, tokens) are declared sync:false in render.yaml
// and injected by the operator; nothing sensitive is committed here.

function req(name) {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env ${name}`);
  return v;
}
// Required only for the services that actually use it. `req()` runs while this module is being evaluated,
// so a value declared with it is demanded by EVERY service that imports CFG — which is how a settle key and
// a control-plane token came to be required by the points web service, a process that uses neither. A lazy
// property keeps the same "fail loudly rather than run misconfigured" contract, but moves the failure to
// first use, so a service that never reads it never needs it set.
function lazyReq(target, name, envName) {
  Object.defineProperty(target, name, {
    enumerable: true,
    get() { return req(envName); },
  });
}
function opt(name, dflt) {
  const v = process.env[name];
  return v === undefined || v === '' ? dflt : v;
}
function num(name, dflt) {
  const v = process.env[name];
  return v === undefined || v === '' ? dflt : Number(v);
}

// ── Mainnet addresses ──
// These default to the live mainnet deployment; override via env for Sepolia rehearsal.
export const ADDR = {
  // ConfidentialPool — settle() + attestBitcoinStateProven() + knownReflectionDigest(). Per-deployment:
  // this default is a fallback only; set POOL_ADDR explicitly per service so every service points at the
  // same deployment.
  pool: opt('POOL_ADDR', '0x000000000Ed1eabD231Be41d93b719056F7febFC'),
  // ConfidentialRouter — escrowAddressFor() + activateExit() for relayed L2 exits. Per-deployment, same
  // caveat as pool above.
  router: opt('ROUTER_ADDR', '0x000000005dA3E3B73726af3c774Deeb9472D4992'),
  // Succinct vApp deposit contract — deposit(uint256) tops up the network prover balance
  vApp: opt('VAPP_DEPOSIT_ADDR', '0x5Ad5Bc4B18f7c173DcE17A57682Cb0Dc8788951F'),
  // PROVE token — the prover-fee currency (approve + deposit to vApp)
  prove: opt('PROVE_TOKEN_ADDR', '0x6BEF15D938d4E72056AC92Ea4bDD0D76B1C4ad29'),
  // zQuoter — best-route quote (fee-asset <-> PROVE / <-> ETH), used both for the swaps replenish.js fires
  // and for provePriceUsd's pricing check. The old address (0x000000a7DfdD39f4D74c7b201501eaD119F8b86C,
  // buildSwapAuto) is deprecated as of 2026-09-23: its buildSwapAuto has no PROVE->ETH route (reverts
  // NoRoute()) despite ETH->PROVE working on it, so provePriceUsd was silently pricing PROVE off a static
  // constant on every call. This address's two-function split (see chain.js's ZQUOTER_ABI) replaces it:
  // buildBestSwap for direct pairs, buildBestSwapViaETHMulticall for assets whose PROVE liquidity sits
  // behind the WETH hub (wstETH, USDT) — replenish.js's quote() tries both and keeps the better one.
  zQuoter: opt('ZQUOTER_ADDR', '0x000000bd2DB80567c23E353ca95a251c573cBf9B'),
  // zRouter — executes the quoted swaps
  zRouter: opt('ZROUTER_ADDR', '0x000000000000FB114709235f1ccBFfb925F600e4'),
  // BitcoinLightRelay — advanceTip(bytes) submits BTC headers; tipHeight() is the confirmed height.
  headerRelay: opt('HEADER_RELAY_ADDR', '0x20A6ddc2C6E620c6248B5A34E85996516FDd19D0'),
  // Chainlink ETH/USD — the relay prices its own gas cost in USD, so this drives the fee gate.
  ethUsdFeed: opt('ETH_USD_FEED', '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419'),
  // Public TAC ERC20 (contracts/deployments/1.json's tacToken) — read-only here, just to check the points
  // distributor's funded balance before attempting updateRoot.
  tacToken: opt('TAC_TOKEN_ADDR', '0xA1313eb9f3A445606D9583bcAc3ebeB56a858279'),
  // PointsDistributor (contracts/src/PointsDistributor.sol) — empty until deployed, in which case
  // points-indexer.js's settleCycle logs and skips publishing rather than failing.
  pointsDistributor: opt('POINTS_DISTRIBUTOR_ADDR', ''),
  // WrapTipForwarder (contracts/src/WrapTipForwarder.sol) — deployed 2026-09-23. Optional for
  // points-indexer.js: when set, a Wrap's matching WrappedWithTip (same tx) is recorded alongside it purely
  // as metadata (tip amount + who it went to) — it never changes which address gets points. Points always
  // go to the tx's own sender, forwarder or not, since that's who actually funded the deposit.
  wrapTipForwarder: opt('WRAP_TIP_FORWARDER_ADDR', '0x000000D218B03db5837943b0b05DeA2965AE956e'),
  // WrapTokenTipForwarder (contracts/src/WrapTokenTipForwarder.sol) — deployed 2026-09-23. The ERC20
  // sibling: one generic deployment covers any registered token asset (cUSDC/cUSDT/cwstETH escrow-backed,
  // cTAC/cBTC/cUSD poolMinted), assetId chosen per call rather than baked into the contract. No current
  // consumer here — the points program (see points-indexer.js's own header) is deliberately ETH-only, so
  // this asset's wraps aren't in scope for it. Recorded for discoverability if that ever changes.
  wrapTokenTipForwarder: opt('WRAP_TOKEN_TIP_FORWARDER_ADDR', '0x0000007b1d93d72f698A861aA86Ac675D6AF7216'),
  // Privacy Pools (privacypools.com) Entrypoint — third-party protocol, not ours. Its own WithdrawalRelayed
  // event names the real recipient of a relayed ETH withdrawal; see points-indexer.js's ppBoostMultiplier.
  ppEntrypoint: opt('PP_ENTRYPOINT_ADDR', '0x6818809EefCe719E480a7526D76bD3e561526b46'),
  // The cUSD CDP controller — EscrowPosted (wstETH collateral, cBTC-mint side) and CdpMinted (cUSD debt
  // minted) both live here. See points-indexer.js's scanCollateralEngineCycle.
  collateralEngine: opt('COLLATERAL_ENGINE_ADDR', '0x000000003f608BDdF0ca45934003ffb9DbDF70DB'),
  // Routes an EscrowPosted whose `from` is any of these helpers back to the real depositor via the
  // helper's own HelperEscrowPosted event — see points-indexer.js. Comma-separated: every CbtcEscrowHelper
  // ever deployed stays here, since old ones keep taking reclaimEscrow calls (and, in principle, further
  // escrow) for as long as anyone still holds a position there.
  cbtcEscrowHelpers: opt(
    'CBTC_ESCROW_HELPER_ADDR',
    '0x00000000689C71E690E5842dF088AF97F9d4f71b,0x000000008eCD09f922C9FbbDD9ACA5aE8F0beBfA',
  ).split(',').map((a) => a.trim()).filter(Boolean),
};

export const CFG = {
  // workerBase / boxToken / relayKey are attached lazily below — see lazyReq.
  // /prover-heartbeat authenticates on a body token, separate from the bearer above, and 401s without it.
  // Optional so a missing value degrades to "health reporting is off" rather than refusing to start a
  // prover — but leave it unset and /prover-health reports this service down forever.
  heartbeatToken: opt('PROVER_HEARTBEAT_TOKEN', ''),

  network: opt('NETWORK', 'mainnet'), // 'mainnet' | 'signet' (Bitcoin side of reflection)
  chainId: num('CHAIN_ID', 1),

  // ── BitcoinLightRelay header feeder (header-relay.js) ──
  // Bitcoin esplora(s) for raw block headers (comma list; tried in order, next on failure).
  btcEsplora: opt('BTC_ESPLORA', 'https://mempool.space/api,https://blockstream.info/api,https://mempool.emzy.de/api'),
  // Reflection maturity depth — matches the pool's immutable REFLECTION_CONFIRMATIONS (attest tip = relayTip - this).
  // 24 on the mainnet pool; override for a pool deployed with a different depth.
  reflectionConfirmations: num('REFLECTION_CONFIRMATIONS', 24),
  // Keep the on-chain relay at most this many blocks ahead of reflection's attested height. This is not a
  // correctness bound — the pool accepts a batch tip up to REFLECTION_MAX_LAG below its matured anchor, so
  // reflection closes any backlog in ordinary batches whatever the relay has done meanwhile. It is a COST
  // bound: the pool's anchor walks one blockParent read per block of lag, so the lead is what caps the gas an
  // attest pays while reflection is behind. A day of Bitcoin blocks keeps that walk cheap and still lets the
  // relay run far enough ahead that a reflection stall never stalls the relay's other readers.
  headerLead: num('HEADER_RELAY_LEAD', 144),
  // Headers per advanceTip tx (gas-bounded batch).
  headerMaxBatch: num('HEADER_RELAY_MAX_BATCH', 40),
  // Submit only once this many headers are pending, so a quiet lane pays one transaction for a batch instead of one per
  // block. 1 (default) is the original behaviour: submit as soon as any block exists.
  headerMinBatch: num('HEADER_RELAY_MIN_BATCH', 1),
  // The bound on how far behind the relay is left. When > 0, a pending count at or above it is submitted even while
  // MAX_GAS_GWEI would hold it and even if it is below the minimum batch. 0 (default) disables the override.
  headerMaxStaleBlocks: num('HEADER_RELAY_MAX_STALE_BLOCKS', 0),
  // Opt-in spend guard for long catch-ups: when > 0, the header feeder and the reflection folder wait instead of
  // submitting while the live gas price is above this many gwei. 0 (default) disables it.
  maxGasGwei: num('MAX_GAS_GWEI', 0),
  // Alert depth for the header feeder's fork recovery. The feeder always walks the relay's tip back to the
  // explorer's chain and resubmits the canonical headers, at any depth; a branch deeper than this is not a
  // normal Bitcoin reorg, so it is also raised as a critical alert (log + ALERT_WEBHOOK_URL).
  headerReorgDepth: num('HEADER_RELAY_REORG_DEPTH', 12),

  // Ethereum execution RPC for the relay's own on-chain calls (settle/attest/replenish).
  rpcUrl: req('RPC_URL'),
  // Ordered read endpoints, RPC_URL first. Reads are retried down the list, so a provider that times out
  // or rate-limits mid-cycle costs a retry instead of the cycle (and, for reflection, a paid proof).
  rpcUrls: [req('RPC_URL'), ...opt('RPC_URLS_FALLBACK', 'https://ethereum-rpc.publicnode.com,https://1rpc.io/eth,https://eth-mainnet.public.blastapi.io')
    .split(',').map((u) => u.trim()).filter(Boolean)]
    .filter((u, i, a) => a.indexOf(u) === i),
  // Independent confirmation endpoint for the reflection attest ack — deliberately NOT part of rpcUrls
  // above, so it can never be the same provider whose receipt is being cross-checked (see chain.js
  // verifyClient). Default assumes RPC_URL is a third-party gateway; override if RPC_URL is already this.
  reflectionVerifyRpcUrl: opt('REFLECTION_VERIFY_RPC_URL', 'https://ethereum-rpc.publicnode.com'),
  // Private submission endpoint for settle txs so the proof isn't exposed in the public mempool (a searcher can
  // otherwise copy it, land it first as msg.sender to steal the bound fee, and revert our tx). Flashbots Protect
  // routes straight to builders AND drops reverting txs (no wasted gas on a lost race). Reads stay on rpcUrl.
  settleRpcUrl: opt('SETTLE_RPC_URL', 'https://rpc.flashbots.net'),
  // Ordered private endpoints to try for a settle. A single endpoint is a single point of failure and a
  // failed submission throws away an already-paid proof, so fall through to the next on error. All entries
  // must be PRIVATE (the bound fee is stealable in a public mempool).
  settleRpcUrls: opt('SETTLE_RPC_URLS', 'https://rpc.flashbots.net,https://rpc.mevblocker.io')
    .split(',').map((u) => u.trim()).filter(Boolean),
  // Last-resort public submission, tried only after every private endpoint refused. The worst case is a
  // searcher copying the proof to collect the bound fee — the user's op still settles either way, which
  // beats discarding a proof the relay has already paid for. SETTLE_ALLOW_PUBLIC=0 to keep it private-only.
  settleAllowPublic: opt('SETTLE_ALLOW_PUBLIC', '1') !== '0',
  // Max transfers to batch into one settle. Gas is per-settle, so members split it; proving is per-op and
  // does not amortize, so the win flattens out — and a bigger batch means a longer proof and more ops lost
  // together if it fails. 1 disables batching.
  settleBatchMax: num('SETTLE_BATCH_MAX', 8),
  // Replenish from INSIDE the settle service, during idle time. The settle wallet earns the fees and holds
  // the only copy of SETTLE_KEY, so running the sweep here means the key never has to be copied to a cron.
  // It runs between cycles — never concurrently — because a swap and a settle from the same wallet would
  // race for one nonce. Fee income flows earner -> sink (see replenishOnce): the settle wallet earns, the
  // RELAY wallet pays maintenance gas and is the account whose vApp deposit funds proving.
  replenishInSettle: opt('REPLENISH_IN_SETTLE', '0') === '1',
  // One-shot key consolidation: move everything the settle wallet holds (fee assets, then ETH) to the relay
  // wallet, on the first idle pass. Set it, let it run, then remove SETTLE_KEY so the settle service signs with
  // RELAY_KEY and the two roles are one wallet. A no-op when they already are.
  replenishDrainToSink: opt('REPLENISH_DRAIN_TO_SINK', '0') === '1',
  replenishIntervalMin: num('REPLENISH_INTERVAL_MIN', 30),
  // Convert fee income to PROVE and deposit it. On by default; REPLENISH_DEPOSIT_PROVE=0 keeps a pass to gas.
  replenishDepositProve: opt('REPLENISH_DEPOSIT_PROVE', '1') !== '0',
  // Native ETH is only converted to PROVE above this. ETH that arrives as fee income is gas as much as it is
  // revenue, and a manual top-up is gas by intent — converting everything over the small gas buffer would
  // quietly turn an operator's deliberate float into PROVE. Below this it stays ETH; only genuine excess goes.
  ethSweepAboveWei: BigInt(opt('ETH_SWEEP_ABOVE_WEI', '100000000000000000')), // 0.1 ETH
  // Don't convert less than this many dollars of a fee asset in one go. Dust swaps cost gas out of
  // proportion, and the aggregator's quotes for tiny amounts are unreliable. Below the floor the asset is
  // held and accumulates.
  sweepMinUsd: num('SWEEP_MIN_USD', 5),
  // A PROVE quote is refused if it is more than this factor away from what an independent price implies.
  // Wide on purpose: it exists to catch a quote that is off by 100x, not to second-guess normal slippage.
  quoteSanityBand: num('QUOTE_SANITY_BAND', 2),
  // Relayed L2 exits: once the settle lands, call ConfidentialRouter.activateExit(recipe) from the settle key so
  // the user never sends it from a wallet that would link to the exit. Sent only when the op's bound fee covers
  // the settle plus the activation (ACTIVATE_MARGIN_BPS over that cost). ACTIVATE_EXITS=0 turns it off.
  activateExits: opt('ACTIVATE_EXITS', '1') !== '0',
  activateGasCap: BigInt(opt('ACTIVATE_GAS_CAP', '1500000')),
  activateMarginBps: BigInt(opt('ACTIVATE_MARGIN_BPS', '0')),
  ethAssetId: opt('ETH_ASSET_ID', '0x3cba71e1114af183cdeacc6b8457a474d17529fd28704480ca799d0d03126f34'),
  ethUnitScale: BigInt(opt('ETH_UNIT_SCALE', '10000000000')),

  // Relay signer — pays gas for attest + settle + replenish swaps and collects fees.
  // A single key can serve all roles; split RELAY_KEY / SETTLE_KEY if you want
  // separate nonspaces. SETTLE_KEY falls back to RELAY_KEY.
  //
  // OPTIONAL, deliberately: chain.js reads this at module scope to build its wallets, so requiring it here
  // would make importing anything from chain.js — including the read-only publicClient — demand a signing
  // key. A service with no key gets null wallets instead (see walletFor), which is what lets the points and
  // monitor services run without one.
  relayKey: opt('RELAY_KEY', ''),
  settleKey: opt('SETTLE_KEY', process.env.RELAY_KEY),
  // PUBLIC address of the settle wallet, for services that must WATCH it but have no business holding its
  // key (the monitor). SETTLE_KEY is set on the settle service alone, so anywhere else it silently falls
  // back to RELAY_KEY and the two wallets would collapse into one.
  settleAddress: opt('SETTLE_ADDRESS', ''),

  // Idle poll intervals (seconds).
  reflectionPollSecs: num('REFLECTION_POLL_SECS', 30),
  // How long a submitted attest may take to land before the cron gives up waiting for it. A timed-out receipt wait is
  // not a failure — the tx can still confirm minutes later — so the folder polls the pool's digest instead, and only
  // a genuine revert or a dropped tx ends the wait early.
  reflectionAttestWaitSecs: num('REFLECTION_ATTEST_WAIT_SECS', 1800),
  // How long the prover keeps retrying the eth-state proof fetch when the API is answering 5xx or dropping the
  // connection (it restarts while building a large job); a real 404 is never retried.
  ethProofWaitSecs: num('REFLECTION_ETH_PROOF_WAIT_SECS', 240),
  reflectionAttestPollSecs: num('REFLECTION_ATTEST_POLL_SECS', 15),
  settlePollSecs: num('SETTLE_POLL_SECS', 15),

  // RUN_MODE=cron ⇒ drain pending work once and exit (Render Cron Job — billed per-run, cheap).
  //   Anything else ⇒ always-on loop (Render Background Worker). Cron mode caps how many
  //   cycles it drains and how long it runs so a run stays bounded within the cron window.
  runMode: (process.env.RUN_MODE || 'worker').toLowerCase(),
  cronMaxCycles: num('CRON_MAX_CYCLES', 25),
  cronBudgetSecs: num('CRON_BUDGET_SECS', 240),

  // Per-job wall-clock ceiling for a settle prove+submit. A witness that blows past
  // this is acked failed so it can't wedge the FIFO. Network proves are slower than
  // GPU, so default generously.
  settleJobTimeoutSecs: num('SETTLE_JOB_TIMEOUT_SECS', 900),

  // ── Prebuilt Rust prover binaries (shipped in the Render image; see README) ──
  // bitcoin_prove: eth-reflection prover-host, patched to .network(). Reads
  // REFLECT_FIXTURE, writes $PROVER_OUT/bitcoin_pv.hex + bitcoin_proof_bytes.hex.
  bitcoinProveBin: opt('BITCOIN_PROVE_BIN', '/app/prover/bin/bitcoin_prove'),
  // exec: confidential settle harness, bin `exec`, patched to .network(). MODE=groth16,
  // OP_FILE=<op json>, writes public_values.hex + proof_bytes.hex in its cwd.
  execBin: opt('EXEC_BIN', '/app/prover/bin/exec'),
  // Per-op-type harness main.rs is baked into the exec bin's build; the relay selects
  // the op via OP_TYPE/OP_FILE env the multi-harness `exec` dispatches on.
  harnessDir: opt('HARNESS_DIR', '/app/prover/harnesses'),
  proverOut: opt('PROVER_OUT', '/tmp/prover-out'),
  fixtureDir: opt('FIXTURE_DIR', '/tmp/prover-fixtures'),

  // ── Mode-B eth-state sidecar (eth-state-sidecar.js / proveEthState) ──
  // Poll interval for the CHEAP check (GET /reflection/eth-state + two view calls) — this is not the
  // proving cadence, just how often the sidecar looks for "no pending candidate live" (see that file's
  // header for why that, not crossOutCount, is the real trigger). Cheap enough to poll often.
  ethStatePollSecs: num('ETH_STATE_POLL_SECS', 60),
  // Hard ceiling on a single eth_prove run. Without one, a network prove that never returns blocks the only
  // producer of Mode-B fuel — and once the pool's crossOutCount has passed 0 that is the ONLY way any
  // Bitcoin-side attest can land, so a single hung child process silently halts the whole Bitcoin->Ethereum
  // lane with every service still reporting healthy. Generous (a real network prove is minutes), but finite.
  ethProveTimeoutSecs: num('ETH_PROVE_TIMEOUT_SECS', 45 * 60),
  // MUST mirror ETH_STATE_PENDING_STALE_SECS_DEFAULT in worker/src/index.js. This value decides whether the
  // sidecar thinks it is worth publishing; that one decides whether the server 409s the publish. When they
  // disagree, the sidecar spends a network proof on a candidate the server then refuses — and the two sides
  // are deployed independently (Render vs the worker), so a retune on one side silently desyncs the other.
  // That has already happened once in the live direction: the server-side ceiling stayed at 4h after the
  // Render-side config was retuned, and a crossOut's Bitcoin-side broadcast sat blocked for 3+ hours.
  // Change both together, in the same commit, and keep this default equal to that constant.
  ethStatePendingStaleSecs: num('ETH_STATE_PENDING_STALE_SECS', 90 * 60),
  // DRY_RUN=1: run every check + log the decision, never invoke eth_prove or POST — the safe first-run
  // mode to validate the trigger logic and API wiring against production before spending any real PROVE.
  ethStateDryRun: opt('DRY_RUN', '0') === '1',
  ethProveBin: opt('ETH_PROVE_BIN', '/app/prover/bin/eth_prove'),
  // eth_prove's own env (contracts/sp1/eth-reflection/prover-host/src/bin/eth_prove.rs) — required, no
  // guessed defaults: a wrong GENESIS_SLOT/DEPLOY_BLOCK/ETH_CALL_OUTBOX fails closed (guest panic or a
  // ChainMismatch-style revert) rather than silently mis-proving, but "fails closed" still means a human
  // must supply the correct per-deployment values.
  sourceConsensusRpc: opt('SOURCE_CONSENSUS_RPC', ''),
  sourceChainId: opt('SOURCE_CHAIN_ID', '1'),
  sourceExecutionRpc: opt('SOURCE_EXECUTION_RPC', ''),
  sourceProofRpc: opt('SOURCE_PROOF_RPC', ''), // falls back to sourceExecutionRpc inside eth_prove if unset
  ethCallOutbox: opt('ETH_CALL_OUTBOX', ''),
  ethProveDeployBlock: opt('DEPLOY_BLOCK', ''), // first-run-only lower bound; ignored once state_path() exists
  ethProveGenesisSlot: opt('GENESIS_SLOT', ''),
  ethProveScanChunk: opt('SCAN_CHUNK', '300'),
  ethProveScanDelayMs: opt('SCAN_DELAY_MS', '600'),
  ethProveCycleLimit: opt('ETHPROVE_CYCLE_LIMIT', '3000000000'),
  ethProveGasLimit: opt('ETHPROVE_GAS_LIMIT', '3000000000'),
  // Persistent (disk-backed on Render) directories — see render.yaml's mounted disk for this service.
  // Losing this file is not a soundness risk (eth_prove.rs just re-derives it from a full eth_getLogs
  // rescan from DEPLOY_BLOCK on the next run — see its `from_block` fallback), only an availability/cost
  // one: a cold rescan grows with total historical cross-out/consume volume, so treat disk loss as an
  // incident to fix, not an accepted steady-state.
  ethProveOutDir: opt('ETH_PROVE_OUT_DIR', '/var/lib/tacit-eth-prove/out'),
  ethProveDebugDir: opt('ETH_PROVE_DEBUG_DIR', '/var/lib/tacit-eth-prove/debug'),

  // ── Succinct network prover ── (consumed by the spawned binaries)
  // SP1_PROVER=network + NETWORK_PRIVATE_KEY + NETWORK_RPC_URL are read by the SP1 SDK
  // inside the binaries. We surface them here only to validate they are present before
  // spawning, and to fail loudly rather than fall back to a (nonexistent) local GPU.
  sp1Prover: opt('SP1_PROVER', 'network'),
  networkPrivateKey: opt('NETWORK_PRIVATE_KEY', ''),
  // Mainnet/auction endpoint (binaries build in Mainnet mode; Reserved endpoint → auction calls Unimplemented).
  networkRpcUrl: opt('NETWORK_RPC_URL', 'https://rpc.mainnet.succinct.xyz'),

  // ── Fee economics ──
  minFloorUsd: num('MIN_FLOOR_USD', 0.5), // absolute floor so tiny trades cover their gas
  opsMargin: num('OPS_MARGIN', 0.12), // ~12% over cost
  bpsCap: num('BPS_CAP', 30), // displayed bps ceiling for mid/large trades
  // Ops/day the maintenance overhead is amortised across. Set it to what the relay actually serves; too
  // high quietly under-prices every op and the relay bleeds, too low prices us out of competitiveness.
  // Measured twice independently 2026-09-23 against real mainnet activity since gen5 launched (deploy
  // block 25998736): 19.61/day from the pool's leaf count (114 leaves / 5.81 days) and 19.35/day from
  // distinct settle transactions on the relay key (112 / 5.79 days) — agreeing within 1.3%. The previous
  // default of 50 overstated real volume by ~2.6x, understating this term's true per-op cost by the same
  // factor wherever RELAY_GATE_INCLUDE_MAINTENANCE is on. Re-measure before trusting this far into the
  // future — it moves with real adoption, not with intent.
  expectedOpsPerDay: num('EXPECTED_OPS_PER_DAY', 20),
  // Refuse ops that carry no priced fee. Default OFF: nothing populates op.feeUsd yet, so switching this
  // on before the producer is wired would refuse every job. Turn it on once fees actually arrive.
  requirePricedFee: opt('RELAY_REQUIRE_PRICED_FEE', '0') === '1',
  // What the relay's fee gate holds a priced fee to. Default: the op's MARGINAL cost (gas + PROVE) — an op that
  // loses money on its own is refused, one that merely under-contributes to fixed overhead is not. Counting
  // maintenance per op is stricter than the published floor and rejected the dapp's standard fee from about
  // 0.06 gwei up, AFTER the job had queued. Set RELAY_GATE_INCLUDE_MAINTENANCE=1 to hold ops to the full cost.
  gateIncludesMaintenance: opt('RELAY_GATE_INCLUDE_MAINTENANCE', '0') === '1',

  // ── Replenish / monitor thresholds ──
  proveBalanceFloor: num('PROVE_BALANCE_FLOOR', 50), // PROVE, whole tokens
  ethGasBufferWei: BigInt(opt('ETH_GAS_BUFFER_WEI', '30000000000000000')), // 0.03 ETH
  // A floor says "low"; runway says WHEN. The relay stalls when it can no longer afford its next transaction, so
  // the actionable number is how many DAYS the wallet lasts at its real burn and the live gas price — which
  // moves with the market, where a fixed wei floor does not. Critical below the first, a warning below the second.
  runwayDaysCritical: num('RUNWAY_DAYS_CRITICAL', 3),
  runwayDaysWarn: num('RUNWAY_DAYS_WARN', 7),
  // Settle-queue health (see lib/queue-health.js). A relayed job is normally picked up in seconds, so a pending job
  // this old means the settle service is down or stuck and a user is waiting.
  queuePendingWarnSec: num('QUEUE_PENDING_WARN_SEC', 300),
  queuePendingCriticalSec: num('QUEUE_PENDING_CRITICAL_SEC', 900),
  reflectionLagAlertBlocks: num('REFLECTION_LAG_ALERT_BLOCKS', 200), // above the ~144-block relay lead that is normal
  // The reflection snapshot is the protocol's one cumulative resource (see handleReflectionState). The
  // assembler has been measured peaking +58-216MB above the snapshot against a 1280MB heap, so the
  // snapshot itself wants to stay well under a fifth of that ceiling; crossing this is the signal to
  // schedule frontier compaction, not an emergency.
  snapshotBytesWarn: num('SNAPSHOT_BYTES_WARN', 64 * 1024 * 1024),
  // No successful attest for this long while Bitcoin has un-attested blocks in range is a stalled reflection lane.
  reflectionStallHours: num('REFLECTION_STALL_HOURS', 3),
  // A pending eth-state candidate bridges an ETH-side crossOut to its Bitcoin-side fold. The sidecar discards
  // and republishes its own candidate once it passes ETH_STATE_PENDING_STALE_SECS, so these thresholds exist
  // only for the case where that hasn't happened on its own timeline.
  //
  // They are DERIVED from that window rather than pinned, because pinning them is how you get an alert that
  // fires before the thing it is alerting about has had its chance: hard-coded 105/150min sat BELOW a 4h
  // default stale window, so the critical claimed the candidate was "past the self-heal window" 90 minutes
  // before self-heal was due, and told the operator to clear it — which destroys the exact candidate the next
  // Bitcoin attest chains from. Deriving keeps the alert true at whatever the window is actually set to.
  ethStatePendingWarnSec: num('ETH_STATE_PENDING_WARN_SEC', 0)
    || Math.round(num('ETH_STATE_PENDING_STALE_SECS', 4 * 60 * 60) * 1.1),
  ethStatePendingCriticalSec: num('ETH_STATE_PENDING_CRITICAL_SEC', 0)
    || Math.round(num('ETH_STATE_PENDING_STALE_SECS', 4 * 60 * 60) * 1.5),
  // How long the pool's recorded crossOutCount may run ahead of reflection's foldedCrossoutCount before the
  // gap is worth a human look. A gap is NORMAL and open-ended by design — it just means someone has settled an
  // ETH->BTC crossOut and not yet broadcast its Bitcoin-side mint, which is entirely at their discretion. What
  // is not normal is a gap that never closes, because one failure mode makes it permanent (see the check).
  crossOutFoldGapWarnHours: num('CROSSOUT_FOLD_GAP_WARN_HOURS', 48),
  // Cross-outs already known to be unfoldable, excluded from the gap the check above measures.
  //
  // A cross-out whose Bitcoin block was scanned before an eth-state bundle covering it existed can never
  // fold — the fold is one-shot and the guest never rescans a block. That leaves a permanent, irreducible
  // gap, and without a baseline the watchdog would page about it every run forever, which trains everyone to
  // ignore the one alert that matters. Raising this is an explicit operator acknowledgement that a specific
  // cross-out is written off; it must never be raised to silence a gap that has not been diagnosed.
  crossOutFoldGapBaseline: num('CROSSOUT_FOLD_GAP_BASELINE', 0),
  alertWebhookUrl: opt('ALERT_WEBHOOK_URL', ''), // optional Slack/Discord/webhook

  // Price oracles for the USD fee math. Kept as overridable env so the crons don't
  // hard-depend on a third-party price API; the dapp passes live prices at quote time.
  provePriceUsd: num('PROVE_PRICE_USD', 0.19),
  ethPriceUsd: num('ETH_PRICE_USD', 1840), // static FALLBACK only — chain.ethUsdPrice() reads the live feed

  // ── Points program (src/points-indexer.js) ──
  // Read-only over existing Wrap events; no contract change. Counts ETH wraps only, forward from
  // pointsStartBlock — no backfill, so a wrap before that block never appears.
  pointsStartBlock: opt('POINTS_START_BLOCK', ''), // required: chain head at first deploy of this service
  pointsPollSecs: num('POINTS_POLL_SECS', 60),
  pointsScanChunk: num('POINTS_SCAN_CHUNK', 2000), // getLogs block span per call
  // Wait this many blocks behind head before scanning, so a reorg can't hand out points for a wrap that
  // then disappears. 12 covers ordinary reorgs; the wrap is still irreversible well before finality.
  pointsConfirmations: num('POINTS_CONFIRMATIONS', 12),
  pointsDbPath: opt('POINTS_DB_PATH', '/var/lib/tacit-points/points.db'),
  pointsHttpPort: num('PORT', 8080), // Render's web services assign this; falls back to 8080 for local runs
  // points = amountEth * pointsBasePerEth * (1 + pointsBonusScale / (1 + priorEthDepositCount / pointsBonusHalfLife))
  // priorEthDepositCount is this service's own running count of ETH wraps scanned before the current one —
  // a smaller count (earlier in the program) means a bigger bonus, which is the "grow the anonymity set while
  // it's still small" incentive. Tune via env; not a protocol parameter, so it carries no on-chain meaning.
  pointsBasePerEth: num('POINTS_BASE_PER_ETH', 1000),
  pointsBonusScale: num('POINTS_BONUS_SCALE', 4),
  pointsBonusHalfLife: num('POINTS_BONUS_HALF_LIFE', 200),

  // ── Privacy Pools cross-protocol boost (src/points-indexer.js) ──
  // A wrap's points get multiplied by ppBoostMultiplier when the depositor address has EVER shown up as the
  // recipient of a Privacy Pools (privacypools.com) ETH withdrawal — full history, no recency cutoff. The
  // Entrypoint's own WithdrawalRelayed event names the real recipient directly (the pool-level Withdrawn
  // event's _processooor is just the Entrypoint contract when relayed, never the person), so this is a
  // cheap, indexed-topic scan, not funding-graph tracing. Deliberately direct-recipient only — boosting a
  // wallet merely FUNDED BY a recipient would let anyone forward 1 wei from a Privacy Pools payout to any
  // address and claim the multiplier on unrelated ETH wrapped there.
  ppEntrypointDeployBlock: num('PP_ENTRYPOINT_DEPLOY_BLOCK', 22153713),
  ppBoostMultiplier: num('PP_BOOST_MULTIPLIER', 1.2),

  // ── cBTC/cUSD mint activity (src/points-indexer.js's scanCollateralEngineCycle) ──
  // Two more ways to earn points, alongside the ETH wrap above: posting wstETH collateral toward a cBTC
  // mint, and opening a cUSD loan against it. Same "not a protocol parameter" status as pointsBasePerEth —
  // tune freely, no on-chain meaning.
  //
  // cBTC: points per whole wstETH posted as escrow (EscrowPosted's own amount, 18 decimals) — same rate as
  // wrapping ETH, since wstETH tracks ETH's value roughly 1:1 and both are "committing value to the system".
  pointsBasePerCbtc: num('POINTS_BASE_PER_CBTC', 1000),
  // cUSD: points per whole dollar of cUSD minted (CdpMinted's debtValue, tacitDecimals=8 scaled — divide by
  // 1e8 for the real dollar amount), BEFORE the bonus below.
  pointsBasePerCusd: num('POINTS_BASE_PER_CUSD', 1),
  // z's explicit ask: favor cUSD minters over cBTC posters. Applied on top of pointsBasePerCusd, not
  // pointsBasePerCbtc — a dollar of cUSD minted ends up worth several times a dollar-equivalent of wstETH
  // posted, by design.
  cusdMintBonusMultiplier: num('CUSD_MINT_BONUS_MULTIPLIER', 2),
  collateralEngineDeployBlock: num('COLLATERAL_ENGINE_DEPLOY_BLOCK', 25998747),

  // ── zRouter ETH-swap activity (src/points-indexer.js's scanZRouterCycle) ──
  // A fourth way to earn points: swapping ETH through zSwap/zRouter. Forward-only by design — no backfill,
  // starts counting from whichever block this service first sees it live. Same base rate as an ETH wrap
  // (kept as its own knob so it can be tuned independently later) and the same early-adopter decay curve.
  pointsBasePerZswapEth: num('POINTS_BASE_PER_ZSWAP_ETH', 1000),

  // ── TAC-holder boost (src/lib/tac-holder-boost.js) ──
  // Every activity's points are multiplied by the depositor's TAC tier: "whole TAC:multiplier" pairs, judged
  // on the lowest public TAC balance held over the trailing tacBoostWindowBlocks (7200 ≈ 24h). Empty tiers
  // switch the boost off. tacBoostStartBlock is required with tiers: activities before it are never boosted,
  // so scoring already done stays exactly as it was if the ledger is ever rebuilt.
  tacBoostTiers: opt('TAC_BOOST_TIERS', ''),
  tacBoostWindowBlocks: num('TAC_BOOST_WINDOW_BLOCKS', 7200),
  tacBoostStartBlock: num('TAC_BOOST_START_BLOCK', 0),
  tacTokenDeployBlock: num('TAC_TOKEN_DEPLOY_BLOCK', 25998751),

  // ── Points reward settlement (src/points-indexer.js's settleCycle -> PointsDistributor) ──
  // Separate from the points/bonus knobs above: this converts POINTS into a pro-rata slice of a fixed TAC
  // budget, once per UTC day-epoch, and publishes the result as a new cumulative merkle root. Empty
  // pointsProgramStartSec means "not configured yet" — settleCycle no-ops entirely rather than guessing a
  // start date, so deploying points-indexer.js ahead of the reward program going live is safe.
  pointsProgramStartSec: num('POINTS_PROGRAM_START_SEC', 0),
  pointsProgramDays: num('POINTS_PROGRAM_DAYS', 90),
  // 100,000 whole TAC, in wei, as a BigInt-safe string (avoid a float literal anywhere near 1e23).
  pointsProgramTotalWei: BigInt(opt('POINTS_PROGRAM_TOTAL_WEI', '100000000000000000000000')),
  // Hot wallet that calls updateRoot daily. Deliberately its own key, not RELAY_KEY/SETTLE_KEY — see
  // PointsDistributor.sol's header: a leak only exposes whatever is currently funded into the distributor,
  // and keeping it separate from the higher-value relay/settle keys keeps that bound meaningful.
  pointsRootSetterKey: opt('POINTS_ROOT_SETTER_KEY', ''),
};

// Measured settle gas per op-type. Used by the fee math.
export const OP_GAS = {
  wrap: 593_000n,
  swap: 569_000n,
  route: 569_000n,
  lp: 749_000n,
  unwrap: 323_000n,
  transfer: 600_000n, // from a live 1-in/2-out settle estimate (600,356); 2 output leaves + membership
  swapblind: 900_000n, // heavier than swap: in-guest amm_swap_batch Groth16 verify + 2 cross-curve sigmas + opening-PoK. Consulted only for the (dormant) relayed path; tips=0 self-settle pays its own gas. Refine from a live estimate at arming.
  // Bitcoin header attestation — the maintenance lane, measured from live receipts. NOT a user op: nobody pays a fee for it, but the bridge and
  // the fast lane stop working in both directions without it, so it is a standing cost the margin on user
  // ops has to carry. See MAINTENANCE_RUNS_PER_DAY.
  maintenance: 264_000n,
};

// How often the maintenance lane runs, for the overhead term in the fee model. Measured on mainnet at
// ≈ 4.6 header-relay transactions per hour. Reflection attestation rides the same
// wallet and cadence. Deliberately an env knob — the cadence follows HEADER_RELAY_LEAD and batch size,
// so a deployment that paces differently should say so rather than inherit this number silently.
export const MAINTENANCE_RUNS_PER_DAY = Number(process.env.MAINTENANCE_RUNS_PER_DAY || 111);
export const DEFAULT_OP_GAS = 600_000n;

// PROVE per op, measured from a live Succinct fulfillment for a confidential transfer (0.3892 PROVE, the
// heaviest confidential op at ~8.4M cycles). Lighter ops cost less and are conservatively over-covered.
export const OP_PROVE = 0.39;

export { req, opt, num };

// Control plane (the tacit-api worker): serves /reflection/job, /confidential/job and the ack routes.
lazyReq(CFG, 'workerBase', 'WORKER_BASE');
// Bearer token = worker CONFIDENTIAL_BOX_TOKEN / DEBUG_TOKEN. The /reflection/* and /confidential/* prover
// routes are token-gated (ack advances the un-rewindable Bitcoin cursor).
lazyReq(CFG, 'boxToken', 'BOX_TOKEN');
