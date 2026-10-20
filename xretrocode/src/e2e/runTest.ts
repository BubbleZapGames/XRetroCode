// End-to-end tests: real VS Code, this extension, and a real mesen-gdb.
//
//   npm run test:e2e
//
// VSCODE_EXECUTABLE  use this VS Code (e.g. /usr/share/code/code) instead of
//                    downloading one into .vscode-test/
// MESEN_GDB          the mesen-gdb to debug with; defaults to the sibling
//                    Mesen-GDB build
//
// On a machine without a display, run it under `xvfb-run -a`.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runTests } from '@vscode/test-electron';

const EXTENSION_ROOT = path.resolve(__dirname, '..', '..');
const REPO_ROOT = path.resolve(EXTENSION_ROOT, '..');
// Mesen-GDB's own deterministic test ROMs, with their symbols and source:
// green (R65, SNES) at the workspace root, hello_c (cc65 C, NES) in hello_c/
const TEST_ROMS = path.join(REPO_ROOT, 'Mesen-GDB', 'tests', 'roms');
const ROM_FILES: { dir: string; files: string[]; to: string }[] = [
  { dir: 'green', files: ['green.sfc', 'green.dbg', 'green.sym', 'green.r65'], to: '' },
  { dir: 'hello_c', files: ['hello.nes', 'hello.dbg', 'hello.c'], to: 'hello_c' },
];
// Copied in beside them: stand-in definitions for the stdlib macros green.r65 uses
const FIXTURES = path.join(EXTENSION_ROOT, 'src', 'e2e', 'fixtures');

function findMesenGdb(): string {
  const candidates = [
    process.env.MESEN_GDB,
    path.join(REPO_ROOT, 'Mesen-GDB', 'bin', 'linux-x64', 'Release', 'mesen-gdb'),
    path.join(REPO_ROOT, 'Mesen-GDB', 'bin', 'linux-x64', 'Debug', 'mesen-gdb'),
  ];
  const found = candidates.find(c => c && fs.existsSync(c));
  if (!found) {
    throw new Error('mesen-gdb not found: build it with `make` in Mesen-GDB, or set MESEN_GDB');
  }
  return found;
}

/**
 * A workspace holding just the ROMs, their symbols and their source. No
 * Makefile, so launching never runs a build.
 */
function makeWorkspace(root: string): string {
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(path.join(workspace, '.vscode'), { recursive: true });
  for (const { dir, files, to } of ROM_FILES) {
    fs.mkdirSync(path.join(workspace, to), { recursive: true });
    for (const file of files) {
      const from = path.join(TEST_ROMS, dir, file);
      if (!fs.existsSync(from)) {
        throw new Error(`missing test ROM file ${from}: run ./setup.sh to fetch the Mesen-GDB submodule`);
      }
      fs.copyFileSync(from, path.join(workspace, to, file));
    }
  }
  for (const file of fs.readdirSync(FIXTURES)) {
    fs.copyFileSync(path.join(FIXTURES, file), path.join(workspace, file));
  }
  fs.writeFileSync(
    path.join(workspace, '.vscode', 'settings.json'),
    JSON.stringify({
      'xretrocode.buildBeforeLaunch': false,
      // ROM discovery should find green.sfc alone: a launch with no romPath
      // picks the workspace's only ROM without asking
      'files.exclude': { 'hello_c/*.nes': true },
    }, null, 2)
  );
  return workspace;
}

async function main(): Promise<void> {
  const mesenGdb = findMesenGdb();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xretrocode-e2e-'));
  try {
    const workspace = makeWorkspace(root);
    await runTests({
      vscodeExecutablePath: process.env.VSCODE_EXECUTABLE || undefined,
      extensionDevelopmentPath: EXTENSION_ROOT,
      extensionTestsPath: path.join(__dirname, 'suite', 'index'),
      launchArgs: [
        workspace,
        '--disable-extensions',
        '--disable-workspace-trust',
        '--skip-welcome',
        '--skip-release-notes',
        // Its own profile, so it runs alongside the developer's VS Code
        `--user-data-dir=${path.join(root, 'user-data')}`,
        `--extensions-dir=${path.join(root, 'extensions')}`,
      ],
      extensionTestsEnv: { MESEN_GDB: mesenGdb, E2E_WORKSPACE: workspace },
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
