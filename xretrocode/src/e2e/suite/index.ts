// Runs inside the VS Code extension host: loads every *.e2e.js beside it.
// The unit tests' vscode mock (out/test/setup.js) is never loaded here.
import * as fs from 'fs';
import * as path from 'path';
import Mocha from 'mocha';

export function run(): Promise<void> {
  const mocha = new Mocha({ ui: 'bdd', timeout: 60_000, color: true });
  for (const file of fs.readdirSync(__dirname)) {
    if (file.endsWith('.e2e.js')) mocha.addFile(path.join(__dirname, file));
  }
  return new Promise((resolve, reject) => {
    mocha.run(failures => {
      if (failures > 0) reject(new Error(`${failures} e2e test(s) failed`));
      else resolve();
    });
  });
}
