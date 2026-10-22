import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { workspace, window, tasks, env } from './vscode-mock';
import { findOnPath } from '../findOnPath';
import {
  checkToolchain, installPlan, isWindowsStoreStub, promptIfMissing, registerToolchainCheck,
  DISMISSED_KEY, PYTHON_DOWNLOAD_URL, R65_PIP_SOURCE, SETUP_DOCS_URL,
} from '../toolchainSetup';

const NOTHING = { r65c: false, wla: false };

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

describe('installPlan', () => {
  it('runs the setup guide commands with brew and pipx', () => {
    const plan = installPlan(NOTHING, { brew: '/opt/homebrew/bin/brew', pipx: '/usr/bin/pipx' });
    assert.deepStrictEqual(plan.steps.map(s => [s.command, ...s.args]), [
      ['/opt/homebrew/bin/brew', 'install', 'wla-dx'],
      ['/usr/bin/pipx', 'install', 'git+https://github.com/BubbleZapGames/R65.git@release'],
    ]);
    assert.strictEqual(plan.needsManualWla, false);
    assert.strictEqual(plan.needsPython, false);
  });

  it('falls back to pip --user, and a WLA-DX download, without pipx or brew', () => {
    const plan = installPlan(NOTHING, { python: '/usr/bin/python3', hasPip: true });
    assert.deepStrictEqual(plan.steps.map(s => [s.command, ...s.args]), [
      ['/usr/bin/python3', '-m', 'pip', 'install', '--user', R65_PIP_SOURCE],
    ]);
    assert.strictEqual(plan.needsManualWla, true);
  });

  it('uses the py launcher on Windows', () => {
    const plan = installPlan({ r65c: false, wla: true }, { python: 'C:\\Windows\\py.exe', hasPip: true });
    assert.deepStrictEqual(plan.steps[0].args, ['-m', 'pip', 'install', '--user', R65_PIP_SOURCE]);
    assert.strictEqual(plan.steps[0].command, 'C:\\Windows\\py.exe');
  });

  it('leaves out --user in a virtualenv', () => {
    const plan = installPlan({ r65c: false, wla: true }, { python: '/venv/bin/python3', hasPip: true, inVirtualEnv: true });
    assert.deepStrictEqual(plan.steps[0].args, ['-m', 'pip', 'install', R65_PIP_SOURCE]);
  });

  it('installs only what is missing', () => {
    const installers = { brew: 'brew', pipx: 'pipx' };
    assert.deepStrictEqual(installPlan({ r65c: true, wla: false }, installers).steps.map(s => s.label), ['WLA-DX']);
    assert.deepStrictEqual(installPlan({ r65c: false, wla: true }, installers).steps.map(s => s.label), ['R65']);
    assert.deepStrictEqual(installPlan({ r65c: true, wla: true }, installers).steps, []);
  });

  it('asks for Python when there is nothing to run pip with', () => {
    const plan = installPlan({ r65c: false, wla: true }, {});
    assert.deepStrictEqual(plan.steps, []);
    assert.strictEqual(plan.needsPython, true);
  });

  it('asks for Python when its python has no pip', () => {
    const plan = installPlan({ r65c: false, wla: true }, { python: '/usr/bin/python3', hasPip: false });
    assert.deepStrictEqual(plan.steps, []);
    assert.strictEqual(plan.needsPython, true);
  });

  it('passes over the Microsoft Store python placeholder', () => {
    assert.ok(isWindowsStoreStub('C:\\Users\\x\\AppData\\Local\\Microsoft\\WindowsApps\\python.exe'));
    assert.ok(!isWindowsStoreStub('C:\\Python312\\python.exe'));
  });
});

describe('findOnPath', () => {
  const savedPath = process.env.PATH;
  afterEach(() => { process.env.PATH = savedPath; });

  it('finds a file in a PATH directory', () => {
    const dir = fakePath(['r65c']);
    assert.strictEqual(findOnPath('r65c'), path.join(dir, 'r65c'));
    assert.strictEqual(findOnPath('wlalink'), undefined);
  });

  it('tries PATHEXT extensions on Windows', () => {
    const dir = fakePath(['mesen-gdb.EXE']);
    const found = findOnPath('mesen-gdb', { Path: dir, PATHEXT: '.COM;.EXE' }, 'win32');
    assert.strictEqual(found, path.join(dir, 'mesen-gdb.EXE'));
  });

  it('ignores a directory with the name', () => {
    const dir = fakePath([]);
    fs.mkdirSync(path.join(dir, 'r65c'));
    assert.strictEqual(findOnPath('r65c'), undefined);
  });
});

