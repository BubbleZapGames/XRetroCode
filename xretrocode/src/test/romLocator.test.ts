import * as assert from 'assert';
import { workspace, window, env, Uri } from './vscode-mock';
import { findRoms, pickRom, ROM_EXTENSIONS } from '../romLocator';
import { ConfigurationProvider } from '../debugConfiguration';
import { locateMesenGdb, setExtensionPath, MESEN_BINARY_NAME, MESEN_RELEASES_URL } from '../debugAdapter';
import * as path from 'path';
import * as fs from 'fs';

describe('ROM locator', () => {
  beforeEach(() => {
    workspace._reset();
    window._reset();
    // Adapter binary resolution is covered separately; keep it satisfied here
    workspace._setConfig('xretrocode.mesenDapPath', '/usr/bin/mesen-gdb');
  });

  it('should recognise ROM extensions for every supported console', () => {
    for (const ext of ['sfc', 'smc', 'nes', 'gb', 'gba', 'pce', 'sms', 'ws']) {
      assert.ok(ROM_EXTENSIONS.includes(ext), `missing ${ext}`);
    }
  });

  it('should find ROMs in the workspace', async () => {
    workspace._setFileContent('/test/build/game.sfc', '');
    workspace._setFileContent('/test/src/main.r65', '');
    const roms = await findRoms();
    assert.strictEqual(roms.length, 1);
    assert.ok(roms[0].fsPath.endsWith('game.sfc'));
  });

  it('should list build outputs before other ROMs', async () => {
    workspace._setFileContent('/test/spare/old.sfc', '');
    workspace._setFileContent('/test/build/fresh.sfc', '');
    const roms = await findRoms();
    assert.ok(roms[0].fsPath.endsWith('fresh.sfc'), 'build/ output should sort first');
  });

  it('should auto-select when the workspace holds exactly one ROM', async () => {
    workspace._setFileContent('/test/build/game.sfc', '');
    const picked = await pickRom({ autoSelectSingle: true });
    assert.strictEqual(picked, '/test/build/game.sfc');
    assert.strictEqual(window._quickPickCalls.length, 0, 'should not prompt for a single ROM');
  });

  it('should offer a quick pick when several ROMs exist', async () => {
    workspace._setFileContent('/test/build/a.sfc', '');
    workspace._setFileContent('/test/build/b.nes', '');
    window._setQuickPickResult({ label: 'b.nes', path: '/test/build/b.nes' });
    const picked = await pickRom({ autoSelectSingle: true });
    assert.strictEqual(picked, '/test/build/b.nes');
    assert.strictEqual(window._quickPickCalls.length, 1);
    // 2 ROMs + a Browse entry
    assert.strictEqual(window._quickPickCalls[0].length, 3);
  });

  it('should fall back to a file dialog when no ROM is in the workspace', async () => {
    window._setOpenDialogResult([Uri.file('/elsewhere/game.gba')]);
    const picked = await pickRom({ autoSelectSingle: true });
    assert.strictEqual(picked, '/elsewhere/game.gba');
    assert.strictEqual(window._openDialogCalls.length, 1);
  });

  it('should return undefined when the user cancels the dialog', async () => {
    window._setOpenDialogResult(undefined);
    assert.strictEqual(await pickRom(), undefined);
  });

  it('should open the dialog when Browse is chosen from the quick pick', async () => {
    workspace._setFileContent('/test/build/a.sfc', '');
    workspace._setFileContent('/test/build/b.sfc', '');
    window._setQuickPickResult({ label: 'Browse', path: '' });
    window._setOpenDialogResult([Uri.file('/elsewhere/other.smc')]);
    assert.strictEqual(await pickRom(), '/elsewhere/other.smc');
  });
});

describe('ConfigurationProvider ROM resolution', () => {
  beforeEach(() => {
    workspace._reset();
    window._reset();
    workspace._setConfig('xretrocode.mesenDapPath', '/usr/bin/mesen-gdb');
  });

  it('should fill in romPath from the workspace instead of erroring', async () => {
    workspace._setFileContent('/test/build/game.sfc', '');
    const provider = new ConfigurationProvider();
    const result = await provider.resolveDebugConfiguration(undefined, {
      name: 'Launch ROM', type: 'xretrocode', request: 'launch', romPath: ''
    } as any);
    assert.ok(result);
    assert.strictEqual((result as any).romPath, '/test/build/game.sfc');
    assert.strictEqual(window._messages.length, 0, 'no error popup should be shown');
  });

  it('should abort quietly when the user cancels', async () => {
    window._setOpenDialogResult(undefined);
    const provider = new ConfigurationProvider();
    const result = await provider.resolveDebugConfiguration(undefined, {
      name: 'Launch ROM', type: 'xretrocode', request: 'launch', romPath: ''
    } as any);
    assert.strictEqual(result, undefined);
    assert.strictEqual(window._messages.length, 0);
  });

  it('should keep an explicit romPath untouched', async () => {
    workspace._setFileContent('/test/build/other.sfc', '');
    const provider = new ConfigurationProvider();
    const result = await provider.resolveDebugConfiguration(undefined, {
      name: 'Launch ROM', type: 'xretrocode', request: 'launch',
      romPath: '/my/game.sfc', dbgPath: '/my/game.dbg'
    } as any);
    assert.strictEqual((result as any).romPath, '/my/game.sfc');
    assert.strictEqual((result as any).dbgPath, '/my/game.dbg');
  });

  it('should complete a bare F5 config that has no type', async () => {
    workspace._setFileContent('/test/build/game.sfc', '');
    const provider = new ConfigurationProvider();
    const result = await provider.resolveDebugConfiguration(undefined, {} as any) as any;
    assert.strictEqual(result.type, 'xretrocode');
    assert.strictEqual(result.request, 'launch');
    assert.strictEqual(result.stopOnEntry, true);
    assert.strictEqual(result.romPath, '/test/build/game.sfc');
  });

  it('should offer pickRom as the default launch.json romPath', () => {
    const provider = new ConfigurationProvider();
    const configs = provider.provideDebugConfigurations(undefined) as any[];
    assert.strictEqual(configs[0].romPath, '${command:xretrocode.pickRom}');
  });
});

