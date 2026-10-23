// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {TokenisedMoneyMarketFund} from "../contracts/mocks/TokenisedMoneyMarketFund.sol";

/**
 * @title DeployRepoAssets
 * @notice Second use case (repo): the representation of a tokenised money market fund (tMMF) on the served chain,
 *         18 decimals, with a balance at the financial institution that brings it as collateral (FI A in the
 *         examples). Writes deployments/<chainId>-<symbol>-token.json. Wrapping it is a separate step (DeployWrapper).
 *
 *         Variables: HOLDER (the FI that receives the shares), SHARES (100 000 by default), NAV_USD_1E2 (10700, that is
 *         107.00 USD), TOKEN_NAME and TOKEN_SYMBOL (default "Tokenised Money Market Fund 1 (representation)" and
 *         "tMMF1"; a second fund is "tMMF2").
 */
contract DeployRepoAssets is Script {
    function run() external returns (TokenisedMoneyMarketFund t) {
        address holder = vm.envAddress("HOLDER");
        uint256 shares = vm.envOr("SHARES", uint256(100_000e18));
        uint256 nav = vm.envOr("NAV_USD_1E2", uint256(10_700)) * 1e16; // 107.00 USD in 18 decimals
        string memory name = vm.envOr("TOKEN_NAME", string("Tokenised Money Market Fund 1 (representation)"));
        string memory symbol = vm.envOr("TOKEN_SYMBOL", string("tMMF1"));
        vm.startBroadcast();
        t = new TokenisedMoneyMarketFund(name, symbol, 18, nav, "USD", msg.sender);
        t.mint(holder, shares);
        vm.stopBroadcast();
        string memory j = symbol;
        vm.serializeAddress(j, "holder", holder);
        vm.serializeUint(j, "shares", shares);
        vm.serializeUint(j, "navPerShare", nav);
        vm.serializeUint(j, "block", block.number);
        string memory out = vm.serializeAddress(j, symbol, address(t));
        vm.writeJson(out, string.concat("deployments/", vm.toString(block.chainid), "-", symbol, "-token.json"));
        console.log(symbol, address(t));
    }
}
