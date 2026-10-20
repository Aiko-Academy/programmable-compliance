# RUNBOOK: verifying the PC exposure surface

This runbook is the companion to the offline delivery gate described in the README. It sets out, step
by step, how an institutional counterparty checks that this
surface is exactly what it claims to be. Verification has two layers: an offline layer that needs no
network, and an on-chain layer that reads the public test networks.

## 1. Offline reproducibility (no network)

Enable the gates once per clone, then run the offline gate:

```
git config core.hooksPath .githooks
node scripts/ci/tous.mjs --rapide
```

The gate (`scripts/ci/check-handoff.mjs`) recomputes the sha256 of every published artifact against
`MANIFEST.json` and refuses:

- any artifact whose digest no longer matches the manifest (a drift);
- any file under `abi/`, `interfaces/` or `deployments/` not declared in the manifest (the surface is
  exactly the manifest);
- any licence outside the whitelist (AGPL-3.0, GPL-3.0, MIT, data), and any non-redistributable licence
  declaration (BUSL, the LayerZero source-available licence, or an unlicensed artifact);
- any tool trace in the surface read by the counterparty;
- any invented address in a tracker (zero, or not in EIP-55 mixed-case checksum).

A green gate proves the digests, the perimeter, the licences, the absence of tool traces, and the
checksum shape of every address. It does not join the chain: that is layer 2.

## 2. On-chain, from the surface alone

Every address in `deployments/` is a live contract on a public test network. A reader who holds only
this surface confirms each address on its explorer and, for the LayerZero legs, cross-checks the
endpoint and the endpoint id against LayerZero's own published deployments.

| role | network | chain id | LayerZero EID | address source |
|---|---|---|---|---|
| production reference deployment | Ethereum Hoodi testnet | 560048 | n/a | `deployments/560048-*.json` (chain id in the file name) |
| cross-border demonstration, source (EUR) | Ethereum Sepolia | 11155111 | 40161 | `deployments/11155111-layerzero-leg.json` |
| cross-border demonstration, destination (SGD) | Arbitrum Sepolia | 421614 | 40231 | `deployments/421614-layerzero-leg.json` |

Both LayerZero legs share the Endpoint V2 at `0x6EDCE65403992e310A62460808c4b910D972f10f`. The explorer
for each leg is named in its tracker (`sepolia.etherscan.io`, `sepolia.arbiscan.io`).

The leg contracts are OpenZeppelin 4.9 representations with a reduced interface, deployed only for this
demonstration: they are not the production contracts and are not described by the production ABIs in
`abi/`. The production contracts are the `560048` tracker set, whose contracts match those ABIs. The
stablecoins on the legs are demonstration ERC-20 tokens, never central bank money, which is never
issued on a public chain. The same address string can denote different contracts on different chains:
deployment is deterministic by deployer and nonce, and each tracker is read on its own chain id.

### Compliance model of the corridor

All compliance checks are made off-chain, before any transaction, by the node of each financial institution (FI):
sanctions, customer due diligence, confirmation of the beneficiary. Each node signs its result. The Policy Wrapper
does not query any identity registry: it only verifies, on-chain and before the wrapped token moves, the proofs
carried by the transfer (signature, active key, binding to the leg, freshness, and a Groth16 non-membership proof
for the public sanctions list). A proof is bound to one leg and one chain, so the proofs travel with the transfer
from the source chain to the arrival chain and are verified again by the wrapper of each chain. The source adapter
also verifies the arrival proofs before the debit (the beneficiary gate), so a transfer that the arrival chain
would refuse is refused at the source, before any lock. The addresses of the verifiers and policies are in
`deployments/fx-corridor.json`, under `source`, `destination` and `zk`.

### Replaying the FX corridor from the surface

The FX cross-chain corridor (EURX to SGD, changed at the arrival pivot by a Uniswap V3 pool and gated by the Policy
Wrapper) carries its demonstration passes in `deployments/fx-corridor.json`, under `demonstration_passes`, all at
1000 EURX:

- `conforming`: wrap, gated transfer and lock at the source, swap and gated delivery at arrival, unwrap;
- `conforming_safe_2dvn`, `refused_safe_2dvn`, `returned_safe_2dvn`: the same three scenarios played again on
  2026-10-20 (09:32 to 09:43 UTC), after the adapters were handed to a test Safe and with two required DVNs
  (LayerZero Labs and Horizen) on send and receive. The conforming pass took route 0 (the direct pool quoted more than
  the pivot at that block). The Safe signed none of these transactions;
- `conforming_500_safe_2dvn`: a conforming pass at 500 EURX (an amount other than 1000), route 1;
- `refused_revoked_key_source_safe_2dvn`: the node key is revoked at the source seal after it signed a valid
  attestation, the source wrapper refuses the transfer before any lock, and the key is restored right after;
