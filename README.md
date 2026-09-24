# 7z-js-benchmark

Reproducible compression benchmarks for JavaScript/WebAssembly 7-Zip ports against native 7-Zip.

The benchmark supports two deterministic 32 MiB corpus types:

- `jsonl`: highly compressible conversation-style JSONL.
- `incompressible`: AES-256-CTR high-entropy bytes for a worst-case compression workload.

Set `BENCH_CORPUS_KIND` to select the corpus. The benchmark verifies every archive with native 7-Zip, extracts it, and checks the extracted tree SHA-256 against the source tree. The incompressible corpus is also required to remain at least 99% of its input size after compression.

Work is tracked in issue #1.
