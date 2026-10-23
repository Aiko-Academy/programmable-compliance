// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @title RepresentedStablecoin
/// @notice The representation, on the demonstration network, of a stablecoin that has no counterpart on this
///         network (same pattern as TokenisedMoneyMarketFund): issuance and redemption by ISSUER_ROLE only,
///         never a public mint like ExampleToken. Not a holder guard: the pack's Policy Wrapper
///         carries the policy (transfer under policy).
contract RepresentedStablecoin is ERC20, AccessControl {
    bytes32 public constant ISSUER_ROLE = keccak256("ISSUER_ROLE");
    uint8 private immutable _dec;

    constructor(string memory name_, string memory symbol_, uint8 dec, address admin) ERC20(name_, symbol_) {
        _dec = dec;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ISSUER_ROLE, admin);
    }

    function decimals() public view override returns (uint8) {
        return _dec;
    }

    function mint(address to, uint256 amount) external onlyRole(ISSUER_ROLE) {
        _mint(to, amount);
    }

    function burn(address from, uint256 amount) external onlyRole(ISSUER_ROLE) {
        _burn(from, amount);
    }
}