- `refused`, `refused_sanctions`, `refused_replay`, `refused_forged_proof`: refusals made at the source, before any
  lock. Each transaction reverts: the proof of refusal is the EVM status of failed plus the error read by replaying
  the call at the block before, and balances equal before and after;
- `returned`: the residual case where the node key is revoked after signing, the arrival refuses, and the value goes
  back to the payer.

A reader holding only this surface verifies them end to end, reading each receipt live on the public RPC:

```
node scripts/demo/corridor-fx-e2e.mjs
```

It is read only: it signs nothing, holds no key and has no dependency (Node 18+). It derives the event and error
selectors from the ABIs of `abi/`, and takes every expected value from the tracker. For each transaction it prints
the block, the EVM status, the target cross-referenced to a named corridor contract, the explorer link, then the
checks:

| what the corridor claims | what the script reads |
|---|---|
| the token moves only once the wrapper has verified the proofs | `PolicyRunComplete` of the Policy Manager on each gated transfer (it is emitted only when every installed policy accepted), and `getPolicies` at the block before: the sanctions non-membership policy is installed on the wrapper of each chain |
| one payment crosses two ledgers | the LayerZero guid born at the source lock (`OFTSent`, and the packet of the Endpoint) is the guid composed and delivered at the arrival (`ComposeDelivered`, composer `Delivered`) |
| the amounts are exact | wrap, lock, delivery, burn and unwrap are compared to the wei with the tracker; the rate and the distance to the reference rate are recomputed from the amounts |
| the better route wins | both routes are quoted at the block before the swap (`route-agent.mjs --block`): the route used is the higher output, and the SGDX delivered equals its quote |
| the composer never holds USDX | no USDX transfer touches the composer, which is itself present in seven transfers of the transaction (a negative check with a positive witness) |
| a refusal at the source moves nothing | the transaction failed, was sent to the source adapter by the payer, did not run out of gas, and its call replayed at the block before reverts with the error the tracker names (policy address and message); the payer balance and the lock are read before and after |
| a refusal at arrival leaves nothing behind | `Refused` for the same guid with the decoded reason, no transfer, no completed policy run; the key window is in order (revoked, refused, restored, returned); `ReturnedToSource`, a second guid for the return packet, `ReturnedToPayer` for the exact amount |

What a chain cannot show is printed as `declared` and never counted: a signature that was never made, a prover that
exits with code 3. The tracker lists under `demonstration_passes.not_played` what these passes do not exercise
(stale proof, invalid signature or revoked key at the source, listed party at the beneficiary side, other
amounts); the script prints that list in its summary.

Exit code: 0 when every check was made and passed; 1 when a check failed; 3 when nothing failed but a check could not
be made (RPC unreachable or history not served). An endpoint that answers another chain id counts as a failure. A green exit therefore means that all
checks were made. The replay of reverts, the installed policies, the route quotes and the balances before need the
state of an old block, which many public endpoints prune: the default Arbitrum Sepolia endpoint serves it, and
`--rpc-sepolia` and `--rpc-arbitrum` point the script at your own node. `--skip-history` skips those checks
and says so (exit 0, "not a full result"). The previous generation of the corridor (50 EURX passes, identity gated
wrappers) is kept under `history` and is not replayed.

### Two exchange routes at arrival

The arrival composer (`COMPOSER_ARBITRUM_FX` in `deployments/fx-corridor.json`) knows two routes, fixed in the
contract: route 0 swaps EURX to SGDX in the direct pool, route 1 swaps EURX to USDX to SGDX through two pivot pools.
The compose payload is `beneficiary(20) ++ minOut(32) ++ route(1) ++ maxOut(32) ++ attestation`. `minOut` and `maxOut`
bound the SGDX delivered, and the arrival attestation is signed for that range: the composer delivers what the pool
returned, capped at `maxOut`, and keeps any surplus above it in base SGDX, which the operator can sweep to a sink fixed
at construction. A read-only agent quotes both routes and picks the higher SGDX output; the contract only accepts a
route identifier, and the floor `minOut` applies to the final SGDX, so a wrong choice can only make the whole call
fail. All pools hold base tokens (EURX, USDX, SGDX), never wrappers. USDX is a demonstration base token with no
wrapper: it exists only inside the router call, and compliance applies to the transfer of the wrapped SGDX. At
1000 EURX each pass moves the pool by a few basis points, so the rule switches between the two routes with the pool
state. `scripts/demo/corridor-fx-e2e.mjs` checks, on a route 1 pass, that both pivot pools moved, that the direct pool
did not, that the composer never held USDX, and that the rule picks route 1 when both routes are quoted at the block
before the swap. The rule switches with the pool state: asked again later, the agent can pick route 0.

