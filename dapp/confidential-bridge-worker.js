// Module worker: the bridge-mint walk's per-nullifier search (confidential-bridge-walk.js walkNullifiers), off the page's thread.
//   { id, setupKey, setup: { p, owners, values, roundValues, maxExp }, nulls: [{ n, want: [leaf, …] }] } → { id, found, tried }
// It runs the same function the page runs, so it can only find what the page would. The value grid (about 1,900 points) is made once per setupKey
// and kept for the next chunk; the page ends this worker a few seconds after its last job, and the key goes with it.

import { secp, sha256, keccak_256, hmac } from './vendor/tacit-deps.min.js';
import { bppH, G } from './bulletproofs-plus.js';
import { makeBridgeMintRecovery } from './bridge-mint-recovery.js';
import { valuePoints, walkNullifiers } from './confidential-bridge-walk.js';

const H = bppH();
const recovery = makeBridgeMintRecovery({ hmac, sha256, curveOrder: secp.CURVE.n });
const deriveBlinding = (priv, nullifier) => recovery.deriveBridgeMintBlinding({ privkey: priv, nullifier });
let kept = null;                                              // { key, pts }: the grid of the last setup

self.onmessage = async ({ data }) => {
  const { id, setupKey, setup, nulls } = data || {};
  try {
    if (!kept || kept.key !== setupKey) {
      kept = { key: setupKey, pts: await valuePoints({ H, values: setup.values.map(BigInt), roundValues: setup.roundValues, maxExp: setup.maxExp }) };
    }
    const r = await walkNullifiers({ G, keccak256: keccak_256, deriveBlinding, p: setup.p, owners: setup.owners, pts: kept.pts, nulls: nulls.map((x) => ({ n: x.n, want: new Set(x.want) })) });
    self.postMessage({ id, found: r.found, tried: r.tried });
  } catch (e) {
    self.postMessage({ id, error: String((e && e.message) || e) });
  }
};
