# Programmable Compliance Toolkit: exposure surface

This repository is the **redistributable exposure surface** of the Programmable Compliance (PC)
toolkit: verified contract ABIs, source interfaces, on-chain deployment trackers, and the reference
notes that credit the upstream projects. It is meant to be read and verified by institutional
counterparties, and by the upstream projects it credits (Chainlink, GLEIF, LayerZero). It carries no
source build, no dependencies,
no demo, and nothing internal.

## Replay in five minutes

Read only. It needs Node 18 or later, a network connection, no key and no dependency.

```
git clone https://github.com/Aiko-Academy/programmable-compliance && cd programmable-compliance
node scripts/ci/tous.mjs --rapide          # offline: fingerprints, licences, tracker schema (about 1 second)
node scripts/demo/wiring-check.mjs         # the LayerZero pathway read back from both chains (about 3 seconds)  
node scripts/demo/corridor-fx-e2e.mjs      # every demonstration transaction re-read live (about 25 seconds)
```

Expected: the first prints `surface propre` and `aucun refus`; the second ends with `0 difference`; the third ends with
`result : every check was made and passed` and exit code 0 (298 checks over 48 transactions on 2026-10-22). Exit code 3
means a check could not be made because an endpoint did not serve old blocks: pass your own node with `--rpc-sepolia`
and `--rpc-arbitrum`. Details and the meaning of each check: `RUNBOOK.md`.

## What the toolkit is

The PC toolkit is best-of-class **by the composability of four bricks**, each a leader in its
role, none imposed:

- **PBM (Policy Wrapper)**: compliance as a detachable layer over an immutable asset.
- **Chainlink ACE**: the compliance-engine model; certain components are integrated, not the whole
  stack. Credited by reference (`references/chainlink-ace.md`).
- **vLEI (GLEIF)**: verifiable organisational identity, used as the counterparty check. On the FX
  corridor, vLEI credentials are verified off chain on a test ecosystem (a test root, not GLEIF) and an
  attestation bound to the transfer is verified on chain before value moves; the reference deployment
  still checks an administered LEI registry (`references/vlei-gleif.md`).
- **LayerZero**: the cross-chain transport (`references/layerzero.md`).

The Policy Wrapper makes the **asset** agnostic (any token, even immutable or foreign, can be governed
without being re-issued); LayerZero makes the **network** agnostic (any EVM chain the transport
reaches). The atom is a **compliant transfer of a wrapped token**
(`wrap? → setContext(attestation) → transfer/transferFrom gated by the Policy Manager → unwrap?`);
a use case is a composition of atoms. The cross-currency pivot is the **Cross-Border Payment
Orchestrator** (PvP): only there does the currency change; a LayerZero transport preserves its token
one-for-one and never transforms it. The orchestrator is described here by reference only; no ABI,
interface or tracker for it is part of this surface.

## Layout

| path | content |
|---|---|
| `abi/` | contract ABIs, reproducible from source by digest (see `MANIFEST.json`) |
| `interfaces/` | Solidity interfaces of the public surface |
| `deployments/` | on-chain deployment trackers; addresses are read from the chain, never invented |
| `references/` | upstream projects credited by reference, under their own licence |
| `MANIFEST.json` | per-file sha256 and licence; the surface is exactly this set |
| `scripts/ci/` | offline delivery gates |
| `scripts/demo/` | read-only replays on the public test networks (`corridor-fx-e2e.mjs`, `wiring-check.mjs`, `route-agent.mjs`) |
| `scripts/wiring/` | complete LayerZero wiring of a corridor adapter, and its read-back (`WireLZ.s.sol`) |

## How to verify

1. **Reproducibility (offline).** `node scripts/ci/check-handoff.mjs` recomputes the sha256 of every
   published artifact against `MANIFEST.json`, rejects any undeclared file, rejects any non-whitelisted
   or non-redistributable licence, rejects any tool trace, and rejects any invented address (zero, or
   uniform-case where an EIP-55 checksum is expected; the checksum itself is confirmed on-chain, see
   `RUNBOOK.md`).
2. **Bytecode against source (on-chain).** The deployed runtime bytecode at each address in
   `deployments/` is compared to the compiled artifact over an RPC endpoint. This step joins the chain
   and is documented in `RUNBOOK.md`; it is kept out of the fast gate so the gate can run before a push
   without depending on the network.

Enable the gates once per clone:

```
git config core.hooksPath .githooks
```

`pre-push` then runs the offline gate; `commit-msg` keeps commit messages free of tool traces.

## Licensing

Our own surface is **AGPL-3.0**, except the two zero-knowledge verifiers auto-generated from circuits,
redistributed under **GPL-3.0**, and the cross-chain FX corridor contracts (`ComplianceOFTAdapter`,
`ArrivalComposerFX`, `PolicyWrapperOZ4`, `VleiAttestationPolicy`), our own permissive code, redistributed under **MIT**. The full
texts are in `LICENSE` (AGPL-3.0) and `LICENSE-GPL-3.0`; the per-file licence is recorded in `MANIFEST.json`. No artifact here is under a non-redistributable licence
(BUSL-1.1, LayerZero BUSL, UNLICENSED); vendored dependencies under such licences stay private and are
never part of this surface. LayerZero is consumed through its permissive messaging layer and credited
by reference; Chainlink ACE and vLEI are credited by reference, never copied.

## Chains

Trackers follow the chain id in their file name (for example `560048` is the public test network used
for the reference deployment). Each ledger is distinct; interoperability moves no asset between them.
