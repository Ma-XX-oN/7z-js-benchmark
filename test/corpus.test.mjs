import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { generateJsonlCorpus, hashTree } from '../src/corpus.mjs';

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