describe('checkToolchain', () => {
  const savedPath = process.env.PATH;
  beforeEach(() => workspace._reset());
  afterEach(() => { process.env.PATH = savedPath; });

  it('needs both WLA-DX tools', () => {
    fakePath(['r65c', 'wla-65816']);
    assert.deepStrictEqual(checkToolchain(), { r65c: true, wla: false });
    fs.writeFileSync(path.join(process.env.PATH!, 'wlalink'), '');
    assert.deepStrictEqual(checkToolchain(), { r65c: true, wla: true });
  });

  it('takes r65.compilerPath as an absolute path', () => {
    const dir = fakePath([]);
    const compiler = path.join(dir, 'my-r65c');
    workspace._setConfig('r65.compilerPath', compiler);
    assert.strictEqual(checkToolchain().r65c, false);
    fs.writeFileSync(compiler, '');
    assert.strictEqual(checkToolchain().r65c, true);
  });
});

describe('toolchain prompt', () => {
  const savedPath = process.env.PATH;
  beforeEach(() => {
    workspace._reset();
    window._reset();
    tasks._reset();
    env._reset();
    fakePath([]);
  });
  afterEach(() => { process.env.PATH = savedPath; });

  it('names what is missing', async () => {
    await promptIfMissing(makeContext() as any);
    assert.strictEqual(window._warnings.length, 1);
    assert.ok(window._warnings[0].msg.includes('r65c'));
    assert.ok(window._warnings[0].msg.includes('WLA-DX'));
    assert.deepStrictEqual(window._warnings[0].items, ['Install', 'Setup Guide', "Don't Ask Again"]);
  });

  it('stays quiet when everything is installed', async () => {
    fakePath(['r65c', 'wla-65816', 'wlalink']);
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

  it('runs the R65 install in a terminal task', async () => {
    // Only r65c missing, with pipx to install it
    const dir = fakePath(['wla-65816', 'wlalink', 'pipx']);
    window._setWarningMessageChoice('Install');
    await promptIfMissing(makeContext() as any);
    assert.strictEqual(tasks._executed.length, 1);
    const execution = tasks._executed[0].execution;
    assert.strictEqual(execution.command, path.join(dir, 'pipx'));
    assert.deepStrictEqual(execution.args, ['install', 'git+https://github.com/BubbleZapGames/R65.git@release']);
  });

  it('reports a failed install', async () => {
    fakePath(['wla-65816', 'wlalink', 'pipx']);
    tasks._setExitCode(1);
    window._setWarningMessageChoice('Install');
    await promptIfMissing(makeContext() as any);
    assert.ok(window._messages.some(m => m.includes('Installing R65 failed')));
  });

  it('keeps installing after a failed step, and reports each failure', async () => {
    fakePath(['brew', 'pipx']);
    tasks._setExitCode(1);
    window._setWarningMessageChoice('Install');
    await promptIfMissing(makeContext() as any);
    assert.deepStrictEqual(tasks._executed.map(t => t.name), ['install WLA-DX', 'install R65']);
    assert.ok(window._messages.some(m => m.includes('Installing WLA-DX and R65 failed')));
  });

  if (process.platform !== 'win32') {
    it('sends a Python without pip to python.org', async () => {
      // A python3 whose `-m pip --version` fails
      const dir = fakePath(['wla-65816', 'wlalink']);
      fs.writeFileSync(path.join(dir, 'python3'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
      window._setWarningMessageChoice('Install');
      window._setErrorMessageChoice('Install Python');
      await promptIfMissing(makeContext() as any);
      assert.strictEqual(tasks._executed.length, 0);
      assert.ok(window._messages.some(m => m.includes('needs Python 3.10+ with pip')));
      assert.deepStrictEqual(env._opened.map(u => u.path), [PYTHON_DOWNLOAD_URL]);
    });
  }

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
