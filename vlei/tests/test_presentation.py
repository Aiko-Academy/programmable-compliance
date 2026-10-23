# -*- encoding: utf-8 -*-
"""OOR and ECR presentations: valid cases, tampering, root, schemas, LEI, revocation, CLI contract."""
import json
import re
import subprocess

import pytest

from conftest import CONFIG, RACINE, lire
from verifier import core


def _message_acdc(texte, said):
    """Position and length of the ACDC message whose SAID is `said` in a text CESR stream."""
    i = texte.index(f'"d":"{said}"')
    debut = texte.rindex('{"v":"ACDC', 0, i)
    taille = int(re.match(r'\{"v":"ACDC10JSON([0-9a-f]{6})_"', texte[debut:]).group(1), 16)
    return debut, taille


# --- valid cases -------------------------------------------------------------------------------

@pytest.mark.parametrize("cle,lei,titre", [
    ("oor-pers-fifr", "DEMO00FIFRPAYER00119", "Head of Payments"),
    ("oor-pers-fisg1", "DEMO00FISG1BENEF0172", "Head of Treasury"),
])
def test_oor_valid(politique, said, aid, cle, lei, titre):
    r = core.verifier_flux(lire(cle), politique, said=said(cle))
    assert r["verdict"] is True, r["reasons"]
    assert r["role"] == "OOR" and r["roleTitle"] == titre and r["lei"] == lei
    assert r["holderAid"] == aid(cle.replace("oor-", ""))
    assert r["telStatus"] == "issued"
    assert [m["type"] for m in r["issuerChain"]] == ["OOR", "OOR_AUTH", "LE", "QVI", "RACINE"]
    assert r["issuerChain"][-1]["aid"] == aid("racine")
    # freshness was indeed measured from the witnesses for each AID of the chain
    assert all(v["witnessesJoined"] >= 1 for v in r["freshness"]["kelReadFromWitnesses"].values())
    assert r["checkedAt"].endswith("Z")


def test_ecr_valid(politique, said):
    r = core.verifier_flux(lire("ecr-pers-fisg1"), politique, said=said("ecr-pers-fisg1"))
    assert r["verdict"] is True, r["reasons"]
    assert r["role"] == "ECR" and r["roleTitle"] == "Settlement Operations Contact"
    assert [m["type"] for m in r["issuerChain"]] == ["ECR", "ECR_AUTH", "LE", "QVI", "RACINE"]


def test_leaf_detected_without_said(politique, said):
    r = core.verifier_flux(lire("oor-pers-fifr"), politique)
    assert r["verdict"] is True and r["credentialSaid"] == said("oor-pers-fifr")


# --- tampering ---------------------------------------------------------------------------------

def test_tampered_credential_refused(politique, said):
    s = said("oor-pers-fifr")
    texte = lire("oor-pers-fifr").decode()
    debut, taille = _message_acdc(texte, s)
    acdc = texte[debut:debut + taille]
    assert "Head of Payments" in acdc
    altere = texte[:debut] + acdc.replace("Head of Payments", "Head of Paymentz", 1) + texte[debut + taille:]
    r = core.verifier_flux(altere.encode(), politique, said=s)
    assert r["verdict"] is False
    assert any("absent from the presentation or rejected" in x for x in r["reasons"]), r["reasons"]


def test_tampered_and_resaidified_credential_refused(politique, said):
    """The attacker recomputes the SAIDs after changing the LEI: the new SAID is anchored nowhere."""
    from keri.core import coring
    s = said("oor-pers-fifr")
    texte = lire("oor-pers-fifr").decode()
    debut, taille = _message_acdc(texte, s)
    sad = json.loads(texte[debut:debut + taille])
    sad["a"]["LEI"] = "DEMO00FISG1BENEF0172"  # same length: the message size does not change
    _, sad["a"] = coring.Saider.saidify(sad=sad["a"], label="d")
    _, sad = coring.Saider.saidify(sad=sad, label="d")
    brut = json.dumps(sad, separators=(",", ":"))
    assert len(brut) == taille
    altere = texte[:debut] + brut + texte[debut + taille:]
    r = core.verifier_flux(altere.encode(), politique, said=sad["d"])
    assert r["verdict"] is False
    assert r["credentialSaid"] == sad["d"] != s


