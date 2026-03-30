import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

// Test the package.json configuration schema for correctness
describe('package.json', () => {
  let pkg: any;

  before(() => {
    const pkgPath = path.resolve(__dirname, '..', '..', 'package.json');
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  });

  it('should have correct extension name', () => {
    assert.strictEqual(pkg.name, 'xretrocode-debug');
  });

  it('should define a debugger contribution', () => {
    assert.ok(pkg.contributes);
    assert.ok(pkg.contributes.debuggers);
    assert.strictEqual(pkg.contributes.debuggers.length, 1);
  });

  describe('debugger contribution', () => {
    let debugger_: any;

    before(() => {
      debugger_ = pkg.contributes.debuggers[0];
    });

    it('should have type "xretrocode"', () => {
      assert.strictEqual(debugger_.type, 'xretrocode');
    });

    it('should require romPath in launch config', () => {
      const launch = debugger_.configurationAttributes.launch;
      assert.ok(launch.required.includes('romPath'));
    });

    it('should define romPath as string', () => {
      const props = debugger_.configurationAttributes.launch.properties;
      assert.strictEqual(props.romPath.type, 'string');
    });

    it('should define stopOnEntry as boolean with default true', () => {
      const props = debugger_.configurationAttributes.launch.properties;
      assert.strictEqual(props.stopOnEntry.type, 'boolean');
      assert.strictEqual(props.stopOnEntry.default, true);
    });

    it('should define mesenDapPath as optional string', () => {
      const props = debugger_.configurationAttributes.launch.properties;
      assert.ok(props.mesenDapPath);
      assert.strictEqual(props.mesenDapPath.type, 'string');
    });

    it('should have an initial configuration', () => {
      assert.ok(debugger_.initialConfigurations);
      assert.ok(debugger_.initialConfigurations.length > 0);
      assert.strictEqual(debugger_.initialConfigurations[0].type, 'xretrocode');
      assert.strictEqual(debugger_.initialConfigurations[0].request, 'launch');
    });
  });

  describe('configuration settings', () => {
    it('should define xretrocode.mesenDapPath setting', () => {
      const props = pkg.contributes.configuration.properties;
      assert.ok(props['xretrocode.mesenDapPath']);
      assert.strictEqual(props['xretrocode.mesenDapPath'].type, 'string');
    });
  });

  describe('scripts', () => {
    it('should have compile script', () => {
      assert.ok(pkg.scripts.compile);
    });

    it('should have test script', () => {
      assert.ok(pkg.scripts.test);
    });
  });
});
