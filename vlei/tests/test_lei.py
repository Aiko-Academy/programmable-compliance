# -*- encoding: utf-8 -*-
"""Fictional LEIs: ISO 17442 check digits and proof of absence from GLEIF (proof file)."""
import json
import sys

from conftest import RACINE, SORTIES

sys.path.insert(0, str(RACINE / "tools"))
import lei  # noqa: E402


def test_check_digits():
    assert lei.valide("506700GE1G29325QX363")  # public GLEIF LEI: positive control of the algorithm
    for l in json.loads((RACINE / "config" / "entities.json").read_text())["entites"].values():
        if l.get("lei"):
            assert l["lei"].startswith("DEMO") and len(l["lei"]) == 20
            assert lei.valide(l["lei"]) and lei.lei_complet(l["lei"][:18]) == l["lei"]
            assert not lei.valide(l["lei"][:19] + str((int(l["lei"][19]) + 1) % 10))


def test_proof_of_absence_gleif():
    p = json.loads((SORTIES / "preuve-lei-absents-gleif.json").read_text())
    assert p["verdict"] is True
    assert p["positiveControl"]["httpStatus"] == 200
    assert {x["lei"] for x in p["fictionalLeis"]} == {
        "DEMO00QVITESTGL1PC75", "DEMO00FIFRPAYER00119", "DEMO00FISG1BENEF0172"}
    assert all(x["httpStatus"] == 404 for x in p["fictionalLeis"])
