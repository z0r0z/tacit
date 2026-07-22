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

// ── Mainnet addresses (from ops runbook / PRICING-RELAY-ECONOMICS.md) ──
// These default to the live mainnet deployment; override via env for Sepolia rehearsal.
export const ADDR = {
  // ConfidentialPool — settle() + attestBitcoinStateProven() + knownReflectionDigest()
  pool: opt('POOL_ADDR', '0x0000000000c5B537A7c3622d1418D5771914C03D'),
  // Succinct vApp deposit contract — deposit(uint256) tops up the network prover balance
  vApp: opt('VAPP_DEPOSIT_ADDR', '0x5Ad5Bc4B18f7c173DcE17A57682Cb0Dc8788951F'),
  // PROVE token — the prover-fee currency (approve + deposit to vApp)
  prove: opt('PROVE_TOKEN_ADDR', '0x6BEF15D938d4E72056AC92Ea4bDD0D76B1C4ad29'),
  // zQuoter — best-route quote (fee-asset -> PROVE / -> ETH)
  zQuoter: opt('ZQUOTER_ADDR', '0x000000a7DfdD39f4D74c7b201501eaD119F8b86C'),
  // zRouter — execute swaps over Uniswap V4
  zRouter: opt('ZROUTER_ADDR', '0x000000000000FB114709235f1ccBFfb925F600e4'),
  // BitcoinLightRelay — advanceTip(bytes) submits BTC headers; tipHeight() is the confirmed height.
  headerRelay: opt('HEADER_RELAY_ADDR', '0x1677A5A3669a6D365431e916678566DAaa2e9094'),
};

export const CFG = {
  // Control plane (the existing Cloudflare Worker). Serves /reflection/job,
  // /confidential/job and the ack routes the box loops already use.
  workerBase: req('WORKER_BASE'),
  // Bearer token = worker CONFIDENTIAL_BOX_TOKEN / DEBUG_TOKEN. The /reflection/*
  // and /confidential/* box routes are token-gated (ack advances the un-rewindable
  // Bitcoin cursor), so the relay must authenticate exactly like the box loops.
  boxToken: req('BOX_TOKEN'),

  network: opt('NETWORK', 'mainnet'), // 'mainnet' | 'signet' (Bitcoin side of reflection)
  chainId: num('CHAIN_ID', 1),

  // ── BitcoinLightRelay header feeder (header-relay.js) ──
  // Bitcoin esplora(s) for raw block headers (comma list; tried in order, next on failure).
  btcEsplora: opt('BTC_ESPLORA', 'https://mempool.space/api,https://blockstream.info/api,https://mempool.emzy.de/api'),
  // Reflection maturity depth — matches the pool's REFLECTION_CONFIRMATIONS (attest tip = relayTip - this).
  reflectionConfirmations: num('REFLECTION_CONFIRMATIONS', 6),
  // Keep the on-chain relay at most this many blocks ahead of reflection's attested height, so reflection's
  // fold always lands in the maturity window [relayTip-12, relayTip-6]. ≤ CONF(6)+FINALITY_WINDOW(6)+MAX_BATCH(6).
  headerLead: num('HEADER_RELAY_LEAD', 18),
  // Headers per advanceTip tx (gas-bounded batch).
  headerMaxBatch: num('HEADER_RELAY_MAX_BATCH', 40),

  // Ethereum execution RPC for the relay's own on-chain calls (settle/attest/replenish).
  rpcUrl: req('RPC_URL'),
  // Private submission endpoint for settle txs so the proof isn't exposed in the public mempool (a searcher can
  // otherwise copy it, land it first as msg.sender to steal the bound fee, and revert our tx). Flashbots Protect
  // routes straight to builders AND drops reverting txs (no wasted gas on a lost race). Reads stay on rpcUrl.
  settleRpcUrl: opt('SETTLE_RPC_URL', 'https://rpc.flashbots.net'),

  // Relay signer — pays gas for attest + settle + replenish swaps and collects fees.
  // A single key can serve all roles; split RELAY_KEY / SETTLE_KEY if you want
  // separate nonspaces. SETTLE_KEY falls back to RELAY_KEY.
  relayKey: req('RELAY_KEY'),
  settleKey: opt('SETTLE_KEY', process.env.RELAY_KEY),

  // Idle poll intervals (seconds).
  reflectionPollSecs: num('REFLECTION_POLL_SECS', 30),
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
  // the op via OP_TYPE/OP_FILE env the multi-harness `exec` dispatches on. TODO: confirm
  // whether one `exec` dispatches all ops or one bin per op-type on the built image.
  harnessDir: opt('HARNESS_DIR', '/app/prover/harnesses'),
  proverOut: opt('PROVER_OUT', '/tmp/prover-out'),
  fixtureDir: opt('FIXTURE_DIR', '/tmp/prover-fixtures'),

  // ── Succinct network prover ── (consumed by the spawned binaries)
  // SP1_PROVER=network + NETWORK_PRIVATE_KEY + NETWORK_RPC_URL are read by the SP1 SDK
  // inside the binaries. We surface them here only to validate they are present before
  // spawning, and to fail loudly rather than fall back to a (nonexistent) local GPU.
  sp1Prover: opt('SP1_PROVER', 'network'),
  networkPrivateKey: opt('NETWORK_PRIVATE_KEY', ''),
  // Mainnet/auction endpoint (binaries build in Mainnet mode; Reserved endpoint → auction calls Unimplemented).
  networkRpcUrl: opt('NETWORK_RPC_URL', 'https://rpc.mainnet.succinct.xyz'),

  // ── Fee economics (see ops/PRICING-RELAY-ECONOMICS.md) ──
  minFloorUsd: num('MIN_FLOOR_USD', 0.5), // absolute floor so tiny trades cover their gas
  opsMargin: num('OPS_MARGIN', 0.12), // ~12% over cost
  bpsCap: num('BPS_CAP', 30), // displayed bps ceiling for mid/large trades

  // ── Replenish / monitor thresholds ──
  proveBalanceFloor: num('PROVE_BALANCE_FLOOR', 50), // PROVE, whole tokens
  ethGasBufferWei: BigInt(opt('ETH_GAS_BUFFER_WEI', '30000000000000000')), // 0.03 ETH
  reflectionLagAlertBlocks: num('REFLECTION_LAG_ALERT_BLOCKS', 6),
  alertWebhookUrl: opt('ALERT_WEBHOOK_URL', ''), // optional Slack/Discord/webhook

  // Price oracles for the USD fee math. Kept as overridable env so the crons don't
  // hard-depend on a third-party price API; the dapp passes live prices at quote time.
  provePriceUsd: num('PROVE_PRICE_USD', 0.19),
  ethPriceUsd: num('ETH_PRICE_USD', 1840),
};

// Measured settle gas per op-type (PRICING-RELAY-ECONOMICS.md). Used by the fee math.
export const OP_GAS = {
  wrap: 593_000n,
  swap: 569_000n,
  route: 569_000n,
  lp: 749_000n,
  unwrap: 323_000n,
  transfer: 600_000n, // from a live 1-in/2-out settle estimate (600,356); 2 output leaves + membership
};
export const DEFAULT_OP_GAS = 600_000n;

// Measured PROVE per incremental op — near the groth16 floor (PRICING doc: ~$0.03/op).
export const OP_PROVE = 0.15; // PROVE tokens per op; instrument from Succinct fulfillment records.

export { req, opt, num };
