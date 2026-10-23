#!/usr/bin/env bash
# Starts anvil, plays examples/transfer, stops anvil. Requires only Foundry and Node.
set -euo pipefail
export PATH="$HOME/.foundry/bin:$PATH"
cd "$(dirname "$0")/../.."
# The examples import the SDK, a compiled output that a fresh clone does not carry.
if [ ! -f sdk/dist/index.js ]; then (cd sdk && npm ci && npm run build); fi
PORT="${ANVIL_PORT:-8545}"
anvil --port "$PORT" --silent --chain-id 31337 &
ANVIL=$!
trap 'kill $ANVIL 2>/dev/null || true' EXIT
for i in $(seq 1 50); do curl -s -o /dev/null "http://127.0.0.1:$PORT" && break; sleep 0.1; done
rm -f deployments/31337.json deployments/31337-wCBDC-EUR.json deployments/31337-example-token.json examples/transfer/evidencing-records.jsonl
RPC="http://127.0.0.1:$PORT" node examples/transfer/run.mjs
