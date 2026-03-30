import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import { workspace } from './vscode-mock';
import { DebugAdapterDescriptorFactory } from '../debugAdapter';

describe('DebugAdapterDescriptorFactory', () => {
  let factory: DebugAdapterDescriptorFactory;

  beforeEach(() => {
    factory = new DebugAdapterDescriptorFactory();
    workspace._reset();
  });

  describe('createDebugAdapterDescriptor', () => {
    it('should return a descriptor with --dap flag', () => {
      const result = factory.createDebugAdapterDescriptor({} as any, undefined) as any;
      assert.ok(result);
      assert.ok(result.args);
      assert.ok(result.args.includes('--dap'));
    });

    it('should use config path when set', () => {
      workspace._setConfig('xretrocode.mesenDapPath', '/custom/path/mesen-gdb');
      const result = factory.createDebugAdapterDescriptor({} as any, undefined) as any;
      assert.strictEqual(result.command, '/custom/path/mesen-gdb');
    });

    it('should fall back to bare command name when no paths found', () => {
      workspace._setWorkspaceFolders([{ uri: { fsPath: '/nonexistent/workspace' } }]);
      const result = factory.createDebugAdapterDescriptor({} as any, undefined) as any;
      assert.strictEqual(result.command, 'mesen-gdb');
    });

    it('should find binary in workspace if it exists', () => {
      // Point to the actual project directory
      const wsPath = path.resolve(__dirname, '..', '..', '..');
      const expectedPath = path.join(wsPath, 'Mesen-GDB', 'bin', 'linux-x64', 'Debug', 'mesen-gdb');

      workspace._setWorkspaceFolders([{ uri: { fsPath: wsPath } }]);
      const result = factory.createDebugAdapterDescriptor({} as any, undefined) as any;

      if (fs.existsSync(expectedPath)) {
        assert.strictEqual(result.command, expectedPath);
      } else {
        // Binary doesn't exist at Debug path, should still return something
        assert.ok(result.command);
      }
    });
  });
});
