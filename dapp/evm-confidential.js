// Prover for the EVM confidential token (TacitConfidentialERC20 / Etched /
// ConfidentialNoteCore). Builds the Schnorr PoK (wrap / mint / unwrap / burn /
// attest), the 1-of-8 denomination OR-proof, and the conservation kernel that
// the contracts verify on-chain via Secp256k1.sol. All challenge byte layouts
// mirror the contracts exactly.
//
// secp256k1 Pedersen notes on Bitcoin's curve: C = d·H + r·G, H the NUMS
// generator shared with the Bitcoin layer ("tacit-generator-H-v1").
//
// Crypto deps are injected so this runs both in Node (tests / deploy scripts)
// and in the browser dapp (vendored noble). Pass { secp, keccak256, sha256 }.

export function makeConfidentialProver({ secp, keccak256, sha256 }) {
  const P = secp.ProjectivePoint;
  const N = secp.CURVE.n;
  const FP = secp.CURVE.p;
  const G = P.BASE;

  // canonical denomination ladder: 1, 10, 100, 1e3, 1e4, 1e5, 1e6, 1e7
  const CANONICAL = [1n, 10n, 100n, 1000n, 10000n, 100000n, 1000000n, 10000000n];

  const bytesToHex = (b) => Buffer.from(b).toString('hex');
  const hexToBytes = (h) => Uint8Array.from(Buffer.from(h.replace(/^0x/, ''), 'hex'));
  const beBytes = (n, len = 32) => hexToBytes(n.toString(16).padStart(len * 2, '0'));
  const addrBytes = (a) => hexToBytes((a || '0x0000000000000000000000000000000000000000').replace(/^0x/, '').padStart(40, '0'));
  const utf8 = (s) => new TextEncoder().encode(s);
  const mod = (a, m) => ((a % m) + m) % m;
  const bToBig = (b) => BigInt('0x' + bytesToHex(b));
  const hx = (n) => '0x' + n.toString(16).padStart(64, '0');
  const concat = (arr) => { const t = arr.reduce((s, x) => s + x.length, 0); const o = new Uint8Array(t); let p = 0; for (const x of arr) { o.set(x, p); p += x.length; } return o; };

  // NUMS H — sha256("tacit-generator-H-v1") + try-increment, matching the
  // Bitcoin-side Pedersen generator (dapp/bulletproofs.js, secp.rs).
  function pedersenH() {
    const seed = sha256(utf8('tacit-generator-H-v1'));
    for (let c = 0; c < 256; c++) {
      const x = sha256(concat([seed, new Uint8Array([c])]));
      try { return P.fromHex('02' + bytesToHex(x)); } catch {}
    }
    throw new Error('no H');
  }
  const H = pedersenH();
  const D = CANONICAL.map((d) => H.multiply(d));

  const defaultRand = () => mod(bToBig(secp.utils.randomPrivateKey()), N) || 1n;

  const aff = (pt) => pt.toAffine();
  const xParity = (pt) => { const a = aff(pt); return { x: a.x, parity: Number(a.y & 1n) }; };
  const addrOf = (pt) => { const a = aff(pt); return '0x' + bytesToHex(keccak256(concat([beBytes(a.x), beBytes(a.y)])).slice(12)); };

  const commit = (d, r) => H.multiply(d).add(G.multiply(r));
  const denomIdxOf = (d) => CANONICAL.indexOf(BigInt(d));

  // Schnorr PoK that C − D_i = r·G, challenge bound to the op. Used by
  // wrap / mint / unwrap / burn (to = recipient or 0) and attest (to = caller).
  function proveOpen({ chainId, contract, denomIdx, r, to, rand = defaultRand }) {
    const C = commit(CANONICAL[denomIdx], r);
    const a = aff(C);
    const k = rand(), R = G.multiply(k), rAddr = addrOf(R);
    const e = mod(bToBig(keccak256(concat([
      utf8('tacit-evm-cnote-pok-v1'), beBytes(BigInt(chainId)), addrBytes(contract),
      beBytes(a.x), beBytes(a.y), new Uint8Array([denomIdx]), addrBytes(to), addrBytes(rAddr),
    ]))), N);
    const z = mod(k + e * r, N);
    return { cx: hx(a.x), cy: hx(a.y), denomIdx, rAddr, z: hx(z) };
  }

  // 1-of-8 CDS OR-proof that C opens to one of {d_i·H + r·G}; output denom hidden.
  function proveOr({ chainId, contract, C, jIndex, r, rand = defaultRand }) {
    const K = CANONICAL.length;
    const Cmi = D.map((Di) => C.add(Di.negate()));
    const e_arr = new Array(K), z_arr = new Array(K), A = new Array(K);
    for (let i = 0; i < K; i++) {
      if (i === jIndex) continue;
      e_arr[i] = rand(); z_arr[i] = rand();
      A[i] = G.multiply(z_arr[i]).add(Cmi[i].multiply(mod(N - e_arr[i], N)));
    }
    const kj = rand();
    A[jIndex] = G.multiply(kj);
    const a = aff(C);
    const tparts = [utf8('tacit-evm-cnote-or-v1'), beBytes(BigInt(chainId)), addrBytes(contract), beBytes(a.x), beBytes(a.y)];
    for (let i = 0; i < K; i++) { const ai = aff(A[i]); tparts.push(beBytes(ai.x), beBytes(ai.y)); }
    const e = mod(bToBig(keccak256(concat(tparts))), N);
    let sumOther = 0n;
    for (let i = 0; i < K; i++) if (i !== jIndex) sumOther = mod(sumOther + e_arr[i], N);
    e_arr[jIndex] = mod(e - sumOther, N);
    z_arr[jIndex] = mod(kj + e_arr[jIndex] * r, N);
    return {
      Ax: A.map((p) => hx(aff(p).x)), Ay: A.map((p) => hx(aff(p).y)),
      e: e_arr.map(hx), z: z_arr.map(hx),
    };
  }

  // Conservation kernel: Σin − Σout == excess·G, challenge bound to contract + notes.
  function proveKernel({ chainId, contract, Cin, Cout, rin, rout, rand = defaultRand }) {
    const excess = mod(rin.reduce((s, x) => s + x, 0n) - rout.reduce((s, x) => s + x, 0n), N);
    const k = rand(), R = G.multiply(k), rAddr = addrOf(R);
    const t = [utf8('tacit-evm-cnote-kernel-v1'), addrBytes(contract)];
    for (const C of [...Cin, ...Cout]) { const a = aff(C); t.push(beBytes(a.x), beBytes(a.y)); }
    t.push(addrBytes(rAddr));
    const e = mod(bToBig(keccak256(concat(t))), N);
    const z = mod(k + e * excess, N);
    return { kernelRAddr: rAddr, kernelZ: hx(z) };
  }

  // Full 2-in/2-out confidential transfer. inputs/outputs: [{ d, r }, { d, r }],
  // with Σ input d == Σ output d. Returns the ConfidentialNoteCore.Transfer fields.
  function proveTransfer({ chainId, contract, inputs, outputs, rand = defaultRand }) {
    const Cin = inputs.map(({ d, r }) => commit(BigInt(d), r));
    const Cout = outputs.map(({ d, r }) => commit(BigInt(d), r));
    const or0 = proveOr({ chainId, contract, C: Cout[0], jIndex: denomIdxOf(outputs[0].d), r: outputs[0].r, rand });
    const or1 = proveOr({ chainId, contract, C: Cout[1], jIndex: denomIdxOf(outputs[1].d), r: outputs[1].r, rand });
    const k = proveKernel({ chainId, contract, Cin, Cout, rin: inputs.map((i) => i.r), rout: outputs.map((o) => o.r), rand });
    return {
      cinx: Cin.map((c) => hx(aff(c).x)), ciny: Cin.map((c) => hx(aff(c).y)),
      coutx: Cout.map((c) => hx(aff(c).x)), couty: Cout.map((c) => hx(aff(c).y)),
      or0, or1, ...k,
    };
  }

  return {
    H, LADDER: CANONICAL, denomPoints: () => D.map((p) => ({ x: hx(aff(p).x), y: hx(aff(p).y) })),
    commit, denomIdxOf, addrOf, proveOpen, proveOr, proveKernel, proveTransfer,
    _internal: { hx, beBytes, bToBig, mod, N, G, P },
  };
}
