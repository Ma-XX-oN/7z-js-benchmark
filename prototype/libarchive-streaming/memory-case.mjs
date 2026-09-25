import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [workRoot, inputRel, archiveRel, memberName] = process.argv.slice(2);
assert(path.isAbsolute(workRoot));
assert(inputRel && archiveRel && memberName);

const here = path.dirname(fileURLToPath(import.meta.url));
const buildModule = path.join(here, 'build', 'stream7z.mjs');
const inputPath = path.join(workRoot, inputRel);
const archivePath = path.join(workRoot, archiveRel);
const inputBytes = fs.statSync(inputPath).size;
const createStream7z = (await import(pathToFileURL(buildModule).href)).default;

let module;
let sourceFd = -1;
let sourcePosition = 0;
let outputFd = -1;
const baselineProcess = process.memoryUsage();
const peakProcess = { ...baselineProcess };

function sampleProcessMemory() {
  const usage = process.memoryUsage();
  for (const key of ['rss', 'heapTotal', 'heapUsed', 'external', 'arrayBuffers']) {
    peakProcess[key] = Math.max(peakProcess[key] || 0, usage[key] || 0);
  }
}

const initStart = performance.now();
module = await createStream7z({
  stream7zRead(sourceId, view) {
    sampleProcessMemory();
    if (sourceId !== 1 || sourceFd < 0 || !(view instanceof Uint8Array)) return -1;
    const remaining = inputBytes - sourcePosition;
    if (remaining <= 0) return 0;
    const length = Math.min(view.byteLength, remaining);
    const count = fs.readSync(sourceFd, view, 0, length, sourcePosition);
    sourcePosition += count;
    sampleProcessMemory();
    return count;
  },
  stream7zSeek(sourceId, offset, whence) {
    if (sourceId !== 1 || sourceFd < 0 || !Number.isSafeInteger(offset)) return -1;
    let next;
    if (whence === 0) next = offset;
    else if (whence === 1) next = sourcePosition + offset;
    else if (whence === 2) next = inputBytes + offset;
    else return -1;
    if (!Number.isSafeInteger(next) || next < 0 || next > inputBytes) return -1;
    sourcePosition = next;
    return next;
  },
  stream7zWrite(outputId, view) {
    sampleProcessMemory();
    if (outputId !== 1 || outputFd < 0 || !(view instanceof Uint8Array)) return -1;
    const count = fs.writeSync(outputFd, view, 0, view.byteLength, null);
    sampleProcessMemory();
    return count;
  },
});
const initMs = performance.now() - initStart;
sampleProcessMemory();

const lastError = module.cwrap('stream7z_last_error', 'string', []);
const heapSize = module.cwrap('stream7z_heap_size', 'number', []);
const writerBegin = module.cwrap(
  'stream7z_writer_begin', 'number', ['number', 'string', 'number']);
const writerAppendSource = module.cwrap(
  'stream7z_writer_append_source', 'number', ['number', 'number', 'number']);
const writerFinish = module.cwrap('stream7z_writer_finish', 'number', ['number']);

const initialWasmHeapBytes = heapSize();
let peakWasmHeapBytes = initialWasmHeapBytes;
fs.rmSync(archivePath, { force: true });
sourceFd = fs.openSync(inputPath, 'r');
outputFd = fs.openSync(archivePath, 'w');
const start = performance.now();
try {
  const writer = writerBegin(1, memberName, inputBytes);
  assert.notEqual(writer, 0, lastError());
  peakWasmHeapBytes = Math.max(peakWasmHeapBytes, heapSize());
  sampleProcessMemory();
  assert.equal(writerAppendSource(writer, 1, inputBytes), 0, lastError());
  peakWasmHeapBytes = Math.max(peakWasmHeapBytes, heapSize());
  sampleProcessMemory();
  assert.equal(writerFinish(writer), 0, lastError());
  peakWasmHeapBytes = Math.max(peakWasmHeapBytes, heapSize());
  sampleProcessMemory();
} finally {
  fs.closeSync(sourceFd);
  fs.closeSync(outputFd);
}
const compressionMs = performance.now() - start;

const output = {
  initMs,
  compressionMs,
  archiveBytes: fs.statSync(archivePath).size,
  initialWasmHeapBytes,
  peakWasmHeapBytes,
  baselineProcessRssBytes: baselineProcess.rss,
  baselineProcessHeapUsedBytes: baselineProcess.heapUsed,
  baselineProcessExternalBytes: baselineProcess.external,
  baselineProcessArrayBuffersBytes: baselineProcess.arrayBuffers,
  peakProcessRssBytes: peakProcess.rss,
  peakProcessHeapUsedBytes: peakProcess.heapUsed,
  peakProcessExternalBytes: peakProcess.external,
  peakProcessArrayBuffersBytes: peakProcess.arrayBuffers,
};
process.stdout.write(`${JSON.stringify(output)}\n`);
