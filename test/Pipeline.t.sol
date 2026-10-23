// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PolicyManager} from "../contracts/PolicyManager.sol";
import {PolicyWrapper} from "../contracts/PolicyWrapper.sol";
import {IPolicy} from "../contracts/interfaces/IPolicy.sol";
import {IPolicyManager} from "../contracts/interfaces/IPolicyManager.sol";
import {IPolicyWrapper} from "../contracts/interfaces/IPolicyWrapper.sol";
import {ComplianceTypes} from "../contracts/interfaces/ComplianceTypes.sol";
import {ERC20TransferExtractor} from "../contracts/extractors/ERC20TransferExtractor.sol";
import {RequiredChecksPolicy} from "../contracts/policies/RequiredChecksPolicy.sol";
import {EnvelopeBindingPolicy} from "../contracts/policies/EnvelopeBindingPolicy.sol";
import {IdentityGatedPolicy} from "../contracts/policies/IdentityGatedPolicy.sol";
import {AttestationValidatorPolicy} from "../contracts/policies/AttestationValidatorPolicy.sol";
import {IdentityRegistry} from "../contracts/identity/IdentityRegistry.sol";
import {CredentialRegistry} from "../contracts/identity/CredentialRegistry.sol";
import {VLEICredentialDataValidator} from "../contracts/identity/VLEICredentialDataValidator.sol";
import {ComplianceKeyRegistry} from "../contracts/verifiers/ComplianceKeyRegistry.sol";
import {InstitutionSignatureVerifier} from "../contracts/verifiers/InstitutionSignatureVerifier.sol";
import {TeeTrustRegistry} from "../contracts/verifiers/TeeTrustRegistry.sol";
import {TeeAttestationVerifier} from "../contracts/verifiers/TeeAttestationVerifier.sol";

/// @dev Any underlying: the pack imposes nothing on the wrapped token.
contract Underlying is ERC20 {
    constructor() ERC20("Central bank money", "wEUR") {}

    function mint(address to, uint256 v) external {
        _mint(to, v);
    }
}

/**
 * @title PipelineTest
 * @notice The whole pipeline of the pack, as the demonstration sets it on a wrapper: presence of the
 *         required checks (position 0), binding of the attestation to the transfer with single use, identity
 *         of both parties, authenticity of the signatures; then the Administrative Control and the unwrap.
 *         The P-256 signatures are produced in the test, the keys are the test's own: nothing is copied.
 */
