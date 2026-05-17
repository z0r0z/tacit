"""
Bulletproofs+ on secp256k1 - independent Python re-derivation.

Differences vs Monero:
- Curve: ed25519 -> secp256k1 (cofactor=1)
- Hash: Keccak -> SHA-256
- All INV_EIGHT / scalarmult8 factors omitted (cofactor=1 simplification)
- Transcript: length-prefixed Merlin-style
- Pedersen: C = v*H + gamma*G
- Wire: A || A1 || B || r1(32 BE) || s1(32 BE) || d1(32 BE) || (L||R)*logMN
"""

import hashlib

SECP_P = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2F
SECP_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141
GX = 0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798
GY = 0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8


def modinv(a, m):
    return pow(a % m, -1, m)


def point_to_affine(P):
    if P is None:
        return None
    X, Y, Z = P
    if Z == 0:
        return None
    z_inv = modinv(Z, SECP_P)
    z_inv2 = (z_inv * z_inv) % SECP_P
    z_inv3 = (z_inv2 * z_inv) % SECP_P
    return ((X * z_inv2) % SECP_P, (Y * z_inv3) % SECP_P)


def point_double(P):
    if P is None:
        return None
    X, Y, Z = P
    if Y == 0:
        return None
    M = (3 * X * X) % SECP_P
    Ysq = (Y * Y) % SECP_P
    S = (4 * X * Ysq) % SECP_P
    Xr = (M * M - 2 * S) % SECP_P
    Yr = (M * (S - Xr) - 8 * Ysq * Ysq) % SECP_P
    Zr = (2 * Y * Z) % SECP_P
    return (Xr, Yr, Zr)


def point_add(P, Q):
    if P is None:
        return Q
    if Q is None:
        return P
    X1, Y1, Z1 = P
    X2, Y2, Z2 = Q
    Z1Z1 = (Z1 * Z1) % SECP_P
    Z2Z2 = (Z2 * Z2) % SECP_P
    U1 = (X1 * Z2Z2) % SECP_P
    U2 = (X2 * Z1Z1) % SECP_P
    S1 = (Y1 * Z2 * Z2Z2) % SECP_P
    S2 = (Y2 * Z1 * Z1Z1) % SECP_P
    if U1 == U2:
        if S1 != S2:
            return None
        return point_double(P)
    H = (U2 - U1) % SECP_P
    r = (S2 - S1) % SECP_P
    HH = (H * H) % SECP_P
    HHH = (H * HH) % SECP_P
    V = (U1 * HH) % SECP_P
    Xr = (r * r - HHH - 2 * V) % SECP_P
    Yr = (r * (V - Xr) - S1 * HHH) % SECP_P
    Zr = (Z1 * Z2 * H) % SECP_P
    return (Xr, Yr, Zr)


def point_mul(k, P):
    if P is None or k % SECP_N == 0:
        return None
    k = k % SECP_N
    R = None
    bits = k.bit_length()
    for i in range(bits - 1, -1, -1):
        R = point_double(R)
        if (k >> i) & 1:
            R = point_add(R, P)
    return R


def point_compressed(P):
    aff = point_to_affine(P)
    if aff is None:
        raise ValueError("Cannot compress point at infinity")
    x, y = aff
    prefix = 0x02 if (y & 1) == 0 else 0x03
    return bytes([prefix]) + x.to_bytes(32, "big")


