import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { workspace, window, tasks, env } from './vscode-mock';
import { findOnPath } from '../findOnPath';
import {
  checkToolchain, installPlan, isWindowsStoreStub, promptIfMissing, registerToolchainCheck, setExtraDirs,
  DISMISSED_KEY, PYTHON_DOWNLOAD_URL, R65_MODULE, R65_PIP_SOURCE, SETUP_DOCS_URL,
} from '../toolchainSetup';

const NOTHING = { r65: false, wla: false };
const PIP_INSTALL = ['-m', 'pip', 'install', '--user', R65_PIP_SOURCE];

function makeContext(state: Record<string, any> = {}) {
  return {
    subscriptions: [] as any[],
    globalState: {
      get: (key: string) => state[key],
      update: (key: string, value: any) => { state[key] = value; return Promise.resolve(); },
    },
    state,
  };
}

/** A temp dir holding empty files with these names, put alone on PATH. */
function fakePath(names: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xretrocode-path-'));
  for (const name of names) {
    fs.writeFileSync(path.join(dir, name), '');
  }
  process.env.PATH = dir;
  return dir;
}

/**
 * A `python` in `dir` for which `-m r65.compiler.main` and `-m pip` succeed
 * or fail as asked (a shell script, so not on Windows).
 */
function fakePython(dir: string, { r65, pip }: { r65: boolean; pip: boolean }): string {
  const python = path.join(dir, 'python');
  fs.writeFileSync(python, [
    '#!/bin/sh',
    `[ "$1 $2" = "-m ${R65_MODULE}" ] && exit ${r65 ? 0 : 1}`,
    `[ "$1 $2" = "-m pip" ] && exit ${pip ? 0 : 1}`,
    'exit 1',
  ].join('\n') + '\n', { mode: 0o755 });
  return python;
}

describe('installPlan', () => {
  it('runs the setup guide commands: brew, and pip into the makefiles\' python', () => {
    const plan = installPlan(NOTHING, { brew: '/opt/homebrew/bin/brew', python: '/usr/bin/python', hasPip: true });
    assert.deepStrictEqual(plan.steps.map(s => [s.command, ...s.args]), [
      ['/opt/homebrew/bin/brew', 'install', 'wla-dx'],
      ['/usr/bin/python', ...PIP_INSTALL],
    ]);
    assert.strictEqual(plan.needsManualWla, false);
    assert.strictEqual(plan.needsPython, false);
  });

  it('links a WLA-DX download without brew', () => {
    const plan = installPlan(NOTHING, { python: '/usr/bin/python', hasPip: true });
    assert.deepStrictEqual(plan.steps.map(s => s.label), ['R65']);
    assert.strictEqual(plan.needsManualWla, true);
  });

  it('downloads WLA-DX on Windows when it is missing', () => {
    const plan = installPlan(NOTHING, { python: 'C:\\fake\\python.exe', hasPip: true }, 'win32');
    assert.strictEqual(plan.downloadWla, true);
    assert.strictEqual(plan.needsManualWla, false);
    assert.deepStrictEqual(plan.steps.map(s => s.label), ['R65']);
  });

  it('downloads nothing when WLA-DX is already on PATH', () => {
    for (const platform of ['win32', 'linux', 'darwin'] as NodeJS.Platform[]) {
      const plan = installPlan({ r65: false, wla: true }, { python: 'python', hasPip: true }, platform);
      assert.strictEqual(plan.downloadWla, false, platform);
      assert.strictEqual(plan.needsManualWla, false, platform);
      assert.deepStrictEqual(plan.steps.map(s => s.label), ['R65'], platform);
    }
  });

  it('leaves out --user in a virtualenv', () => {
    const plan = installPlan({ r65: false, wla: true }, { python: '/venv/bin/python', hasPip: true, inVirtualEnv: true });
    assert.deepStrictEqual(plan.steps[0].args, ['-m', 'pip', 'install', R65_PIP_SOURCE]);
  });

  it('installs only what is missing', () => {
    const installers = { brew: 'brew', python: 'python', hasPip: true };
    assert.deepStrictEqual(installPlan({ r65: true, wla: false }, installers).steps.map(s => s.label), ['WLA-DX']);
    assert.deepStrictEqual(installPlan({ r65: false, wla: true }, installers).steps.map(s => s.label), ['R65']);
    assert.deepStrictEqual(installPlan({ r65: true, wla: true }, installers).steps, []);
  });

  it('asks for Python when there is no python', () => {
    const plan = installPlan({ r65: false, wla: true }, {});
    assert.deepStrictEqual(plan.steps, []);
    assert.strictEqual(plan.needsPython, true);
  });

  it('asks for Python when its python has no pip', () => {
    const plan = installPlan({ r65: false, wla: true }, { python: '/usr/bin/python', hasPip: false });
    assert.deepStrictEqual(plan.steps, []);
    assert.strictEqual(plan.needsPython, true);
  });

  it('passes over the Microsoft Store python placeholder', () => {
    assert.ok(isWindowsStoreStub('C:\\Users\\x\\AppData\\Local\\Microsoft\\WindowsApps\\python.exe'));
    assert.ok(!isWindowsStoreStub('C:\\fake\\python.exe'));
  });
});

