#!/usr/bin/env bash
# REAL proofs bound to the LIVE wSGDX wrapper of Arbitrum Sepolia, to payer BANK_FR and beneficiary BANK_SG1: verified by the deployed policy on a fork.
# (SAN01 public, SAN02 private to the beneficiary's institution), two parties each. Fixed test parameters.
set -euo pipefail
cd "$(dirname "$0")"
PK="${PK:-$HOME/.aiko-ceremonies/sanctions-v1/pk/pk.bin}"
go build -o /tmp/prove-sanctions ./cmd/prove-sanctions
OUT=fixtures; mkdir -p "$OUT"
COMMUN=(--wrapper 0xd8b0f8795141a0B2736BeF452726A39d55638f40 --uetr 0x538a859d49a9960cbce077e6d61df36f
  --payer 0x7C0984484391D6cD7bFc68d12D1fD3c48f1BbB38 --beneficiary 0xadEe31407e2AdcA6B0f25Bd039DCe047B80AfAde
  --min 1450000000000000000000 --max 1500000000000000000000 --chainid 421614
  --pk "$PK" --circuit ceremony-output/circuit.json --vk ceremony-output/vk.bin)
ORIG=0x7C0984484391D6cD7bFc68d12D1fD3c48f1BbB38; BENEF=0xadEe31407e2AdcA6B0f25Bd039DCe047B80AfAde
PUB=lists/demo-sanctions-v1.json; PRIV=lists/private-demo/fi-sg-sanctions-private-v1.json
/tmp/prove-sanctions root --snapshot $PRIV > "$OUT/racine-privee-live.json"
for l in pub:$PUB priv:$PRIV; do n=${l%%:*}; f=${l#*:}
  /tmp/prove-sanctions prove --snapshot $f "${COMMUN[@]}" --party donneur --type address --id $ORIG  --output "$OUT/live-arrivee-$n-donneur.json"
  /tmp/prove-sanctions prove --snapshot $f "${COMMUN[@]}" --party beneficiaire --type address --id $BENEF --output "$OUT/live-arrivee-$n-beneficiaire.json"
done
