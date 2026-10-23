# -*- encoding: utf-8 -*-
"""
Holder key rotation (ACTIVE test, opt-in): a binding signed before rotation must be refused
afterward, because verification runs against the CURRENT key state, re-read from the witnesses.

This test MODIFIES the ecosystem (`kli rotate` on pers-fisg1: the KEL gains an event). It only runs
if VLEI_TEST_ROTATION=1.
"""
import os
import sys

import pytest

from conftest import RACINE, lire
from verifier import binding

pytestmark = pytest.mark.skipif(os.environ.get("VLEI_TEST_ROTATION") != "1",
                                reason="active test: set VLEI_TEST_ROTATION=1 to run it")

ADRESSE = "0x2222222222222222222222222222222222222222"


def test_binding_refused_after_rotation(politique, said, aid):
    sys.path.insert(0, str(RACINE / "tools"))
    import orchestrator

    decl = binding.construire(65650, ADRESSE, aid("pers-fisg1"), said("oor-pers-fisg1"))
    avant = binding.signer(decl, "pers-fisg1")
    r = binding.verifier_liaison(avant, lire("oor-pers-fisg1"), politique)
    assert r["verdict"] is True, r["reasons"]
    sn_avant = r["signature"]["holderKeyState"]["sn"]

    orchestrator.kli("pers-fisg1", ["rotate", "--name", "pers-fisg1", "--alias", "pers-fisg1"])

    # Same presentation (holder's KEL stale): the re-read from the witnesses brings in the rotation.
    r = binding.verifier_liaison(avant, lire("oor-pers-fisg1"), politique)
    assert r["verdict"] is False
    assert r["signature"]["holderKeyState"]["sn"] > sn_avant
    assert any("invalid for the current key" in x for x in r["reasons"]), r["reasons"]

    apres = binding.signer(decl, "pers-fisg1")
    assert apres["signer"]["keys"] != avant["signer"]["keys"]
    r = binding.verifier_liaison(apres, lire("oor-pers-fisg1"), politique)
    assert r["verdict"] is True, r["reasons"]
