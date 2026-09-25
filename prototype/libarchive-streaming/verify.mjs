import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const native7z = require('7zip-bin-full').path7z;
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');
const workRoot = path.join(repoRoot, '.streaming-work');
const resultRoot = path.join(repoRoot, 'benchmark-results');
const buildModule = path.join(here, 'build', 'stream7z.mjs');
const transferBytes = 256 * 1024;
const patternBytes = Number(process.env.STREAM7Z_PATTERN_BYTES || 1024 * 1024);
const archivedSegments = Number(process.env.STREAM7Z_SEGMENTS || 3);

assert(Number.isInteger(patternBytes) && patternBytes > 0);
assert(Number.isInteger(archivedSegments) && archivedSegments >= 2);
assert(fs.existsSync(native7z), `native 7z oracle missing: ${native7z}`);
assert(fs.existsSync(buildModule), `WASM module missing: ${buildModule}`);

fs.rmSync(workRoot, { recursive: true, force: true });
fs.mkdirSync(workRoot, { recursive: true });
fs.mkdirSync(resultRoot, { recursive: true });

const pattern = deterministicPattern(patternBytes);
const segmentArchives = [];
const sourceRawFiles = [];

for (let i = 0; i < archivedSegments; i += 1) {
  const rawPath = path.join(workRoot, `segment-${String(i + 1).padStart(6, '0')}.bin`);
  const archivePath = path.join(workRoot, `${String(i + 1).padStart(6, '0')}.7z`);
  fs.writeFileSync(rawPath, pattern);
  runNative([
    'a', '-t7z', '-mx=5', '-m0=lzma2', '-md=32m', '-ms=on', '-mmt=1',
    '-bd', '-bso0', '-bse0', '-bsp0', '-y', archivePath, rawPath
  ]);
  sourceRawFiles.push(rawPath);
  segmentArchives.push(archivePath);
}

const activePath = path.join(workRoot, 'active.jsonl');
fs.writeFileSync(activePath, pattern);
const expectedRawBytes = (archivedSegments + 1) * pattern.length;
const expectedHashBuilder = createHash('sha256');
for (let i = 0; i < archivedSegments + 1; i += 1) {
  expectedHashBuilder.update(pattern);
}
const expectedConcatenationHash = expectedHashBuilder.digest('hex');

let module;
let nextSourceId = 1;
let nextOutputId = 1;
const sources = new Map();
const outputs = new Map();

function registerSource(filePath) {
  const id = nextSourceId++;
  const fd = fs.openSync(filePath, 'r');
  sources.set(id, {
    fd,
    filePath,
    position: 0,
    size: fs.statSync(filePath).size
  });
  return id;
}

function closeSource(id) {
  const source = sources.get(id);
  if (!source) return;
  fs.closeSync(source.fd);
  sources.delete(id);
}

function registerOutput(filePath) {
  const id = nextOutputId++;
  const fd = fs.openSync(filePath, 'w');
  outputs.set(id, { fd, filePath, bytes: 0 });
  return id;
}

function closeOutput(id) {
  const output = outputs.get(id);
  if (!output) return;
  fs.closeSync(output.fd);
  outputs.delete(id);
}

const createStream7z = (await import(pathToFileURL(buildModule).href)).default;
module = await createStream7z({
  stream7zRead(sourceId, ptr, capacity) {
    const source = sources.get(sourceId);
    if (!source) return -1;
    const remaining = source.size - source.position;
    if (remaining <= 0) return 0;
    const length = Math.min(capacity, remaining);
    const view = module.HEAPU8.subarray(ptr, ptr + length);
    const count = fs.readSync(source.fd, view, 0, length, source.position);
    source.position += count;
    return count;
  },
  stream7zSeek(sourceId, offset, whence) {
    const source = sources.get(sourceId);
    if (!source || !Number.isSafeInteger(offset)) return -1;
    let next;
    if (whence === 0) next = offset;
    else if (whence === 1) next = source.position + offset;
    else if (whence === 2) next = source.size + offset;
    else return -1;
    if (!Number.isSafeInteger(next) || next < 0 || next > source.size) return -1;
    source.position = next;
    return next;
  },
  stream7zWrite(outputId, ptr, length) {
    const output = outputs.get(outputId);
    if (!output) return -1;
    const view = module.HEAPU8.subarray(ptr, ptr + length);
    const written = fs.writeSync(output.fd, view, 0, length, null);
    output.bytes += written;
    return written;
  }
});

