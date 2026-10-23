# -*- encoding: utf-8 -*-
"""
Test salts and passphrases, generated locally on first use in `.etat/secrets/`.

Rules:
- never a hardcoded value in the repository;
- one file per keystore, permissions 0600, folder 0700;
- no function of this module prints a secret value. `lire()` returns it to the caller, who
  passes it to keripy in memory (never on a command line visible to `ps`).
"""
import json
import os
import secrets
import string
import sys
from pathlib import Path

RACINE = Path(__file__).resolve().parents[1]
DOSSIER = RACINE / ".etat" / "secrets"

# Same alphabet and same length as `kli passcode generate` (keripy 1.2.12).
ALPHABET = string.ascii_lowercase + string.ascii_uppercase + "123456789"
LONGUEUR = 21


def _sel():
    sys.path.insert(0, str(RACINE))
    from verifier import environment  # noqa: F401  (libsodium)
    from keri.core import signing
    return signing.Salter().qb64  # 128 random bits, CESR code 0A


def assurer(nom):
    """Creates the secret of keystore `nom` if missing. Returns True
    if created, False if it existed."""
    DOSSIER.mkdir(parents=True, exist_ok=True)
    os.chmod(DOSSIER, 0o700)
    chemin = DOSSIER / f"{nom}.json"
    if chemin.exists():
        return False
    valeur = {
        "passcode": "".join(secrets.choice(ALPHABET) for _ in range(LONGUEUR)),
        "salt": _sel(),
    }
    fd = os.open(chemin, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(valeur, f)
    return True


def lire(nom):
    chemin = DOSSIER / f"{nom}.json"
    with open(chemin) as f:
        return json.load(f)


if __name__ == "__main__":
    for n in sys.argv[1:]:
        print(f"{n}: {'created' if assurer(n) else 'already present'}")
