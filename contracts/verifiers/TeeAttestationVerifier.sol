// SPDX-License-Identifier: AGPL-3.0
// Provenance: src/common/compliance/TeeAttestationVerifier.sol (onchain-fx-markets, originally MIT), taken as is; only the contract name and the import paths change.
// Distributed here under AGPL-3.0. The code deployed on Hoodi is this one, byte for byte apart from metadata.
pragma solidity ^0.8.28;

import {P256} from "@openzeppelin/contracts/utils/cryptography/P256.sol";
import {InstitutionSignatureVerifier} from "./InstitutionSignatureVerifier.sol";
import {TeeTrustRegistry} from "./TeeTrustRegistry.sol";

/**
 * @title TeeAttestationVerifier
 * @notice On-chain verification of a node's SAN01 / SAN02 TEE-attestation proof, faithful to the reference specification.
 *         Per the reference specification (Proof-Generation-and-Verifications v3, §2.8): SAN verification has TWO
 *         parts, (a) the hardware attestation establishes a genuine enclave, and (b) the enclave signature
 *         over the screening exchange. On-chain we mirror the specification's own on-chain strategy (§2.10, which uses
 *         secp256r1/RIP-7212 because Ed25519 has no precompile and SEV-SNP/VCEK cert-chains are infeasible
 *         to verify on-chain):
 *           (a) the enclave's public key hash must be TRUSTED in the TeeTrustRegistry, a quorum of
 *               validators verified the full SEV-SNP attestation (cert chain / TCB / policy) OFF-chain and
 *               co-signed (secp256r1), exactly the specification's attestation-trust model; and
 *           (b) the enclave's secp256r1 EIP-712 signature over the check's InstitutionSignature (checkCode
 *               SAN01/SAN02, verdict, canonicalDataHash = the hash of the enclave's canonical screening
 *               exchange) re-verifies via OZ P256.
 *         It reuses InstitutionSignatureVerifier's exact EIP-712 digest, so a SAN proof is signed +
 *         verified identically to PC01/CFM01, only the trust ANCHOR differs (TeeTrustRegistry vs the
 *         institution key's ComplianceKeyRegistry). teeKeyHash = keccak256(abi.encode(qx, qy)) (the S1
 *         convention endorsed in the registry).
 */
contract TeeAttestationVerifier {
    InstitutionSignatureVerifier public immutable sigVerifier; // shared EIP-712 InstitutionSignature digest
    TeeTrustRegistry public immutable teeTrust; // quorum-endorsed enclave keys (attestation trust)

    constructor(InstitutionSignatureVerifier sigVerifier_, TeeTrustRegistry teeTrust_) {
        sigVerifier = sigVerifier_;
        teeTrust = teeTrust_;
    }

    /// @notice The enclave-key hash the registry endorses for a given (qx, qy).
    function teeKeyHash(bytes32 qx, bytes32 qy) public pure returns (bytes32) {
        return keccak256(abi.encode(qx, qy));
    }

    /**
     * @notice Verify a SAN01/SAN02 TEE-attestation proof: the enclave key (qx,qy) must be quorum-TRUSTED in
     *         the TeeTrustRegistry, and its secp256r1 signature (r,s) must be valid over the shared EIP-712
     *         InstitutionSignature digest of `s` (checkCode = SAN01 / SAN02).
     */
    function verify(InstitutionSignatureVerifier.Sig calldata s, bytes32 r, bytes32 sigS, bytes32 qx, bytes32 qy)
        external
        view
        returns (bool)
    {
        if (!teeTrust.isTrusted(teeKeyHash(qx, qy))) return false;
        return P256.verify(sigVerifier.digest(s), r, sigS, qx, qy);
    }
}
