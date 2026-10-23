# -*- encoding: utf-8 -*-
"""
Core of the vLEI verifier: CESR presentation -> JSON verdict.

Built on the verification classes of keripy 1.2.14, without modifying them:
- `keri.core.eventing.Kevery` : KEL (signatures against key state, pre-rotation commitments,
  witness receipts at the `toad` threshold, anchoring of delegation);
- `keri.vdr.eventing.Tevery` : TEL of the registry and of each credential (iss, rev), each event
  anchored by a seal in the issuer's KEL;
- `keri.vdr.verifying.Verifier` : ACDC (SAID, JSON schema, anchoring in the TEL, edges and the I2I operator);
- `keri.core.scheming` : schemas, loaded only from the allowlist (SAIDs recomputed).

Added to this is the policy, explicit and tested:
- PINNED root (configured, never derived from the presentation);
- allowlist of schema SAIDs;
- expected chain shape per type (OOR -> OOR Auth -> LE -> QVI -> root, same for ECR, mandat -> OOR);
- consistency of the LEI, the name and the role along the chain;
- registry controlled by the issuer of the credential (otherwise a third party could "issue" in another's name);
- QVI delegated by the root (vLEI governance: a QVI is delegated by GLEIF External);
- TEL status at verification time: TEL present AND, if the witnesses are reachable, the KEL of each
  issuer re-read from the witnesses to look there for a revocation seal (s = 1) that the
  presentation might have omitted.
"""
import json
import logging
import shutil
import tempfile
import urllib.error
import urllib.request
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

from . import environment

S_QVI = "EBfdlu8R27Fbx-ehrqwImnK-8Cm79sqbAQ4MmvEAYqao"
S_LE = "ENPXp1vQzRF6JwIuS-mp2U8Uf1MoADoP_GqQ62VsDZWY"
S_OOR_AUTH = "EKA57bKBKxr_kN7iN5i7lMUxpMG-s19dRcmov1iDxz-E"
S_OOR = "EBNaNu-M9P5cgrnfl2Fvymy4E_jvxxyjb70PRtiANlJy"
S_ECR_AUTH = "EH6ekLjSr8V32WyFbGe1zXjTzFs9PkTYmupJ9H65O14g"
S_ECR = "EEy9PkikFcANV1l7EHukCeXqrzT1hNZjGlUk7wuMO5jw"

# Official SAIDs of the vLEI 1.0 schemas (WebOfTrust/vLEI repository, tag 1.0.5). Recomputed at load time.
SCHEMAS_VLEI = {S_QVI: "QVI", S_LE: "LE", S_OOR_AUTH: "OOR_AUTH", S_OOR: "OOR",
                S_ECR_AUTH: "ECR_AUTH", S_ECR: "ECR"}

DOSSIER_SCHEMAS_VLEI = environment.RACINE / ".sources" / "vLEI" / "schema" / "acdc"
FICHIER_SCHEMA_MANDAT = environment.RACINE / "schemas" / "publies" / "transfer-mandate.json"


def schema_mandat():
    return json.loads(FICHIER_SCHEMA_MANDAT.read_text())["$id"]


def maintenant():
    return datetime.now(timezone.utc)


def iso(dt):
    return dt.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


@dataclass
class Politique:
    """What the verifier accepts. The root is PINNED: it comes from the configuration."""
    racine: str
    schemas_autorises: dict = field(default_factory=lambda: dict(SCHEMAS_VLEI))
    temoins: dict = field(default_factory=dict)  # witness AID -> base URL (http://127.0.0.1:5642)
    fraicheur: str = "required"  # required | optional | none
    delai_http: float = 5.0

    @classmethod
    def depuis_fichier(cls, chemin, **surcharges):
        c = json.loads(Path(chemin).read_text())
        sch = dict(SCHEMAS_VLEI)
        if c.get("mandateSchema"):
            sch[c["mandateSchema"]] = "MANDAT"
        autorises = {k: v for k, v in sch.items() if k in set(c.get("allowedSchemas", sch))}
        p = cls(racine=c["rootAid"], schemas_autorises=autorises,
                temoins={k: v for k, v in c.get("witnesses", {}).items()},
                fraicheur=c.get("freshness", "required"))
        for k, v in surcharges.items():
            if v is not None:
                setattr(p, k, v)
        return p