def test_tampered_kel_signature_refused_offline(politique, said, aid):
    """Root inception signature tampered with: without re-reading from the witnesses, the chain falls."""
    texte = lire("oor-pers-fifr").decode()
    racine = aid("racine")
    m = re.search(r'\{"v":"KERI10JSON([0-9a-f]{6})_","t":"icp","d":"' + re.escape(racine), texte)
    fin = m.start() + int(m.group(1), 16)
    pos = texte.index("-AAB", fin) + 4 + 20  # in the middle of the first indexed signature
    car = "A" if texte[pos] != "A" else "B"
    altere = texte[:pos] + car + texte[pos + 1:]
    politique.fraicheur = "none"
    r = core.verifier_flux(altere.encode(), politique, said=said("oor-pers-fifr"))
    assert r["verdict"] is False, r
    temoin = core.verifier_flux(texte.encode(), politique, said=said("oor-pers-fifr"))
    assert temoin["verdict"] is True, temoin["reasons"]  # the same untampered stream passes offline


# --- root, schemas, LEI ------------------------------------------------------------------------

def test_wrong_pinned_root_refused(politique, said, aid):
    politique.racine = aid("le-fifr")  # a real AID of the ecosystem, but not the root
    r = core.verifier_flux(lire("oor-pers-fifr"), politique, said=said("oor-pers-fifr"))
    assert r["verdict"] is False
    assert any(x.startswith("root:") for x in r["reasons"]), r["reasons"]


def test_schema_not_listed_refused(politique, said):
    politique.schemas_autorises = {k: v for k, v in politique.schemas_autorises.items() if v != "OOR_AUTH"}
    r = core.verifier_flux(lire("oor-pers-fifr"), politique, said=said("oor-pers-fifr"))
    assert r["verdict"] is False
    assert any("not in the allowed list" in x for x in r["reasons"]), r["reasons"]


def test_inconsistent_lei_refused_even_if_cryptographically_valid(politique, said):
    """OOR issued and admitted by keripy (valid signatures and anchorings)
    whose LEI contradicts its authorization."""
    r = core.verifier_flux(lire("oor-piege-lei-pers-fisg1"), politique, said=said("oor-piege-lei-pers-fisg1"))
    assert r["verdict"] is False
    assert any("LEI inconsistent" in x for x in r["reasons"]), r["reasons"]
    assert not any("rejected by the keripy verifier" in x for x in r["reasons"])  # keripy accepts it


# --- revocation --------------------------------------------------------------------------------

@pytest.fixture()
def revoque(registre):
    if "oor-pers-fifr-ancien" not in registre.get("revocations", {}):
        pytest.fail("demo revocation not played: run ./ecosystem.sh revoke")
    return registre["credentials"]["oor-pers-fifr-ancien"]["said"]


def test_revoked_refused(politique, revoque):
    r = core.verifier_flux(lire("oor-pers-fifr-ancien"), politique, said=revoque)
    assert r["verdict"] is False and r["telStatus"] == "revoked"
    assert any("revoked" in x for x in r["reasons"])
    # keripy stores the revoked leaf (it only logs it): only the TEL check refuses it.
    assert not any("rejected by the keripy verifier" in x for x in r["reasons"]), r["reasons"]


def test_stale_presentation_refused_thanks_to_witnesses(politique, revoque):
    """Presentation exported BEFORE the revocation (TEL without rev): the KEL re-read
    from the witnesses carries the seal."""
    r = core.verifier_flux(lire("oor-pers-fifr-ancien-avant-revocation"), politique, said=revoque)
    assert r["verdict"] is False
    assert r["issuerChain"][0]["revocationAncreeDansKel"]
    assert "revocation seal" in r["issuerChain"][0]["telSource"]


def test_stale_presentation_passes_without_freshness(politique, revoque):
    """Documented limit: without re-reading from the witnesses, a stale presentation cannot be refused."""
    politique.fraicheur = "none"
    r = core.verifier_flux(lire("oor-pers-fifr-ancien-avant-revocation"), politique, said=revoque)
    assert r["verdict"] is True


