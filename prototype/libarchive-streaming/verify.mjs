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
const js7zReferenceRunner = path.join(here, 'js7z-reference.cjs');
const patternBytes = Number(process.env.STREAM7Z_PATTERN_BYTES || 1024 * 1024);
const archivedSegments = Number(process.env.STREAM7Z_SEGMENTS || 3);

assert(Number.isInteger(patternBytes) && patternBytes > 0);
assert(Number.isInteger(archivedSegments) && archivedSegments >= 2);
assert(fs.existsSync(native7z), `native 7z oracle missing: ${native7z}`);
assert(fs.existsSync(buildModule), `WASM module missing: ${buildModule}`);
assert(fs.existsSync(js7zReferenceRunner), `JS7z reference runner missing: ${js7zReferenceRunner}`);

fs.rmSync(workRoot, { recursive: true, force: true });
fs.mkdirSync(workRoot, { recursive: true });
fs.mkdirSync(resultRoot, { recursive: true });

const commonPattern = deterministicPattern(patternBytes);
const orderedChunks = Array.from(
  { length: archivedSegments + 1 },
  (_, index) => orderedChunk(commonPattern, index + 1),
);
const segmentArchives = [];

for (let i = 0; i < archivedSegments; i += 1) {
  const rawPath = path.join(workRoot, `segment-${String(i + 1).padStart(6, '0')}.bin`);
  const archivePath = path.join(workRoot, `${String(i + 1).padStart(6, '0')}.7z`);
  fs.writeFileSync(rawPath, orderedChunks[i]);
  runNative([
    'a', '-t7z', '-mx=5', '-m0=lzma2', '-md=32m', '-ms=on', '-mmt=1',
    '-bd', '-bso0', '-bse0', '-bsp0', '-y', archivePath, rawPath,
  ]);
  segmentArchives.push(archivePath);
}

const activePath = path.join(workRoot, 'active.jsonl');
fs.writeFileSync(activePath, orderedChunks.at(-1));
const expectedRawBytes = orderedChunks.reduce((sum, chunk) => sum + chunk.length, 0);
const expectedHashBuilder = createHash('sha256');
for (const chunk of orderedChunks) expectedHashBuilder.update(chunk);
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
    size: fs.statSync(filePath).size,
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
  stream7zRead(sourceId, view) {
    const source = sources.get(sourceId);
    if (!source || !(view instanceof Uint8Array)) return -1;
    const remaining = source.size - source.position;
    if (remaining <= 0) return 0;
    const length = Math.min(view.byteLength, remaining);
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
  stream7zWrite(outputId, view) {
    const output = outputs.get(outputId);
    if (!output || !(view instanceof Uint8Array)) return -1;
    const written = fs.writeSync(output.fd, view, 0, view.byteLength, null);
    output.bytes += written;
    return written;
  },
});

const lastError = module.cwrap('stream7z_last_error', 'string', []);
const heapSize = module.cwrap('stream7z_heap_size', 'number', []);
const readerOpen = module.cwrap('stream7z_reader_open', 'number', ['number']);
const readerSize = module.cwrap('stream7z_reader_size', 'number', ['number']);
const readerBytes = module.cwrap('stream7z_reader_bytes_read', 'number', ['number']);
const readerClose = module.cwrap('stream7z_reader_close', 'number', ['number']);
const writerBegin = module.cwrap(
  'stream7z_writer_begin', 'number', ['number', 'string', 'number']);
const pipeReaderToWriter = module.cwrap(
  'stream7z_pipe_reader_to_writer', 'number', ['number', 'number']);
const writerAppendSource = module.cwrap(
  'stream7z_writer_append_source', 'number', ['number', 'number', 'number']);
const writerBytes = module.cwrap(
  'stream7z_writer_bytes_written', 'number', ['number']);
const writerFinish = module.cwrap('stream7z_writer_finish', 'number', ['number']);

const outputArchive = path.join(workRoot, '(1).7z');
const outputId = registerOutput(outputArchive);
const outputMember = 'DownloadConversation_chat(1).jsonl';
const writer = writerBegin(outputId, outputMember, expectedRawBytes);
assert.notEqual(writer, 0, lastError());

let peakWasmHeapBytes = heapSize();
let decompressedRawBytes = 0;

