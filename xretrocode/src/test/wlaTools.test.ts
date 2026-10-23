import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  WLA_DOWNLOAD, WLA_WIN64_SHA256, WLA_WIN64_URL, applyToolPath, buildEnv, downloadWla, initWlaTools, managedWlaDir,
  setExtraDirs, sha256, wlaDirs,
} from '../wlaTools';

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `xretrocode-${prefix}-`));
}

/** An extension context with its own storage, and a PATH collection that records what it's told */
function fakeContext() {
  const collection = {
    prepended: new Map<string, string>(),
    prepend(variable: string, value: string) { this.prepended.set(variable, value); },
    delete(variable: string) { this.prepended.delete(variable); },
  };
  const storage = tempDir('storage');
  return { globalStorageUri: { fsPath: storage }, environmentVariableCollection: collection, storage, collection };
}

function writeTools(dir: string, ext: string) {
  fs.mkdirSync(dir, { recursive: true });
  for (const tool of ['wla-65816', 'wlalink']) fs.writeFileSync(path.join(dir, tool + ext), '');
}

describe('wlaTools', () => {
  const savedPath = process.env.PATH;
  let context: ReturnType<typeof fakeContext>;
  beforeEach(() => {
    process.env.PATH = tempDir('path');
    setExtraDirs([]);
    context = fakeContext();
    initWlaTools(context as any);
  });
  afterEach(() => {
    process.env.PATH = savedPath;
    setExtraDirs(undefined);
    // Leave no WLA-DX behind for other suites
    initWlaTools(fakeContext() as any);
  });

  it('adds nothing while WLA-DX is nowhere, or already on PATH', () => {
    assert.deepStrictEqual(wlaDirs(), []);
    writeTools(process.env.PATH!, '');
    writeTools(managedWlaDir()!, process.platform === 'win32' ? '.exe' : '');
    assert.deepStrictEqual(wlaDirs(), []);
  });

  it('puts the downloaded WLA-DX on PATH: in new terminals, and in builds', () => {
    const managed = managedWlaDir()!;
    assert.ok(managed.startsWith(context.storage), managed);
    writeTools(managed, '.exe');
    assert.deepStrictEqual(wlaDirs({ Path: process.env.PATH, PATHEXT: '.exe' }, 'win32'), [managed]);

    writeTools(managed, process.platform === 'win32' ? '.exe' : '');
    applyToolPath();
    assert.strictEqual(context.collection.prepended.get('PATH'), managed + path.delimiter);
    assert.deepStrictEqual(buildEnv({ Path: 'C:\\Windows' }), { Path: [managed, 'C:\\Windows'].join(path.delimiter) });
  });

  it('uses Homebrew\'s folder when VS Code\'s PATH lacks it', function () {
    if (process.platform === 'win32') this.skip();
    const brew = tempDir('brew');
    setExtraDirs(['/nonexistent', brew]);
    assert.deepStrictEqual(wlaDirs(), []);
    writeTools(brew, '');
    assert.deepStrictEqual(wlaDirs(), [brew]);
    applyToolPath();
    assert.deepStrictEqual(buildEnv({ PATH: '/usr/bin' }), { PATH: `${brew}:/usr/bin` });
  });

  it('takes PATH back out when nothing needs adding', () => {
    context.collection.prepended.set('PATH', 'stale');
    applyToolPath();
    assert.strictEqual(context.collection.prepended.has('PATH'), false);
    assert.strictEqual(buildEnv(), undefined);
  });

  describe('downloadWla', () => {
    /** The release as `body`: fetch writes it, extract unpacks the two tools */
    function release(body: Buffer, sha = sha256(body)) {
      const calls: string[] = [];
      return {
        calls,
        download: {
          url: WLA_WIN64_URL,
          sha256: sha,
          fetch: async (url: string, dest: string) => { calls.push(`fetch ${url}`); fs.writeFileSync(dest, body); },
          extract: async (zip: string, dir: string) => {
            calls.push(`extract ${path.basename(zip)}`);
            writeTools(path.join(dir, path.basename(zip, '.zip')), '.exe');
          },
        },
      };
    }

    it('pins the official v10.7 Windows release', () => {
      assert.strictEqual(WLA_DOWNLOAD.url, 'https://github.com/vhelin/wla-dx/releases/download/v10.7/wla_dx_v10.7_Win64.zip');
      assert.strictEqual(WLA_DOWNLOAD.sha256, WLA_WIN64_SHA256);
    });

    it('fetches the release, checks it, unpacks it and deletes the zip', async () => {
      const { calls, download } = release(Buffer.from('release'));
      await downloadWla(download);

      assert.deepStrictEqual(calls, [`fetch ${WLA_WIN64_URL}`, 'extract wla_dx_v10.7_Win64.zip']);
      const parent = path.dirname(managedWlaDir()!);
      assert.deepStrictEqual(fs.readdirSync(parent).filter(f => f.endsWith('.zip')), [], 'zip left behind');
      assert.ok(fs.existsSync(path.join(managedWlaDir()!, 'wlalink.exe')));
    });

    it('refuses a download that isn\'t the release, and deletes it', async () => {
      const { calls, download } = release(Buffer.from('something else'), WLA_WIN64_SHA256);
      await assert.rejects(downloadWla(download), /isn't the WLA-DX v10\.7 release/);
      assert.deepStrictEqual(calls, [`fetch ${WLA_WIN64_URL}`]);
      assert.deepStrictEqual(fs.readdirSync(path.dirname(managedWlaDir()!)), []);
    });
  });
});
