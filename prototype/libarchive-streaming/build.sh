#!/usr/bin/env bash
set -euo pipefail

LIBARCHIVE_VERSION=3.8.9
XZ_VERSION=5.8.4
EMSDK_IMAGE_DIGEST=d0be652409a4d3362b8a36c3279dd1123ff1c9327e603d86d9361aa84f1d2e4c
EMSCRIPTEN_HOST=wasm32-unknown-emscripten

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK="$HERE/.build"
PREFIX="$WORK/prefix"
DEPS="$WORK/deps"
OUT="$HERE/build"
JOBS="${JOBS:-2}"

mkdir -p "$DEPS" "$PREFIX" "$OUT"

fetch_extract() {
  local url="$1"
  local archive="$2"
  local directory="$3"
  if [[ -d "$directory" ]]; then
    return
  fi
  echo "Downloading $url"
  curl --fail --location --retry 3 --output "$archive" "$url"
  mkdir -p "$directory"
  tar -xf "$archive" --strip-components=1 -C "$directory"
}

XZ_ARCHIVE="$DEPS/xz-$XZ_VERSION.tar.xz"
XZ_SOURCE="$DEPS/xz-$XZ_VERSION"
fetch_extract \
  "https://github.com/tukaani-project/xz/releases/download/v$XZ_VERSION/xz-$XZ_VERSION.tar.xz" \
  "$XZ_ARCHIVE" \
  "$XZ_SOURCE"

if [[ ! -f "$PREFIX/lib/liblzma.a" ]]; then
  pushd "$XZ_SOURCE" >/dev/null
  emconfigure ./configure \
    --host="$EMSCRIPTEN_HOST" \
    --prefix="$PREFIX" \
    --disable-shared \
    --enable-static \
    --disable-doc \
    --disable-scripts \
    --disable-nls \
    --disable-assembler \
    --enable-threads=no
  emmake make -j"$JOBS"
  emmake make install
  popd >/dev/null
fi

LIBARCHIVE_ARCHIVE="$DEPS/libarchive-$LIBARCHIVE_VERSION.tar.xz"
LIBARCHIVE_SOURCE="$DEPS/libarchive-$LIBARCHIVE_VERSION"
fetch_extract \
  "https://github.com/libarchive/libarchive/releases/download/v$LIBARCHIVE_VERSION/libarchive-$LIBARCHIVE_VERSION.tar.xz" \
  "$LIBARCHIVE_ARCHIVE" \
  "$LIBARCHIVE_SOURCE"

if [[ ! -f "$PREFIX/lib/libarchive.a" ]]; then
  pushd "$LIBARCHIVE_SOURCE" >/dev/null
  export CPPFLAGS="-I$PREFIX/include"
  export LDFLAGS="-L$PREFIX/lib"
  export PKG_CONFIG_PATH="$PREFIX/lib/pkgconfig"
  export PKG_CONFIG_LIBDIR="$PREFIX/lib/pkgconfig"
  emconfigure ./configure \
    --host="$EMSCRIPTEN_HOST" \
    --prefix="$PREFIX" \
    --disable-shared \
    --enable-static \
    --disable-bsdtar \
    --disable-bsdcpio \
    --disable-bsdcat \
    --disable-bsdunzip \
    --disable-xattr \
    --disable-acl \
    --enable-posix-regex-lib=libc \
    --without-zlib \
    --without-bz2lib \
    --without-lz4 \
    --without-zstd \
    --without-lzo2 \
    --without-nettle \
    --without-openssl \
    --without-mbedtls \
    --without-xml2 \
    --without-expat
  emmake make -j"$JOBS"
  emmake make install
  popd >/dev/null
fi

emcc "$HERE/stream7z.c" \
  "$PREFIX/lib/libarchive.a" \
  "$PREFIX/lib/liblzma.a" \
  -I"$PREFIX/include" \
  -O3 \
  -o "$OUT/stream7z.mjs" \
  -sMODULARIZE=1 \
  -sEXPORT_ES6=1 \
  -sEXPORT_NAME=createStream7z \
  -sALLOW_MEMORY_GROWTH=1 \
  -sFORCE_FILESYSTEM=1 \
  -sENVIRONMENT=node,web,worker \
  -sEXPORTED_RUNTIME_METHODS='["cwrap"]' \
  -sEXPORTED_FUNCTIONS='["_malloc","_free"]' \
  -sERROR_ON_UNDEFINED_SYMBOLS=1

printf 'Built %s and %s\n' "$OUT/stream7z.mjs" "$OUT/stream7z.wasm"
