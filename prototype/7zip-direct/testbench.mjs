import assert from 'node:assert/strict';
import { gzipSync, gunzipSync } from 'node:zlib';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = new URL('./', import.meta.url);
const modulePath = new URL('build/stream7z.mjs', here);
const wasmPath = new URL('build/stream7z.wasm', here);

// Mirror DownloadConversation's delivery shape: gzip the Wasm, embed that
// compressed payload as base64 text, then recover the exact Wasm bytes before
// instantiating the Emscripten module.
const builtWasm = await readFile(wasmPath);
const embeddedCompressedWasmBase64 = gzipSync(builtWasm, { level: 9 }).toString('base64');
const wasmBinary = new Uint8Array(
  gunzipSync(Buffer.from(embeddedCompressedWasmBase64, 'base64'))
);
assert.deepEqual(Buffer.from(wasmBinary), builtWasm);

const createModule = (await import(pathToFileURL(fileURLToPath(modulePath)).href)).default;
const sources = new Map();
const outputs = new Map();
const mod = await createModule({
  wasmBinary,
  stream7zRead(id, target) {
    const source = sources.get(id);
    if (!source) return -1;
    const count = Math.min(target.length, source.bytes.length - source.offset);
    if (count <= 0) return 0;
    target.set(source.bytes.subarray(source.offset, source.offset + count));
    source.offset += count;
    return count;
  },
  stream7zReadAt(id, position, target) {
    const source = sources.get(id);
    if (!source || !Number.isSafeInteger(position) || position < 0) return -1;
    const count = Math.min(target.length, source.bytes.length - position);
    if (count <= 0) return 0;
    target.set(source.bytes.subarray(position, position + count));
    return count;
  },
  stream7zWriteAt(id, position, bytes) {
    const output = outputs.get(id);
    if (!output || !Number.isSafeInteger(position) || position < 0) return -1;
    const required = position + bytes.length;
    if (required > output.bytes.length) {
      const grown = new Uint8Array(Math.max(required, output.bytes.length * 2, 4096));
      grown.set(output.bytes);
      output.bytes = grown;
    }
    output.bytes.set(bytes, position);
    output.size = Math.max(output.size, required);
    return bytes.length;
  },
  stream7zSetSize(id, size) {
    const output = outputs.get(id);
    if (!output || !Number.isSafeInteger(size) || size < 0) return -1;
    if (size > output.bytes.length) {
      const grown = new Uint8Array(size);
      grown.set(output.bytes.subarray(0, output.size));
      output.bytes = grown;
    }
    output.size = size;
    return 0;
  }
});

const create = mod.cwrap('stream7z_create', 'number', ['number', 'number', 'string', 'number']);
const extract = mod.cwrap('stream7z_extract', 'number', ['number', 'number', 'number']);
const lastError = mod.cwrap('stream7z_last_error', 'string', []);

const input = new TextEncoder().encode(
  '{"type":"testbench","message":"embedded compressed Wasm round trip"}\n'
);
sources.set(1, { bytes: input, offset: 0 });
outputs.set(1, { bytes: new Uint8Array(4096), size: 0 });
assert.equal(create(1, 1, 'testbench.jsonl', input.length), 0, lastError());
const archiveState = outputs.get(1);
const archive = archiveState.bytes.slice(0, archiveState.size);
assert.deepEqual(Array.from(archive.subarray(0, 6)), [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]);

sources.set(2, { bytes: archive, offset: 0 });
outputs.set(2, { bytes: new Uint8Array(4096), size: 0 });
assert.equal(extract(2, archive.length, 2), 0, lastError());
const extractedState = outputs.get(2);
const extracted = extractedState.bytes.slice(0, extractedState.size);
assert.deepEqual(extracted, input);

console.log(JSON.stringify({
  embeddedCompressedWasmBytes: Buffer.from(embeddedCompressedWasmBase64, 'base64').length,
  wasmBytes: wasmBinary.length,
  archiveBytes: archive.length,
  roundTripExact: true
}));
