# Holding Bitcoin coins under a multisig or vault script without burning Tacit assets

A Tacit asset note is a Bitcoin output. Spending it as plain sats destroys the asset ([SPEC §3.2](../SPEC.md)).
A wallet whose coins sit under a script with no single key (a multisig vault) cannot use the owner-keyed
`/holdings` lookup, so it needs to know by coin which outputs are notes.

## Rules

1. **Never send Tacit assets to a vault address.** Nothing in the protocol stops a sender from paying a note to any
   script, and the vault can then neither read the amount (the blinding derives from the recipient's private key,
   [§2.6](../SPEC.md)) nor publish an opening. Only the sender knows what is in it.
2. **Quarantine anything that arrives anyway.** Anyone can send a note to your address. The 546-sat band catches the
   usual case but is not a guarantee: the sender chooses the output value.
3. **Fail closed.** If the check cannot run, build no spend.

## `POST /outpoints/classify?network=mainnet`

Open to any origin. No key, no auth. Up to 100 outpoints per call.

```
POST https://api.tacit.finance/outpoints/classify?network=mainnet
{ "outpoints": ["<txid>:<vout>", ...] }

200 {
  "network": "mainnet",
  "coins": {
    "<txid>:<vout>": { "status": "asset",      "asset_ids": ["<asset_id>"] },
    "<txid>:<vout>": { "status": "plain" },
    "<txid>:<vout>": { "status": "unverified", "reason": "..." }
  },
  "assets":     { "<txid>:<vout>": ["<asset_id>"] },   // the `asset` coins only
  "unverified": ["<txid>:<vout>", ...]                  // the `unverified` coins only
}
```

| `status` | Meaning | Spend as sats? |
|---|---|---|
| `asset` | A verified Tacit note of `asset_ids[0]` (kernel signatures and range proofs walked back to the etch). | **No.** |
| `plain` | Provably not a note: the creating transaction has no Tacit envelope on any input, or the envelope's rules put this vout outside the notes it creates. | Yes. |
| `unverified` | Could be a note and could not be shown not to be: explorer lookup failed, an op the walk does not cover, a pool exit riding a later input, or the request ran out of time. | **No.** Treat as an asset, retry later. |

A coin missing from `coins` is not a verdict. Read `status`, and treat a missing entry like `unverified`.

Retrying `unverified` coins converges: every hop a walk proves is cached permanently, and a request that hits its
time or walk budget (25 walks, about 20 s) returns the rest as `unverified` with `reason: "request over budget, retry"`.
A coin that has never been looked up can take tens of seconds the first time.

### Drop-in guard

```js
const TACIT = 'https://api.tacit.finance';

// Returns the outpoints that are safe to spend as sats. Throws if the check cannot run.
async function spendableAsSats(outpoints) {
  const safe = [];
  for (let i = 0; i < outpoints.length; i += 100) {
    const chunk = outpoints.slice(i, i + 100);
    const r = await fetch(`${TACIT}/outpoints/classify?network=mainnet`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ outpoints: chunk }),
    });
    if (!r.ok) throw new Error(`Tacit check failed (${r.status}); not building a spend`);
    const { coins } = await r.json();
    for (const op of chunk) if (coins?.[op]?.status === 'plain') safe.push(op);
  }
  return safe;
}
```

Run it when selecting coins and again on the final input set right before signing. Show `asset` coins in the coin
list with their `asset_ids[0]`. Add `https://api.tacit.finance` to `connect-src` in the page's CSP.

## Checking without Tacit

If you would rather not depend on the endpoint for the gate, fetch each coin's creating transaction from any
Esplora and quarantine the coin when any input's witness holds a taproot script of the form
`<32-byte key> OP_CHECKSIG OP_FALSE OP_IF "TACIT" 0x01 <payload> OP_ENDIF` ([§3.1](../SPEC.md)). That
over-excludes a little (a failed op's outputs, a trade's plain BTC payment) and never under-excludes. The endpoint
then refines it and names the asset.
