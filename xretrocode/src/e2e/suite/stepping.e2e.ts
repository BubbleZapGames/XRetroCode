// Step over, into and out of code in green.r65.
import * as assert from 'assert';
import * as fs from 'fs';
import * as vscode from 'vscode';
import {
  LINES, breakAt, cleanUp, inGreenSource, installTracker, mark, runTo, startSession,
  topFrame, waitForEvent, waitForStopped,
} from './helpers';

/** Send a step request and wait for the stop it causes; returns its reason, top frame and duration. */
async function step(session: vscode.DebugSession, command: string, threadId: number) {
  const since = mark();
  const started = Date.now();
  await session.customRequest(command, { threadId });
  const stopped = await waitForEvent(e => e.event === 'stopped', `stopped after ${command}`, since);
  return { reason: stopped.body.reason as string, top: await topFrame(session, threadId), ms: Date.now() - started };
}

async function runToAndClear(line: number) {
  const stop = await runTo(line);
  breakAt();
  // Let VS Code send the now-empty breakpoint list before stepping
  await new Promise(r => setTimeout(r, 300));
  return stop;
}

describe('Stepping', () => {
  before(installTracker);
  afterEach(cleanUp);

  it('steps over a line that invokes a macro in one step', async () => {
    // set_backdrop!(...) expands to code the .dbg files under <macro:set_backdrop>
    const { session, threadId } = await runToAndClear(LINES.MAIN_FIRST);
    const { reason, top } = await step(session, 'next', threadId);
    assert.strictEqual(reason, 'step');
    assert.ok(inGreenSource(top) && top.line === LINES.MAIN_SECOND, JSON.stringify(top));
  });

  it('steps into a call', async () => {
    const { session, threadId } = await runToAndClear(LINES.CALL_MAIN);
    const { reason, top } = await step(session, 'stepIn', threadId);
    assert.strictEqual(reason, 'step');
    assert.strictEqual(top.name, 'main');
    assert.strictEqual(top.line, LINES.MAIN_FIRST);
  });

  it('steps out of the NMI handler back to the interrupted loop', async () => {
    const { session, threadId } = await runToAndClear(LINES.NMI);
    const { reason, top } = await step(session, 'stepOut', threadId);
    assert.strictEqual(reason, 'step');
    assert.strictEqual(top.line, LINES.MAIN_LOOP, `stepped out to ${JSON.stringify(top)}`);
  });

  it('steps over the wait in the main loop to its next pass', async () => {
    // A loop on one line never reaches another, and the WAI in it halts the
    // CPU until the next frame's NMI
    const { session, threadId } = await runToAndClear(LINES.MAIN_LOOP);
    const { reason, top, ms } = await step(session, 'next', threadId);
    assert.strictEqual(reason, 'step');
    assert.strictEqual(top.line, LINES.MAIN_LOOP);
    assert.ok(ms < 2000, `took ${ms} ms — the step should not run to its time budget`);
  });

  it('stops at a breakpoint in the NMI handler while stepping over the main loop', async () => {
    const { session, threadId } = await runTo(LINES.MAIN_LOOP);
    breakAt(LINES.NMI);
    await new Promise(r => setTimeout(r, 300));
    const since = mark();
    await session.customRequest('next', { threadId });
    const stopped = await waitForStopped('breakpoint', since);
    assert.strictEqual((await topFrame(session, stopped.body.threadId)).line, LINES.NMI);
  });

  it('reports frames in a source file that exists, without any breakpoints', async () => {
    // green.dbg records the path the ROM was built from. Where that is gone
    // (another machine, CI), the copy beside the .dbg stands in for it;
    // either way the client gets a file it can open.
    const since = mark();
    const session = await startSession({ stopOnEntry: true });
    const stopped = await waitForStopped('entry', since);
    const { top } = await step(session, 'stepIn', stopped.body.threadId);
    assert.ok(inGreenSource(top) && fs.existsSync(top.source!.path!), JSON.stringify(top));
  });
});