describe('findOnPath', () => {
  const savedPath = process.env.PATH;
  afterEach(() => { process.env.PATH = savedPath; });

  it('finds a file in a PATH directory', () => {
    const dir = fakePath(['wlalink']);
    assert.strictEqual(findOnPath('wlalink'), path.join(dir, 'wlalink'));
    assert.strictEqual(findOnPath('wla-65816'), undefined);
  });

  it('tries PATHEXT extensions on Windows', () => {
    const dir = fakePath(['mesen-gdb.EXE']);
    const found = findOnPath('mesen-gdb', { Path: dir, PATHEXT: '.COM;.EXE' }, 'win32');
    assert.strictEqual(found, path.join(dir, 'mesen-gdb.EXE'));
  });

  it('ignores a directory with the name', () => {
    const dir = fakePath([]);
    fs.mkdirSync(path.join(dir, 'wlalink'));
    assert.strictEqual(findOnPath('wlalink'), undefined);
  });
});

// The rest runs fake `python` shell scripts
if (process.platform !== 'win32') {
  describe('checkToolchain', () => {
    const savedPath = process.env.PATH;
    beforeEach(() => workspace._reset());
    afterEach(() => { process.env.PATH = savedPath; });

    it('needs both WLA-DX tools', () => {
      const dir = fakePath(['wla-65816']);
      fakePython(dir, { r65: true, pip: true });
      assert.deepStrictEqual(checkToolchain(), { r65: true, wla: false });
      fs.writeFileSync(path.join(dir, 'wlalink'), '');
      assert.deepStrictEqual(checkToolchain(), { r65: true, wla: true });
    });

    it('counts WLA-DX on PATH as installed, so it never asks to install or download it', async () => {
      const dir = fakePath(['wla-65816', 'wlalink']);
      fakePython(dir, { r65: true, pip: true });
      assert.deepStrictEqual(checkToolchain(), { r65: true, wla: true });
      window._reset();
      await promptIfMissing(makeContext() as any);
      assert.strictEqual(window._warnings.length, 0);
    });

    it('finds R65 by running python -m r65.compiler.main, not by an r65c on PATH', () => {
      const dir = fakePath(['r65c', 'wla-65816', 'wlalink']);
      assert.strictEqual(checkToolchain().r65, false, 'no python');
      fakePython(dir, { r65: false, pip: true });
      assert.strictEqual(checkToolchain().r65, false, 'python without R65');
      fakePython(dir, { r65: true, pip: true });
      assert.strictEqual(checkToolchain().r65, true);
    });
  });

  describe('toolchain prompt', () => {
    const savedPath = process.env.PATH;
    const savedVenv = process.env.VIRTUAL_ENV;
    beforeEach(() => {
      workspace._reset();
      window._reset();
      tasks._reset();
      env._reset();
      fakePath([]);
      // Only the fake PATH: a brew on this machine must not count
      setExtraDirs([]);
      delete process.env.VIRTUAL_ENV;
    });
    afterEach(() => {
      process.env.PATH = savedPath;
      setExtraDirs(undefined);
      if (savedVenv !== undefined) process.env.VIRTUAL_ENV = savedVenv;
    });

    it('names what is missing', async () => {
      await promptIfMissing(makeContext() as any);
      assert.strictEqual(window._warnings.length, 1);
      assert.ok(window._warnings[0].msg.includes(`python -m ${R65_MODULE}`), window._warnings[0].msg);
      assert.ok(window._warnings[0].msg.includes('WLA-DX'));
      assert.deepStrictEqual(window._warnings[0].items, ['Install', 'Setup Guide', "Don't Ask Again"]);
    });

    it('stays quiet when everything is installed', async () => {
      fakePython(fakePath(['wla-65816', 'wlalink']), { r65: true, pip: true });
      await promptIfMissing(makeContext() as any);
      assert.strictEqual(window._warnings.length, 0);
    });

    it('remembers Don\'t Ask Again', async () => {
      const context = makeContext();
      window._setWarningMessageChoice("Don't Ask Again");
      await promptIfMissing(context as any);
      assert.strictEqual(context.state[DISMISSED_KEY], true);

      window._reset();
      await promptIfMissing(context as any);
      assert.strictEqual(window._warnings.length, 0);
    });

    it('is off with xretrocode.checkToolchain false', async () => {
      workspace._setConfig('xretrocode.checkToolchain', false);
      await promptIfMissing(makeContext() as any);
      assert.strictEqual(window._warnings.length, 0);
    });

    it('opens the setup guide', async () => {
      window._setWarningMessageChoice('Setup Guide');
      await promptIfMissing(makeContext() as any);
      assert.deepStrictEqual(env._opened.map(u => u.path), [SETUP_DOCS_URL]);
    });

    it('pip installs R65 into the makefiles\' python, in a terminal task', async () => {
      // Only R65 missing; this python has pip
      const python = fakePython(fakePath(['wla-65816', 'wlalink']), { r65: false, pip: true });
      window._setWarningMessageChoice('Install');
      await promptIfMissing(makeContext() as any);
      assert.strictEqual(tasks._executed.length, 1);
      const execution = tasks._executed[0].execution;
      assert.strictEqual(execution.command, python);
      assert.deepStrictEqual(execution.args, PIP_INSTALL);
    });

    it('reports a failed install', async () => {
      fakePython(fakePath(['wla-65816', 'wlalink']), { r65: false, pip: true });
      tasks._setExitCode(1);
      window._setWarningMessageChoice('Install');
      await promptIfMissing(makeContext() as any);
      assert.ok(window._messages.some(m => m.includes('Installing R65 failed')));
    });

    it('says so when R65 installed but python -m r65.compiler.main still fails', async () => {
      fakePython(fakePath(['wla-65816', 'wlalink']), { r65: false, pip: true });
      window._setWarningMessageChoice('Install');
      await promptIfMissing(makeContext() as any);
      assert.ok(window._messages.some(m => m.includes('still doesn\'t run')), JSON.stringify(window._messages));
    });

    it('keeps installing after a failed step, and reports each failure', async () => {
      fakePython(fakePath(['brew']), { r65: false, pip: true });
      tasks._setExitCode(1);
      window._setWarningMessageChoice('Install');
      await promptIfMissing(makeContext() as any);
      assert.deepStrictEqual(tasks._executed.map(t => t.name), ['install WLA-DX', 'install R65']);
      assert.ok(window._messages.some(m => m.includes('Installing WLA-DX and R65 failed')));
    });

    it('sends a python without pip to python.org', async () => {
      fakePython(fakePath(['wla-65816', 'wlalink']), { r65: false, pip: false });
      window._setWarningMessageChoice('Install');
      window._setErrorMessageChoice('Install Python');
      await promptIfMissing(makeContext() as any);
      assert.strictEqual(tasks._executed.length, 0);
      const message = window._messages.find(m => m.includes('needs Python 3.10+ with pip'));
      assert.ok(message, JSON.stringify(window._messages));
      // Names the command the makefiles run, not the button's label
      assert.ok(message.includes(`as "python" on your PATH`), message);
      assert.ok(message.includes(`"python -m ${R65_MODULE}"`), message);
      assert.deepStrictEqual(env._opened.map(u => u.path), [PYTHON_DOWNLOAD_URL]);
    });

    it('checks on the first R65 document opened', async () => {
      const context = makeContext();
      registerToolchainCheck(context as any);
      assert.strictEqual(window._warnings.length, 0);
      workspace._openDocument({ languageId: 'c' });
      workspace._openDocument({ languageId: 'r65' });
      workspace._openDocument({ languageId: 'r65' });
      await new Promise(resolve => setImmediate(resolve));
      assert.strictEqual(window._warnings.length, 1);
    });
  });
}