To see which route the agent would pick right now, read-only:

```
node scripts/demo/route-agent.mjs [--amount 1000] [--tol-bps 30]
```

It checks on the chain that the three tokens of the paths and the three pools are base tokens (it refuses if one is a
wrapper), quotes both routes with the QuoterV2, and prints the choice with its reason, then a `GL1_FX_ROUTE={...}` line
(route, quoted output, floor `minOut`).

### Returning a refused amount

The normal refusal happens at the source, before any lock, so nothing needs to come back. A refusal can still happen
at arrival in a residual case: a proof valid when signed stops being valid before delivery (for example the signing key
of a node is revoked in between). The composer then records the refusal by guid, with the original payer read from the
compose message, and `returnToSource` sends the amount back through the bridge. Only the payer or the operator can
call it, once per guid:

1. the composer's wEURX goes to the arrival adapter and is burned there, and the reserve gets the same amount of EURX back;
2. the adapter trace (`inboundComposer`, `inboundAmount`) is consumed, so a guid cannot be returned twice;
3. on the source chain the lock is released and `RETURN_RECEIVER` hands the wEURX back to the payer by a gated transfer.
   If the source policy refuses, the wEURX stays with the receiver and a `pending` entry is settled by `claim` with a
   fresh attestation: no funds sit in a compose queue.

`scripts/demo/corridor-fx-e2e.mjs` replays this pass (`demonstration_passes.returned`) and checks that exactly the
refused amount left the composer, was burned, came back to the reserve and reached the payer.

Gas on the source chain matters: a return needs `lzReceive` gas of about 920,000 and the compose step a few million;
the enforced options of the adapters carry the values (see `wiring`).

`scripts/demo/wiring-check.mjs` also replays the `ComposerSet` events of each adapter and requires the set of
registered composers to equal the announced list in `deployments/fx-corridor.json`.

### Checking the pinned LayerZero pathway

The pathway of the FX corridor is set by the application on both chains: explicit send and
receive libraries, ULN config (2 confirmations, one required DVN), executor, and enforced gas options. Before,
only the peer was set and everything else ran on the LayerZero defaults. The expected values are in
`deployments/fx-corridor.json`, under `wiring`. To read them back from the chains:

```
node scripts/demo/wiring-check.mjs
```

It reads the raw values set by the application (not the merged effective value, which cannot tell a pinned
setting from an inherited one), prints one line per check, and exits with code 1 if any check differs or if an
RPC does not answer. It is read only and has no dependency. The script that sets these values is
`scripts/wiring/WireLZ.s.sol` (see `scripts/wiring/README.md`).

## 3. On-chain, bytecode against source (participant holding the toolkit)

The strongest check compares the runtime bytecode deployed at each address to the bytecode compiled
from source. This needs the compiled artifacts, which are produced from the private toolkit build and
are not part of this surface. It is therefore the step run inside a deployment with designated
participants who hold that build, not from the surface alone. The procedure is:

1. compile the contracts under the profile that matches the deployment (the same compiler settings as
   the origin);
2. take the compiled `deployedBytecode` and strip the trailing CBOR metadata (its last two bytes give
   its length);
3. zero out the immutable reference ranges on both sides: the compiler reports where they are, because
   an immutable such as a manager address is written into the code at deployment;
4. read the on-chain code with `eth_getCode` at the address, and strip its CBOR metadata the same way;
5. compare. Equal, outside metadata and immutables, means the deployed contract is this source.

In the toolkit this is implemented as `scripts/verifier-bytecode.mjs`. It is named here so a
participant knows where it lives; it stays out of this surface because it depends on the build.

## 4. Provenance

`MANIFEST.json` records `source_commit`: the toolkit commit the reproducible artifacts (`abi/` and
`interfaces/`) are cut from. Those artifacts are unchanged since that commit. The LayerZero testnet
legs were deployed later, as on-chain demonstration data: their trackers carry the `data` licence, are
read from the chain, and make no reproducibility claim against `source_commit`. The `source_commit` is
a bare commit fingerprint, never a private path or repository name.

## 5. What is not in this surface

- the LayerZero plumbing (endpoints, libraries) under its own source-available commercial licence: it
  is consumed through the permissive messaging layer and credited by reference, never embedded here;
- the session attestation seal used in the demonstration (a secp256k1 test key): it is kept out of the
  surface; in production the attestation is validated against the P-256 `InstitutionSignatureVerifier`
  (`abi/InstitutionSignatureVerifier.json`), see `references/layerzero.md`;
- any private key, mnemonic or secret: none is ever part of this surface.