try {
  for (let index = 0; index < segmentArchives.length; index += 1) {
    const sourceId = registerSource(segmentArchives[index]);
    try {
      const reader = readerOpen(sourceId);
      assert.notEqual(reader, 0, lastError());
      assert.equal(readerSize(reader), orderedChunks[index].length);
      try {
        assert.equal(pipeReaderToWriter(reader, writer), 0, lastError());
        assert.equal(readerBytes(reader), orderedChunks[index].length);
        decompressedRawBytes += readerBytes(reader);
        peakWasmHeapBytes = Math.max(peakWasmHeapBytes, heapSize());
      } finally {
        assert.equal(readerClose(reader), 0, lastError());
      }
    } finally {
      closeSource(sourceId);
    }
  }

  const activeSourceId = registerSource(activePath);
  try {
    const activeSnapshotBytes = orderedChunks.at(-1).length;
    assert.equal(
      writerAppendSource(writer, activeSourceId, activeSnapshotBytes),
      0,
      lastError(),
    );
    peakWasmHeapBytes = Math.max(peakWasmHeapBytes, heapSize());
  } finally {
    closeSource(activeSourceId);
  }

  assert.equal(
    decompressedRawBytes,
    orderedChunks.slice(0, archivedSegments).reduce((sum, chunk) => sum + chunk.length, 0),
  );
  assert.equal(writerBytes(writer), expectedRawBytes);
  assert.equal(writerFinish(writer), 0, lastError());
} finally {
  closeOutput(outputId);
  for (const id of [...sources.keys()]) closeSource(id);
}

assert(fs.statSync(outputArchive).size > 0);
const streamedCompatibility = validateStock7zArchive({
  archivePath: outputArchive,
  memberName: outputMember,
  expectedBytes: expectedRawBytes,
  expectedHash: expectedConcatenationHash,
  extractRoot: path.join(workRoot, 'extract-streamed'),
});

// This raw file exists only as an independent native/JS7z oracle after the
// streaming path has already completed. The streaming path itself never makes
// a reconstructed raw intermediate.
const baselineRaw = path.join(workRoot, 'expected-concatenation.jsonl');
const baselineFd = fs.openSync(baselineRaw, 'w');
try {
  for (const chunk of orderedChunks) fs.writeSync(baselineFd, chunk);
} finally {
  fs.closeSync(baselineFd);
}
assert.equal(hashFile(baselineRaw), expectedConcatenationHash);

const baselineArchive = path.join(workRoot, 'native-single-input.7z');
runNative([
  'a', '-t7z', '-mx=5', '-m0=lzma2', '-md=32m', '-ms=on', '-mmt=1',
  '-bd', '-bso0', '-bse0', '-bsp0', '-y', baselineArchive, baselineRaw,
]);
runNative(['t', '-bd', '-bso0', '-bse0', baselineArchive]);

const js7zReferenceArchive = path.join(workRoot, 'js7z-reference.7z');
runNode([
  js7zReferenceRunner,
  workRoot,
  path.basename(baselineRaw),
  path.basename(js7zReferenceArchive),
]);
const js7zCompatibility = validateStock7zArchive({
  archivePath: js7zReferenceArchive,
  memberName: path.basename(baselineRaw),
  expectedBytes: expectedRawBytes,
  expectedHash: expectedConcatenationHash,
  extractRoot: path.join(workRoot, 'extract-js7z'),
});

const streamedArchiveBytes = fs.statSync(outputArchive).size;
const nativeBaselineBytes = fs.statSync(baselineArchive).size;
const js7zReferenceBytes = fs.statSync(js7zReferenceArchive).size;
const streamedRatio = streamedArchiveBytes / expectedRawBytes;

// Every chunk is mostly the same incompressible-looking block but begins with
// a unique order marker. A reset compressor would have to encode the shared
// block repeatedly; a continuous LZMA2 history can match later copies while
// the SHA-256 oracle independently detects loss, duplication, or reordering.
assert(
  streamedRatio < 0.45,
  `streamed ratio ${streamedRatio.toFixed(3)} suggests history was reset`,
);
assert(
  streamedArchiveBytes <= nativeBaselineBytes * 1.20 + 64 * 1024,
  `streamed archive ${streamedArchiveBytes} unexpectedly exceeds native ` +
    `single-input baseline ${nativeBaselineBytes}`,
);

