# -*- encoding: utf-8 -*-
"""
Fixtures for the vLEI verifier tests.

The tests run against the REAL ecosystem (witnesses, KEL, TEL, credentials issued by `kli`): they read
the presentations exported in `sorties/presentations/` and the configuration `sorties/config-verificateur.json`.
Prerequisite: `./ecosystem.sh issue` then `./ecosystem.sh revoke`. If the witnesses do not answer,
the tests FAIL (no silent skip: a green must prove something).
"""
import json
import sys
import urllib.request
from pathlib import Path

import pytest

RACINE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RACINE))

from verifier import core  # noqa: E402

SORTIES = RACINE / "sorties"
PRES = SORTIES / "presentations"
CONFIG = SORTIES / "config-verificateur.json"
REGISTRE = RACINE / ".etat" / "registre.json"


@pytest.fixture(scope="session")
def registre():
    if not REGISTRE.exists():
        pytest.fail("ecosystem missing: run ./ecosystem.sh issue")
    return json.loads(REGISTRE.read_text())


@pytest.fixture(scope="session")
def config():
    if not CONFIG.exists():
        pytest.fail("sorties/config-verificateur.json missing: run ./ecosystem.sh issue")
    c = json.loads(CONFIG.read_text())
    for pre, url in c["witnesses"].items():
        try:
            urllib.request.urlopen(f"{url}/oobi/{pre}/controller", timeout=3).read()
        except OSError as e:
            pytest.fail(f"witness {pre} unreachable ({url}): run ./ecosystem.sh up ({e})")
    return c


@pytest.fixture()
def politique(config):
    return core.Politique.depuis_fichier(CONFIG)


@pytest.fixture(scope="session")
def said(registre):
    return lambda cle: registre["credentials"][cle]["said"]


@pytest.fixture(scope="session")
def aid(registre):
    return lambda cle: registre["aids"][cle]


def lire(nom):
    return (PRES / f"{nom}.cesr").read_bytes()
