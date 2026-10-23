// SPDX-License-Identifier: AGPL-3.0
// Provenance: src/common/compliance/InstitutionSignatureVerifier.sol (onchain-fx-markets, originally MIT), taken as is; only the contract name and the import paths change.
// Distributed here under AGPL-3.0. The code deployed on Hoodi is this one, byte for byte apart from metadata.
pragma solidity ^0.8.28;

import {P256} from "@openzeppelin/contracts/utils/cryptography/P256.sol";
import {ComplianceKeyRegistry} from "./ComplianceKeyRegistry.sol";

/**
 * @title InstitutionSignatureVerifier
 * @notice On-chain verification of a node's Institution Signature (PC01 / AML01), per the
 *         on-chain proof-verification deck. The node dual-signs each on-chain-validated check: besides
 *         the off-chain SHA-256/DER signature, it produces a SECOND signature, EIP-712 typed data,
 *         keccak digest, secp256r1, that this contract verifies via OZ `P256` (RIP-7212 precompile on
 *         Fusaka/Hoodi ~6,900 gas, Solidity fallback elsewhere) against the signer's active key in the
 *         ComplianceKeyRegistry. Replaces trust in the single attester EOA for these checks with real
 *         cryptographic verification.
 *
 *         EIP-712 is implemented inline (not OZ EIP712) so the domain `verifyingContract` can be pinned
 *         via `domainOverride` (0 => address(this)), used only to make off-chain test vectors
 *         reproducible; production deploys pass address(0).
 */
contract InstitutionSignatureVerifier {
    ComplianceKeyRegistry public immutable registry;
    address private immutable _domainOverride;

    // EIP-712
    bytes32 private constant _DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant _NAME_HASH = keccak256("InstitutionSig");
    bytes32 private constant _VERSION_HASH = keccak256("1");
    bytes32 private constant _SIG_TYPEHASH = keccak256(
        "InstitutionSignature(bytes16 uetr,string checkCode,bool verdict,bytes32 canonicalDataHash,bytes32 policyRef,uint256 timestamp)"
    );

    constructor(ComplianceKeyRegistry registry_, address domainOverride) {
        registry = registry_;
        _domainOverride = domainOverride;
    }

    function _verifyingContract() internal view returns (address) {
        return _domainOverride == address(0) ? address(this) : _domainOverride;
    }

    function domainSeparator() public view returns (bytes32) {
        return keccak256(abi.encode(_DOMAIN_TYPEHASH, _NAME_HASH, _VERSION_HASH, block.chainid, _verifyingContract()));
    }

    struct Sig {
        bytes16 uetr;
        string checkCode;
        bool verdict;
        bytes32 canonicalDataHash; // keccak256(utf8(node canonicalData(proof)))
        bytes32 policyRef;
        uint256 timestamp;
    }

    /// @notice The EIP-712 digest the node signs (exposed for tooling/tests).
    function digest(Sig calldata s) public view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                _SIG_TYPEHASH,
                s.uetr,
                keccak256(bytes(s.checkCode)),
                s.verdict,
                s.canonicalDataHash,
                s.policyRef,
                s.timestamp
            )
        );
        return keccak256(abi.encodePacked(hex"1901", domainSeparator(), structHash));
    }

    /**
     * @notice Verify a node Institution Signature: the (qx,qy) key must be active for `orgId` in the
     *         registry, and the secp256r1 signature (r,s) must be valid over the EIP-712 digest.
     */
    function verify(bytes32 orgId, Sig calldata s, bytes32 r, bytes32 sigS, bytes32 qx, bytes32 qy)
        external
        view
        returns (bool)
    {
        if (!registry.isActiveKey(orgId, qx, qy)) return false;
        return P256.verify(digest(s), r, sigS, qx, qy);
    }
}