class _Capture(logging.Handler):
    """Collects the errors logged by keripy during parsing (diagnostic for the verdict)."""

    def __init__(self):
        super().__init__(level=logging.INFO)
        self.lignes = []

    def emit(self, record):
        try:
            msg = record.getMessage()
        except Exception:  # pragma: no cover
            msg = str(record.msg)
        if record.levelno >= logging.ERROR or "unescrow" in msg.lower():
            self.lignes.append(f"{record.levelname}: {msg[:300]}")


@contextmanager
def _contexte_keri():
    """Disposable keripy database: a temporary folder under .etat/verif/, erased on exit."""
    base = environment.ETAT / "verif"
    base.mkdir(parents=True, exist_ok=True)
    tete = Path(tempfile.mkdtemp(prefix="v-", dir=base))
    environment.confiner(tete)
    from keri.app import habbing
    from keri.core import eventing, parsing, routing
    from keri.vdr import eventing as veventing
    from keri.vdr import verifying, viring

    # keripy's logs (the "hio.help.ogling" logger) are diverted to the capture during
    # verification: standard output stays pure JSON for the caller (the EVM attester).
    capture = _Capture()
    lg = logging.getLogger("hio.help.ogling")
    ancien, anciens = lg.level, list(lg.handlers)
    for h in anciens:
        lg.removeHandler(h)
    lg.addHandler(capture)
    lg.setLevel(logging.INFO)
    hby = reger = None
    try:
        hby = habbing.Habery(name="verificateur", temp=False, headDirPath=str(tete))
        reger = viring.Reger(name="verificateur", temp=False, headDirPath=str(tete))
        kvy = eventing.Kevery(db=hby.db, lax=False, local=False)
        rvy = routing.Revery(db=hby.db)
        kvy.registerReplyRoutes(router=rvy.rtr)
        tvy = veventing.Tevery(reger=reger, db=hby.db, local=False)
        vry = verifying.Verifier(hby=hby, reger=reger)
        ctx = dict(hby=hby, reger=reger, kvy=kvy, rvy=rvy, tvy=tvy, vry=vry, psr=parsing.Parser(),
                   capture=capture)
        yield ctx
    finally:
        lg.removeHandler(capture)
        for h in anciens:
            lg.addHandler(h)
        lg.setLevel(ancien)
        for db in (reger, hby):
            try:
                if db is not None:
                    db.close()
            except Exception:
                pass
        shutil.rmtree(tete, ignore_errors=True)


def _charger_schemas(ctx, politique):
    from keri.core import scheming
    res = scheming.CacheResolver(db=ctx["hby"].db)
    charges = {}
    fichiers = list(DOSSIER_SCHEMAS_VLEI.glob("*.json")) + [FICHIER_SCHEMA_MANDAT]
    for f in fichiers:
        raw = f.read_bytes()
        schemer = scheming.Schemer(raw=raw)  # recomputes the SAID
        if schemer.said in politique.schemas_autorises:
            res.add(schemer.said, raw)
            charges[schemer.said] = schemer.sed.get("title")
    return charges


def _ingerer(ctx, flux):
    ctx["psr"].parse(ims=bytearray(flux), kvy=ctx["kvy"], tvy=ctx["tvy"], vry=ctx["vry"], rvy=ctx["rvy"],
                     local=False)
    _escrows(ctx)


def _escrows(ctx, tours=6):
    for _ in range(tours):
        ctx["kvy"].processEscrows()
        ctx["tvy"].processEscrows()
        ctx["vry"].processEscrows()


def _etat_cles(ctx, aid):
    kever = ctx["kvy"].kevers.get(aid)
    if kever is None:
        return None
    return {
        "aid": aid,
        "sn": kever.sner.num,
        "lastEvent": kever.serder.said,
        "currentKeys": [v.qb64 for v in kever.verfers],
        "signingThreshold": kever.tholder.sith,
        "witnesses": list(kever.wits),
        "witnessThreshold": kever.toader.num,
        "delegataire": kever.delpre,
    }


