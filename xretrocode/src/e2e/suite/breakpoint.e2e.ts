// Debug Mesen-GDB's green test ROM through VS Code and stop on a breakpoint.
import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';

const WORKSPACE = process.env.E2E_WORKSPACE!;
const ROM = path.join(WORKSPACE, 'green.sfc');
const SOURCE = vscode.Uri.file(path.join(WORKSPACE, 'green.r65'));
/** `clear_nmi!()` in nmi_handler: runs once every frame */
const NMI_LINE = 22;

interface DapEvent {
  event: string;
  body?: any;
}

// Every event the adapter sends, in order, across all sessions
const events: DapEvent[] = [];
let waiters: { match: (e: DapEvent) => boolean; resolve: (e: DapEvent) => void }[] = [];

function record(e: DapEvent): void {
  events.push(e);
  for (const w of waiters.filter(w => w.match(e))) {
    waiters = waiters.filter(x => x !== w);
    w.resolve(e);
  }
}

/**
 * The first `stopped` event with `reason` sent at or after index `since` of
 * `events`. Taking `since` before the request that causes the stop means a
 * stop that arrives before the request's response still counts.
 */
function waitForStopped(reason: string, since: number, timeoutMs = 30_000): Promise<DapEvent> {
  const match = (e: DapEvent) => e.event === 'stopped' && e.body?.reason === reason;
  const already = events.slice(since).find(match);
  if (already) return Promise.resolve(already);

  return new Promise((resolve, reject) => {
    const waiter = {
      match,
      resolve: (e: DapEvent) => {
        clearTimeout(timer);
        resolve(e);
      },
    };
    const timer = setTimeout(() => {
      waiters = waiters.filter(w => w !== waiter);
      const seen = events.slice(since).map(e => e.body?.reason ? `${e.event}:${e.body.reason}` : e.event);
      reject(new Error(`no stopped(${reason}) within ${timeoutMs} ms; events since the request: ${JSON.stringify(seen)}`));
    }, timeoutMs);
    waiters.push(waiter);
  });
}

async function startSession(overrides: Partial<vscode.DebugConfiguration> = {}): Promise<vscode.DebugSession> {
  const started = new Promise<vscode.DebugSession>(resolve => {
    const sub = vscode.debug.onDidStartDebugSession(session => {
      sub.dispose();
      resolve(session);
    });
  });
  const ok = await vscode.debug.startDebugging(vscode.workspace.workspaceFolders![0], {
    type: 'xretrocode',
    request: 'launch',
    name: 'e2e',
    romPath: ROM,
    stopOnEntry: false,
    headless: true,
    mesenDapPath: process.env.MESEN_GDB,
    ...overrides,
  });
  assert.ok(ok, 'startDebugging refused the launch configuration');
  return started;
}

async function stopSession(): Promise<void> {
  if (!vscode.debug.activeDebugSession) return;
  const ended = new Promise<void>(resolve => {
    const sub = vscode.debug.onDidTerminateDebugSession(() => {
      sub.dispose();
      resolve();
    });
  });
  await vscode.debug.stopDebugging();
  await Promise.race([ended, new Promise(r => setTimeout(r, 10_000))]);
}

function breakAt(line: number): void {
  vscode.debug.addBreakpoints([
    new vscode.SourceBreakpoint(new vscode.Location(SOURCE, new vscode.Position(line - 1, 0))),
  ]);
}

describe('Debugging with mesen-gdb', () => {
  let tracker: vscode.Disposable;

  before(() => {
    tracker = vscode.debug.registerDebugAdapterTrackerFactory('xretrocode', {
      createDebugAdapterTracker: () => ({
        onDidSendMessage: (message: any) => {
          if (message.type === 'event') record(message);
        },
      }),
    });
  });

  after(() => tracker.dispose());

  afterEach(async () => {
    vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
    await stopSession();
  });

  it('stops at a source breakpoint in the .r65 file', async () => {
    breakAt(NMI_LINE);
    const since = events.length;
    const session = await startSession();

    const stopped = await waitForStopped('breakpoint', since);
    const trace = await session.customRequest('stackTrace', { threadId: stopped.body.threadId });
    const top = trace.stackFrames[0];
    assert.strictEqual(top.line, NMI_LINE, `stopped at ${JSON.stringify(top)}`);
    // The adapter reports the path recorded in green.dbg, not the workspace copy
    assert.ok(top.source?.path?.endsWith('green.r65'), `top frame source: ${JSON.stringify(top.source)}`);
  });

  it('hits the breakpoint again after continue', async () => {
    breakAt(NMI_LINE);
    const first = events.length;
    const session = await startSession();
    const stopped = await waitForStopped('breakpoint', first);

    const second = events.length;
    await session.customRequest('continue', { threadId: stopped.body.threadId });
    const again = await waitForStopped('breakpoint', second);
    assert.strictEqual(again.body.threadId, stopped.body.threadId);
  });

  it('stops on entry when asked to', async () => {
    const since = events.length;
    await startSession({ stopOnEntry: true });
    const stopped = await waitForStopped('entry', since);
    assert.ok(stopped.body.threadId > 0);
  });
});
