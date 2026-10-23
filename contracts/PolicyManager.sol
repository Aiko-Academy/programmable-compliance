// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IPolicy} from "./interfaces/IPolicy.sol";
import {IPolicyManager, IExtractor} from "./interfaces/IPolicyManager.sol";

/**
 * @title PolicyManager
 * @notice The Policy Manager of the GL1 white paper (Key Feature 3): the orchestration layer between the Policy
 *         Wrappers and the evaluation modules. Written for the pack, under AGPL-3.0, with the calling convention that
 *         the policies already in service on Hoodi expect (`run`, `postRun`, `onInstall`, `onUninstall`,
 *         results None/Allowed/Continue, refusal by `PolicyRejected(reason)`), so that they plug in without
 *         changing a byte.
 *
 *         What the white paper names and this contract carries:
 *           - policies ORDERED per target and per operation (`addPolicyAt`, `getPolicies`);
 *           - a policy VERSION per target, incremented at each change, with a label
 *             (`policyVersion`, `labelPolicyVersion`) and a digest per operation (`policyDescriptor`) that the
 *             Compliance Attestation references in `policyRef`;
 *           - an ACTIVATION STATE per operation (`setActive`): when suspended, the default rule applies;
 *           - an EFFECTIVE SCOPE per target (`scopeOf`): the operations that carry at least one policy;
 *           - events for the evidencing records (each configuration change, each evaluation).
 *
 *         Semantics of `run`: policies are called in order; `Allowed` stops the chain and
 *         grants; `Continue` moves to the next one; a `PolicyRejected` revert refuses with the reason, any
 *         other revert refuses with the raw error; if the list runs out without `Allowed`, the default rule
 *         decides (refuse unless `setDefaultAllow(true)`, or per target). This is the sequence of the pipelines
 *         in service on Hoodi: presence, binding, identity, verification, none of which returns `Allowed`, on a target
 *         whose default rule is to allow.
 */
