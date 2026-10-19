// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {OptionsBuilder} from "@layerzerolabs/lz-evm-oapp-v2/contracts/oapp/libs/OptionsBuilder.sol";

// The types and interfaces below are declared HERE, identical to the upstream ABI, so that nothing is imported
// from the plumbing layer under a source-available licence (UlnBase, SendLibBase, IMessageLibManager). Same rule
// as ComplianceOFTAdapter: the permissive (oapp) layer is imported, the plumbing is called by address.
struct UlnConfig {
    uint64 confirmations;
    uint8 requiredDVNCount;
    uint8 optionalDVNCount;
    uint8 optionalDVNThreshold;
    address[] requiredDVNs;
    address[] optionalDVNs;
}

struct ExecutorConfig {
    uint32 maxMessageSize;
    address executor;
}

struct SetConfigParam {
    uint32 eid;
    uint32 configType;
    bytes config;
}

struct EnforcedOptionParam {
    uint32 eid;
    uint16 msgType;
    bytes options;
}

interface ILzEndpointWiring {
    function setSendLibrary(address oapp, uint32 eid, address lib) external;
    function getSendLibrary(address sender, uint32 eid) external view returns (address);
    function isDefaultSendLibrary(address sender, uint32 eid) external view returns (bool);
    function setReceiveLibrary(address oapp, uint32 eid, address lib, uint256 gracePeriod) external;
    function getReceiveLibrary(address receiver, uint32 eid) external view returns (address lib, bool isDefault);
    function setConfig(address oapp, address lib, SetConfigParam[] calldata params) external;
    function delegates(address oapp) external view returns (address);
    function eid() external view returns (uint32);
}

interface ILzSendLibRaw {
    function getAppUlnConfig(address oapp, uint32 remoteEid) external view returns (UlnConfig memory);
    function executorConfigs(address oapp, uint32 remoteEid) external view returns (uint32, address);
}

interface ILzReceiveLibRaw {
    function getAppUlnConfig(address oapp, uint32 remoteEid) external view returns (UlnConfig memory);
}

interface IOAppWiring {
    function owner() external view returns (address);
    function setDelegate(address delegate) external;
    function transferOwnership(address newOwner) external;
    function setPeer(uint32 eid, bytes32 peer) external;
    function peers(uint32 eid) external view returns (bytes32);
    function setEnforcedOptions(EnforcedOptionParam[] calldata params) external;
    function enforcedOptions(uint32 eid, uint16 msgType) external view returns (bytes memory);
}

