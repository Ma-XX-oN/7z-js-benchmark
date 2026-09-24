import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const JSONL_RECORD_BYTES = 1024;
const MIXED_BLOCK_BYTES = 64 * 1024;
const MIXED_PATTERN = Buffer.from(
  '7z-js-benchmark moderate compressible block; ' +
  'conversation JSONL source code logs WebAssembly LZMA2. '
);

export function generateJsonlCorpus(root, targetBytes = 32 * 1024 * 1024) {
  assert(Number.isInteger(targetBytes) && targetBytes > 0);
  assert.equal(targetBytes % JSONL_RECORD_BYTES, 0);
  resetRoot(root);

  const file = path.join(root, 'conversation.jsonl');
  const fd = fs.openSync(file, 'w');

  try {
    const records = targetBytes / JSONL_RECORD_BYTES;
    for (let id = 0; id < records; id += 1) {
      const role = id % 3 === 0 ? 'user' : 'assistant';
      const prefix =
        `{"id":${id},"role":"${role}","sequence":${id % 997},"content":"`;
      const suffix = '"}\n';
      const fillBytes =
        JSONL_RECORD_BYTES - Buffer.byteLength(prefix) - Buffer.byteLength(suffix);
      assert(fillBytes > 0);
      const repeated = (
        'Conversation benchmark JSONL record. Typed arrays WebAssembly ' +
        'compression source code logs. '
      ).repeat(Math.ceil(fillBytes / 91));
      const line = Buffer.from(prefix + repeated.slice(0, fillBytes) + suffix);
      assert.equal(line.length, JSONL_RECORD_BYTES);
      fs.writeSync(fd, line);
    }
  } finally {
    fs.closeSync(fd);
  }

  return corpusInfo(file, targetBytes);
}

export function generateModerateCorpus(root, targetBytes = 32 * 1024 * 1024) {
  assert(Number.isInteger(targetBytes) && targetBytes > 0);
  resetRoot(root);

  const file = path.join(root, 'mixed-50pct.bin');
  const cipher = createCtrCipher('7z-js-benchmark-moderate-v1');
  const fd = fs.openSync(file, 'w');
  let written = 0;
  let blockIndex = 0;

  try {
    while (written < targetBytes) {
      const count = Math.min(MIXED_BLOCK_BYTES, targetBytes - written);
      if (blockIndex % 2 === 0) {
        const repeats = Math.ceil(count / MIXED_PATTERN.length);
        const block = Buffer.allocUnsafe(count);
        Buffer.from(MIXED_PATTERN.toString().repeat(repeats))
          .copy(block, 0, 0, count);
        fs.writeSync(fd, block);
      } else {
        const block = cipher.update(Buffer.alloc(count));
        assert.equal(block.length, count);
        fs.writeSync(fd, block);
      }
      written += count;
      blockIndex += 1;
    }
    assert.equal(cipher.final().length, 0);
  } finally {
    fs.closeSync(fd);
  }

  return corpusInfo(file, targetBytes);
}

export function generateIncompressibleCorpus(
  root,
  targetBytes = 32 * 1024 * 1024
) {
  assert(Number.isInteger(targetBytes) && targetBytes > 0);
  resetRoot(root);

  const file = path.join(root, 'high-entropy.bin');
  const cipher = createCtrCipher('7z-js-benchmark-incompressible-v1');
  const fd = fs.openSync(file, 'w');
  const zeroChunk = Buffer.alloc(1024 * 1024);
  let written = 0;

  try {
    while (written < targetBytes) {
      const count = Math.min(zeroChunk.length, targetBytes - written);
      const encrypted = cipher.update(zeroChunk.subarray(0, count));
      assert.equal(encrypted.length, count);
      fs.writeSync(fd, encrypted);
      written += encrypted.length;
    }
    assert.equal(cipher.final().length, 0);
  } finally {
    fs.closeSync(fd);
  }

  return corpusInfo(file, targetBytes);
}

export function hashFile(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

export function hashTree(root) {
  assert(fs.statSync(root).isDirectory());
  const hash = crypto.createHash('sha256');
  const files = [];

  walk(root, root, files);
  files.sort((a, b) => a.localeCompare(b));

  for (const relative of files) {
    hash.update(relative.replaceAll(path.sep, '/'));
    hash.update('\0');
    hash.update(hashFile(path.join(root, relative)));
    hash.update('\n');
  }

  return hash.digest('hex');
}

function createCtrCipher(label) {
  const key = crypto.createHash('sha256').update(`${label}:key`).digest();
  const iv = crypto.createHash('sha256')
    .update(`${label}:iv`)
    .digest()
    .subarray(0, 16);
  return crypto.createCipheriv('aes-256-ctr', key, iv);
}

function corpusInfo(file, expectedBytes) {
  assert.equal(fs.statSync(file).size, expectedBytes);
  return {
    bytes: expectedBytes,
    files: 1,
    sha256: hashFile(file)
  };
}

function resetRoot(root) {
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
}

function walk(root, current, output) {
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) {
      walk(root, absolute, output);
    } else {
      assert(entry.isFile());
      output.push(path.relative(root, absolute));
    }
  }
}