contract PolicyManager is IPolicyManager, Ownable {
    uint256 public constant MAX_POLICIES = 32;

    bool private _defaultAllow;
    mapping(address target => bool) private _attached;
    mapping(bytes4 selector => address) private _extractor;
    mapping(address target => mapping(bytes4 selector => address[])) private _policies;
    mapping(address target => mapping(bytes4 selector => mapping(address policy => bytes32[]))) private _parameterNames;
    mapping(address target => mapping(bytes4 selector => bool)) private _suspended;
    mapping(address target => bool) private _hasDefault;
    mapping(address target => bool) private _targetDefault;
    mapping(address target => uint64) private _version;
    mapping(address target => string) private _label;
    mapping(address target => bytes4[]) private _scope;

    constructor(address initialOwner, bool defaultAllow) Ownable(initialOwner) {
        _defaultAllow = defaultAllow;
        emit DefaultAllowSet(address(0), true, defaultAllow);
    }

    // ── attachement et extraction ──────────────────────────────────────────────────────────────────────
    function attach() external {
        if (_attached[msg.sender]) revert TargetAlreadyAttached(msg.sender);
        _attached[msg.sender] = true;
        emit TargetAttached(msg.sender);
    }

    function detach() external {
        if (!_attached[msg.sender]) revert TargetNotAttached(msg.sender);
        _attached[msg.sender] = false;
        emit TargetDetached(msg.sender);
    }

    function isAttached(address target) external view returns (bool) {
        return _attached[target];
    }

    function setExtractor(bytes4 selector, address extractor) external onlyOwner {
        _extractor[selector] = extractor;
        emit ExtractorSet(selector, extractor);
    }

    function getExtractor(bytes4 selector) external view returns (address) {
        return _extractor[selector];
    }

    // ── the ordered list ──────────────────────────────────────────────────────────────────────────────
    function addPolicy(address target, bytes4 selector, address policy, bytes32[] calldata parameterNames)
        external
        onlyOwner
    {
        _add(target, selector, policy, parameterNames, _policies[target][selector].length);
    }

    function addPolicyAt(
        address target,
        bytes4 selector,
        address policy,
        bytes32[] calldata parameterNames,
        uint256 position
    ) external onlyOwner {
        if (position > _policies[target][selector].length) revert InvalidConfiguration("position beyond the list");
        _add(target, selector, policy, parameterNames, position);
    }

    function removePolicy(address target, bytes4 selector, address policy) external onlyOwner {
        address[] storage list = _policies[target][selector];
        uint256 n = list.length;
        for (uint256 i; i < n; ++i) {
            if (list[i] != policy) continue;
            for (uint256 j = i; j + 1 < n; ++j) {
                list[j] = list[j + 1];
            }
            list.pop();
            delete _parameterNames[target][selector][policy];
            IPolicy(policy).onUninstall(selector);
            if (list.length == 0) _dropFromScope(target, selector);
            emit PolicyRemoved(target, selector, policy);
            _bump(target, "");
            return;
        }
        revert InvalidConfiguration("policy not in the list");
    }

    function getPolicies(address target, bytes4 selector) external view returns (address[] memory) {
        return _policies[target][selector];
    }

    function getPolicyParameterNames(address target, bytes4 selector, address policy)
        external
        view
        returns (bytes32[] memory)
    {
        return _parameterNames[target][selector][policy];
    }

    // ── version, activation, scope, default rule ───────────────────────────────────────────────
    function policyVersion(address target) external view returns (uint64) {
        return _version[target];
    }

    function policyVersionLabel(address target) external view returns (string memory) {
        return _label[target];
    }

    function labelPolicyVersion(address target, string calldata label) external onlyOwner {
        _bump(target, label);
    }

    function policyDescriptor(address target, bytes4 selector) external view returns (bytes32) {
        return keccak256(abi.encode(target, selector, _policies[target][selector], !_suspended[target][selector]));
    }

    function setActive(address target, bytes4 selector, bool active) external onlyOwner {
        _suspended[target][selector] = !active;
        emit ActivationSet(target, selector, active);
        _bump(target, "");
    }

    function isActive(address target, bytes4 selector) external view returns (bool) {
        return !_suspended[target][selector];
    }

    function scopeOf(address target) external view returns (bytes4[] memory) {
        return _scope[target];
    }

    function setDefaultAllow(bool allow) external onlyOwner {
        _defaultAllow = allow;
        emit DefaultAllowSet(address(0), true, allow);
    }

    function setTargetDefaultAllow(address target, bool set, bool allow) external onlyOwner {
        _hasDefault[target] = set;
        _targetDefault[target] = allow;
        emit DefaultAllowSet(target, set, allow);
        _bump(target, "");
    }

    // ── l'evaluation ───────────────────────────────────────────────────────────────────────────────────
    function check(Payload calldata payload) external view {
        address target = msg.sender;
        if (!_attached[target]) revert TargetNotAttached(target);
        address[] memory list = _policies[target][payload.selector];
        if (list.length == 0 || _suspended[target][payload.selector]) {
            _defaultRule(target);
            return;
        }
        Parameter[] memory extracted = _extract(payload);
        for (uint256 i; i < list.length; ++i) {
            bytes[] memory values = _values(target, payload.selector, list[i], extracted);
            try IPolicy(list[i]).run(payload.sender, target, payload.selector, values, payload.context) returns (
                IPolicy.PolicyResult r
            ) {
                if (r == IPolicy.PolicyResult.Allowed) return;
            } catch (bytes memory err) {
                _refuse(payload.selector, list[i], err);
            }
        }
        _defaultRule(target);
    }

    function run(Payload calldata payload) external {
        address target = msg.sender;
        if (!_attached[target]) revert TargetNotAttached(target);
        address[] memory list = _policies[target][payload.selector];
        uint64 version = _version[target];
        if (list.length == 0 || _suspended[target][payload.selector]) {
            _defaultRule(target);
            emit PolicyRunComplete(payload.sender, target, payload.selector, version);
            return;
        }
        Parameter[] memory extracted = _extract(payload);
        for (uint256 i; i < list.length; ++i) {
            address policy = list[i];
            bytes[] memory values = _values(target, payload.selector, policy, extracted);
            try IPolicy(policy).run(payload.sender, target, payload.selector, values, payload.context) returns (
                IPolicy.PolicyResult r
            ) {
                try IPolicy(policy).postRun(payload.sender, target, payload.selector, values, payload.context) {}
                catch (bytes memory err) {
                    revert PolicyPostRunError(payload.selector, policy, err);
                }
                if (r == IPolicy.PolicyResult.Allowed) {
                    emit PolicyRunComplete(payload.sender, target, payload.selector, version);
                    return;
                }
            } catch (bytes memory err) {
                _refuse(payload.selector, policy, err);
            }
        }
        _defaultRule(target);
        emit PolicyRunComplete(payload.sender, target, payload.selector, version);
    }

    // ── interne ────────────────────────────────────────────────────────────────────────────────────────
    function _add(address target, bytes4 selector, address policy, bytes32[] calldata parameterNames, uint256 position)
        private
    {
        if (policy == address(0)) revert InvalidConfiguration("zero policy");
        address[] storage list = _policies[target][selector];
        if (list.length >= MAX_POLICIES) revert InvalidConfiguration("maximum policies reached");
        for (uint256 i; i < list.length; ++i) {
            if (list[i] == policy) revert InvalidConfiguration("policy already added");
        }
        list.push(policy);
        for (uint256 j = list.length - 1; j > position; --j) {
            list[j] = list[j - 1];
        }
        list[position] = policy;
        _parameterNames[target][selector][policy] = parameterNames;
        if (list.length == 1) _scope[target].push(selector);
        IPolicy(policy).onInstall(selector);
        emit PolicyAdded(target, selector, policy, position);
        _bump(target, "");
    }

    function _dropFromScope(address target, bytes4 selector) private {
        bytes4[] storage s = _scope[target];
        for (uint256 i; i < s.length; ++i) {
            if (s[i] == selector) {
                s[i] = s[s.length - 1];
                s.pop();
                return;
            }
        }
    }

    function _bump(address target, string memory label) private {
        uint64 v = ++_version[target];
        if (bytes(label).length != 0) _label[target] = label;
        emit PolicyVersionBumped(target, v, _label[target]);
    }

    function _defaultRule(address target) private view {
        bool allow = _hasDefault[target] ? _targetDefault[target] : _defaultAllow;
        if (!allow) revert PolicyRunRejected(bytes4(0), address(0), "no policy allowed the action and default is reject");
    }

    function _extract(Payload calldata payload) private view returns (Parameter[] memory extracted) {
        address extractor = _extractor[payload.selector];
        if (extractor == address(0)) return extracted;
        try IExtractor(extractor).extract(payload) returns (Parameter[] memory p) {
            extracted = p;
        } catch (bytes memory err) {
            revert ExtractorError(payload.selector, extractor, err);
        }
    }

    function _values(address target, bytes4 selector, address policy, Parameter[] memory extracted)
        private
        view
        returns (bytes[] memory values)
    {
        bytes32[] storage names = _parameterNames[target][selector][policy];
        uint256 n = names.length;
        values = new bytes[](n);
        if (n == 0) return values;
        uint256 found;
        for (uint256 i; i < extracted.length; ++i) {
            for (uint256 j; j < n; ++j) {
                if (extracted[i].name == names[j]) {
                    values[j] = extracted[i].value;
                    ++found;
                    break;
                }
            }
            if (found == n) return values;
        }
        revert InvalidConfiguration("missing policy parameters");
    }

    function _refuse(bytes4 selector, address policy, bytes memory err) private pure {
        if (err.length >= 4 && bytes4(err) == IPolicy.PolicyRejected.selector) {
            bytes memory data = new bytes(err.length - 4);
            for (uint256 i = 4; i < err.length; ++i) {
                data[i - 4] = err[i];
            }
            revert PolicyRunRejected(selector, policy, abi.decode(data, (string)));
        }
        revert PolicyRunError(selector, policy, err);
    }
}
