#!/usr/bin/env bash
# vLEI TEST ecosystem (KERI, ACDC, CESR, TEL) by keripy 1.2.14, all under toolkit/vlei/.
#
#   ./ecosystem.sh install        Python 3.12.14 venv, local libsodium, pinned sources
#   ./ecosystem.sh up               3 KERI witnesses and schema server (idempotent, 127.0.0.1 only)
#   ./ecosystem.sh issue          AIDs, OOBI, registries, credentials, exports (idempotent)
#   ./ecosystem.sh issue --reset   complete reset then issuance
#   ./ecosystem.sh revoke         revokes the demonstration OOR (pers-fifr-ancien) through its registry
#   ./ecosystem.sh export         CESR presentations and JSON records into sorties/
#   ./ecosystem.sh prove-lei      proof of absence of the fictitious LEIs in GLEIF (HTTP 404 expected)
#   ./ecosystem.sh status         processes, ports and state summary
#   ./ecosystem.sh down             stops witnesses and schema server
#
# The root is a TEST root standing in for GLEIF External: it is not GLEIF.
# Salts and passphrases are generated locally in .etat/secrets/ (never printed).
# 'witness' and 'temoin-1' below are data: the witness name its log line starts with
# (tools/witness.py) and the key in .etat/temoins.json and config/entities.json.
set -euo pipefail

ICI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ETAT="$ICI/.etat"
PIDS="$ETAT/pids"
JOURNAL="$ETAT/journal"
VENV="$ICI/.venv"
PY="$VENV/bin/python"
export UV_CACHE_DIR="$ICI/.cache/uv"
export PYTHONWARNINGS="ignore::SyntaxWarning"
PYTHON_VERSION="3.12.14"

dire() { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }

lock() { awk -v n="$1" '$1 == n { print $'"$2"' }' "$ICI/sources.lock"; }

witness_ports() { "$PY" -c 'import json,sys; c=json.load(open(sys.argv[1])); [print(k, v["port"]) for k, v in c["witnesses"].items()]' "$ICI/config/entities.json"; }
schema_port() { "$PY" -c 'import json,sys; print(json.load(open(sys.argv[1]))["schemaServer"]["port"])' "$ICI/config/entities.json"; }

# ---------------------------------------------------------------------------------------------
do_install() {
  mkdir -p "$ICI/.deps/src" "$ICI/.sources" "$ICI/.cache"

  if [[ ! -x "$PY" ]]; then
    if ! uv python find "$PYTHON_VERSION" >/dev/null 2>&1; then
      # No Python 3.12.14 on the machine: uv installs it INSIDE the folder, not in ~/.local.
      export UV_PYTHON_INSTALL_DIR="$ICI/.cache/uv-python"
    fi
    dire "Python venv $PYTHON_VERSION"
    uv venv -q --python "$PYTHON_VERSION" "$VENV"
  fi
  dire "Python packages (requirements.lock, hashes required)"
  uv pip sync -q --python "$PY" --require-hashes "$ICI/requirements.lock"

  if [[ ! -f "$ICI/.deps/libsodium/lib/libsodium.dylib" && ! -f "$ICI/.deps/libsodium/lib/libsodium.so" ]]; then
    local url sha arch
    url="$(lock libsodium 2)"; sha="$(lock libsodium 4)"; sha="${sha#sha256:}"
    arch="$ICI/.deps/src/$(basename "$url")"
    dire "libsodium 1.0.20: download, sha256, minisign, compiled into .deps/libsodium"
    [[ -f "$arch" ]] || curl -sSL -o "$arch" "$url"
    [[ -f "$arch.minisig" ]] || curl -sSL -o "$arch.minisig" "$url.minisig"
    echo "$sha  $arch" | shasum -a 256 -c - >/dev/null
    "$PY" "$ICI/tools/verifier_minisign.py" "$arch" "$arch.minisig" "$(lock libsodium-minisign-cle 2)"
    rm -rf "$ICI/.deps/src/libsodium-1.0.20"
    tar -xzf "$arch" -C "$ICI/.deps/src"
    ( cd "$ICI/.deps/src/libsodium-1.0.20" \
      && ./configure --prefix="$ICI/.deps/libsodium" --disable-dependency-tracking >/dev/null \
      && make -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)" >/dev/null && make install >/dev/null )
  fi
  # pysodium looks for libsodium through ctypes.util.find_library: we point it there from the venv.
  local site
  site="$("$PY" -c 'import sysconfig; print(sysconfig.get_paths()["purelib"])')"
  printf 'import os; os.environ["DYLD_FALLBACK_LIBRARY_PATH"] = "%s" + (":" + os.environ["DYLD_FALLBACK_LIBRARY_PATH"] if os.environ.get("DYLD_FALLBACK_LIBRARY_PATH") else "")\n' \
    "$ICI/.deps/libsodium/lib" > "$site/vlei_libsodium.pth"

  local nom url ref commit
  for nom in vLEI keripy vlei-verifier; do
    url="$(lock "$nom" 2)"; ref="$(lock "$nom" 3)"; commit="$(lock "$nom" 4)"
    if [[ ! -d "$ICI/.sources/$nom/.git" ]]; then
      dire "source $nom $ref ($commit)"
      git clone -q "$url" "$ICI/.sources/$nom"
    fi
    git -C "$ICI/.sources/$nom" -c advice.detachedHead=false checkout -q "$commit"
    [[ "$(git -C "$ICI/.sources/$nom" rev-parse HEAD)" == "$commit" ]] || { echo "unexpected commit for $nom" >&2; exit 1; }
  done
  dire "installation OK: keri $("$PY" -c 'import importlib.metadata as m; print(m.version("keri"))'), libsodium $(basename "$(readlink "$ICI/.deps/libsodium/lib/libsodium.dylib" 2>/dev/null || echo libsodium)")"
}

