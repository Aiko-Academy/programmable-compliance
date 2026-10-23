# -*- encoding: utf-8 -*-
"""
Orchestration of the test vLEI ecosystem, through the `kli` commands of keripy 1.2.12.

Called by `ecosystem.sh`:

    python tools/orchestrator.py issue      # AIDs, OOBI, registries, credentials (idempotent)
    python tools/orchestrator.py revoke     # revokes the demonstration OOR (pers-fifr-ancien)
    python tools/orchestrator.py export     # CESR presentations and JSON sheets for the EVM side
    python tools/orchestrator.py status       # summary of .etat/registre.json

Each kli command is logged in `.etat/journal/kli.log` (no secret: the passphrase is
injected into the process by `local_kli.py`, never on the command line). The state (AIDs, SAIDs,
registries) is kept in `.etat/registre.json`: a step already done is skipped.

DATA KEPT AS SPELLED, not prose: the state keys (`aids`, `registres`, `nom`, `emetteur`,
`porteur`, `admis`, `grant`, `revocations`, `oobis`, `mandat`, `racine`, `temoins`, `entites`,
`delegueePar`, `libelle`, `entite`, `ecrit`), the registry table REGISTRES, the presentation and
entity identifiers (`oor-pers-fifr`, `pers-fifr`, `reg-qvi-test`, `temoin-1`, ...), the `kli`
arguments and subcommands, and the config file name `ecosysteme`. They are the shared vocabulary of
`.etat/registre.json`, config/entities.json, tools/lei.py, verifier/cli.py, verifier/binding.py and
the exported sheets.
"""
import json
import re
import shlex
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path

RACINE = Path(__file__).resolve().parents[1]
ETAT = RACINE / ".etat"
TETE = ETAT / "keri"
CF_DIR = TETE / "keri" / "cf"
TMP = ETAT / "tmp"
JOURNAL = ETAT / "journal"
REGISTRE = ETAT / "registre.json"
SORTIES = RACINE / "sorties"
PY = str(RACINE / ".venv" / "bin" / "python")
KLI = str(RACINE / "tools" / "local_kli.py")
CONF = json.loads((RACINE / "config" / "entities.json").read_text())
SCHEMAS_OFFICIELS = RACINE / ".sources" / "vLEI" / "schema" / "acdc"
SCHEMA_MANDAT = RACINE / "schemas" / "publies" / "transfer-mandate.json"

S_QVI = "EBfdlu8R27Fbx-ehrqwImnK-8Cm79sqbAQ4MmvEAYqao"
S_LE = "ENPXp1vQzRF6JwIuS-mp2U8Uf1MoADoP_GqQ62VsDZWY"
S_OOR_AUTH = "EKA57bKBKxr_kN7iN5i7lMUxpMG-s19dRcmov1iDxz-E"
S_OOR = "EBNaNu-M9P5cgrnfl2Fvymy4E_jvxxyjb70PRtiANlJy"
S_ECR_AUTH = "EH6ekLjSr8V32WyFbGe1zXjTzFs9PkTYmupJ9H65O14g"
S_ECR = "EEy9PkikFcANV1l7EHukCeXqrzT1hNZjGlUk7wuMO5jw"
S_MANDAT = json.loads(SCHEMA_MANDAT.read_text())["$id"]
SCHEMAS = [S_QVI, S_LE, S_OOR_AUTH, S_OOR, S_ECR_AUTH, S_ECR, S_MANDAT]

ENT = CONF["entites"]


class Echec(RuntimeError):
    pass


# ----------------------------------------------------------------------------------------------
# Logging, state, kli invocation


def maintenant():
    return datetime.now(timezone.utc)


def iso(dt):
    return dt.isoformat(timespec="microseconds")


def dire(msg):
    ligne = f"[{maintenant().strftime('%H:%M:%S')}] {msg}"
    print(ligne, flush=True)
    with open(JOURNAL / "orchestre.log", "a") as f:
        f.write(ligne + "\n")


def lire_registre():
    if REGISTRE.exists():
        return json.loads(REGISTRE.read_text())
    return {"aids": {}, "registres": {}, "credentials": {}, "oobis": [], "revocations": {}}


def ecrire_registre(reg):
    REGISTRE.write_text(json.dumps(reg, indent=2, ensure_ascii=False) + "\n")


