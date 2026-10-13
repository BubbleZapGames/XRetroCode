// The extension's launch path: ROM lookup, load failures, build before launch.
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  WORKSPACE, ROM, adapterPids, cleanUp, newAdapterPids, eventually, installTracker, mark, startSession,
  tryStartSession, waitForStopped,
} from './helpers';

const MAKEFILE = path.join(WORKSPACE, 'Makefile');
const MARKER = path.join(WORKSPACE, 'built.marker');

function writeMakefile(recipe: string): void {
  fs.writeFileSync(MAKEFILE, `all:\n\t${recipe}\n`);
}

async function setBuildBeforeLaunch(on: boolean): Promise<void> {
  await vscode.workspace.getConfiguration('xretrocode')
    .update('buildBeforeLaunch', on, vscode.ConfigurationTarget.Workspace);
}

describe('Launching through the extension', () => {
  before(installTracker);
  afterEach(cleanUp);

  it('picks the only ROM in the workspace when romPath is omitted', async () => {
    const since = mark();
    const session = await startSession({ romPath: undefined, stopOnEntry: true });
    await waitForStopped('entry', since);
    assert.strictEqual(session.configuration.romPath, ROM);
  });

  it('reports a ROM that fails to load and leaves nothing running', async () => {
    const before = adapterPids();
    const missing = path.join(WORKSPACE, 'missing.sfc');
    // VS Code shows the adapter's error in a dialog; in tests the dialog is
    // refused, which surfaces as startDebugging rejecting with the message
    const outcome = await tryStartSession({ romPath: missing }).then(
      ok => `resolved ${ok}`,
      (err: Error) => err.message
    );
    assert.ok(outcome.includes(`Failed to load ROM: ${missing}`) || outcome === 'resolved false', outcome);
    assert.ok(await eventually(() => vscode.debug.activeDebugSession === undefined), 'session still active');
    assert.ok(await eventually(() => newAdapterPids(before).length === 0, 15_000),
      `adapter(s) ${newAdapterPids(before)} left after a failed launch`);
  });

  describe('with a makefile', () => {
    let realShowError: typeof vscode.window.showErrorMessage;
    let errors: string[];

    beforeEach(async () => {
      fs.rmSync(MARKER, { force: true });
      await setBuildBeforeLaunch(true);
      // The build-failure dialog is modal; answer it from here instead
      errors = [];
      realShowError = vscode.window.showErrorMessage;
    });

    afterEach(async () => {
      (vscode.window as any).showErrorMessage = realShowError;
      fs.rmSync(MAKEFILE, { force: true });
      fs.rmSync(MARKER, { force: true });
      await setBuildBeforeLaunch(false);
    });

    function answerErrors(choice: string | undefined): void {
      (vscode.window as any).showErrorMessage = async (message: string) => {
        errors.push(message);
        return choice;
      };
    }

    it('runs make before launching', async () => {
      writeMakefile(`touch ${MARKER}`);
      const since = mark();
      await startSession({ stopOnEntry: true });
      await waitForStopped('entry', since);
      assert.ok(fs.existsSync(MARKER), 'make should have run before the session started');
    });

    it('does not launch when the build fails', async () => {
      writeMakefile('exit 3');
      answerErrors(undefined);
      const ok = await tryStartSession({ stopOnEntry: true });
      assert.strictEqual(ok, false);
      // make reports a failed recipe as its own exit status 2
      assert.ok(errors.some(m => m.includes('make exited with 2')), JSON.stringify(errors));
      assert.strictEqual(vscode.debug.activeDebugSession, undefined);
    });

    it('launches anyway when asked after a failed build', async () => {
      writeMakefile('exit 3');
      answerErrors('Debug Anyway');
      const since = mark();
      await startSession({ stopOnEntry: true });
      await waitForStopped('entry', since);
      // make reports a failed recipe as its own exit status 2
      assert.ok(errors.some(m => m.includes('make exited with 2')), JSON.stringify(errors));
    });
  });
});
