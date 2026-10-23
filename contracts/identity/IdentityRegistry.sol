// SPDX-License-Identifier: AGPL-3.0
// Provenance: src/common/identity/IdentityRegistry.sol (onchain-fx-markets, originally MIT), taken as is; only the contract name and the import paths change.
// Distributed here under AGPL-3.0. The code deployed on Hoodi is this one, byte for byte apart from metadata.
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title IdentityRegistry
 * @notice Programmable Compliance pack, the CCID identity layer ported (in spirit) from demo-compliance's
 *         cross-chain-identity `IdentityRegistry`. Maps wallet addresses to a **Customer/LEI CCID**
 *         (Compliance Customer ID), derived from the LEI, one CCID can span multiple wallets.
 *
 *         ⚠️ Vocabulary: this **CCID = identity** (LEI-derived, stable across wallets/chains) is DISTINCT
 *         from the per-transaction `uetr` (the on-chain bytes16 transaction reference, also loosely called
 *         "CCID = Compliance Check ID" in the FX/wrapper flow). Two different concepts, same acronym, *         here it is the institution's identity.
 *
 *         Self-contained (Ownable issuer, no PolicyEngine coupling), admin = the identity issuer / vLEI bridge.
 */
contract IdentityRegistry is Ownable {
    mapping(address => bytes32) private _accountToCcid;
    mapping(bytes32 => address[]) private _ccidToAccounts;

    event IdentityRegistered(bytes32 indexed ccid, address indexed account, bytes20 lei);
    event IdentityRemoved(bytes32 indexed ccid, address indexed account);

    error AlreadyRegistered(address account);
    error NotRegistered(address account);

    constructor(address initialOwner) Ownable(initialOwner) {}

    /// @notice CCID derivation from the LEI, keccak256(abi.encodePacked(lei)). Same wallet→CCID for all wallets of an LEI.
    function ccidOf(bytes20 lei) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(lei));
    }

    /// @notice Bind a wallet to the CCID of `lei` (issuer-gated).
    function registerIdentity(address account, bytes20 lei) external onlyOwner returns (bytes32 ccid) {
        if (_accountToCcid[account] != bytes32(0)) revert AlreadyRegistered(account);
        ccid = ccidOf(lei);
        _accountToCcid[account] = ccid;
        _ccidToAccounts[ccid].push(account);
        emit IdentityRegistered(ccid, account, lei);
    }

    function removeIdentity(address account) external onlyOwner {
        bytes32 ccid = _accountToCcid[account];
        if (ccid == bytes32(0)) revert NotRegistered(account);
        delete _accountToCcid[account];
        address[] storage accs = _ccidToAccounts[ccid];
        for (uint256 i = 0; i < accs.length; i++) {
            if (accs[i] == account) {
                accs[i] = accs[accs.length - 1];
                accs.pop();
                break;
            }
        }
        emit IdentityRemoved(ccid, account);
    }

    function getIdentity(address account) external view returns (bytes32) {
        return _accountToCcid[account];
    }

    function getAccounts(bytes32 ccid) external view returns (address[] memory) {
        return _ccidToAccounts[ccid];
    }
}