def kli(ks, args, timeout=240):
    """Runs `kli <args>` on keystore `ks`. Raises Echec if kli fails. Returns standard output."""
    cmd = [PY, "-W", "ignore", KLI] + (["--ks", ks] if ks else []) + ["--"] + [str(a) for a in args]
    visible = "kli " + " ".join(shlex.quote(str(a)) for a in args)
    debut = time.time()
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, stdin=subprocess.DEVNULL)
    except subprocess.TimeoutExpired as e:
        with open(JOURNAL / "kli.log", "a") as f:
            f.write(f"\n$ {visible}\n[timeout after {timeout} s]\n{e.stdout or ''}\n")
        raise Echec(f"timeout ({timeout} s): {visible}")
    with open(JOURNAL / "kli.log", "a") as f:
        f.write(f"\n$ {visible}\n[rc={r.returncode} {time.time() - debut:.1f} s]\n{r.stdout}{r.stderr}")
    if r.returncode != 0 or "ERR:" in r.stdout:
        raise Echec(f"{visible} -> rc={r.returncode}: {(r.stdout + r.stderr).strip()[-600:]}")
    return r.stdout


def kli_fond(ks, args):
    """Runs kli in the background (delegation: `incept` and `confirm` in parallel)."""
    cmd = [PY, "-W", "ignore", KLI] + (["--ks", ks] if ks else []) + ["--"] + [str(a) for a in args]
    log = open(JOURNAL / "kli.log", "a")
    log.write(f"\n$ (fond) kli {' '.join(shlex.quote(str(a)) for a in args)}\n")
    log.flush()
    return subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                            stdin=subprocess.DEVNULL)


def fichier_tmp(nom, objet):
    TMP.mkdir(parents=True, exist_ok=True)
    chemin = TMP / nom
    chemin.write_text(json.dumps(objet, indent=1, ensure_ascii=False))
    return chemin


def saidifier(nom, objet):
    """SAIDifies a block (field `d`) with `kli saidify` and returns the file path."""
    chemin = fichier_tmp(nom, objet)
    kli(None, ["saidify", "--file", chemin, "--label", "d"])
    return chemin


# ----------------------------------------------------------------------------------------------
# Witnesses and keystore configuration


def temoins():
    t = json.loads((ETAT / "temoins.json").read_text())
    return t  # {name: {"pre":..., "url":...}}


def oobi_aid(aid):
    t = temoins()
    premier = t["temoin-1"]
    return f"{premier['url']}/oobi/{aid}/witness/{premier['pre']}"


def poser_config():
    t = temoins()
    port = CONF["schemaServer"]["port"]
    cf = {
        "dt": "2026-10-22T00:00:00.000000+00:00",
        "iurls": [f"{w['url']}/oobi/{w['pre']}/controller" for w in t.values()],
        "durls": [f"http://127.0.0.1:{port}/oobi/{s}" for s in SCHEMAS],
    }
    CF_DIR.mkdir(parents=True, exist_ok=True)
    # `kli init` reads its configuration via Configer(base=""): <head>/keri/cf/<name>.json
    (CF_DIR / "ecosysteme.json").write_text(json.dumps(cf, indent=1))


def fichier_inception(delpre=None):
    t = temoins()
    d = {"transferable": True, "wits": [w["pre"] for w in t.values()], "toad": 2,
         "icount": 1, "ncount": 1, "isith": "1", "nsith": "1"}
    if delpre:
        d["delpre"] = delpre
    return fichier_tmp(f"inception{'-delegue' if delpre else ''}.json", d)


def keystore_existe(ks):
    return (TETE / "keri" / "ks" / ks).exists()


def assurer_keystore(ks):
    sys.path.insert(0, str(RACINE / "tools"))
    import local_secrets
    local_secrets.assurer(ks)
    if keystore_existe(ks):
        return
    dire(f"keystore {ks}: kli init (OOBIs of the witnesses and schemas)")
    sortie = kli(ks, ["init", "--name", ks, "--config-dir", TETE, "--config-file", "ecosysteme"])
    echecs = [l for l in sortie.splitlines() if l.endswith("failed")]
    if echecs:
        raise Echec(f"OOBIs not resolved for {ks}: {echecs}")


def prefixe(ks, alias):
    sortie = kli(ks, ["status", "--name", ks, "--alias", alias])
    m = re.search(r"Identifier:\s+(\S+)", sortie)
    return m.group(1) if m else None


