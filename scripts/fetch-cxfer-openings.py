#!/usr/bin/env python3
"""
Fetch published Pedersen openings for CXFER outputs in a block range and
write them to the JSON file the SP1 host's CXFER_WITNESSES_PATH expects.

The bridge SP1 guest's CXFER conservation tracker (program/src/main.rs
:413-432) needs (amount, blinding) for every output of every CXFER tx
spending a tETH UTXO. Without them the guest removes the input UTXO but
creates no outputs → recipients can't import + redeem ETH. The dapp
auto-publishes openings to the worker when CXFER is for the bridge
asset (dapp/tacit.js auto-publish branch). This script fetches them
before each prover cycle.

Strategy: iterate every (txid, vout) in the block range; query the
worker's /utxos/<txid>/<vout>/opening?network=<net> endpoint; retain
the 200 responses. The worker doesn't have a bulk-by-block endpoint
(yet), so this is one HTTP call per output — typically a few hundred
per block, bearable for a low-traffic pilot. A worker-side block-range
index is the proper long-term fix.

Usage:
    fetch-cxfer-openings.py --start-height N --num-blocks K \
        --network signet|mainnet --worker-base URL --output PATH

Output JSON format (matches host's load_cxfer_witnesses):
    [ { "block_height": int, "tx_index": int,
        "outputs": [ {"amount": int, "blinding": "hex32"}, ... ] }, ... ]
"""

import argparse
import json
import sys
import urllib.parse
import urllib.request
import urllib.error
import time

MEMPOOL_API = {
    "signet":  "https://mempool.space/signet/api",
    "mainnet": "https://mempool.space/api",
}

# mempool.space 403s the default Python-urllib UA and rate-limits bursts, so
# send a browser-ish UA and retry transient 403/429/5xx with backoff.
_UA = "Mozilla/5.0 (tacit-prover) urllib"

def _http(url, timeout=15, want_json=True, retries=6):
    for i in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": _UA})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                data = r.read()
                return json.loads(data) if want_json else data.decode().strip()
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            time.sleep(0.6 * (i + 1) + 0.4)  # 403/429/5xx backoff
        except Exception:
            time.sleep(0.5 * (i + 1))
    return None

def http_get_json(url, timeout=15):
    return _http(url, timeout, want_json=True)

def http_get_text(url, timeout=15):
    return _http(url, timeout, want_json=False)

def fetch_block_txids(api_base, height):
    h = http_get_text(f"{api_base}/block-height/{height}")
    if not h:
        return None
    txids = http_get_json(f"{api_base}/block/{h}/txids")
    return txids if isinstance(txids, list) else None

def fetch_tx_vouts(api_base, txid):
    tx = http_get_json(f"{api_base}/tx/{txid}")
    if not tx or not isinstance(tx.get("vout"), list):
        return None
    return len(tx["vout"])

def fetch_asset_openings(worker_base, network, asset_id):
    qs = urllib.parse.urlencode({"network": network})
    url = f"{worker_base.rstrip('/')}/assets/{asset_id}/openings?{qs}"
    resp = http_get_json(url)
    if not resp or not isinstance(resp.get("openings"), list):
        return []
    return resp["openings"]

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--start-height", type=int, required=True)
    ap.add_argument("--num-blocks",   type=int, required=True)
    ap.add_argument("--network",      default="signet")
    ap.add_argument("--worker-base",  required=True)
    ap.add_argument("--output",       required=True)
    ap.add_argument("--asset-id",     required=True, help="bridge asset id (no 0x) to scope the opening list")
    args = ap.parse_args()

    api = MEMPOOL_API.get(args.network)
    if not api:
        print(f"unknown network: {args.network}", file=sys.stderr); sys.exit(1)
    target = args.start_height + args.num_blocks - 1

    # Scope to the few published CXFER openings for this asset (one worker call)
    # rather than probing every (txid, vout) in the range — mainnet blocks carry
    # thousands of txs, so per-output probing is O(100k) calls/cycle. The worker
    # only stores openings for bridge-CXFER outputs, so the list IS the candidate
    # set; map each to its block and keep the ones in range.
    aid = args.asset_id.replace("0x", "")
    openings = fetch_asset_openings(args.worker_base, args.network, aid)
    by_txid = {}  # txid -> {vout: {amount, blinding}}
    for op in openings:
        txid = op.get("txid"); vout = op.get("vout")
        if txid is None or vout is None or "amount" not in op or "blinding" not in op:
            continue
        try:
            by_txid.setdefault(txid, {})[int(vout)] = {
                "amount": int(op["amount"]),
                "blinding": str(op["blinding"]).replace("0x", ""),
            }
        except (ValueError, TypeError):
            continue

    entries = []
    for txid, vouts in by_txid.items():
        st = http_get_json(f"{api}/tx/{txid}/status")
        if not st or not st.get("confirmed"):
            continue
        h = st.get("block_height")
        if h is None or h < args.start_height or h > target:
            continue
        block_hash = st.get("block_hash") or http_get_text(f"{api}/block-height/{h}")
        txids = http_get_json(f"{api}/block/{block_hash}/txids")
        if not isinstance(txids, list) or txid not in txids:
            print(f"  {txid[:10]}… in block {h} but not in its txids (skip)", file=sys.stderr); continue
        tx_index = txids.index(txid)
        # Contiguous outputs from vout 0 to the max published vout; gaps -> zero.
        max_vout = max(vouts.keys())
        outputs = [vouts.get(v, {"amount": 0, "blinding": "00" * 32}) for v in range(max_vout + 1)]
        entries.append({"block_height": h, "tx_index": tx_index, "outputs": outputs})
        print(f"  block {h} tx_idx {tx_index} ({txid[:10]}…): {len(outputs)} openings", file=sys.stderr)

    entries.sort(key=lambda e: (e["block_height"], e["tx_index"]))
    with open(args.output, "w") as f:
        json.dump(entries, f, indent=2)
    print(f"wrote {len(entries)} CXFER witness entries to {args.output}", file=sys.stderr)

if __name__ == "__main__":
    main()
