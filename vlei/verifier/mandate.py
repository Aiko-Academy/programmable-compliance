# -*- encoding: utf-8 -*-
"""
Transfer Mandate: chain verification and intent check.

`verifier_mandat` verifies the full chain mandate -> OOR -> OOR Auth -> LE -> QVI -> pinned root
(via `noyau`) and returns the mandate's limits. `check_intent` decides whether a given transfer
fits within those limits; it refuses if the mandate was not verified, if the amount exceeds
`maxAmount`, if the asset differs, or if the transfer time is after `validUntil`.
"""
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation

from . import core


def verifier_mandat(flux, politique, said=None, a_l_instant=None):
    """Verifies a mandate presentation. Returns `noyau`'s verdict enriched with the limits."""
    r = core.verifier_flux(flux, politique, said=said, a_l_instant=a_l_instant)
    if r.get("role") != "MANDAT" and r.get("credentialSaid"):
        r["verdict"] = False
        r.setdefault("reasons", []).append(
            f"the credential {r.get('credentialSaid')} is not a Transfer Mandate (schema {r.get('schemaSaid')})")
    return r


def _instant(a_l_instant):
    if a_l_instant is None:
        return datetime.now(timezone.utc)
    if isinstance(a_l_instant, (int, float)):
        return datetime.fromtimestamp(a_l_instant, tz=timezone.utc)
    if isinstance(a_l_instant, str):
        dt = datetime.fromisoformat(a_l_instant.replace("Z", "+00:00"))
    else:
        dt = a_l_instant
    if dt.tzinfo is None:
        raise ValueError("instant without a timezone")
    return dt


def check_intent(mandate, amount, asset, at_time=None):
    """
    Intent check of a transfer against a VERIFIED mandate.

    Parameters:
        mandate: result of `verifier_mandat` (dict with `verdict` and `mandat`)
        amount:  requested amount (decimal string or Decimal; never a float)
        asset:   requested asset (string, compared exactly)
        at_time: time of the transfer (timezone-aware datetime, ISO 8601, or Unix timestamp); now by default

    Returns {"autorise": bool, "raisons": [...], "limites": {...}, "demande": {...}}.
    """
    raisons = []
    limites = (mandate or {}).get("mandate") or {}
    if not mandate or not mandate.get("verdict"):
        raisons.append("mandate not verified or refused: "
                       + "; ".join((mandate or {}).get("reasons", []) or ["no verdict"]))
    if isinstance(amount, float):
        raisons.append("float amount refused: pass a decimal string")
        montant = None
    else:
        try:
            montant = Decimal(str(amount))
            if not montant.is_finite() or montant <= 0:
                raisons.append(f"amount {amount!r} not strictly positive")
        except InvalidOperation:
            montant = None
            raisons.append(f"amount {amount!r} is not a decimal")
    try:
        plafond = Decimal(limites.get("maxAmount", "x"))
    except InvalidOperation:
        plafond = None
        raisons.append("mandate's maxAmount is unreadable")
    if montant is not None and plafond is not None and montant > plafond:
        raisons.append(f"amount {montant} greater than maxAmount {plafond}")
    if asset != limites.get("asset"):
        raisons.append(f"asset {asset!r} differs from the mandate's asset, expected {limites.get('asset')!r}")
    try:
        quand = _instant(at_time)
        fin = datetime.fromisoformat(str(limites.get("validUntil", "")).replace("Z", "+00:00"))
        if quand > fin:
            raisons.append(f"mandate expired at {limites.get('validUntil')} (transfer at {core.iso(quand)})")
    except ValueError as e:
        quand = None
        raisons.append(f"instant or validUntil unreadable: {e}")
    return {
        "authorized": not raisons,
        "reasons": raisons,
        "limits": limites,
        "requested": {"amount": str(amount), "asset": asset, "atTime": core.iso(quand) if quand else None},
        "credentialSaid": (mandate or {}).get("credentialSaid"),
        "agentAid": limites.get("agentAid"),
        "lei": (mandate or {}).get("lei"),
    }