def _sceaux_revocation(ctx, emetteur, said):
    """Looks in the issuer's KEL for a rank-1 TEL event seal (revocation) for `said`."""
    from keri.core import serdering
    trouves = []
    for msg in ctx["hby"].db.clonePreIter(pre=emetteur):
        serder = serdering.SerderKERI(raw=bytes(msg))
        for sceau in serder.ked.get("a", []) or []:
            if isinstance(sceau, dict) and sceau.get("i") == said and sceau.get("s") == "1":
                trouves.append({"kelSn": serder.sn, "kelEvent": serder.said, "revEvent": sceau.get("d")})
    return trouves


def _rafraichir(ctx, politique, aids):
    """Re-reads each AID's KEL from its witnesses (witness OOBI), at verification time."""
    rapport = {}
    for aid in aids:
        kever = ctx["kvy"].kevers.get(aid)
        avant = kever.sner.num if kever else None
        wits = list(kever.wits) if kever else list(politique.temoins)
        ok, erreurs = 0, []
        for w in wits:
            base = politique.temoins.get(w)
            if not base:
                erreurs.append(f"witness {w} has no configured URL")
                continue
            url = f"{base}/oobi/{aid}/witness/{w}"
            try:
                with urllib.request.urlopen(url, timeout=politique.delai_http) as rep:
                    corps = rep.read()
                _ingerer(ctx, corps)
                ok += 1
            except (urllib.error.URLError, OSError) as e:
                erreurs.append(f"{url}: {e}")
        kever = ctx["kvy"].kevers.get(aid)
        rapport[aid] = {"snBefore": avant, "snAfter": kever.sner.num if kever else None,
                        "witnessesJoined": ok, "errors": erreurs}
    return rapport


def _type(schema, politique):
    return politique.schemas_autorises.get(schema)


# Expected chain shape: type -> (edge label, target type)
ARETE_ATTENDUE = {
    "OOR": ("auth", "OOR_AUTH"),
    "ECR": ("auth", "ECR_AUTH"),
    "OOR_AUTH": ("le", "LE"),
    "ECR_AUTH": ("le", "LE"),
    "LE": ("qvi", "QVI"),
    "MANDAT": ("oor", "OOR"),
    "QVI": None,
}


def _feuille(ctx):
    """The presentation's credential that no other one references by an edge."""
    reger = ctx["reger"]
    creds = {_cle_said(k): c for k, c in reger.creds.getItemIter()}
    references = set()
    for c in creds.values():
        for k, v in (c.edge or {}).items():
            if isinstance(v, dict) and "n" in v:
                references.add(v["n"])
    feuilles = [s for s in creds if s not in references]
    return feuilles


def verifier_flux(flux, politique, said=None, a_l_instant=None, apres=None):
    """Verifies a CESR presentation (bytes). Returns the verdict dictionary.

    `apres(ctx, resultat)`: complementary check run in the same keripy context (KELs already
    ingested and refreshed), for example the verification of a wallet binding.

    DATA KEPT AS SPELLED, not prose: the output keys (`verdict`, `raisons`, `fraicheur`,
    `kelReadFromWitnesses`, `witnessesJoined`, `pinnedRoot`, `mandate`, `issuerAid`) and the
    `raisons` sentences are the contract read by attester/attester.mjs, live-pass.mjs and the tests.
    """
    with _contexte_keri() as ctx:
        r = _verifier(ctx, flux, politique, said, a_l_instant)
        if apres is not None:
            apres(ctx, r)
        return r


def _cle_said(k):
    if isinstance(k, tuple):
        k = k[0]
    return k.decode() if isinstance(k, (bytes, bytearray)) else k


