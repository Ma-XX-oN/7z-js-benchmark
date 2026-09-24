import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  generateIncompressibleCorpus,
  generateJsonlCorpus,
  generateModerateCorpus,
  hashTree
} from '../src/corpus.mjs';

test('JSONL corpus has exact size and independent golden hash', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), '7z-js-benchmark-'));
  const root = path.join(temp, 'jsonl');
  try {
    const info = generateJsonlCorpus(root, 4096);
    assert.equal(info.bytes, 4096);
    assert.equal(
      info.sha256,
      '690d45dc3d046a692a66aae24e951ba8e6a1f58a2627b80d499eebcbab9fb05d'
    );
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('moderate corpus has exact size and independent golden hash', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), '7z-js-benchmark-'));
  const root = path.join(temp, 'moderate');
  try {
    const info = generateModerateCorpus(root, 128 * 1024);
    assert.equal(info.bytes, 128 * 1024);
    assert.equal(
      info.sha256,
      'cee5bb16e298640abe2eef0f1472a26114abbdeacc551d0f50852ad214a4af4d'
    );
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

test('tree hashing changes when corpus bytes change', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), '7z-js-benchmark-'));
  const root = path.join(temp, 'tree');
  try {
    generateJsonlCorpus(root, 4096);
    const before = hashTree(root);
    fs.appendFileSync(path.join(root, 'conversation.jsonl'), 'x');
    assert.notEqual(hashTree(root), before);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
