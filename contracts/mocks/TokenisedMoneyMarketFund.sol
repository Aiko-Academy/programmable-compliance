// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @title TokenisedMoneyMarketFund
/// @notice The representation, on the demonstration network, of a share of a tokenised money market fund (tMMF)
///         issued elsewhere: the fund's shares are recorded as tokens, while the fund's own register (kept by the
///         transfer agent) stays the record of ownership. Same decimals as the original and a net asset value
///         (NAV) per share. Roles follow the market split: FUND_MANAGER_ROLE sets the NAV, ISSUER_ROLE issues and
///         redeems the tokens (the issuer or tokenisation agent), DEFAULT_ADMIN_ROLE grants the two. Not a holder
///         guard: the pack's Policy Wrapper carries the policy (investor eligibility). Simplification for the
///         demonstration: deployed tMMFs keep the NAV outside the token contract (a separate oracle or subscription
///         module), and they split access more finely than two roles.
contract TokenisedMoneyMarketFund is ERC20, AccessControl {
    bytes32 public constant ISSUER_ROLE = keccak256("ISSUER_ROLE");
    bytes32 public constant FUND_MANAGER_ROLE = keccak256("FUND_MANAGER_ROLE");
    uint8 private immutable _dec;
    /// @notice The net asset value of a share, in units of the reference currency (18 decimals), and its currency.
    uint256 public navPerShare;
    string public navCurrency;

    event NavUpdated(uint256 navPerShare, string navCurrency);

    constructor(string memory name_, string memory symbol_, uint8 dec, uint256 nav_, string memory navCurrency_, address admin)
        ERC20(name_, symbol_)
    {
        _dec = dec;
        navPerShare = nav_;
        navCurrency = navCurrency_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ISSUER_ROLE, admin);
        _grantRole(FUND_MANAGER_ROLE, admin);
        emit NavUpdated(nav_, navCurrency_);
    }

    function decimals() public view override returns (uint8) {
        return _dec;
    }

    function setNav(uint256 nav_) external onlyRole(FUND_MANAGER_ROLE) {
        navPerShare = nav_;
        emit NavUpdated(nav_, navCurrency);
    }

    function mint(address to, uint256 shares) external onlyRole(ISSUER_ROLE) {
        _mint(to, shares);
    }

    function burn(address from, uint256 shares) external onlyRole(ISSUER_ROLE) {
        _burn(from, shares);
    }
}
