// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title Secp256k1
/// @notice On-chain secp256k1 primitives for confidential-token verification.
///         Pedersen commitments and proofs live on Bitcoin's curve, so the EVM
///         needs to verify secp relations natively. Two mechanisms:
///
///         1. `mulmuladd` — the `ecrecover` precompile coerced into computing
///            `address(a·G + b·P)` for ~3k gas. Verifying a linear relation
///            (Schnorr signature, OR-proof branch, kernel) reduces to one such
///            call plus an address compare, the cheap path.
///         2. `ecAdd` — explicit affine point addition (modexp-backed inverse),
///            for summing commitment points where no precompile exists. Bounded,
///            a handful per transfer.
///
///         Address comparison (160-bit) is the standard soundness basis for
///         ecrecover-style secp verifiers: the proof's commitments are bound
///         into the Fiat-Shamir challenge, so an attacker cannot grind an
///         address collision without also satisfying the challenged equations.
library Secp256k1 {
    uint256 internal constant N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
    uint256 internal constant PP = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2F;

    /// @notice address(a·G + b·P), P given by (px, pyParity: 0 even / 1 odd).
    ///         ecrecover(h,v,r,s) = address( r⁻¹·(s·R − h·G) ) with R.x = r.
    ///         Set r = px (R = P), s = b·px, h = −a·px ⇒ result = a·G + b·P.
    ///         a and b must be non-zero mod N (zero ⇒ identity term, unused on
    ///         the proof paths here; callers pass proof responses/challenges).
    function mulmuladd(uint256 px, uint8 pyParity, uint256 a, uint256 b) internal pure returns (address) {
        uint256 s = mulmod(b, px, N);
        uint256 m = mulmod(a, px, N);
        uint256 h = m == 0 ? 0 : N - m;
        return ecrecover(bytes32(h), 27 + pyParity, bytes32(px), bytes32(s));
    }

    /// @notice address of an affine point.
    function addrOf(uint256 x, uint256 y) internal pure returns (address) {
        return address(uint160(uint256(keccak256(abi.encodePacked(x, y)))));
    }

    /// @notice Verify a Schnorr-style relation z·G == R + e·P by checking
    ///         address(z·G + (N−e)·P) == rAddr (= address(R)).
    function verifyLinear(uint256 px, uint8 pyParity, uint256 e, uint256 z, address rAddr)
        internal pure returns (bool)
    {
        uint256 ne = e == 0 ? 0 : N - e;
        return mulmuladd(px, pyParity, z, ne) == rAddr;
    }

    /// @notice Affine addition of two non-identity points with distinct
    ///         x-coordinates. Reverts on x1 == x2 (the doubling / inverse cases)
    ///         rather than silently computing a wrong sum from `_inv(0) = 0` —
    ///         callers sum independent commitment points, where equal x is
    ///         negligible for honest inputs and a fail-closed revert otherwise.
    function ecAdd(uint256 x1, uint256 y1, uint256 x2, uint256 y2)
        internal view returns (uint256 x3, uint256 y3)
    {
        require(x1 != x2, "ecAdd: equal x");
        uint256 num = addmod(y2, PP - y1, PP);
        uint256 den = addmod(x2, PP - x1, PP);
        uint256 lam = mulmod(num, _inv(den), PP);
        x3 = addmod(mulmod(lam, lam, PP), PP - addmod(x1, x2, PP), PP);
        y3 = addmod(mulmod(lam, addmod(x1, PP - x3, PP), PP), PP - y1, PP);
    }

    /// @notice Modular inverse mod PP via the modexp precompile (a^(PP−2)).
    function _inv(uint256 a) internal view returns (uint256 r) {
        uint256[6] memory in_;
        in_[0] = 0x20; in_[1] = 0x20; in_[2] = 0x20;
        in_[3] = a; in_[4] = PP - 2; in_[5] = PP;
        bool ok;
        assembly {
            ok := staticcall(gas(), 0x05, in_, 0xc0, in_, 0x20)
            r := mload(in_)
        }
        require(ok, "modexp");
    }
}
