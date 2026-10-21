# vLEI (GLEIF): verifiable organisational identity (credited by reference)

Status on 22 October 2026: the toolkit does **not** verify vLEI credentials yet.

What exists today:

- `VLEICredentialDataValidator` checks the format of an 85-byte record: a LEI of 20 upper-case
  alphanumeric characters, two non-zero identifiers and a role (OOR or ECR). It verifies no signature,
  no issuer, no chain to GLEIF and no revocation status.
- `IdentityRegistry` and `CredentialRegistry` are written by their administrator. `IdentityGatedPolicy`
  requires the originator and the beneficiary to hold a compliance account id (CCID) and a registry entry
  that passes the format check.
- On the live LayerZero corridor, no identity policy is attached to the wrappers since 18 October 2026.

What is being built: verification of real vLEI credentials (KERI key state, ACDC chain to a pinned root,
revocation through the credential status registry) off chain, by a verifier whose attestation is bound
to the transfer and checked on chain before value moves.

Licence: GLEIF specifications and trust chain are credited by reference; our validator and registries
are AGPL-3.0 and published in `abi/` and `interfaces/`.
