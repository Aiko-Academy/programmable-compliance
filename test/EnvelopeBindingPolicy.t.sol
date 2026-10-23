// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {EnvelopeBindingPolicy as LegBindingPolicy} from "../contracts/policies/EnvelopeBindingPolicy.sol";

/**
 * @title LegBindingPolicyTest
 * @notice What this suite is FOR: every one of these refusals was a settlement that succeeded on Hoodi on
 *         2026-07-31, with a validly signed proof belonging to another transfer. A positive test alone would
 *         prove nothing here: the engine permits an action no policy objects to, so "it settled" is
 *         compatible with "nothing was checked". Each negative below names the live transaction it closes.
 */
contract EnvelopeBindingPolicyTest is Test {
    LegBindingPolicy internal policy;

    address internal constant ENGINE = address(0xE9E9);
    address internal constant OWNER = address(0x0BEE);
    address internal constant WRAPPER = address(0xA11CE);
    address internal constant ORCH = address(0x0FC1);
    address internal constant BFI = address(0xB71);

    bytes16 internal constant UETR = bytes16(0x538a859d49a9960cbce077e6d61df36f);
    uint256 internal constant AMOUNT = 925_000_000;
    uint32 internal constant TTL = 300;
    uint32 internal constant SKEW = 60;

    function setUp() public {
        policy = new LegBindingPolicy(ENGINE, OWNER);
        vm.warp(1_785_500_000);
        vm.prank(OWNER);
        policy.setBinding(WRAPPER, TTL, SKEW, false);
    }

    // ── helpers ───────────────────────────────────────────────────────────────────────────────────────
    function _params(address from, address to, uint256 amount) internal pure returns (bytes[] memory p) {
        // The engine hands each value as a standalone abi.encode of ONE value, not a packed word.
        p = new bytes[](3);
        p[0] = abi.encode(from);
        p[1] = abi.encode(to);
        p[2] = abi.encode(amount);
    }

    function _item(bytes16 uetr, string memory code, bytes32 cdh, uint256 ts, bool verdict)
        internal
        pure
        returns (LegBindingPolicy.Item memory it)
    {
        it.kind = 0;
        it.orgId = keccak256("org");
        it.sig = LegBindingPolicy.Sig({
            uetr: uetr,
            checkCode: code,
            verdict: verdict,
            canonicalDataHash: cdh,
            policyRef: keccak256("policy:mandala-monorepo"),
            timestamp: ts
        });
        it.r = bytes32(uint256(1));
        it.s = bytes32(uint256(2));
        it.qx = bytes32(uint256(3));
        it.qy = bytes32(uint256(4));
    }

    /// A well-formed context bound to (ORCH -> BFI, AMOUNT, WRAPPER), the leg the tests present.
    function _boundCtx(uint256 ts) internal view returns (bytes memory) {
        string[3] memory codes = ["PC01", "CFM01", "SAN01"];
        LegBindingPolicy.Item[] memory items = new LegBindingPolicy.Item[](3);
        for (uint256 i; i < 3; ++i) {
            items[i] = _item(UETR, codes[i], policy.commitment(UETR, ORCH, BFI, AMOUNT, WRAPPER, codes[i]), ts, true);
        }
        return abi.encode(items);
    }

    function _run(bytes[] memory p, bytes memory ctx) internal view returns (LegBindingPolicy.PolicyResult) {
        return policy.run(ORCH, WRAPPER, bytes4(0xa9059cbb), p, ctx);
    }

    /// The nullifier preimage, spelled out rather than read back from the contract: a test that asks the
    /// contract for the key it is checking asserts self-consistency and would survive any change to it.
    function _key(address subject, bytes16 uetr, address from, address to, uint256 amount)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(subject, uetr, from, to, amount));
    }

    /// A context bound to an arbitrary leg of the SAME payment on the SAME wrapper: the UC2c shape.
    function _boundCtxFor(address from, address to, uint256 amount, uint256 ts) internal view returns (bytes memory) {
        string[3] memory codes = ["SAN01", "SAN02", "TR01"];
        LegBindingPolicy.Item[] memory items = new LegBindingPolicy.Item[](3);
        for (uint256 i; i < 3; ++i) {
            items[i] = _item(UETR, codes[i], policy.commitment(UETR, from, to, amount, WRAPPER, codes[i]), ts, true);
        }
        return abi.encode(items);
    }

    // ── the positive, and it must return Continue and not Allowed ──────────────────────────────────────
    function test_boundProofPasses() public view {
        LegBindingPolicy.PolicyResult r = _run(_params(ORCH, BFI, AMOUNT), _boundCtx(block.timestamp));
        assertEq(uint256(r), uint256(LegBindingPolicy.PolicyResult.Continue));
    }

    /// An `Allowed` here would short-circuit the engine and silently disable the signature re-verification
    /// behind this policy. This assertion is the one that keeps the rest of the pipeline alive.
    function test_neverReturnsAllowed() public view {
        LegBindingPolicy.PolicyResult r = _run(_params(ORCH, BFI, AMOUNT), _boundCtx(block.timestamp));
        assertTrue(r != LegBindingPolicy.PolicyResult.Allowed);
    }

    // ── the negatives, each closing a measured live acceptance ─────────────────────────────────────────

    /// Closes probe `foreign-binding`, which SETTLED as 0x7f5b11d2…a40e1a: a proof naming another beneficiary.
    function test_refusesForeignBeneficiary() public {
        bytes memory ctx = _boundCtx(block.timestamp);
        vm.expectRevert(
            abi.encodeWithSelector(
                LegBindingPolicy.PolicyRejected.selector,
                "LegBindingPolicy: proof is not bound to this transfer"
            )
        );
        _run(_params(ORCH, address(0xDEAD), AMOUNT), ctx);
    }

    function test_refusesForeignAmount() public {
        bytes memory ctx = _boundCtx(block.timestamp);
        vm.expectRevert(
            abi.encodeWithSelector(
                LegBindingPolicy.PolicyRejected.selector,
                "LegBindingPolicy: proof is not bound to this transfer"
            )
        );
        _run(_params(ORCH, BFI, AMOUNT + 1), ctx);
    }

    /// The UC2a case: one blob presented on two legs. Same context, a different wrapper as `subject`, and it
    /// must fail: `asset` is the strongest field in the commitment because it IS the calling contract.
    function test_refusesTheSameProofOnAnotherWrapper() public {
        bytes memory ctx = _boundCtx(block.timestamp);
        address otherWrapper = address(0xB0B);
        vm.prank(OWNER);
        policy.setBinding(otherWrapper, TTL, SKEW, false);
        vm.expectRevert(
            abi.encodeWithSelector(
                LegBindingPolicy.PolicyRejected.selector,
                "LegBindingPolicy: proof is not bound to this transfer"
            )
        );
        policy.run(ORCH, otherWrapper, bytes4(0xa9059cbb), _params(ORCH, BFI, AMOUNT), ctx);
    }

    /// Closes probe `stale`, which SETTLED as 0x8285accb…28aa71 with a proof signed 400 days earlier.
    function test_refusesStaleProof() public {
        bytes memory ctx = _boundCtx(block.timestamp - TTL - 1);
        vm.expectRevert(
            abi.encodeWithSelector(
                LegBindingPolicy.PolicyRejected.selector, "LegBindingPolicy: proof is stale"
            )
        );
        _run(_params(ORCH, BFI, AMOUNT), ctx);
    }

    function test_acceptsAProofAtTheEdgeOfTheWindow() public view {
        // Exactly at the boundary is still inside it. A window whose edge is ambiguous produces refusals
        // nobody can reproduce.
        LegBindingPolicy.PolicyResult r = _run(_params(ORCH, BFI, AMOUNT), _boundCtx(block.timestamp - TTL));
        assertEq(uint256(r), uint256(LegBindingPolicy.PolicyResult.Continue));
    }

    /// A proof stamped slightly ahead of the block is tolerated, because block timestamps trail wall clock;
    /// far ahead is refused. Without the skew this is sporadic and reads as RPC flakiness.
    function test_toleratesSkewButRefusesTheFuture() public {
        LegBindingPolicy.PolicyResult r = _run(_params(ORCH, BFI, AMOUNT), _boundCtx(block.timestamp + SKEW));
        assertEq(uint256(r), uint256(LegBindingPolicy.PolicyResult.Continue));

        bytes memory ahead = _boundCtx(block.timestamp + SKEW + 1);
        vm.expectRevert(
            abi.encodeWithSelector(
                LegBindingPolicy.PolicyRejected.selector,
                "LegBindingPolicy: proof timestamp is ahead of the block"
            )
        );
        _run(_params(ORCH, BFI, AMOUNT), ahead);
    }

    /// Inside the skew window the naive `block.timestamp - s.timestamp` underflows. This asserts the
    /// formulation, by proving a near-future proof yields Continue rather than a panic.
    function test_nearFutureDoesNotUnderflow() public view {
        LegBindingPolicy.PolicyResult r = _run(_params(ORCH, BFI, AMOUNT), _boundCtx(block.timestamp + 5));
        assertEq(uint256(r), uint256(LegBindingPolicy.PolicyResult.Continue));
    }

    function test_refusesItemsThatDisagreeOnTheUetr() public {
        LegBindingPolicy.Item[] memory items = new LegBindingPolicy.Item[](2);
        items[0] =
            _item(UETR, "PC01", policy.commitment(UETR, ORCH, BFI, AMOUNT, WRAPPER, "PC01"), block.timestamp, true);
        bytes16 other = bytes16(uint128(uint256(bytes32(UETR)) ^ 1));
        items[1] =
            _item(other, "CFM01", policy.commitment(other, ORCH, BFI, AMOUNT, WRAPPER, "CFM01"), block.timestamp, true);
        vm.expectRevert(
            abi.encodeWithSelector(
                LegBindingPolicy.PolicyRejected.selector, "LegBindingPolicy: items disagree on the uetr"
            )
        );
        _run(_params(ORCH, BFI, AMOUNT), abi.encode(items));
    }

    function test_refusesANegativeVerdict() public {
        LegBindingPolicy.Item[] memory items = new LegBindingPolicy.Item[](1);
        items[0] =
            _item(UETR, "PC01", policy.commitment(UETR, ORCH, BFI, AMOUNT, WRAPPER, "PC01"), block.timestamp, false);
        vm.expectRevert(
            abi.encodeWithSelector(
                LegBindingPolicy.PolicyRejected.selector,
                "LegBindingPolicy: a check carries a negative verdict"
            )
        );
        _run(_params(ORCH, BFI, AMOUNT), abi.encode(items));
    }

    function test_refusesEmptyAndAbsentContext() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                LegBindingPolicy.PolicyRejected.selector, "LegBindingPolicy: no compliance proof supplied"
            )
        );
        _run(_params(ORCH, BFI, AMOUNT), "");

        LegBindingPolicy.Item[] memory none = new LegBindingPolicy.Item[](0);
        vm.expectRevert(
            abi.encodeWithSelector(
                LegBindingPolicy.PolicyRejected.selector, "LegBindingPolicy: empty compliance proof"
            )
        );
        _run(_params(ORCH, BFI, AMOUNT), abi.encode(none));
    }

    /// Installed without its parameter names, the engine supplies fewer values. Say which, rather than
    /// decoding whatever arrived and binding against a zero address.
    function test_refusesWhenInstalledWithoutItsParameterNames() public {
        bytes[] memory two = new bytes[](2);
        two[0] = abi.encode(ORCH);
        two[1] = abi.encode(BFI);
        // Built BEFORE expectRevert: `_boundCtx` calls `commitment` externally, so evaluating it after the
        // cheatcode consumes the expectation on a call that succeeds, and the test passes vacuously.
        bytes memory ctx = _boundCtx(block.timestamp);
        vm.expectRevert(
            abi.encodeWithSelector(
                LegBindingPolicy.PolicyRejected.selector,
                "LegBindingPolicy: expected 3 parameters (from,to,amount) - installed without its names"
            )
        );
        _run(two, ctx);
    }

    // ── the no-op property that makes a per-wrapper rollout possible ───────────────────────────────────
    function test_unconfiguredTargetIsANoOp() public view {
        // Not merely permissive: it must not even look at the context, so an unarmed wrapper cannot be
        // broken by a malformed blob.
        LegBindingPolicy.PolicyResult r =
            policy.run(ORCH, address(0xDEAD), bytes4(0xa9059cbb), new bytes[](0), hex"deadbeef");
        assertEq(uint256(r), uint256(LegBindingPolicy.PolicyResult.Continue));
    }

    function test_clearBindingIsTheRollback() public {
        vm.prank(OWNER);
        policy.clearBinding(WRAPPER);
        assertFalse(policy.binding(WRAPPER).enabled);
        // A proof bound to nothing at all now passes, because the target is unarmed again.
        LegBindingPolicy.Item[] memory items = new LegBindingPolicy.Item[](1);
        items[0] = _item(UETR, "PC01", bytes32(uint256(0xbad)), block.timestamp, true);
        assertEq(
            uint256(_run(_params(ORCH, BFI, AMOUNT), abi.encode(items))),
            uint256(LegBindingPolicy.PolicyResult.Continue)
        );
    }

    // ── the nullifier ─────────────────────────────────────────────────────────────────────────────────
    function test_singleUseRefusesTheSecondPresentation() public {
        vm.prank(OWNER);
        policy.setBinding(WRAPPER, TTL, SKEW, true);
        bytes memory ctx = _boundCtx(block.timestamp);
        bytes[] memory p = _params(ORCH, BFI, AMOUNT);

        assertEq(uint256(_run(p, ctx)), uint256(LegBindingPolicy.PolicyResult.Continue));
        vm.prank(ENGINE);
        policy.postRun(ORCH, WRAPPER, bytes4(0xa9059cbb), p, ctx);

        vm.expectRevert(
            abi.encodeWithSelector(
                LegBindingPolicy.PolicyRejected.selector, "LegBindingPolicy: proof already used"
            )
        );
        _run(p, ctx);
    }

    /// The nullifier is per target, so one settlement's proof may legitimately back a leg on each wrapper.
    function test_nullifierIsPerTarget() public {
        address second = address(0xB0B);
        vm.startPrank(OWNER);
        policy.setBinding(WRAPPER, TTL, SKEW, true);
        policy.setBinding(second, TTL, SKEW, true);
        vm.stopPrank();

        bytes memory ctx = _boundCtx(block.timestamp);
        bytes[] memory p = _params(ORCH, BFI, AMOUNT);
        vm.prank(ENGINE);
        policy.postRun(ORCH, WRAPPER, bytes4(0xa9059cbb), p, ctx);

        // Asserted on the REAL key. An earlier version of this test asserted a digest that was never a
        // candidate, so it held whether the nullifier was per-target or global: coverage that reads as
        // present and is not.
        assertTrue(policy.isConsumed(_key(WRAPPER, UETR, ORCH, BFI, AMOUNT)), "the burned target must be spent");
        assertFalse(policy.isConsumed(_key(second, UETR, ORCH, BFI, AMOUNT)), "another target must be untouched");
    }

    /**
     * One write per CONTEXT, not one per check. UC2a depends on the per-target part (it presents the same uetr
     * on wCBDC-INR and wDT-INR, and both legs must pass); this pins the per-context part, so a caller cannot
     * replay a spent context by dropping one of its checks and changing the digest.
     */
    function test_nullifierIsPerContextNotPerCheck() public {
        vm.prank(OWNER);
        policy.setBinding(WRAPPER, TTL, SKEW, true);
        bytes[] memory p = _params(ORCH, BFI, AMOUNT);
        bytes memory five = _boundCtx(block.timestamp);
        vm.prank(ENGINE);
        policy.postRun(ORCH, WRAPPER, bytes4(0xa9059cbb), p, five);
        assertTrue(policy.isConsumed(_key(WRAPPER, UETR, ORCH, BFI, AMOUNT)));

        // A context with a DIFFERENT item count, same (target, uetr): already spent, so still refused.
        LegBindingPolicy.Item[] memory one = new LegBindingPolicy.Item[](1);
        one[0] = _item(UETR, "PC01", policy.commitment(UETR, ORCH, BFI, AMOUNT, WRAPPER, "PC01"), block.timestamp, true);
        vm.expectRevert(
            abi.encodeWithSelector(
                LegBindingPolicy.PolicyRejected.selector, "LegBindingPolicy: proof already used"
            )
        );
        _run(p, abi.encode(one));
    }

    /**
     * THE UC2c PROPERTY. Three legs of one payment, one uetr, one wrapper, and all three must settle. Under a
     * key of (subject, uetr) this test was impossible to write: leg 1 spent the only key there was and legs 2
     * and 3 reverted "proof already used", which is why the corridor carried three UETRs and then, briefly,
     * three wrappers for one coin. Neither detour is needed once the key names the leg.
     */
    function test_threeLegsOfOnePaymentShareOneUetrOnOneWrapper() public {
        address provider = address(0xF00D);
        address sender = ORCH;
        address receiver = BFI;
        vm.prank(OWNER);
        policy.setBinding(WRAPPER, TTL, SKEW, true);

        // provider -> sender (on-ramp), sender -> receiver (crossing), receiver -> provider (off-ramp)
        address[3] memory froms = [provider, sender, receiver];
        address[3] memory tos = [sender, receiver, provider];
        for (uint256 i; i < 3; ++i) {
            bytes[] memory p = _params(froms[i], tos[i], AMOUNT);
            bytes memory ctx = _boundCtxFor(froms[i], tos[i], AMOUNT, block.timestamp);
            assertEq(
                uint256(policy.run(ORCH, WRAPPER, bytes4(0xa9059cbb), p, ctx)),
                uint256(LegBindingPolicy.PolicyResult.Continue),
                "every leg of the payment must pass under the shared uetr"
            );
            vm.prank(ENGINE);
            policy.postRun(ORCH, WRAPPER, bytes4(0xa9059cbb), p, ctx);
        }

        // Three distinct keys, all spent: the assertion the old preimage could not satisfy.
        assertTrue(policy.isConsumed(_key(WRAPPER, UETR, provider, sender, AMOUNT)));
        assertTrue(policy.isConsumed(_key(WRAPPER, UETR, sender, receiver, AMOUNT)));
        assertTrue(policy.isConsumed(_key(WRAPPER, UETR, receiver, provider, AMOUNT)));
    }

    /// And the guarantee that must survive the widening: replaying ONE of those legs is still refused. Without
    /// this, the test above is indistinguishable from having removed the nullifier.
    function test_replayingOneOfThoseLegsIsStillRefused() public {
        address provider = address(0xF00D);
        vm.prank(OWNER);
        policy.setBinding(WRAPPER, TTL, SKEW, true);

        bytes[] memory p = _params(provider, ORCH, AMOUNT);
        bytes memory ctx = _boundCtxFor(provider, ORCH, AMOUNT, block.timestamp);
        assertEq(
            uint256(policy.run(ORCH, WRAPPER, bytes4(0xa9059cbb), p, ctx)),
            uint256(LegBindingPolicy.PolicyResult.Continue)
        );
        vm.prank(ENGINE);
        policy.postRun(ORCH, WRAPPER, bytes4(0xa9059cbb), p, ctx);

        vm.expectRevert(
            abi.encodeWithSelector(
                LegBindingPolicy.PolicyRejected.selector, "LegBindingPolicy: proof already used"
            )
        );
        policy.run(ORCH, WRAPPER, bytes4(0xa9059cbb), p, ctx);
    }

    /// A leg differing ONLY by amount is a different leg, and its own proof must pass after the first is spent.
    /// Amount is in the key precisely because two transfers between the same parties are two payments.
    function test_sameParties_differentAmount_isADifferentLeg() public {
        vm.prank(OWNER);
        policy.setBinding(WRAPPER, TTL, SKEW, true);

        bytes[] memory p1 = _params(ORCH, BFI, AMOUNT);
        bytes memory c1 = _boundCtxFor(ORCH, BFI, AMOUNT, block.timestamp);
        vm.prank(ENGINE);
        policy.postRun(ORCH, WRAPPER, bytes4(0xa9059cbb), p1, c1);

        assertEq(
            uint256(
                policy.run(
                    ORCH,
                    WRAPPER,
                    bytes4(0xa9059cbb),
                    _params(ORCH, BFI, AMOUNT + 1),
                    _boundCtxFor(ORCH, BFI, AMOUNT + 1, block.timestamp)
                )
            ),
            uint256(LegBindingPolicy.PolicyResult.Continue)
        );
    }

    /**
     * `postRun` now reads the leg out of the parameters, so it has the same dependency on the parameter names
     * that `run` has. Storing a key derived from fewer values would put the nullifier under a preimage `run`
     * never looks up: single-use silently off, which is the exact failure shape this contract exists to
     * refuse. It must revert instead, and say the same thing `run` says.
     */
    function test_postRunRefusesWhenInstalledWithoutItsParameterNames() public {
        vm.prank(OWNER);
        policy.setBinding(WRAPPER, TTL, SKEW, true);
        bytes memory ctx = _boundCtx(block.timestamp);
        bytes[] memory two = new bytes[](2);
        two[0] = abi.encode(ORCH);
        two[1] = abi.encode(BFI);

        vm.prank(ENGINE);
        vm.expectRevert(
            abi.encodeWithSelector(
                LegBindingPolicy.PolicyRejected.selector,
                "LegBindingPolicy: expected 3 parameters (from,to,amount) - installed without its names"
            )
        );
        policy.postRun(ORCH, WRAPPER, bytes4(0xa9059cbb), two, ctx);
    }

    /// An ungated nullifier writer is a free griefing primitive: anyone pre-burns a digest and the settlement
    /// reverts for a proof never presented.
    function test_postRunIsEngineOnly() public {
        vm.prank(OWNER);
        policy.setBinding(WRAPPER, TTL, SKEW, true);
        bytes memory ctx = _boundCtx(block.timestamp);
        vm.expectRevert(LegBindingPolicy.Unauthorized.selector);
        policy.postRun(ORCH, WRAPPER, bytes4(0xa9059cbb), _params(ORCH, BFI, AMOUNT), ctx);
    }

    // ── configuration guards ──────────────────────────────────────────────────────────────────────────
    function test_setBindingIsOwnerOnlyAndRejectsAFootgunTtl() public {
        vm.expectRevert(LegBindingPolicy.NotOwner.selector);
        policy.setBinding(WRAPPER, TTL, SKEW, false);

        vm.startPrank(OWNER);
        vm.expectRevert(
            abi.encodeWithSelector(LegBindingPolicy.BadConfig.selector, "ttl 0 would refuse every proof")
        );
        policy.setBinding(WRAPPER, 0, SKEW, false);
        vm.expectRevert(abi.encodeWithSelector(LegBindingPolicy.BadConfig.selector, "skew > 300s"));
        policy.setBinding(WRAPPER, TTL, 301, false);
        vm.stopPrank();
    }

    /// The getter must return the key `postRun` actually WRITES, not merely a plausible one. Asserted by
    /// spending a leg and then looking it up through the getter: if the two ever diverge, the tooling would
    /// report a spent proof as unspent and single-use would look switched off from the outside.
    function test_nullifierGetterMatchesWhatPostRunWrites() public {
        vm.prank(OWNER);
        policy.setBinding(WRAPPER, TTL, SKEW, true);
        bytes[] memory p = _params(ORCH, BFI, AMOUNT);
        // Built BEFORE the prank: `_boundCtx` calls `commitment` externally, and that call would consume it:
        // the same trap this file already documents for `expectRevert`.
        bytes memory ctx = _boundCtx(block.timestamp);
        vm.prank(ENGINE);
        policy.postRun(ORCH, WRAPPER, bytes4(0xa9059cbb), p, ctx);

        bytes32 k = policy.nullifier(WRAPPER, UETR, ORCH, BFI, AMOUNT);
        assertEq(k, _key(WRAPPER, UETR, ORCH, BFI, AMOUNT), "the getter must compute the documented preimage");
        assertTrue(policy.isConsumed(k), "and it must be the key postRun wrote");
    }

    /// The generators must read the preimage from the chain rather than reimplement it. This pins the tag.
    function test_commitmentIsDomainTagged() public view {
        assertEq(policy.BINDING_DOMAIN(), keccak256("LegBinding/v2"));
        bytes32 untagged = keccak256(abi.encode(UETR, ORCH, BFI, AMOUNT, WRAPPER, "PC01"));
        assertTrue(policy.commitment(UETR, ORCH, BFI, AMOUNT, WRAPPER, "PC01") != untagged);
    }
}
