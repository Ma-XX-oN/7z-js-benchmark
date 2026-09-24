import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { createRequire } from 'node:module';
import {
  generateIncompressibleCorpus,
  generateJsonlCorpus,
  generateModerateCorpus,
  hashTree
} from './corpus.mjs';

const require = createRequire(import.meta.url);
const native7z = require('7zip-bin-full').path7z;
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const workRoot = path.join(repoRoot, '.benchmark-work');
const resultRoot = path.join(repoRoot, 'benchmark-results');
const repetitions = Number(process.env.BENCH_REPETITIONS || 3);
const corpusBytes = Number(process.env.BENCH_CORPUS_BYTES || 32 * 1024 * 1024);
const corpusSelection = process.env.BENCH_CORPUS_KIND || 'all';

assert(Number.isInteger(repetitions) && repetitions > 0);
assert(Number.isInteger(corpusBytes) && corpusBytes > 0);
assert(['all', 'jsonl', 'moderate', 'incompressible'].includes(corpusSelection));
assert(fs.existsSync(native7z));

const corpusDefinitions = [
  {
    kind: 'jsonl',
    label: 'Highly compressible JSONL',
    generator: 'fixed-size conversation-style JSONL records',
    create: generateJsonlCorpus,
    ratioMin: 0,
    ratioMax: 0.10
  },
  {
    kind: 'moderate',
    label: 'Moderately compressible 50/50 mixed data',
    generator: 'alternating 64 KiB repetitive and AES-256-CTR high-entropy blocks',
    create: generateModerateCorpus,
    ratioMin: 0.40,
    ratioMax: 0.60
  },
  {
    kind: 'incompressible',
    label: 'Incompressible high-entropy data',
    generator: 'deterministic AES-256-CTR high-entropy bytes',
    create: generateIncompressibleCorpus,
    ratioMin: 0.99,
    ratioMax: 1.02
  }
];
const selectedCorpora = corpusSelection === 'all'
  ? corpusDefinitions
  : corpusDefinitions.filter((entry) => entry.kind === corpusSelection);

const implementations = [
  { id: 'native-7zip-26.03', kind: 'native' },
  { id: 'sevenzip-wasm-26.3.0', kind: 'wasm', package: 'sevenzip-wasm' },
  { id: 'js7z-tools-2.5.0', kind: 'wasm', package: 'js7z-tools' },
  { id: '7z-wasm-1.2.0', kind: 'wasm', package: '7z-wasm' }
];
const threadModes = ['single', 'auto'];

fs.rmSync(workRoot, { recursive: true, force: true });
fs.rmSync(resultRoot, { recursive: true, force: true });
fs.mkdirSync(path.join(workRoot, 'corpora'), { recursive: true });
fs.mkdirSync(path.join(workRoot, 'out'), { recursive: true });
fs.mkdirSync(resultRoot, { recursive: true });

const metadata = {
  timestamp: new Date().toISOString(),
  workflowRunId: process.env.GITHUB_RUN_ID || null,
  gitSha: process.env.GITHUB_SHA || null,
  node: process.version,
  platform: `${process.platform} ${process.arch}`,
  release: os.release(),
  cpuModel: os.cpus()[0]?.model || 'unknown',
  logicalCpus: os.cpus().length,
  totalMemoryBytes: os.totalmem(),
  settings: {
    format: '7z',
    method: 'LZMA2',
    level: 5,
    dictionary: '32 MiB',
    solid: true,
    repetitions,
    warmupRuns: 1
  }
};
const corpusResults = [];

