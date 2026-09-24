import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  generateIncompressibleCorpus,
  generateJsonlCorpus,
  hashTree
} from '../src/corpus.mjs';

test('JSONL corpus generation is deterministic', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), '7z-js-benchmark-'));
  const first = path.join(temp, 'first');
  const second = path.join(temp, 'second');
  try {
    const firstInfo = generateJsonlCorpus(first, 128 * 1024);
    const secondInfo = generateJsonlCorpus(second, 128 * 1024);
    assert.equal(firstInfo.bytes, secondInfo.bytes);
    assert.equal(firstInfo.sha256, secondInfo.sha256);
    assert.equal(hashTree(first), hashTree(second));
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('incompressible corpus has exact size and independent golden hash', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), '7z-js-benchmark-'));
  const root = path.join(temp, 'incompressible');
  try {
    const info = generateIncompressibleCorpus(root, 4096);
    assert.equal(info.bytes, 4096);
    assert.equal(
      info.sha256,
      'fc8159115a01869c3798d540724ec45f2917904b65cbf08884f3544d55f5a704'
    );
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
