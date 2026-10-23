// SPDX-License-Identifier: AGPL-3.0
// Provenance: src/common/compliance/RequiredChecksPolicy.sol (onchain-fx-markets, originally MIT), taken as is; only the contract name and the import paths change.
// Distributed here under AGPL-3.0. The code deployed on Hoodi is this one, byte for byte apart from metadata.
pragma solidity ^0.8.28;

/**
 * @title RequiredChecksPolicy
 * @notice The policy that makes an ABSENT check as fatal as a false one.
 *
 *         `ComplianceProofPolicy` re-verifies every item it is handed, and returns `Continue` for an
 *         empty context, deliberately, so it could be wired into the live wrappers before callers started
 *         emitting the proof region. That affordance outlived its migration: measured live on Hoodi, a gated
 *         settlement carrying an empty `Item[]` SETTLES, and so does one with a check dropped. Only a
 *         tampered check is refused. The per-use-case sets (UC2a 5, UC2b 4, UC3 3) were honoured by the node
 *         building the context and by nothing on chain.
 *
 *         This policy supplies the missing half: PRESENCE. Per target wrapper it holds the set of check
 *         codes that must appear, each with `verdict == true`, and reverts otherwise. Authenticity stays
 *         where it already works, this policy verifies no signature and duplicates no work.
 *
 *         PIPELINE CONTRACT, and it is not optional:
 *           - it returns `Continue`, NEVER `Allowed`. The engine's `run` STOPS at the first policy returning
 *             `Allowed`, so a policy that allowed would silently disable every policy behind it, including
 *             the proof verification.
 *           - it must be installed at POSITION 0 (`addPolicyAt(..., 0)`), for the same reason in reverse: a
 *             policy placed after one that returns `Allowed` never runs at all.
 *           - a target with no configured set is a NO-OP. Rollout is therefore per wrapper, and installing
 *             the contract changes nothing until a set is written.
 *
 *         It touches no orchestrator, no wrapper, no selector, no event and no address: the settlement
 *         surface callers integrate against is unchanged.
 */
contract RequiredChecksPolicy {
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

    /// @dev The context shape the proof policy decodes. Only `sig.checkCode` and `sig.verdict` are read here.
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

    address public owner;
    address public immutable policyEngine;

    /// @notice target wrapper => the check codes that must be present, hashed.
    mapping(address => bytes32[]) private _required;
    /// @notice target wrapper => the same codes, kept readable for operators and explorers.
    mapping(address => string[]) private _requiredCodes;

    event RequiredChecksSet(address indexed target, string[] codes);
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
        require(engine != address(0) && initialOwner != address(0), "required-checks: zero arg");
        policyEngine = engine;
        owner = initialOwner;
    }

    function transferOwnership(address to) external onlyOwner {
        require(to != address(0), "required-checks: zero owner");
        emit OwnerTransferred(owner, to);
        owner = to;
    }

    /**
     * @notice Set the checks a target wrapper's gated transfer must carry. An empty array disables the
     *         requirement for that target, which is also the state every target starts in.
     */
    function setRequiredChecks(address target, string[] calldata codes) external onlyOwner {
        delete _required[target];
        delete _requiredCodes[target];
        for (uint256 i; i < codes.length; ++i) {
            _required[target].push(keccak256(bytes(codes[i])));
            _requiredCodes[target].push(codes[i]);
        }
        emit RequiredChecksSet(target, codes);
    }

    function requiredChecks(address target) external view returns (string[] memory) {
        return _requiredCodes[target];
    }

    // ── the pipeline hooks ────────────────────────────────────────────────────────────────────────────
    function onInstall(bytes4) external view onlyPolicyEngine {}

    function onUninstall(bytes4) external view onlyPolicyEngine {}

    // solhint-disable-next-line no-empty-blocks
    function postRun(address, address, bytes4, bytes[] calldata, bytes calldata) external {}

    function run(
        address, /*caller*/
        address subject,
        bytes4, /*selector*/
        bytes[] calldata, /*parameters*/
        bytes calldata context
    )
        external
        view
        returns (PolicyResult)
    {
        bytes32[] storage req = _required[subject];
        if (req.length == 0) return PolicyResult.Continue; // not configured for this target: no-op

        // An empty or unparseable context cannot satisfy a non-empty requirement. Decoding is attempted
        // rather than assumed: a caller supplying a malformed blob must be refused here, not further down.
        if (context.length == 0) {
            revert PolicyRejected("RequiredChecksPolicy: no compliance checks supplied");
        }
        Item[] memory items = abi.decode(context, (Item[]));

        for (uint256 i; i < req.length; ++i) {
            // Written explicitly rather than left to the zero-value default: this flag decides whether a
            // required check is refused, so an analyser flagging it as never-initialised is a signal worth
            // keeping quiet permanently instead of carrying in a baseline.
            bool found = false;
            for (uint256 j; j < items.length; ++j) {
                if (items[j].sig.verdict && keccak256(bytes(items[j].sig.checkCode)) == req[i]) {
                    found = true;
                    break;
                }
            }
            if (!found) {
                revert PolicyRejected(string.concat(
                        "RequiredChecksPolicy: missing required check ", _requiredCodes[subject][i]
                    ));
            }
        }
        return PolicyResult.Continue;
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == 0x01ffc9a7; // ERC-165
    }
}
