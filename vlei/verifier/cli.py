# -*- encoding: utf-8 -*-
"""
Command-line interface of the vLEI verifier.

    vlei-verifier presentation --cesr F|- [--said SAID] --config C [--root AID] [--freshness M] [--a ISO]
    vlei-verifier mandate       --cesr F|- [--said SAID] --config C [--a ISO]
    vlei-verifier intent    --cesr F|- [--said SAID] --config C --amount 1000.00 --asset EURX [--a ISO]
    vlei-verifier binding produce --holder KS --credential SAID --chain-id N --address 0x.. [--nonce N]
                                   [--valid-until UNIX | --duration S] --output F
    vlei-verifier binding verify --binding F --cesr F|- --config C [--chain-id N] [--address 0x..]

Contract:
- standard output: a single JSON object (UTF-8), nothing else;
- exit code: 0 if the verdict is true (or the intent authorized), 1 if false, 2 on a usage error
  or internal error (the JSON then carries `verdict: false` and `erreur`).
"""
import argparse
import json
import sys
from datetime import datetime
from pathlib import Path

from . import environment  # noqa: F401  (libsodium before keri)
from . import binding, mandate, core


def _lire_cesr(chemin):
    if chemin == "-":
        return sys.stdin.buffer.read()
    return Path(chemin).read_bytes()


def _instant(texte):
    if texte is None:
        return None
    dt = datetime.fromisoformat(texte.replace("Z", "+00:00"))
    if dt.tzinfo is None:
        raise ValueError("--a requires a timezone (e.g. 2026-10-22T10:00:00Z)")
    return dt


def _politique(args):
    return core.Politique.depuis_fichier(args.config, racine=getattr(args, "racine", None),
                                          fraicheur=getattr(args, "fraicheur", None))


def _emettre(obj, ok):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False, indent=2) + "\n")
    sys.stdout.flush()
    return 0 if ok else 1


def main(argv=None):
    p = argparse.ArgumentParser(prog="vlei-verifier", description="vLEI verifier (KERI, ACDC, TEL)")
    sp = p.add_subparsers(dest="cmd", required=True)

    def communs(q, said=True):
        q.add_argument("--cesr", required=True, help="CESR presentation (file, or - for standard input)")
        if said:
            q.add_argument("--said", help="SAID of the credential to verify (default: the leaf of the chain)")
        q.add_argument("--config", required=True, help="verifier configuration (pinned root, schemas, witnesses)")
        q.add_argument("--root", help="override of the pinned root (AID)")
        q.add_argument("--freshness", choices=["required", "optional", "none"],
                       help="re-reading of the KELs from the witnesses at check time (default: config)")
        q.add_argument("--a", dest="a", help="time of the check, ISO 8601 with a timezone (default: now)")

    communs(sp.add_parser("presentation", help="verify an OOR or ECR presentation"))
    communs(sp.add_parser("mandate", help="verify a Transfer Mandate and return its limits"))
    qi = sp.add_parser("intent", help="verify a mandate then check a transfer")
    communs(qi)
    qi.add_argument("--amount", required=True, help="decimal amount (string), e.g. 1000.00")
    qi.add_argument("--asset", required=True, help="asset, e.g. EURX")

    ql = sp.add_parser("binding", help="EVM wallet binding")
    sl = ql.add_subparsers(dest="action", required=True)
    pr = sl.add_parser("produce", help="sign a binding with the holder's current KERI key (local ecosystem)")
    pr.add_argument("--holder", required=True, help="holder's keystore (e.g. pers-fifr)")
    pr.add_argument("--alias", help="alias of the AID (default: keystore name)")
    pr.add_argument("--credential", required=True, help="SAID of the holder's OOR")
    pr.add_argument("--holder-aid", help="holder AID (default: the one of the alias)")
    pr.add_argument("--chain-id", required=True, type=int)
    pr.add_argument("--address", required=True)
    pr.add_argument("--nonce")
    pr.add_argument("--valid-until", type=int, help="Unix timestamp")
    pr.add_argument("--duration", type=int, default=3600, help="validity in seconds when --valid-until is absent")
    pr.add_argument("--output", required=True)
    vl = sl.add_parser("verify", help="verify a binding against the OOR presentation")
    vl.add_argument("--binding", required=True)
    communs(vl, said=False)
    vl.add_argument("--chain-id", type=int)
    vl.add_argument("--address")

    args = p.parse_args(argv)
    try:
        if args.cmd == "presentation":
            r = core.verifier_flux(_lire_cesr(args.cesr), _politique(args), said=args.said,
                                    a_l_instant=_instant(args.a))
            return _emettre(r, r["verdict"])
        if args.cmd == "mandate":
            r = mandate.verifier_mandat(_lire_cesr(args.cesr), _politique(args), said=args.said,
                                       a_l_instant=_instant(args.a))
            return _emettre(r, r["verdict"])
        if args.cmd == "intent":
            quand = _instant(args.a)
            m = mandate.verifier_mandat(_lire_cesr(args.cesr), _politique(args), said=args.said, a_l_instant=quand)
            r = mandate.check_intent(m, args.amount, args.asset, quand)
            r["mandateVerdict"] = m.get("verdict")
            r["mandateReasons"] = m.get("reasons")
            return _emettre(r, r["authorized"])
        if args.cmd == "binding" and args.action == "produce":
            holder = args.holder_aid
            if holder is None:
                reg = json.loads((environment.ETAT / "registre.json").read_text())
                cles = [k for k, v in reg["aids"].items() if k == args.holder or k == (args.alias or "")]
                holder = reg["aids"][cles[0]] if cles else None
            decl = binding.construire(args.chain_id, args.address, holder, args.credential,
                                      nonce=args.nonce, valid_until=args.valid_until, duree=args.duration)
            l = binding.signer(decl, args.holder, args.alias)
            Path(args.output).write_text(json.dumps(l, indent=2, ensure_ascii=False) + "\n")
            return _emettre({"ecrit": args.output, **l}, True)
        if args.cmd == "binding" and args.action == "verify":
            l = json.loads(Path(args.binding).read_text())
            r = binding.verifier_liaison(l, _lire_cesr(args.cesr), _politique(args),
                                         chain_id=args.chain_id, adresse=args.address)
            return _emettre(r, r["verdict"])
    except Exception as e:  # the JSON stays the only output, even on error
        sys.stdout.write(json.dumps({"verdict": False, "error": f"{type(e).__name__}: {e}"},
                                    ensure_ascii=False) + "\n")
        return 2
    return 2


if __name__ == "__main__":
    sys.exit(main())
