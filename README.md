# Programmable Compliance Toolkit

Compliance as a detachable layer over a token: a Policy Wrapper holds the asset, a Policy Manager runs the
policies, and a transfer goes through only if the attached checks pass. This repository carries the Solidity
source of that layer, its tests, the exported ABIs, the on-chain deployment trackers and the notes that credit
the upstream projects (Chainlink ACE, GLEIF vLEI, LayerZero). It is meant to be read, compiled and verified by
institutional counterparties.

## Build and test in five minutes

Offline, no key, no network after the clone. It needs [Foundry](https://getfoundry.sh) and Node 18 or later.

```
git clone --recurse-submodules https://github.com/Aiko-Academy/programmable-compliance
cd programmable-compliance
forge build
forge test
```

Expected: the build succeeds and `forge test` ends with `62 tests passed, 0 failed, 0 skipped` (the figure of the
day this lot was prepared). The build uses `via_ir`: allow from a few seconds to a few minutes, depending on the machine and on whether the
compiler (solc 0.8.28) has to be downloaded.

Two more checks, both read only:

```
npm install                            # once: the scripts need ethers
node scripts/export-abi.mjs            # re-exports the ABIs of the contracts of this repository
node scripts/verifier-bytecode.mjs     # compares the compiled code to the contracts in service on Hoodi (needs a network)
```

`scripts/verifier-bytecode.mjs` says, contract by contract, whether the compiled runtime code equals the code on
chain, and it never rounds a difference to a match. Today it reports 2 identical (`ComplianceKeyRegistry`,
`ZkCheckRegistry`) and 2 different (`RequiredChecksPolicy`, `EnvelopeBindingPolicy`, deployed under the name
`LegBindingPolicy`): the code in service was compiled from an earlier version whose revert messages, and for the
binding policy the `BINDING_DOMAIN` constant, carried an earlier name. `deployments/hoodi-reference.json` records
this.

Read-only replays of the demonstration on the public test networks need only Node 18 or later, a network connection and no key:

```
node scripts/ci/tous.mjs --rapide          # offline: fingerprints, licences, tracker schema (about 1 second)
node scripts/demo/wiring-check.mjs         # the LayerZero pathway read back from both chains (about 3 seconds)
node scripts/demo/corridor-fx-e2e.mjs      # every demonstration transaction re-read live (about 25 seconds)
```

Expected: the first prints `surface propre` and `aucun refus`; the second ends with `0 difference`; the third ends with
`result : every check was made and passed` and exit code 0. Exit code 3 means a check could not be made because an
endpoint did not serve old blocks: pass your own node with `--rpc-sepolia` and `--rpc-arbitrum`. Details and the meaning
of each check: `RUNBOOK.md`.

## Run the examples

Two end-to-end examples run on a local `anvil` chain and need only Foundry and Node. They import the SDK, which is a
compiled output and is not in the repository: build it once.

```
npm install                            # once, at the root
(cd sdk && npm ci && npm run build)    # once: compiles the SDK to sdk/dist
bash examples/transfer/run.sh          # a compliant transfer, a refusal, a replay, an unwrap
bash examples/repo/run.sh              # a repo in two legs, a price drop, a liquidation
```

Each ends with `example transfer : OK` or `example repo : OK` and exit code 0. `run.sh` builds the SDK itself if
`sdk/dist` is missing.

## What the toolkit is

The atom is a compliant transfer of a wrapped token:
`wrap? -> setContext(attestation) -> transfer/transferFrom gated by the Policy Manager -> unwrap?`.
A use case is a composition of atoms. The toolkit composes four bricks, none imposed: the Policy Wrapper (compliance as
a detachable layer over an immutable asset), the Chainlink ACE compliance-engine model, vLEI (GLEIF) organisational
identity, and LayerZero as the cross-chain transport. On the FX corridor, vLEI credentials are verified off chain on a
test ecosystem (a test root, not GLEIF) and an attestation bound to the transfer, carrying the reliance terms it is
invoked under, is verified on chain before value moves. The cross-currency pivot is the Cross-Border Payment
Orchestrator (PvP), described by reference only: no ABI, interface or tracker for it is part of this repository.

| path | content | licence |
|---|---|---|
| `contracts/` | `PolicyWrapper`, `PolicyManager`, the ERC-20 extractor, the policies (presence, binding, identity, verification), the identity and credential registries, the signature and TEE verifiers, the ZK verifier registry | AGPL-3.0 |
| `contracts/interfaces/` | `IPolicy`, `IPolicyManager`, `IPolicyWrapper`, `ComplianceTypes` | AGPL-3.0 |
| `contracts/mocks/` | demonstration tokens: `ExampleToken`, `TokenisedMoneyMarketFund` (a tokenised money market fund with an issuer role and a fund manager role), `RepresentedStablecoin` | AGPL-3.0 |
| `contracts/verifiers-zk/` | two example Groth16 verifiers generated from circuits under GPL | GPL-3.0, separate module |
| `test/` | Foundry tests, including the whole pipeline with P-256 signatures produced in the test | AGPL-3.0 |
| `abi/` | ABIs. Those of the contracts in `contracts/` are re-exported by `scripts/export-abi.mjs` and match `MANIFEST.json`; the ABIs of five cross-chain corridor contracts have no source here and are checked against the chain only (`RUNBOOK.md`) | data |
| `deployments/` | on-chain trackers; addresses are read from the chain, never invented | data |
| `scripts/` | `export-abi.mjs`, `verifier-bytecode.mjs`, and the offline gates in `scripts/ci/` | AGPL-3.0 |
| `sdk/` | TypeScript SDK `programmable-compliance-toolkit` used by the examples | AGPL-3.0 |
| `examples/` | `transfer/` and `repo/` run on a local `anvil`; `corridor-fx/` holds the live-pass runner and the recorded results of the cross-chain FX corridor | AGPL-3.0, results as data |
| `vlei/`, `zk/` | the vLEI verification tooling (test ecosystem) and the sanctions circuits | AGPL-3.0 |
| `scripts/demo/`, `scripts/wiring/` | read-only replays on the public test networks, and the complete LayerZero wiring of a corridor adapter with its read-back | AGPL-3.0 or MIT, per file |
| `docs/` | SDK notes and test vectors | AGPL-3.0 |
| `references/` | upstream projects credited by reference, under their own licence | upstream |
| `MANIFEST.json` | sha256 and licence of every ABI, interface, tracker and reference; the offline gate recomputes them. Source files carry their SPDX header | |

The Policy Wrapper makes the asset agnostic (any token, even immutable or foreign, can be governed without being
re-issued). The Chainlink ACE compliance-engine model and the vLEI organisational identity are credited by
reference (`references/`), never copied.

## Dependencies

Two submodules, pinned: `lib/openzeppelin-contracts` at v5.6.1 and `lib/forge-std` at v1.16.2.
`git clone --recurse-submodules` fetches them; after a plain clone, run `git submodule update --init`.

## How to verify

1. Reproducibility (offline). `node scripts/ci/check-handoff.mjs` recomputes the sha256 of every ABI, interface, tracker and reference against
   `MANIFEST.json`, rejects any undeclared file under `abi/`, `interfaces/` and `deployments/`, any non-whitelisted or non-redistributable licence, any tool trace and
   any invented address (zero, or uniform-case where an EIP-55 checksum is expected).
2. Bytecode against source (on chain). `node scripts/verifier-bytecode.mjs` and `RUNBOOK.md` compare the deployed
   runtime code at each address to the compiled artifact over an RPC endpoint. This step joins the chain and is kept
   out of the fast gate.

Enable the gates once per clone: `git config core.hooksPath .githooks`. `pre-push` then runs the offline gate and
`commit-msg` keeps commit messages free of tool traces.

## Chains

Trackers follow the chain id in their file name (for example `560048` is the public test network used for the
reference deployment). Each ledger is distinct; interoperability moves no asset between them.

## Licensing

The contracts, tests and scripts are under **AGPL-3.0** (`LICENSE`). The two Groth16 verifiers in
`contracts/verifiers-zk/` are generated from circuits published under **GPL-3.0** and stay under it
(`contracts/verifiers-zk/LICENSE`); the rest of the repository reaches them only through the `IZkVerifier`
interface, so an integrator can install their own verifiers without taking that licence. The cross-chain FX corridor contracts (`ComplianceOFTAdapter`, `ArrivalComposerFX`, `PolicyWrapperOZ4`,
`VleiAttestationPolicy`) are our own permissive code, under **MIT**. LayerZero is consumed through its permissive
messaging layer. The per-file licence is
recorded in `MANIFEST.json`. No file here is under a non-redistributable licence (BUSL-1.1, LZBL-1.2,
UNLICENSED).

## Contributing

External contributions are closed. Report a problem in an issue.
