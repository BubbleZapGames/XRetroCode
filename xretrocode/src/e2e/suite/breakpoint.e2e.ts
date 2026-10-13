// Breakpoints in green.r65, set before and during a session.
import * as assert from 'assert';
import {
  LINES, breakAt, cleanUp, inGreenSource, installTracker, mark, runTo, staysRunning,
  startSession, topFrame, waitForStopped,
} from './helpers';

describe('Breakpoints', () => {
  before(installTracker);
  afterEach(cleanUp);

  it('stops at a source breakpoint in the .r65 file', async () => {
    const { session, threadId } = await runTo(LINES.NMI);
    const top = await topFrame(session, threadId);
    assert.strictEqual(top.line, LINES.NMI, `stopped at ${JSON.stringify(top)}`);
    // The adapter reports the path recorded in green.dbg, not the workspace copy
    assert.ok(inGreenSource(top), `top frame source: ${JSON.stringify(top.source)}`);
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

  it('stops when a breakpoint condition is true', async () => {
    breakAt({ line: LINES.NMI, condition: '1' });
    const since = mark();
    await startSession();
    await waitForStopped('breakpoint', since);
  });
});
