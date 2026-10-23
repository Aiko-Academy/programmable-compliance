#!/usr/bin/env bash
# REAL proofs bound to the LIVE wrappers (wEURX Sepolia, wSGDX Arbitrum Sepolia), to their conduits and their parties.
set -euo pipefail
cd "$(dirname "$0")"
PK="${PK:-$HOME/.aiko-ceremonies/sanctions-v1/pk/pk.bin}"
go build -o /tmp/prove-sanctions ./cmd/prove-sanctions
PUB=lists/demo-sanctions-v1.json; UETR=0x538a859d49a9960cbce077e6d61df36f
BASE=(--snapshot $PUB --uetr $UETR --pk "$PK" --circuit ceremony-output/circuit.json --vk ceremony-output/vk.bin)
FR=0x7C0984484391D6cD7bFc68d12D1fD3c48f1BbB38; SG1=0xadEe31407e2AdcA6B0f25Bd039DCe047B80AfAde
# Sepolia: wEURX, exact mode, from = FI FR, to = source adapter (conduit). One proof: FI FR.
/tmp/prove-sanctions prove "${BASE[@]}" --chainid 11155111 --wrapper 0x738DE4A03a18891e07Ff001323cA4d150d4B2C84 --payer $FR --beneficiary 0x6ad8F75cfef4BA21499106acE487c3273902eD91 --amount 1000000000000000000000 --party from --type address --id $FR --output fixtures/live-wrapper-source-from.json
# Arbitrum Sepolia: wSGDX, range mode, from = composer (conduit), to = FI SG. One proof: FI SG.
/tmp/prove-sanctions prove "${BASE[@]}" --chainid 421614 --wrapper 0xd8b0f8795141a0B2736BeF452726A39d55638f40 --payer 0x36145Dd3E3b8f5dFa4b4044B1d80Ee5c5b9f356a --beneficiary $SG1 --min 1450000000000000000000 --max 1500000000000000000000 --party to --type address --id $SG1 --output fixtures/live-wrapper-arrival-to.json
