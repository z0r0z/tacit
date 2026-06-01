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

def fetch_opening(worker_base, network, txid, vout):
    qs = urllib.parse.urlencode({"network": network})
    url = f"{worker_base.rstrip('/')}/utxos/{txid}/{vout}/opening?{qs}"
    return http_get_json(url)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--start-height", type=int, required=True)
    ap.add_argument("--num-blocks",   type=int, required=True)
    ap.add_argument("--network",      default="signet")
    ap.add_argument("--worker-base",  required=True)
    ap.add_argument("--output",       required=True)
    args = ap.parse_args()

    api = MEMPOOL_API.get(args.network)
    if not api:
        print(f"unknown network: {args.network}", file=sys.stderr); sys.exit(1)

    entries = []
    for h in range(args.start_height, args.start_height + args.num_blocks):
        txids = fetch_block_txids(api, h)
        if not txids:
            print(f"  block {h}: no txids (skip)", file=sys.stderr); continue
        for tx_idx, txid in enumerate(txids):
            vout_count = fetch_tx_vouts(api, txid)
            if not vout_count:
                continue
            outputs = []
            any_found = False
            for v in range(vout_count):
                op = fetch_opening(args.worker_base, args.network, txid, v)
                if op and "amount" in op and "blinding" in op:
                    try:
                        outputs.append({
                            "amount":   int(op["amount"]),
                            "blinding": op["blinding"].replace("0x", ""),
                        })
                        any_found = True
                    except (ValueError, AttributeError):
                        outputs.append({"amount": 0, "blinding": "00" * 32})
                else:
                    outputs.append({"amount": 0, "blinding": "00" * 32})
            if any_found:
                # Trim trailing all-zeros (no opening published past this point)
                while outputs and outputs[-1]["amount"] == 0 and outputs[-1]["blinding"] == "00" * 32:
                    outputs.pop()
                if outputs:
                    entries.append({"block_height": h, "tx_index": tx_idx, "outputs": outputs})
                    print(f"  block {h} tx_idx {tx_idx} ({txid[:10]}…): {len(outputs)} openings", file=sys.stderr)

    with open(args.output, "w") as f:
        json.dump(entries, f, indent=2)
    print(f"wrote {len(entries)} CXFER witness entries to {args.output}", file=sys.stderr)

if __name__ == "__main__":
    main()
