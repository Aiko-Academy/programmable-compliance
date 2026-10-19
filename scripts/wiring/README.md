# WireLZ: complete wiring of a corridor adapter

`WireLZ.s.sol` sets, and reads back, the full LayerZero pathway of one corridor adapter: peer, send library,
receive library, ULN config on both libraries, executor, and enforced options. It covers the six steps of the
usual OFT wiring list, on both chains.

Before 2026-10-16 the corridor set only `setPeer`. The libraries, the ULN config and the options were the
LayerZero defaults. A default is not a security model: it can change, and nothing pins it.

## What is pinned

The values equal what was already effective, so the behaviour did not change. They are now set by the
application instead of inherited. They are listed in `deployments/fx-corridor.json` under `wiring`:

- send and receive library: `SendUln302` and `ReceiveUln302` of each chain, set explicitly;
- ULN config: 2 confirmations, two required DVNs (LayerZero Labs and a second one, since 2026-10-20; one before), no
  optional DVN, written as an explicit
  "none" so that a future default optional DVN is not inherited;
- executor and maximum message size (10,000 bytes);
- enforced options: `lzReceive` 500,000 gas on both chains, and `lzCompose` 4,500,000 gas on SEND_AND_CALL on the
  Sepolia side only (the return path has no composer).

Enforced options ADD to the caller's options: the executor sums the gas. A sender that repeats the same amounts
counts them twice, so the sender passes no options.

## Two ways to check

- `node scripts/demo/wiring-check.mjs` reads the chains with JSON-RPC only. No build, no key, no dependency. Exit
  code 1 if any value differs.
- `check()` in `WireLZ.s.sol` does the same from Foundry and reverts if any value differs.

Both read the raw value set by the application (`getAppUlnConfig`, `executorConfigs`), never the merged effective
value.

## Setting the values

`WireLZ.s.sol` is a Foundry script. It needs `forge-std` and the permissive `oapp` layer of LayerZero v2
(`OptionsBuilder`), mapped as `@layerzerolabs/lz-evm-oapp-v2/`. It declares the few types and interfaces of the
messaging libraries itself, so that nothing is imported from the source-available plumbing. It cannot be built
from this surface alone: it is shown so that the wiring can be read and reused.

```
forge script WireLZ.s.sol:WireLZ --sig 'check()' --rpc-url <rpc>
forge script WireLZ.s.sol:WireLZ --sig 'run()' --rpc-url <rpc> --sender <owner>                     # simulation
forge script WireLZ.s.sol:WireLZ --sig 'run()' --rpc-url <rpc> --private-key "$KEY" --broadcast     # sets
```

`run()` sets only what differs: the peer, the libraries, the config and the enforced options. A replay on a
conforming wiring broadcasts nothing. Run `check()` in a separate command after setting: inside `run()` the
read-back reads the simulated state.

Measured on 2026-10-16: before, the check reported 7 differences on Sepolia and 5 on Arbitrum Sepolia; after,
0 on both. On a fork, changing one value turned the check red on that line only, and `run()` made it green again.

## A second required DVN

Since 2026-10-20 the spec pins two required DVNs on both chains: LayerZero Labs and a second one (`dvn2`), in the send
and the receive ULN config (the list is sorted ascending, as the ULN requires). `EXTRA_REQUIRED_DVN=<address on the
chain being run>` overrides the second one, and the zero address removes it. The same logical DVN has a different
address on each chain, so the variable is set per run. `check()` and `run()` must use the same value.
Before choosing a DVN, quote it on the pathway: a DVN that does not serve the pathway reverts on
`getFee(dstEid, confirmations, sender, options)`, called from the send library.

## Who controls the adapter

The owner of the adapter is also its delegate. Either can replace the DVN set or the peer, which is enough to
forge messages and drain the lockbox. On a testnet the deployer key holds both. `check()` and `wiring-check.mjs`
report whether the owner is a contract, as a warning. `REQUIRE_CONTRACT_OWNER=true` (script) and
`--require-contract-owner` (reader) turn that warning into a failure, for production.

`handover()` moves the delegate, then the ownership, to `NEW_OWNER`. It refuses an address without code
(`ALLOW_EOA_OWNER=true` lifts that), and `HANDOVER_CONFIRM` must repeat `NEW_OWNER`. Both moves are immediate,
so a wrong address is final. After a handover, `run()` must be signed by the new owner.