/// @title WireLZ
/// @notice Complete wiring of a corridor adapter (peer, send and receive libraries, ULN config, executor,
///         enforced options) and its read-back from the chain. Before it, the corridor only set `setPeer` and ran
///         on the LayerZero DEFAULTS (measured on 2026-10-16: `isDefaultSendLibrary` true, empty
///         `enforcedOptions`, inherited ULN config). A default is not our security model: LayerZero can change it
///         and nothing pins it.
///
///         Two entry points, one source of truth (`_spec`):
///           - `check()`: read only. Compares the chain state with the specification and REVERTS if any
///             discrepancy remains. This is the proof to replay after every action; read the verdict from the
///             exit code, not from a log.
///           - `run()`: sets what differs, under the adapter's delegate. Without `--broadcast` it is a simulation.
///
///         What was pinned on 2026-10-16 was WHAT WAS ALREADY EFFECTIVE (2 confirmations, one required DVN = LayerZero
///         Labs, default executor, 10,000 bytes). On 2026-10-20 a second required DVN was added (`dvn2`): two verifiers
///         must confirm. Changing the DVN set again (for example to a compliance DVN) is another line of `_spec`,
///         applied by this same script.
///
///         Enforced options ADD to the caller's options (the executor sums the `lzReceive` gas and the
///         `lzCompose` gas). Once they are set, the caller sends no options: a send that repeated the same
///         amounts would count them twice.
///
///         Control surface: the owner of the adapter is also its delegate, and either can replace the DVN set or the
///         peer, which is enough to forge messages and drain the lockbox. On a testnet the deployer key holds both.
///         `check()` reports whether the owner is a contract (multisig or timelock) and fails on an EOA when
///         REQUIRE_CONTRACT_OWNER=true. `handover()` moves delegate and ownership to NEW_OWNER in one broadcast.
///
///         Env: LOCAL_ADAPTER and REMOTE_ADAPTER (default: the FX corridor pair), ENFORCED_LZRECEIVE_GAS (500000),
///         ENFORCED_COMPOSE_GAS (4500000, Sepolia to Arbitrum direction only: the return path has no composer).
///         EXTRA_REQUIRED_DVN (address ON THE CHAIN BEING RUN) overrides the second required DVN of the send and the
///         receive ULN config; the default is the one set on 2026-10-20. The zero address means "no second DVN". REQUIRE_CONTRACT_OWNER (true/false),
///         NEW_OWNER and HANDOVER_CONFIRM (the same address, typed twice) drive the control surface.
///         See scripts/wiring/README.md.
contract WireLZ is Script {
    using OptionsBuilder for bytes;

    uint32 internal constant CONFIG_TYPE_EXECUTOR = 1;
    uint32 internal constant CONFIG_TYPE_ULN = 2;
    uint16 internal constant MSG_SEND = 1;
    uint16 internal constant MSG_SEND_AND_CALL = 2;
    uint8 internal constant NIL_DVN_COUNT = type(uint8).max;

    struct Spec {
        string name;
        uint32 localEid;
        uint32 remoteEid;
        address endpoint;
        address sendLib;
        address recvLib;
        address executor;
        address dvn; // the required DVN on THIS chain (the same logical DVN has another address on the other chain)
        address dvn2; // second required DVN on THIS chain (EXTRA_REQUIRED_DVN overrides the default), zero for none
        address adapter;
        address remoteAdapter;
        bool enforce; // enforced options on the plain message (SEND): lzReceive
        bool compose; // and on SEND_AND_CALL (lzCompose): only where a composer waits (Sepolia to Arbitrum direction)
        uint32 maxMessageSize;
        uint64 confirmations;
    }

    uint256 internal bad;

    // ── specification: values come from the LayerZero metadata API (read on 2026-10-16) ─────────────────────────
    //   https://metadata.layerzero-api.com/v1/metadata, keys `sepolia-testnet` (EID 40161) and `arbitrum-sepolia`
    //   (EID 40231). The ULN and executor values were read ON the chain (`getConfig`) the same day and match the
    //   defaults: we pin what is effective, we do not change it. Shared endpoint v2, read back.

    function _spec() internal view returns (Spec memory s) {
        if (block.chainid == 11155111) {
            s = Spec({
                name: "Sepolia",
                localEid: 40161,
                remoteEid: 40231,
                endpoint: vm.parseAddress("0x6edce65403992e310a62460808c4b910d972f10f"),
                sendLib: vm.parseAddress("0xcc1ae8cf5d3904cef3360a9532b477529b177cce"),
                recvLib: vm.parseAddress("0xdaf00f5ee2158dd58e0d3857851c432e34a3a851"),
                executor: vm.parseAddress("0x718b92b5cb0a5552039b593faf724d182a881eda"),
                dvn: vm.parseAddress("0x8eebf8b423b73bfca51a1db4b7354aa0bfca9193"), // LayerZero Labs
                dvn2: vm.envOr("EXTRA_REQUIRED_DVN", vm.parseAddress("0x843139c725c2fb9814de6a12fb890d8dbf3e1698")),
                adapter: vm.envOr("LOCAL_ADAPTER", vm.parseAddress("0x6ad8F75cfef4BA21499106acE487c3273902eD91")),
                remoteAdapter: vm.envOr("REMOTE_ADAPTER", vm.parseAddress("0xbC2060BE78E637E16cD09a856dF2eE2534A59a80")),
                enforce: true,
                compose: true,
                maxMessageSize: 10000,
                confirmations: 2
            });
        } else if (block.chainid == 421614) {
            s = Spec({
                name: "Arbitrum Sepolia",
                localEid: 40231,
                remoteEid: 40161,
                endpoint: vm.parseAddress("0x6edce65403992e310a62460808c4b910d972f10f"),
                sendLib: vm.parseAddress("0x4f7cd4da19abb31b0ec98b9066b9e857b1bf9c0e"),
                recvLib: vm.parseAddress("0x75db67cdab2824970131d5aa9cecfc9f69c69636"),
                executor: vm.parseAddress("0x5df3a1cebbd9c8ba7f8df51fd632a9aef8308897"),
                dvn: vm.parseAddress("0x53f488e93b4f1b60e8e83aa374dbe1780a1ee8a8"), // LayerZero Labs
                dvn2: vm.envOr("EXTRA_REQUIRED_DVN", vm.parseAddress("0xc6cec4e6b8f3dc87e676d06a24864081311eda15")),
                adapter: vm.envOr("LOCAL_ADAPTER", vm.parseAddress("0xbC2060BE78E637E16cD09a856dF2eE2534A59a80")),
                remoteAdapter: vm.envOr("REMOTE_ADAPTER", vm.parseAddress("0x6ad8F75cfef4BA21499106acE487c3273902eD91")),
                enforce: true,
                compose: false,
                maxMessageSize: 10000,
                confirmations: 2
            });
        } else {
            revert("WireLZ: chaine non prevue (11155111 ou 421614)");
        }
    }

    function _ulnSpec(Spec memory s) internal pure returns (UlnConfig memory u) {
        // The ULN requires the DVN list sorted ascending and without duplicates.
        uint8 n = s.dvn2 == address(0) ? 1 : 2;
        address[] memory req = new address[](n);
        if (n == 1) {
            req[0] = s.dvn;
        } else {
            require(s.dvn2 != s.dvn, "WireLZ: EXTRA_REQUIRED_DVN equals the first DVN");
            (req[0], req[1]) = s.dvn < s.dvn2 ? (s.dvn, s.dvn2) : (s.dvn2, s.dvn);
        }
        // optionalDVNCount = NIL: "no optional DVN" written explicitly. Left at 0, it would inherit any optional
        // DVN that LayerZero adds to the default one day.
        u = UlnConfig({
            confirmations: s.confirmations,
            requiredDVNCount: n,
            optionalDVNCount: NIL_DVN_COUNT,
            optionalDVNThreshold: 0,
            requiredDVNs: req,
            optionalDVNs: new address[](0)
        });
    }

    function _optionsSpec(uint256 lzReceiveGas, uint256 composeGas, uint16 msgType) internal pure returns (bytes memory o) {
        o = OptionsBuilder.newOptions().addExecutorLzReceiveOption(uint128(lzReceiveGas), 0);
        if (msgType == MSG_SEND_AND_CALL) o = o.addExecutorLzComposeOption(0, uint128(composeGas), 0);
    }

    function _gas() internal view returns (uint256 rcv, uint256 cmp) {
        rcv = vm.envOr("ENFORCED_LZRECEIVE_GAS", uint256(500_000));
        cmp = vm.envOr("ENFORCED_COMPOSE_GAS", uint256(4_500_000));
    }

    // ── read: one discrepancy per line, one revert at the end ────────────────────────────────────────────────────

    function check() external {
        Spec memory s = _spec();
        console2.log("== WireLZ check :", s.name, "chainid", block.chainid);
        console2.log("   block", block.number);
        _checkAll(s);
        console2.log(bad == 0 ? "== CONFORMING: 0 discrepancy" : "== DISCREPANCIES (see above)");
        require(bad == 0, "WireLZ: wiring discrepancies");
    }

    function _ok(bool cond, string memory label) internal {
        if (cond) {
            console2.log("   ok     ", label);
        } else {
            console2.log("   DIFF   ", label);
            bad++;
        }
    }

    function _checkAll(Spec memory s) internal {
        ILzEndpointWiring ep = ILzEndpointWiring(s.endpoint);
        IOAppWiring app = IOAppWiring(s.adapter);

        // target witness: the endpoint answers with the expected EID, otherwise we are reading the wrong chain
        _ok(ep.eid() == s.localEid, "endpoint.eid() == expected local EID");
        _ok(ep.delegates(s.adapter) == app.owner(), "adapter delegate == adapter owner");
        _checkControl(app.owner());
        if (s.dvn2 != address(0)) {
            _ok(s.dvn2.code.length > 0, "second required DVN has code on this chain");
        }

        _ok(app.peers(s.remoteEid) == bytes32(uint256(uint160(s.remoteAdapter))), "peer(remoteEid) == remote adapter");

        // send library: EXPLICIT (isDefault false) and equal to the specification
        (address rl, bool rDef) = ep.getReceiveLibrary(s.adapter, s.remoteEid);
        _ok(!ep.isDefaultSendLibrary(s.adapter, s.remoteEid), "SEND library pinned (not the default)");
        _ok(ep.getSendLibrary(s.adapter, s.remoteEid) == s.sendLib, "send library == expected sendUln302");
        _ok(!rDef, "RECEIVE library pinned (not the default)");
        _ok(rl == s.recvLib, "receive library == expected receiveUln302");

        // send config: the RAW value set by the application (getAppUlnConfig), not the effective value merged
        // with the default: only the raw value tells "pinned" from "inherited".
        UlnConfig memory want = _ulnSpec(s);
        _ulnEq(ILzSendLibRaw(s.sendLib).getAppUlnConfig(s.adapter, s.remoteEid), want, "send ULN");
        _ulnEq(ILzReceiveLibRaw(s.recvLib).getAppUlnConfig(s.adapter, s.remoteEid), want, "receive ULN");
        (uint32 mms, address exec) = ILzSendLibRaw(s.sendLib).executorConfigs(s.adapter, s.remoteEid);
        _ok(mms == s.maxMessageSize && exec == s.executor, "executor + max size pinned (raw)");

        if (s.enforce) {
            (uint256 g, uint256 c) = _gas();
            _ok(
                keccak256(app.enforcedOptions(s.remoteEid, MSG_SEND)) == keccak256(_optionsSpec(g, c, MSG_SEND)),
                "enforced options SEND (lzReceive)"
            );
            if (s.compose) {
                _ok(
                    keccak256(app.enforcedOptions(s.remoteEid, MSG_SEND_AND_CALL))
                        == keccak256(_optionsSpec(g, c, MSG_SEND_AND_CALL)),
                    "enforced options SEND_AND_CALL (lzReceive + lzCompose)"
                );
            }
        }
    }

    // The owner and the delegate can swap the DVN set or the peer, so they control the lockbox. An EOA is a demo
    // setting: reported as a warning, and a failure once REQUIRE_CONTRACT_OWNER=true (production).
    function _checkControl(address owner_) internal {
        bool isContract = owner_.code.length > 0;
        console2.log("   owner/delegate :", owner_);
        if (vm.envOr("REQUIRE_CONTRACT_OWNER", false)) {
            _ok(isContract, "owner is a contract (multisig or timelock)");
        } else if (isContract) {
            console2.log("   info    owner is a contract");
        } else {
            console2.log("   WARN    owner is an EOA: acceptable on a demo, not in production");
        }
    }

    function _ulnSame(UlnConfig memory got, UlnConfig memory want) internal pure returns (bool) {
        return got.confirmations == want.confirmations && got.requiredDVNCount == want.requiredDVNCount
            && got.optionalDVNCount == want.optionalDVNCount && got.optionalDVNThreshold == want.optionalDVNThreshold
            && keccak256(abi.encode(got.requiredDVNs)) == keccak256(abi.encode(want.requiredDVNs))
            && keccak256(abi.encode(got.optionalDVNs)) == keccak256(abi.encode(want.optionalDVNs));
    }

    function _ulnEq(UlnConfig memory got, UlnConfig memory want, string memory label) internal {
        _ok(_ulnSame(got, want), label);
    }

    // ── hand over: delegate and owner to a secure address ───────────────────────────────────────────────────────

    /// @notice Moves the delegate, then the ownership, of the adapter to NEW_OWNER. The delegate goes first
    ///         because `setDelegate` is owner-only. Both are immediate: a wrong address is final, hence three
    ///         guards: NEW_OWNER must be a contract (unless ALLOW_EOA_OWNER=true), HANDOVER_CONFIRM must repeat
    ///         it, and the move is a simulation without --broadcast. After it, `run()` must be signed by
    ///         NEW_OWNER, so the multisig has to be able to send the transactions `run()` lists.
    function handover() external {
        Spec memory s = _spec();
        IOAppWiring app = IOAppWiring(s.adapter);
        address to = vm.envAddress("NEW_OWNER");
        require(to != address(0) && to != app.owner(), "WireLZ: NEW_OWNER is zero or already the owner");
        require(vm.envOr("HANDOVER_CONFIRM", address(0)) == to, "WireLZ: HANDOVER_CONFIRM must repeat NEW_OWNER");
        require(
            to.code.length > 0 || vm.envOr("ALLOW_EOA_OWNER", false),
            "WireLZ: NEW_OWNER has no code on this chain (multisig or timelock expected)"
        );
        require(ILzEndpointWiring(s.endpoint).eid() == s.localEid, "WireLZ: the endpoint does not carry the expected EID");
        console2.log("== WireLZ handover :", s.name, "adapter", s.adapter);
        console2.log("   from", app.owner());
        console2.log("   to  ", to);
        vm.startBroadcast();
        app.setDelegate(to);
        app.transferOwnership(to);
        vm.stopBroadcast();
        console2.log("   set   setDelegate + transferOwnership (read back with check() in a separate command)");
    }

    // ── set: only what differs ───────────────────────────────────────────────────────────────────────────────────

    function run() external {
        Spec memory s = _spec();
        ILzEndpointWiring ep = ILzEndpointWiring(s.endpoint);
        IOAppWiring app = IOAppWiring(s.adapter);
        require(ep.eid() == s.localEid, "WireLZ: the endpoint does not carry the expected EID");
        console2.log("== WireLZ run :", s.name, "adapter", s.adapter);
        console2.log("   expected delegate/owner :", app.owner());

        vm.startBroadcast();

        if (app.peers(s.remoteEid) != bytes32(uint256(uint160(s.remoteAdapter)))) {
            app.setPeer(s.remoteEid, bytes32(uint256(uint160(s.remoteAdapter))));
            console2.log("   set   setPeer");
        }
        if (ep.isDefaultSendLibrary(s.adapter, s.remoteEid)) {
            ep.setSendLibrary(s.adapter, s.remoteEid, s.sendLib);
            console2.log("   set   setSendLibrary");
        }
        (, bool rDef) = ep.getReceiveLibrary(s.adapter, s.remoteEid);
        if (rDef) {
            ep.setReceiveLibrary(s.adapter, s.remoteEid, s.recvLib, 0);
            console2.log("   set   setReceiveLibrary");
        }

        _setConfig(s, ep);
        if (s.enforce) _setOptions(s, app);

        vm.stopBroadcast();

        // Without --broadcast the read-back below reads the SIMULATED state. With --broadcast it does not prove
        // the chain: the proof is a `check()` run AFTER, in a separate command.
        _checkAll(s);
        console2.log(bad == 0 ? "== state after set: conforming (simulated)" : "== state after set: DISCREPANCIES");
        require(bad == 0, "WireLZ: discrepancies after set");
    }

    // setConfig and setEnforcedOptions are only set when the RAW value differs from the specification (the same
    // reads as `check()`): a `run()` replayed on a conforming wiring broadcasts nothing it does not need to.
    function _setConfig(Spec memory s, ILzEndpointWiring ep) internal {
        UlnConfig memory want = _ulnSpec(s);
        (uint32 mms, address exec) = ILzSendLibRaw(s.sendLib).executorConfigs(s.adapter, s.remoteEid);
        bool sendDiff = !_ulnSame(ILzSendLibRaw(s.sendLib).getAppUlnConfig(s.adapter, s.remoteEid), want)
            || mms != s.maxMessageSize || exec != s.executor;
        if (sendDiff) {
            SetConfigParam[] memory sendP = new SetConfigParam[](2);
            sendP[0] = SetConfigParam(
                s.remoteEid, CONFIG_TYPE_EXECUTOR, abi.encode(ExecutorConfig(s.maxMessageSize, s.executor))
            );
            sendP[1] = SetConfigParam(s.remoteEid, CONFIG_TYPE_ULN, abi.encode(want));
            ep.setConfig(s.adapter, s.sendLib, sendP);
            console2.log("   set   setConfig send (executor + ULN)");
        }
        if (!_ulnSame(ILzReceiveLibRaw(s.recvLib).getAppUlnConfig(s.adapter, s.remoteEid), want)) {
            SetConfigParam[] memory recvP = new SetConfigParam[](1);
            recvP[0] = SetConfigParam(s.remoteEid, CONFIG_TYPE_ULN, abi.encode(want));
            ep.setConfig(s.adapter, s.recvLib, recvP);
            console2.log("   set   setConfig receive (ULN)");
        }
    }

    function _setOptions(Spec memory s, IOAppWiring app) internal {
        (uint256 g, uint256 c) = _gas();
        bytes memory oSend = _optionsSpec(g, c, MSG_SEND);
        bytes memory oCall = s.compose ? _optionsSpec(g, c, MSG_SEND_AND_CALL) : bytes("");
        bool dSend = keccak256(app.enforcedOptions(s.remoteEid, MSG_SEND)) != keccak256(oSend);
        bool dCall = s.compose && keccak256(app.enforcedOptions(s.remoteEid, MSG_SEND_AND_CALL)) != keccak256(oCall);
        if (dSend || dCall) {
            // both types are set together: setEnforcedOptions overwrites the value of each type it is given.
            EnforcedOptionParam[] memory eo = new EnforcedOptionParam[](s.compose ? 2 : 1);
            eo[0] = EnforcedOptionParam(s.remoteEid, MSG_SEND, oSend);
            if (s.compose) eo[1] = EnforcedOptionParam(s.remoteEid, MSG_SEND_AND_CALL, oCall);
            app.setEnforcedOptions(eo);
            console2.log("   set   setEnforcedOptions");
        }
    }
}
