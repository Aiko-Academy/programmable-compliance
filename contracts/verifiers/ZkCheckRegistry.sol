// SPDX-License-Identifier: AGPL-3.0
// Provenance: src/legacy/ZkCheckRegistry.sol (onchain-fx-markets, originally MIT), taken as is; only the contract name and the import paths change.
// Distributed here under AGPL-3.0. The code deployed on Hoodi is this one, byte for byte apart from metadata.
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// ZK-check verifier convention: a circuit's Solidity verifier (gnark- or snarkjs-generated)
/// wrapped to a uniform entrypoint. `proof` is the serialized Groth16/PLONK proof; `publicInputs` the
/// circuit's public signals. (The live OFAC sanctions-seal Groth16 verifier plugs in via an adapter.)
interface IZkVerifier {
    function verify(bytes calldata proof, uint256[] calldata publicInputs) external view returns (bool);
}

/**
 * @title ZkCheckRegistry
 * @notice Step (ZKP checks): routes a ZK-backed compliance check (by check code) to its deployed
 *         Solidity verifier. Per the deck, the ZK tooling emits a verifier carrying the verification key
 *         + compiled circuit; calling it with the public inputs returns valid/invalid. This registry is
 *         the indirection so the verification framework can verify any approved circuit's proof on-chain
 *         (e.g. SAN public-sanctions seal). Admin maps/rotates verifiers per check code.
 */
contract ZkCheckRegistry is AccessControl {
    mapping(bytes32 => address) public verifierOf; // keccak256(checkCode) => IZkVerifier

    event VerifierSet(bytes32 indexed checkCode, address verifier);

    error NoVerifier(bytes32 checkCode);

    constructor(address admin) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    function setVerifier(string calldata checkCode, address verifier) external onlyRole(DEFAULT_ADMIN_ROLE) {
        bytes32 k = keccak256(bytes(checkCode));
        verifierOf[k] = verifier;
        emit VerifierSet(k, verifier);
    }

    function verifyZkCheck(string calldata checkCode, bytes calldata proof, uint256[] calldata publicInputs)
        external
        view
        returns (bool)
    {
        address v = verifierOf[keccak256(bytes(checkCode))];
        if (v == address(0)) revert NoVerifier(keccak256(bytes(checkCode)));
        return IZkVerifier(v).verify(proof, publicInputs);
    }
}
