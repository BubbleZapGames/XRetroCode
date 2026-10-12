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
// Mesen-GDB's own deterministic test ROM, with its .dbg and source
const ROM_DIR = path.join(REPO_ROOT, 'Mesen-GDB', 'tests', 'roms', 'green');
const ROM_FILES = ['green.sfc', 'green.dbg', 'green.r65'];

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
 * A workspace holding just the ROM, its symbols and its source. No Makefile,
 * so launching never runs a build.
 */
function makeWorkspace(root: string): string {
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(path.join(workspace, '.vscode'), { recursive: true });
  for (const file of ROM_FILES) {
    const from = path.join(ROM_DIR, file);
    if (!fs.existsSync(from)) {
      throw new Error(`missing test ROM file ${from}: run ./setup.sh to fetch the Mesen-GDB submodule`);
    }
    fs.copyFileSync(from, path.join(workspace, file));
  }
  fs.writeFileSync(
    path.join(workspace, '.vscode', 'settings.json'),
    JSON.stringify({ 'xretrocode.buildBeforeLaunch': false }, null, 2)
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