const lastError = module.cwrap('stream7z_last_error', 'string', []);
const readerOpen = module.cwrap('stream7z_reader_open', 'number', ['number']);
const readerSize = module.cwrap('stream7z_reader_size', 'number', ['number']);
const readerRead = module.cwrap(
  'stream7z_reader_read', 'number', ['number', 'number', 'number']);
const readerClose = module.cwrap('stream7z_reader_close', 'number', ['number']);
const writerBegin = module.cwrap(
  'stream7z_writer_begin', 'number', ['number', 'string', 'number']);
const writerWrite = module.cwrap(
  'stream7z_writer_write', 'number', ['number', 'number', 'number']);
const writerBytes = module.cwrap(
  'stream7z_writer_bytes_written', 'number', ['number']);
const writerFinish = module.cwrap('stream7z_writer_finish', 'number', ['number']);

const outputArchive = path.join(workRoot, '(1).7z');
const outputId = registerOutput(outputArchive);
const outputMember = 'DownloadConversation_chat(1).jsonl';
const writer = writerBegin(outputId, outputMember, expectedRawBytes);
assert.notEqual(writer, 0, lastError());

const transferPtr = module._malloc(transferBytes);
assert.notEqual(transferPtr, 0);
let peakWasmHeapBytes = module.HEAPU8.buffer.byteLength;
let decompressedRawBytes = 0;

try {
  for (const archivePath of segmentArchives) {
    const sourceId = registerSource(archivePath);
    try {
      const reader = readerOpen(sourceId);
      assert.notEqual(reader, 0, lastError());
      assert.equal(readerSize(reader), pattern.length);
      try {
        for (;;) {
          const count = readerRead(reader, transferPtr, transferBytes);
          assert(count >= 0, lastError());
          if (count === 0) break;
          const written = writerWrite(writer, transferPtr, count);
          assert.equal(written, count, lastError());
          decompressedRawBytes += count;
          peakWasmHeapBytes = Math.max(
            peakWasmHeapBytes,
            module.HEAPU8.buffer.byteLength);
        }
      } finally {
        assert.equal(readerClose(reader), 0, lastError());
      }
    } finally {
      closeSource(sourceId);
    }
  }

  const activeFd = fs.openSync(activePath, 'r');
  try {
    let activePosition = 0;
    while (activePosition < pattern.length) {
      const length = Math.min(transferBytes, pattern.length - activePosition);
      const view = module.HEAPU8.subarray(transferPtr, transferPtr + length);
      const count = fs.readSync(activeFd, view, 0, length, activePosition);
      assert(count > 0);
      const written = writerWrite(writer, transferPtr, count);
      assert.equal(written, count, lastError());
      activePosition += count;
      peakWasmHeapBytes = Math.max(
        peakWasmHeapBytes,
        module.HEAPU8.buffer.byteLength);
    }
  } finally {
    fs.closeSync(activeFd);
  }

  assert.equal(decompressedRawBytes, archivedSegments * pattern.length);
  assert.equal(writerBytes(writer), expectedRawBytes);
  assert.equal(writerFinish(writer), 0, lastError());
} finally {
  module._free(transferPtr);
  closeOutput(outputId);
  for (const id of [...sources.keys()]) closeSource(id);
}

assert(fs.statSync(outputArchive).size > 0);
runNative(['t', '-bd', '-bso0', '-bse0', outputArchive]);

