import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import { workspace } from './vscode-mock';

const BINARY = 'mesen-gdb';
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

    it('should prefer a per-launch mesenDapPath from launch.json', () => {
      workspace._setConfig('xretrocode.mesenDapPath', '/setting/mesen-gdb');
      const session = { configuration: { mesenDapPath: '/launch/mesen-gdb' } } as any;
      const result = factory.createDebugAdapterDescriptor(session, undefined) as any;
      assert.strictEqual(result.command, '/launch/mesen-gdb');
    });

    it('should find a Release build in the workspace', () => {
      const wsPath = path.resolve(__dirname, '..', '..', '..');
      const release = path.join(wsPath, 'Mesen-GDB', 'bin', 'linux-x64', 'Release', BINARY);
      workspace._setWorkspaceFolders([{ uri: { fsPath: wsPath } }]);
      const result = factory.createDebugAdapterDescriptor({} as any, undefined) as any;

      if (fs.existsSync(release)) {
        assert.strictEqual(result.command, release,
          'a Release build must be picked up without any configuration');
      } else {
        assert.ok(result.command);
      }
    });

  });
});