def aid_existe(ks, alias):
    try:
        return prefixe(ks, alias)
    except Echec:
        return None


# ----------------------------------------------------------------------------------------------
# Steps


def etape_aids(reg):
    poser_config()
    for cle, e in ENT.items():
        assurer_keystore(e["keystore"])

    # Non-delegated AIDs
    for cle, e in ENT.items():
        if e.get("delegueePar"):
            continue
        pre = aid_existe(e["keystore"], e["alias"])
        if not pre:
            dire(f"{cle}: kli incept ({e['label']})")
            sortie = kli(e["keystore"], ["incept", "--name", e["keystore"], "--alias", e["alias"],
                                         "--file", fichier_inception()])
            pre = re.search(r"Prefix\s+(\S+)", sortie).group(1)
        reg["aids"][cle] = pre
        ecrire_registre(reg)

    # Delegated AIDs (QVI delegated by the test root, as a QVI is delegated by GLEIF External)
    for cle, e in ENT.items():
        deleg = e.get("delegueePar")
        if not deleg:
            continue
        ks, alias = e["keystore"], e["alias"]
        pre = aid_existe(ks, alias)
        if not pre:
            proxy = f"{alias}-proxy"
            if not aid_existe(ks, proxy):
                dire(f"{cle}: proxy AID {proxy} for the delegation request")
                kli(ks, ["incept", "--name", ks, "--alias", proxy, "--file", fichier_inception()])
            dr = ENT[deleg]
            kli(ks, ["oobi", "resolve", "--name", ks, "--oobi-alias", dr["alias"],
                     "--oobi", oobi_aid(reg["aids"][deleg])])
            dire(f"{cle}: inception delegated by {deleg} ({reg['aids'][deleg]}), confirmation -Y")
            p_icp = kli_fond(ks, ["incept", "--name", ks, "--alias", alias, "--proxy", proxy,
                                  "--file", fichier_inception(reg["aids"][deleg])])
            time.sleep(2)
            p_conf = kli_fond(dr["keystore"], ["delegate", "confirm", "--name", dr["keystore"],
                                               "--alias", dr["alias"], "-Y"])
            try:
                s_icp, _ = p_icp.communicate(timeout=300)
                s_conf, _ = p_conf.communicate(timeout=300)
            except subprocess.TimeoutExpired:
                p_icp.kill()
                p_conf.kill()
                raise Echec("delegation: timeout")
            with open(JOURNAL / "kli.log", "a") as f:
                f.write(f"\n[incept delegue rc={p_icp.returncode}]\n{s_icp}\n[confirm rc={p_conf.returncode}]\n{s_conf}\n")
            if p_icp.returncode != 0 or p_conf.returncode != 0 or "ERR:" in s_icp + s_conf:
                raise Echec(f"delegation failed: {s_icp[-400:]} / {s_conf[-400:]}")
            pre = re.search(r"Prefix\s+(\S+)", s_icp).group(1)
        reg["aids"][cle] = pre
        ecrire_registre(reg)
    for cle in ENT:
        dire(f"AID {cle:18s} {reg['aids'][cle]}")


def etape_oobis(reg):
    """Each keystore resolves the OOBI (witness) of each of the other AIDs."""
    faits = set(reg.get("oobis", []))

    def resoudre(ks_cle):
        e = ENT[ks_cle]
        for autre, ae in ENT.items():
            cle = f"{ks_cle}>{autre}"
            if autre == ks_cle or cle in faits:
                continue
            kli(e["keystore"], ["oobi", "resolve", "--name", e["keystore"], "--oobi-alias", ae["alias"],
                                "--oobi", oobi_aid(reg["aids"][autre])])
            faits.add(cle)

    dire("OOBI: full mesh between AIDs (through witness 1)")
    with ThreadPoolExecutor(max_workers=4) as ex:
        list(ex.map(resoudre, list(ENT)))
    reg["oobis"] = sorted(faits)
    ecrire_registre(reg)


REGISTRES = {"racine": "reg-racine-test", "qvi": "reg-qvi-test", "le-fifr": "reg-le-fifr",
             "le-fisg1": "reg-le-fisg1", "pers-fifr": "reg-pers-fifr"}


