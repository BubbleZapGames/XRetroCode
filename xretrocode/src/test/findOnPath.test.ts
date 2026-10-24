import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { findOnPath } from '../findOnPath';

describe('findOnPath', () => {
  let root: string;
  let bin: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'xretrocode-path-'));
    bin = path.join(root, 'bin');
    fs.mkdirSync(bin);
  });
  afterEach(() => {
    fs.chmodSync(root, 0o700);
    for (const dir of fs.readdirSync(root)) fs.chmodSync(path.join(root, dir), 0o700);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('finds a file, and passes over folders and links to nothing', () => {
    fs.writeFileSync(path.join(bin, 'tool'), '');
    fs.mkdirSync(path.join(bin, 'folder'));
    // Windows needs Developer Mode or admin for symlinks
    let linked = true;
    try {
      fs.symlinkSync(path.join(root, 'missing'), path.join(bin, 'dangling'));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EPERM') throw e;
      linked = false;
    }
    assert.strictEqual(findOnPath('tool', { PATH: bin }), path.join(bin, 'tool'));
    assert.strictEqual(findOnPath('folder', { PATH: bin }), undefined);
    if (linked) assert.strictEqual(findOnPath('dangling', { PATH: bin }), undefined);
    assert.strictEqual(findOnPath('absent', { PATH: bin }), undefined);
  });

  it('finds a link stat can\'t follow, as with Windows\' WindowsApps\\winget.exe', function () {
    if (process.platform === 'win32' || process.getuid?.() === 0) this.skip();
    // stat answers EACCES through a folder it may not search, as it does for an App Execution Alias
    const locked = path.join(root, 'locked');
    fs.mkdirSync(locked);
    fs.writeFileSync(path.join(locked, 'winget'), '');
    fs.symlinkSync(path.join(locked, 'winget'), path.join(bin, 'winget'));
    fs.chmodSync(locked, 0o000);
    assert.strictEqual(findOnPath('winget', { PATH: bin }, 'linux'), path.join(bin, 'winget'));
  });

  it('skips the candidates it is told to, and keeps looking', () => {
    const later = path.join(root, 'later');
    fs.mkdirSync(later);
    fs.writeFileSync(path.join(bin, 'python'), '');
    fs.writeFileSync(path.join(later, 'python'), '');
    // path.delimiter: a ':' list would split C:\ drive letters on Windows
    const env = { PATH: [bin, later].join(path.delimiter) };
    assert.strictEqual(findOnPath('python', env, process.platform, p => p.startsWith(bin)), path.join(later, 'python'));
  });
});
