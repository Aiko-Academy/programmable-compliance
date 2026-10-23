# -*- encoding: utf-8 -*-
"""
Verifies a minisign signature (Ed25519, the pre-hashed "ED" variant
via BLAKE2b-512), without minisign.

    python tools/verifier_minisign.py <file> <file>.minisig <public key base64>

Checks: algorithm, key ID, the file signature, the global signature of the trusted
comment. Exit code 0 if everything is valid, 1 otherwise.
"""
import base64
import hashlib
import sys

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey


def verifier(fichier, minisig, cle_b64):
    cle = base64.b64decode(cle_b64)
    if cle[:2] != b"Ed":
        raise ValueError("unexpected minisign public key")
    id_cle, pub = cle[2:10], cle[10:42]
    lignes = open(minisig).read().splitlines()
    sig = base64.b64decode(lignes[1])
    alg, id_sig, s = sig[:2], sig[2:10], sig[10:74]
    if id_sig != id_cle:
        raise ValueError("key identifier differs")
    confiance = lignes[2].split("trusted comment: ", 1)[1]
    sig_globale = base64.b64decode(lignes[3])
    donnees = open(fichier, "rb").read()
    message = hashlib.blake2b(donnees, digest_size=64).digest() if alg == b"ED" else donnees
    k = Ed25519PublicKey.from_public_bytes(pub)
    k.verify(s, message)
    k.verify(sig_globale, s + confiance.encode())
    return confiance


if __name__ == "__main__":
    try:
        print("minisign valid:", verifier(*sys.argv[1:4]))
    except (InvalidSignature, ValueError, IndexError) as e:
        print(f"minisign INVALID: {e!r}")
        sys.exit(1)
