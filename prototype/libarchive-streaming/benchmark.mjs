import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  generateIncompressibleCorpus,
  generateJsonlCorpus,
  generateModerateCorpus,
  hashFile,
} from '../../src/corpus.mjs';

const require = createRequire(import.meta.url);
const native7z = require('7zip-bin-full').path7z;
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');
const buildModule = path.join(here, 'build', 'stream7z.mjs');
const js7zRunner = path.join(here, 'js7z-benchmark.cjs');
const workRoot = path.join(repoRoot, '.streaming-benchmark-work');
const resultRoot = path.join(repoRoot, 'benchmark-results');
const repetitions = Number(process.env.STREAM_BENCH_REPETITIONS || 3);
const corpusBytes = Number(process.env.STREAM_BENCH_BYTES || 32 * 1024 * 1024);
const memoryMiB = (process.env.STREAM_BENCH_MEMORY_MIB || '4,16,32,64')
  .split(',')
  .map((value) => Number(value.trim()));

assert(Number.isInteger(repetitions) && repetitions > 0);
assert(Number.isInteger(corpusBytes) && corpusBytes > 0);
assert(memoryMiB.length > 0);
assert(memoryMiB.every((value) => Number.isInteger(value) && value > 0));
assert(fs.existsSync(native7z));
assert(fs.existsSync(buildModule));
assert(fs.existsSync(js7zRunner));

fs.rmSync(workRoot, { recursive: true, force: true });
fs.mkdirSync(path.join(workRoot, 'corpora'), { recursive: true });
fs.mkdirSync(path.join(workRoot, 'out'), { recursive: true });
fs.mkdirSync(path.join(workRoot, 'verify'), { recursive: true });
fs.mkdirSync(path.join(workRoot, 'memory'), { recursive: true });
fs.mkdirSync(resultRoot, { recursive: true });

const createStream7z = (await import(pathToFileURL(buildModule).href)).default;
const corpusDefinitions = [
  { kind: 'jsonl', label: 'Highly compressible JSONL', create: generateJsonlCorpus },
  { kind: 'moderate', label: 'Moderately compressible 50/50 mixed data', create: generateModerateCorpus },
  { kind: 'incompressible', label: 'Incompressible high-entropy data', create: generateIncompressibleCorpus },
];

const metadata = {
  timestamp: new Date().toISOString(),
  gitSha: process.env.GITHUB_SHA || null,
  workflowRunId: process.env.GITHUB_RUN_ID || null,
  node: process.version,
  cpuModel: os.cpus()[0]?.model || 'unknown',
  logicalCpus: os.cpus().length,
  totalMemoryBytes: os.totalmem(),
  inputBytesPerCorpus: corpusBytes,
  repetitions,
  warmupRuns: 1,
  settings: '7z / LZMA2 / mx=5 / 32 MiB dictionary / solid',
};
const corpora = [];

for (const definition of corpusDefinitions) {
  const corpusDir = path.join(workRoot, 'corpora', definition.kind);
  const corpus = definition.create(corpusDir, corpusBytes);
  const inputName = fs.readdirSync(corpusDir)[0];
  const inputPath = path.join(corpusDir, inputName);
  assert(fs.statSync(inputPath).isFile());
  const inputRel = path.relative(workRoot, inputPath);
  const expectedHash = hashFile(inputPath);

  const direct = await runDirectSeries(
    inputRel,
    `${definition.kind}-direct`,
    inputName,
    expectedHash,
  );
  const js7zSingle = runJs7zSeries(inputRel, `${definition.kind}-js7z-single`, 'single');
  const js7zAuto = runJs7zSeries(inputRel, `${definition.kind}-js7z-auto`, 'auto');
  const nativeSingle = runNativeSeries(
    inputRel,
    `${definition.kind}-native-single`,
    'single',
    inputName,
    expectedHash,
  );
  const nativeAuto = runNativeSeries(
    inputRel,
    `${definition.kind}-native-auto`,
    'auto',
    inputName,
    expectedHash,
  );

  for (const entry of [js7zSingle, js7zAuto]) {
    for (const run of entry.runs) {
      validateStock7zArchive(
        path.join(workRoot, run.archiveRel),
        inputName,
        corpusBytes,
        expectedHash,
      );
    }
  }

  const rawResults = [
    { id: 'direct-libarchive-wasm', threadMode: 'single', runs: direct.runs },
    { id: 'js7z-tools-2.5.0', threadMode: 'single', runs: js7zSingle.runs },
    { id: 'js7z-tools-2.5.0', threadMode: 'auto', runs: js7zAuto.runs },
    { id: 'native-7zip-26.03', threadMode: 'single', runs: nativeSingle.runs },
    { id: 'native-7zip-26.03', threadMode: 'auto', runs: nativeAuto.runs },
  ];
  corpora.push({
    kind: definition.kind,
    label: definition.label,
    inputBytes: corpusBytes,
    inputSha256: expectedHash,
    summary: rawResults.map((entry) => summarize(entry, corpusBytes)),
    rawResults,
  });
}

