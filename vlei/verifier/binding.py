# -*- encoding: utf-8 -*-
"""
Wallet binding ("vlei-wallet-binding"): the AID holding an OOR signs, with its CURRENT KERI
signing key, a declaration that binds an EVM address to its credential.

Declaration (exact fields and types):
    {"type": "vlei-wallet-binding", "chainId": <int>, "address": "0x<40 hex>", "holderAid": "<AID>",
     "credentialSaid": "<the OOR's SAID>", "nonce": "<string>", "validUntil": <Unix timestamp, int>}

Signed bytes: canonical JSON form, sorted keys, no spaces, UTF-8 (for this flat object of strings
and integers, this is the JCS form of RFC 8785). The signature is a CESR indexed signature (Siger,
Ed25519) produced by keripy's `Hab.sign`; the index designates the key in the list of current keys.

Verification (`verifier_liaison`):
1. the OOR presentation is valid (chain up to the pinned root, TEL not revoked);
2. `credentialSaid` is the presented OOR and `holderAid` is its holder (attribute `a.i`);
3. the signatures verify against the holder's CURRENT key state (KEL presented then re-read from the
   witnesses) and satisfy its signing threshold;
4. `validUntil` is not past, and, if the caller provides them, `chainId` and `address` are the expected
   ones (address compared case-insensitively).

The EVM signature of the same declaration (wallet side) is outside this module.
"""
import json
import re
import secrets
import sys
import time
from datetime import datetime, timezone

from . import environment, core

TYPE = "vlei-wallet-binding"
CHAMPS = {"type": str, "chainId": int, "address": str, "holderAid": str, "credentialSaid": str,
          "nonce": str, "validUntil": int}
ADRESSE = re.compile(r"^0x[0-9a-fA-F]{40}$")