def etape_registres(reg):
    for cle, nom in REGISTRES.items():
        if cle in reg["registres"]:
            continue
        e = ENT[cle]
        dire(f"registry {nom} for {cle} (TEL without backers, anchored in the issuer's KEL)")
        sortie = kli(e["keystore"], ["vc", "registry", "incept", "--name", e["keystore"], "--alias", e["alias"],
                                     "--registry-name", nom])
        m = re.search(r"Registry:\s+\S+\((\S+)\)", sortie)
        reg["registres"][cle] = {"nom": nom, "regk": m.group(1) if m else None}
        ecrire_registre(reg)


def regles(schema_said):
    """Rules block built from the schema's constants (official legal text)."""
    if schema_said == S_MANDAT:
        sch = json.loads(SCHEMA_MANDAT.read_text())
    else:
        sch = next(json.loads(f.read_text()) for f in SCHEMAS_OFFICIELS.glob("*.json")
                   if json.loads(f.read_text())["$id"] == schema_said)
    rb = next(o for o in sch["properties"]["r"]["oneOf"] if isinstance(o, dict) and o.get("type") == "object")
    r = {"d": ""}
    for k, v in rb["properties"].items():
        if k == "d":
            continue
        r[k] = {"l": v["properties"]["l"]["const"]}
    return r


def emettre_credential(reg, cle, emetteur, porteur, schema, donnees, aretes=None, prive=False):
    """kli vc create, then IPEX grant (issuer) and admit (holder).

    `prive`: nonce-bearing credential (`u` at the credential and attribute levels), required by the
    vLEI ECR schema (`u` field required), per the ECR privacy rules."""
    if cle in reg["credentials"] and reg["credentials"][cle].get("admis"):
        return reg["credentials"][cle]["said"]
    ee, pe = ENT[emetteur], ENT[porteur]
    info = reg["credentials"].get(cle)
    if not info:
        dire(f"credential {cle}: {emetteur} -> {porteur} (schema {schema})")
        f_data = fichier_tmp(f"{cle}-donnees.json", donnees)
        args = ["vc", "create", "--name", ee["keystore"], "--alias", ee["alias"],
                "--registry-name", REGISTRES[emetteur], "--schema", schema,
                "--recipient", reg["aids"][porteur], "--data", f"@{f_data}",
                "--rules", f"@{saidifier(f'{cle}-regles.json', regles(schema))}"]
        if aretes:
            args += ["--edges", f"@{saidifier(f'{cle}-aretes.json', aretes)}"]
        if prive:
            args += ["--private"]
        sortie = kli(ee["keystore"], args)
        said = re.search(r"(\S+) has been created", sortie).group(1)
        info = {"said": said, "emetteur": emetteur, "porteur": porteur, "schema": schema,
                "issuerAid": reg["aids"][emetteur], "porteurAid": reg["aids"][porteur]}
        reg["credentials"][cle] = info
        ecrire_registre(reg)
    said = info["said"]
    if not info.get("grant"):
        sortie = kli(ee["keystore"], ["ipex", "grant", "--name", ee["keystore"], "--alias", ee["alias"],
                                      "--said", said, "--recipient", reg["aids"][porteur]])
        info["grant"] = re.search(r"Sending message (\S+) to", sortie).group(1)
        ecrire_registre(reg)
    # The holder polls its mailbox until it sees the grant, then admits it.
    for essai in range(30):
        sortie = kli(pe["keystore"], ["ipex", "list", "--name", pe["keystore"], "--alias", pe["alias"],
                                      "--type", "grant", "--poll", "--said"])
        if info["grant"] in sortie.split():
            break
        time.sleep(1)
    else:
        raise Echec(f"grant {info['grant']} never received by {porteur}")
    kli(pe["keystore"], ["ipex", "admit", "--name", pe["keystore"], "--alias", pe["alias"],
                         "--said", info["grant"]])
    # Proof that the holder holds the credential, checked by its own keripy Verifier.
    for essai in range(30):
        sortie = kli(pe["keystore"], ["vc", "list", "--name", pe["keystore"], "--alias", pe["alias"],
                                      "--said"])
        if said in sortie.split():
            break
        time.sleep(1)
    else:
        raise Echec(f"{said} admitted but absent from {porteur}'s store (chain not verified?)")
    info["admis"] = True
    ecrire_registre(reg)
    dire(f"credential {cle} {said} admitted by {porteur}")
    return said


