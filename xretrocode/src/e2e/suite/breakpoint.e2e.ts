// Breakpoints in green.r65, set before and during a session.
import * as assert from 'assert';
import {
  LINES, SOURCE, breakAt, breakpointReports, cleanUp, eventually, inGreenSource, installTracker,
  latestBreakpointReports, mark, runTo, staysRunning, startSession, topFrame, waitForStopped,
} from './helpers';

describe('Breakpoints', () => {
  before(installTracker);
  afterEach(cleanUp);

  it('stops at a source breakpoint in the .r65 file', async () => {
    const { session, threadId } = await runTo(LINES.NMI);
    const top = await topFrame(session, threadId);
    assert.strictEqual(top.line, LINES.NMI, `stopped at ${JSON.stringify(top)}`);
    assert.ok(inGreenSource(top), `top frame source: ${JSON.stringify(top.source)}`);
  });

  it('reports stack frames in the workspace file the breakpoint was set in', async () => {
    const { session, threadId } = await runTo(LINES.NMI);
    const top = await topFrame(session, threadId);
    // Not the path recorded in green.dbg when the ROM was built
    assert.strictEqual(top.source?.path, SOURCE.fsPath);
  });

  it('hits the breakpoint again after continue', async () => {
    const { session, threadId } = await runTo(LINES.NMI);
    const since = mark();
    await session.customRequest('continue', { threadId });
    const again = await waitForStopped('breakpoint', since);
    assert.strictEqual(again.body.threadId, threadId);
  });

  it('stops on entry when asked to', async () => {
    const since = mark();
    await startSession({ stopOnEntry: true });
    const stopped = await waitForStopped('entry', since);
    assert.ok(stopped.body.threadId > 0);
  });

  it('stops at a breakpoint on the first statement after reset', async () => {
    const { session, threadId } = await runTo(LINES.SNES_INIT);
    assert.strictEqual((await topFrame(session, threadId)).line, LINES.SNES_INIT);
  });

  it('stops on a breakpoint added while running', async () => {
    const started = mark();
    const session = await startSession();
    assert.ok(await staysRunning(started, 500), 'nothing should stop a session with no breakpoints');

    const since = mark();
    breakAt(LINES.NMI);
    const stopped = await waitForStopped('breakpoint', since);
    assert.strictEqual((await topFrame(session, stopped.body.threadId)).line, LINES.NMI);
  });

  it('runs on once the breakpoint is removed', async () => {
    const { session, threadId } = await runTo(LINES.NMI);
    breakAt();
    // Let VS Code send the now-empty breakpoint list before resuming
    await new Promise(r => setTimeout(r, 300));
    const since = mark();
    await session.customRequest('continue', { threadId });
    assert.ok(await staysRunning(since, 1500), 'the NMI line runs every frame, so a stale breakpoint would stop again');
  });

  it('reports the line a breakpoint on a line without code lands on', async () => {
    // Line 11 is blank; the next code is the reset handler on line 14
    const reports = breakpointReports.length;
    breakAt(11);
    const since = mark();
    await startSession({ stopOnEntry: true });
    await waitForStopped('entry', since);
    assert.ok(await eventually(() => latestBreakpointReports(reports).some(r => r.verified && r.line === 14)),
      JSON.stringify(latestBreakpointReports(reports)));
  });

  describe('with a condition', () => {
    it('stops when it is true', async () => {
      breakAt({ line: LINES.NMI, condition: '1' });
      const since = mark();
      await startSession();
      await waitForStopped('breakpoint', since);
    });

    it('never stops when it is false', async () => {
      breakAt({ line: LINES.NMI, condition: '0' });
      const since = mark();
      await startSession();
      assert.ok(await staysRunning(since, 1500), 'the NMI line runs every frame');
    });

    it('stops when a comparison on a register holds', async () => {
      breakAt({ line: LINES.NMI, condition: 'pc != 0' });
      const since = mark();
      await startSession();
      await waitForStopped('breakpoint', since);
    });

    it('reports a condition that does not parse', async () => {
      const reports = breakpointReports.length;
      breakAt({ line: LINES.NMI, condition: 'nonsense ((' });
      const since = mark();
      await startSession();
      assert.ok(await eventually(() => latestBreakpointReports(reports)
        .some(r => !r.verified && (r.message ?? '').includes('Invalid condition'))),
        JSON.stringify(latestBreakpointReports(reports)));
      assert.ok(await staysRunning(since, 1000));
    });
  });

  it('stops at an instruction breakpoint from the disassembly view', async () => {
    // Find the NMI handler's address by stopping there once
    const { session, threadId } = await runTo(LINES.NMI);
    const address = (await topFrame(session, threadId)).instructionPointerReference!;

    // Leave only an instruction breakpoint on it
    breakAt();
    await new Promise(r => setTimeout(r, 300));
    const { breakpoints } = await session.customRequest('setInstructionBreakpoints', {
      breakpoints: [{ instructionReference: address }],
    });
    assert.ok(breakpoints[0].verified, JSON.stringify(breakpoints));

    const since = mark();
    await session.customRequest('continue', { threadId });
    await waitForStopped('breakpoint', since);
    assert.strictEqual((await topFrame(session, threadId)).instructionPointerReference, address);
  });
});
