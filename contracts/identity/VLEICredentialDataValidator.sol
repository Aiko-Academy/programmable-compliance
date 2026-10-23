// SPDX-License-Identifier: AGPL-3.0
// Provenance: src/common/identity/VLEICredentialDataValidator.sol (onchain-fx-markets, originally MIT), taken as is; only the contract name and the import paths change.
// Distributed here under AGPL-3.0. The code deployed on Hoodi is this one, byte for byte apart from metadata.
pragma solidity ^0.8.28;

/**
 * @title VLEICredentialDataValidator
 * @notice Programmable Compliance pack, on-chain validation of a vLEI (GLEIF) credential's data, ported from
 *         demo-compliance (`back/src/VLEICredentialDataValidator.sol`). This is the identity dimension
 *         demo-compliance pioneered (CCID-LEI + vLEI/KYB), inherited here so the RFI check can be backed
 *         by a real on-chain credential rather than a bare signature.
 *
 *         vLEI credential data layout (85 bytes):
 *           [ 0..19]  bytes20 lei            (Legal Entity Identifier, 20 alphanumeric chars)
 *           [20..51]  bytes32 schemaSAID     (ACDC schema SAID)
 *           [52..83]  bytes32 credentialSAID (credential SAID)
 *           [84]      uint8   credType       (0 = OOR, 1 = ECR)
 *
 *         Self-contained (no PolicyEngine/ICredentialDataValidator coupling), consumed by
 *         CredentialRegistry.
 */
contract VLEICredentialDataValidator {
    enum VLEICredentialType {
        OOR,
        ECR
    }

    struct VLEICredentialData {
        bytes20 lei;
        bytes32 schemaSAID;
        bytes32 credentialSAID;
        VLEICredentialType credType;
    }

    /// @notice KYB credential type id: keccak256("common.kyb").
    bytes32 public constant KYB_CREDENTIAL_TYPE = keccak256(abi.encodePacked("common.kyb"));

    /// @notice Validate a vLEI credential blob for the KYB type. Pure; never reverts.
    function validateCredentialData(bytes32 credentialTypeId, bytes calldata credentialData)
        external
        pure
        returns (bool)
    {
        if (credentialTypeId != KYB_CREDENTIAL_TYPE) return false;
        if (credentialData.length < 85) return false;
        VLEICredentialData memory d = _decode(credentialData);
        if (!_isValidLEI(d.lei)) return false;
        if (d.schemaSAID == bytes32(0)) return false;
        if (d.credentialSAID == bytes32(0)) return false;
        return true;
    }

    function decodeVLEIData(bytes calldata credentialData) external pure returns (VLEICredentialData memory) {
        return _decode(credentialData);
    }

    function isValidLEI(bytes20 lei) external pure returns (bool) {
        return _isValidLEI(lei);
    }

    function _decode(bytes calldata data) internal pure returns (VLEICredentialData memory) {
        bytes20 lei = bytes20(data[0:20]);
        bytes32 schemaSAID = bytes32(data[20:52]);
        bytes32 credentialSAID = bytes32(data[52:84]);
        VLEICredentialType credType = uint8(data[84]) == 0 ? VLEICredentialType.OOR : VLEICredentialType.ECR;
        return
            VLEICredentialData({lei: lei, schemaSAID: schemaSAID, credentialSAID: credentialSAID, credType: credType});
    }

    /// @dev LEI format: 20 alphanumeric chars (0-9, A-Z).
    function _isValidLEI(bytes20 lei) internal pure returns (bool) {
        if (lei == bytes20(0)) return false;
        for (uint256 i = 0; i < 20; i++) {
            bytes1 c = lei[i];
            bool isDigit = (c >= 0x30 && c <= 0x39);
            bool isUpper = (c >= 0x41 && c <= 0x5A);
            if (!isDigit && !isUpper) return false;
        }
        return true;
    }
}