const extractRoot = path.join(workRoot, 'extract');
fs.mkdirSync(extractRoot, { recursive: true });
runNative(['x', '-bd', '-bso0', '-bse0', '-y', `-o${extractRoot}`, outputArchive]);
const extractedPath = path.join(extractRoot, outputMember);
assert.equal(fs.statSync(extractedPath).size, expectedRawBytes);
assert.equal(hashFile(extractedPath), expectedConcatenationHash);

const baselineRaw = path.join(workRoot, 'expected-concatenation.jsonl');
const baselineFd = fs.openSync(baselineRaw, 'w');
try {
  for (let i = 0; i < archivedSegments + 1; i += 1) {
    fs.writeSync(baselineFd, pattern);
  }
} finally {
  fs.closeSync(baselineFd);
}
assert.equal(hashFile(baselineRaw), expectedConcatenationHash);

const baselineArchive = path.join(workRoot, 'native-single-input.7z');
runNative([
  'a', '-t7z', '-mx=5', '-m0=lzma2', '-md=32m', '-ms=on', '-mmt=1',
  '-bd', '-bso0', '-bse0', '-bsp0', '-y', baselineArchive, baselineRaw
]);
runNative(['t', '-bd', '-bso0', '-bse0', baselineArchive]);

const streamedArchiveBytes = fs.statSync(outputArchive).size;
const nativeBaselineBytes = fs.statSync(baselineArchive).size;
const streamedRatio = streamedArchiveBytes / expectedRawBytes;

// The corpus repeats an incompressible-looking block across segment boundaries.
// A reset compressor would have to encode that block repeatedly. A continuous
// LZMA2 history should encode it once and match later copies from dictionary.
assert(
  streamedRatio < 0.45,
  `streamed ratio ${streamedRatio.toFixed(3)} suggests history was reset`);
assert(
  streamedArchiveBytes <= nativeBaselineBytes * 1.20 + 64 * 1024,
  `streamed archive ${streamedArchiveBytes} unexpectedly exceeds native ` +
    `single-input baseline ${nativeBaselineBytes}`);

const result = {
  timestamp: new Date().toISOString(),
  gitSha: process.env.GITHUB_SHA || null,
  libraryApi: 'libarchive direct C API compiled to WASM',
  compression: '7z / LZMA2 / level 5',
  archivedSegments,
  activeRawFiles: 1,
  sourceBytesPerSegment: pattern.length,
  expectedRawBytes,
  expectedConcatenationSha256: expectedConcatenationHash,
  extractedSha256: hashFile(extractedPath),
  streamedArchiveBytes,
  nativeSingleInputArchiveBytes: nativeBaselineBytes,
  streamedToRawRatio: streamedRatio,
  streamedToNativeSizeRatio: streamedArchiveBytes / nativeBaselineBytes,
  transferBufferBytes: transferBytes,
  peakWasmHeapBytes,
  rawIntermediateCreatedByStreamingPath: false,
  note: 'libarchive 7z writer internally stages compressed bytes before final archive output'
};
fs.writeFileSync(
  path.join(resultRoot, 'streaming-wasm-results.json'),
  `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));

function deterministicPattern(size) {
  const output = Buffer.allocUnsafe(size);
  let offset = 0;
  let counter = 0;
  while (offset < size) {
    const digest = createHash('sha256')
      .update(`7z-streaming-cross-boundary-${counter}`)
      .digest();
    const length = Math.min(digest.length, size - offset);
    digest.copy(output, offset, 0, length);
    offset += length;
    counter += 1;
  }
  return output;
}

function hashFile(filePath) {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function runNative(args) {
  const result = childProcess.spawnSync(native7z, args, {
    cwd: workRoot,
    encoding: 'utf8',
    timeout: 5 * 60 * 1000,
    maxBuffer: 4 * 1024 * 1024
  });
  assert.equal(
    result.status,
    0,
    `native 7z failed: ${args.join(' ')}\n${result.stderr}\n${result.stdout}`);
}
