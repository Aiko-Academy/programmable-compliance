// SPDX-License-Identifier: AGPL-3.0
// Provenance: src/common/compliance/TeeTrustRegistry.sol (onchain-fx-markets, originally MIT), taken as is; only the contract name and the import paths change.
// Distributed here under AGPL-3.0. The code deployed on Hoodi is this one, byte for byte apart from metadata.
pragma solidity ^0.8.28;

import {P256} from "@openzeppelin/contracts/utils/cryptography/P256.sol";
import {ComplianceKeyRegistry} from "./ComplianceKeyRegistry.sol";

/**
 * @title TeeTrustRegistry
 * @notice Step 4 (TEE / SAN01-02): on-chain verification of a TEE attestation by a QUORUM of verifiers
 *         (the deck's chosen path, cert-chain verification on-chain is infeasible). A set of trusted
 *         organizations verify the full attestation (cert chain, image/TCB/policy allowlist) OFF-chain
 *         and co-sign their "ok" (EIP-712 / secp256r1, reusing ComplianceKeyRegistry). When the quorum
 *         is met (e.g. 5-of-8), the TEE-generated public key hash is marked TRUSTED, and SAN proofs
 *         later signed from inside that TEE verify against it (via InstitutionSignatureVerifier).
 *
 *         Reusable for any check whose proof a quorum endorses. domainOverride pins verifyingContract
 *         for reproducible off-chain vectors (0 => address(this)).
 */
contract TeeTrustRegistry {
    ComplianceKeyRegistry public immutable registry;
    uint256 public immutable minQuorum;
    address private immutable _domainOverride;

    mapping(bytes32 => bool) public isTrusted; // teeKeyHash => trusted

    bytes32 private constant _DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant _NAME_HASH = keccak256("TeeQuorum");
    bytes32 private constant _VERSION_HASH = keccak256("1");
    bytes32 private constant _TEE_TYPEHASH =
        keccak256("TeeAttestation(bytes32 teeKeyHash,bytes32 reportHash,uint256 timestamp)");

    struct Endorsement {
        bytes32 orgId;
        bytes32 r;
        bytes32 s;
        bytes32 qx;
        bytes32 qy;
    }

    event TeeKeyTrusted(bytes32 indexed teeKeyHash, uint256 quorum);

    error QuorumNotMet(uint256 valid, uint256 required);

    constructor(ComplianceKeyRegistry registry_, uint256 minQuorum_, address domainOverride) {
        registry = registry_;
        minQuorum = minQuorum_;
        _domainOverride = domainOverride;
    }

    function _verifyingContract() internal view returns (address) {
        return _domainOverride == address(0) ? address(this) : _domainOverride;
    }

    function digest(bytes32 teeKeyHash, bytes32 reportHash, uint256 timestamp) public view returns (bytes32) {
        bytes32 ds =
            keccak256(abi.encode(_DOMAIN_TYPEHASH, _NAME_HASH, _VERSION_HASH, block.chainid, _verifyingContract()));
        bytes32 structHash = keccak256(abi.encode(_TEE_TYPEHASH, teeKeyHash, reportHash, timestamp));
        return keccak256(abi.encodePacked(hex"1901", ds, structHash));
    }

    /// @notice Submit the quorum's endorsements; if >= minQuorum distinct validator keys verify, trust the TEE key.
    function submitQuorum(
        bytes32 teeKeyHash,
        bytes32 reportHash,
        uint256 timestamp,
        Endorsement[] calldata endorsements
    ) external returns (uint256 valid) {
        bytes32 d = digest(teeKeyHash, reportHash, timestamp);
        for (uint256 i = 0; i < endorsements.length; i++) {
            Endorsement calldata e = endorsements[i];
            // de-dupe by orgId (a validator can't be counted twice)
            bool dup = false;
            for (uint256 j = 0; j < i; j++) {
                if (endorsements[j].orgId == e.orgId) {
                    dup = true;
                    break;
                }
            }
            if (dup) continue;
            if (registry.isActiveKey(e.orgId, e.qx, e.qy) && P256.verify(d, e.r, e.s, e.qx, e.qy)) valid++;
        }
        if (valid < minQuorum) revert QuorumNotMet(valid, minQuorum);
        isTrusted[teeKeyHash] = true;
        emit TeeKeyTrusted(teeKeyHash, valid);
    }
}
