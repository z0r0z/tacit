// Checking a holding claim: a Groth16 proof (dapp/circuits/evm-pool/holding.circom) that its prover owns a note of at least
// `bucketMin` that is in the pool's note tree and not in its spent set at the snapshot, naming the address the points go to.
// The proof is only as good as the public values it was made against, so every one is compared with what this service holds
// for that day and chain before the proof itself is checked.
//
// publicSignals, in the circuit's order: [root, nfRoot, asset, epoch, bucketMin, claimHash, retNf].
import { isAddress } from 'viem';
import { FIELD_P, claimHashOf } from './holding-epoch.js';

export const SIGNALS = ['root', 'nfRoot', 'asset', 'epoch', 'bucketMin', 'claimHash', 'retNf'];

const refuse = (reason) => ({ ok: false, reason });

// claim: { chainId, epoch, claimAddress, proof, publicSignals }. snapshot: { root, nfRoot } for that day and chain.
// groth16: { verify(vkey, publicSignals, proof) → boolean } (snarkjs).
export async function verifyHoldingClaim({ claim, snapshot, buckets, poolAsset, vkey, groth16 }) {
  const { chainId, epoch, claimAddress, proof, publicSignals } = claim ?? {};
  if (!Number.isInteger(chainId) || !Number.isInteger(epoch)) return refuse('chain and day must be whole numbers');
  if (typeof claimAddress !== 'string' || !isAddress(claimAddress, { strict: false })) return refuse('not an address to pay');
  if (!Array.isArray(publicSignals) || publicSignals.length !== SIGNALS.length || !publicSignals.every((x) => typeof x === 'string' && /^\d{1,80}$/.test(x))) return refuse('public values are not seven decimal numbers');
  if (!proof || typeof proof !== 'object') return refuse('no proof');
  const v = Object.fromEntries(SIGNALS.map((k, i) => [k, BigInt(publicSignals[i])]));
  if (SIGNALS.some((k) => v[k] >= FIELD_P)) return refuse('a public value is not a field element');
  if (v.root !== BigInt(snapshot.root)) return refuse('not the pool\'s note tree at this snapshot');
  if (v.nfRoot !== BigInt(snapshot.nfRoot)) return refuse('not the pool\'s spent set at this snapshot');
  if (v.asset !== BigInt(poolAsset)) return refuse('not this pool\'s asset');
  if (v.epoch !== BigInt(epoch)) return refuse('not this day');
  if (!buckets.some((b) => b === v.bucketMin)) return refuse('not a size that can be claimed');
  if (v.claimHash !== claimHashOf({ chainId, epoch, claimAddress })) return refuse('not made for this payout address, chain and day');
  if (v.retNf === 0n) return refuse('no tag');
  let valid = false;
  try { valid = await groth16.verify(vkey, publicSignals, proof); } catch { return refuse('the proof could not be read'); }
  if (!valid) return refuse('the proof does not verify');
  return { ok: true, retNf: v.retNf, bucketWei: v.bucketMin };
}
