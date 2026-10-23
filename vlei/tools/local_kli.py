# -*- encoding: utf-8 -*-
"""
Wrapper around `kli` (keripy 1.2.12) for the test ecosystem.

    python tools/local_kli.py [--ks NAME] -- <kli arguments>

- confines all keripy state under `.etat/keri`;
- if `--ks` is given, injects `--passcode` (and `--salt` for `init`) from `.etat/secrets/NAME.json`
  AFTER the process starts: the passphrase appears neither on the command line nor in
  `ps`, nor in the output;
- the return code is kli's (0 success, 255 error, kli prints "ERR: ...").
"""
import sys
from pathlib import Path

RACINE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RACINE))

from verifier import environment  # noqa: E402

AVEC_PASSCODE_INTERDIT = {"saidify", "salt", "version", "passcode"}


def main(argv):
    ks = None
    if argv and argv[0] == "--ks":
        ks, argv = argv[1], argv[2:]
    if argv and argv[0] == "--":
        argv = argv[1:]
    if not argv:
        print("usage: local_kli.py [--ks NAME] -- <kli command>", file=sys.stderr)
        return 2

    environment.confiner(environment.ETAT / "keri")

    if ks is not None and argv[0] not in AVEC_PASSCODE_INTERDIT:
        sys.path.insert(0, str(RACINE / "tools"))
        import local_secrets
        sec = local_secrets.lire(ks)
        argv = list(argv) + ["--passcode", sec["passcode"]]
        if argv[0] == "init":
            argv += ["--salt", sec["salt"]]

    sys.argv = ["kli"] + list(argv)
    from keri.app.cli.kli import main as kli_main
    rc = kli_main()
    return 0 if rc in (None, 0) else 255


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
