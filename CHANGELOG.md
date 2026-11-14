# Changelog of the pack

## Demonstration material (2026-11-14)

- `media/Cross-chain programmable compliance demonstration.mp4` (3:15), and a README section on what it shows.
- `examples/corridor-fx/live-result-2026-11-13-*.json`: the compliant pass behind the film's figures and three refusals of the
  same day (revoked credential, agent beyond its mandate, someone else's attestation), nothing sent for the refusals.
- The pack version is unchanged (0.1.1): no contract, ABI or tracker changed.

## 0.1.1 (2026-09-14)

- `PolicyWrapper` emits `Paused` and `Unpaused`; a service can read them as evidencing records.
- `scripts/Control.s.sol`: the Administrative Control as an idempotent runner.
- SDK: reread after write between two submissions (`synchronised`); a public provider spreads its calls over
  several nodes, and the one that answers after a receipt may not have seen the block.
- `scripts/TrustSigners.s.sol`: two Compliance Rules Engines side by side; the pack's institution verifier is
  set at the EIP-712 domain of the verifier in service, on the pack's registry where the active keys of the
  registry in service (public points reread from its log) and the second engine's key are copied.
- `mocks/TokenisedMoneyMarketFund.sol`, `scripts/DeployRepoAssets.s.sol`: the repo assets (a tokenised money
  market fund representation and its wrapper).

## 0.1.0 (2026-09-14)

- First pack: `PolicyManager`, `PolicyWrapper`, ERC-20 extractor, presence, binding, identity and verification
  policies, identity and credential registries, vLEI validator, signature and TEE verifiers, ZK verifier
  registry, two Groth16 verifiers (GPL-3.0).
- SDK `programmable-compliance-toolkit`: envelope, enrichment, `CheckProvider`, P-256 signed attestation,
  submission, records, links.
- Scripts `Deploy`, `DeployWrapper`, `Admit`, `DeployExampleToken`; `examples/transfer` against anvil;
  `verifier-bytecode.mjs` against Hoodi (four contracts identical to the code in service).
