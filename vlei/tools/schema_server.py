# -*- encoding: utf-8 -*-
"""
ACDC schema server (WebOfTrust/vLEI's vLEI-server, pinned), listening ONLY on 127.0.0.1.

Reuses the `ACDCMaterialEnd` entry point of vLEI-server (`vlei.app.serving`, WebOfTrust/vLEI
repository at the commit pinned in `sources.lock`), which serves each schema by OOBI under
`/oobi/<SAID>`, with the type `application/schema+json`. The upstream server (`vlei.server`)
binds all interfaces: so we build the same `falcon.App` and serve it via
`hio.core.http.Server(host="127.0.0.1")`.

Served schemas:
- the official vLEI schemas of the `WebOfTrust/vLEI` repository (`schema/acdc/`);
- the demonstration "Transfer Mandate" schema (`schemas/`), which is NOT an official vLEI schema.

Each schema is loaded by `keri.core.scheming.Schemer`, which recomputes its SAID: a file
whose `$id` does not match its content makes startup fail.

    python tools/schema_server.py --port 7723
"""
import argparse
import sys
from pathlib import Path

RACINE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RACINE))
from verifier import environment  # noqa: E402

VLEI_SRC = RACINE / ".sources" / "vLEI" / "src"
SCHEMAS_OFFICIELS = RACINE / ".sources" / "vLEI" / "schema" / "acdc"
SCHEMAS_DEMO = RACINE / "schemas"
HOTE = "127.0.0.1"


def main():
    p = argparse.ArgumentParser(description="Local ACDC schema server (127.0.0.1)")
    p.add_argument("--port", type=int, default=7723)
    args = p.parse_args()

    environment.confiner(environment.ETAT / "keri")
    sys.path.insert(0, str(VLEI_SRC))

    import falcon
    from hio.base import doing
    from hio.core import http
    from vlei.app import caching, serving

    vide = environment.ETAT / "schemas-credentials-vide"
    vide.mkdir(parents=True, exist_ok=True)

    app = falcon.App()
    fin = serving.ACDCMaterialEnd(schemaDir=str(SCHEMAS_OFFICIELS), credDir=str(vide))
    caching.cacheSchema(str(SCHEMAS_DEMO / "publies"), fin.schemaCache)
    app.add_route("/oobi/{said}", fin)
    app.add_route("/health", serving.HealthEnd())

    serveur = http.Server(host=HOTE, port=args.port, app=app)
    if not serveur.reopen():
        raise SystemExit(f"cannot open {HOTE}:{args.port}")
    for said in sorted(fin.schemaCache):
        print(f"schema {said}", flush=True)
    print(f"schema server on http://{HOTE}:{args.port}/oobi/<SAID>", flush=True)
    doist = doing.Doist(limit=0.0, tock=0.03125, real=True)
    doist.do(doers=[http.ServerDoer(server=serveur)])


if __name__ == "__main__":
    main()
