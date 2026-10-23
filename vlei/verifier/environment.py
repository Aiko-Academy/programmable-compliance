# -*- encoding: utf-8 -*-
"""
Preparation of the keripy runtime environment, to call BEFORE any import of `keri`.

Two things, and nothing else:

1. libsodium. keripy loads libsodium through `pysodium`, which looks it up with
   `ctypes.util.find_library`. The library is compiled locally under `.deps/libsodium/lib` (no
   system installation); `find_library` reads `DYLD_FALLBACK_LIBRARY_PATH` at call time, so we set
   it here.

2. File confinement. keripy writes by default under `/usr/local/var/keri` or `~/.keri`.
   All of the ecosystem's state must live under `toolkit/vlei/.etat/`, so we rewrite the head of
   the path of every hio and keripy filing class (`HeadDirPath`, `AltHeadDirPath`, `TempHeadDir`)
   to a given folder.
"""
import os
from pathlib import Path

RACINE = Path(__file__).resolve().parents[1]  # toolkit/vlei
ETAT = RACINE / ".etat"
LIBSODIUM = RACINE / ".deps" / "libsodium" / "lib"


def poser_libsodium():
    """Makes libsodium findable by pysodium (call before importing keri)."""
    chemins = [p for p in os.environ.get("DYLD_FALLBACK_LIBRARY_PATH", "").split(":") if p]
    if str(LIBSODIUM) not in chemins:
        chemins.insert(0, str(LIBSODIUM))
    os.environ["DYLD_FALLBACK_LIBRARY_PATH"] = ":".join(chemins)
    os.environ.setdefault("LD_LIBRARY_PATH", str(LIBSODIUM))


def _sous_classes(cls):
    for sous in cls.__subclasses__():
        yield sous
        yield from _sous_classes(sous)


def confiner(tete):
    """Makes hio and keripy write under `tete` (databases, keystores, configs, temporaries)."""
    tete = Path(tete).resolve()
    (tete / "tmp").mkdir(parents=True, exist_ok=True)
    poser_libsodium()

    # Import of the modules that declare filing classes, so the walk sees them all.
    # The order matters: keri.app.habbing pulls keri.core then keri.db without a circular import.
    from hio.base import filing
    import keri.app.habbing  # noqa: F401
    import keri.app.keeping  # noqa: F401
    import keri.app.configing  # noqa: F401
    import keri.app.storing  # noqa: F401
    import keri.app.notifying  # noqa: F401
    import keri.vdr.viring  # noqa: F401

    valeurs = {
        "HeadDirPath": str(tete),
        "AltHeadDirPath": str(tete),
        "TempHeadDir": str(tete / "tmp"),
    }
    for cls in [filing.Filer, *_sous_classes(filing.Filer)]:
        for nom, val in valeurs.items():
            if nom in cls.__dict__:
                setattr(cls, nom, val)
    return tete


poser_libsodium()