def point_from_compressed(b):
    if len(b) != 33:
        raise ValueError("compressed point must be 33 bytes")
    prefix = b[0]
    if prefix not in (0x02, 0x03):
        raise ValueError("invalid compressed prefix")
    x = int.from_bytes(b[1:33], "big")
    if x >= SECP_P:
        raise ValueError("x out of range")
    rhs = (pow(x, 3, SECP_P) + 7) % SECP_P
    y = pow(rhs, (SECP_P + 1) // 4, SECP_P)
    if (y * y) % SECP_P != rhs:
        raise ValueError("not on curve")
    if (y & 1) != (prefix & 1):
        y = (-y) % SECP_P
    return (x, y, 1)


G_POINT = (GX, GY, 1)


def _try_hash_to_curve(prefix_bytes):
    for counter in range(256):
        candidate = b"\x02" + hashlib.sha256(prefix_bytes + bytes([counter])).digest()
        try:
            return point_from_compressed(candidate)
        except ValueError:
            continue
    raise RuntimeError("try-and-increment exhausted")


def derive_H():
    seed = hashlib.sha256(b"tacit-generator-H-v1").digest()
    return _try_hash_to_curve(seed)


def derive_Gvec(i):
    return _try_hash_to_curve(b"tacit-bp-G-v1" + i.to_bytes(4, "little"))


def derive_Hvec(i):
    return _try_hash_to_curve(b"tacit-bp-H-v1" + i.to_bytes(4, "little"))


N_BITS = 64
MAX_M = 8
MAX_NM = N_BITS * MAX_M

_H_GEN = None
_GVEC = None
_HVEC = None


def _init_generators():
    global _H_GEN, _GVEC, _HVEC
    if _H_GEN is None:
        _H_GEN = derive_H()
    if _GVEC is None:
        _GVEC = [derive_Gvec(i) for i in range(MAX_NM)]
    if _HVEC is None:
        _HVEC = [derive_Hvec(i) for i in range(MAX_NM)]


class Transcript:
    def __init__(self, domain_label):
        self.buf = bytearray()
        self.append(b"domain", domain_label)

    def append(self, label, data):
        if isinstance(label, str):
            label = label.encode()
        if isinstance(data, str):
            data = data.encode()
        self.buf.extend(len(label).to_bytes(4, "little"))
        self.buf.extend(label)
        self.buf.extend(len(data).to_bytes(4, "little"))
        self.buf.extend(data)

    def challenge(self, label):
        if isinstance(label, str):
            label = label.encode()
        self.buf.extend(len(label).to_bytes(4, "little"))
        self.buf.extend(label)
        h = hashlib.sha256(bytes(self.buf)).digest()
        self.buf.extend((32).to_bytes(4, "little"))
        self.buf.extend(h)
        c = int.from_bytes(h, "big") % SECP_N
        if c == 0:
            raise RuntimeError("transcript challenge produced zero scalar")
        return c


def sc_add(a, b):
    return (a + b) % SECP_N


def sc_sub(a, b):
    return (a - b) % SECP_N


def sc_mul(a, b):
    return (a * b) % SECP_N


def sc_inv(a):
    if a % SECP_N == 0:
        raise ValueError("inv of zero scalar")
    return pow(a % SECP_N, -1, SECP_N)


def vector_powers(x, n):
    out = [1]
    if n == 1:
        return out
    out.append(x % SECP_N)
    for _ in range(2, n):
        out.append((out[-1] * x) % SECP_N)
    return out


def weighted_inner_product(a, b, y):
    assert len(a) == len(b)
    res = 0
    yp = 1
    for i in range(len(a)):
        yp = (yp * y) % SECP_N
        res = (res + a[i] * b[i] * yp) % SECP_N
    return res


def vector_sub_scalar(a, s):
    return [(x - s) % SECP_N for x in a]


def vector_add_scalar(a, s):
    return [(x + s) % SECP_N for x in a]


def vector_add(a, b):
    return [(x + y) % SECP_N for x, y in zip(a, b)]


def msm(scalars, points):
    acc = None
    for s, P in zip(scalars, points):
        s = s % SECP_N
        if s == 0 or P is None:
            continue
        acc = point_add(acc, point_mul(s, P))
    return acc


def vector_exponent(a, b):
    assert len(a) == len(b)
    pts = list(_GVEC[: len(a)]) + list(_HVEC[: len(b)])
    scals = list(a) + list(b)
    return msm(scals, pts)


class RngBuf:
    def __init__(self, b):
        self.b = b
        self.off = 0

    def take_scalar(self):
        if self.off + 32 > len(self.b):
            raise RuntimeError("rng_bytes exhausted")
        chunk = self.b[self.off : self.off + 32]
        self.off += 32
        s = int.from_bytes(chunk, "big")
        if s == 0 or s >= SECP_N:
            raise RuntimeError(
                f"rng scalar invalid (zero or >=N) at offset {self.off-32}"
            )
        return s


def bpp_range_prove(values, blindings, rng_bytes):
    _init_generators()
    assert len(values) == len(blindings)
    assert len(values) in (1, 2, 4, 8)
    for v in values:
        assert 0 <= v < (1 << 64), f"value out of range: {v}"
    for g in blindings:
        assert 1 <= g < SECP_N

    N = 64
    M = len(values)
    logN = 6
    logM = M.bit_length() - 1
    logMN = logM + logN
    MN = M * N

    rng = RngBuf(rng_bytes)

    V_points = []
    for v, gamma in zip(values, blindings):
        V_points.append(point_add(point_mul(v, _H_GEN), point_mul(gamma, G_POINT)))
    V_bytes = [point_compressed(V) for V in V_points]

    aL = [0] * MN
    aR = [0] * MN
    for j in range(M):
        v = values[j]
        for i in range(N):
            bit = (v >> i) & 1
            aL[j * N + i] = bit
            aR[j * N + i] = (bit - 1) % SECP_N

    tr = Transcript(b"tacit-bpp-v1")
    tr.append(b"M", bytes([M]))
    for vb in V_bytes:
        tr.append(b"V", vb)

    alpha = rng.take_scalar()
    A_point = point_add(vector_exponent(aL, aR), point_mul(alpha, G_POINT))
    A_bytes = point_compressed(A_point)
    tr.append(b"A", A_bytes)

    y = tr.challenge(b"y")
    z = tr.challenge(b"z")
    z_sq = sc_mul(z, z)

    d = [0] * MN
    d[0] = z_sq
    for i in range(1, N):
        d[i] = sc_mul(d[i - 1], 2)
    for j in range(1, M):
        for i in range(N):
            d[j * N + i] = sc_mul(d[(j - 1) * N + i], z_sq)

    y_powers = vector_powers(y, MN + 2)

    aL1 = vector_sub_scalar(aL, z)
    aR1 = vector_add_scalar(aR, z)
    d_y = [sc_mul(d[i], y_powers[MN - i]) for i in range(MN)]
    aR1 = vector_add(aR1, d_y)

    alpha1 = alpha
    z_pow = 1
    yMN1 = y_powers[MN + 1]
    for j in range(M):
        z_pow = sc_mul(z_pow, z_sq)
        coeff = sc_mul(yMN1, z_pow)
        alpha1 = sc_add(alpha1, sc_mul(coeff, blindings[j]))

    nprime = MN
    Gprime = list(_GVEC[:MN])
    Hprime = list(_HVEC[:MN])
    aprime = list(aL1)
    bprime = list(aR1)

    yinv = sc_inv(y)
    yinvpow = [1] * MN
    for i in range(1, MN):
        yinvpow[i] = sc_mul(yinvpow[i - 1], yinv)

    L_bytes_list = []
    R_bytes_list = []
    while nprime > 1:
        nprime //= 2

        a_lo = aprime[:nprime]
        a_hi = aprime[nprime:]
        b_lo = bprime[:nprime]
        b_hi = bprime[nprime:]
        cL = weighted_inner_product(a_lo, b_hi, y)
        ynp = y_powers[nprime]
        cR = weighted_inner_product(
            [sc_mul(x, ynp) for x in a_hi], b_lo, y
        )

        dL = rng.take_scalar()
        dR = rng.take_scalar()

        yinvnp = yinvpow[nprime]

        L_scals = [sc_mul(a_lo[i], yinvnp) for i in range(nprime)] + [
            b_hi[i] for i in range(nprime)
        ]
        L_pts_in = list(Gprime[nprime : 2 * nprime]) + list(Hprime[:nprime])
        L_point = msm(L_scals, L_pts_in)
        L_point = point_add(L_point, point_mul(cL, _H_GEN))
        L_point = point_add(L_point, point_mul(dL, G_POINT))

        R_scals = [sc_mul(a_hi[i], ynp) for i in range(nprime)] + [
            b_lo[i] for i in range(nprime)
        ]
        R_pts_in = list(Gprime[:nprime]) + list(Hprime[nprime : 2 * nprime])
        R_point = msm(R_scals, R_pts_in)
        R_point = point_add(R_point, point_mul(cR, _H_GEN))
        R_point = point_add(R_point, point_mul(dR, G_POINT))

        Lb = point_compressed(L_point)
        Rb = point_compressed(R_point)
        L_bytes_list.append(Lb)
        R_bytes_list.append(Rb)
        tr.append(b"L", Lb)
        tr.append(b"R", Rb)

        u = tr.challenge(b"u")
        u_inv = sc_inv(u)

        u_y_inv_np = sc_mul(u, yinvnp)
        new_G = []
        for i in range(nprime):
            new_G.append(
                point_add(
                    point_mul(u_inv, Gprime[i]),
                    point_mul(u_y_inv_np, Gprime[nprime + i]),
                )
            )
        Gprime = new_G

        new_H = []
        for i in range(nprime):
            new_H.append(
                point_add(
                    point_mul(u, Hprime[i]),
                    point_mul(u_inv, Hprime[nprime + i]),
                )
            )
        Hprime = new_H

        u_inv_ynp = sc_mul(u_inv, ynp)
        new_a = []
        for i in range(nprime):
            new_a.append(sc_add(sc_mul(u, a_lo[i]), sc_mul(u_inv_ynp, a_hi[i])))
        aprime = new_a

        new_b = []
        for i in range(nprime):
            new_b.append(sc_add(sc_mul(u_inv, b_lo[i]), sc_mul(u, b_hi[i])))
        bprime = new_b

        u_sq = sc_mul(u, u)
        u_inv_sq = sc_mul(u_inv, u_inv)
        alpha1 = sc_add(alpha1, sc_mul(dL, u_sq))
        alpha1 = sc_add(alpha1, sc_mul(dR, u_inv_sq))

    r_ = rng.take_scalar()
    s_ = rng.take_scalar()
    d_ = rng.take_scalar()
    eta = rng.take_scalar()

    A1_point = point_add(point_mul(r_, Gprime[0]), point_mul(s_, Hprime[0]))
    A1_point = point_add(A1_point, point_mul(d_, G_POINT))
    rybp = sc_mul(sc_mul(r_, y), bprime[0])
    syap = sc_mul(sc_mul(s_, y), aprime[0])
    A1_point = point_add(A1_point, point_mul(sc_add(rybp, syap), _H_GEN))
    A1_bytes = point_compressed(A1_point)

    rys = sc_mul(sc_mul(r_, y), s_)
    B_point = point_add(point_mul(eta, G_POINT), point_mul(rys, _H_GEN))
    B_bytes = point_compressed(B_point)

    tr.append(b"A1", A1_bytes)
    tr.append(b"B", B_bytes)
    e = tr.challenge(b"e")
    e_sq = sc_mul(e, e)

    r1 = sc_add(sc_mul(aprime[0], e), r_)
    s1 = sc_add(sc_mul(bprime[0], e), s_)
    d1 = sc_add(sc_mul(d_, e), eta)
    d1 = sc_add(d1, sc_mul(alpha1, e_sq))

    out = bytearray()
    out.extend(A_bytes)
    out.extend(A1_bytes)
    out.extend(B_bytes)
    out.extend(r1.to_bytes(32, "big"))
    out.extend(s1.to_bytes(32, "big"))
    out.extend(d1.to_bytes(32, "big"))
    for Lb, Rb in zip(L_bytes_list, R_bytes_list):
        out.extend(Lb)
        out.extend(Rb)

    return bytes(out), V_bytes


def _expected_len(logMN):
    return 99 + 96 + logMN * 66


def bpp_range_verify(commitments, proof_bytes):
    _init_generators()
    try:
        m = len(commitments)
        if m not in (1, 2, 4, 8):
            return False
        N = 64
        logN = 6
        logM = m.bit_length() - 1
        logMN = logM + logN
        MN = m * N

        if len(proof_bytes) != _expected_len(logMN):
            return False

        off = [0]

        def take(n):
            v = proof_bytes[off[0] : off[0] + n]
            off[0] += n
            return v

        A_bytes = take(33)
        A1_bytes = take(33)
        B_bytes = take(33)
        r1 = int.from_bytes(take(32), "big")
        s1 = int.from_bytes(take(32), "big")
        d1 = int.from_bytes(take(32), "big")
        if not (0 <= r1 < SECP_N and 0 <= s1 < SECP_N and 0 <= d1 < SECP_N):
            return False

        L_bytes_list = []
        R_bytes_list = []
        for _ in range(logMN):
            L_bytes_list.append(take(33))
            R_bytes_list.append(take(33))

        A_point = point_from_compressed(A_bytes)
        A1_point = point_from_compressed(A1_bytes)
        B_point = point_from_compressed(B_bytes)
        L_pts = [point_from_compressed(b) for b in L_bytes_list]
        R_pts = [point_from_compressed(b) for b in R_bytes_list]
        V_pts = [point_from_compressed(b) for b in commitments]

        tr = Transcript(b"tacit-bpp-v1")
        tr.append(b"M", bytes([m]))
        for vb in commitments:
            tr.append(b"V", vb)
        tr.append(b"A", A_bytes)
        y = tr.challenge(b"y")
        z = tr.challenge(b"z")
        challenges = []
        for Lb, Rb in zip(L_bytes_list, R_bytes_list):
            tr.append(b"L", Lb)
            tr.append(b"R", Rb)
            challenges.append(tr.challenge(b"u"))
        tr.append(b"A1", A1_bytes)
        tr.append(b"B", B_bytes)
        e = tr.challenge(b"e")

        z_sq = sc_mul(z, z)
        e_sq = sc_mul(e, e)
        yinv = sc_inv(y)
        y_MN = pow(y, MN, SECP_N)
        y_MN_1 = sc_mul(y_MN, y)

        d = [0] * MN
        d[0] = z_sq
        for i in range(1, N):
            d[i] = sc_add(d[i - 1], d[i - 1])
        for j in range(1, m):
            for i in range(N):
                d[j * N + i] = sc_mul(d[(j - 1) * N + i], z_sq)

        sum_y = 0
        yp = 1
        for _ in range(MN):
            yp = sc_mul(yp, y)
            sum_y = sc_add(sum_y, yp)

        def sum_even_powers(x, n):
            x_sq = sc_mul(x, x)
            s = x_sq
            cur = x_sq
            while n > 2:
                s = sc_add(sc_mul(cur, s), s)
                cur = sc_mul(cur, cur)
                n //= 2
            return s

        TWO64_MINUS_ONE = (1 << 64) - 1
        sum_d = sc_mul(TWO64_MINUS_ONE % SECP_N, sum_even_powers(z, 2 * m))

        weight = 1

        msm_points = []
        msm_scals = []

        def add_term(s, P):
            s = s % SECP_N
            if s == 0 or P is None:
                return
            msm_scals.append(s)
            msm_points.append(P)

        base = sc_mul(SECP_N - e_sq, y_MN_1)
        base = sc_mul(base, weight)
        for j in range(m):
            base = sc_mul(base, z_sq)
            add_term(base, V_pts[j])

        add_term(SECP_N - weight, B_point)
        add_term(sc_mul(SECP_N - weight, e), A1_point)
        add_term(sc_mul(SECP_N - weight, e_sq), A_point)

        G_scalar = sc_mul(weight, d1)

        inner = sc_mul(sc_sub(z_sq, z), sum_y)
        t2 = sc_mul(sc_mul(y_MN_1, z), sum_d)
        inner = sc_add(inner, t2)
        inner = sc_mul(inner, e_sq)
        rys = sc_mul(sc_mul(r1, y), s1)
        inner = sc_add(inner, rys)
        H_scalar = sc_mul(weight, inner)

        rounds = logMN
        challenges_inv = [sc_inv(c) for c in challenges]
        cache_size = 1 << rounds
        cache = [0] * cache_size
        cache[0] = challenges_inv[0]
        cache[1] = challenges[0]
        # Iterate every slot s in [0, slots) descending. For each s, set
        # cache[s] = cache[s >> 1] * (challenges[j] if s odd else challenges_inv[j]).
        # Original transcribed loop iterated s in [1, slots] which writes
        # past the cache (OOB) and double-writes each slot. The correct
        # Monero-equivalent iteration is stride-1 over [0, slots) with
        # parity dispatch.
        for j in range(1, rounds):
            slots = 1 << (j + 1)
            for s in range(slots - 1, -1, -1):
                if s & 1:
                    cache[s] = sc_mul(cache[s >> 1], challenges[j])
                else:
                    cache[s] = sc_mul(cache[s >> 1], challenges_inv[j])

        e_r1_w_y = sc_mul(sc_mul(e, r1), weight)
        e_s1_w = sc_mul(sc_mul(e, s1), weight)
        e_squared_z_w = sc_mul(sc_mul(e_sq, z), weight)
        minus_e_squared_z_w = (SECP_N - e_squared_z_w) % SECP_N
        minus_e_squared_w_y = sc_mul(sc_mul(SECP_N - e_sq, weight), y_MN)

        Gi_scalars = [0] * MN
        Hi_scalars = [0] * MN
        for i in range(MN):
            g_scalar = sc_add(sc_mul(e_r1_w_y, cache[i]), e_squared_z_w)
            j_idx = (~i) & (MN - 1)
            h_scalar = sc_add(sc_mul(e_s1_w, cache[j_idx]), minus_e_squared_z_w)
            h_scalar = sc_add(h_scalar, sc_mul(minus_e_squared_w_y, d[i]))
            Gi_scalars[i] = sc_add(Gi_scalars[i], g_scalar)
            Hi_scalars[i] = sc_add(Hi_scalars[i], h_scalar)

            e_r1_w_y = sc_mul(e_r1_w_y, yinv)
            minus_e_squared_w_y = sc_mul(minus_e_squared_w_y, yinv)

        neg_weight_e_sq = sc_mul(SECP_N - weight, e_sq)
        for j in range(rounds):
            chal_sq = sc_mul(challenges[j], challenges[j])
            add_term(sc_mul(chal_sq, neg_weight_e_sq), L_pts[j])
            chal_inv_sq = sc_mul(challenges_inv[j], challenges_inv[j])
            add_term(sc_mul(chal_inv_sq, neg_weight_e_sq), R_pts[j])

        add_term(G_scalar, G_POINT)
        add_term(H_scalar, _H_GEN)
        for i in range(MN):
            add_term(Gi_scalars[i], _GVEC[i])
            add_term(Hi_scalars[i], _HVEC[i])

        result = msm(msm_scals, msm_points)
        return result is None or point_to_affine(result) is None
    except Exception:
        return False


def _format_kat():
    _init_generators()
    H_hex = point_compressed(_H_GEN).hex()
    G0_hex = point_compressed(_GVEC[0]).hex()
    H0_hex = point_compressed(_HVEC[0]).hex()
    lines = []
    lines.append(f"H         = {H_hex}")
    lines.append(f"Gvec[0]   = {G0_hex}")
    lines.append(f"Hvec[0]   = {H0_hex}")
    return "\n".join(lines)


def _roundtrip_test(m, values, blindings, rng):
    proof, V_bytes = bpp_range_prove(values, blindings, rng)
    ok = bpp_range_verify(V_bytes, proof)
    assert ok, f"verify failed for m={m}"
    return len(proof)


if __name__ == "__main__":
    print("=== generator KAT ===")
    print(_format_kat())
    print()
    print("=== round-trip ===")
    # 64 * 32 = 2048 bytes of pseudo-random RNG, plenty for m=8 prover needs
    # (1 alpha + 18 round randoms + 4 final = 23 × 32 = 736 bytes at m=8).
    # Use sha256-extending to avoid degenerate constant scalars.
    rng_full = b"".join(hashlib.sha256(b"bpp-test-rng-v1" + i.to_bytes(2, "big")).digest() for i in range(64))
    cases = [
        (1, [12345], [1]),
        (2, [100, 200], [2, 3]),
        (4, [1, 2, 4, 8], [4, 5, 6, 7]),
        (8,
         [0, 1, 2**32, 2**63, 2**64 - 1, 42, 1337, 999999999],
         [8, 9, 10, 11, 12, 13, 14, 15]),
    ]
    for m, vals, gammas in cases:
        proof, V_bytes = bpp_range_prove(vals, gammas, rng_full)
        ok = bpp_range_verify(V_bytes, proof)
        assert ok, f"verify failed for m={m}"
        print(f"m={m}: prove -> verify OK, proof len={len(proof)}")
        print(f"  V_hex = {','.join(v.hex() for v in V_bytes)}")
        print(f"  proof_hex = {proof.hex()}")
