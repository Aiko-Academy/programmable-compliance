// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PolicyManager} from "../contracts/PolicyManager.sol";
import {PolicyWrapper} from "../contracts/PolicyWrapper.sol";
import {ERC20TransferExtractor} from "../contracts/extractors/ERC20TransferExtractor.sol";
import {RequiredChecksPolicy} from "../contracts/policies/RequiredChecksPolicy.sol";
import {EnvelopeBindingPolicy} from "../contracts/policies/EnvelopeBindingPolicy.sol";
import {IdentityGatedPolicy} from "../contracts/policies/IdentityGatedPolicy.sol";
import {AttestationValidatorPolicy} from "../contracts/policies/AttestationValidatorPolicy.sol";
import {IdentityRegistry} from "../contracts/identity/IdentityRegistry.sol";
import {CredentialRegistry} from "../contracts/identity/CredentialRegistry.sol";
import {VLEICredentialDataValidator} from "../contracts/identity/VLEICredentialDataValidator.sol";
import {ComplianceKeyRegistry} from "../contracts/verifiers/ComplianceKeyRegistry.sol";
import {InstitutionSignatureVerifier} from "../contracts/verifiers/InstitutionSignatureVerifier.sol";
import {TeeTrustRegistry} from "../contracts/verifiers/TeeTrustRegistry.sol";
import {TeeAttestationVerifier} from "../contracts/verifiers/TeeAttestationVerifier.sol";
import {ZkCheckRegistry} from "../contracts/verifiers/ZkCheckRegistry.sol";

/**
 * @title Deploy
 * @notice Deploys the pack's foundation on any chain: the verifiers, the identity registries,
 *         the Policy Manager, the extractor and the four policies. Writes `deployments/<chainId>.json`.
 *
 *         Variables: `OWNER` (the governing address; by default the deployer), `TEE_QUORUM` (1 by default).
 *         Example: `forge script scripts/Deploy.s.sol --rpc-url $RPC --broadcast --private-key $KEY`
 */
contract Deploy is Script {
    struct Core {
        ComplianceKeyRegistry keys;
        InstitutionSignatureVerifier sigVerifier;
        TeeTrustRegistry teeTrust;
        TeeAttestationVerifier teeVerifier;
        ZkCheckRegistry zk;
        VLEICredentialDataValidator vlei;
        IdentityRegistry ids;
        CredentialRegistry creds;
        PolicyManager manager;
        ERC20TransferExtractor extractor;
        RequiredChecksPolicy required;
        EnvelopeBindingPolicy binding;
        IdentityGatedPolicy identity;
        AttestationValidatorPolicy validator;
    }

    function run() external returns (Core memory c) {
        address owner = vm.envOr("OWNER", msg.sender);
        uint256 quorum = vm.envOr("TEE_QUORUM", uint256(1));
        vm.startBroadcast();
        c = deployCore(owner, quorum);
        vm.stopBroadcast();
        _write(c, owner);
    }

    /// @dev Reusable by the tests and by the example: everything that does not depend on a token.
    function deployCore(address owner, uint256 quorum) public returns (Core memory c) {
        c.keys = new ComplianceKeyRegistry(owner);
        c.sigVerifier = new InstitutionSignatureVerifier(c.keys, address(0));
        c.teeTrust = new TeeTrustRegistry(c.keys, quorum, address(0));
        c.teeVerifier = new TeeAttestationVerifier(c.sigVerifier, c.teeTrust);
        c.zk = new ZkCheckRegistry(owner);
        c.vlei = new VLEICredentialDataValidator();
        c.ids = new IdentityRegistry(owner);
        c.creds = new CredentialRegistry(owner);
        c.manager = new PolicyManager(owner, true);
        c.extractor = new ERC20TransferExtractor();
        c.required = new RequiredChecksPolicy(address(c.manager), owner);
        c.binding = new EnvelopeBindingPolicy(address(c.manager), owner);
        c.identity = new IdentityGatedPolicy(address(c.manager), owner, c.ids, c.creds);
        c.validator = new AttestationValidatorPolicy(address(c.manager), owner, c.sigVerifier, c.teeVerifier);
    }

    function _write(Core memory c, address owner) internal {
        string memory j = "core";
        vm.serializeUint(j, "chainId", block.chainid);
        vm.serializeUint(j, "block", block.number);
        vm.serializeAddress(j, "owner", owner);
        vm.serializeAddress(j, "ComplianceKeyRegistry", address(c.keys));
        vm.serializeAddress(j, "InstitutionSignatureVerifier", address(c.sigVerifier));
        vm.serializeAddress(j, "TeeTrustRegistry", address(c.teeTrust));
        vm.serializeAddress(j, "TeeAttestationVerifier", address(c.teeVerifier));
        vm.serializeAddress(j, "ZkCheckRegistry", address(c.zk));
        vm.serializeAddress(j, "VLEICredentialDataValidator", address(c.vlei));
        vm.serializeAddress(j, "IdentityRegistry", address(c.ids));
        vm.serializeAddress(j, "CredentialRegistry", address(c.creds));
        vm.serializeAddress(j, "PolicyManager", address(c.manager));
        vm.serializeAddress(j, "ERC20TransferExtractor", address(c.extractor));
        vm.serializeAddress(j, "RequiredChecksPolicy", address(c.required));
        vm.serializeAddress(j, "EnvelopeBindingPolicy", address(c.binding));
        vm.serializeAddress(j, "IdentityGatedPolicy", address(c.identity));
        string memory out = vm.serializeAddress(j, "AttestationValidatorPolicy", address(c.validator));
        string memory path = string.concat("deployments/", vm.toString(block.chainid), ".json");
        vm.writeJson(out, path);
        console.log("ecrit", path);
    }
}
