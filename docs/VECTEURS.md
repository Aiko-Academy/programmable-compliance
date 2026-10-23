# Test vectors

What the Foundry tests and the SDK must reproduce identically. Nothing here is invented: each
vector is computed by the contract or by the SDK and verified against the other.

| object | form | where it is verified |
|---|---|---|
| binding domain | `keccak256("LegBinding/v2")` | `EnvelopeBindingPolicy.BINDING_DOMAIN`, `attestation.ts` |
| binding digest | `keccak256(abi.encode(domain, uetr, from, to, amount, asset, checkCode))` | `EnvelopeBindingPolicy.commitment`, `commitment()` of the SDK, `test/Pipeline.t.sol` |
| anti-replay key | `keccak256(abi.encode(subject, uetr, from, to, amount))` | `EnvelopeBindingPolicy.nullifier`, `test/EnvelopeBindingPolicy.t.sol` |
| signature digest | EIP-712, domain `InstitutionSig` v1, type `InstitutionSignature(bytes16 uetr,string checkCode,bool verdict,bytes32 canonicalDataHash,bytes32 policyRef,uint256 timestamp)` | `InstitutionSignatureVerifier.digest`, `institutionDigest()` of the SDK, `test/InstitutionSignatureVerifier.t.sol` (signed vector of the node) |
| context | `abi.encode(AttestationItem[])`, fields `(uint8 kind, bytes32 orgId, (bytes16,string,bool,bytes32,bytes32,uint256) sig, bytes32 r, bytes32 s, bytes32 qx, bytes32 qy)` | `encodeContext()` of the SDK, decoded by the four policies |
| parameter names | `keccak256("from")`, `keccak256("to")`, `keccak256("amount")` | `ERC20TransferExtractor`, policy installation in `DeployWrapper` |
| policy descriptor | `keccak256(abi.encode(target, selector, policies[], active))` | `PolicyManager.policyDescriptor`, `policyRef` of the attestations |
| envelope digest | `keccak256(abi.encode(uetr, asset, amount, datetime, keccak256(pattern), parties[]))` | `ComplianceTypes.hashEnvelope`, `hashEnvelope()` of the SDK |
