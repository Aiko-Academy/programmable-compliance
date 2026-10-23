#!/usr/bin/env bash
# examples/corridor-fx : plays the cross-chain FX corridor EURX -> SGDX in DEV (no network, no go).
#
# Two witnesses, in order:
#   1. the GATE + CROSS-CHAIN witness, deterministic, zero gas: the Foundry suite of the lz profile
#      (CrossChainFXSettlement) proves the full atom lock -> transport -> release EURX -> SWAP -> GATE ->
#      delivery SGDX, AND that the change DOES NOT EXECUTE on a refused path (pool reserves motionless).
#      If it is not green, we stop: there is no point playing a swap if the corridor is not proven.
#   2. the ON-CHAIN FX witness: a real V3 pool (session double) on anvil (31337), where the EURX -> SGDX swap
#      is a real transaction (hash, balance diff consistent with the rate). That is the corridor's new
#      gesture, played for real locally.
#
# The LAST line of stdout is the machine block FX_RESULT={...}, the only seam with the skill
# runner skill (layerzero pattern) that parses it and renders it. Needs only Foundry and Node.
# Broadcasts NOTHING outside the local anvil: the live testnet pass is another sequence, gated.
set -euo pipefail
export PATH="$HOME/.foundry/bin:$PATH"
cd "$(dirname "$0")/../.."

echo "== 1. gate + cross-chain witness (lz profile, zero gas)"
FOUNDRY_PROFILE=lz forge test --match-path "test-layerzero/CrossChainFXSettlement.t.sol" -q

echo
echo "== 2. on-chain FX witness (anvil 31337, real swap)"
PORT="${ANVIL_PORT:-8545}"
anvil --port "$PORT" --silent --chain-id 31337 &
ANVIL=$!
trap 'kill $ANVIL 2>/dev/null || true' EXIT
for i in $(seq 1 50); do curl -s -o /dev/null "http://127.0.0.1:$PORT" && break; sleep 0.1; done
rm -f examples/corridor-fx/evidencing-records.jsonl
RPC="http://127.0.0.1:$PORT" node examples/corridor-fx/run.mjs