describe('Adapter binary resolution', () => {
  beforeEach(() => {
    workspace._reset();
    window._reset();
  });

  it('should prompt and remember the binary when it cannot be found', async () => {
    window._setErrorMessageChoice('Locate mesen-gdb...');
    window._setOpenDialogResult([Uri.file('/opt/mesen/mesen-gdb')]);
    workspace._setFileContent('/test/build/game.sfc', '');

    const provider = new ConfigurationProvider();
    const result = await provider.resolveDebugConfiguration(undefined, {
      name: 'Launch ROM', type: 'xretrocode', request: 'launch', romPath: '/test/build/game.sfc'
    } as any) as any;

    assert.ok(result);
    assert.strictEqual(result.mesenDapPath, '/opt/mesen/mesen-gdb');
    // Saved globally so the prompt only ever appears once
    const saved = workspace._updates.find(u => u.key === 'xretrocode.mesenDapPath');
    assert.ok(saved, 'the chosen path should be written to settings');
    assert.strictEqual(saved!.value, '/opt/mesen/mesen-gdb');
  });

  it('should abort when the user dismisses the missing-binary prompt', async () => {
    window._setErrorMessageChoice(undefined);
    const provider = new ConfigurationProvider();
    const result = await provider.resolveDebugConfiguration(undefined, {
      name: 'Launch ROM', type: 'xretrocode', request: 'launch', romPath: '/test/build/game.sfc'
    } as any);
    assert.strictEqual(result, undefined);
    assert.ok(window._messages.some(m => m.includes('mesen-gdb')));
  });

  it('should open the releases page and stop the launch when asked to download', async () => {
    env._reset();
    window._setErrorMessageChoice('Download mesen-gdb');
    const provider = new ConfigurationProvider();
    const result = await provider.resolveDebugConfiguration(undefined, {
      name: 'Launch ROM', type: 'xretrocode', request: 'launch', romPath: '/test/build/game.sfc'
    } as any);
    assert.strictEqual(result, undefined, 'nothing to launch until the binary is installed');
    assert.deepStrictEqual(env._opened.map(u => u.path), [MESEN_RELEASES_URL]);
    assert.strictEqual(window._openDialogCalls.length, 0, 'no file picker for a download');
    assert.strictEqual(workspace._updates.length, 0, 'nothing saved to settings');
  });

  it('should not prompt when mesenDapPath is already set', async () => {
    workspace._setConfig('xretrocode.mesenDapPath', '/usr/bin/mesen-gdb');
    const provider = new ConfigurationProvider();
    const result = await provider.resolveDebugConfiguration(undefined, {
      name: 'Launch ROM', type: 'xretrocode', request: 'launch', romPath: '/test/build/game.sfc'
    } as any) as any;
    assert.ok(result);
    assert.strictEqual(window._messages.length, 0);
  });
});

describe('Binary discovery', () => {
  beforeEach(() => {
    workspace._reset();
    window._reset();
    setExtensionPath(undefined);
  });
  afterEach(() => setExtensionPath(undefined));

  it('should find the sibling Mesen-GDB build from the extension location', () => {
    // In a repo checkout the layout is <repo>/xretrocode and <repo>/Mesen-GDB
    const extDir = path.resolve(__dirname, '..', '..');
    const release = path.join(path.dirname(extDir), 'Mesen-GDB', 'bin', 'linux-x64', 'Release', MESEN_BINARY_NAME);

    setExtensionPath(extDir);
    const found = locateMesenGdb();

    if (fs.existsSync(release)) {
      assert.strictEqual(found, release,
        'a built binary beside the extension must be found without any setting');
    } else {
      // No build present; discovery must not invent a path
      assert.ok(found === undefined || fs.existsSync(found));
    }
  });

  it('should not depend on the debugged game being the XRetroCode workspace', () => {
    const extDir = path.resolve(__dirname, '..', '..');
    const release = path.join(path.dirname(extDir), 'Mesen-GDB', 'bin', 'linux-x64', 'Release', MESEN_BINARY_NAME);
    if (!fs.existsSync(release)) return;

    // Workspace is some unrelated game project
    workspace._setWorkspaceFolders([{ uri: { fsPath: '/some/other/game' } }]);
    setExtensionPath(extDir);
    assert.strictEqual(locateMesenGdb(), release);
  });

  it('should prefer an explicit setting over anything discovered', () => {
    setExtensionPath(path.resolve(__dirname, '..', '..'));
    workspace._setConfig('xretrocode.mesenDapPath', '/explicit/mesen-gdb');
    assert.strictEqual(locateMesenGdb(), '/explicit/mesen-gdb');
  });

  it('should prefer a launch.json override over the setting', () => {
    workspace._setConfig('xretrocode.mesenDapPath', '/setting/mesen-gdb');
    const session = { configuration: { mesenDapPath: '/launch/mesen-gdb' } } as any;
    assert.strictEqual(locateMesenGdb(session), '/launch/mesen-gdb');
  });

  it('should return undefined when nothing is installed anywhere', () => {
    setExtensionPath('/nonexistent/extension');
    const saved = process.env.PATH;
    process.env.PATH = '/nonexistent/bin';
    try {
      assert.strictEqual(locateMesenGdb(), undefined);
    } finally {
      process.env.PATH = saved;
    }
  });
});