def test_same_presentation_serves_two_relying_parties(config, said):
    """Portable evidence: the same presentation, held once by the holder, is verified by two independent
    relying parties (two policies, two checks at different instants), with no contact with the issuer.
    Each check re-reads the witnesses on its own: the second does not rely on the first."""
    pres = lire("oor-pers-fifr")
    s = said("oor-pers-fifr")
    premier = core.verifier_flux(pres, core.Politique.depuis_fichier(CONFIG), said=s)
    second = core.verifier_flux(pres, core.Politique.depuis_fichier(CONFIG), said=s)
    for r in (premier, second):
        assert r["verdict"] is True, r["reasons"]
        assert all(v["witnessesJoined"] >= 1 for v in r["freshness"]["kelReadFromWitnesses"].values())
    assert premier["issuerChain"][0]["credentialSaid"] == second["issuerChain"][0]["credentialSaid"] == s


def _temoins_injoignables(politique):
    """Same witness AIDs, URLs on a closed port: the status service cannot be reached."""
    politique.temoins = {k: "http://127.0.0.1:9" for k in politique.temoins}
    politique.delai_http = 1.0


def test_unreachable_witnesses_refused_when_freshness_required(politique, revoque):
    """Fail-closed rule: when the key state cannot be re-read in time, the verifier refuses.
    Worst case: a presentation exported before a revocation, which only the witnesses can reveal."""
    _temoins_injoignables(politique)
    assert politique.fraicheur == "required"
    r = core.verifier_flux(lire("oor-pers-fifr-ancien-avant-revocation"), politique, said=revoque)
    assert r["verdict"] is False
    assert any("freshness cannot be checked" in x for x in r["reasons"]), r["reasons"]


def test_unreachable_witnesses_refused_for_a_valid_credential_too(politique, said):
    """The refusal does not depend on the credential: a valid OOR is refused as well, nothing is assumed."""
    _temoins_injoignables(politique)
    r = core.verifier_flux(lire("oor-pers-fifr"), politique, said=said("oor-pers-fifr"))
    assert r["verdict"] is False
    assert any("freshness cannot be checked" in x for x in r["reasons"]), r["reasons"]


def test_optional_freshness_is_fail_open_and_says_so(politique, said):
    """Documented limit, not a rule: in `optional` mode an unreachable witness does not refuse.
    The mode exists for offline checks; the corridor runs in `required`."""
    _temoins_injoignables(politique)
    politique.fraicheur = "optional"
    r = core.verifier_flux(lire("oor-pers-fifr"), politique, said=said("oor-pers-fifr"))
    assert r["verdict"] is True
    assert all(v["witnessesJoined"] == 0 for v in r["freshness"]["kelReadFromWitnesses"].values())


# --- command-line contract ---------------------------------------------------------------------

def _cli(*args, entree=None):
    p = subprocess.run([str(RACINE / "vlei-verifier"), *args], capture_output=True, input=entree,
                       timeout=120)
    return p.returncode, json.loads(p.stdout)  # standard output is a JSON and nothing else


def test_cli_contract(said):
    rc, r = _cli("presentation", "--cesr", str(RACINE / "sorties/presentations/oor-pers-fifr.cesr"),
                 "--said", said("oor-pers-fifr"), "--config", str(CONFIG))
    assert rc == 0 and r["verdict"] is True
    for k in ("verdict", "lei", "role", "roleTitle", "credentialSaid", "holderAid", "issuerChain",
              "telStatus", "checkedAt"):
        assert k in r
    rc, r = _cli("presentation", "--cesr", "-", "--config", str(CONFIG),
                 entree=(RACINE / "sorties/presentations/oor-pers-fifr-ancien.cesr").read_bytes())
    assert rc == 1 and r["verdict"] is False
    rc, r = _cli("presentation", "--cesr", "/inexistant.cesr", "--config", str(CONFIG))
    assert rc == 2 and r["verdict"] is False and "error" in r