# ---------------------------------------------------------------------------------------------
vivant() { [[ -f "$PIDS/$1.pid" ]] && kill -0 "$(cat "$PIDS/$1.pid")" 2>/dev/null; }

attendre_http() {
  local url="$1" i
  for i in $(seq 1 60); do
    if curl -s -o /dev/null --max-time 2 "$url"; then return 0; fi
    sleep 0.5
  done
  echo "no answer: $url" >&2
  return 1
}

lancer() {  # name, command...
  local nom="$1"; shift
  if vivant "$nom"; then return 0; fi
  nohup "$@" >"$JOURNAL/$nom.log" 2>&1 </dev/null &
  echo $! >"$PIDS/$nom.pid"
}

up() {
  [[ -x "$PY" && -f "$ICI/.deps/libsodium/lib/libsodium.dylib" && -d "$ICI/.sources/vLEI" ]] || do_install
  mkdir -p "$PIDS" "$JOURNAL"
  chmod 700 "$ETAT"
  local nom port ps
  ps="$(schema_port)"
  lancer serveur-schemas "$PY" "$ICI/tools/schema_server.py" --port "$ps"
  while read -r nom port; do
    lancer "$nom" "$PY" "$ICI/tools/witness.py" --name "$nom" --port "$port"
  done < <(witness_ports)
  attendre_http "http://127.0.0.1:$ps/health"
  while read -r nom port; do
    for _ in $(seq 1 60); do grep -q "^witness $nom " "$JOURNAL/$nom.log" 2>/dev/null && break; sleep 0.5; done
    attendre_http "http://127.0.0.1:$port/oobi"
  done < <(witness_ports)
  # Registry of the witnesses (AID and URL) read from their startup log.
  "$PY" - "$JOURNAL" "$ETAT/temoins.json" <<'PYEOF'
import json, re, sys
from pathlib import Path
j, sortie = Path(sys.argv[1]), Path(sys.argv[2])
t = {}
for f in sorted(j.glob("temoin-*.log")):
    m = re.search(r"^witness (\S+) (B[\w-]{43}) at (http://\S+?)/?$", f.read_text(), re.M)
    if m:
        t[m.group(1)] = {"pre": m.group(2), "url": m.group(3)}
sortie.write_text(json.dumps(t, indent=1))
for k, v in t.items():
    print(f"  {k} {v['pre']} {v['url']}")
PYEOF
  verifier_ecoute
}

verifier_ecoute() {
  # Every listen socket of our processes must be on 127.0.0.1: we read it on the machine, not in the code.
  local pid nom bad=0
  for f in "$PIDS"/*.pid; do
    [[ -f "$f" ]] || continue
    nom="$(basename "$f" .pid)"; pid="$(cat "$f")"
    while read -r adr; do
      [[ -z "$adr" ]] && continue
      if [[ "$adr" != 127.0.0.1:* ]]; then echo "NON-LOCAL LISTEN: $nom $adr" >&2; bad=1; fi
      echo "  listen $nom $adr"
    done < <(lsof -nP -a -p "$pid" -iTCP -sTCP:LISTEN 2>/dev/null | awk 'NR>1 {print $9}')
  done
  return $bad
}

down() {
  local f pid
  for f in "$PIDS"/*.pid; do
    [[ -f "$f" ]] || continue
    pid="$(cat "$f")"
    if kill -0 "$pid" 2>/dev/null; then kill "$pid"; dire "stopped $(basename "$f" .pid) ($pid)"; fi
    rm -f "$f"
  done
}

do_reset() {
  dire "reset: stopping, deleting .etat (keystores, secrets, witnesses) and the generated outputs"
  down
  rm -rf "$ETAT"
  rm -rf "$ICI/sorties/presentations" "$ICI/sorties/parties"
  rm -f "$ICI/sorties/liaisons/"*.json 2>/dev/null || true
}

prove_lei() {
  # Fictitious LEIs (DEMO prefix, ISO 17442 check digits): queries the public GLEIF API, 404 expected,
  # with a positive witness (a GLEIF LEI, 200 expected). Timestamped proof in sorties/.
  dire "proof of absence of the fictitious LEIs in GLEIF (api.gleif.org)"
  "$PY" "$ICI/tools/lei.py" prouver "$ICI/config/entities.json" "$ICI/sorties/preuve-lei-absents-gleif.json" >/dev/null
}

show_status() {
  local f
  for f in "$PIDS"/*.pid; do
    [[ -f "$f" ]] || continue
    if kill -0 "$(cat "$f")" 2>/dev/null; then echo "  alive  $(basename "$f" .pid)"; else echo "  DEAD    $(basename "$f" .pid)"; fi
  done
  verifier_ecoute || true
  "$PY" "$ICI/tools/orchestrator.py" resume
}

cmd="${1:-}"; shift || true
case "$cmd" in
  install) do_install ;;
  up) up ;;
  down) down ;;
  issue)
    if [[ "${1:-}" == "--reset" ]]; then do_reset; fi
    up
    prove_lei || dire "WARNING: GLEIF absence proof not renewed (network?), the previous one stays in sorties/"
    "$PY" "$ICI/tools/orchestrator.py" issue
    "$PY" "$ICI/tools/orchestrator.py" export
    ;;
  prove-lei) prove_lei ;;
  revoke)
    up
    "$PY" "$ICI/tools/orchestrator.py" revoke
    "$PY" "$ICI/tools/orchestrator.py" export
    ;;
  export) up; "$PY" "$ICI/tools/orchestrator.py" export ;;
  status) show_status ;;
  *) sed -n '2,16p' "$0"; exit 2 ;;
esac
