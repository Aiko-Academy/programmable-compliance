# -*- encoding: utf-8 -*-
"""
Launches a KERI witness (keripy 1.2.12) listening ONLY on 127.0.0.1, HTTP only.

`kli witness start` binds its HTTP server to 0.0.0.0 and its TCP server to all interfaces
(`keri.app.indirecting.setupWitness`, hardcoded host). We reuse exactly the same witness
code, replacing only the HTTP server factory to force the host 127.0.0.1, and with no
TCP server (`tcp=None`).

    python tools/witness.py --name temoin-1 --port 5642

The witness keystore is created on first launch (local salt and passphrase, `.etat/secrets/`),
with a configuration file that declares its controller URL `http://127.0.0.1:<port>/`.
"""
import argparse
import json
import sys
from pathlib import Path

RACINE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RACINE))
sys.path.insert(0, str(RACINE / "tools"))

from verifier import environment  # noqa: E402
import local_secrets  # noqa: E402

HOTE = "127.0.0.1"


def main():
    p = argparse.ArgumentParser(description="Local KERI witness (127.0.0.1)")
    p.add_argument("--name", required=True)
    p.add_argument("--port", type=int, required=True)
    args = p.parse_args()

    tete = environment.confiner(environment.ETAT / "keri")
    cfdir = tete / "keri" / "cf" / "main"  # Configer: <head>/keri/cf/main/<name>.json
    cfdir.mkdir(parents=True, exist_ok=True)
    cfnom = f"temoin-{args.name}"
    (cfdir / f"{cfnom}.json").write_text(json.dumps({
        "dt": "2026-10-22T00:00:00.000000+00:00",
        args.name: {
            "dt": "2026-10-22T00:00:00.000000+00:00",
            "curls": [f"http://{HOTE}:{args.port}/"],
        },
    }, indent=2))

    local_secrets.assurer(args.name)
    sec = local_secrets.lire(args.name)

    from keri.app import indirecting

    fabrique = indirecting.createHttpServer

    def fabrique_locale(host, port, app, keypath=None, certpath=None, cafilepath=None):
        return fabrique(HOTE, port, app, keypath, certpath, cafilepath)

    indirecting.createHttpServer = fabrique_locale

    # Equivalent of `kli witness start` (keri.app.cli.commands.witness.start.runWitness): on the first
    # launch the keystore is created, encrypted by the local passphrase, with the local salt; the
    # witness (non-transferable AID) is created by setupWitness with its URL read from the config.
    # Intended differences: host 127.0.0.1 (factory replaced above) and no TCP server.
    from keri.app import configing, directing, habbing, keeping
    from keri.app.cli.common import existing

    cf = configing.Configer(name=cfnom, headDirPath=str(tete), temp=False, reopen=True, clear=False)
    ks = keeping.Keeper(name=args.name, base="", temp=False, reopen=True)
    aeid = ks.gbls.get("aeid")
    ks.close()
    if aeid is None:
        hby = habbing.Habery(name=args.name, base="", bran=sec["passcode"], salt=sec["salt"], cf=cf)
    else:
        hby = existing.setupHby(name=args.name, base="", bran=sec["passcode"], cf=cf)

    doers = [habbing.HaberyDoer(habery=hby)]
    doers.extend(indirecting.setupWitness(alias=args.name, hby=hby, aids=None,
                                          tcpPort=None, httpPort=args.port))
    hab = hby.habByName(args.name)
    print(f"witness {args.name} {hab.pre} at http://{HOTE}:{args.port}/", flush=True)
    directing.runController(doers=doers, expire=0.0)


if __name__ == "__main__":
    main()
