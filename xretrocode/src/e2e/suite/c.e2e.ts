// Debug a C program: Mesen-GDB's hello_c test ROM, built by cc65 with -g.
import * as assert from 'assert';
import * as vscode from 'vscode';
import {
  C_LINES, C_ROM, C_SOURCE, Frame, breakIn, breakpointReports, cleanUp, installTracker,
  latestBreakpointReports, mark, runTo, startSession, topFrame, waitForEvent, waitForStopped,
} from './helpers';

function inHelloC(frame: Frame): boolean {
  return !!frame.source?.path?.endsWith('hello.c');
}

/** Send a step request and wait for the stop it causes; returns its reason and top frame. */
async function step(session: vscode.DebugSession, command: string, threadId: number) {
  const since = mark();
  await session.customRequest(command, { threadId });
  const stopped = await waitForEvent(e => e.event === 'stopped', `stopped after ${command}`, since);
  return { reason: stopped.body.reason as string, top: await topFrame(session, threadId) };
}

/** Stop at `line` of hello.c, then clear the breakpoint so steps aren't cut short by it. */
async function runToAndClear(line: number) {
  const stop = await runTo(line, { romPath: C_ROM }, C_SOURCE);
  breakIn(C_SOURCE);
  // Let VS Code send the now-empty breakpoint list before stepping
  await new Promise(r => setTimeout(r, 300));
  return stop;
}

describe('C debugging', () => {
  before(installTracker);
  afterEach(cleanUp);

  it('opens .c files as C, so the gutter takes breakpoints', async () => {
    const doc = await vscode.workspace.openTextDocument(C_SOURCE);
    assert.strictEqual(doc.languageId, 'c');
  });

  it('hits a breakpoint on a C line, and shows it in hello.c', async () => {
    const since = breakpointReports.length;
    const { session, threadId } = await runTo(C_LINES.CALL_ADD, { romPath: C_ROM }, C_SOURCE);
    const top = await topFrame(session, threadId);
    assert.ok(inHelloC(top), JSON.stringify(top));
    assert.strictEqual(top.line, C_LINES.CALL_ADD);
    // cc65 calls it _main; the C name is main
    assert.strictEqual(top.name, 'main');
    const reports = latestBreakpointReports(since);
    assert.ok(reports.some(r => r.verified && r.line === C_LINES.CALL_ADD), JSON.stringify(reports));
  });

  it('steps over a C statement to the next one', async () => {
    const { session, threadId } = await runToAndClear(C_LINES.CALL_ADD);
    const { reason, top } = await step(session, 'next', threadId);
    assert.strictEqual(reason, 'step');
    assert.ok(inHelloC(top) && top.line === C_LINES.IF, JSON.stringify(top));
  });

  it("steps into a C function, past cc65's runtime helpers", async () => {
    // The call pushes its argument through pusha first, which is assembly
    const { session, threadId } = await runToAndClear(C_LINES.CALL_ADD);
    const into = await step(session, 'stepIn', threadId);
    assert.ok(inHelloC(into.top) && into.top.name === 'add', JSON.stringify(into.top));
    assert.strictEqual(into.top.line, C_LINES.ADD_OPEN);

    const next = await step(session, 'next', threadId);
    assert.ok(inHelloC(next.top) && next.top.line === C_LINES.ADD_FIRST, JSON.stringify(next.top));

    // The caller is next on the stack
    const trace = await session.customRequest('stackTrace', { threadId });
    const caller: Frame = trace.stackFrames[1];
    assert.ok(inHelloC(caller) && caller.name === 'main' && caller.line === C_LINES.CALL_ADD,
      JSON.stringify(trace.stackFrames));
  });

  it('stops at a function breakpoint on a C function', async () => {
    // What Run > New Breakpoint > Function Breakpoint... creates
    vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
    vscode.debug.addBreakpoints([
      new vscode.FunctionBreakpoint('add'),
      new vscode.FunctionBreakpoint('no_such_function'),
    ]);
    const reportsSince = breakpointReports.length;
    const since = mark();
    const session = await startSession({ romPath: C_ROM });
    const stopped = await waitForStopped('breakpoint', since);

    // At add's entry: cc65 files its prologue under the opening brace
    const top = await topFrame(session, stopped.body.threadId);
    assert.ok(inHelloC(top) && top.name === 'add' && top.line === C_LINES.ADD_OPEN, JSON.stringify(top));

    // Pending until launch loads the symbols, then placed or refused
    const reports = latestBreakpointReports(reportsSince);
    assert.ok(reports.some(r => r.verified), JSON.stringify(reports));
    assert.ok(reports.some(r => !r.verified && r.message?.includes('no_such_function')), JSON.stringify(reports));
  });

  it('steps out of a C function back to its caller', async () => {
    const { session, threadId } = await runToAndClear(C_LINES.ADD_RETURN);
    const { top } = await step(session, 'stepOut', threadId);
    assert.ok(inHelloC(top) && top.name === 'main' && top.line === C_LINES.CALL_ADD, JSON.stringify(top));
  });
});
