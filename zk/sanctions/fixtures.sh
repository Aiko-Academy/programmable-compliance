#!/usr/bin/env bash
# Regenerates the real proofs used by the Foundry test (ZkSanctionsReelle.t.sol): fixed test parameters.
# Requires the ceremony's proving key, outside the repository.
# DATA KEPT AS SPELLED, not prose: the party values passed to `--party` (payeur, beneficiaire)
# and the temporary path /tmp/ne-doit-pas-exister.json are read as-is (fixtures contract, Foundry).
set -euo pipefail
cd "$(dirname "$0")"
PK="${PK:-$HOME/.aiko-ceremonies/sanctions-v1/pk/pk.bin}"
go build -o /tmp/prove-sanctions ./cmd/prove-sanctions
OUT=fixtures; mkdir -p "$OUT"
COMMUN=(--snapshot lists/demo-sanctions-v1.json --wrapper 0x00000000000000000000000000000000000000c1
  --uetr 0x538a859d49a9960cbce077e6d61df36f --amount 1000000000000000000000 --chainid 31337
  --pk "$PK" --circuit ceremony-output/circuit.json --vk ceremony-output/vk.bin)
PAYEUR=0x00000000000000000000000000000000000000a1; BENEF=0x00000000000000000000000000000000000000b1
/tmp/prove-sanctions root --snapshot lists/demo-sanctions-v1.json > "$OUT/root.json"
/tmp/prove-sanctions prove "${COMMUN[@]}" --payer $PAYEUR --beneficiary $BENEF --party payeur --type address --id $PAYEUR --output "$OUT/address-payer.json"
/tmp/prove-sanctions prove "${COMMUN[@]}" --payer $PAYEUR --beneficiary $BENEF --party beneficiaire --type address --id $BENEF --output "$OUT/address-beneficiary.json"
# LEI: the CCID of both parties is read by the policy from the IdentityRegistry
/tmp/prove-sanctions prove "${COMMUN[@]}" --payer $PAYEUR --beneficiary $BENEF --party payeur --type lei --id FIFRLEI0000000000001 --output "$OUT/lei-payer.json"
/tmp/prove-sanctions prove "${COMMUN[@]}" --payer $PAYEUR --beneficiary $BENEF --party beneficiaire --type lei --id FISGLEI0000000000001 --output "$OUT/lei-beneficiary.json"
# refusal: listed members, no proof, code 3
for cas in "address 0x7e57000000000000000000000000000000005a11" "lei TESTSANCTION00000001"; do
  set +e; /tmp/prove-sanctions prove "${COMMUN[@]}" --payer $PAYEUR --beneficiary $BENEF --party payeur --type ${cas% *} --id ${cas#* } --output /tmp/ne-doit-pas-exister.json; rc=$?; set -e
  [ "$rc" = 3 ] && [ ! -e /tmp/ne-doit-pas-exister.json ] || { echo "FAILURE: the member ${cas} obtained a proof (rc=$rc)" >&2; exit 1; }
  echo "refusal read: ${cas} (code 3, no file)"
done
