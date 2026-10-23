// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {ExampleToken} from "../contracts/mocks/ExampleToken.sol";

/// @notice For `examples/` only: a token to wrap, with a balance at `HOLDER`.
contract DeployExampleToken is Script {
    function run() external returns (ExampleToken t) {
        address holder = vm.envAddress("HOLDER");
        uint256 amount = vm.envOr("AMOUNT", uint256(10_000_000e18));
        vm.startBroadcast();
        t = new ExampleToken(vm.envOr("TOKEN_NAME", string("Example central bank money")), vm.envOr("TOKEN_SYMBOL", string("wEUR")), 18);
        t.mint(holder, amount);
        vm.stopBroadcast();
        string memory j = "token";
        vm.serializeAddress(j, "holder", holder);
        string memory out = vm.serializeAddress(j, "ExampleToken", address(t));
        string memory path = string.concat("deployments/", vm.toString(block.chainid), "-example-token.json");
        vm.writeJson(out, path);
        console.log("ExampleToken", address(t), path);
    }
}
