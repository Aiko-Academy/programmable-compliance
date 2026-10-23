// SPDX-License-Identifier: AGPL-3.0
// Provenance: src/common/compliance/ComplianceKeyRegistry.sol (onchain-fx-markets, originally MIT), taken as is; only the contract name and the import paths change.
// Distributed here under AGPL-3.0. The code deployed on Hoodi is this one, byte for byte apart from metadata.
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/**
 * @title ComplianceKeyRegistry
 * @notice On-chain registry of institutional signing keys (secp256r1 / P-256), per the on-chain
 *         proof-verification deck. Maps an organization id to its active public key(s), with rotation
 *         + revocation, the on-chain counterpart of mandala-node's `mandala_peer_keys`
 *         (institutional_public_key_pem), which the InstitutionSignatureVerifier consults.
 *
 *         orgId is an opaque bytes32 (e.g. keccak256(nodeId) or a BIC-derived id). A key is the affine
 *         public point (qx, qy). Multiple keys per org are allowed (overlapping rotation); a key is
 *         active iff registered and not yet revoked.
 */
contract ComplianceKeyRegistry is AccessControl {
    struct Key {
        bytes32 qx;
        bytes32 qy;
        uint64 addedAt;
        uint64 revokedAt; // 0 == active
    }

    mapping(bytes32 => Key[]) private _keys; // orgId => keys (append-only; revocation flips revokedAt)

    event KeyRegistered(bytes32 indexed orgId, bytes32 qx, bytes32 qy);
    event KeyRevoked(bytes32 indexed orgId, bytes32 qx, bytes32 qy);

    error KeyExists();
    error KeyNotFound();

    constructor(address admin) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    function registerKey(bytes32 orgId, bytes32 qx, bytes32 qy) external onlyRole(DEFAULT_ADMIN_ROLE) {
        Key[] storage ks = _keys[orgId];
        for (uint256 i = 0; i < ks.length; i++) {
            if (ks[i].qx == qx && ks[i].qy == qy && ks[i].revokedAt == 0) revert KeyExists();
        }
        ks.push(Key({qx: qx, qy: qy, addedAt: uint64(block.timestamp), revokedAt: 0}));
        emit KeyRegistered(orgId, qx, qy);
    }

    function revokeKey(bytes32 orgId, bytes32 qx, bytes32 qy) external onlyRole(DEFAULT_ADMIN_ROLE) {
        Key[] storage ks = _keys[orgId];
        for (uint256 i = 0; i < ks.length; i++) {
            if (ks[i].qx == qx && ks[i].qy == qy && ks[i].revokedAt == 0) {
                ks[i].revokedAt = uint64(block.timestamp);
                emit KeyRevoked(orgId, qx, qy);
                return;
            }
        }
        revert KeyNotFound();
    }

    // Rotation = registerKey(new) then (optionally) revokeKey(old) → overlap window for in-flight proofs.

    function isActiveKey(bytes32 orgId, bytes32 qx, bytes32 qy) external view returns (bool) {
        Key[] storage ks = _keys[orgId];
        for (uint256 i = 0; i < ks.length; i++) {
            if (ks[i].qx == qx && ks[i].qy == qy && ks[i].revokedAt == 0) return true;
        }
        return false;
    }

    function keysOf(bytes32 orgId) external view returns (Key[] memory) {
        return _keys[orgId];
    }
}