for (const definition of selectedCorpora) {
  const corpusRel = `corpora/${definition.kind}`;
  const corpusRoot = path.join(workRoot, corpusRel);
  const corpus = definition.create(corpusRoot, corpusBytes);
  const sourceTreeHash = hashTree(corpusRoot);
  const rawResults = [];

  for (const threadMode of threadModes) {
    for (const implementation of implementations) {
      const outPrefix =
        `${definition.kind}-${implementation.id}-${threadMode}`;
      const result = implementation.kind === 'native'
        ? runNative(outPrefix, threadMode, corpusRel)
        : runWasm(implementation, outPrefix, threadMode, corpusRel);

      for (const run of result.runs) {
        verifyArchive(run.archiveRel, corpusRel, sourceTreeHash);
      }

      rawResults.push({
        id: implementation.id,
        threadMode,
        runs: result.runs
      });
    }
  }

  const summary = rawResults.map((entry) => summarize(entry, corpus.bytes));
  assert(
    summary.every(
      (row) => row.ratio >= definition.ratioMin &&
        row.ratio <= definition.ratioMax
    ),
    `${definition.kind} corpus ratio escaped expected range ` +
      `${definition.ratioMin}-${definition.ratioMax}`
  );

  corpusResults.push({
    corpus: {
      kind: definition.kind,
      label: definition.label,
      generator: definition.generator,
      requestedBytes: corpusBytes,
      actualBytes: corpus.bytes,
      files: corpus.files,
      treeSha256: sourceTreeHash,
      ratioExpected: [definition.ratioMin, definition.ratioMax]
    },
    summary,
    rawResults
  });
}

const output = { metadata, corpora: corpusResults };
fs.writeFileSync(
  path.join(resultRoot, 'results.json'),
  `${JSON.stringify(output, null, 2)}\n`
);
const summaryMarkdown = renderMarkdown(metadata, corpusResults);
fs.writeFileSync(path.join(resultRoot, 'summary.md'), summaryMarkdown);
console.log(summaryMarkdown);

function baseArgs(archiveRel, threadMode, corpusRel) {
  const threading = threadMode === 'single' ? '-mmt=1' : '-mmt=on';
  return [
    'a', '-t7z', '-mx=5', '-m0=lzma2', '-md=32m', '-ms=on', threading,
    '-bd', '-bso0', '-bse0', '-bsp0', '-y', archiveRel, corpusRel
  ];
}

function runNative(outPrefix, threadMode, corpusRel) {
  const warmupRel = `out/${outPrefix}-warmup.7z`;
  runNativeOnce(warmupRel, threadMode, corpusRel);
  fs.rmSync(path.join(workRoot, warmupRel), { force: true });

  const runs = [];
  for (let i = 0; i < repetitions; i += 1) {
    const archiveRel = `out/${outPrefix}-run-${i + 1}.7z`;
    runs.push(runNativeOnce(archiveRel, threadMode, corpusRel));
  }
  return { runs };
}

function runNativeOnce(archiveRel, threadMode, corpusRel) {
  fs.rmSync(path.join(workRoot, archiveRel), { force: true });
  const start = performance.now();
  const result = childProcess.spawnSync(
    native7z,
    baseArgs(archiveRel, threadMode, corpusRel),
    {
      cwd: workRoot,
      encoding: 'utf8',
      timeout: 10 * 60 * 1000
    }
  );
  const compressionMs = performance.now() - start;
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const archiveBytes = fs.statSync(path.join(workRoot, archiveRel)).size;
  assert(archiveBytes > 0);
  return { initMs: 0, compressionMs, archiveBytes, archiveRel };
}

function runWasm(implementation, outPrefix, threadMode, corpusRel) {
  const runner = path.join(here, 'wasm-runner.cjs');
  const result = childProcess.spawnSync(
    process.execPath,
    [
      runner,
      implementation.package,
      workRoot,
      corpusRel,
      outPrefix,
      threadMode,
      String(repetitions)
    ],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 20 * 60 * 1000,
      maxBuffer: 10 * 1024 * 1024
    }
  );
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  const lines = result.stdout.trim().split(/\r?\n/).filter(Boolean);
  assert(lines.length > 0, `${implementation.id} produced no JSON result`);
  const parsed = JSON.parse(lines.at(-1));
  assert.equal(parsed.implementation, implementation.package);
  assert.equal(parsed.threadMode, threadMode);
  assert.equal(parsed.runs.length, repetitions);
  return parsed;
}

