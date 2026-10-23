// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.28;

/// @title IPolicy
/// @notice A policy of the Policy Manager. The Policy Manager calls them in the order configured for a target
///         and an operation; each one returns `Continue` (nothing to object to, the next one decides),
///         `Allowed` (the chain stops here, granted) or rejects by reverting `PolicyRejected(reason)`. A
///         presence or binding policy NEVER returns `Allowed`: the manager would stop before those that follow.
interface IPolicy {
    /// @dev None = 0, Allowed = 1, Continue = 2: deployed policies rely on this ordering, do not change it.
    enum PolicyResult {
        None,
        Allowed,
        Continue
    }

    /// @notice A policy's rejection. The manager wraps it in `PolicyRunRejected` together with its address.
    error PolicyRejected(string reason);

    /// @notice Called by the manager when the policy is installed on an operation.
    function onInstall(bytes4 selector) external;

    /// @notice Called by the manager when the policy is removed from an operation.
    function onUninstall(bytes4 selector) external;

    /// @notice The evaluation. `parameters` are the values extracted from the call, in the order of the names
    ///         declared at install time; `context` is the Compliance Attestation the caller has set as context.
    function run(address caller, address subject, bytes4 selector, bytes[] calldata parameters, bytes calldata context)
        external
        view
        returns (PolicyResult);

    /// @notice The write after evaluation (single use of an attestation, for example). Same arguments.
    function postRun(address caller, address subject, bytes4 selector, bytes[] calldata parameters, bytes calldata context)
        external;

    function supportsInterface(bytes4 interfaceId) external view returns (bool);
}
