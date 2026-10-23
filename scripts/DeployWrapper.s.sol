// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PolicyManager} from "../contracts/PolicyManager.sol";
import {PolicyWrapper} from "../contracts/PolicyWrapper.sol";
import {RequiredChecksPolicy} from "../contracts/policies/RequiredChecksPolicy.sol";
import {EnvelopeBindingPolicy} from "../contracts/policies/EnvelopeBindingPolicy.sol";
import {IdentityGatedPolicy} from "../contracts/policies/IdentityGatedPolicy.sol";
import {AttestationValidatorPolicy} from "../contracts/policies/AttestationValidatorPolicy.sol";
import {VLEICredentialDataValidator} from "../contracts/identity/VLEICredentialDataValidator.sol";

/**
 * @title DeployWrapper
 * @notice Deploys a Policy Wrapper for a given ERC-20 and sets the pack's pipeline on it, in order:
 *         presence (position 0), binding, identity, verification, on `transfer` and `transferFrom`.
 *
 *         Reads the foundation in `deployments/<chainId>.json` (written by `Deploy`). Variables:
 *           `UNDERLYING` (the token's address), `WRAPPER_NAME`, `WRAPPER_SYMBOL`,
 *           `REQUIRED_CHECKS` (comma-separated codes, for example
 *           "customer-due-diligence,sanctions-screening,transaction-threshold"),
 *           `BINDING_TTL` (300 by default), `BINDING_SKEW` (60), `POLICY_LABEL` (for example "2026.09-01").
 *         The caller must be the owner of the Policy Manager and of the policies.
 */
contract DeployWrapper is Script {
    function run() external returns (PolicyWrapper wrapper) {
        string memory core = vm.readFile(string.concat("deployments/", vm.toString(block.chainid), ".json"));
        PolicyManager manager = PolicyManager(vm.parseJsonAddress(core, ".PolicyManager"));
        address extractor = vm.parseJsonAddress(core, ".ERC20TransferExtractor");
        RequiredChecksPolicy required = RequiredChecksPolicy(vm.parseJsonAddress(core, ".RequiredChecksPolicy"));
        EnvelopeBindingPolicy binding = EnvelopeBindingPolicy(vm.parseJsonAddress(core, ".EnvelopeBindingPolicy"));
        IdentityGatedPolicy identity = IdentityGatedPolicy(vm.parseJsonAddress(core, ".IdentityGatedPolicy"));
        AttestationValidatorPolicy validator =
            AttestationValidatorPolicy(vm.parseJsonAddress(core, ".AttestationValidatorPolicy"));
        VLEICredentialDataValidator vlei = VLEICredentialDataValidator(vm.parseJsonAddress(core, ".VLEICredentialDataValidator"));

        address underlying = vm.envAddress("UNDERLYING");
        string memory name = vm.envString("WRAPPER_NAME");
        string memory symbol = vm.envString("WRAPPER_SYMBOL");
        string[] memory codes = vm.envString("REQUIRED_CHECKS", ",");
        uint32 ttl = uint32(vm.envOr("BINDING_TTL", uint256(300)));
        uint32 skew = uint32(vm.envOr("BINDING_SKEW", uint256(60)));
        string memory label = vm.envOr("POLICY_LABEL", string("2026.09-01"));

        vm.startBroadcast();
        wrapper = new PolicyWrapper(IERC20(underlying), name, symbol, msg.sender);
        wrapper.setPolicyManager(address(manager));
        if (manager.getExtractor(IERC20.transfer.selector) == address(0)) {
            manager.setExtractor(IERC20.transfer.selector, extractor);
            manager.setExtractor(IERC20.transferFrom.selector, extractor);
        }
        required.setRequiredChecks(address(wrapper), codes);
        binding.setBinding(address(wrapper), ttl, skew, true);
        identity.setGate(address(wrapper), vlei.KYB_CREDENTIAL_TYPE());
        bytes32[] memory none;
        bytes32[] memory leg = new bytes32[](3);
        leg[0] = keccak256("from");
        leg[1] = keccak256("to");
        leg[2] = keccak256("amount");
        bytes4[2] memory sels = [IERC20.transfer.selector, IERC20.transferFrom.selector];
        for (uint256 i; i < 2; ++i) {
            manager.addPolicyAt(address(wrapper), sels[i], address(required), none, 0);
            manager.addPolicy(address(wrapper), sels[i], address(binding), leg);
            manager.addPolicy(address(wrapper), sels[i], address(identity), leg);
            manager.addPolicy(address(wrapper), sels[i], address(validator), none);
        }
        manager.labelPolicyVersion(address(wrapper), label);
        vm.stopBroadcast();

        string memory j = "wrapper";
        vm.serializeAddress(j, "underlying", underlying);
        vm.serializeString(j, "symbol", symbol);
        vm.serializeUint(j, "block", block.number);
        vm.serializeUint(j, "policyVersion", manager.policyVersion(address(wrapper)));
        vm.serializeBytes32(j, "policyDescriptor", manager.policyDescriptor(address(wrapper), IERC20.transfer.selector));
        string memory out = vm.serializeAddress(j, "PolicyWrapper", address(wrapper));
        string memory path = string.concat("deployments/", vm.toString(block.chainid), "-", symbol, ".json");
        vm.writeJson(out, path);
        console.log("ecrit", path);
    }
}
