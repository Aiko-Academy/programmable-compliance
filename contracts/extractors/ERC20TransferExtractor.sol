// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPolicyManager, IExtractor} from "../interfaces/IPolicyManager.sol";

/// @title ERC20TransferExtractor
/// @notice Extracts (from, to, amount) from a `transfer` or a `transferFrom`, under the names that the
///         policies declare at install time: keccak256("from"), keccak256("to"), keccak256("amount").
contract ERC20TransferExtractor is IExtractor {
    bytes32 public constant PARAM_FROM = keccak256("from");
    bytes32 public constant PARAM_TO = keccak256("to");
    bytes32 public constant PARAM_AMOUNT = keccak256("amount");

    function extract(IPolicyManager.Payload calldata payload)
        external
        pure
        returns (IPolicyManager.Parameter[] memory result)
    {
        address from;
        address to;
        uint256 amount;
        if (payload.selector == IERC20.transfer.selector) {
            from = payload.sender;
            (to, amount) = abi.decode(payload.data, (address, uint256));
        } else if (payload.selector == IERC20.transferFrom.selector) {
            (from, to, amount) = abi.decode(payload.data, (address, address, uint256));
        } else {
            revert IPolicyManager.UnsupportedSelector(payload.selector);
        }
        result = new IPolicyManager.Parameter[](3);
        result[0] = IPolicyManager.Parameter(PARAM_FROM, abi.encode(from));
        result[1] = IPolicyManager.Parameter(PARAM_TO, abi.encode(to));
        result[2] = IPolicyManager.Parameter(PARAM_AMOUNT, abi.encode(amount));
    }
}
