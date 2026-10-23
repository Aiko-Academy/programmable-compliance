// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {PolicyWrapper} from "../contracts/PolicyWrapper.sol";

/**
 * @title Control
 * @notice The Administrative Control (Key Feature 1) by runner, idempotent, by the holder of COMPLIANCE_ROLE:
 *         restrict an address, freeze an amount, force a transfer, pause, resume. Each
 *         action emits the wrapper's event that the service reads as an evidencing record (action type, time,
 *         object, actor, outcome, transaction). The reason is written into the event: that is what an auditor will read.
 *
 *         forge script scripts/Control.s.sol --sig "restrict(address,address,bool,string)" <wrapper> <compte> true "regulatory order ..." \
 *           --rpc-url $RPC --broadcast --private-key $KEY
 *         --sig "freeze(address,address,uint256,string)", "forcedTransfer(address,address,address,uint256,string)",
 *         "pause(address)", "unpause(address)"
 */
contract Control is Script {
    function restrict(address wrapper, address account, bool restricted, string calldata reason) external {
        PolicyWrapper w = PolicyWrapper(wrapper);
        if (w.isRestricted(account) == restricted) { console.log("already", restricted ? "restricted" : "free"); return; }
        vm.startBroadcast();
        w.restrict(account, restricted, reason);
        vm.stopBroadcast();
        require(w.isRestricted(account) == restricted, "control: not applied");
        console.log(restricted ? "restricted" : "freed", account);
    }

    function freeze(address wrapper, address account, uint256 amount, string calldata reason) external {
        PolicyWrapper w = PolicyWrapper(wrapper);
        if (w.frozenOf(account) == amount) { console.log("already frozen at that amount"); return; }
        vm.startBroadcast();
        w.freeze(account, amount, reason);
        vm.stopBroadcast();
        require(w.frozenOf(account) == amount, "control: not applied");
        console.log("frozen", account, amount);
    }

    function forcedTransfer(address wrapper, address from, address to, uint256 amount, string calldata reason) external {
        PolicyWrapper w = PolicyWrapper(wrapper);
        uint256 before = w.balanceOf(to);
        vm.startBroadcast();
        w.forcedTransfer(from, to, amount, reason);
        vm.stopBroadcast();
        require(w.balanceOf(to) == before + amount, "control: not applied");
        console.log("forced", amount, "from", from);
    }

    function pause(address wrapper) external {
        PolicyWrapper w = PolicyWrapper(wrapper);
        if (w.paused()) { console.log("already paused"); return; }
        vm.startBroadcast();
        w.pause();
        vm.stopBroadcast();
        require(w.paused(), "control: not applied");
        console.log("paused", wrapper);
    }

    function unpause(address wrapper) external {
        PolicyWrapper w = PolicyWrapper(wrapper);
        if (!w.paused()) { console.log("already running"); return; }
        vm.startBroadcast();
        w.unpause();
        vm.stopBroadcast();
        require(!w.paused(), "control: not applied");
        console.log("running", wrapper);
    }
}
