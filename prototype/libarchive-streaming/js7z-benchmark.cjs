const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

const [workRoot, inputRel, outPrefix, threadMode, repetitionsText] = process.argv.slice(2);
const repetitions = Number(repetitionsText);
assert(path.isAbsolute(workRoot));
assert(inputRel && outPrefix);
assert(['single', 'auto'].includes(threadMode));
assert(Number.isInteger(repetitions) && repetitions > 0);
assert(fs.statSync(path.join(workRoot, inputRel)).isFile());

const loaded = require('js7z-tools');
const factory = loaded.default || loaded;
assert.equal(typeof factory, 'function');

async function runJs7z(instance, args, errors) {
  await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    instance.onExit = (code) => {
      if (code === 0) finish(resolve);
      else finish(reject, new Error(`JS7z exited with code ${code}: ${errors.join('\n')}`));
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

async function runOne(label) {
  const inputDirRel = path.dirname(inputRel).replaceAll(path.sep, '/');
  const inputName = path.basename(inputRel);
  const archiveRel = `out/${outPrefix}-${label}.7z`;
  const archiveHost = path.join(workRoot, archiveRel);
  fs.rmSync(archiveHost, { force: true });

  const errors = [];
  const initStart = performance.now();
  const instance = await factory({
    print: () => {},
    printErr: (line) => errors.push(String(line)),
  });
  const initMs = performance.now() - initStart;
  assert(instance && instance.FS);
  const nodefs = instance.NODEFS || instance.FS.filesystems?.NODEFS;
  assert(nodefs, 'JS7z did not expose NODEFS');
  instance.FS.mkdir('/host');
  instance.FS.mount(nodefs, { root: workRoot }, '/host');
  instance.FS.chdir(inputDirRel === '.' ? '/host' : `/host/${inputDirRel}`);

  const threading = threadMode === 'single' ? '-mmt=1' : '-mmt=on';
  const archiveVirtual = `/host/${archiveRel}`;
  const start = performance.now();
  await runJs7z(instance, [
    'a', '-t7z', '-mx=5', '-m0=lzma2', '-md=32m', '-ms=on', threading,
    '-bd', '-bso0', '-bse0', '-bsp0', '-y', archiveVirtual, inputName,
  ], errors);
  const compressionMs = performance.now() - start;
  const archiveBytes = fs.statSync(archiveHost).size;
  assert(archiveBytes > 0);
  return { initMs, compressionMs, archiveBytes, archiveRel };
}

(async () => {
  const warmup = await runOne('warmup');
  fs.rmSync(path.join(workRoot, warmup.archiveRel), { force: true });
  const runs = [];
  for (let i = 0; i < repetitions; i += 1) {
    runs.push(await runOne(`run-${i + 1}`));
  }
  process.stdout.write(`${JSON.stringify({ implementation: 'js7z-tools', threadMode, runs })}\n`);
})().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
