#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$HERE/.build"
SRC="$ROOT/7zip-26.03"
SOURCE_URL="https://github.com/ip7z/7zip/releases/download/26.03/7z2603-src.tar.xz"
mkdir -p "$ROOT" "$HERE/build"
if [[ ! -d "$SRC" ]]; then
  mkdir -p "$SRC"
  curl --fail --location --retry 3 "$SOURCE_URL" | tar -xJ -C "$SRC"
fi
cp "$HERE/stream7z.cpp" "$SRC/CPP/7zip/UI/Console/Main.cpp"
python3 - "$SRC/CPP/7zip/7zip_gcc.mak" <<'PY'
from pathlib import Path
import sys
p=Path(sys.argv[1])
s=p.read_text()
needle='-sMODULARIZE -sEXPORT_NAME="JS7z"'
repl=needle + " --no-entry -sEXPORTED_FUNCTIONS='[\\\"_stream7z_create\\\",\\\"_stream7z_last_error\\\",\\\"_stream7z_heap_size\\\"]' -sEXPORTED_RUNTIME_METHODS='[\\\"cwrap\\\"]'"
s=s.replace(needle,repl)
s=s.replace("LIB2 += -sEXPORTED_RUNTIME_METHODS='[\\\"callMain\\\", \\\"FS\\\"]'","")
p.write_text(s)
PY
pushd "$SRC/CPP/7zip/Bundles/Alone2" >/dev/null
emmake make -f makefile.gcc ST_MODE=1 EXPORT_ES6=1 -j"${JOBS:-2}"
popd >/dev/null
cp "$SRC/CPP/7zip/Bundles/Alone2/_o/js7z.mjs" "$HERE/build/stream7z.mjs"
cp "$SRC/CPP/7zip/Bundles/Alone2/_o/js7z.wasm" "$HERE/build/stream7z.wasm"
sed -i 's/js7z\.wasm/stream7z.wasm/g' "$HERE/build/stream7z.mjs"
printf 'Built direct 7-Zip 26.03 API module\n'
