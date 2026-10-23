# -*- encoding: utf-8 -*-
"""Wallet binding: KERI signature by the holder of the OOR, verified against its current key state."""
import copy
import time

from conftest import lire
from verifier import binding

ADRESSE = "0x00000000000000000000000000000000000dEaD1"
AUTRE = "0x1111111111111111111111111111111111111111"
CHAINE = 11155111


def _liaison(aid, said, holder="pers-fifr", signataire=None, **kw):
    decl = binding.construire(CHAINE, ADRESSE, aid(holder), said(f"oor-{holder}"), **kw)
    return binding.signer(decl, signataire or holder)


def test_binding_valid(politique, said, aid):
    l = _liaison(aid, said)
    r = binding.verifier_liaison(l, lire("oor-pers-fifr"), politique, chain_id=CHAINE, adresse=ADRESSE.lower())
    assert r["verdict"] is True, r["reasons"]
    assert r["holderAid"] == aid("pers-fifr") and r["lei"] == "DEMO00FIFRPAYER00119"
    assert r["signature"]["validIndices"] == [0]
    assert r["signature"]["holderKeyState"]["keys"] == l["signer"]["keys"]


def test_binding_other_expected_address_refused(politique, said, aid):
    r = binding.verifier_liaison(_liaison(aid, said), lire("oor-pers-fifr"), politique, adresse=AUTRE)
    assert r["verdict"] is False
    assert any("differs from the expected" in x for x in r["reasons"])


def test_binding_address_changed_after_signature_refused(politique, said, aid):
    l = _liaison(aid, said)
    falsifiee = copy.deepcopy(l)
    falsifiee["statement"]["address"] = AUTRE
    falsifiee.pop("canonical")  # the attacker also removes the attached canonical form
    r = binding.verifier_liaison(falsifiee, lire("oor-pers-fifr"), politique)
    assert r["verdict"] is False
    assert any("invalid for the current key" in x for x in r["reasons"]), r["reasons"]


def test_binding_signed_by_another_key_refused(politique, said, aid):
    """Declaration in the name of the holder of FI FR's OOR, signed by FI SG1's person key."""
    l = _liaison(aid, said, holder="pers-fifr", signataire="pers-fisg1")
    assert l["signer"]["aid"] == aid("pers-fisg1")
    r = binding.verifier_liaison(l, lire("oor-pers-fifr"), politique)
    assert r["verdict"] is False
    assert any("invalid for the current key" in x for x in r["reasons"]), r["reasons"]


def test_binding_by_a_non_holder_refused(politique, said, aid):
    """FI SG1's person signs correctly with THEIR OWN key, but claims FI FR's OOR."""
    decl = binding.construire(CHAINE, ADRESSE, aid("pers-fisg1"), said("oor-pers-fifr"))
    l = binding.signer(decl, "pers-fisg1")
    r = binding.verifier_liaison(l, lire("oor-pers-fifr"), politique)
    assert r["verdict"] is False
    assert any("is not the OOR issuer" in x for x in r["reasons"]), r["reasons"]


def test_binding_expired_refused(politique, said, aid):
    l = _liaison(aid, said, valid_until=int(time.time()) - 10)
    r = binding.verifier_liaison(l, lire("oor-pers-fifr"), politique)
    assert r["verdict"] is False
    assert any("binding expired" in x for x in r["reasons"])


def test_binding_on_revoked_oor_refused(politique, said, aid, registre):
    if "oor-pers-fifr-ancien" not in registre.get("revocations", {}):
        import pytest
        pytest.fail("run ./ecosystem.sh revoke")
    l = _liaison(aid, said, holder="pers-fifr-ancien")
    r = binding.verifier_liaison(l, lire("oor-pers-fifr-ancien"), politique)
    assert r["verdict"] is False
    assert any("OOR presentation refused" in x for x in r["reasons"])
