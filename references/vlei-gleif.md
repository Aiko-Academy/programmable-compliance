# vLEI (GLEIF): verifiable organisational identity (credited by reference)

Status on 22 October 2026:

- On the cross-chain FX corridor (Sepolia to Arbitrum Sepolia), real vLEI credentials are verified off chain, on a
  **test** ecosystem, and an attestation bound to the transfer is verified on chain before value moves.
- The reference deployment on Hoodi is unchanged: it checks an administered LEI registry, not a vLEI credential.

## Why: the counterparty check

In a payment between institutions on ledgers, a wallet address proves technical control of a key. It does not say which
institution is on the other side, nor that the person or agent acting for it has the authority to act. Settlement is
final, so there is no correction window behind the control point: the check must come before the movement.

The corridor runs this as a counterparty check, in both directions. It answers three questions:

| question | answered by |
|---|---|
| Is the institution on the other side the one I mean to pay? | the LEI of a Legal Entity (LE) credential, chained to a recognised root |
| Is the person or agent acting for it authorised? | an Official Organizational Role (OOR) credential, or an agent mandate bounded in amount, asset and validity and chained to that OOR |
| Is this wallet theirs? | a binding signed by the holder's current KERI key and countersigned by the wallet (EIP-191) |

Each institution checks the other before value moves. On chain, each wrapper verifies the attestation of the party it
sees and records what it relied upon. The vLEI does not replace an institution's due diligence on its own customer, nor
the sanctions screening: both stay signed results of the institution's node, and sanctions are also proven by a
zero-knowledge non-membership proof.

## What is verified, and where

| step | where | what |
|---|---|---|
| test ecosystem | off chain | open KERI stack (keripy and kli 1.2.14), three witnesses, official vLEI schemas 1.0.5; a test root standing in for GLEIF External (it is not GLEIF), a QVI delegated by it, two institutions with fictitious LEIs proven absent from the GLEIF register, OOR and ECR credentials, an agent under a Transfer Mandate (a demonstration schema, outside vLEI governance), revocation through the credential status registry (TEL) |
| verifier | off chain | key state refreshed at the witnesses, credential chain up to the pinned root, schema allow-list, same LEI along the chain, TEL status at the time of the check, mandate limits against the intended transfer |
| attester | off chain | the verifier's verdict, then the two-way wallet binding; only then it signs an EIP-712 `VleiAttestation` bound to the transfer (uetr, wallet, asset, chain) |
| `VleiAttestationPolicy` | on chain, last in the policy list of each wrapper | signature of a registered verifier; same transfer, asset, chain and controlled party (`from` at the source, `to` at arrival); pinned root; accepted role; freshness set by the relying party (3600 seconds); mandate cap; single use. It then emits `VleiReliedUpon`: LEI, role, digests of the credential, holder, root and mandate, time of verification, verifier |

The attestation follows the attestation items in the transfer context, `abi.encode(items, proof)`, so the policies already
installed read the same items array unchanged. `runFor` returns the same verdict as the transfer, for a read-only check
before sending.

| wrapper | chain | controlled party | accepted roles |
|---|---|---|---|
| source wEURX | Sepolia (11155111) | payer | OOR, or agent under a mandate |
| delivery wSGDX | Arbitrum Sepolia (421614) | beneficiary | OOR or ECR |

Addresses and configuration: `deployments/fx-corridor.json` (`source.contracts`, `destination.contracts`, and
`generation.vlei`). How to read them back from the chains: `RUNBOOK.md`, "The vLEI counterparty check".

## Passes of 22 October 2026

| record in `demonstration_passes` | what it shows |
|---|---|
| `conforming_vlei` | an officer (OOR) on each side; one `VleiReliedUpon` on each chain, with the same uetr |
| `conforming_vlei_agent_mandate` | the payer side is an agent under a mandate (role 3, the mandate digest is in the event) |
| `vlei_refusals_without_transaction` | four refusals stopped before any transaction: a revoked officer credential, the attestation of one institution presented by another wallet, a LEI other than the one the payer expects, an agent beyond its mandate. Nothing reaches a chain; the evidence is read only (`runFor` of the policy) |

Each conforming pass records, for each side, the LEI presented and the LEI expected, the role, the time of the off-chain
verification and the transaction where the policy relied on it (`counterparty_check`). `scripts/demo/corridor-fx-e2e.mjs`
reads them back from the chains (`RUNBOOK.md`, "Replaying the FX corridor from the surface").

## Limits

- The root is a test root, not GLEIF. The LEIs are fictitious. No credential here was issued by GLEIF or by a real QVI.
- The attester is a trusted verifier (oracle model). The chain verifies its signature, not KERI, ACDC or CESR. One
  attester serves both chains.
- The witnesses run on a single machine. Identifiers are single-signature, where GLEIF and QVIs use multi-signature.
- A revocation that happens after the check is not seen on chain for up to 3600 seconds.
- No zero-knowledge proof yet: the LEI is public in the event; credential identifiers appear only as keccak256 digests.
- No reliance terms and no allocation of loss are attached to the evidence.
- On the reference deployment, `VLEICredentialDataValidator` checks the format of an 85-byte record (a LEI of 20
  upper-case alphanumeric characters, two non-zero identifiers, a role OOR or ECR), and `IdentityRegistry` and
  `CredentialRegistry` are written by their administrator. They verify no signature, no issuer, no chain to GLEIF and
  no revocation status.

Licence: GLEIF specifications and trust chain are credited by reference. `VleiAttestationPolicy` is MIT
(`abi/VleiAttestationPolicy.json`). The validator and registries of the reference deployment are AGPL-3.0, published in
`abi/` and `interfaces/`.
