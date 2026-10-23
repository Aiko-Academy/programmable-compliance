# -*- encoding: utf-8 -*-
"""
SAIDifies an ACDC schema with `kli saidify`, block by block, like the official vLEI schemas.

Procedure (identical to `vlei.app.generating.populateSAIDS` of the WebOfTrust/vLEI repository):
1. for each block `a`, `e`, `r`, the `oneOf` object that carries a `$id` is SAIDified on its own;
2. then the whole schema is SAIDified on `$id`.
Each SAIDification goes through `kli saidify --file <f> --label '$id'` (keripy 1.2.12).

    python tools/saidifier_schema.py schemas/source/transfer-mandate.json schemas/publies/transfer-mandate.json
    python tools/saidifier_schema.py --official-checks

`--official-checks` empties the `$id` of each official vLEI schema, recomputes them by the same
procedure and compares against the published SAID: that is the proof the procedure is correct.
"""
import copy
import json
import subprocess
import sys
import tempfile
from pathlib import Path

RACINE = Path(__file__).resolve().parents[1]
PY = RACINE / ".venv" / "bin" / "python"
KLI = RACINE / "tools" / "local_kli.py"
OFFICIELS = RACINE / ".sources" / "vLEI" / "schema" / "acdc"


def kli_saidify(objet):
    tmpdir = RACINE / ".etat" / "tmp"
    tmpdir.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", suffix=".json", dir=tmpdir, delete=False) as f:
        json.dump(objet, f)
        chemin = f.name
    try:
        r = subprocess.run([str(PY), str(KLI), "--", "saidify", "--file", chemin, "--label", "$id"],
                           capture_output=True, text=True)
        if r.returncode != 0:
            raise RuntimeError(f"kli saidify failed: {r.stdout} {r.stderr}")
        with open(chemin) as f:
            return json.load(f)
    finally:
        Path(chemin).unlink(missing_ok=True)


def saidifier(schema):
    schema = copy.deepcopy(schema)
    props = schema.get("properties", {})
    for bloc in ("a", "e", "r"):
        if bloc not in props:
            continue
        if "$id" in props[bloc]:
            props[bloc] = kli_saidify(props[bloc])
        elif isinstance(props[bloc].get("oneOf"), list):
            props[bloc]["oneOf"] = [kli_saidify(o) if isinstance(o, dict) and "$id" in o else o
                                    for o in props[bloc]["oneOf"]]
    return kli_saidify(schema)


def vider(schema):
    schema = copy.deepcopy(schema)
    schema["$id"] = ""
    for bloc in ("a", "e", "r"):
        p = schema.get("properties", {}).get(bloc, {})
        if "$id" in p:
            p["$id"] = ""
        for o in p.get("oneOf", []) if isinstance(p.get("oneOf"), list) else []:
            if isinstance(o, dict) and "$id" in o:
                o["$id"] = ""
    return schema


def verifier_schemer(schema):
    """Recomputes the SAID via keripy (Schemer): raises an exception if `$id` does not match."""
    sys.path.insert(0, str(RACINE))
    from verifier import environment  # noqa: F401
    from keri.core import scheming
    return scheming.Schemer(sed=schema).said


def main(argv):
    if argv == ["--official-checks"]:
        ok = True
        for f in sorted(OFFICIELS.glob("*.json")):
            officiel = json.loads(f.read_text())
            recalcule = saidifier(vider(officiel))
            egal = recalcule["$id"] == officiel["$id"] and recalcule == officiel
            ok &= egal
            print(f"{'OK  ' if egal else 'ECART'} {officiel['$id']} {f.name}")
        return 0 if ok else 1

    source, cible = Path(argv[0]), Path(argv[1])
    schema = saidifier(json.loads(source.read_text()))
    said = verifier_schemer(schema)
    assert said == schema["$id"]
    cible.parent.mkdir(parents=True, exist_ok=True)
    cible.write_text(json.dumps(schema, indent=2, ensure_ascii=False) + "\n")
    print(said)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
