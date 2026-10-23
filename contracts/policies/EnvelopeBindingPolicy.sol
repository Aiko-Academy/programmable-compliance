// SPDX-License-Identifier: AGPL-3.0
// Provenance: src/common/compliance/LegBindingPolicy.sol (onchain-fx-markets, originally MIT), taken as is; only the contract name and the import paths change.
// Distributed here under AGPL-3.0. The code deployed on Hoodi is this one, byte for byte apart from metadata.
pragma solidity ^0.8.28;

/**
 * @title EnvelopeBindingPolicy
 * @notice The policy that makes `canonicalDataHash` mean something.
 *
 *         The compliance proof commits to (uetr, from, to, amount, asset) and, until this contract, nothing
 *         on chain read that commitment. Measured on Hoodi 2026-07-31: every accepted settlement carried a
 *         commitment reproducing NONE of its own value-moving legs (0/5 on UC2a, 0/4 on UC2b, 0/3 on both UC3
 *         rails), and all of them settled. Three validly signed proofs belonging to something else settled
 *         too: one naming a different beneficiary and amount, one signed 400 days earlier, and one lifted
 *         verbatim from an earlier transaction. On UC2a the SAME proof blob was presented on two proof
 *         arguments gating two legs that move different amounts to different parties, so at most one of them
 *         could ever have matched, and the accepted path depended on the commitment not being read.
 *
 *         The consequence was not that a check could be forged. `ComplianceProofPolicy` re-verifies
 *         every signature, and `RequiredChecksPolicy` requires the set to be present. It was that both
 *         did so for the WRONG TRANSFER: the right list of check codes, authentically signed, about a payment
 *         other than the one moving value.
 *
 *         This policy recomputes the commitment from what the transfer actually is and requires a match, and
 *         it bounds how old a proof may be. Four of the six fields come from the CHAIN and cannot be claimed:
 *         `to` and `amount` from the engine's extracted parameters, `asset` from `subject` (it IS the calling
 *         token), `from` from the extracted sender. Two come from the proof: `checkCode`, which the presence
 *         policy pins against the per-target configured set, and `uetr`, which nothing on chain can verify, *         see the note below, because that limit is deliberate and belongs in the documentation rather than
 *         behind an implication.
 *
 *         WHAT THIS DOES NOT CLOSE, stated rather than implied:
 *           - The `uetr` is self-declared. The gated selector is `transfer(address,uint256)`, whose calldata
 *             is (to, amount); the engine's payload carries no reference field, and the orchestrators'
 *             bytecode is frozen, so no correlation id can be introduced before the leg. The policy therefore
 *             enforces only that every item of one context names the SAME uetr. A settlement executed under
 *             an intent uetr different from the one its proof names is not detectable here.
 *           - Consequently, a proof can be reused across two settlements whose (from, to, amount, asset) are
 *             identical, within the TTL. With fixed demo amounts and fixed party wallets that is the normal
 *             case, not a corner, which is why `singleUse` exists and why it is the finish line rather than a
 *             refinement. Its unit is the LEG, (asset, uetr, from, to, amount), deliberately the same tuple
 *             the commitment binds, so that the anti-replay is neither coarser nor finer than the thing it
 *             protects. A payment may therefore carry ONE uetr across several legs of ONE wrapper, which is
 *             what UC2c needs and what a key of (asset, uetr) alone made impossible; see `_legNullifier`.
 *           - `from` on a plain `transfer` is the caller, which on every gated settlement leg is the
 *             orchestrator, not the originating party. The party binding survives off-chain and in the
 *             `…Settled(uetr, ofi, bfi, …)` event, tied to the leg by the unverifiable uetr. It becomes
 *             chain-verifiable only on the source `transferFrom` legs, where the real payer is in calldata.
 *
 *         PIPELINE CONTRACT, inherited from RequiredChecksPolicy and equally non-optional:
 *           - it returns `Continue`, NEVER `Allowed`. The engine's `run` stops at the first policy returning
 *             `Allowed`, so a policy that allowed would silently disable every policy behind it, here, the
 *             signature re-verification.
 *           - a target with no configuration is a NO-OP, so rollout is per wrapper and installing the
 *             contract changes nothing until a binding is written. `clearBinding` is the rollback, one
 *             transaction, pipeline untouched.
 *           - the three parameter names (`from`, `to`, `amount`) are written by `addPolicyAt` and there is no
 *             setter for names alone. Installed without them, every gated transfer of that target reverts.
 *
 *         It touches no orchestrator, no wrapper, no selector, no event and no address: the settlement
 *         surface callers integrate against is unchanged. What changes is the VALUE the node places in the
 *         existing `canonicalDataHash` field, which is why the preimage carries a domain tag, an auditor
 *         recomputing a first-generation proof gets a clean miss rather than an ambiguous match.
 */
