import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export function generateJsonlCorpus(root, targetBytes = 32 * 1024 * 1024) {
  assert(Number.isInteger(targetBytes) && targetBytes > 0);
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });

  const file = path.join(root, 'conversation.jsonl');
  const fd = fs.openSync(file, 'w');
  let written = 0;
  let id = 0;

  try {
    while (written < targetBytes) {
      const role = id % 3 === 0 ? 'user' : 'assistant';
      const payload = {
        id,
        role,
        timestamp: `2026-09-24T15:${String(id % 60).padStart(2, '0')}:00-04:00`,
        content: `Conversation benchmark record ${id}. ` +
          'Typed arrays, WebAssembly, compression, JSONL, source code, and logs. '.repeat(12) +
          `Sequence=${id % 997}; branch=issue-${id % 31}; status=${id % 5}.`
      };
      const line = `${JSON.stringify(payload)}\n`;
      const buffer = Buffer.from(line);
      fs.writeSync(fd, buffer);
      written += buffer.length;
      id += 1;
    }
  } finally {
    fs.closeSync(fd);
  }

  return {
    bytes: fs.statSync(file).size,
    files: 1,
    sha256: hashFile(file)
  };
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
