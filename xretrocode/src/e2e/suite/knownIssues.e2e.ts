// Adapter behaviour that is wrong today. Each test states the behaviour we
// want and is skipped until mesen-gdb is fixed; drop the `.skip` to check a fix.
import * as assert from 'assert';
import * as vscode from 'vscode';
import {
  LINES, SOURCE, breakAt, cleanUp, inGreenSource, installTracker, mark, runTo,
  staysRunning, startSession, topFrame, waitForStopped,
} from './helpers';

describe('Known adapter issues', () => {
  before(installTracker);
  afterEach(cleanUp);

  // Today: stops inside `<macro:set_backdrop>` line 1, then on line 27 again
  it.skip('steps over a macro invocation in one step', async () => {
    const { session, threadId } = await runTo(LINES.MAIN_FIRST);
    vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
    const since = mark();
    await session.customRequest('next', { threadId });
    await waitForStopped('step', since);
    const top = await topFrame(session, threadId);
    assert.ok(inGreenSource(top) && top.line === LINES.MAIN_SECOND, JSON.stringify(top));
  });

  // Today: an NMI during `next` is stepped out of, so its breakpoint is skipped
  // and the step ends with reason "step"
  it.skip('stops at a breakpoint in the NMI handler while stepping over the main loop', async () => {
    // Stopped in the main loop, step over the wait: the NMI fires meanwhile
    // and its handler holds a breakpoint
    const { session, threadId } = await runTo(LINES.MAIN_LOOP);
    breakAt(LINES.NMI);
    await new Promise(r => setTimeout(r, 300));
    const since = mark();
    await session.customRequest('next', { threadId });
    const stopped = await waitForStopped('breakpoint', since);
    assert.strictEqual((await topFrame(session, stopped.body.threadId)).line, LINES.NMI);
  });

  // Today: the condition is ignored, so `0` stops like `1`
  it.skip('never stops when the breakpoint condition is false', async () => {
    breakAt({ line: LINES.NMI, condition: '0' });
    const since = mark();
    await startSession();
    assert.ok(await staysRunning(since, 1500));
  });

  // Today: a breakpoint on line 11 lands on line 14 but is reported at 11
  it.skip('reports the line a breakpoint actually landed on', async () => {
    const since = mark();
    breakAt(11);
    await startSession({ stopOnEntry: true });
    await waitForStopped('entry', since);
    const bp = vscode.debug.breakpoints[0] as vscode.SourceBreakpoint;
    // VS Code moves the breakpoint to the line the adapter reports
    assert.notStrictEqual(bp.location.range.start.line + 1, 11);
  });

  // Today: hit on some runs and not others
  it.skip('stops at a breakpoint on the first statement after reset', async () => {
    const { session, threadId } = await runTo(LINES.SNES_INIT);
    assert.strictEqual((await topFrame(session, threadId)).line, LINES.SNES_INIT);
  });

  // Today: frames carry the absolute path recorded in green.dbg
  it.skip('reports stack frame sources as the workspace file', async () => {
    const { session, threadId } = await runTo(LINES.NMI);
    const top = await topFrame(session, threadId);
    assert.strictEqual(top.source?.path, SOURCE.fsPath);
  });

  // Today: advertised in capabilities, but the request is rejected
  it.skip('accepts setInstructionBreakpoints', async () => {
    const since = mark();
    const session = await startSession({ stopOnEntry: true });
    await waitForStopped('entry', since);
    await session.customRequest('setInstructionBreakpoints', { breakpoints: [] });
  });
});