const memoryScaling = [];
for (const definition of [corpusDefinitions[0], corpusDefinitions[2]]) {
  for (const sizeMiB of memoryMiB) {
    const bytes = sizeMiB * 1024 * 1024;
    const root = path.join(workRoot, 'memory', `${definition.kind}-${sizeMiB}m`);
    const corpus = definition.create(root, bytes);
    const inputName = fs.readdirSync(root)[0];
    const inputPath = path.join(root, inputName);
    const inputRel = path.relative(workRoot, inputPath);
    const archiveRel = `out/memory-${definition.kind}-${sizeMiB}m.7z`;
    const run = await runDirectOnce(inputRel, archiveRel, inputName);
    runNativeCommand(['t', '-bd', '-bso0', '-bse0', path.join(workRoot, archiveRel)]);
    memoryScaling.push({
      kind: definition.kind,
      inputBytes: corpus.bytes,
      inputMiB: sizeMiB,
      archiveBytes: run.archiveBytes,
      ratio: run.archiveBytes / corpus.bytes,
      compressionMs: run.compressionMs,
      initialWasmHeapBytes: run.initialWasmHeapBytes,
      peakWasmHeapBytes: run.peakWasmHeapBytes,
      heapGrowthBytes: run.peakWasmHeapBytes - run.initialWasmHeapBytes,
    });
  }
}

const output = { metadata, corpora, memoryScaling };
fs.writeFileSync(
  path.join(resultRoot, 'streaming-performance-results.json'),
  `${JSON.stringify(output, null, 2)}\n`,
);
console.log(renderSummary(output));

async function runDirectSeries(inputRel, outPrefix, memberName, expectedHash) {
  const warmupRel = `out/${outPrefix}-warmup.7z`;
  await runDirectOnce(inputRel, warmupRel, memberName);
  fs.rmSync(path.join(workRoot, warmupRel), { force: true });

  const runs = [];
  for (let index = 0; index < repetitions; index += 1) {
    const archiveRel = `out/${outPrefix}-run-${index + 1}.7z`;
    const run = await runDirectOnce(inputRel, archiveRel, memberName);
    validateStock7zArchive(
      path.join(workRoot, archiveRel),
      memberName,
      fs.statSync(path.join(workRoot, inputRel)).size,
      expectedHash,
    );
    runs.push(run);
  }
  return { runs };
}

