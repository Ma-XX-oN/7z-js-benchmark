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
  assert.doesNotMatch(source, /callMain\s*\(/);
  assert.doesNotMatch(source, /\bsystem\s*\(/);
  assert.doesNotMatch(source, /\bexec[lvpe]*\s*\(/);
});

test('streaming build pins the investigated secure upstream versions', async () => {
  const build = await readPrototypeFile('build.sh');

  assert.match(build, /LIBARCHIVE_VERSION=3\.8\.9/);
  assert.match(build, /XZ_VERSION=5\.8\.4/);
});

test('verification compares streamed output with an independent byte oracle', async () => {
  const harness = await readPrototypeFile('verify.mjs');

  assert.match(harness, /createHash\(['"]sha256['"]\)/);
  assert.match(harness, /native.*7z|7z.*native/i);
  assert.match(harness, /expected.*concaten/i);
});
