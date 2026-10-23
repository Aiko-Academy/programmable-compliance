# -*- encoding: utf-8 -*-
"""
Fictional demonstration LEIs: computing the ISO 17442 check digits (ISO 7064 MOD 97-10) and
proving absence from the GLEIF register.

An LEI is 20 characters long: 18 alphanumeric characters then 2 check digits such that
converting the full LEI to an integer (A=10 ... Z=35) leaves a remainder of 1 modulo 97.

The demonstration LEIs start with "DEMO": none is a real LEI, and the `prouver` command shows this
by querying GLEIF's public API (expected: HTTP 404 for each one), with a positive
control (GLEIF's own LEI, expected: HTTP 200) to prove the probe can say yes.

    python tools/lei.py calculer DEMO00FIFRPAYER001
    python tools/lei.py prouver config/entities.json sorties/preuve-lei-absents-gleif.json
"""
import json
import string
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone

API = "https://api.gleif.org/api/v1/lei-records/"
# GLEIF's LEI (Global Legal Entity Identifier Foundation), a public record: positive control.
TEMOIN_POSITIF = "506700GE1G29325QX363"


def _entier(chaine):
    return int("".join(str(int(c, 36)) for c in chaine))


def chiffres_controle(base18):
    base18 = base18.upper()
    if len(base18) != 18 or any(c not in string.ascii_uppercase + string.digits for c in base18):
        raise ValueError("an LEI's base is 18 alphanumeric characters")
    return f"{98 - (_entier(base18 + '00') % 97):02d}"


def lei_complet(base18):
    return base18.upper() + chiffres_controle(base18)


def valide(lei):
    return (len(lei) == 20 and lei.isalnum() and lei == lei.upper() and lei[18:].isdigit()
            and _entier(lei) % 97 == 1)


def interroger(lei):
    req = urllib.request.Request(API + lei, headers={"Accept": "application/vnd.api+json"})
    quand = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    try:
        with urllib.request.urlopen(req, timeout=30) as rep:
            return rep.status, quand
    except urllib.error.HTTPError as e:
        return e.code, quand


def prouver(entites, sortie):
    conf = json.load(open(entites))
    leis = sorted({e["lei"] for e in conf["entites"].values() if e.get("lei")})
    lignes = []
    ok = True
    for lei in leis:
        if not lei.startswith("DEMO") or not valide(lei):
            raise SystemExit(f"LEI refused (must start with DEMO and be valid under ISO 17442): {lei}")
        statut, quand = interroger(lei)
        absent = statut == 404
        ok &= absent
        lignes.append({"lei": lei, "url": API + lei, "httpStatus": statut, "checkedAt": quand,
                       "absentFromGleif": absent, "iso17442CheckDigitsValid": True})
    statut, quand = interroger(TEMOIN_POSITIF)
    temoin = {"lei": TEMOIN_POSITIF, "role": "positive control (GLEIF public LEI)", "url": API + TEMOIN_POSITIF,
              "httpStatus": statut, "checkedAt": quand, "expected": 200}
    ok &= statut == 200
    preuve = {"api": API, "verdict": ok, "fictionalLeis": lignes, "positiveControl": temoin}
    with open(sortie, "w") as f:
        json.dump(preuve, f, indent=2, ensure_ascii=False)
        f.write("\n")
    print(json.dumps(preuve, indent=2, ensure_ascii=False))
    return 0 if ok else 1


if __name__ == "__main__":
    if len(sys.argv) >= 3 and sys.argv[1] == "calculer":
        for b in sys.argv[2:]:
            print(lei_complet(b))
    elif len(sys.argv) == 4 and sys.argv[1] == "prouver":
        sys.exit(prouver(sys.argv[2], sys.argv[3]))
    else:
        print(__doc__)
        sys.exit(2)