async function runDirectOnce(inputRel, archiveRel, memberName) {
  const inputPath = path.join(workRoot, inputRel);
  const archivePath = path.join(workRoot, archiveRel);
  fs.rmSync(archivePath, { force: true });
  const inputBytes = fs.statSync(inputPath).size;
  let module;
  let sourceFd = -1;
  let sourcePosition = 0;
  let outputFd = -1;

  const initStart = performance.now();
  module = await createStream7z({
    stream7zRead(sourceId, view) {
      if (sourceId !== 1 || sourceFd < 0 || !(view instanceof Uint8Array)) return -1;
      const remaining = inputBytes - sourcePosition;
      if (remaining <= 0) return 0;
      const length = Math.min(view.byteLength, remaining);
      const count = fs.readSync(sourceFd, view, 0, length, sourcePosition);
      sourcePosition += count;
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
      if (outputId !== 1 || outputFd < 0 || !(view instanceof Uint8Array)) return -1;
      return fs.writeSync(outputFd, view, 0, view.byteLength, null);
    },
  });
  const initMs = performance.now() - initStart;

  const lastError = module.cwrap('stream7z_last_error', 'string', []);
  const heapSize = module.cwrap('stream7z_heap_size', 'number', []);
  const writerBegin = module.cwrap(
    'stream7z_writer_begin', 'number', ['number', 'string', 'number']);
  const writerAppendSource = module.cwrap(
    'stream7z_writer_append_source', 'number', ['number', 'number', 'number']);
  const writerFinish = module.cwrap('stream7z_writer_finish', 'number', ['number']);

  const initialWasmHeapBytes = heapSize();
  let peakWasmHeapBytes = initialWasmHeapBytes;
  sourceFd = fs.openSync(inputPath, 'r');
  outputFd = fs.openSync(archivePath, 'w');
  const start = performance.now();
  try {
    const writer = writerBegin(1, memberName, inputBytes);
    assert.notEqual(writer, 0, lastError());
    peakWasmHeapBytes = Math.max(peakWasmHeapBytes, heapSize());
    assert.equal(writerAppendSource(writer, 1, inputBytes), 0, lastError());
    peakWasmHeapBytes = Math.max(peakWasmHeapBytes, heapSize());
    assert.equal(writerFinish(writer), 0, lastError());
    peakWasmHeapBytes = Math.max(peakWasmHeapBytes, heapSize());
  } finally {
    fs.closeSync(sourceFd);
    fs.closeSync(outputFd);
  }
  const compressionMs = performance.now() - start;
  const archiveBytes = fs.statSync(archivePath).size;
  assert(archiveBytes > 0);
  return {
    initMs,
    compressionMs,
    archiveBytes,
    archiveRel,
    initialWasmHeapBytes,
    peakWasmHeapBytes,
  };
}