def etape_credentials(reg):
    lei = {k: e.get("lei") for k, e in ENT.items()}
    # 1. QVI: test root -> QVI
    qvi = emettre_credential(reg, "qvi", "racine", "qvi", S_QVI, {"LEI": lei["qvi"]})
    # 2. LE: QVI -> each legal entity
    le = {}
    for k in ("le-fifr", "le-fisg1"):
        le[k] = emettre_credential(reg, k, "qvi", k, S_LE, {"LEI": lei[k]},
                                   {"d": "", "qvi": {"n": qvi, "s": S_QVI}})
    # 3. OOR Auth (LE -> QVI) then OOR (QVI -> person), I2I chain
    for p in ("pers-fifr", "pers-fisg1", "pers-fifr-ancien"):
        e = ENT[p]
        auth = emettre_credential(reg, f"oor-auth-{p}", e["le"], "qvi", S_OOR_AUTH,
                                  {"AID": reg["aids"][p], "LEI": e["lei"],
                                   "personLegalName": e["personLegalName"], "officialRole": e["officialRole"]},
                                  {"d": "", "le": {"n": le[e["le"]], "s": S_LE}})
        emettre_credential(reg, f"oor-{p}", "qvi", p, S_OOR,
                           {"LEI": e["lei"], "personLegalName": e["personLegalName"],
                            "officialRole": e["officialRole"]},
                           {"d": "", "auth": {"n": auth, "s": S_OOR_AUTH, "o": "I2I"}})
    # 4. ECR Auth (LE -> QVI) then ECR (QVI -> person) for FI SG1
    for p, e in ENT.items():
        if not e.get("ecr"):
            continue
        auth = emettre_credential(reg, f"ecr-auth-{p}", e["le"], "qvi", S_ECR_AUTH,
                                  {"AID": reg["aids"][p], "LEI": e["lei"],
                                   "personLegalName": e["personLegalName"],
                                   "engagementContextRole": e["ecr"]["engagementContextRole"]},
                                  {"d": "", "le": {"n": le[e["le"]], "s": S_LE}})
        emettre_credential(reg, f"ecr-{p}", "qvi", p, S_ECR,
                           {"LEI": e["lei"], "personLegalName": e["personLegalName"],
                            "engagementContextRole": e["ecr"]["engagementContextRole"]},
                           {"d": "", "auth": {"n": auth, "s": S_ECR_AUTH, "o": "I2I"}}, prive=True)
    # 4 bis. TRAP credential for negative tests: a cryptographically valid OOR (signed, anchored,
    # correct I2I chain) whose LEI (FI FR's) contradicts the FI SG1 authorization it chains to.
    # keripy accepts it; the verifier's policy must refuse it (LEI consistency).
    e = ENT["pers-fisg1"]
    emettre_credential(reg, "oor-piege-lei-pers-fisg1", "qvi", "pers-fisg1", S_OOR,
                       {"LEI": ENT["le-fifr"]["lei"], "personLegalName": e["personLegalName"],
                        "officialRole": e["officialRole"]},
                       {"d": "", "auth": {"n": reg["credentials"]["oor-auth-pers-fisg1"]["said"],
                                          "s": S_OOR_AUTH, "o": "I2I"}})

    # 5. Transfer mandates: holder of the OOR -> agent (I2I edge to the OOR)
    for a, e in ENT.items():
        m = e.get("mandate")
        if not m:
            continue
        oor = reg["credentials"][f"oor-{m['emetteur']}"]["said"]
        debut = maintenant().replace(microsecond=0)
        for suffixe, fin, objet in (("", debut + timedelta(days=m["validiteJours"]), m["purpose"]),
                                    ("-expire", debut - timedelta(days=1),
                                     "TEST ONLY: expired mandate, must be refused")):
            emettre_credential(reg, f"mandat{suffixe}-{a}", m["emetteur"], a, S_MANDAT,
                               {"agentAid": reg["aids"][a], "maxAmount": m["maxAmount"], "asset": m["asset"],
                                "validUntil": fin.isoformat().replace("+00:00", "Z"), "purpose": objet},
                               {"d": "", "oor": {"n": oor, "s": S_OOR, "o": "I2I"}})


# ----------------------------------------------------------------------------------------------
# Exports


