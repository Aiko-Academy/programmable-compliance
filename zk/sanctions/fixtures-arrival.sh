#!/usr/bin/env bash
# REAL proofs for the ARRIVAL leg for ZkSanctionsArrivee.t.sol: binding as a range, chain 421614, two lists
# (SAN01 public, SAN02 private to the beneficiary's institution), two parties each. Fixed test parameters.
# DATA KEPT AS SPELLED, not prose: the party values passed to `--party` (donneur, beneficiaire), the
# output names (arrivee-...-donneur, ...-beneficiaire) and /tmp/ne-doit-pas-exister.json are read as-is.
set -euo pipefail
cd "$(dirname "$0")"
PK="${PK:-$HOME/.aiko-ceremonies/sanctions-v1/pk/pk.bin}"
go build -o /tmp/prove-sanctions ./cmd/prove-sanctions
OUT=fixtures; mkdir -p "$OUT"
COMMUN=(--wrapper 0x00000000000000000000000000000000000000d5 --uetr 0x538a859d49a9960cbce077e6d61df36f
  --payer 0x00000000000000000000000000000000000000a1 --beneficiary 0x00000000000000000000000000000000000000b1
  --min 1450000000000000000000 --max 1500000000000000000000 --chainid 421614
  --pk "$PK" --circuit ceremony-output/circuit.json --vk ceremony-output/vk.bin)
ORIG=0x00000000000000000000000000000000000000a1; BENEF=0x00000000000000000000000000000000000000b1
PUB=lists/demo-sanctions-v1.json; PRIV=lists/private-demo/fi-sg-sanctions-private-v1.json
/tmp/prove-sanctions root --snapshot $PRIV > "$OUT/root-private.json"
for l in pub:$PUB priv:$PRIV; do n=${l%%:*}; f=${l#*:}
  /tmp/prove-sanctions prove --snapshot $f "${COMMUN[@]}" --party donneur --type address --id $ORIG  --output "$OUT/arrivee-$n-donneur.json"
  /tmp/prove-sanctions prove --snapshot $f "${COMMUN[@]}" --party beneficiaire --type address --id $BENEF --output "$OUT/arrivee-$n-beneficiaire.json"
done
# refusal: a listed party gets no proof (code 3, no file)
for cas in "$PUB 0x7e57000000000000000000000000000000005a11" "$PRIV 0x7e57000000000000000000000000000000005a12"; do
  rm -f /tmp/ne-doit-pas-exister.json; set +e
  /tmp/prove-sanctions prove --snapshot ${cas% *} "${COMMUN[@]}" --party donneur --type address --id ${cas#* } --output /tmp/ne-doit-pas-exister.json 2>/dev/null; rc=$?; set -e
  [ "$rc" = 3 ] && [ ! -e /tmp/ne-doit-pas-exister.json ] || { echo "FAILURE: ${cas} obtained a proof (rc=$rc)" >&2; exit 1; }
  echo "refusal read: ${cas} (code 3, no file)"
done