contract PipelineTest is Test {
    uint256 internal constant P256_N = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551;

    address internal constant OWNER = address(0x0BEE);
    address internal constant BANK_A = address(0xA1);
    address internal constant BANK_B = address(0xB1);
    address internal constant STRANGER = address(0xC1);
    bytes20 internal constant LEI_A = bytes20("969500FX8K40ZDW4F377");
    bytes20 internal constant LEI_B = bytes20("IO66REGK3RCBAMA8HR66");
    bytes32 internal constant ORG = keccak256("node");
    uint256 internal constant NODE_KEY = 0x4c6f6e67206c697665207468652047726f746831362070726f6f6620656e6769;
    bytes16 internal constant UETR = bytes16(0x538a859d49a9960cbce077e6d61df36f);
    uint256 internal constant AMOUNT = 1_000_000e18;

    Underlying internal cash;
    PolicyManager internal manager;
    PolicyWrapper internal wrapper;
    ERC20TransferExtractor internal extractor;
    RequiredChecksPolicy internal required;
    EnvelopeBindingPolicy internal binding;
    IdentityGatedPolicy internal identity;
    AttestationValidatorPolicy internal validator;
    IdentityRegistry internal ids;
    CredentialRegistry internal creds;
    VLEICredentialDataValidator internal vlei;
    ComplianceKeyRegistry internal keys;
    InstitutionSignatureVerifier internal sigVerifier;
    TeeTrustRegistry internal teeTrust;
    TeeAttestationVerifier internal teeVerifier;
    bytes32 internal qx;
    bytes32 internal qy;
    string[] internal codes;

    function setUp() public {
        vm.warp(1_789_000_000);
        codes.push("customer-due-diligence");
        codes.push("sanctions-screening");
        codes.push("transaction-threshold");

        // the verifiers and the key of the Compliance Rules Engine (the node) in the registry
        keys = new ComplianceKeyRegistry(OWNER);
        sigVerifier = new InstitutionSignatureVerifier(keys, address(0));
        teeTrust = new TeeTrustRegistry(keys, 1, address(0));
        teeVerifier = new TeeAttestationVerifier(sigVerifier, teeTrust);
        (uint256 x, uint256 y) = vm.publicKeyP256(NODE_KEY);
        (qx, qy) = (bytes32(x), bytes32(y));
        vm.prank(OWNER);
        keys.registerKey(ORG, qx, qy);

        // the Identity Manager: two financial institutions, one vLEI KYB credential each
        vlei = new VLEICredentialDataValidator();
        ids = new IdentityRegistry(OWNER);
        creds = new CredentialRegistry(OWNER);
        bytes32 kyb = vlei.KYB_CREDENTIAL_TYPE();
        vm.startPrank(OWNER);
        creds.setDataValidator(kyb, address(vlei));
        bytes32 ccidA = ids.registerIdentity(BANK_A, LEI_A);
        bytes32 ccidB = ids.registerIdentity(BANK_B, LEI_B);
        creds.registerCredential(ccidA, kyb, uint40(block.timestamp + 365 days), _vleiPayload(LEI_A));
        creds.registerCredential(ccidB, kyb, uint40(block.timestamp + 365 days), _vleiPayload(LEI_B));
        vm.stopPrank();

        // the Policy Manager, the extractor, the attached wrapper
        manager = new PolicyManager(OWNER, true);
        extractor = new ERC20TransferExtractor();
        cash = new Underlying();
        wrapper = new PolicyWrapper(IERC20(address(cash)), "Policy Wrapper wEUR", "wCBDC-EUR", OWNER);
        vm.startPrank(OWNER);
        manager.setExtractor(IERC20.transfer.selector, address(extractor));
        manager.setExtractor(IERC20.transferFrom.selector, address(extractor));
        wrapper.setPolicyManager(address(manager));

        // the four policies, in the order of the in-service pipeline
        required = new RequiredChecksPolicy(address(manager), OWNER);
        binding = new EnvelopeBindingPolicy(address(manager), OWNER);
        identity = new IdentityGatedPolicy(address(manager), OWNER, ids, creds);
        validator = new AttestationValidatorPolicy(address(manager), OWNER, sigVerifier, teeVerifier);
        required.setRequiredChecks(address(wrapper), codes);
        binding.setBinding(address(wrapper), 300, 60, true);
        identity.setGate(address(wrapper), kyb);
        bytes32[] memory none;
        bytes32[] memory leg = new bytes32[](3);
        leg[0] = keccak256("from");
        leg[1] = keccak256("to");
        leg[2] = keccak256("amount");
        bytes4[2] memory sels = [IERC20.transfer.selector, IERC20.transferFrom.selector];
        for (uint256 i; i < 2; ++i) {
            manager.addPolicyAt(address(wrapper), sels[i], address(required), none, 0);
            manager.addPolicy(address(wrapper), sels[i], address(binding), leg);
            manager.addPolicy(address(wrapper), sels[i], address(identity), leg);
            manager.addPolicy(address(wrapper), sels[i], address(validator), none);
        }
        manager.labelPolicyVersion(address(wrapper), "2026.09-01");
        vm.stopPrank();

        // FI A wraps one million
        cash.mint(BANK_A, AMOUNT);
        vm.startPrank(BANK_A);
        cash.approve(address(wrapper), AMOUNT);
        wrapper.depositFor(BANK_A, AMOUNT);
        vm.stopPrank();
    }

    // ── aides ──────────────────────────────────────────────────────────────────────────────────────────
    function _vleiPayload(bytes20 lei) internal pure returns (bytes memory) {
        return abi.encodePacked(lei, keccak256("schema"), keccak256("cred"), uint8(1));
    }

    function _signed(string memory code, address from, address to, uint256 amount, uint256 ts)
        internal
        view
        returns (ComplianceTypes.AttestationItem memory it)
    {
        it.kind = 0;
        it.orgId = ORG;
        it.sig = ComplianceTypes.CheckResult({
            uetr: UETR,
            checkCode: code,
            verdict: true,
            canonicalDataHash: binding.commitment(UETR, from, to, amount, address(wrapper), code),
            policyRef: manager.policyDescriptor(address(wrapper), IERC20.transfer.selector),
            timestamp: ts
        });
        bytes32 digest = sigVerifier.digest(
            InstitutionSignatureVerifier.Sig(it.sig.uetr, it.sig.checkCode, it.sig.verdict, it.sig.canonicalDataHash, it.sig.policyRef, it.sig.timestamp)
        );
        (bytes32 r, bytes32 s) = vm.signP256(NODE_KEY, digest);
        if (uint256(s) > P256_N / 2) s = bytes32(P256_N - uint256(s));
        it.r = r;
        it.s = s;
        it.qx = qx;
        it.qy = qy;
    }

    function _attestation(address from, address to, uint256 amount) internal view returns (bytes memory) {
        ComplianceTypes.AttestationItem[] memory items = new ComplianceTypes.AttestationItem[](3);
        for (uint256 i; i < 3; ++i) {
            items[i] = _signed(codes[i], from, to, amount, block.timestamp);
        }
        return abi.encode(items);
    }

    function _rejected(string memory reason, address policy) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(IPolicyManager.PolicyRunRejected.selector, IERC20.transfer.selector, policy, reason);
    }

    // ── the granted path ──────────────────────────────────────────────────────────────────────────────
    function test_transferUnderPolicyPasses() public {
        bytes memory ctx = _attestation(BANK_A, BANK_B, AMOUNT);
        vm.startPrank(BANK_A);
        wrapper.setContext(ctx);
        vm.expectEmit(true, true, true, true, address(manager));
        emit IPolicyManager.PolicyRunComplete(BANK_A, address(wrapper), IERC20.transfer.selector, manager.policyVersion(address(wrapper)));
        wrapper.transfer(BANK_B, AMOUNT);
        vm.stopPrank();
        assertEq(wrapper.balanceOf(BANK_B), AMOUNT);
        assertEq(wrapper.balanceOf(BANK_A), 0);
        assertEq(cash.balanceOf(address(wrapper)), AMOUNT, "le sous-jacent reste verrouille dans le wrapper");
    }

    function test_unwrapReleasesTheUnderlying() public {
        test_transferUnderPolicyPasses();
        vm.prank(BANK_B);
        wrapper.withdrawTo(BANK_B, AMOUNT);
        assertEq(cash.balanceOf(BANK_B), AMOUNT);
        assertEq(wrapper.totalSupply(), 0);
    }

    function test_decimalsAreTheUnderlyingOnes() public view {
        assertEq(wrapper.decimals(), cash.decimals());
    }

    function test_policyVersionAndScope() public view {
        assertEq(manager.policyVersionLabel(address(wrapper)), "2026.09-01");
        assertGt(manager.policyVersion(address(wrapper)), 8, "une version par changement de configuration");
        assertEq(manager.scopeOf(address(wrapper)).length, 2, "transfer et transferFrom");
        assertEq(manager.getPolicies(address(wrapper), IERC20.transfer.selector).length, 4);
        assertEq(manager.getPolicies(address(wrapper), IERC20.transfer.selector)[0], address(required), "presence en position 0");
    }

    // ── the refusals, one per policy ────────────────────────────────────────────────────────────────────
    function test_refusesWithoutAttestation() public {
        vm.prank(BANK_A);
        vm.expectRevert(_rejected("RequiredChecksPolicy: no compliance checks supplied", address(required)));
        wrapper.transfer(BANK_B, AMOUNT);
    }

    function test_refusesAMissingCheck() public {
        ComplianceTypes.AttestationItem[] memory items = new ComplianceTypes.AttestationItem[](2);
        items[0] = _signed(codes[0], BANK_A, BANK_B, AMOUNT, block.timestamp);
        items[1] = _signed(codes[1], BANK_A, BANK_B, AMOUNT, block.timestamp);
        vm.startPrank(BANK_A);
        wrapper.setContext(abi.encode(items));
        vm.expectRevert(_rejected("RequiredChecksPolicy: missing required check transaction-threshold", address(required)));
        wrapper.transfer(BANK_B, AMOUNT);
        vm.stopPrank();
    }

    function test_refusesAnAttestationBoundToAnotherTransfer() public {
        bytes memory ctx = _attestation(BANK_A, BANK_B, AMOUNT);
        vm.startPrank(BANK_A);
        wrapper.setContext(ctx);
        vm.expectRevert(_rejected("LegBindingPolicy: proof is not bound to this transfer", address(binding)));
        wrapper.transfer(BANK_B, AMOUNT - 1);
        vm.stopPrank();
    }

    function test_refusesAReplay() public {
        bytes memory ctx = _attestation(BANK_A, BANK_B, AMOUNT / 2);
        vm.startPrank(BANK_A);
        wrapper.setContext(ctx);
        wrapper.transfer(BANK_B, AMOUNT / 2);
        wrapper.setContext(ctx);
        vm.expectRevert(_rejected("LegBindingPolicy: proof already used", address(binding)));
        wrapper.transfer(BANK_B, AMOUNT / 2);
        vm.stopPrank();
    }

    function test_refusesAStaleAttestation() public {
        bytes memory ctx = _attestation(BANK_A, BANK_B, AMOUNT);
        vm.warp(block.timestamp + 301);
        vm.startPrank(BANK_A);
        wrapper.setContext(ctx);
        vm.expectRevert(_rejected("LegBindingPolicy: proof is stale", address(binding)));
        wrapper.transfer(BANK_B, AMOUNT);
        vm.stopPrank();
    }

    function test_refusesABeneficiaryWithoutIdentity() public {
        bytes memory ctx = _attestation(BANK_A, STRANGER, AMOUNT);
        vm.startPrank(BANK_A);
        wrapper.setContext(ctx);
        vm.expectRevert(_rejected("IdentityGatedPolicy: beneficiary has no identity", address(identity)));
        wrapper.transfer(STRANGER, AMOUNT);
        vm.stopPrank();
    }

    function test_refusesAnExpiredCredential() public {
        bytes memory ctx = _attestation(BANK_A, BANK_B, AMOUNT);
        bytes32 ccidB = ids.getIdentity(BANK_B);
        bytes32 kyb = vlei.KYB_CREDENTIAL_TYPE();
        vm.prank(OWNER);
        creds.removeCredential(ccidB, kyb);
        vm.startPrank(BANK_A);
        wrapper.setContext(ctx);
        vm.expectRevert(_rejected("IdentityGatedPolicy: beneficiary has no valid credential", address(identity)));
        wrapper.transfer(BANK_B, AMOUNT);
        vm.stopPrank();
    }

    function test_refusesATamperedSignature() public {
        ComplianceTypes.AttestationItem[] memory items = new ComplianceTypes.AttestationItem[](3);
        for (uint256 i; i < 3; ++i) {
            items[i] = _signed(codes[i], BANK_A, BANK_B, AMOUNT, block.timestamp);
        }
        items[1].r = bytes32(uint256(items[1].r) ^ 1);
        vm.startPrank(BANK_A);
        wrapper.setContext(abi.encode(items));
        vm.expectRevert(
            _rejected("AttestationValidatorPolicy: attestation of check sanctions-screening is not authentic", address(validator))
        );
        wrapper.transfer(BANK_B, AMOUNT);
        vm.stopPrank();
    }

    function test_refusesARevokedSignerKey() public {
        bytes memory ctx = _attestation(BANK_A, BANK_B, AMOUNT);
        vm.prank(OWNER);
        keys.revokeKey(ORG, qx, qy);
        vm.startPrank(BANK_A);
        wrapper.setContext(ctx);
        vm.expectRevert(
            _rejected("AttestationValidatorPolicy: attestation of check customer-due-diligence is not authentic", address(validator))
        );
        wrapper.transfer(BANK_B, AMOUNT);
        vm.stopPrank();
    }

    // ── activation and default rule ─────────────────────────────────────────────────────────────────
    function test_suspendedOperationFallsBackToTheDefaultRule() public {
        vm.prank(OWNER);
        manager.setActive(address(wrapper), IERC20.transfer.selector, false);
        vm.prank(BANK_A);
        wrapper.transfer(BANK_B, 1);
        assertEq(wrapper.balanceOf(BANK_B), 1);
        vm.prank(OWNER);
        manager.setTargetDefaultAllow(address(wrapper), true, false);
        vm.prank(BANK_A);
        vm.expectRevert(_rejectedDefault());
        wrapper.transfer(BANK_B, 1);
    }

    function _rejectedDefault() internal pure returns (bytes memory) {
        return abi.encodeWithSelector(
            IPolicyManager.PolicyRunRejected.selector, bytes4(0), address(0), "no policy allowed the action and default is reject"
        );
    }

    function test_unattachedCallerIsRefused() public {
        IPolicyManager.Payload memory p = IPolicyManager.Payload(IERC20.transfer.selector, BANK_A, "", "");
        vm.expectRevert(abi.encodeWithSelector(IPolicyManager.TargetNotAttached.selector, address(this)));
        manager.run(p);
    }

    // ── Administrative Control ─────────────────────────────────────────────────────────────────────────
    function test_restrictedAddressCannotReceive() public {
        vm.prank(OWNER);
        wrapper.restrict(BANK_B, true, "regulatory order 2026-09-14");
        bytes memory ctx = _attestation(BANK_A, BANK_B, AMOUNT);
        vm.startPrank(BANK_A);
        wrapper.setContext(ctx);
        vm.expectRevert(abi.encodeWithSelector(IPolicyWrapper.AccountRestricted.selector, BANK_B));
        wrapper.transfer(BANK_B, AMOUNT);
        vm.stopPrank();
    }

    function test_frozenBalanceCannotMove() public {
        vm.prank(OWNER);
        wrapper.freeze(BANK_A, AMOUNT - 10, "asset recovery pending");
        bytes memory ctx = _attestation(BANK_A, BANK_B, 11);
        vm.startPrank(BANK_A);
        wrapper.setContext(ctx);
        vm.expectRevert(abi.encodeWithSelector(IPolicyWrapper.InsufficientUnfrozenBalance.selector, BANK_A, 10, 11));
        wrapper.transfer(BANK_B, 11);
        vm.stopPrank();
    }

    function test_forcedTransferIgnoresPoliciesPauseAndRestriction() public {
        vm.startPrank(OWNER);
        wrapper.pause();
        wrapper.restrict(BANK_A, true, "restricted");
        wrapper.forcedTransfer(BANK_A, BANK_B, AMOUNT, "court order");
        vm.stopPrank();
        assertEq(wrapper.balanceOf(BANK_B), AMOUNT);
    }

    function test_pauseBlocksWrapAndUnwrap() public {
        vm.prank(OWNER);
        wrapper.pause();
        vm.prank(BANK_A);
        vm.expectRevert(IPolicyWrapper.WrapperPaused.selector);
        wrapper.withdrawTo(BANK_A, 1);
        vm.prank(OWNER);
        wrapper.unpause();
        vm.prank(BANK_A);
        wrapper.withdrawTo(BANK_A, 1);
        assertEq(cash.balanceOf(BANK_A), 1);
    }

    function test_onlyComplianceRoleControls() public {
        vm.prank(STRANGER);
        vm.expectRevert();
        wrapper.pause();
        vm.prank(STRANGER);
        vm.expectRevert();
        wrapper.forcedTransfer(BANK_A, STRANGER, 1, "theft");
    }
}
