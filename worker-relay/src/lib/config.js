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
  // zQuoter — best-route quote (fee-asset -> PROVE / -> ETH)
  zQuoter: opt('ZQUOTER_ADDR', '0x000000a7DfdD39f4D74c7b201501eaD119F8b86C'),
  // zRouter — executes the quoted swaps
  zRouter: opt('ZROUTER_ADDR', '0x000000000000FB114709235f1ccBFfb925F600e4'),
  // BitcoinLightRelay — advanceTip(bytes) submits BTC headers; tipHeight() is the confirmed height.
  headerRelay: opt('HEADER_RELAY_ADDR', '0x20A6ddc2C6E620c6248B5A34E85996516FDd19D0'),
  // Chainlink ETH/USD — the relay prices its own gas cost in USD, so this drives the fee gate.
  ethUsdFeed: opt('ETH_USD_FEED', '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419'),
};

export const CFG = {
  // Control plane (the tacit-api worker). Serves /reflection/job,
  // /confidential/job and the ack routes.
  workerBase: req('WORKER_BASE'),
  // Bearer token = worker CONFIDENTIAL_BOX_TOKEN / DEBUG_TOKEN. The /reflection/*
  // and /confidential/* prover routes are token-gated (ack advances the un-rewindable
  // Bitcoin cursor).
  boxToken: req('BOX_TOKEN'),
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
  relayKey: req('RELAY_KEY'),
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
  // Mirrors the worker's own ETH_STATE_PENDING_STALE_SECS default (worker/src/index.js) so the sidecar's
  // own "is it worth trying to publish" pre-check agrees with the server's actual gate — kept independently
  // configurable in case the two are ever intentionally detuned relative to each other.
  ethStatePendingStaleSecs: num('ETH_STATE_PENDING_STALE_SECS', 4 * 60 * 60),
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
  expectedOpsPerDay: num('EXPECTED_OPS_PER_DAY', 50),
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
  alertWebhookUrl: opt('ALERT_WEBHOOK_URL', ''), // optional Slack/Discord/webhook

  // Price oracles for the USD fee math. Kept as overridable env so the crons don't
  // hard-depend on a third-party price API; the dapp passes live prices at quote time.
  provePriceUsd: num('PROVE_PRICE_USD', 0.19),
  ethPriceUsd: num('ETH_PRICE_USD', 1840), // static FALLBACK only — chain.ethUsdPrice() reads the live feed
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
