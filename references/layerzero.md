# LayerZero: cross-chain transport (credited by reference)

The toolkit uses LayerZero as its cross-chain transport: the leader for reach across EVM networks.
We write our own OApp / OFT / OFTAdapter on the permissive messaging layer and call endpoints that are
already deployed; we never embed the non-redistributable plumbing.

- Upstream: LayerZero-Labs/LayerZero-v2 (consumed as an upstream dependency; not vendored here).
- Compliance hook: LayerZero does not offer a first-class policy hook (CCIP does). We add it as an
  override of `_debit` (source) and `_credit` (destination) in a `ComplianceOFTAdapter` whose
  `innerToken` is the Policy Wrapper. On the source, `_debit` pulls the wrapped token from the payer
  by `transferFrom` (a transfer gated by the Policy Manager) and withdraws the underlying into the
  adapter, locking it; the wrapped supply at the source returns to zero. On the destination, `_credit`
  releases the wrapped token from a pre-financed reserve held by the adapter, through the wrapper's
  ungated deposit, with no mint: this is the OFTAdapter lock and release model. The compliance
  attestation travels in the OFT compose message, and the final delivery to the beneficiary is a
  gated transfer that runs the policies against that attestation.
- Licence: consumed through the permissive messaging layer only. A deployment with designated
  participants reviews the commercial licence before hosting any plumbing.
- Risk controls and scope: the leg runs the compliance policies on every transfer, and the Policy
  Wrapper carries a global pause (Administrative Control). The cross-chain risk guardrails, meaning
  the security-stack tuning (verifier set, confirmations, executor), a per-route stop, per-chain rate
  limiting, pre-financed reserve management, and the failure return path, are the role of the
  Cross-Border Payment Orchestrator and are out of this surface. On the demonstration legs the
  transport runs on the default testnet configuration; a destination credit against an insufficient
  reserve reverts, with no partial credit, and a refused delivery is recorded without automatic replay
  or refund.
- Cross-chain FX corridor (EURX to SGDX): a dedicated OFT adapter pair carries EURX one-for-one; the
  real FX happens at the arrival pivot, inside the `ArrivalComposerFX`, which swaps EURX to SGDX through
  a calibrated Uniswap V3 pool before the gated delivery, so a non-compliant delivery leaves the pool
  untouched. The underlying 1:1 legs stay intact. Uniswap V3 is consumed by canonical address
  (SwapRouter02, QuoterV2, factory, position manager; see the `fx-corridor` tracker), never vendored
  here under GPL-2.0. The corridor contracts' ABIs and the `IComplianceOFTAdapter` interface are
  published; the pool, composer and leg addresses are read on-chain in the tracker.
