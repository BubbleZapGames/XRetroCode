// The adapter process across stop and restart.
import * as assert from 'assert';
import * as vscode from 'vscode';
import {
  LINES, adapterPids, cleanUp, eventually, installTracker, isRunning, mark, newAdapterPids,
  runTo, stopSession, topFrame, waitForEvent, waitForStopped,
} from './helpers';

/** The one adapter process started since `before`. */
function startedAdapter(before: Set<number>): number {
  const started = newAdapterPids(before);
  assert.strictEqual(started.length, 1, `expected one new adapter, found ${JSON.stringify(started)}`);
  return started[0];
}

describe('Session lifecycle', () => {
  before(installTracker);
  afterEach(cleanUp);

  it('leaves no adapter process after stopping', async () => {
    const before = adapterPids();
    await runTo(LINES.NMI);
    const pid = startedAdapter(before);
    await stopSession();
    assert.ok(await eventually(() => !isRunning(pid), 15_000), `mesen-gdb ${pid} still running after stop`);
  });

  it('restarts into a fresh session that hits the breakpoint again', async () => {
    const before = adapterPids();
    await runTo(LINES.NMI);
    const first = startedAdapter(before);

    const restarted = new Promise<vscode.DebugSession>(resolve => {
      const sub = vscode.debug.onDidStartDebugSession(session => {
        sub.dispose();
        resolve(session);
      });
    });
    const since = mark();
    await vscode.commands.executeCommand('workbench.action.debug.restart');
    const session = await restarted;
    // The new adapter announces itself before it stops
    await waitForEvent(e => e.event === 'initialized', 'initialized', since);
    const stopped = await waitForStopped('breakpoint', since);
    assert.strictEqual((await topFrame(session, stopped.body.threadId)).line, LINES.NMI);

    assert.ok(await eventually(() => !isRunning(first), 15_000), `first adapter ${first} still running after restart`);
    startedAdapter(new Set([...before, first]));
  });
});
