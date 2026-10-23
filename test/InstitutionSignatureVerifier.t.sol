// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.28;

// forge-std-free (this repo vendors no forge-std). `forge test --match-contract InstitutionSignature`
// runs test_* and reverts on mismatch. Default chainId 31337 matches the off-chain vector below.
//
// Reference vector: a P-256 EIP-712 signature over a PC01 proof under the pack's own domain
// ("InstitutionSig" v1), produced by the SDK InstitutionSigner with a deterministic TEST key (RFC6979,
// lowS) and noble-verified off-chain. Domain pinned via domainOverride = 0x…C0DE so the on-chain digest
// equals the off-chain one regardless of the deployed address.
import {ComplianceKeyRegistry} from "../contracts/verifiers/ComplianceKeyRegistry.sol";
import {InstitutionSignatureVerifier} from "../contracts/verifiers/InstitutionSignatureVerifier.sol";

contract InstitutionSignatureVerifierTest {
    ComplianceKeyRegistry registry;
    InstitutionSignatureVerifier verifier;

    bytes32 constant ORG_ID = 0x77ced2f91ef6b97e1cec7b5a29bc624ceb453b47586ecb0fed13dfcac2dbd4ea;
    address constant VERIFIER_OVR = 0x000000000000000000000000000000000000c0DE;
    bytes16 constant UETR = 0x11223344556677889900aabbccddeeff;
    bytes32 constant CANON_HASH = 0x338328a1fdcb30cdd97ce1e2e98878872c37bbdb2d9a1a7e0edbb2b266ef626f;
    bytes32 constant POLICY_REF = 0x24d36e6f3fd20a1e8de6730a7a6e68b9a7c3874eb7a326986d9fd1cf28aaaf6b;
    uint256 constant TS = 1750000000;
    bytes32 constant R = 0x52913e03d93ba0715767f2f7db4656151842a8174473330c86cba66b3d134918;
    bytes32 constant S = 0x080ba71cbab9ba9b2023245d2a878a457307567679d29df4633e5df9b29cd591;
    bytes32 constant QX = 0x7cf27b188d034f7e8a52380304b51ac3c08969e277f21b35a60b48fc47669978;
    bytes32 constant QY = 0x07775510db8ed040293d9ac69f7430dbba7dade63ce982299e04b79d227873d1;
    bytes32 constant DIGEST = 0x2ce380016d25a447851329a24de64a8bf5c2d88b81b9322bb517757f1051196e;

    function setUp() public {
        registry = new ComplianceKeyRegistry(address(this));
        verifier = new InstitutionSignatureVerifier(registry, VERIFIER_OVR);
        registry.registerKey(ORG_ID, QX, QY);
    }

    function _sig() internal pure returns (InstitutionSignatureVerifier.Sig memory) {
        return InstitutionSignatureVerifier.Sig({
            uetr: UETR,
            checkCode: "PC01",
            verdict: true,
            canonicalDataHash: CANON_HASH,
            policyRef: POLICY_REF,
            timestamp: TS
        });
    }

    // The on-chain EIP-712 digest must equal the digest the node signed.
    function test_DigestMatchesNode() public view {
        require(verifier.digest(_sig()) == DIGEST, "digest mismatch (EIP-712 encoding differs from node)");
    }

    // A valid node signature over an active key verifies.
    function test_VerifyValid() public view {
        require(verifier.verify(ORG_ID, _sig(), R, S, QX, QY), "valid institution signature rejected");
    }

    // Revoked key → verification fails (rotation/revocation enforced).
    function test_RejectsRevokedKey() public {
        registry.revokeKey(ORG_ID, QX, QY);
        require(!verifier.verify(ORG_ID, _sig(), R, S, QX, QY), "revoked key still verifies");
    }

    // Unknown org (no registered key) → fails before touching P256.
    function test_RejectsUnknownOrg() public view {
        require(!verifier.verify(bytes32(uint256(0xdead)), _sig(), R, S, QX, QY), "unknown org verified");
    }

    // Tampered verdict → different digest → P256 rejects.
    function test_RejectsTamperedPayload() public view {
        InstitutionSignatureVerifier.Sig memory s = _sig();
        s.verdict = false;
        require(!verifier.verify(ORG_ID, s, R, S, QX, QY), "tampered payload verified");
    }
}
