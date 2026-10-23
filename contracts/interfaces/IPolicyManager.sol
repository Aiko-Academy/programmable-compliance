// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.28;

import {IPolicy} from "./IPolicy.sol";

/// @title IPolicyManager
/// @notice The Policy Manager from the GL1 whitepaper: the coordination point between the Policy Wrappers and
///         the evaluation modules. A target (a wrapper) attaches to it; for each operation (selector) it
///         carries an ordered list of policies, a version, an activation state; `run` evaluates them in
///         order and rejects on the first rejection.
interface IPolicyManager {
    /// @notice What the policies work on: the operation, the caller, the arguments, the attestation.
    struct Payload {
        bytes4 selector;
        address sender;
        bytes data;
        bytes context;
    }

    /// @notice A value extracted from a call, named (keccak256 of the name) to be distributed to the policies.
    struct Parameter {
        bytes32 name;
        bytes value;
    }

    event TargetAttached(address indexed target);
    event TargetDetached(address indexed target);
    event ExtractorSet(bytes4 indexed selector, address indexed extractor);
    event PolicyAdded(address indexed target, bytes4 indexed selector, address policy, uint256 position);
    event PolicyRemoved(address indexed target, bytes4 indexed selector, address policy);
    event ActivationSet(address indexed target, bytes4 indexed selector, bool active);
    event DefaultAllowSet(address indexed target, bool set, bool allow);
    event PolicyVersionBumped(address indexed target, uint64 version, string label);
    event PolicyRunComplete(address indexed sender, address indexed target, bytes4 indexed selector, uint64 version);

    error TargetAlreadyAttached(address target);
    error TargetNotAttached(address target);
    error InvalidConfiguration(string what);
    error UnsupportedSelector(bytes4 selector);
    error ExtractorError(bytes4 selector, address extractor, bytes err);
    error PolicyRunRejected(bytes4 selector, address policy, string reason);
    error PolicyRunError(bytes4 selector, address policy, bytes err);
    error PolicyPostRunError(bytes4 selector, address policy, bytes err);

    // ── attachment and extraction ──────────────────────────────────────────────────────────────────────
    function attach() external;
    function detach() external;
    function isAttached(address target) external view returns (bool);
    function setExtractor(bytes4 selector, address extractor) external;
    function getExtractor(bytes4 selector) external view returns (address);

    // ── the ordered list, by target and by operation ───────────────────────────────────────────────────
    function addPolicy(address target, bytes4 selector, address policy, bytes32[] calldata parameterNames) external;
    function addPolicyAt(
        address target,
        bytes4 selector,
        address policy,
        bytes32[] calldata parameterNames,
        uint256 position
    ) external;
    function removePolicy(address target, bytes4 selector, address policy) external;
    function getPolicies(address target, bytes4 selector) external view returns (address[] memory);
    function getPolicyParameterNames(address target, bytes4 selector, address policy)
        external
        view
        returns (bytes32[] memory);

    // ── version, activation, effective scope, default rule ─────────────────────────────────────────────
    /// @notice The policy version of a target: incremented on every configuration change.
    function policyVersion(address target) external view returns (uint64);
    /// @notice The label set with the latest version (for example "2026.09-01").
    function policyVersionLabel(address target) external view returns (string memory);
    /// @notice Sets a label and increments the version, with no other change.
    function labelPolicyVersion(address target, string calldata label) external;
    /// @notice The digest of the ordered list for an operation: what an attestation references.
    function policyDescriptor(address target, bytes4 selector) external view returns (bytes32);
    /// @notice Activates or suspends evaluation for an operation; when suspended, the default rule applies.
    function setActive(address target, bytes4 selector, bool active) external;
    function isActive(address target, bytes4 selector) external view returns (bool);
    /// @notice The effective scope of a target: the operations that carry at least one policy.
    function scopeOf(address target) external view returns (bytes4[] memory selectors);
    function setDefaultAllow(bool allow) external;
    function setTargetDefaultAllow(address target, bool set, bool allow) external;

    // ── evaluation ─────────────────────────────────────────────────────────────────────────────────────
    /// @notice Evaluates without writing (no `postRun`). Reverts if rejected.
    function check(Payload calldata payload) external view;
    /// @notice Evaluates and applies (`postRun` of each policy traversed). Reverts if rejected.
    function run(Payload calldata payload) external;
}

/// @title IExtractor
/// @notice Extracts from a call the named values the policies read (from, to, amount for an ERC-20).
interface IExtractor {
    function extract(IPolicyManager.Payload calldata payload) external view returns (IPolicyManager.Parameter[] memory);
}