const result = {
  timestamp: new Date().toISOString(),
  gitSha: process.env.GITHUB_SHA || null,
  libraryApi: 'libarchive direct C API compiled to WASM',
  compression: '7z / LZMA2 / level 5',
  archivedSegments,
  activeRawFiles: 1,
  sourceBytesPerSegment: commonPattern.length,
  expectedRawBytes,
  expectedConcatenationSha256: expectedConcatenationHash,
  extractedSha256: streamedCompatibility.extractedSha256,
  streamedArchiveBytes,
  nativeSingleInputArchiveBytes: nativeBaselineBytes,
  js7zReferenceArchiveBytes: js7zReferenceBytes,
  streamedToRawRatio: streamedRatio,
  streamedToNativeSizeRatio: streamedArchiveBytes / nativeBaselineBytes,
  streamedToJs7zSizeRatio: streamedArchiveBytes / js7zReferenceBytes,
  peakWasmHeapBytes,
  stock7zTestPassed: streamedCompatibility.testPassed,
  stock7zListPassed: streamedCompatibility.listPassed,
  stock7zExtractPassed: streamedCompatibility.extractPassed,
  js7zStock7zTestPassed: js7zCompatibility.testPassed,
  js7zStock7zListPassed: js7zCompatibility.listPassed,
  js7zStock7zExtractPassed: js7zCompatibility.extractPassed,
  js7zExtractedSha256: js7zCompatibility.extractedSha256,
  orderSensitiveFixture: true,
  rawIntermediateCreatedByStreamingPath: false,
  note: 'libarchive 7z writer internally stages compressed bytes before final archive output',
};
fs.writeFileSync(
  path.join(resultRoot, 'streaming-wasm-results.json'),
  `${JSON.stringify(result, null, 2)}\n`,
);
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

function orderedChunk(common, ordinal) {
  const output = Buffer.from(common);
  const marker = Buffer.from(
    `STREAM7Z-ORDER-${String(ordinal).padStart(8, '0')}\n`,
    'utf8',
  );
  marker.copy(output, 0, 0, Math.min(marker.length, output.length));
  return output;
}

function hashFile(filePath) {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function validateStock7zArchive({
  archivePath,
  memberName,
  expectedBytes,
  expectedHash,
  extractRoot,
}) {
  runNative(['t', '-bd', '-bso0', '-bse0', archivePath]);
  const listing = runNative(['l', '-slt', '-bd', archivePath]);
  assert(
    listing.stdout.includes(`Path = ${memberName}`),
    `stock 7z listing did not contain expected member ${memberName}`,
  );
  assert(
    listing.stdout.includes(`Size = ${expectedBytes}`),
    `stock 7z listing did not contain expected size ${expectedBytes}`,
  );
  assert.match(listing.stdout, /Method = LZMA2/);

  fs.rmSync(extractRoot, { recursive: true, force: true });
  fs.mkdirSync(extractRoot, { recursive: true });
  runNative(['x', '-bd', '-bso0', '-bse0', '-y', `-o${extractRoot}`, archivePath]);
  const extractedPath = path.join(extractRoot, memberName);
  assert.equal(fs.statSync(extractedPath).size, expectedBytes);
  const extractedSha256 = hashFile(extractedPath);
  assert.equal(extractedSha256, expectedHash);
  return {
    testPassed: true,
    listPassed: true,
    extractPassed: true,
    extractedSha256,
  };
}

function runNative(args) {
  const result = childProcess.spawnSync(native7z, args, {
    cwd: workRoot,
    encoding: 'utf8',
    timeout: 5 * 60 * 1000,
    maxBuffer: 4 * 1024 * 1024,
  });
  assert.equal(
    result.status,
    0,
    `native 7z failed: ${args.join(' ')}\n${result.stderr}\n${result.stdout}`,
  );
  return result;
}

function runNode(args) {
  const result = childProcess.spawnSync(process.execPath, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 5 * 60 * 1000,
    maxBuffer: 4 * 1024 * 1024,
  });
  assert.equal(
    result.status,
    0,
    `Node child failed: ${args.join(' ')}\n${result.stderr}\n${result.stdout}`,
  );
  return result;
}