def _verifier(ctx, flux, politique, said, a_l_instant=None):
    controle = a_l_instant or maintenant()
    raisons = []
    sortie = {"verdict": False, "checkedAt": iso(maintenant()), "pinnedRoot": politique.racine}
    charges = _charger_schemas(ctx, politique)
    _ingerer(ctx, flux)
    reger, kvy = ctx["reger"], ctx["kvy"]
    creds = {_cle_said(k): c for k, c in reger.creds.getItemIter()}

    if said is None:
        feuilles = _feuille(ctx)
        if len(feuilles) != 1:
            raisons.append(f"ambiguous or missing credential to verify (leaves: {feuilles}), specify --said")
            sortie["reasons"] = raisons
            sortie["journalKeri"] = ctx["capture"].lignes[-12:]
            return sortie
        said = feuilles[0]
    sortie["credentialSaid"] = said
    if said not in creds:
        raisons.append(f"credential {said} absent from the presentation or rejected while parsing "
                       "(invalid SAID: altered content, or unreadable CESR stream)")
        sortie["reasons"] = raisons
        sortie["journalKeri"] = ctx["capture"].lignes[-12:]
        return sortie

    # Freshness: issuer KELs (and the holder's) re-read from the witnesses at verification time.
    chaine_saids, curseur, vus = [], said, set()
    while curseur in creds and curseur not in vus:
        vus.add(curseur)
        chaine_saids.append(curseur)
        c = creds[curseur]
        suivants = [v["n"] for k, v in (c.edge or {}).items() if isinstance(v, dict) and "n" in v]
        curseur = suivants[0] if suivants else None
    aids = []
    for s in chaine_saids:
        c = creds[s]
        for a in (c.issuer, (c.attrib or {}).get("i") if isinstance(c.attrib, dict) else None):
            if a and a not in aids:
                aids.append(a)
    if politique.racine not in aids:
        aids.append(politique.racine)
    if politique.fraicheur != "none":
        rap = _rafraichir(ctx, politique, aids)
        _escrows(ctx)
        sortie["freshness"] = {"mode": politique.fraicheur, "kelReadFromWitnesses": rap}
        injoignables = [a for a, r in rap.items() if r["witnessesJoined"] == 0]
        if injoignables and politique.fraicheur == "required":
            raisons.append(f"freshness cannot be checked: no witness reached for {injoignables}")
        creds = {_cle_said(k): c for k, c in reger.creds.getItemIter()}
    else:
        sortie["freshness"] = {"mode": "none", "kelReadFromWitnesses": {}}

    chaine = []
    lei_entite = None
    curseur = said
    precedent = None
    vus = set()
    while True:
        if curseur in vus:
            raisons.append(f"cycle in the chain at {curseur}")
            break
        vus.add(curseur)
        c = creds.get(curseur)
        if c is None:
            raisons.append(f"chained credential {curseur} absent from the presentation")
            break
        typ = _type(c.schema, politique)
        a = c.attrib if isinstance(c.attrib, dict) else {}
        maillon = {"credentialSaid": c.said, "type": typ or "INCONNU", "schemaSaid": c.schema,
                   "issuer": c.issuer, "issuee": a.get("i"), "lei": a.get("LEI"), "issuedAt": a.get("dt"),
                   "registre": c.regi}
        chaine.append(maillon)

        # 1. Allowed schema (and loaded from the list, SAID recomputed)
        if typ is None:
            raisons.append(f"{c.said}: schema {c.schema} not in the allowed list")
            break
        # 2. Integrity of the credential SAID and of the attributes block (recomputed)
        from keri.core import coring
        if not coring.Saider(qb64=c.said).verify(sad=c.sad, prefixed=True):
            raisons.append(f"{c.said}: invalid credential SAID")
        if isinstance(c.attrib, dict) and "d" in a and not coring.Saider(qb64=a["d"]).verify(sad=a, prefixed=True):
            raisons.append(f"{c.said}: invalid attributes block SAID")
        # 3. Accepted by the keripy Verifier (JSON schema, TEL anchoring, I2I edges, non-revoked chain)
        if reger.saved.get(keys=(c.said,)) is None:
            raisons.append(f"{c.said} ({typ}): rejected by the keripy verifier (signature, anchoring, "
                           "schema or chain), see journalKeri")
        # 4. Registry controlled by the issuer, TEL status and anchoring in the issuer's KEL
        tever = reger.tevers.get(c.regi)
        if tever is None:
            raisons.append(f"{c.said}: registry {c.regi} unknown (no TEL)")
            maillon["telStatus"] = "unknown"
        else:
            if tever.pre != c.issuer:
                raisons.append(f"{c.said}: registry {c.regi} controlled by {tever.pre}, not by the issuer {c.issuer}")
            etat = tever.vcState(c.said)
            if etat is None:
                maillon["telStatus"] = "not issued"
                raisons.append(f"{c.said}: no issuance event in the TEL")
            else:
                maillon["telStatus"] = "revoked" if etat.et in ("rev", "brv") else "issued"
                maillon["tel"] = {"sn": etat.s if hasattr(etat, "s") else None, "dt": etat.dt, "ilk": etat.et,
                                  "ancrageKel": dict(etat.a) if getattr(etat, "a", None) else None}
            anc = _sceaux_revocation(ctx, c.issuer, c.said)
            if anc:
                maillon["revocationAncreeDansKel"] = anc
                if maillon.get("telStatus") != "revoked":
                    maillon["telStatus"] = "revoked"
                    maillon["telSource"] = "revocation seal in the issuer's KEL (revocation TEL absent from the presentation)"
            if maillon.get("telStatus") == "revoked":
                raisons.append(f"{c.said} ({typ}): revoked")
        # 5. State of the issuer's keys (KEL)
        maillon["issuerKeyState"] = _etat_cles(ctx, c.issuer)
        if maillon["issuerKeyState"] is None:
            raisons.append(f"{c.said}: issuer {c.issuer} KEL missing")

        # 6. Consistency with the previous link (edge holder and attributes)
        if precedent is not None:
            pc, ptyp = precedent
            pa = pc.attrib if isinstance(pc.attrib, dict) else {}
            if a.get("i") != pc.issuer:
                raisons.append(f"{pc.said} -> {c.said}: broken I2I (holder {a.get('i')} != issuer {pc.issuer})")
            if ptyp in ("OOR", "ECR"):
                if a.get("AID") != pa.get("i"):
                    raisons.append(f"{ptyp}: the authorization targets {a.get('AID')}, not the holder {pa.get('i')}")
                champs = ("LEI", "personLegalName", "officialRole" if ptyp == "OOR" else "engagementContextRole")
                for k in champs:
                    if a.get(k) != pa.get(k):
                        raisons.append(f"{ptyp}: {k} inconsistent with the authorization ({pa.get(k)!r} != {a.get(k)!r})")
            if ptyp in ("OOR_AUTH", "ECR_AUTH") and a.get("LEI") != pa.get("LEI"):
                raisons.append(f"{ptyp}: LEI {pa.get('LEI')} differs from the entity's LEI {a.get('LEI')}")
            if ptyp == "LE":
                lei_entite = pa.get("LEI")

        # 6 bis. Transfer mandate: agent = holder, decimal amount, expiry at verification time
        if typ == "MANDAT":
            from decimal import Decimal, InvalidOperation
            if a.get("agentAid") != a.get("i"):
                raisons.append(f"mandate: agentAid {a.get('agentAid')} differs from the holder {a.get('i')}")
            try:
                if Decimal(a.get("maxAmount", "x")) <= 0:
                    raisons.append("mandate: maxAmount must be strictly positive")
            except InvalidOperation:
                raisons.append(f"mandate: maxAmount {a.get('maxAmount')!r} is not a decimal")
            try:
                fin = datetime.fromisoformat(a.get("validUntil", "").replace("Z", "+00:00"))
                if fin.tzinfo is None:
                    raisons.append("mandate: validUntil without a timezone")
                elif controle > fin:
                    raisons.append(f"mandate: expired since {a.get('validUntil')} (checked at {iso(controle)})")
            except ValueError:
                raisons.append(f"mandate: validUntil {a.get('validUntil')!r} is not an ISO 8601 date")

        # 7. Next edge
        attendu = ARETE_ATTENDUE.get(typ)
        aretes = {k: v for k, v in (c.edge or {}).items() if k not in ("d", "o") and isinstance(v, dict)}
        if attendu is None:  # QVI: end of chain, the issuer must be the pinned root
            if aretes:
                raisons.append(f"{c.said}: a QVI credential must not have an edge")
            if c.issuer != politique.racine:
                raisons.append(f"root: the QVI credential {c.said} is issued by {c.issuer}, "
                               f"not by the pinned root {politique.racine}")
            qvi = kvy.kevers.get(a.get("i"))
            if qvi is None or qvi.delpre != politique.racine:
                raisons.append(f"root: the QVI's AID {a.get('i')} is not delegated by the pinned root")
            break
        etiq, cible = attendu
        if set(aretes) != {etiq}:
            raisons.append(f"{c.said} ({typ}): edges {sorted(aretes)} instead of [{etiq}]")
            break
        noeud = aretes[etiq]
        if _type(noeud.get("s"), politique) is None:
            raisons.append(f"{c.said}: the {etiq} edge points at schema {noeud.get('s')}, not in the allowed list")
            break
        if _type(noeud.get("s"), politique) != cible:
            raisons.append(f"{c.said}: the {etiq} edge requires schema {noeud.get('s')}, expected {cible}")
            break
        if noeud.get("o") not in (None, "I2I"):
            raisons.append(f"{c.said}: operator {noeud.get('o')} on the {etiq} edge, I2I expected")
        cn = creds.get(noeud["n"])
        if cn is not None and cn.schema != noeud.get("s"):
            raisons.append(f"{c.said}: the chained credential {cn.said} does not have the schema the edge requires")
        precedent = (c, typ)
        curseur = noeud["n"]

    chaine.append({"type": "RACINE", "aid": politique.racine, "epinglee": True,
                   "keyState": _etat_cles(ctx, politique.racine)})

    feuille = creds.get(said)
    fa = feuille.attrib if feuille is not None and isinstance(feuille.attrib, dict) else {}
    ftyp = _type(feuille.schema, politique) if feuille is not None else None
    role_titre = fa.get("officialRole") if ftyp == "OOR" else fa.get("engagementContextRole") if ftyp == "ECR" else None
    sortie.update({
        "lei": fa.get("LEI") or lei_entite,
        "role": ftyp,
        "roleTitle": role_titre,
        "personLegalName": fa.get("personLegalName"),
        "credentialSaid": said,
        "schemaSaid": feuille.schema if feuille is not None else None,
        "holderAid": fa.get("i"),
        "issuerAid": feuille.issuer if feuille is not None else None,
        "issuedAt": fa.get("dt"),
        "telStatus": chaine[0].get("telStatus") if chaine else None,
        "issuerChain": chaine,
        "schemasCharges": charges,
    })
    if ftyp == "MANDAT":
        oor = creds.get(((feuille.edge or {}).get("oor") or {}).get("n"))
        oa = oor.attrib if oor is not None and isinstance(oor.attrib, dict) else {}
        sortie["lei"] = oa.get("LEI") or lei_entite
        sortie["roleTitle"] = oa.get("officialRole")
        sortie["personLegalName"] = oa.get("personLegalName")
        sortie["mandate"] = {
            "agentAid": fa.get("agentAid"),
            "maxAmount": fa.get("maxAmount"),
            "asset": fa.get("asset"),
            "validUntil": fa.get("validUntil"),
            "purpose": fa.get("purpose"),
            "issuerAid": feuille.issuer,
            "oorSaid": oor.said if oor is not None else None,
        }
    # LEI consistent along the chain (except the QVI, whose LEI is the QVI's own)
    leis = {m.get("lei") for m in chaine if m.get("type") in ("OOR", "ECR", "OOR_AUTH", "ECR_AUTH", "LE")}
    if len(leis) > 1:
        raisons.append(f"LEI inconsistent along the chain: {sorted(x for x in leis if x)}")
    sortie["reasons"] = list(dict.fromkeys(raisons))
    sortie["verdict"] = not sortie["reasons"]
    sortie["journalKeri"] = ctx["capture"].lignes[-12:]
    return sortie
