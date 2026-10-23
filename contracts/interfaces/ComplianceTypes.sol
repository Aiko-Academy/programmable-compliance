// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.28;

/// @title ComplianceTypes
/// @notice The structures from the GL1 whitepaper as they travel on chain.
///
///         `CheckResult` and `AttestationItem` are the form that deployed policies decode from the
///         context (`abi.encode(AttestationItem[])`): a check result signed by an institution
///         (kind 0, P-256 key in the ComplianceKeyRegistry) or by an endorsed TEE key (kind 1). The
///         field names are those of the deployed policies; changing them would change the encoding.
///
///         `TransactionEnvelope` and `PartyPacket` (figure 2 of the whitepaper) are what the SDK builds off
///         chain; on chain only the digest (`envelopeHash`) and the identifier (`uetr`) are passed.
library ComplianceTypes {
    /// @notice The result of a check, signed: it is the signed half of an `AttestationItem`.
    struct CheckResult {
        bytes16 uetr;
        string checkCode;
        bool verdict;
        bytes32 canonicalDataHash;
        bytes32 policyRef;
        uint256 timestamp;
    }

    /// @notice An element of a Compliance Attestation: a result, its signer, its P-256 signature.
    struct AttestationItem {
        uint8 kind; // 0: institution signature; 1: endorsed TEE key
        bytes32 orgId;
        CheckResult sig;
        bytes32 r;
        bytes32 s;
        bytes32 qx;
        bytes32 qy;
    }

    /// @notice An actor in the transaction, reduced to its identifiers at construction.
    struct PartyPacket {
        bytes32 role; // keccak256("originator"), keccak256("beneficiary"), keccak256("liquidator")...
        address wallet;
        bytes2 jurisdiction; // ISO 3166-1 alpha-2
        bytes32 ccid; // the identity resolved by the Identity Manager, zero before enrichment
        bytes32 dataHash; // digest of the off-ledger data (Travel Rule), zero if none
    }

    /// @notice The structured record that travels with the transaction.
    struct TransactionEnvelope {
        bytes16 uetr;
        address asset;
        uint256 amount;
        uint64 datetime;
        bytes32 mediationPattern; // keccak256("Entity-to-Entity")...
        PartyPacket[] parties;
    }

    uint8 internal constant KIND_INSTITUTION = 0;
    uint8 internal constant KIND_TEE = 1;

    /// @notice The digest of an envelope: what an evidencing record designates.
    function hashEnvelope(TransactionEnvelope memory e) internal pure returns (bytes32) {
        return keccak256(abi.encode(e.uetr, e.asset, e.amount, e.datetime, e.mediationPattern, e.parties));
    }
}
