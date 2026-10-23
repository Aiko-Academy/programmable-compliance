// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {IdentityRegistry} from "../contracts/identity/IdentityRegistry.sol";
import {CredentialRegistry} from "../contracts/identity/CredentialRegistry.sol";
import {VLEICredentialDataValidator} from "../contracts/identity/VLEICredentialDataValidator.sol";
import {ComplianceKeyRegistry} from "../contracts/verifiers/ComplianceKeyRegistry.sol";
import {ZkCheckRegistry} from "../contracts/verifiers/ZkCheckRegistry.sol";

/**
 * @title Admit
 * @notice The Identity Manager's three admission actions, idempotent, by the owning caller:
 *           `admitParty`      : an address, its LEI, a KYB credential by vLEI (schema SAID, credential SAID,
 *                               expiration); the identity (CCID) derives from the LEI, the address binds to it.
 *           `registerSigner`  : the P-256 key (qx, qy) of a Compliance Rules Engine under its orgId.
 *           `setZkVerifier`   : the zero-knowledge verifier of a check (Groth16 adapter).
 *
 *         Reads the foundation in `deployments/<chainId>.json`. Each function runs via `--sig`, for example:
 *           forge script scripts/Admit.s.sol --sig "admitParty(address,string,bytes32,bytes32,uint40)" \
 *             0xA1... 969500FX8K40ZDW4F377 0x<schemaSAID> 0x<credSAID> 1789000000 --rpc-url $RPC --broadcast
 */
contract Admit is Script {
    function _core() internal view returns (string memory) {
        return vm.readFile(string.concat("deployments/", vm.toString(block.chainid), ".json"));
    }

    function admitParty(address account, string calldata lei, bytes32 schemaSaid, bytes32 credentialSaid, uint40 expiresAt)
        external
    {
        require(bytes(lei).length == 20, "admit: a LEI has 20 characters");
        string memory core = _core();
        IdentityRegistry ids = IdentityRegistry(vm.parseJsonAddress(core, ".IdentityRegistry"));
        CredentialRegistry creds = CredentialRegistry(vm.parseJsonAddress(core, ".CredentialRegistry"));
        VLEICredentialDataValidator vlei = VLEICredentialDataValidator(vm.parseJsonAddress(core, ".VLEICredentialDataValidator"));
        bytes20 lei20 = bytes20(bytes(lei));
        bytes32 kyb = vlei.KYB_CREDENTIAL_TYPE();

        vm.startBroadcast();
        if (creds.dataValidator(kyb) != address(vlei)) creds.setDataValidator(kyb, address(vlei)); // once
        bytes32 ccid = ids.getIdentity(account);
        if (ccid == bytes32(0)) {
            ccid = ids.registerIdentity(account, lei20);
            console.log("identite posee", account);
        }
        if (!creds.validate(ccid, kyb)) {
            bytes memory payload = abi.encodePacked(lei20, schemaSaid, credentialSaid, uint8(1));
            if (creds.credentialData(ccid, kyb).length == 0) {
                creds.registerCredential(ccid, kyb, expiresAt, payload);
            } else {
                creds.renewCredential(ccid, kyb, expiresAt);
            }
            console.log("credential KYB pose pour", lei);
        }
        vm.stopBroadcast();
        require(ids.getIdentity(account) == ccid && creds.validate(ccid, kyb), "admit: not admitted");
    }

    function registerSigner(bytes32 orgId, bytes32 qx, bytes32 qy) external {
        ComplianceKeyRegistry keys = ComplianceKeyRegistry(vm.parseJsonAddress(_core(), ".ComplianceKeyRegistry"));
        vm.startBroadcast();
        if (!keys.isActiveKey(orgId, qx, qy)) keys.registerKey(orgId, qx, qy);
        vm.stopBroadcast();
        require(keys.isActiveKey(orgId, qx, qy), "admit: signer not active");
    }

    function setZkVerifier(string calldata checkCode, address adapter) external {
        ZkCheckRegistry zk = ZkCheckRegistry(vm.parseJsonAddress(_core(), ".ZkCheckRegistry"));
        vm.startBroadcast();
        zk.setVerifier(checkCode, adapter);
        vm.stopBroadcast();
        console.log("verificateur pose pour", checkCode, adapter);
    }
}
