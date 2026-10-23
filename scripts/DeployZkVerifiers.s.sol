// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {ZkCheckRegistry} from "../contracts/verifiers/ZkCheckRegistry.sol";
import {Groth16ZkAdapter} from "../contracts/verifiers/Groth16ZkAdapter.sol";
import {SanctionsGroth16Verifier} from "../contracts/verifiers-zk/SanctionsGroth16Verifier.sol";
import {HolderKycGroth16Verifier} from "../contracts/verifiers-zk/HolderKycGroth16Verifier.sol";

/**
 * @title DeployZkVerifiers
 * @notice Lot 5: the pack's two Groth16 verifiers (sanctions: two public inputs; holder KYC attestation with
 *         hidden issuer: thirty-seven), each behind an adapter, set in the foundation's ZkCheckRegistry under
 *         the whitepaper codes. Anyone can then re-verify a proof via `verifyZkCheck(code, proof, publicInputs)`:
 *         that is the meaning of "on-chain verification".
 *         Reads deployments/<chainId>.json; writes deployments/<chainId>-zk.json. Idempotent by rereading.
 */
contract DeployZkVerifiers is Script {
    bytes4 constant SEL_SANCTIONS = 0xf5c9d69e; // verifyProof(uint256[2],uint256[2][2],uint256[2],uint256[2])
    bytes4 constant SEL_HOLDER_KYC = 0x76852571; // verifyProof(uint256[2],uint256[2][2],uint256[2],uint256[37])

    function run() external {
        string memory corePath = string.concat("deployments/", vm.toString(block.chainid), ".json");
        // Chain without the pack's foundation (Sepolia, Arbitrum Sepolia of the FX corridor): the registry is deployed
        // here, its admin is the broadcaster. Otherwise reread the one from the foundation.
        bool hasCore = vm.exists(corePath);
        vm.startBroadcast();
        ZkCheckRegistry zk = hasCore
            ? ZkCheckRegistry(vm.parseJsonAddress(vm.readFile(corePath), ".ZkCheckRegistry"))
            : new ZkCheckRegistry(msg.sender);
        SanctionsGroth16Verifier sanctions = new SanctionsGroth16Verifier();
        HolderKycGroth16Verifier holder = new HolderKycGroth16Verifier();
        Groth16ZkAdapter aSanctions = new Groth16ZkAdapter(address(sanctions), SEL_SANCTIONS);
        Groth16ZkAdapter aHolder = new Groth16ZkAdapter(address(holder), SEL_HOLDER_KYC);
        zk.setVerifier("sanctions-screening", address(aSanctions));
        zk.setVerifier("holder-kyc-attestation", address(aHolder));
        vm.stopBroadcast();
        require(zk.verifierOf(keccak256("sanctions-screening")) == address(aSanctions), "zk: sanctions not set");
        require(zk.verifierOf(keccak256("holder-kyc-attestation")) == address(aHolder), "zk: holder kyc not set");
        string memory j = "zk";
        vm.serializeAddress(j, "SanctionsGroth16Verifier", address(sanctions));
        vm.serializeAddress(j, "SanctionsAdapter", address(aSanctions));
        vm.serializeAddress(j, "HolderKycGroth16Verifier", address(holder));
        vm.serializeAddress(j, "ZkCheckRegistry", address(zk));
        vm.serializeUint(j, "block", block.number);
        string memory out = vm.serializeAddress(j, "HolderKycAdapter", address(aHolder));
        vm.writeJson(out, string.concat("deployments/", vm.toString(block.chainid), "-zk.json"));
        console.log("zk verifiers set in", address(zk));
    }
}
