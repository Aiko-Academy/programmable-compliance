// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title ExampleToken
/// @notice An example ERC-20 for the tests and `examples/` against anvil. It is deployed on no shared network:
///         the demonstration wraps real tokens.
contract ExampleToken is ERC20 {
    uint8 private immutable _dec;

    constructor(string memory name_, string memory symbol_, uint8 dec) ERC20(name_, symbol_) {
        _dec = dec;
    }

    function decimals() public view override returns (uint8) {
        return _dec;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
