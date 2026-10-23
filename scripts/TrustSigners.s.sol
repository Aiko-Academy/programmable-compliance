// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script} from "forge-std/Script.sol";
import {ComplianceKeyRegistry} from "../contracts/verifiers/ComplianceKeyRegistry.sol";
import {InstitutionSignatureVerifier} from "../contracts/verifiers/InstitutionSignatureVerifier.sol";
import {TeeAttestationVerifier} from "../contracts/verifiers/TeeAttestationVerifier.sol";
import {AttestationValidatorPolicy} from "../contracts/policies/AttestationValidatorPolicy.sol";

/**
 * @title TrustSigners
 * @notice The attestation chain of trust when two Compliance Rules Engines cohabit: a node whose keys live in a
 *         registry IN SERVICE, and the demonstration service that signs the repo legs itself. A single
 *         institution verifier is read by the pack's AttestationValidatorPolicy; it is set here to the EIP-712
 *         DOMAIN of the verifier in service (`domainOverride`), over the pack's registry, into which the active
 *         keys of the in-service registry are copied (public points, read from its log) and the service's key.
 *         The node's signatures remain valid as they are; the in-service registry is not touched.
 *
 *         Variables: `LIVE_INSTITUTION_VERIFIER`, `LIVE_TEE_VERIFIER`, `KEYS_ORG`, `KEYS_QX`, `KEYS_QY`
 *         (comma-separated lists, same length), `SIGNER_ORG`, `SIGNER_QX`, `SIGNER_QY`.
 *         Idempotent: a key already active is not re-registered; a verifier already set to the same
 *         domain (`deployments/<chainId>-trust.json`) is reused.
 */
contract TrustSigners is Script {
    function run() external {
        string memory core = vm.readFile(string.concat("deployments/", vm.toString(block.chainid), ".json"));
        ComplianceKeyRegistry keys = ComplianceKeyRegistry(vm.parseJsonAddress(core, ".ComplianceKeyRegistry"));
        AttestationValidatorPolicy validator = AttestationValidatorPolicy(vm.parseJsonAddress(core, ".AttestationValidatorPolicy"));
        address liveInst = vm.envAddress("LIVE_INSTITUTION_VERIFIER");
        address liveTee = vm.envAddress("LIVE_TEE_VERIFIER");
        bytes32[] memory org = vm.envBytes32("KEYS_ORG", ",");
        bytes32[] memory qx = vm.envBytes32("KEYS_QX", ",");
        bytes32[] memory qy = vm.envBytes32("KEYS_QY", ",");
        require(org.length == qx.length && qx.length == qy.length, "KEYS_*: lengths differ");

        string memory path = string.concat("deployments/", vm.toString(block.chainid), "-trust.json");
        address existing;
        if (vm.exists(path)) {
            string memory prev = vm.readFile(path);
            if (vm.keyExistsJson(prev, ".InstitutionSignatureVerifierLiveDomain")) existing = vm.parseJsonAddress(prev, ".InstitutionSignatureVerifierLiveDomain");
        }

        vm.startBroadcast();
        InstitutionSignatureVerifier inst = existing != address(0) && existing.code.length > 0
            ? InstitutionSignatureVerifier(existing)
            : new InstitutionSignatureVerifier(keys, liveInst);
        uint256 mirrored;
        for (uint256 i = 0; i < org.length; i++) {
            if (keys.isActiveKey(org[i], qx[i], qy[i])) continue;
            keys.registerKey(org[i], qx[i], qy[i]);
            mirrored++;
        }
        bytes32 sOrg = vm.envBytes32("SIGNER_ORG");
        bytes32 sQx = vm.envBytes32("SIGNER_QX");
        bytes32 sQy = vm.envBytes32("SIGNER_QY");
        if (!keys.isActiveKey(sOrg, sQx, sQy)) keys.registerKey(sOrg, sQx, sQy);
        if (address(validator.institutionVerifier()) != address(inst) || address(validator.teeVerifier()) != liveTee) {
            validator.setVerifiers(inst, TeeAttestationVerifier(liveTee));
        }
        vm.stopBroadcast();

        string memory j = "trust";
        vm.serializeAddress(j, "InstitutionSignatureVerifierLiveDomain", address(inst));
        vm.serializeAddress(j, "attestationDomain", liveInst);
        vm.serializeAddress(j, "liveInstitutionVerifier", liveInst);
        vm.serializeAddress(j, "liveTeeVerifier", liveTee);
        vm.serializeUint(j, "keysMirrored", org.length);
        vm.serializeUint(j, "keysRegisteredNow", mirrored);
        vm.serializeBytes32(j, "serviceSignerOrg", sOrg);
        vm.serializeBytes32(j, "serviceSignerQx", sQx);
        vm.serializeBytes32(j, "serviceSignerQy", sQy);
        vm.writeJson(vm.serializeUint(j, "block", block.number), path);
    }
}
