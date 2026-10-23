// SPDX-License-Identifier: AGPL-3.0
// Provenance: src/common/identity/CredentialRegistry.sol (onchain-fx-markets, originally MIT), taken as is; only the contract name and the import paths change.
// Distributed here under AGPL-3.0. The code deployed on Hoodi is this one, byte for byte apart from metadata.
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {VLEICredentialDataValidator} from "./VLEICredentialDataValidator.sol";

/**
 * @title CredentialRegistry
 * @notice Programmable Compliance pack, CCID → credential store, ported (in spirit) from demo-compliance's
 *         cross-chain-identity `CredentialRegistry`. Holds KYB/vLEI credentials per **Customer/LEI CCID**
 *         (see IdentityRegistry), with expiry, and validates the credential DATA via a pluggable
 *         per-type data validator (the vLEI validator for KYB). This backs the **RFI** check with a real
 *         on-chain credential instead of a bare signature.
 *
 *         Self-contained (Ownable issuer, no PolicyEngine coupling). `isValid` = registered + not-expired;
 *         `validate` = `isValid` AND the stored data passes the type's validator.
 */
contract CredentialRegistry is Ownable {
    struct Credential {
        uint40 expiresAt; // 0 = never expires
        bool exists;
        bytes data;
    }

    mapping(bytes32 => mapping(bytes32 => Credential)) private _credentials; // ccid => typeId => credential
    mapping(bytes32 => address) public dataValidator; // typeId => validator

    event CredentialRegistered(bytes32 indexed ccid, bytes32 indexed credentialTypeId, uint40 expiresAt);
    event CredentialRemoved(bytes32 indexed ccid, bytes32 indexed credentialTypeId);
    event CredentialRenewed(bytes32 indexed ccid, bytes32 indexed credentialTypeId, uint40 expiresAt);
    event DataValidatorSet(bytes32 indexed credentialTypeId, address validator);

    error InvalidExpiration();
    error CredentialNotFound(bytes32 ccid, bytes32 credentialTypeId);

    constructor(address initialOwner) Ownable(initialOwner) {}

    /// @notice Set the data validator for a credential type (e.g. KYB → VLEICredentialDataValidator).
    function setDataValidator(bytes32 credentialTypeId, address validator) external onlyOwner {
        dataValidator[credentialTypeId] = validator;
        emit DataValidatorSet(credentialTypeId, validator);
    }

    // `payload`, not `credentialData`: the latter is also the getter below, and solc warns (8760) on the
    // collision. Parameter names are compile-time only, so this is a rename with no bytecode or ABI effect.
    function registerCredential(bytes32 ccid, bytes32 credentialTypeId, uint40 expiresAt, bytes calldata payload)
        external
        onlyOwner
    {
        if (expiresAt > 0 && expiresAt <= block.timestamp) revert InvalidExpiration();
        _credentials[ccid][credentialTypeId] = Credential({expiresAt: expiresAt, exists: true, data: payload});
        emit CredentialRegistered(ccid, credentialTypeId, expiresAt);
    }

    function renewCredential(bytes32 ccid, bytes32 credentialTypeId, uint40 expiresAt) external onlyOwner {
        if (expiresAt > 0 && expiresAt <= block.timestamp) revert InvalidExpiration();
        Credential storage c = _credentials[ccid][credentialTypeId];
        if (!c.exists) revert CredentialNotFound(ccid, credentialTypeId);
        c.expiresAt = expiresAt;
        emit CredentialRenewed(ccid, credentialTypeId, expiresAt);
    }

    function removeCredential(bytes32 ccid, bytes32 credentialTypeId) external onlyOwner {
        if (!_credentials[ccid][credentialTypeId].exists) revert CredentialNotFound(ccid, credentialTypeId);
        delete _credentials[ccid][credentialTypeId];
        emit CredentialRemoved(ccid, credentialTypeId);
    }

    function credentialData(bytes32 ccid, bytes32 credentialTypeId) external view returns (bytes memory) {
        return _credentials[ccid][credentialTypeId].data;
    }

    /// @notice Registered + not expired.
    function isValid(bytes32 ccid, bytes32 credentialTypeId) public view returns (bool) {
        Credential storage c = _credentials[ccid][credentialTypeId];
        if (!c.exists) return false;
        if (c.expiresAt != 0 && c.expiresAt <= block.timestamp) return false;
        return true;
    }

    /// @notice `isValid` AND the stored credential data passes the type's data validator (if set).
    function validate(bytes32 ccid, bytes32 credentialTypeId) external view returns (bool) {
        if (!isValid(ccid, credentialTypeId)) return false;
        address v = dataValidator[credentialTypeId];
        if (v == address(0)) return true; // no data validator configured → existence/expiry only
        return VLEICredentialDataValidator(v)
            .validateCredentialData(credentialTypeId, _credentials[ccid][credentialTypeId].data);
    }
}
