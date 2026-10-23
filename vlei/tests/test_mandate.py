# -*- encoding: utf-8 -*-
"""Transfer Mandate: chain mandat -> OOR -> ... -> root, limits and intent check."""
from datetime import datetime, timedelta, timezone
from decimal import Decimal

import pytest

from conftest import lire
from verifier import mandate


@pytest.fixture()
def m(politique, said):
    r = mandate.verifier_mandat(lire("mandat-agent-fifr"), politique, said=said("mandat-agent-fifr"))
    assert r["verdict"] is True, r["reasons"]
    return r


def test_chain_and_limits(m, aid):
    assert [x["type"] for x in m["issuerChain"]] == ["MANDAT", "OOR", "OOR_AUTH", "LE", "QVI", "RACINE"]
    lim = m["mandate"]
    assert lim["agentAid"] == aid("agent-fifr") == m["holderAid"]
    assert lim["issuerAid"] == aid("pers-fifr")
    assert (lim["maxAmount"], lim["asset"]) == ("250000.00", "EURX")
    assert m["lei"] == "DEMO00FIFRPAYER00119" and m["roleTitle"] == "Head of Payments"


def test_intent_within_limits(m):
    r = mandate.check_intent(m, "1000.00", "EURX", datetime.now(timezone.utc))
    assert r["authorized"] is True, r["reasons"]
    assert mandate.check_intent(m, "250000.00", "EURX")["authorized"] is True  # upper bound included


def test_intent_above_cap(m):
    r = mandate.check_intent(m, Decimal("250000.01"), "EURX")
    assert r["authorized"] is False and any("greater than maxAmount" in x for x in r["reasons"])


def test_intent_other_asset(m):
    r = mandate.check_intent(m, "10", "SGDX")
    assert r["authorized"] is False and any("differs from the mandate's asset" in x for x in r["reasons"])


def test_intent_after_expiry(m):
    fin = datetime.fromisoformat(m["mandate"]["validUntil"].replace("Z", "+00:00"))
    r = mandate.check_intent(m, "10", "EURX", fin + timedelta(seconds=1))
    assert r["authorized"] is False and any("expired" in x for x in r["reasons"])


def test_intent_floating_amount_refused(m):
    assert mandate.check_intent(m, 10.0, "EURX")["authorized"] is False


def test_mandate_expired_refused(politique, said):
    r = mandate.verifier_mandat(lire("mandat-expire-agent-fifr"), politique, said=said("mandat-expire-agent-fifr"))
    assert r["verdict"] is False and any("expired" in x for x in r["reasons"])
    assert mandate.check_intent(r, "1", "EURX")["authorized"] is False


def test_mandate_schema_not_listed_refused(politique, said):
    politique.schemas_autorises = {k: v for k, v in politique.schemas_autorises.items() if v != "MANDAT"}
    r = mandate.verifier_mandat(lire("mandat-agent-fifr"), politique, said=said("mandat-agent-fifr"))
    assert r["verdict"] is False
