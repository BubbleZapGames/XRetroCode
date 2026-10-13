// Step over, into and out of code in green.r65.
import * as assert from 'assert';
import * as vscode from 'vscode';
import {
  Frame, LINES, cleanUp, inGreenSource, installTracker, mark, runTo, topFrame,
  waitForEvent, waitForStopped,
} from './helpers';

/** Send a step request and wait for the stop it causes; returns its reason and top frame. */
async function step(session: vscode.DebugSession, command: string, threadId: number) {
  const since = mark();
  await session.customRequest(command, { threadId });
  const stopped = await waitForEvent(e => e.event === 'stopped', `stopped after ${command}`, since);
  return { reason: stopped.body.reason as string, top: await topFrame(session, threadId) };
}

describe('Stepping', () => {
  before(installTracker);
  afterEach(cleanUp);

  it('steps over to the next line', async () => {
    const { session, threadId } = await runTo(LINES.MAIN_FIRST);
    vscode.debug.removeBreakpoints(vscode.debug.breakpoints);

    // `next` may stop inside the macro the line expands (see knownIssues),
    // but must reach the following line in a few steps, each a plain step
    let top: Frame | undefined;
    for (let i = 0; i < 5; i++) {
      const result = await step(session, 'next', threadId);
      assert.strictEqual(result.reason, 'step');
      top = result.top;
      if (inGreenSource(top) && top.line === LINES.MAIN_SECOND) return;
    }
    assert.fail(`never reached line ${LINES.MAIN_SECOND}; last stop ${JSON.stringify(top)}`);
  });

  it('steps into a call', async () => {
    const { session, threadId } = await runTo(LINES.CALL_MAIN);
    vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
    const { reason, top } = await step(session, 'stepIn', threadId);
    assert.strictEqual(reason, 'step');
    assert.strictEqual(top.name, 'main');
    assert.strictEqual(top.line, LINES.MAIN_FIRST);
  });

  it('steps out of the NMI handler back to the interrupted loop', async () => {
    const { session, threadId } = await runTo(LINES.NMI);
    vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
    await new Promise(r => setTimeout(r, 300));
    const { reason, top } = await step(session, 'stepOut', threadId);
    assert.strictEqual(reason, 'step');
    assert.strictEqual(top.line, LINES.MAIN_LOOP, `stepped out to ${JSON.stringify(top)}`);
  });
});
