// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {MessagingFee, MessagingReceipt} from "@layerzerolabs/lz-evm-protocol-v2/contracts/interfaces/ILayerZeroEndpointV2.sol";
import {SendParam, OFTReceipt} from "@layerzerolabs/lz-evm-oapp-v2/contracts/oft/interfaces/IOFT.sol";

/// @title IComplianceOFTAdapter
/// @notice La surface de reglage du point d'accroche cross-chain, hors OFT/LayerZero : ce que le
///         composeur et la pose appellent. La pose (le script, puis l'Orchestrator) s'y adosse.
/// @dev Declaree sous le profil `lz` uniquement : la brique n'entre pas dans la CI ni dans le zip
///      des participants (mesure du 08/10 : `lib/` n'y est pas).
interface IComplianceOFTAdapter {
    function policyWrapper() external view returns (address);
    function setComposer(address composer, bool allowed) external;
    function composers(address) external view returns (bool);
    function inboundComposer(bytes32 guid) external view returns (address);
    function inboundAmount(bytes32 guid) external view returns (uint256);
    function composePayloadFor(address beneficiary, bytes calldata attestation) external pure returns (bytes memory);
    function recordDelivery(bytes32 guid, address beneficiary, uint256 amountLD) external;
    function stageContext(bytes calldata context) external;
    function underlyingToken() external view returns (address);
    /// @dev Le retour des fonds refuses passe par le pont : le composeur renvoie son wEURX a la source.
    function send(SendParam calldata sendParam, MessagingFee calldata fee, address refundAddress)
        external
        payable
        returns (MessagingReceipt memory, OFTReceipt memory);
    function quoteSend(SendParam calldata sendParam, bool payInLzToken) external view returns (MessagingFee memory);

    event ComposerSet(address indexed composer, bool allowed);
    event Inbound(bytes32 indexed guid, address indexed composer, uint256 amountLD);
    event Delivered(bytes32 indexed guid, address indexed composer, address indexed beneficiary, uint256 amountLD);
}
