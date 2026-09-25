import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const prototypeRoot = new URL('../prototype/libarchive-streaming/', import.meta.url);

async function readPrototypeFile(name) {
  return readFile(new URL(name, prototypeRoot), 'utf8');
}

test('streaming 7z prototype is a library API, not a CLI wrapper', async () => {
  const source = await readPrototypeFile('stream7z.c');

  assert.match(source, /archive_read_data\s*\(/);
  assert.match(source, /archive_write_data\s*\(/);
  assert.match(source, /stream7z_writer_begin\s*\(/);
  assert.match(source, /stream7z_writer_write\s*\(/);
  assert.match(source, /stream7z_reader_read\s*\(/);
  assert.match(source, /stream7z_pipe_reader_to_writer\s*\(/);
  assert.match(source, /stream7z_writer_append_source\s*\(/);
  assert.doesNotMatch(source, /callMain\s*\(/);
  assert.doesNotMatch(source, /\bsystem\s*\(/);
  assert.doesNotMatch(source, /\bexec[lvpe]*\s*\(/);
});

test('streaming build pins secure upstream versions and cross-compiles dependencies', async () => {
  const build = await readPrototypeFile('build.sh');

  assert.match(build, /LIBARCHIVE_VERSION=3\.8\.9/);
  assert.match(build, /XZ_VERSION=5\.8\.4/);
  assert.match(build, /EMSCRIPTEN_HOST=wasm32-unknown-emscripten/);
  assert.equal(
    (build.match(/--host="\$EMSCRIPTEN_HOST"/g) ?? []).length,
    2,
    'both xz and libarchive configure invocations must be marked as cross-compiles',
  );
});

test('verification does not depend on an unexported Emscripten heap view', async () => {
  const harness = await readPrototypeFile('verify.mjs');
  const source = await readPrototypeFile('stream7z.c');

  assert.doesNotMatch(harness, /module\.HEAPU8/);
  assert.match(source, /HEAPU8\.subarray\s*\(/);
  assert.match(source, /stream7z_heap_size\s*\(/);
  assert.match(source, /stream7z_js_heap_size\s*\(/);
});

test('verification compares streamed output with stock 7z and an independent byte oracle', async () => {
  const harness = await readPrototypeFile('verify.mjs');

  assert.match(harness, /createHash\(['"]sha256['"]\)/);
  assert.match(harness, /native.*7z|7z.*native/i);
  assert.match(harness, /runNative\(\['t'/);
  assert.match(harness, /runNative\(\['l'/);
  assert.match(harness, /runNative\(\['x'/);
  assert.match(harness, /expected.*concaten/i);
  assert.match(harness, /orderedChunk/);
});

test('stock 7z interoperability gate also validates a JS7z reference archive', async () => {
  const harness = await readPrototypeFile('verify.mjs');
  const js7zReference = await readPrototypeFile('js7z-reference.cjs');

  assert.match(harness, /js7z-reference\.cjs/);
  assert.match(harness, /js7zReferenceArchive/);
  assert.match(harness, /js7zStock7zTestPassed/);
  assert.match(harness, /js7zStock7zListPassed/);
  assert.match(harness, /js7zStock7zExtractPassed/);
  assert.match(js7zReference, /require\(['"]js7z-tools['"]\)/);
  assert.match(js7zReference, /callMain\s*\(/);
});

test('performance benchmark covers direct WASM, JS7z threading, native 7z, and memory scaling', async () => {
  const benchmark = await readPrototypeFile('benchmark.mjs');

  assert.match(benchmark, /performance\.now\s*\(/);
  assert.match(benchmark, /warmup/i);
  assert.match(benchmark, /repetitions/i);
  assert.match(benchmark, /js7z-tools/);
  assert.match(benchmark, /single/);
  assert.match(benchmark, /auto/);
  assert.match(benchmark, /native7z/);
  assert.match(benchmark, /peakWasmHeapBytes/);
  assert.match(benchmark, /memoryScaling/);
  assert.match(benchmark, /validateStock7zArchive/);
});
