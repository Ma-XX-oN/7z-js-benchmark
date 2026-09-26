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
chmod -R u+w "$SRC"
cp "$HERE/stream7z.cpp" "$SRC/CPP/7zip/UI/Console/Main.cpp"
cat >> "$SRC/CPP/7zip/7zip_gcc.mak" <<'MAKE'
LDFLAGS += --no-entry -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME="Stream7zModule" \
  -sALLOW_MEMORY_GROWTH=1 \
  -sEXPORTED_FUNCTIONS='["_stream7z_create","_stream7z_last_error","_stream7z_heap_size"]' \
  -sEXPORTED_RUNTIME_METHODS='["cwrap"]'
MAKE
pushd "$SRC/CPP/7zip/Bundles/Alone2" >/dev/null
emmake make -f makefile.gcc ST_MODE=1 PROG=stream7z.mjs -j"${JOBS:-2}"
popd >/dev/null
cp "$SRC/CPP/7zip/Bundles/Alone2/_o/stream7z.mjs" "$HERE/build/stream7z.mjs"
cp "$SRC/CPP/7zip/Bundles/Alone2/_o/stream7z.wasm" "$HERE/build/stream7z.wasm"
printf 'Built direct 7-Zip 26.03 API module\n'