def canonique(declaration):
    return json.dumps(declaration, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def construire(chain_id, adresse, holder_aid, credential_said, nonce=None, valid_until=None, duree=3600):
    if not ADRESSE.match(adresse):
        raise ValueError(f"invalid EVM address: {adresse}")
    return {
        "type": TYPE,
        "chainId": int(chain_id),
        "address": adresse,
        "holderAid": holder_aid,
        "credentialSaid": credential_said,
        "nonce": nonce or secrets.token_hex(16),
        "validUntil": int(valid_until if valid_until is not None else time.time() + duree),
    }


def signer(declaration, keystore, alias=None):
    """Signs the declaration with the current key of the `alias` AID in the local keystore (test ecosystem).

    The passphrase is read from `.etat/secrets/<keystore>.json` and never leaves the process."""
    environment.confiner(environment.ETAT / "keri")
    sys.path.insert(0, str(environment.RACINE / "tools"))
    import local_secrets
    from keri.app.cli.common import existing

    sec = local_secrets.lire(keystore)
    hby = existing.setupHby(name=keystore, base="", bran=sec["passcode"])
    try:
        hab = hby.habByName(alias or keystore)
        if hab is None:
            raise ValueError(f"alias {alias or keystore} absent from keystore {keystore}")
        ser = canonique(declaration)
        sigers = hab.sign(ser=ser, indexed=True)
        kever = hab.kever
        return {
            "statement": declaration,
            "canonical": ser.decode("utf-8"),
            "signatures": [s.qb64 for s in sigers],
            "signer": {"aid": hab.pre, "sn": kever.sner.num, "event": kever.serder.said,
                       "keys": [v.qb64 for v in kever.verfers]},
            "algorithm": "KERI Ed25519, CESR indexed signature over the canonical form (sorted keys, no spaces)",
            "signedAt": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        }
    finally:
        hby.close()


def _controler_declaration(decl, raisons):
    if not isinstance(decl, dict):
        raisons.append("declaration missing")
        return False
    if set(decl) != set(CHAMPS):
        raisons.append(f"declaration fields {sorted(decl)} instead of {sorted(CHAMPS)}")
    for k, t in CHAMPS.items():
        if k in decl and (not isinstance(decl[k], t) or isinstance(decl[k], bool)):
            raisons.append(f"field {k} of type {type(decl[k]).__name__}, {t.__name__} expected")
    if decl.get("type") != TYPE:
        raisons.append(f"type {decl.get('type')!r} instead of {TYPE!r}")
    if isinstance(decl.get("address"), str) and not ADRESSE.match(decl["address"]):
        raisons.append(f"invalid EVM address: {decl.get('address')}")
    return True


def verifier_liaison(binding, flux_oor, politique, chain_id=None, adresse=None, maintenant=None):
    """Verifies a binding (dict produced by `signer`) against the CESR presentation of the holder's OOR."""
    raisons = []
    decl = (binding or {}).get("statement")
    _controler_declaration(decl, raisons)
    decl = decl if isinstance(decl, dict) else {}
    instant = maintenant or datetime.now(timezone.utc)
    if isinstance(decl.get("validUntil"), int) and instant.timestamp() > decl["validUntil"]:
        raisons.append(f"binding expired (validUntil {decl['validUntil']})")
    if chain_id is not None and decl.get("chainId") != int(chain_id):
        raisons.append(f"chainId {decl.get('chainId')} differs from the expected {chain_id}")
    if adresse is not None and str(decl.get("address", "")).lower() != adresse.lower():
        raisons.append(f"address {decl.get('address')} differs from the expected {adresse}")
    ser = canonique(decl)
    if binding.get("canonical") is not None and binding["canonical"].encode("utf-8") != ser:
        raisons.append("canonical form supplied differs from the declaration (declaration modified after signing)")

    detail = {}

    def controle_signature(ctx, r):
        from keri.core import indexing
        holder = decl.get("holderAid")
        kever = ctx["kvy"].kevers.get(holder)
        if kever is None:
            raisons.append(f"holder's KEL {holder} absent: key state unknown")
            return
        detail["holderKeyState"] = {"aid": holder, "sn": kever.sner.num, "event": kever.serder.said,
                                    "keys": [v.qb64 for v in kever.verfers], "seuil": kever.tholder.sith}
        indices = []
        for qb64 in binding.get("signatures", []):
            try:
                siger = indexing.Siger(qb64=qb64)
            except Exception as e:
                raisons.append(f"unreadable signature: {e}")
                continue
            if siger.index >= len(kever.verfers):
                raisons.append(f"signature index {siger.index} outside the current keys")
                continue
            if kever.verfers[siger.index].verify(siger.raw, ser):
                indices.append(siger.index)
            else:
                raisons.append(f"signature at index {siger.index} invalid for the current key "
                               f"{kever.verfers[siger.index].qb64} of the holder")
        if not kever.tholder.satisfy(indices):
            raisons.append(f"signature threshold {kever.tholder.sith} not met by the holder current key "
                           f"(valid indices: {indices})")
        detail["validIndices"] = indices

    r = core.verifier_flux(flux_oor, politique, said=decl.get("credentialSaid"), apres=controle_signature)
    if not r.get("verdict"):
        raisons.append("OOR presentation refused: " + "; ".join(r.get("reasons", [])))
    if r.get("role") not in ("OOR",):
        raisons.append(f"the credential to bind must be an OOR, not {r.get('role')}")
    if r.get("credentialSaid") != decl.get("credentialSaid"):
        raisons.append("declaration credentialSaid differs from the credential presented")
    if r.get("holderAid") != decl.get("holderAid"):
        raisons.append(f"holderAid {decl.get('holderAid')} is not the OOR issuer ({r.get('holderAid')})")
    raisons = list(dict.fromkeys(raisons))
    return {
        "verdict": not raisons,
        "reasons": raisons,
        "binding": decl,
        "holderAid": decl.get("holderAid"),
        "address": decl.get("address"),
        "chainId": decl.get("chainId"),
        "credentialSaid": decl.get("credentialSaid"),
        "lei": r.get("lei"),
        "role": r.get("role"),
        "roleTitle": r.get("roleTitle"),
        "signature": detail,
        "oor": {k: r.get(k) for k in ("verdict", "reasons", "telStatus", "lei", "roleTitle", "checkedAt")},
        "checkedAt": core.iso(datetime.now(timezone.utc)),
    }
