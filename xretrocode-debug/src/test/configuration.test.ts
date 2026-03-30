import * as assert from 'assert';
import { window } from './vscode-mock';
import { ConfigurationProvider } from '../configuration';

describe('ConfigurationProvider', () => {
  let provider: ConfigurationProvider;

  beforeEach(() => {
    provider = new ConfigurationProvider();
    window._reset();
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
    it('should accept config with romPath', () => {
      const config = {
        name: 'Test', type: 'xretrocode', request: 'launch',
        romPath: '/path/to/game.sfc', stopOnEntry: true
      };
      const result = provider.resolveDebugConfiguration(undefined, config) as any;
      assert.ok(result);
      assert.strictEqual(result.romPath, '/path/to/game.sfc');
    });

    it('should reject config without romPath', () => {
      const config = {
        name: 'Test', type: 'xretrocode', request: 'launch',
        romPath: '', stopOnEntry: true
      };
      const result = provider.resolveDebugConfiguration(undefined, config);
      assert.strictEqual(result, null);
    });

    it('should show error message when romPath missing', () => {
      provider.resolveDebugConfiguration(undefined, {
        name: 'Test', type: 'xretrocode', request: 'launch', romPath: ''
      });
      assert.ok(window._messages.length > 0);
      assert.ok(window._messages[0].toLowerCase().includes('rom'));
    });

    it('should preserve all config properties', () => {
      const config = {
        name: 'Test', type: 'xretrocode', request: 'launch',
        romPath: '/game.sfc', stopOnEntry: false,
        dbgPath: '/symbols.dbg', mesenDapPath: '/usr/bin/mesen-gdb'
      };
      const result = provider.resolveDebugConfiguration(undefined, config) as any;
      assert.ok(result);
      assert.strictEqual(result.stopOnEntry, false);
      assert.strictEqual(result.dbgPath, '/symbols.dbg');
      assert.strictEqual(result.mesenDapPath, '/usr/bin/mesen-gdb');
    });
  });
});
