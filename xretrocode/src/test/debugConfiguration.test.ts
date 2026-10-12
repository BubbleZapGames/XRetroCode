import * as assert from 'assert';
import { window, workspace, tasks, Uri } from './vscode-mock';
import { ConfigurationProvider } from '../debugConfiguration';

describe('ConfigurationProvider', () => {
  let provider: ConfigurationProvider;

  beforeEach(() => {
    provider = new ConfigurationProvider();
    window._reset();
    workspace._reset();
    // Adapter binary resolution is covered separately; keep it satisfied here
    workspace._setConfig('xretrocode.mesenDapPath', '/usr/bin/mesen-gdb');
  });

  describe('provideDebugConfigurations', () => {
    it('should return a default SNES launch config', () => {
      const configs = provider.provideDebugConfigurations(undefined) as any[];
      assert.ok(Array.isArray(configs));
      assert.strictEqual(configs.length, 1);
      assert.strictEqual(configs[0].type, 'xretrocode');
      assert.strictEqual(configs[0].request, 'launch');
      assert.strictEqual(configs[0].stopOnEntry, true);
    });

    it('should include romPath in default config', () => {
      const configs = provider.provideDebugConfigurations(undefined) as any[];
      assert.ok('romPath' in configs[0]);
    });
  });

  describe('resolveDebugConfiguration', () => {
    it('should accept a config that already has romPath', async () => {
      const config = {
        name: 'Test', type: 'xretrocode', request: 'launch',
        romPath: '/path/to/game.sfc', stopOnEntry: true
      };
      const result = await provider.resolveDebugConfiguration(undefined, config as any) as any;
      assert.ok(result);
      assert.strictEqual(result.romPath, '/path/to/game.sfc');
    });

    it('should abort quietly when romPath is missing and the user cancels', async () => {
      // No ROMs in the workspace and a cancelled file dialog
      window._setOpenDialogResult(undefined);
      const config = {
        name: 'Test', type: 'xretrocode', request: 'launch',
        romPath: '', stopOnEntry: true
      };
      const result = await provider.resolveDebugConfiguration(undefined, config as any);
      assert.strictEqual(result, undefined);
    });

    it('should not show an error popup when romPath is missing', async () => {
      window._setOpenDialogResult(undefined);
      await provider.resolveDebugConfiguration(undefined, {
        name: 'Test', type: 'xretrocode', request: 'launch', romPath: ''
      } as any);
      assert.strictEqual(window._messages.length, 0,
        'the provider should resolve a ROM rather than scolding the user');
    });

    it('should preserve all config properties', async () => {
      const config = {
        name: 'Test', type: 'xretrocode', request: 'launch',
        romPath: '/game.sfc', stopOnEntry: false,
        dbgPath: '/symbols.dbg', mesenDapPath: '/usr/bin/mesen-gdb'
      };
      const result = await provider.resolveDebugConfiguration(undefined, config as any) as any;
      assert.ok(result);
      assert.strictEqual(result.stopOnEntry, false);
      assert.strictEqual(result.dbgPath, '/symbols.dbg');
      assert.strictEqual(result.mesenDapPath, '/usr/bin/mesen-gdb');
    });
  });

  describe('build before launch', () => {
    const FOLDER = { uri: Uri.file('/proj'), name: 'proj', index: 0 } as any;

    beforeEach(() => {
      tasks._reset();
      workspace._setWorkspaceFolders([FOLDER]);
      workspace._setFileContent('/proj/Makefile', 'all: build/GAME.smc\n');
      workspace._setFileContent('/proj/build/GAME.smc', 'rom');
    });

    it('should run make before looking for the ROM', async () => {
      const result = await provider.resolveDebugConfiguration(FOLDER, {
        name: 'Test', type: 'xretrocode', request: 'launch', romPath: ''
      } as any) as any;
      assert.ok(result);
      assert.strictEqual(tasks._executed.length, 1, 'the ROM build should have run');
      assert.strictEqual(tasks._executed[0].execution.command, 'make');
      assert.strictEqual(result.romPath, '/proj/build/GAME.smc');
    });

    // The build has to finish first: the ROM does not exist on a clean tree, so
    // a preLaunchTask would run too late for the lookup above to see it.
    it('should not defer the build to a preLaunchTask', async () => {
      const result = await provider.resolveDebugConfiguration(FOLDER, {
        name: 'Test', type: 'xretrocode', request: 'launch', romPath: '/game.sfc'
      } as any) as any;
      assert.strictEqual(result.preLaunchTask, undefined);
    });

    it('should build even when romPath is already set', async () => {
      await provider.resolveDebugConfiguration(FOLDER, {
        name: 'Test', type: 'xretrocode', request: 'launch', romPath: '/game.sfc'
      } as any);
      assert.strictEqual(tasks._executed.length, 1);
    });

    it('should skip the build when the folder has no makefile', async () => {
      workspace._reset();
      workspace._setConfig('xretrocode.mesenDapPath', '/usr/bin/mesen-gdb');
      workspace._setWorkspaceFolders([FOLDER]);
      workspace._setFileContent('/proj/build/GAME.smc', 'rom');
      await provider.resolveDebugConfiguration(FOLDER, {
        name: 'Test', type: 'xretrocode', request: 'launch', romPath: '/game.sfc'
      } as any);
      assert.strictEqual(tasks._executed.length, 0);
    });

    it('should skip the build when buildBeforeLaunch is off', async () => {
      workspace._setConfig('xretrocode.buildBeforeLaunch', false);
      await provider.resolveDebugConfiguration(FOLDER, {
        name: 'Test', type: 'xretrocode', request: 'launch', romPath: '/game.sfc'
      } as any);
      assert.strictEqual(tasks._executed.length, 0);
    });

    it('should abort the launch when the build fails', async () => {
      tasks._setExitCode(2);
      window._setErrorMessageChoice(undefined);
      const result = await provider.resolveDebugConfiguration(FOLDER, {
        name: 'Test', type: 'xretrocode', request: 'launch', romPath: '/game.sfc'
      } as any);
      assert.strictEqual(result, undefined);
      assert.strictEqual(window._messages.length, 1);
    });

    it('should launch anyway when the user says so after a failed build', async () => {
      tasks._setExitCode(2);
      window._setErrorMessageChoice('Debug Anyway');
      const result = await provider.resolveDebugConfiguration(FOLDER, {
        name: 'Test', type: 'xretrocode', request: 'launch', romPath: '/game.sfc'
      } as any) as any;
      assert.ok(result);
      assert.strictEqual(result.romPath, '/game.sfc');
    });

    it('should stay quiet when the build succeeds', async () => {
      await provider.resolveDebugConfiguration(FOLDER, {
        name: 'Test', type: 'xretrocode', request: 'launch', romPath: '/game.sfc'
      } as any);
      assert.strictEqual(window._messages.length, 0);
    });
  });
});
