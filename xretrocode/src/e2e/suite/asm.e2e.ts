// Debug an assembly-only program: Mesen-GDB's hello_asm test ROM, built by
// ca65 -g and ld65 --dbgfile.
import * as assert from 'assert';
import * as vscode from 'vscode';
import {
  ASM_LINES, ASM_ROM, ASM_SOURCE, Frame, breakIn, cleanUp, installTracker, mark, runTo,
  startSession, topFrame, waitForEvent, waitForStopped,
} from './helpers';

function inHelloS(frame: Frame): boolean {
  return !!frame.source?.path?.endsWith('hello.s');
}

/** Send a step request and wait for the stop it causes; returns its reason and top frame. */
async function step(session: vscode.DebugSession, command: string, threadId: number) {
  const since = mark();
  await session.customRequest(command, { threadId });
  const stopped = await waitForEvent(e => e.event === 'stopped', `stopped after ${command}`, since);
  return { reason: stopped.body.reason as string, top: await topFrame(session, threadId) };
}

/** Stop at `line` of hello.s, then clear the breakpoint so steps aren't cut short by it. */
async function runToAndClear(line: number) {
  const stop = await runTo(line, { romPath: ASM_ROM }, ASM_SOURCE);
  breakIn(ASM_SOURCE);
  // Let VS Code send the now-empty breakpoint list before stepping
  await new Promise(r => setTimeout(r, 300));
  return stop;
}

describe('Assembly debugging', () => {
  before(installTracker);
  afterEach(cleanUp);

  it('opens .s files as Retro Assembly, so the gutter takes breakpoints', async () => {
    const doc = await vscode.workspace.openTextDocument(ASM_SOURCE);
    assert.strictEqual(doc.languageId, 'retroasm');
  });

  it('hits a breakpoint on an assembly line, in the .proc it is in', async () => {
    const { session, threadId } = await runTo(ASM_LINES.CALL_TICK, { romPath: ASM_ROM }, ASM_SOURCE);
    const top = await topFrame(session, threadId);
    assert.ok(inHelloS(top) && top.line === ASM_LINES.CALL_TICK && top.name === 'reset', JSON.stringify(top));
  });

  it('steps over a jsr to the next line', async () => {
    const { session, threadId } = await runToAndClear(ASM_LINES.CALL_TICK);
    const { reason, top } = await step(session, 'next', threadId);
    assert.strictEqual(reason, 'step');
    assert.ok(inHelloS(top) && top.line === ASM_LINES.AFTER_CALL, JSON.stringify(top));
  });

  it('steps into a subroutine and out again', async () => {
    const { session, threadId } = await runToAndClear(ASM_LINES.CALL_TICK);
    const into = await step(session, 'stepIn', threadId);
    assert.ok(inHelloS(into.top) && into.top.name === 'tick' && into.top.line === ASM_LINES.TICK_FIRST,
      JSON.stringify(into.top));
    const trace = await session.customRequest('stackTrace', { threadId });
    const caller: Frame = trace.stackFrames[1];
    assert.ok(caller.name === 'reset' && caller.line === ASM_LINES.CALL_TICK, JSON.stringify(trace.stackFrames));

    const out = await step(session, 'stepOut', threadId);
    assert.ok(out.top.name === 'reset' && out.top.line === ASM_LINES.AFTER_CALL, JSON.stringify(out.top));
  });

  it('stops at a function breakpoint on a .proc', async () => {
    vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
    vscode.debug.addBreakpoints([new vscode.FunctionBreakpoint('tick')]);
    const since = mark();
    const session = await startSession({ romPath: ASM_ROM });
    const stopped = await waitForStopped('breakpoint', since);
    const top = await topFrame(session, stopped.body.threadId);
    assert.ok(inHelloS(top) && top.name === 'tick' && top.line === ASM_LINES.TICK_FIRST, JSON.stringify(top));
  });
});
