// Stopped on a line that invokes macros, "Go to Macro Definition" offers
// their definitions (the debugger steps over macros).
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { LINES, WORKSPACE, cleanUp, installTracker, mark, runTo, sleep, startSession, topFrame, waitForStopped } from './helpers';

const COMMAND = 'xretrocode.goToMacroDefinition';
const FIXTURE = path.join(WORKSPACE, 'green-macros.r65');

/** 0-based line of `macro_rules! name` in the fixture. */
function definitionLine(name: string): number {
  const lines = fs.readFileSync(FIXTURE, 'utf8').split('\n');
  const line = lines.findIndex(l => new RegExp(`macro_rules!\\s*${name}\\b`).test(l));
  assert.ok(line >= 0, `no ${name} in the fixture`);
  return line;
}

/**
 * The command's answer once the aid has looked up the stop (it reacts to the
 * stopped event asynchronously): retry until it offers something.
 */
async function offeredDefinitions(): Promise<vscode.Location[]> {
  const end = Date.now() + 10_000;
  for (;;) {
    const locations = await vscode.commands.executeCommand<vscode.Location[]>(COMMAND) ?? [];
    if (locations.length > 0 || Date.now() > end) return locations;
    await sleep(200);
  }
}

const describeLocations = (locations: vscode.Location[]) =>
  locations.map(l => `${path.basename(l.uri.fsPath)}:${l.range.start.line}`);

describe('Go to Macro Definition while stopped', () => {
  before(installTracker);
  afterEach(cleanUp);

  it('offers every macro invoked on the stopped line', async () => {
    // set_backdrop!(Color::rgb!(0, 31, 0));
    await runTo(LINES.MAIN_FIRST);
    const locations = await offeredDefinitions();
    assert.deepStrictEqual(describeLocations(locations), [
      `green-macros.r65:${definitionLine('set_backdrop')}`,
      `green-macros.r65:${definitionLine('rgb')}`,
    ]);
  });

  it('offers the macro in the NMI handler', async () => {
    // clear_nmi!()
    await runTo(LINES.NMI);
    const locations = await offeredDefinitions();
    assert.deepStrictEqual(describeLocations(locations), [`green-macros.r65:${definitionLine('clear_nmi')}`]);
  });

  it('goes to the macro definition on the first Step Into, and steps on the second', async () => {
    // set_backdrop!(Color::rgb!(0, 31, 0)) — the outermost macro is the one stepped into
    const { session, threadId } = await runTo(LINES.MAIN_FIRST);
    await offeredDefinitions(); // the stop has been looked up

    const shown = await vscode.commands.executeCommand<vscode.Location[]>('xretrocode.stepIntoMacro') ?? [];
    assert.deepStrictEqual(describeLocations(shown), [`green-macros.r65:${definitionLine('set_backdrop')}`]);
    const editor = vscode.window.activeTextEditor!;
    assert.strictEqual(path.basename(editor.document.uri.fsPath), 'green-macros.r65');
    assert.strictEqual(editor.selection.active.line, definitionLine('set_backdrop'));

    // The debugger runs the macro as one statement: the next Step Into steps
    const since = mark();
    const again = await vscode.commands.executeCommand<vscode.Location[]>('xretrocode.stepIntoMacro') ?? [];
    assert.deepStrictEqual(again, []);
    await waitForStopped('step', since);
    assert.strictEqual((await topFrame(session, threadId)).line, LINES.MAIN_SECOND);
  });

  it('offers nothing when stopped where there is no source line', async () => {
    // The reset entry point has no line record, so nothing to look at
    const since = mark();
    await startSession({ stopOnEntry: true });
    await waitForStopped('entry', since);
    await sleep(1000);
    const locations = await vscode.commands.executeCommand<vscode.Location[]>(COMMAND);
    assert.deepStrictEqual(locations, []);
  });
});
