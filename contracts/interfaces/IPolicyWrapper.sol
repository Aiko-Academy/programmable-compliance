// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title IPolicyWrapper
/// @notice The Policy Wrapper from the GL1 whitepaper: an ERC-20 that wraps an underlying token one for one
///         (lock-and-mint), transfers under policy (the Policy Manager evaluates each transfer with the
///         attestation set as context), unwraps, and carries the Administrative Control: address restriction,
///         freeze, forced transfer, pause.
interface IPolicyWrapper is IERC20 {
    event TokenWrap(address indexed from, address indexed to, uint256 amount, address underlying);
    event TokenUnwrap(address indexed from, address indexed to, uint256 amount, address underlying);
    event ContextSet(address indexed sender, bytes32 contextHash);
    event AddressRestricted(address indexed account, bool restricted, string reason);
    event BalanceFrozen(address indexed account, uint256 amount, string reason);
    event ForcedTransfer(address indexed from, address indexed to, uint256 amount, string reason);
    event Paused(address indexed by);
    event Unpaused(address indexed by);

    error WrapperPaused();
    error AccountRestricted(address account);
    error InsufficientUnfrozenBalance(address account, uint256 available, uint256 needed);
    error PolicyManagerNotSet();

    /// @notice Sets as context, for the caller, the attestation the next gated transfer will consume.
    function setContext(bytes calldata context) external;

    /// @notice Wraps `amount` of underlying, taken from the caller, for the benefit of `to`.
    function depositFor(address to, uint256 amount) external returns (bool);

    /// @notice Unwraps `amount` from the caller to `to`.
    function withdrawTo(address to, uint256 amount) external returns (bool);

    /// @dev `underlying()` is provided by OpenZeppelin's ERC20Wrapper, non-virtual: it is not declared here.
    function policyManager() external view returns (address);

    // ── Administrative Control ─────────────────────────────────────────────────────────────────────────
    function restrict(address account, bool restricted, string calldata reason) external;
    function isRestricted(address account) external view returns (bool);
    function freeze(address account, uint256 amount, string calldata reason) external;
    function frozenOf(address account) external view returns (uint256);
    function forcedTransfer(address from, address to, uint256 amount, string calldata reason) external;
    function pause() external;
    function unpause() external;
    function paused() external view returns (bool);
}