function verifyArchive(archiveRel, corpusRel, expectedTreeHash) {
  const archive = path.join(workRoot, archiveRel);
  const test = childProcess.spawnSync(
    native7z,
    ['t', '-bd', '-bso0', '-bse0', archive],
    {
      cwd: workRoot,
      encoding: 'utf8',
      timeout: 5 * 60 * 1000
    }
  );
  assert.equal(test.status, 0, test.stderr || test.stdout);

  const extractRoot = path.join(
    workRoot,
    'verify',
    path.basename(archiveRel, '.7z')
  );
  fs.rmSync(extractRoot, { recursive: true, force: true });
  fs.mkdirSync(extractRoot, { recursive: true });
  const extract = childProcess.spawnSync(
    native7z,
    ['x', '-bd', '-bso0', '-bse0', '-y', `-o${extractRoot}`, archive],
    {
      cwd: workRoot,
      encoding: 'utf8',
      timeout: 5 * 60 * 1000
    }
  );
  assert.equal(extract.status, 0, extract.stderr || extract.stdout);
  const extractedCorpus = path.join(extractRoot, corpusRel);
  assert.equal(hashTree(extractedCorpus), expectedTreeHash);
  fs.rmSync(extractRoot, { recursive: true, force: true });
}

function summarize(entry, inputBytes) {
  const times = entry.runs
    .map((run) => run.compressionMs)
    .sort((a, b) => a - b);
  const sizes = entry.runs.map((run) => run.archiveBytes);
  assert(
    sizes.every((size) => size === sizes[0]),
    `${entry.id} archive sizes varied`
  );
  const medianMs = median(times);
  return {
    id: entry.id,
    threadMode: entry.threadMode,
    medianMs,
    minMs: Math.min(...times),
    maxMs: Math.max(...times),
    throughputMiBPerSec:
      inputBytes / (1024 * 1024) / (medianMs / 1000),
    archiveBytes: sizes[0],
    ratio: sizes[0] / inputBytes,
    medianInitMs: median(
      entry.runs.map((run) => run.initMs).sort((a, b) => a - b)
    )
  };
}

function median(sorted) {
  assert(sorted.length > 0);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function renderMarkdown(common, results) {
  const lines = [
    '# 7z JavaScript/WASM compression benchmark',
    '',
    `- CPU: ${common.cpuModel}`,
    `- Logical CPUs: ${common.logicalCpus}`,
    `- Node: ${common.node}`,
    '- Settings: 7z / LZMA2 / mx=5 / 32 MiB dictionary / solid',
    `- Measured repetitions: ${common.settings.repetitions} after 1 warm-up`,
    ''
  ];

  for (const result of results) {
    lines.push(
      `## ${result.corpus.label}`,
      '',
      `- Input: ${(result.corpus.actualBytes / 1024 / 1024).toFixed(2)} MiB`,
      `- Generator: ${result.corpus.generator}`,
      '',
      '| Thread mode | Implementation | Median compression | MiB/s | ' +
        'Archive MiB | Ratio | Median WASM init |',
      '|---|---|---:|---:|---:|---:|---:|'
    );
    const rows = [...result.summary].sort((a, b) => {
      const threadCompare = a.threadMode.localeCompare(b.threadMode);
      return threadCompare || a.medianMs - b.medianMs;
    });
    for (const row of rows) {
      lines.push(
        `| ${row.threadMode} | ${row.id} | ${row.medianMs.toFixed(1)} ms | ` +
          `${row.throughputMiBPerSec.toFixed(2)} | ` +
          `${(row.archiveBytes / 1024 / 1024).toFixed(3)} | ` +
          `${(row.ratio * 100).toFixed(2)}% | ` +
          `${row.medianInitMs.toFixed(1)} ms |`
      );
    }
    lines.push('');
  }

  lines.push(
    'All produced archives passed native 7-Zip integrity testing and ' +
      'extracted tree SHA-256 verification.',
    ''
  );
  return `${lines.join('\n')}\n`;
}
