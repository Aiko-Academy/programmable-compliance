// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.28;

import {IPolicy} from "../interfaces/IPolicy.sol";
import {ComplianceTypes} from "../interfaces/ComplianceTypes.sol";
import {InstitutionSignatureVerifier} from "../verifiers/InstitutionSignatureVerifier.sol";
import {TeeAttestationVerifier} from "../verifiers/TeeAttestationVerifier.sol";

/**
 * @title AttestationValidatorPolicy
 * @notice The authenticity of each element of the Compliance Attestation put in context: a check result
 *         signed by an institution (kind 0, P-256 key active in the ComplianceKeyRegistry) or by
 *         a TEE key endorsed by a quorum (kind 1). A forged element refuses the transfer.
 *
 *         Empty context: `Continue`. The presence of the required checks is the job of the
 *         RequiredChecksPolicy, placed at position 0; the binding to the transfer and the age of the attestation are
 *         those of the EnvelopeBindingPolicy. This policy only verifies signatures, and never returns
 *         `Allowed`.
 */
contract AttestationValidatorPolicy is IPolicy {
    error Unauthorized();
    error NotOwner();
    error UnknownKind(uint8 kind);
    error VerifierNotSet();

    event VerifiersSet(address indexed institutionVerifier, address indexed teeVerifier);
    event OwnerTransferred(address indexed from, address indexed to);

    address public owner;
    address public immutable policyManager;
    InstitutionSignatureVerifier public institutionVerifier;
    TeeAttestationVerifier public teeVerifier;

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyPolicyManager() {
        if (msg.sender != policyManager) revert Unauthorized();
        _;
    }

    constructor(address manager, address initialOwner, InstitutionSignatureVerifier inst, TeeAttestationVerifier tee) {
        require(manager != address(0) && initialOwner != address(0), "attestation-validator: zero arg");
        policyManager = manager;
        owner = initialOwner;
        _set(inst, tee);
    }

    function transferOwnership(address to) external onlyOwner {
        require(to != address(0), "attestation-validator: zero owner");
        emit OwnerTransferred(owner, to);
        owner = to;
    }

    function setVerifiers(InstitutionSignatureVerifier inst, TeeAttestationVerifier tee) external onlyOwner {
        _set(inst, tee);
    }

    function onInstall(bytes4) external view onlyPolicyManager {}
    function onUninstall(bytes4) external view onlyPolicyManager {}
    function postRun(address, address, bytes4, bytes[] calldata, bytes calldata) external {}

    function run(address, address, bytes4, bytes[] calldata, bytes calldata context)
        external
        view
        returns (PolicyResult)
    {
        if (context.length == 0) return PolicyResult.Continue;
        if (address(institutionVerifier) == address(0) || address(teeVerifier) == address(0)) revert VerifierNotSet();
        ComplianceTypes.AttestationItem[] memory items = abi.decode(context, (ComplianceTypes.AttestationItem[]));
        for (uint256 i; i < items.length; ++i) {
            ComplianceTypes.AttestationItem memory it = items[i];
            bool ok;
            if (it.kind == ComplianceTypes.KIND_INSTITUTION) {
                ok = _institution(it);
            } else if (it.kind == ComplianceTypes.KIND_TEE) {
                ok = _tee(it);
            } else {
                revert UnknownKind(it.kind);
            }
            if (!ok) {
                revert PolicyRejected(
                    string.concat("AttestationValidatorPolicy: attestation of check ", it.sig.checkCode, " is not authentic")
                );
            }
        }
        return PolicyResult.Continue;
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == 0x01ffc9a7;
    }

    function _institution(ComplianceTypes.AttestationItem memory it) private view returns (bool) {
        try institutionVerifier.verify(it.orgId, _sig(it.sig), it.r, it.s, it.qx, it.qy) returns (bool ok) {
            return ok;
        } catch {
            return false;
        }
    }

    function _tee(ComplianceTypes.AttestationItem memory it) private view returns (bool) {
        try teeVerifier.verify(_sig(it.sig), it.r, it.s, it.qx, it.qy) returns (bool ok) {
            return ok;
        } catch {
            return false;
        }
    }

    function _sig(ComplianceTypes.CheckResult memory c) private pure returns (InstitutionSignatureVerifier.Sig memory s) {
        s = InstitutionSignatureVerifier.Sig({
            uetr: c.uetr,
            checkCode: c.checkCode,
            verdict: c.verdict,
            canonicalDataHash: c.canonicalDataHash,
            policyRef: c.policyRef,
            timestamp: c.timestamp
        });
    }

    function _set(InstitutionSignatureVerifier inst, TeeAttestationVerifier tee) private {
        require(address(inst) != address(0) && address(tee) != address(0), "attestation-validator: zero verifier");
        institutionVerifier = inst;
        teeVerifier = tee;
        emit VerifiersSet(address(inst), address(tee));
    }
}