def exporter_cesr(porteur, said):
    """CESR presentation: the holder's KEL, then the full credential (issuers' KELs, TEL, chain)."""
    e = ENT[porteur]
    kel = kli(e["keystore"], ["export", "--name", e["keystore"], "--alias", e["alias"]])
    vc = kli(e["keystore"], ["vc", "export", "--name", e["keystore"], "--alias", e["alias"],
                             "--said", said, "--full"])
    return kel.strip() + vc


# Exported presentations: credential key -> holder
PRESENTATIONS = {
    "oor-pers-fifr": "pers-fifr",
    "oor-pers-fisg1": "pers-fisg1",
    "ecr-pers-fisg1": "pers-fisg1",
    "oor-pers-fifr-ancien": "pers-fifr-ancien",
    "mandat-agent-fifr": "agent-fifr",
    "mandat-expire-agent-fifr": "agent-fifr",
    "oor-piege-lei-pers-fisg1": "pers-fisg1",
}

# Sheets for the EVM side: one per party, backed by the presentation of its OOR (or mandate).
PARTIES = {
    "fi-fr-payeur": {"credential": "oor-pers-fifr", "entite": "le-fifr",
                     "label": "FI FR (payer's bank), holder of the Head of Payments OOR"},
    "fi-sg1-beneficiaire": {"credential": "oor-pers-fisg1", "entite": "le-fisg1",
                            "label": "FI SG1 (beneficiary's bank), holder of the Head of Treasury OOR"},
    "fi-fr-agent-mandate": {"credential": "mandat-agent-fifr", "entite": "le-fifr",
                            "label": "Agent of FI FR, holder of a Transfer Mandate issued by FI FR's OOR"},
}


def config_verificateur(reg):
    t = temoins()
    conf = {
        "_note": ("PINNED root: AID of the TEST root of this ecosystem (stands in for GLEIF "
                  "External, it is not GLEIF). In production it would be GLEIF External's published AID."),
        "rootAid": reg["aids"]["racine"],
        "allowedSchemas": [S_QVI, S_LE, S_OOR_AUTH, S_OOR, S_ECR_AUTH, S_ECR, S_MANDAT],
        "mandateSchema": S_MANDAT,
        "witnesses": {w["pre"]: w["url"] for w in t.values()},
        "freshness": "required",
    }
    (SORTIES / "config-verificateur.json").write_text(json.dumps(conf, indent=2, ensure_ascii=False) + "\n")
    return conf


def etape_exporter(reg):
    sys.path.insert(0, str(RACINE))
    from verifier import core

    pres = SORTIES / "presentations"
    pres.mkdir(parents=True, exist_ok=True)
    config_verificateur(reg)
    politique = core.Politique.depuis_fichier(SORTIES / "config-verificateur.json")
    resultats = {}
    for cle, porteur in PRESENTATIONS.items():
        info = reg["credentials"].get(cle)
        if not info or not info.get("admis"):
            continue
        flux = exporter_cesr(porteur, info["said"])
        (pres / f"{cle}.cesr").write_text(flux)
        if cle == "oor-pers-fifr-ancien" and cle not in reg.get("revocations", {}):
            # Snapshot BEFORE revocation: used to show that a stale presentation is refused.
            (pres / f"{cle}-avant-revocation.cesr").write_text(flux)
        r = core.verifier_flux(flux.encode(), politique, said=info["said"])
        resultats[cle] = r
        dire(f"export {cle}.cesr ({len(flux)} bytes): verdict {r['verdict']} {r['reasons'][:1]}")

    parties = SORTIES / "parties"
    parties.mkdir(parents=True, exist_ok=True)
    for nom, p in PARTIES.items():
        r = resultats.get(p["credential"])
        if r is None:
            continue
        cesr = f"toolkit/vlei/sorties/presentations/{p['credential']}.cesr"
        conf = "toolkit/vlei/sorties/config-verificateur.json"
        sous = "mandate" if r.get("role") == "MANDAT" else "presentation"
        fiche = {
            "party": nom,
            "label": p["label"],
            "warning": "TEST data: test root (not GLEIF), fictional LEIs prefixed DEMO.",
            "lei": r.get("lei"),
            "role": r.get("role"),
            "roleTitle": r.get("roleTitle"),
            "credentialSaid": r.get("credentialSaid"),
            "holderAid": r.get("holderAid"),
            "rootAid": reg["aids"]["racine"],
            "schemaSaid": r.get("schemaSaid"),
            "issuedAt": r.get("issuedAt"),
            "legalEntityAid": reg["aids"][p["entite"]],
            "verdictAtExport": r.get("verdict"),
            "verifiedAt": r.get("checkedAt"),
            "presentation": cesr,
            "verifierCall": (f"toolkit/vlei/vlei-verifier {sous} --cesr {cesr} "
                                  f"--said {r.get('credentialSaid')} --config {conf}"),
            "contract": {
                "since": "repository root (paths relative to the caller's current folder)",
                "input": ("text CESR stream: the holder's KEL, then `kli vc export --full` of the credential "
                           "(issuers' KELs, the registry's and the credential's TEL, chained credentials); "
                           "--cesr - for standard input"),
                "output": ("one JSON object on standard output: verdict, reasons[], lei, role, roleTitle, "
                           "credentialSaid, holderAid, issuerChain[], telStatus, checkedAt (UTC), freshness"),
                "exitCodes": {"0": "verdict true", "1": "verdict false", "2": "usage or internal error"},
            },
        }
        if r.get("role") == "OOR":
            fiche["bindingCall"] = (f"toolkit/vlei/vlei-verifier binding verify --binding <binding.json> "
                                     f"--cesr {cesr} --config {conf} --chain-id <chainId> --address <0x...>")
        if r.get("role") == "MANDAT":
            fiche["mandate"] = r.get("mandate")
            fiche["intentCall"] = (f"toolkit/vlei/vlei-verifier intent --cesr {cesr} "
                                       f"--said {r.get('credentialSaid')} --config {conf} "
                                       f"--amount <decimal> --asset <asset> [--a <ISO 8601 UTC>]")
        (parties / f"{nom}.json").write_text(json.dumps(fiche, indent=2, ensure_ascii=False) + "\n")
        dire(f"sheet sorties/parties/{nom}.json")


