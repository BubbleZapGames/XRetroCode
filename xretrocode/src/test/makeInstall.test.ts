import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { env, tasks, window } from './vscode-mock';
import { WINGET_MAKE_ID, WINGET_URL, ensureMake, findMake, makeCommand } from '../makeInstall';

/** A Windows environment: a PATH folder holding `onPath`, and a LOCALAPPDATA */
function windowsEnv(onPath: string[] = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xretrocode-make-'));
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  for (const name of onPath) fs.writeFileSync(path.join(bin, name), '');
  const localAppData = path.join(root, 'AppData', 'Local');
  const links = path.join(localAppData, 'Microsoft', 'WinGet', 'Links');
  return {
    // Lowercase: Windows matches either case, this test's filesystem doesn't
    vars: { Path: bin, PATHEXT: '.com;.exe', LOCALAPPDATA: localAppData } as NodeJS.ProcessEnv,
    bin,
    links,
    /** What winget leaves behind */
    installMake: () => {
      fs.mkdirSync(links, { recursive: true });
      fs.writeFileSync(path.join(links, 'make.exe'), '');
    },
  };
}

describe('findMake and makeCommand', () => {
  it('runs plain make off Windows', () => {
    assert.strictEqual(makeCommand({ PATH: '' }, 'linux'), 'make');
  });

  it('finds make.exe on the Windows PATH, and runs it by name', () => {
    const win = windowsEnv(['make.exe']);
    assert.strictEqual(findMake(win.vars, 'win32'), path.join(win.bin, 'make.exe'));
    assert.strictEqual(makeCommand(win.vars, 'win32'), 'make');
  });

  it('finds the make winget installed while the PATH VS Code started with lacks it', () => {
    const win = windowsEnv();
    assert.strictEqual(findMake(win.vars, 'win32'), undefined);
    win.installMake();
    const installed = path.join(win.links, 'make.exe');
    assert.strictEqual(findMake(win.vars, 'win32'), installed);
    assert.strictEqual(makeCommand(win.vars, 'win32'), installed);
  });

  // Without Developer Mode winget can't make the Links symlink, and puts the
  // package's own bin folder on the user's PATH instead
  it('finds the make winget left in its package folder', () => {
    const win = windowsEnv();
    const bin = path.join(win.vars.LOCALAPPDATA!, 'Microsoft', 'WinGet', 'Packages',
      `${WINGET_MAKE_ID}_Microsoft.Winget.Source_8wekyb3d8bbwe`, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'make.exe'), '');
    assert.strictEqual(findMake(win.vars, 'win32'), path.join(bin, 'make.exe'));
    assert.strictEqual(makeCommand(win.vars, 'win32'), path.join(bin, 'make.exe'));
  });
});

describe('ensureMake', () => {
  beforeEach(() => {
    window._reset();
    tasks._reset();
    env._reset();
  });

  it('asks for nothing off Windows, or when make is there', async () => {
    assert.strictEqual(await ensureMake({ PATH: '' }, 'linux'), true);
    assert.strictEqual(await ensureMake(windowsEnv(['make.exe']).vars, 'win32'), true);
    assert.strictEqual(window._warnings.length, 0);
  });

  it('installs make with winget, then lets the build go ahead', async () => {
    const win = windowsEnv(['winget.exe']);
    tasks._setOnExecute(() => win.installMake());
    window._setWarningMessageChoice('Install');
    assert.strictEqual(await ensureMake(win.vars, 'win32'), true);

    const prompt = window._warnings[0];
    assert.ok(prompt.msg.includes(`winget install ${WINGET_MAKE_ID}`), prompt.msg);
    assert.deepStrictEqual(prompt.items, [{ modal: true }, 'Install']);
    const execution = tasks._executed[0].execution;
    assert.strictEqual(execution.command, path.join(win.bin, 'winget.exe'));
    assert.deepStrictEqual(execution.args, ['install', WINGET_MAKE_ID]);
  });

  it('cancels the launch when the install is declined', async () => {
    assert.strictEqual(await ensureMake(windowsEnv(['winget.exe']).vars, 'win32'), false);
    assert.strictEqual(tasks._executed.length, 0);
  });

  it('cancels the launch when winget fails', async () => {
    const win = windowsEnv(['winget.exe']);
    tasks._setExitCode(1);
    window._setWarningMessageChoice('Install');
    assert.strictEqual(await ensureMake(win.vars, 'win32'), false);
    assert.ok(window._messages.some(m => m.includes('Installing make failed')), JSON.stringify(window._messages));
  });

  it('asks for a restart when make installed but cannot be found', async () => {
    window._setWarningMessageChoice('Install');
    assert.strictEqual(await ensureMake(windowsEnv(['winget.exe']).vars, 'win32'), false);
    assert.ok(window._messages.some(m => m.includes('Restart VS Code')), JSON.stringify(window._messages));
  });

  it('points to winget when there is none', async () => {
    window._setWarningMessageChoice('Install');
    window._setErrorMessageChoice('Get winget');
    assert.strictEqual(await ensureMake(windowsEnv().vars, 'win32'), false);
    assert.strictEqual(tasks._executed.length, 0);
    assert.deepStrictEqual(env._opened.map(u => u.path), [WINGET_URL]);
  });
});
