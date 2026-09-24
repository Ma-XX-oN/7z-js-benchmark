const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

const [implementation, workRoot, corpusRel, outPrefix, threadMode, repetitionsText] =
  process.argv.slice(2);
const repetitions = Number(repetitionsText);

assert(['sevenzip-wasm', '7z-wasm', 'js7z-tools'].includes(implementation));
assert(path.isAbsolute(workRoot));
assert(fs.statSync(path.join(workRoot, corpusRel)).isDirectory());
assert(['single', 'auto'].includes(threadMode));
assert(Number.isInteger(repetitions) && repetitions > 0);

const loaded = require(implementation);
const factory = loaded.default || loaded;
assert.equal(typeof factory, 'function');

function compressionArgs(archiveRel) {
  const threading = threadMode === 'single' ? '-mmt=1' : '-mmt=on';
  return [
    'a', '-t7z', '-mx=5', '-m0=lzma2', '-md=32m', '-ms=on', threading,
    '-bd', '-bso0', '-bse0', '-bsp0', '-y', archiveRel, corpusRel
  ];
}

async function createInstance() {
  const errors = [];
  const start = performance.now();
  const instance = await factory({
    print: () => {},
    printErr: (line) => errors.push(String(line))
  });
  const initMs = performance.now() - start;

  assert(instance && instance.FS);
  const nodefs = instance.NODEFS || instance.FS.filesystems?.NODEFS;
  assert(nodefs, `${implementation} did not expose NODEFS`);
  instance.FS.mkdir('/host');
  instance.FS.mount(nodefs, { root: workRoot }, '/host');
  instance.FS.chdir('/host');

  return { instance, initMs, errors };
}

async function runJs7z(instance, args, errors) {
  await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };

    instance.onExit = (code) => {
      if (code === 0) {
        finish(resolve);
      } else {
        finish(reject, new Error(`JS7z exited with code ${code}: ${errors.join('\n')}`));
      }
    };
    instance.onAbort = (reason) => {
      finish(reject, new Error(`JS7z aborted: ${reason}: ${errors.join('\n')}`));
    };

    try {
      const result = instance.callMain(args);
      if (result && typeof result.then === 'function') {
        result.catch((error) => finish(reject, error));
      }
    } catch (error) {
      finish(reject, error);
    }
  });
}

async function runCommand(instance, args, errors) {
  if (implementation === 'js7z-tools') {
    await runJs7z(instance, args, errors);
    return;
  }

  const result = instance.callMain(args);
  assert.equal(result, 0, `${implementation} exited ${result}: ${errors.join('\n')}`);
}

async function runOne(archiveRel) {
  fs.rmSync(path.join(workRoot, archiveRel), { force: true });
  const { instance, initMs, errors } = await createInstance();
  const start = performance.now();
  await runCommand(instance, compressionArgs(archiveRel), errors);
  const compressionMs = performance.now() - start;
  const archiveBytes = fs.statSync(path.join(workRoot, archiveRel)).size;
  assert(archiveBytes > 0);
  return { initMs, compressionMs, archiveBytes, archiveRel };
}

(async () => {
  const warmup = await runOne(`out/${outPrefix}-warmup.7z`);
  fs.rmSync(path.join(workRoot, warmup.archiveRel), { force: true });

  const runs = [];
  for (let i = 0; i < repetitions; i += 1) {
    runs.push(await runOne(`out/${outPrefix}-run-${i + 1}.7z`));
  }

  process.stdout.write(`${JSON.stringify({ implementation, threadMode, runs })}\n`);
})().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