def etape_revoquer(reg):
    cle = "oor-pers-fifr-ancien"
    info = reg["credentials"][cle]
    if cle in reg.get("revocations", {}):
        dire(f"{cle} already revoked ({reg['revocations'][cle]['a']})")
        return
    q = ENT["qvi"]
    dire(f"revocation of {cle} {info['said']} by the QVI, registry {REGISTRES['qvi']} (TEL rev anchored in its KEL)")
    kli(q["keystore"], ["vc", "revoke", "--name", q["keystore"], "--alias", q["alias"],
                        "--registry-name", REGISTRES["qvi"], "--said", info["said"],
                        "--send", ENT["pers-fifr-ancien"]["alias"]])
    reg.setdefault("revocations", {})[cle] = {"said": info["said"], "a": iso(maintenant())}
    ecrire_registre(reg)
    # The holder polls its mailbox (it receives the TEL rev event sent by --send).
    p = ENT["pers-fifr-ancien"]
    kli(p["keystore"], ["vc", "list", "--name", p["keystore"], "--alias", p["alias"], "--poll"])


def resume(reg):
    print(f"  root (TEST, not GLEIF) {reg['aids'].get('racine')}")
    for cle, aid in reg.get("aids", {}).items():
        print(f"  AID {cle:18s} {aid}")
    for cle, c in reg.get("credentials", {}).items():
        etat = "REVOKED" if cle in reg.get("revocations", {}) else ("admitted" if c.get("admis") else "in progress")
        print(f"  {cle:28s} {c['said']} {etat}")


def main(argv):
    JOURNAL.mkdir(parents=True, exist_ok=True)
    cmd = argv[0] if argv else "resume"
    reg = lire_registre()
    if cmd == "issue":
        debut = time.time()
        etape_aids(reg)
        etape_oobis(reg)
        etape_registres(reg)
        etape_credentials(reg)
        dire(f"issuance finished in {time.time() - debut:.0f} s")
    elif cmd == "export":
        etape_exporter(reg)
    elif cmd == "revoke":
        etape_revoquer(reg)
    elif cmd == "resume":
        resume(reg)
    elif cmd == "status":
        print(json.dumps(reg, indent=2, ensure_ascii=False))
    else:
        raise SystemExit(f"unknown command: {cmd}")


if __name__ == "__main__":
    try:
        main(sys.argv[1:])
    except Echec as ex:
        dire(f"FAILURE: {ex}")
        sys.exit(1)
