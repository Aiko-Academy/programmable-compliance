// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.28;

import {IPolicy} from "../interfaces/IPolicy.sol";
import {IdentityRegistry} from "../identity/IdentityRegistry.sol";
import {CredentialRegistry} from "../identity/CredentialRegistry.sol";

/**
 * @title IdentityGatedPolicy
 * @notice Identity Management (Key Feature 4) applied to the transfer: the sender and the beneficiary must
 *         resolve to an identity (CCID) in the IdentityRegistry and that identity must carry a valid
 *         credential of the type configured for the target (for example the vLEI KYB). An infrastructure address
 *         (an orchestrator, a bridge) is exempted per target.
 *
 *         Not configured for a target: `Continue`. Never returns `Allowed`.
 */
contract IdentityGatedPolicy is IPolicy {
    error Unauthorized();
    error NotOwner();

    struct Config {
        bool enabled;
        bytes32 credentialType;
    }

    event GateSet(address indexed target, bytes32 credentialType);
    event GateCleared(address indexed target);
    event ExemptionSet(address indexed target, address indexed account, bool exempt);
    event OwnerTransferred(address indexed from, address indexed to);

    address public owner;
    address public immutable policyManager;
    IdentityRegistry public immutable identityRegistry;
    CredentialRegistry public immutable credentialRegistry;

    mapping(address target => Config) private _cfg;
    mapping(address target => mapping(address account => bool)) private _exempt;

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyPolicyManager() {
        if (msg.sender != policyManager) revert Unauthorized();
        _;
    }

    constructor(address manager, address initialOwner, IdentityRegistry ids, CredentialRegistry creds) {
        require(manager != address(0) && initialOwner != address(0), "identity-gated: zero arg");
        require(address(ids) != address(0) && address(creds) != address(0), "identity-gated: zero registry");
        policyManager = manager;
        owner = initialOwner;
        identityRegistry = ids;
        credentialRegistry = creds;
    }

    function transferOwnership(address to) external onlyOwner {
        require(to != address(0), "identity-gated: zero owner");
        emit OwnerTransferred(owner, to);
        owner = to;
    }

    function setGate(address target, bytes32 credentialType) external onlyOwner {
        _cfg[target] = Config({enabled: true, credentialType: credentialType});
        emit GateSet(target, credentialType);
    }

    function clearGate(address target) external onlyOwner {
        delete _cfg[target];
        emit GateCleared(target);
    }

    function gate(address target) external view returns (Config memory) {
        return _cfg[target];
    }

    function setExempt(address target, address account, bool exempt) external onlyOwner {
        _exempt[target][account] = exempt;
        emit ExemptionSet(target, account, exempt);
    }

    function isExempt(address target, address account) external view returns (bool) {
        return _exempt[target][account];
    }

    function onInstall(bytes4) external view onlyPolicyManager {}
    function onUninstall(bytes4) external view onlyPolicyManager {}
    function postRun(address, address, bytes4, bytes[] calldata, bytes calldata) external {}

    function run(address, address subject, bytes4, bytes[] calldata parameters, bytes calldata)
        external
        view
        returns (PolicyResult)
    {
        Config memory c = _cfg[subject];
        if (!c.enabled) return PolicyResult.Continue;
        if (parameters.length < 2) {
            revert PolicyRejected("IdentityGatedPolicy: expected parameters (from,to) - installed without its names");
        }
        _require(subject, abi.decode(parameters[0], (address)), c.credentialType, "originator");
        _require(subject, abi.decode(parameters[1], (address)), c.credentialType, "beneficiary");
        return PolicyResult.Continue;
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == 0x01ffc9a7;
    }

    function _require(address subject, address account, bytes32 credentialType, string memory side) private view {
        if (_exempt[subject][account]) return;
        bytes32 ccid = identityRegistry.getIdentity(account);
        if (ccid == bytes32(0)) {
            revert PolicyRejected(string.concat("IdentityGatedPolicy: ", side, " has no identity"));
        }
        if (!credentialRegistry.validate(ccid, credentialType)) {
            revert PolicyRejected(string.concat("IdentityGatedPolicy: ", side, " has no valid credential"));
        }
    }
}
