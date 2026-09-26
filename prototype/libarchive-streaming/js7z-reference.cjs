const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const [workRoot, inputRel, archiveRel] = process.argv.slice(2);
assert(path.isAbsolute(workRoot));
assert(inputRel && archiveRel);
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

(async () => {
  const errors = [];
  const instance = await factory({
    print: () => {},
    printErr: (line) => errors.push(String(line)),
  });
  assert(instance && instance.FS);
  const nodefs = instance.NODEFS || instance.FS.filesystems?.NODEFS;
  assert(nodefs, 'JS7z did not expose NODEFS');
  instance.FS.mkdir('/host');
  instance.FS.mount(nodefs, { root: workRoot }, '/host');
  instance.FS.chdir('/host');

  fs.rmSync(path.join(workRoot, archiveRel), { force: true });
  await runJs7z(instance, [
    'a', '-t7z', '-mx=5', '-m0=lzma2', '-md=32m', '-ms=on', '-mmt=1', '-mtm-', '-mtr-',
    '-bd', '-bso0', '-bse0', '-bsp0', '-y', archiveRel, inputRel,
  ], errors);

  const archivePath = path.join(workRoot, archiveRel);
  assert(fs.statSync(archivePath).size > 0);
  process.stdout.write(`${JSON.stringify({ archiveBytes: fs.statSync(archivePath).size })}\n`);
})().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
