// SPDX-License-Identifier: AGPL-3.0
// Provenance: src/legacy/Groth16ZkAdapter.sol (onchain-fx-markets, originally MIT), taken as is; only the contract name and the import paths change.
// Distributed here under AGPL-3.0. The code deployed on Hoodi is this one, byte for byte apart from metadata.
pragma solidity ^0.8.28;

import {IZkVerifier} from "./ZkCheckRegistry.sol";

/**
 * @title Groth16ZkAdapter
 * @notice Wraps a snarkjs-/gnark-generated Groth16 verifier (fixed-arity
 *         `verifyProof(uint[2],uint[2][2],uint[2],uint[N])`) behind the `IZkVerifier` convention
 *         (`verify(bytes proof, uint256[] publicInputs)`), so the live OFAC sanctions-seal verifier plugs
 *         into ZkCheckRegistry. The fixed-size array params are ABI-encoded inline (no offsets), so the
 *         target calldata is exactly: selector ‖ proof(8 words: a[2],b[2][2],c[2]) ‖ publicInputs(N words).
 *
 *         `proof` MUST be abi.encode(uint256[2] a, uint256[2][2] b, uint256[2] c) (8×32 bytes). `selector`
 *         is the target's verifyProof selector for its pubSignals arity (uint[2] OFAC, uint[3]).
 */
contract Groth16ZkAdapter is IZkVerifier {
    address public immutable verifier;
    bytes4 public immutable selector;

    error BadProofLength();

    constructor(address verifier_, bytes4 selector_) {
        verifier = verifier_;
        selector = selector_;
    }

    function verify(bytes calldata proof, uint256[] calldata publicInputs) external view returns (bool) {
        if (proof.length != 256) revert BadProofLength(); // a[2]+b[2][2]+c[2] = 8 words
        // Splice the fixed-arity calldata: selector ‖ proof ‖ each public input inline.
        bytes memory cd = abi.encodePacked(selector, proof, abi.encodePacked(publicInputs));
        (bool ok, bytes memory ret) = verifier.staticcall(cd);
        return ok && ret.length >= 32 && abi.decode(ret, (bool));
    }
}
