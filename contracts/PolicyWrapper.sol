// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20Wrapper} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Wrapper.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IPolicyManager} from "./interfaces/IPolicyManager.sol";
import {IPolicyWrapper} from "./interfaces/IPolicyWrapper.sol";

/**
 * @title PolicyWrapper
 * @notice The Policy Wrapper of the GL1 white paper (Key Feature 2): an adaptable compliance layer placed on
 *         an immutable token. It wraps any ERC-20 one for one (lock-and-mint, ERC-7291 PBM:
 *         `depositFor` locks the underlying here and mints the wrap; `withdrawTo` burns the wrap and releases
 *         the underlying), and each `transfer` or `transferFrom` of the wrap goes through the Policy Manager with the
 *         Compliance Attestation that the caller put in context just before (`setContext`, consumed by the
 *         next transfer of that same caller).
 *
 *         It also carries the Administrative Control (Key Feature 1), distinct from usage transfers and traced
 *         by its own events: address restriction, amount freeze, forced transfer, pause. These
 *         actions belong to `COMPLIANCE_ROLE`; the forced transfer ignores the policies, the pause and the
 *         restriction, because it answers an order and not a use.
 *
 *         The pack imposes nothing on the underlying: a CBDC, a tokenised deposit, a fund, a stablecoin, on any
 *         EVM network. Decimals are those of the underlying, read and never copied.
 */
contract PolicyWrapper is ERC20, ERC20Wrapper, AccessControl, IPolicyWrapper {
    bytes32 public constant COMPLIANCE_ROLE = keccak256("COMPLIANCE_ROLE");

    IPolicyManager private _manager;
    bool private _paused;
    bool private _administrative;
    mapping(address sender => bytes) private _context;
    mapping(address account => bool) private _restricted;
    mapping(address account => uint256) private _frozen;

    event PolicyManagerSet(address indexed manager);

    constructor(IERC20 underlyingToken, string memory name_, string memory symbol_, address admin)
        ERC20(name_, symbol_)
        ERC20Wrapper(underlyingToken)
    {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(COMPLIANCE_ROLE, admin);
    }

    // ── the Policy Manager ──────────────────────────────────────────────────────────────────────────────
    /// @notice Names the Policy Manager and attaches to it. Once set, every transfer of the wrap goes through it.
    function setPolicyManager(address manager) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _manager = IPolicyManager(manager);
        IPolicyManager(manager).attach();
        emit PolicyManagerSet(manager);
    }

    function policyManager() external view returns (address) {
        return address(_manager);
    }

    function setContext(bytes calldata context) external {
        _context[msg.sender] = context;
        emit ContextSet(msg.sender, keccak256(context));
    }

    // ── wrap, transfer under policy, unwrap ─────────────────────────────────────────────────────────
    function depositFor(address to, uint256 amount) public override(ERC20Wrapper, IPolicyWrapper) returns (bool) {
        bool ok = ERC20Wrapper.depositFor(to, amount);
        emit TokenWrap(msg.sender, to, amount, address(underlying()));
        return ok;
    }

    function withdrawTo(address to, uint256 amount) public override(ERC20Wrapper, IPolicyWrapper) returns (bool) {
        bool ok = ERC20Wrapper.withdrawTo(to, amount);
        emit TokenUnwrap(msg.sender, to, amount, address(underlying()));
        return ok;
    }

    function transfer(address to, uint256 value) public override(ERC20, IERC20) returns (bool) {
        _gate(IERC20.transfer.selector, abi.encode(to, value));
        return ERC20.transfer(to, value);
    }

    function transferFrom(address from, address to, uint256 value) public override(ERC20, IERC20) returns (bool) {
        _gate(IERC20.transferFrom.selector, abi.encode(from, to, value));
        return ERC20.transferFrom(from, to, value);
    }

    function decimals() public view override(ERC20, ERC20Wrapper) returns (uint8) {
        return ERC20Wrapper.decimals();
    }

    // ── Administrative Control ─────────────────────────────────────────────────────────────────────────
    function restrict(address account, bool restricted, string calldata reason) external onlyRole(COMPLIANCE_ROLE) {
        _restricted[account] = restricted;
        emit AddressRestricted(account, restricted, reason);
    }

    function isRestricted(address account) external view returns (bool) {
        return _restricted[account];
    }

    function freeze(address account, uint256 amount, string calldata reason) external onlyRole(COMPLIANCE_ROLE) {
        _frozen[account] = amount;
        emit BalanceFrozen(account, amount, reason);
    }

    function frozenOf(address account) external view returns (uint256) {
        return _frozen[account];
    }

    function forcedTransfer(address from, address to, uint256 amount, string calldata reason)
        external
        onlyRole(COMPLIANCE_ROLE)
    {
        _administrative = true;
        _transfer(from, to, amount);
        _administrative = false;
        if (_frozen[from] > balanceOf(from)) _frozen[from] = balanceOf(from);
        emit ForcedTransfer(from, to, amount, reason);
    }

    function pause() external onlyRole(COMPLIANCE_ROLE) {
        _paused = true;
        emit Paused(msg.sender);
    }

    function unpause() external onlyRole(COMPLIANCE_ROLE) {
        _paused = false;
        emit Unpaused(msg.sender);
    }

    function paused() external view returns (bool) {
        return _paused;
    }

    // ── internal ────────────────────────────────────────────────────────────────────────────────────────
    function _gate(bytes4 selector, bytes memory data) private {
        if (address(_manager) == address(0)) revert PolicyManagerNotSet();
        bytes memory context = _context[msg.sender];
        delete _context[msg.sender];
        _manager.run(IPolicyManager.Payload({selector: selector, sender: msg.sender, data: data, context: context}));
    }

    function _update(address from, address to, uint256 value) internal override {
        if (!_administrative) {
            if (_paused) revert WrapperPaused();
            if (_restricted[from]) revert AccountRestricted(from);
            if (_restricted[to]) revert AccountRestricted(to);
            if (from != address(0)) {
                uint256 balance = balanceOf(from);
                uint256 frozen = _frozen[from];
                uint256 available = frozen >= balance ? 0 : balance - frozen;
                if (value > available) revert InsufficientUnfrozenBalance(from, available, value);
            }
        }
        ERC20._update(from, to, value);
    }
}
