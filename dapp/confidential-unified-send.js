// Unified Send dispatch — one "send to <recipient>" intent routed to the right
// existing builder based on the parsed recipient + chosen asset + context.
//
// This module is ROUTING ONLY. Every byte of crypto stays in the builders it
// calls (BTC CXFER, sats P2WPKH/silent-payment, EVM pool transfer, wrap-and-send).
// It is constructed by tacit.js with its builders injected (factory pattern) so
// there is no circular import back into the monolith.
//
// Lanes:
//   - Bitcoin-native asset  → CXFER (pubkey or stealth recipient)
//   - sats                  → existing sats-send (P2WPKH or BIP-352 silent payment)
//   - pool asset (cETH/…)   → confidential-pool transfer; with optional
//                             wrap-and-send when the user holds underlying funds
//                             but no/insufficient shielded notes.
//
// The Ethereum lane is wired but GATED: dispatch consults isCrosslaneConfigured()
// and refuses to construct/route EVM when the pool isn't live for the network
// (all of mainnet today; signet until an asset is flipped live).

export function makeUnifiedSend(deps) {
  const {
    parseRecipient,            // (raw, {network, chainHint}) → normalized recipient
    currentNetworkName,        // () → 'mainnet'|'signet'|…
    isCrosslaneConfigured,     // (network) → bool   (tacit.js _crosslaneConfigured)
    // Bitcoin-native asset send (CXFER), multi-recipient capable:
    buildAndBroadcastCXferMulti, // ({assetIdHex, recipients:[{pubHex|stealthAddress, amount}], ...})
    // sats send (plain BTC / silent payment) — opaque driver supplied by tacit.js:
    sendSats,                  // ({parsed, amountSats, opts}) → {txid}
    // EVM pool lane (lazily provided; may be null when gated):
    getPoolUx,                 // () → ux | null   (null when pool not configured)
  } = deps;

  // Resolve which lane an asset belongs to. A descriptor carries either a
  // Bitcoin asset id, the sats sentinel, or a pool ticker/assetId.
  function laneOfAsset(asset) {
    if (!asset) return null;
    if (asset.kind === 'sats') return 'sats';
    if (asset.kind === 'btc')  return 'btc';   // etched Bitcoin asset
    if (asset.kind === 'pool') return 'evm';   // confidential-pool asset
    return null;
  }

  // Map the chosen asset to the chainHint parseRecipient needs to break the
  // bare-pubkey ambiguity (a 33-byte key is valid on both chains).
  function chainHintForAsset(asset) {
    const lane = laneOfAsset(asset);
    if (lane === 'evm') return 'evm';
    if (lane === 'btc' || lane === 'sats') return 'btc';
    return undefined;
  }

  // Pick the concrete recipient leg for the chosen asset. For a unified Tacit
  // address the asset selects the lane; for a single-format address we verify
  // it matches the asset's lane.
  function resolveLeg(parsed, asset) {
    const lane = laneOfAsset(asset);
    if (parsed.kind === 'tacit') {
      if (lane === 'evm') {
        if (!parsed.lanes.evm) return { error: 'this Tacit address does not advertise an Ethereum lane' };
        return { path: 'evm-transfer', pubHex: '0x' + bytesHex(parsed.lanes.evm.ownerPub) };
      }
      // btc / sats lane: the unified address carries spend + scan pubkeys.
      if (lane === 'sats') {
        // Pay the unified holder as a silent payment using their scan/spend keys.
        return { path: 'sats-sp', scanPub: parsed.lanes.btc.scanPub, spendPub: parsed.lanes.btc.spendPub };
      }
      return { path: 'cxfer-pubkey', pubHex: bytesHex(parsed.lanes.btc.spendPub) };
    }
    // Single-format address: confirm the lane matches.
    if (lane === 'evm') {
      if (parsed.path !== 'evm-transfer') return { error: 'recipient is not an Ethereum shielded pubkey' };
      return { path: 'evm-transfer', pubHex: parsed.pubHex };
    }
    if (lane === 'sats') {
      if (parsed.path === 'sats-p2wpkh' || parsed.path === 'sats-sp') return { ...parsed };
      return { error: 'sats sends go to a bech32 address or silent-payment address' };
    }
    // btc asset (CXFER)
    if (parsed.path === 'cxfer-pubkey' || parsed.path === 'cxfer-stealth') return { ...parsed };
    return { error: 'recipient is not a Bitcoin asset target' };
  }

  function bytesHex(u8) {
    return Array.from(u8, (x) => x.toString(16).padStart(2, '0')).join('');
  }

  // Dispatch a send. Returns a result object; never throws for routing/gating
  // decisions (throws only propagate from the underlying builders).
  //   { wallet, recipientRaw, asset, amount, opts }
  //   asset: { kind:'sats' } | { kind:'btc', assetId } | { kind:'pool', assetId, ticker }
  async function dispatchSend({ wallet, recipientRaw, asset, amount, opts = {} }) {
    const network = currentNetworkName();
    const parsed = parseRecipient(recipientRaw, { network, chainHint: chainHintForAsset(asset) });

    if (parsed.kind === 'empty') return { ok: false, reason: 'enter a recipient' };
    if (parsed.kind === 'error') return { ok: false, reason: parsed.message };
    if (parsed.kind === 'ambiguous') {
      return { ok: false, ambiguous: true, candidates: parsed.candidates,
        reason: 'recipient pubkey is valid on both chains — choose Bitcoin or Ethereum' };
    }

    const lane = laneOfAsset(asset);
    if (!lane) return { ok: false, reason: 'choose an asset to send' };

    // Gate the Ethereum lane.
    if (lane === 'evm' && !isCrosslaneConfigured(network)) {
      return { ok: false, blocked: true, reason: 'Ethereum sends are not live on this network yet' };
    }

    const leg = resolveLeg(parsed, asset);
    if (leg.error) return { ok: false, reason: leg.error };

    if (lane === 'btc') {
      const recipients = leg.path === 'cxfer-stealth'
        ? [{ stealthAddress: leg.raw, amount }]
        : [{ pubHex: leg.pubHex, amount }];
      const r = await buildAndBroadcastCXferMulti({ assetIdHex: asset.assetId, recipients, ...opts });
      return { ok: true, lane, path: leg.path, result: r };
    }

    if (lane === 'sats') {
      const r = await sendSats({ parsed: leg, amountSats: amount, opts });
      return { ok: true, lane, path: leg.path, result: r };
    }

    // lane === 'evm'
    const ux = getPoolUx && getPoolUx();
    if (!ux) return { ok: false, blocked: true, reason: 'Ethereum pool is not available' };
    return await dispatchEvm({ wallet, ux, recipientPubHex: leg.pubHex, asset, amount, opts });
  }

  // EVM lane: transfer from shielded notes; wrap-and-send if the user holds
  // underlying funds but lacks sufficient shielded balance. NOT atomic — the
  // wrap must settle before the transfer note is spendable; caller surfaces the
  // two-phase status via opts.onPhase.
  async function dispatchEvm({ wallet, ux, recipientPubHex, asset, amount, opts }) {
    const onPhase = opts.onPhase || (() => {});
    const ticker = asset.ticker || ux.tickerOf(asset.assetId) || 'cETH';
    const fee = opts.fee || 0n;

    const bal = await ux.balance(wallet.priv);
    const notes = (bal.notes || []).filter((n) => n.asset === asset.assetId);
    const shielded = notes.reduce((s, n) => s + BigInt(n.value), 0n);
    const need = amount + fee;

    if (shielded < need) {
      if (!opts.allowWrap) {
        return { ok: false, reason: `insufficient shielded ${ticker}; enable wrap-and-send to top up from your balance` };
      }
      const shortfall = need - shielded;

      // Preferred path: the ConfidentialRouter batches wrap + settle into ONE
      // user tx (router.wrapAndSettleETH / wrapAndSettleWithPermit) — the wrap
      // deposit and the recipient note settle atomically, no intermediate
      // spendable note, no poll. Available only when the router is configured
      // and the user has no existing shielded notes to combine (single input =
      // the freshly-wrapped note). ux.wrapAndSend encapsulates the prove-only
      // proof + router calldata.
      if (shielded === 0n && ux.wrapAndSend && ux.routerConfigured && ux.routerConfigured()) {
        onPhase({ phase: 'wrap-and-send', ticker, atomic: true });
        const r = await ux.wrapAndSend({
          walletPriv: wallet.priv, amountWei: shortfall, ticker, recipientPubHex, amount, fee,
        });
        return { ok: true, lane: 'evm', path: 'wrap-and-settle', atomic: true, result: r };
      }

      // Fallback: two-step (wrap, wait for settle, then transfer). Not atomic —
      // OP_WRAP must settle before the new note is spendable.
      onPhase({ phase: 'wrap', shortfall, ticker });
      const wrapFn = (ux.routerConfigured && ux.routerConfigured() && ux.routerWrap) ? ux.routerWrap : ux.wrap;
      await wrapFn.call(ux, { walletPriv: wallet.priv, amountWei: shortfall, ticker });
      await pollForBalance(ux, wallet.priv, asset.assetId, need, opts);
    }

    onPhase({ phase: 'send', ticker });
    const fresh = await ux.balance(wallet.priv);
    const picked = selectNotes((fresh.notes || []), asset.assetId, need);
    if (!picked) return { ok: false, reason: 'shielded balance did not settle in time; retry the send' };
    const r = await ux.transfer({
      walletPriv: wallet.priv, notes: picked, recipientPubHex, amount, fee,
      selfRelay: !!opts.selfRelay, waitOpts: opts.waitOpts,
    });
    return { ok: true, lane: 'evm', path: 'evm-transfer', result: r };
  }

  function selectNotes(notes, assetId, need) {
    const pool = notes.filter((n) => n.asset === assetId)
      .sort((a, b) => (BigInt(b.value) - BigInt(a.value) > 0n ? 1 : -1));
    const picked = [];
    let sum = 0n;
    for (const n of pool) { picked.push(n); sum += BigInt(n.value); if (sum >= need) break; }
    return sum >= need ? picked : null;
  }

  async function pollForBalance(ux, priv, assetId, need, opts) {
    const tries = opts.wrapPollTries || 30;
    const delayMs = opts.wrapPollDelayMs || 4000;
    for (let i = 0; i < tries; i++) {
      const bal = await ux.balance(priv);
      const have = (bal.notes || []).filter((n) => n.asset === assetId)
        .reduce((s, n) => s + BigInt(n.value), 0n);
      if (have >= need) return true;
      await new Promise((res) => setTimeout(res, delayMs));
    }
    return false;
  }

  return { dispatchSend, laneOfAsset, chainHintForAsset, resolveLeg };
}
