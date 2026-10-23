#!/usr/bin/env bash
# REAL proofs for ZkSanctionsWrapper.t.sol: the wrapper's policy screens the from and the to of the transfer it gates,
# except the rail's CONDUITS (adapter, composer). Chain 421614. Public list. Fixed test parameters.
set -euo pipefail
cd "$(dirname "$0")"
PK="${PK:-$HOME/.aiko-ceremonies/sanctions-v1/pk/pk.bin}"
go build -o /tmp/prove-sanctions ./cmd/prove-sanctions
OUT=fixtures; PUB=lists/demo-sanctions-v1.json
UETR=0x538a859d49a9960cbce077e6d61df36f
A1=0x00000000000000000000000000000000000000a1; B1=0x00000000000000000000000000000000000000b1
ADAPTER=0x00000000000000000000000000000000000000ad; COMPOSER=0x00000000000000000000000000000000000000c0
BASE=(--snapshot $PUB --uetr $UETR --chainid 421614 --pk "$PK" --circuit ceremony-output/circuit.json --vk ceremony-output/vk.bin)
p() { /tmp/prove-sanctions prove "${BASE[@]}" "$@" 2>&1 | grep -v 'INF\|DBG'; }
# A. SOURCE leg: exact, from = payer, to = adapter (conduit). One proof only: the payer's.
p --wrapper 0x00000000000000000000000000000000000000d6 --payer $A1 --beneficiary $ADAPTER --amount 1000000000000000000000 --party from --type address --id $A1 --output $OUT/wrapper-source-from.json
# B. ARRIVAL leg: range, from = composer (conduit), to = beneficiary. One proof only: the beneficiary's.
p --wrapper 0x00000000000000000000000000000000000000d5 --payer $COMPOSER --beneficiary $B1 --min 1450000000000000000000 --max 1500000000000000000000 --party to --type address --id $B1 --output $OUT/wrapper-arrival-to.json
# C. DIRECT transfer between two institutions (the reference case): exact, two proofs.
p --wrapper 0x00000000000000000000000000000000000000d7 --payer $A1 --beneficiary $B1 --amount 1000000000000000000000 --party from --type address --id $A1 --output $OUT/wrapper-direct-from.json
p --wrapper 0x00000000000000000000000000000000000000d7 --payer $A1 --beneficiary $B1 --amount 1000000000000000000000 --party to --type address --id $B1 --output $OUT/wrapper-direct-to.json
