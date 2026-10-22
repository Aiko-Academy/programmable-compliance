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
sanctions, customer due diligence, confirmation of the beneficiary. Each node signs its result. Since 2026-10-22 the
counterparty check is added: each party's vLEI is verified off chain, and an attestation bound to the transfer is
signed by a registered verifier (see the next section and `references/vlei-gleif.md`). The Policy Wrapper
does not query any identity registry: it only verifies, on-chain and before the wrapped token moves, the proofs
carried by the transfer (signature, active key, binding to the leg, freshness, a Groth16 non-membership proof
for the public sanctions list, and the vLEI attestation of the party it controls). A proof is bound to one leg and
one chain, so the proofs travel with the transfer from the source chain to the arrival chain and are verified again by
the wrapper of each chain. The source adapter also verifies the arrival proofs signed by the nodes before the debit
(the beneficiary gate), so a transfer that those proofs would get refused at arrival is refused at the source, before
any lock. The gate does not verify the arrival vLEI attestation, because the source chain cannot read the state of the
arrival policy: the sender checks it with a read-only `runFor` call on the arrival policy before sending, and a
refusal at arrival is atomic (no exchange), and the amount is then sent back to the payer (see "Returning a refused
amount"). The addresses of the verifiers and
policies are in `deployments/fx-corridor.json`, under `source`, `destination`, `zk` and `generation.vlei`.

### The vLEI counterparty check (since 2026-10-22)

`VleiAttestationPolicy` (ABI `abi/VleiAttestationPolicy.json`, MIT) is the last policy of the source wEURX, where it
checks the payer, and of the delivery wSGDX, where it checks the beneficiary. It verifies an EIP-712 attestation signed
by a registered verifier after an off-chain vLEI verification against a pinned TEST root (not GLEIF). The chain
verifies the verifier's signature, not KERI or ACDC. The expected values are in `deployments/fx-corridor.json`, under
`source.contracts`, `destination.contracts` and `generation.vlei`. To read them back (Foundry `cast`, read only):

```
# Sepolia: the policy list of the source wEURX, for transfer (0xa9059cbb) and transferFrom (0x23b872dd)
cast call 0x9b4Abe496A3F387d2D7723915844C9bEF96C7a26 'getPolicies(address,bytes4)(address[])' \
  0x738DE4A03a18891e07Ff001323cA4d150d4B2C84 0xa9059cbb --rpc-url <sepolia rpc>
# its configuration for that wrapper: (enabled, side, maxAge, roleMask, rootAid)
cast call 0x7F2f0E02eE528B991fF527ceACBFef767BEbb237 'configOf(address)((bool,uint8,uint32,uint8,bytes32))' \
  0x738DE4A03a18891e07Ff001323cA4d150d4B2C84 --rpc-url <sepolia rpc>
# the verifier is registered
cast call 0x7F2f0E02eE528B991fF527ceACBFef767BEbb237 'isVerifier(address)(bool)' \
  0x87aa85fc706B9DFe39482787edc4450dCd9C0CD6 --rpc-url <sepolia rpc>
```

On Arbitrum Sepolia, the same three reads use the manager `0x21AD6DC26A2F727A7b329cEB1279Ffe64e2AC269`, the wrapper
`0xd8b0f8795141a0B2736BeF452726A39d55638f40` and the policy `0x8fb6F7E53fdf3B9EFD707bc66a45869F99A5BfBc`.

| read | expected, source wEURX | expected, delivery wSGDX |
|---|---|---|
| `getPolicies`, both selectors | the vLEI policy is the last entry, after the sanctions policy | same |
| `configOf` | `enabled` true, `side` 0 (`from`, the payer), `maxAge` 3600, `roleMask` 10 (OOR or agent under a mandate) | `enabled` true, `side` 1 (`to`, the beneficiary), `maxAge` 3600, `roleMask` 6 (OOR or ECR) |
| `configOf`, `rootAid` | `keccak256` of the pinned root identifier, `generation.vlei.pinned_root_keccak256` | same |
| `isVerifier(generation.vlei.verifier)` | true | true |

The role mask has one bit per role: OOR is `1 << 1`, ECR is `1 << 2`, agent under a mandate is `1 << 3`. To recompute the
root digest: `cast keccak <generation.vlei.pinned_root_aid>`.

What each transfer relied upon is an event of the policy, emitted in the same transaction as the gated transfer:

```
cast logs --from-block 11965986 --address 0x7F2f0E02eE528B991fF527ceACBFef767BEbb237 \
  'VleiReliedUpon(address indexed subject,bytes16 indexed uetr,address indexed wallet,bytes20 lei,uint8 role,bytes32 credentialSaid,bytes32 holderAid,bytes32 rootAid,bytes32 mandateSaid,uint64 verifiedAt,address verifier)' \
  --rpc-url <sepolia rpc>
```

On Arbitrum Sepolia, read from block 321558108 at `0x8fb6F7E53fdf3B9EFD707bc66a45869F99A5BfBc`. The event topic is
`0xd2301df7a27533d426a7a8f98de3468e691786797ea5071d789a5b77b9c1b32c`; the indexed fields are the wrapper, the uetr and
the wallet of the controlled party. `lei` is the 20 ASCII characters of the LEI; `credentialSaid`, `holderAid`,
`rootAid` and `mandateSaid` are keccak256 digests of the CESR identifiers (zero `mandateSaid` when no mandate);
`verifiedAt` is the time of the off-chain check, at most 3600 seconds before the block. An empty result with no error
means that no transfer has relied on the policy yet: the same read on `VerifierSet(address indexed verifier,bool active)`
must return the registration of the verifier at the creation block, which proves the read itself works. Since
2026-10-22 two conforming passes have relied on the policy on both chains (`demonstration_passes.conforming_vlei` and
`conforming_vlei_agent_mandate`), and `scripts/demo/corridor-fx-e2e.mjs` reads their events (next section).

### Replaying the FX corridor from the surface

The FX cross-chain corridor (EURX to SGD, changed at the arrival pivot by a Uniswap V3 pool and gated by the Policy
Wrapper) carries its demonstration passes in `deployments/fx-corridor.json`, under `demonstration_passes`, at
1000 EURX unless stated:

- `conforming`: wrap, gated transfer and lock at the source, swap and gated delivery at arrival, unwrap;
- `conforming_safe_2dvn`, `refused_safe_2dvn`, `returned_safe_2dvn`: the same three scenarios played again on
  2026-10-20 (09:32 to 09:43 UTC), after the adapters were handed to a test Safe and with two required DVNs
  (LayerZero Labs and Horizen) on send and receive. The conforming pass took route 0 (the direct pool quoted more than
  the pivot at that block). The Safe signed none of these transactions;
- `conforming_500_safe_2dvn`: a conforming pass at 500 EURX (an amount other than 1000), route 1;
- `refused_revoked_key_source_safe_2dvn`: the node key is revoked at the source seal after it signed a valid
  attestation, the source wrapper refuses the transfer before any lock, and the key is restored right after;
- `refused_invalid_signature_source_safe_2dvn`: one bit of the node signature is flipped while the key stays active,
  the source wrapper refuses before any lock;
- `refused_stale_root_safe_2dvn`: the attestation and the sanctions proof are valid but the SAN01 root is past its freshness
  window (24 hours when this pass was played, 7 days since 2026-10-21), the source wrapper refuses before any lock; the root is then republished as version 3;
- `returned_sanctions_beneficiary_safe_2dvn`: the arrival leg carries a valid sanctions proof made for another
  identifier than the beneficiary, the arrival wrapper refuses, the funds go back under a second guid;
- `conforming_payer_sg1_safe_2dvn`: a payer other than FI FR (FI SG1 pays and receives, an FX conversion for its own
  account);
- `refused`, `refused_sanctions`, `refused_replay`, `refused_forged_proof`: refusals made at the source, before any
  lock. Each transaction reverts: the proof of refusal is the EVM status of failed plus the error read by replaying
  the call at the block before, and balances equal before and after;
- `returned`: the residual case where the node key is revoked after signing, the arrival refuses, and the value goes
  back to the payer;
- `conforming_vlei`, `conforming_vlei_agent_mandate`: the two conforming passes of 2026-10-22 with the vLEI
  counterparty check, an officer (OOR) on each side, then an agent of FI FR under a mandate (role 3) on the payer side.
  Each carries a `counterparty_check`: for each side, the LEI presented and the LEI expected, the role, the time of the
  off-chain verification and the transaction where the policy relied on it (`VleiReliedUpon`). Test root, not GLEIF;
  fictitious LEIs;
- `vlei_refusals_without_transaction`: four vLEI refusals stopped before any transaction (a revoked officer credential,
  the attestation of FI FR presented by another wallet, a LEI other than the one the payer expects, an agent asking
  300,000 EURX beyond a mandate of 250,000.00). They emit nothing, so there is no receipt to read: the script prints
  them as `declared`, with their read-only evidence (`runFor` of the policy), and never counts them as checks.

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
| each side is the counterparty the other expects (vLEI generation) | for a gated transfer at or after the creation block of the vLEI policy on its chain (`generation.vlei`): at the block before, `getPolicies` shows the vLEI policy last on the wrapper for `transfer` and `transferFrom`, `configOf` (enabled, side, maxAge, roleMask, rootAid) equals the tracker and `isVerifier` is true for the attester; the receipt carries exactly one `VleiReliedUpon`, whose wrapper, wallet, LEI, role (within the role mask), root, verifier, time of verification (at most maxAge before the block) and mandate match `counterparty_check`; the same uetr on both chains. Earlier passes are verified as before: the policy did not exist then |

What a chain cannot show is printed as `declared` and never counted: a signature that was never made, a prover that
exits with code 3, a vLEI refusal stopped before any transaction. The tracker lists under `demonstration_passes.not_played` what these passes do not exercise; the script prints
that list in its summary.

Exit code: 0 when every check was made and passed; 1 when a check failed; 3 when nothing failed but a check could not
be made (RPC unreachable or history not served). An endpoint that answers another chain id counts as a failure. A green exit therefore means that all
checks were made. The replay of reverts, the installed policies, the route quotes and the balances before need the
state of an old block, which many public endpoints prune. Without a flag the script tries a short list of public
endpoints in order and keeps the first that answers the right chain id and serves the receipt of the most recent
transaction of the tracker; `--rpc-sepolia` and `--rpc-arbitrum` point it at your own node and are never replaced. `--skip-history` skips those checks
and says so (exit 0, "not a full result"). The previous generation of the corridor (50 EURX passes, identity gated
wrappers) is kept under `history` and is not replayed.

### Nilifying a packet through the delegate (drill of the night of 2026-10-20 to 2026-10-21)

The delegate of each adapter is the test Safe, and the Endpoint V2 lets the delegate of an OApp call `nilify`, `skip`,
`burn` and `clear`. This was played once on the arrival adapter, Sepolia to Arbitrum Sepolia, with the guid
`0x2af5d78f5c0df5d2f5770f61e1d8546bfdf9a4c1e5522356b84e8e6ef717274a` (1000 EURX, route 1), and it is NOT a tracker pass:

- the Safe nilified the NEXT nonce (15) before it was sent, with the empty payload hash, which the Endpoint allows for a
  nonce that is not yet verified: tx `0x419e7942bfd8c2f53805890c31e2ef8fc9bd3d3f18ba9a5fd6dc8e399bd2954d` on Arbitrum
  Sepolia, and the Endpoint then stored the nil hash for that nonce;
- the message was sent (source tx `0x17861b0bb21ee73cb7d898b206e42a71de241a8c49f6930177d247268cd27d96`). In the next 25
  minutes neither required DVN verified it, while the same DVNs verified other applications' packets on the same
  library. The pathway was therefore held at nonce 15;
- it was released by hand: the Safe replaced the required DVN of the receive library by the deployer account
  (`0xa695a726...bbb67`), that account called `verify` (`0xe70f43c0...75d44`) and `commitVerification`
  (`0x9f67e194...afe607`), the Endpoint stored the real payload hash in place of the nil one, and the Safe restored the
  two required DVNs (`0xb01c1bfc...abd907`, `getConfig` read back identical to the saved one);
- LayerZero's executor then delivered and composed the message: 1468.511681129168327548 wSGDX, the quoted amount.

What this shows: the Safe can nilify, and a nilified nonce is delivered after a fresh verification. What it does NOT
show: a packet that was verified, then nilified, then re-verified by the production DVNs. Here the production DVNs did not
re-verify on their own, and the release used a temporary DVN swap that a production setup must not rely on.

Recovery after a nilify (answer of LayerZero, 2026-10-22). A nilify is followed by a new verification only if the DVNs
are asked for one: LayerZero re-pings the DVNs for that packet. The off-chain workflow they published (swimlanes of
the Essence DVN) starts from the `PacketSent` event, waits for block confirmations, collects the signatures, then calls
`verify()` on the receive library; the committer calls `commitVerification()` once every required DVN has verified.
Nothing in that flow listens to `nilify`. Reading: the verification is triggered once per `PacketSent`, so a nonce
nilified before or after it stays held until someone asks for a new verification. This is our reading of the flow, not
a statement of LayerZero.

To ask for the re-verification, send LayerZero:

- the source and destination endpoint ids, the sender and the receiver (the two adapters);
- the nonce, the guid and the source transaction of the `PacketSent`;
- the payload hash read on the source chain;
- the nilify transaction on the destination chain.

Not settled: whether the request also reaches the second required DVN (Horizen) or only LayerZero Labs, the channel and
the delay, and whether a packet already verified and then blocked behaves like the nonce of the drill above.
Do not use the temporary DVN swap of the drill as a recovery path: it makes the delegate the root of trust of the
pathway.

### Freshness window of the sanctions root

The sanctions policy of each wrapper refuses a transfer when the SAN01 root is older than the `maxRootAge` of the list
(`listsOf(subject)`). It was 86400 seconds (24 hours) until 2026-10-21. On that day the owner reconfigured the two deployed
policies, with `setConfig(subject, rangeMode)` then `addList(subject, registry, listId, 604800, "SAN01")`, so the window is now
**7 days** (604800 seconds). The policies keep their addresses, their conduits and their consumed nullifiers.

- Sepolia, wrapper source `0x738D...2C84`: `setConfig` `0x24f044b6...cc6f9`, `addList` `0xd17f9923...a0a9a`;
- Arbitrum Sepolia, wrapper wSGDX `0xd8b0...f40`: `setConfig` `0xa7514f51...4bca`, `addList` `0x67fb60ea...e87c`.

Between the two calls a policy has no list and refuses everything (`no list configured`), so the gap fails closed. The
window is read from the chain, not from this file: `listsOf` on the policy is the source of truth.

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
receive libraries, ULN config (2 confirmations, two required DVNs: LayerZero Labs and Horizen), executor, and
enforced gas options. Before 2026-10-16, only the peer was set and everything else ran on the LayerZero defaults. The expected values are in
`deployments/fx-corridor.json`, under `wiring`. To read them back from the chains:

```
node scripts/demo/wiring-check.mjs
```

It reads the raw values set by the application (not the merged effective value, which cannot tell a pinned
setting from an inherited one), prints one line per check, and exits with code 1 if any check differs or if an
RPC does not answer. It is read only and has no dependency. The script that sets these values is
`scripts/wiring/WireLZ.s.sol` (see `scripts/wiring/README.md`).

Two options harden the read: `--require-contract-owner` turns the warning "the adapter owner is an EOA" into a failure
(both adapters are owned by a test Safe since 2026-10-20), and `--check-dvn-metadata` reads LayerZero's public DVN
metadata and fails on an unknown, deprecated or lzRead-flagged required DVN.

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