function runJs7zSeries(inputRel, outPrefix, threadMode) {
  const result = childProcess.spawnSync(
    process.execPath,
    [js7zRunner, workRoot, inputRel, outPrefix, threadMode, String(repetitions)],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 30 * 60 * 1000,
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  const lines = result.stdout.trim().split(/\r?\n/).filter(Boolean);
  const parsed = JSON.parse(lines.at(-1));
  assert.equal(parsed.implementation, 'js7z-tools');
  assert.equal(parsed.threadMode, threadMode);
  assert.equal(parsed.runs.length, repetitions);
  return parsed;
}

function runNativeSeries(inputRel, outPrefix, threadMode, memberName, expectedHash) {
  const warmupRel = `out/${outPrefix}-warmup.7z`;
  runNativeOnce(inputRel, warmupRel, threadMode);
  fs.rmSync(path.join(workRoot, warmupRel), { force: true });

  const runs = [];
  for (let index = 0; index < repetitions; index += 1) {
    const archiveRel = `out/${outPrefix}-run-${index + 1}.7z`;
    const run = runNativeOnce(inputRel, archiveRel, threadMode);
    validateStock7zArchive(
      path.join(workRoot, archiveRel),
      memberName,
      fs.statSync(path.join(workRoot, inputRel)).size,
      expectedHash,
    );
    runs.push(run);
  }
  return { runs };
}

function runNativeOnce(inputRel, archiveRel, threadMode) {
  const inputPath = path.join(workRoot, inputRel);
  const inputDir = path.dirname(inputPath);
  const inputName = path.basename(inputPath);
  const archivePath = path.join(workRoot, archiveRel);
  fs.rmSync(archivePath, { force: true });
  const threading = threadMode === 'single' ? '-mmt=1' : '-mmt=on';
  const start = performance.now();
  runNativeCommand([
    'a', '-t7z', '-mx=5', '-m0=lzma2', '-md=32m', '-ms=on', threading,
    '-bd', '-bso0', '-bse0', '-bsp0', '-y', archivePath, inputName,
  ], inputDir);
  const compressionMs = performance.now() - start;
  return {
    initMs: 0,
    compressionMs,
    archiveBytes: fs.statSync(archivePath).size,
    archiveRel,
  };
}

function validateStock7zArchive(archivePath, memberName, expectedBytes, expectedHash) {
  runNativeCommand(['t', '-bd', '-bso0', '-bse0', archivePath]);
  const listing = runNativeCommand(['l', '-slt', '-bd', archivePath]);
  assert(listing.stdout.includes(`Path = ${memberName}`));
  assert(listing.stdout.includes(`Size = ${expectedBytes}`));
  assert.match(listing.stdout, /Method = LZMA2/);

  const extractRoot = path.join(
    workRoot,
    'verify',
    path.basename(archivePath, '.7z'),
  );
  fs.rmSync(extractRoot, { recursive: true, force: true });
  fs.mkdirSync(extractRoot, { recursive: true });
  runNativeCommand(['x', '-bd', '-bso0', '-bse0', '-y', `-o${extractRoot}`, archivePath]);
  const extracted = path.join(extractRoot, memberName);
  assert.equal(fs.statSync(extracted).size, expectedBytes);
  assert.equal(hashFile(extracted), expectedHash);
  fs.rmSync(extractRoot, { recursive: true, force: true });
}

function runNativeCommand(args, cwd = workRoot) {
  const result = childProcess.spawnSync(native7z, args, {
    cwd,
    encoding: 'utf8',
    timeout: 10 * 60 * 1000,
    maxBuffer: 4 * 1024 * 1024,
  });
  assert.equal(
    result.status,
    0,
    `native 7z failed: ${args.join(' ')}\n${result.stderr}\n${result.stdout}`,
  );
  return result;
}

function summarize(entry, inputBytes) {
  const times = entry.runs.map((run) => run.compressionMs).sort((a, b) => a - b);
  const sizes = entry.runs.map((run) => run.archiveBytes);
  assert(sizes.every((size) => size === sizes[0]), `${entry.id} archive sizes varied`);
  const medianMs = median(times);
  const initTimes = entry.runs.map((run) => run.initMs || 0).sort((a, b) => a - b);
  const peaks = entry.runs
    .map((run) => run.peakWasmHeapBytes)
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);
  return {
    id: entry.id,
    threadMode: entry.threadMode,
    medianMs,
    minMs: Math.min(...times),
    maxMs: Math.max(...times),
    throughputMiBPerSec: inputBytes / (1024 * 1024) / (medianMs / 1000),
    archiveBytes: sizes[0],
    ratio: sizes[0] / inputBytes,
    medianInitMs: median(initTimes),
    medianPeakWasmHeapBytes: peaks.length ? median(peaks) : null,
  };
}

function median(sorted) {
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function renderSummary(result) {
  const lines = [
    '# Streaming 7z direct-WASM performance',
    '',
    `CPU: ${result.metadata.cpuModel}`,
    `Logical CPUs: ${result.metadata.logicalCpus}`,
    `Input per corpus: ${(result.metadata.inputBytesPerCorpus / 1024 / 1024).toFixed(0)} MiB`,
    `Measured repetitions: ${result.metadata.repetitions} after one warm-up`,
    '',
  ];
  for (const corpus of result.corpora) {
    lines.push(`## ${corpus.label}`, '', '| Implementation | Threads | Median ms | MiB/s | Ratio |', '|---|---|---:|---:|---:|');
    for (const row of [...corpus.summary].sort((a, b) => a.medianMs - b.medianMs)) {
      lines.push(`| ${row.id} | ${row.threadMode} | ${row.medianMs.toFixed(1)} | ${row.throughputMiBPerSec.toFixed(2)} | ${(row.ratio * 100).toFixed(2)}% |`);
    }
    lines.push('');
  }
  lines.push('## Direct-WASM memory scaling', '', '| Corpus | Input MiB | Peak heap MiB | Heap growth MiB | Archive ratio |', '|---|---:|---:|---:|---:|');
  for (const row of result.memoryScaling) {
    lines.push(`| ${row.kind} | ${row.inputMiB} | ${(row.peakWasmHeapBytes / 1024 / 1024).toFixed(1)} | ${(row.heapGrowthBytes / 1024 / 1024).toFixed(1)} | ${(row.ratio * 100).toFixed(2)}% |`);
  }
  return `${lines.join('\n')}\n`;
}