contract EnvelopeBindingPolicy {
    /// @dev Mirrors the engine's enum exactly: None = 0, Allowed = 1, Continue = 2.
    enum PolicyResult {
        None,
        Allowed,
        Continue
    }

    /// @dev Same signature as the engine's own error, so the engine wraps it as PolicyRunRejected.
    error PolicyRejected(string reason);
    error Unauthorized();
    error NotOwner();
    error BadConfig(string what);

    /// @dev The context shape the proof policy decodes, reproduced so this policy can read the same blob.
    struct Sig {
        bytes16 uetr;
        string checkCode;
        bool verdict;
        bytes32 canonicalDataHash;
        bytes32 policyRef;
        uint256 timestamp;
    }

    struct Item {
        uint8 kind;
        bytes32 orgId;
        Sig sig;
        bytes32 r;
        bytes32 s;
        bytes32 qx;
        bytes32 qy;
    }

    struct Config {
        bool enabled; // false => NO-OP for this target. Every target starts here.
        uint32 ttl; // seconds a proof stays acceptable, measured from sig.timestamp
        uint32 skew; // tolerance for a proof timestamp ahead of the block
        bool singleUse; // the nullifier: a proof may back exactly one transfer per target
    }

    /// @notice Separates this preimage from the unenforced first generation. Part of the hash, not decoration.
    bytes32 public constant BINDING_DOMAIN = keccak256("LegBinding/v2");

    address public owner;
    address public immutable policyEngine;

    mapping(address target => Config) private _cfg;
    mapping(bytes32 nullifier => bool) private _consumed;

    event BindingSet(address indexed target, uint32 ttl, uint32 skew, bool singleUse);
    event BindingCleared(address indexed target);
    event OwnerTransferred(address indexed from, address indexed to);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyPolicyEngine() {
        if (msg.sender != policyEngine) revert Unauthorized();
        _;
    }

    constructor(address engine, address initialOwner) {
        require(engine != address(0) && initialOwner != address(0), "leg-binding: zero arg");
        policyEngine = engine;
        owner = initialOwner;
    }

    function transferOwnership(address to) external onlyOwner {
        require(to != address(0), "leg-binding: zero owner");
        emit OwnerTransferred(owner, to);
        owner = to;
    }

    // ── configuration, per target ─────────────────────────────────────────────────────────────────────
    /**
     * @notice Arm the binding for one target wrapper.
     * @param ttl   How long a proof stays acceptable. Measured latency between signing and inclusion on the
     *              live rails was 6 to 11 seconds, so 300 leaves ~27x headroom. A TTL wide enough to be
     *              invisible is a TTL that proves nothing.
     * @param skew  Tolerance for a proof stamped ahead of the block. Block timestamps trail wall clock, and
     *              a zero tolerance produces sporadic refusals that read as RPC flakiness.
     */
    function setBinding(address target, uint32 ttl, uint32 skew, bool singleUse) external onlyOwner {
        if (target == address(0)) revert BadConfig("zero target");
        // Enabling with ttl 0 would refuse every proof ever presented. That is a mistake, not a policy.
        if (ttl == 0) revert BadConfig("ttl 0 would refuse every proof");
        if (skew > 300) revert BadConfig("skew > 300s");
        _cfg[target] = Config(true, ttl, skew, singleUse);
        emit BindingSet(target, ttl, skew, singleUse);
    }

    /// @notice The rollback lever: back to a NO-OP for this target, without touching the pipeline.
    function clearBinding(address target) external onlyOwner {
        delete _cfg[target];
        emit BindingCleared(target);
    }

    function binding(address target) external view returns (Config memory) {
        return _cfg[target];
    }

    /// @dev The parameter is `key`, not `nullifier`: since `nullifier(...)` became a function on this
    ///      contract, a parameter of that name SHADOWS it inside this body. Harmless here, the body only
    ///      indexes a mapping, but a reader who then writes `nullifier(subject, uetr, …)` two lines further
    ///      would be calling nothing of the sort, and Slither flags it for exactly that reason.
    function isConsumed(bytes32 key) external view returns (bool) {
        return _consumed[key];
    }

    /**
     * @notice The commitment, as this contract computes it. Exposed so the off-chain generators and the
     *         verification tooling read it from the chain instead of reimplementing the preimage, two
     *         independent reimplementations of one hash is how twins drift.
     */
    function commitment(
        bytes16 uetr,
        address from,
        address to,
        uint256 amount,
        address asset,
        string calldata checkCode
    ) external pure returns (bytes32) {
        return keccak256(abi.encode(BINDING_DOMAIN, uetr, from, to, amount, asset, checkCode));
    }

    /**
     * @notice The anti-replay key, as this contract computes it. Exposed for the same reason `commitment` is:
     *         `prove-nullifier.mjs` has to ask whether a given leg is spent, and the only alternative to
     *         reading the preimage from here is a second implementation of it in JavaScript. There already was
     *         one, keyed `(subject, uetr)`, and it had to be found and changed by hand when this preimage
     *         gained three fields, which is the drift this getter exists to end rather than repeat.
     */
    function nullifier(address subject, bytes16 uetr, address from, address to, uint256 amount)
        external
        pure
        returns (bytes32)
    {
        return _legNullifier(subject, uetr, from, to, amount);
    }

    // ── the pipeline hooks ────────────────────────────────────────────────────────────────────────────
    function onInstall(bytes4) external view onlyPolicyEngine {}

    function onUninstall(bytes4) external view onlyPolicyEngine {}

    /**
     * @notice Burn this context's proofs so they cannot back a second transfer on this target.
     * @dev    `onlyPolicyEngine` is mandatory rather than hygiene: an ungated nullifier writer is a free
     *         griefing primitive, anyone pre-burns a digest and the settlement reverts for a proof that was
     *         never presented. Note the binding itself already narrows this: presenting a proof requires
     *         `from == the orchestrator`, which requires SETTLER_ROLE, so a proof read off public calldata
     *         cannot be burned by its reader.
     */
    function postRun(address, address subject, bytes4, bytes[] calldata parameters, bytes calldata context)
        external
        onlyPolicyEngine
    {
        Config memory c = _cfg[subject];
        if (!c.enabled || !c.singleUse) return;
        // ONE nullifier per LEG, and still only ONE per context: the two are different axes and only the
        // second is a gas question. Dropping an item does not evade the key, it is computed from the leg and
        // the uetr, neither of which an item carries, and adding one cannot help, since every item must
        // still verify its P-256 signature and reproduce this leg's commitment. Keying per ITEM was the
        // arrangement rejected on cost: one cold SLOAD plus one SSTORE each, 20 items across four armed legs
        // on a UC2a settlement, about 458,000 gas for a distinction that does not exist. Naming the leg costs
        // none of that. It is one SSTORE either way; what it adds is three calldata decodes.
        //
        // The engine hands `postRun` the SAME extracted values it handed `run` (PolicyEngine.run, one call
        // apart), so the leg is already here and does not have to be threaded through storage.
        if (parameters.length != 3) {
            // Never write a key nobody will ever look up. `run` computes its key from three parameters; a
            // `postRun` storing one derived from fewer would leave single-use silently switched off, which is
            // the failure this contract exists to make impossible rather than one it may commit itself.
            revert PolicyRejected("LegBindingPolicy: expected 3 parameters (from,to,amount) - installed without its names");
        }
        _consumed[
            _legNullifier(
                subject,
                _uetrOf(context),
                abi.decode(parameters[0], (address)),
                abi.decode(parameters[1], (address)),
                abi.decode(parameters[2], (uint256))
            )
        ] = true;
    }

    function run(
        address, /*caller*/
        address subject,
        bytes4, /*selector, deliberately unconstrained, so the same policy works on transferFrom*/
        bytes[] calldata parameters,
        bytes calldata context
    )
        external
        view
        returns (PolicyResult)
    {
        Config memory c = _cfg[subject];
        if (!c.enabled) return PolicyResult.Continue; // unconfigured target: no-op. Rollout is per wrapper.

        // Installed without its parameter names, the engine hands over fewer values than this needs. Say so,
        // rather than decoding whatever arrived and binding against a zero address.
        if (parameters.length != 3) {
            revert PolicyRejected("LegBindingPolicy: expected 3 parameters (from,to,amount) - installed without its names");
        }
        address from = abi.decode(parameters[0], (address));
        address to = abi.decode(parameters[1], (address));
        uint256 amount = abi.decode(parameters[2], (uint256));

        if (context.length == 0) {
            revert PolicyRejected("LegBindingPolicy: no compliance proof supplied");
        }
        Item[] memory items = abi.decode(context, (Item[]));
        if (items.length == 0) {
            revert PolicyRejected("LegBindingPolicy: empty compliance proof");
        }

        bytes16 uetr = items[0].sig.uetr;
        uint256 n = items.length;
        for (uint256 i; i < n; ++i) {
            Sig memory s = items[i].sig;

            // One transaction, one payment. A context assembled from two different settlements' items is
            // refused here even though every signature in it is authentic.
            if (s.uetr != uetr) {
                revert PolicyRejected("LegBindingPolicy: items disagree on the uetr");
            }
            if (!s.verdict) {
                revert PolicyRejected("LegBindingPolicy: a check carries a negative verdict");
            }
            if (s.timestamp > uint256(block.timestamp) + c.skew) {
                revert PolicyRejected("LegBindingPolicy: proof timestamp is ahead of the block");
            }
            // Written as an addition on the left, never as `block.timestamp - s.timestamp`: inside the skew
            // window that subtraction underflows and surfaces as panic 0x11 wrapped in PolicyRunError, which
            // is a legible refusal turned into an unreadable one.
            if (s.timestamp + c.ttl < block.timestamp) {
                revert PolicyRejected("LegBindingPolicy: proof is stale");
            }
            if (
                s.canonicalDataHash
                    != keccak256(abi.encode(BINDING_DOMAIN, uetr, from, to, amount, subject, s.checkCode))
            ) {
                revert PolicyRejected("LegBindingPolicy: proof is not bound to this transfer");
            }
        }
        // Outside the loop, because the unit of replay is the leg and not the check. Reads one slot per
        // gated leg instead of one per item.
        if (c.singleUse && _consumed[_legNullifier(subject, uetr, from, to, amount)]) {
            revert PolicyRejected("LegBindingPolicy: proof already used");
        }
        return PolicyResult.Continue; // NEVER Allowed
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == 0x01ffc9a7; // ERC-165
    }

    /**
     * @dev Keyed by the LEG, not by the payment. Per TARGET, so one settlement's context may legitimately back
     *      a leg on each wrapper it touches, UC2a presents the same uetr on wCBDC-INR and on wDT-INR, and both
     *      must pass. And per (from, to, amount), so a payment whose legs share ONE uetr on ONE wrapper passes
     *      too: UC2c moves provider→sender, sender→receiver, receiver→provider on the same wUSDX, and under a
     *      key of (subject, uetr) alone the first leg spent the only key there was and the other two reverted
     *      "proof already used". Three UETRs, or three wrappers for one coin, were both ways of buying back
     *      that key, the first splits the payment an auditor has to reassemble, the second breaks the property
     *      that the coin is never wrapped twice, and neither was needed.
     *
     *      This does not widen what a proof may do. The commitment checked immediately above binds each proof
     *      to (uetr, from, to, amount, asset, checkCode), so a context that passes `run` on this subject under
     *      this uetr has ALREADY named this leg; keying the nullifier by the same fields simply stops the
     *      anti-replay from being coarser than the binding it protects. What it refuses is unchanged where it
     *      matters: presenting the same leg twice. What it stops refusing is a DIFFERENT leg, which never was
     *      a replay and could not have borrowed the first leg's proof anyway.
     */
    function _legNullifier(address subject, bytes16 uetr, address from, address to, uint256 amount)
        private
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(subject, uetr, from, to, amount));
    }

    /**
     * @dev The uetr the context is keyed by. It still decodes the whole `Item[]` to reach one word, which costs
     *      roughly 4,000 gas per leg, and that is a deliberate trade: reading the offset out of calldata in
     *      assembly would save it, and this contract's job is to be reviewable by someone deciding whether to
     *      trust a settlement rail. The saving that mattered was 20 storage writes becoming 1.
     *
     *      Safe to reach for `items[0]` because `run` has already run for this call and refused an empty
     *      context; the guard here is for a direct `postRun` from the engine on a path `run` did not precede.
     */
    function _uetrOf(bytes calldata context) private pure returns (bytes16) {
        Item[] memory items = abi.decode(context, (Item[]));
        if (items.length == 0) revert PolicyRejected("LegBindingPolicy: empty compliance proof");
        return items[0].sig.uetr;
    }
}
