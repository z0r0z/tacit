#!/usr/bin/env python3
"""Frees the coordinator's disk by deleting old chain files that the mirror holds, never one it does not.

The coordinator needs only the head to accept a contribution. Every older file is on the mirror (Filebase, pinned on IPFS), put there
only after its SHA-256 matched the signed transcript. This deletes the oldest such files, and only while the disk is fuller than
--above GB, down to --to GB. It never deletes: the head or the --keep newest files, phase2-17 (Succinct's, the chain's base), a
file whose receipt is missing, or a file the mirror does not list with the same SHA-256 as its receipt.

  prune.py <chain dir> [--above 60] [--to 45] [--keep 3] [--dry-run]

Run it in a loop on the coordinator's machine (upkeep/prune-loop.sh). Reads state.json from the chain directory and the mirror's list
from https://tacit-praxis-ceremony.onrender.com/api/mirror; if either cannot be read it deletes nothing.
"""
import argparse, json, os, re, shutil, sys, urllib.request

MIRROR = os.environ.get("MIRROR_LIST", "https://tacit-praxis-ceremony.onrender.com/api/mirror")
NAME = re.compile(r"^phase2-(\d+)$")


def used_gb(d):
    u = shutil.disk_usage(d)
    return (u.total - u.free) / 1e9


def eligible(state, mirror_files, present, keep):
    """Indexes that may be deleted now, oldest first. Pure: the safety rules, in one place."""
    head = state["head_index"]
    base = state["base_index"]
    sha = {r["index"]: r["file_sha256"] for r in state.get("receipts", [])}
    out = []
    for i in sorted(present):
        if i <= base or i > head - keep:
            continue                       # the base file, the head and the newest few stay
        want = sha.get(i)
        m = mirror_files.get(str(i)) or mirror_files.get(i)
        if not want or not m or m.get("sha256") != want:
            continue                       # no receipt, or the mirror does not hold exactly this file
        out.append(i)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("dir")
    ap.add_argument("--above", type=float, default=60)
    ap.add_argument("--to", type=float, default=45)
    ap.add_argument("--keep", type=int, default=3)
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()

    d = a.dir
    if used_gb(d) <= a.above and not a.dry_run:
        return 0
    try:
        state = json.load(open(os.path.join(d, "state.json")))
        with urllib.request.urlopen(MIRROR, timeout=30) as r:
            mirror = json.load(r)["files"]
    except Exception as e:
        print(f"prune: cannot read state or mirror ({e}); nothing deleted", file=sys.stderr)
        return 1
    present = [int(m.group(1)) for f in os.listdir(d) if (m := NAME.match(f))]
    for i in eligible(state, mirror, present, a.keep):
        if used_gb(d) <= a.to and not a.dry_run:
            break
        p = os.path.join(d, f"phase2-{i}")
        print(f"prune: {'would delete' if a.dry_run else 'deleting'} {p} (the mirror holds it: {mirror[str(i)].get('cid')})")
        if not a.dry_run:
            os.remove(p)
    print(f"prune: {used_gb(d):.1f} GB used")
    return 0


if __name__ == "__main__":
    sys.exit(main())
