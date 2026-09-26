import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

test('published 26.03 browser payload matches its verified manifest', async () => {
  const manifest = JSON.parse(await readFile(path.join(root, 'dist/stream7z-26.03.json'), 'utf8'));
  assert.equal(manifest.schema, 1);
  assert.equal(manifest.version, '26.03');
  assert.equal(manifest.source_commit, '1c520932a8e71842f3a205d44e8d3de25a452ec9');
  for (const [name, expected] of Object.entries(manifest.files)) {
    const bytes = gunzipSync(await readFile(path.join(root, 'dist', expected.compressed)));
    assert.equal(bytes.length, expected.bytes, name);
    assert.equal(sha256(bytes), expected.sha256, name);
  }
});

test('fresh direct build reproduces the published browser payload byte for byte', async t => {
  const build = path.join(root, 'prototype/7zip-direct/build');
  try {
    await access(path.join(build, 'stream7z.mjs'));
    await access(path.join(build, 'stream7z.wasm'));
  } catch {
    t.skip('direct build output is not present in this test environment');
    return;
  }
  const manifest = JSON.parse(await readFile(path.join(root, 'dist/stream7z-26.03.json'), 'utf8'));
  for (const [name, expected] of Object.entries(manifest.files)) {
    const published = gunzipSync(await readFile(path.join(root, 'dist', expected.compressed)));
    const built = await readFile(path.join(build, name));
    assert.deepEqual(built, published, name);
  }
});
