// Shared plumbing for the e2e suites: launch sessions on Mesen-GDB's green
// test ROM and watch what the adapter sends.
import * as assert from 'assert';
import { execSync } from 'child_process';
import * as path from 'path';
import * as vscode from 'vscode';

export const WORKSPACE = process.env.E2E_WORKSPACE!;
export const ROM = path.join(WORKSPACE, 'green.sfc');
export const SOURCE = vscode.Uri.file(path.join(WORKSPACE, 'green.r65'));

/** Lines of green.r65 the tests aim at. */
export const LINES = {
  /** `snes_init();` — first statement after reset; runs once */
  SNES_INIT: 16,
  /** `main();` in init_reset — runs once */
  CALL_MAIN: 17,
  /** `clear_nmi!()` in nmi_handler — runs every frame */
  NMI: 22,
  /** `set_backdrop!(...)`, first line of main — runs once */
  MAIN_FIRST: 27,
  /** `set_brightness!(15)` — runs once, right after MAIN_FIRST */
  MAIN_SECOND: 28,
  /** `wait_nmi!()` in main's loop — where the NMI handler returns to */
  MAIN_LOOP: 31,
};

export interface DapMessage {
  type: string;
  event?: string;
  command?: string;
  body?: any;
}

/** Every event the adapter sends, in order, across all sessions. */
export const events: DapMessage[] = [];

export interface BreakpointReport {
  id: number;
  verified: boolean;
  line?: number;
  message?: string;
}

/** Everything the adapter said about breakpoints, in order: setBreakpoints responses and breakpoint events. */
export const breakpointReports: BreakpointReport[] = [];

/** The latest report per breakpoint id among those after index `since`. */
export function latestBreakpointReports(since: number): BreakpointReport[] {
  const latest = new Map<number, BreakpointReport>();
  for (const report of breakpointReports.slice(since)) latest.set(report.id, report);
  return [...latest.values()];
}

let waiters: { match: (e: DapMessage) => boolean; resolve: (e: DapMessage) => void }[] = [];
let tracker: vscode.Disposable | undefined;

function record(e: DapMessage): void {
  events.push(e);
  for (const w of waiters.filter(w => w.match(e))) {
    waiters = waiters.filter(x => x !== w);
    w.resolve(e);
  }
}

function noteBreakpoint(bp: BreakpointReport | undefined): void {
  if (bp?.id !== undefined) breakpointReports.push({ id: bp.id, verified: bp.verified, line: bp.line, message: bp.message });
}

/**
 * Watch every xretrocode session's adapter traffic. Registration reaches VS
 * Code asynchronously, so the suite runner calls this once and lets it
 * settle before the first session — a session started straight after
 * registering can go untracked.
 */
export function installTracker(): void {
  tracker ??= vscode.debug.registerDebugAdapterTrackerFactory('xretrocode', {
    createDebugAdapterTracker: () => ({
      onDidSendMessage: (message: DapMessage) => {
        if (message.type === 'event') {
          if (message.event === 'breakpoint') noteBreakpoint(message.body?.breakpoint);
          record(message);
        } else if (message.type === 'response' && message.command === 'setBreakpoints') {
          for (const bp of message.body?.breakpoints ?? []) noteBreakpoint(bp);
        }
      },
    }),
  });
}

/** Index to pass as `since`: take it before the request that causes the event. */
export function mark(): number {
  return events.length;
}

/**
 * The first event matching `match` sent at or after index `since`. Taking
 * `since` before the request means an event that beats the request's
 * response still counts.
 */
export function waitForEvent(
  match: (e: DapMessage) => boolean, describe: string, since: number, timeoutMs = 30_000
): Promise<DapMessage> {
  const already = events.slice(since).find(match);
  if (already) return Promise.resolve(already);

  return new Promise((resolve, reject) => {
    const waiter = {
      match,
      resolve: (e: DapMessage) => {
        clearTimeout(timer);
        resolve(e);
      },
    };
    const timer = setTimeout(() => {
      waiters = waiters.filter(w => w !== waiter);
      const seen = events.slice(since).map(e => e.body?.reason ? `${e.event}:${e.body.reason}` : e.event);
      reject(new Error(`no ${describe} within ${timeoutMs} ms; events since the request: ${JSON.stringify(seen)}`));
    }, timeoutMs);
    waiters.push(waiter);
  });
}

export function waitForStopped(reason: string, since: number, timeoutMs = 30_000): Promise<DapMessage> {
  return waitForEvent(e => e.event === 'stopped' && e.body?.reason === reason, `stopped(${reason})`, since, timeoutMs);
}

/** Resolves true if no `stopped` event arrives after `since` within `ms`. */
export async function staysRunning(since: number, ms: number): Promise<boolean> {
  try {
    await waitForEvent(e => e.event === 'stopped', 'stopped', since, ms);
    return false;
  } catch {
    return true;
  }
}

export const baseConfig = (): vscode.DebugConfiguration => ({
  type: 'xretrocode',
  request: 'launch',
  name: 'e2e',
  romPath: ROM,
  stopOnEntry: false,
  headless: true,
  mesenDapPath: process.env.MESEN_GDB,
});

/** Start a session; `overrides` replace base keys, and an `undefined` value removes one. */
export async function startSession(overrides: Partial<vscode.DebugConfiguration> = {}): Promise<vscode.DebugSession> {
  const started = new Promise<vscode.DebugSession>(resolve => {
    const sub = vscode.debug.onDidStartDebugSession(session => {
      sub.dispose();
      resolve(session);
    });
  });
  const ok = await tryStartSession(overrides);
  assert.ok(ok, 'startDebugging refused the launch configuration');
  return started;
}

/** startDebugging's own answer, for tests that expect a refusal. */
export async function tryStartSession(overrides: Partial<vscode.DebugConfiguration> = {}): Promise<boolean> {
  const config: vscode.DebugConfiguration = { ...baseConfig(), ...overrides };
  for (const key of Object.keys(config)) {
    if (config[key] === undefined) delete config[key];
  }
  return vscode.debug.startDebugging(vscode.workspace.workspaceFolders![0], config);
}

/** Stop the active session (if any) and wait for it to end. */
export async function stopSession(): Promise<void> {
  if (!vscode.debug.activeDebugSession) return;
  const ended = new Promise<void>(resolve => {
    const sub = vscode.debug.onDidTerminateDebugSession(() => {
      sub.dispose();
      resolve();
    });
  });
  await vscode.debug.stopDebugging();
  await Promise.race([ended, sleep(10_000)]);
}

/** Replace all breakpoints with ones at these lines of green.r65. */
export function breakAt(...lines: (number | { line: number; condition: string })[]): void {
  vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
  vscode.debug.addBreakpoints(lines.map(l => {
    const { line, condition } = typeof l === 'number' ? { line: l, condition: undefined } : l;
    return new vscode.SourceBreakpoint(
      new vscode.Location(SOURCE, new vscode.Position(line - 1, 0)), true, condition
    );
  }));
}

export interface Frame {
  line: number;
  name: string;
  source?: { name?: string; path?: string };
  instructionPointerReference?: string;
}

export async function topFrame(session: vscode.DebugSession, threadId: number): Promise<Frame> {
  const trace = await session.customRequest('stackTrace', { threadId });
  return trace.stackFrames[0];
}

/** Whether a frame is in green.r65 (the adapter reports the path recorded in the .dbg). */
export function inGreenSource(frame: Frame): boolean {
  return !!frame.source?.path?.endsWith('green.r65');
}

/** Start with a breakpoint at `line` and wait for it to be hit. */
export async function runTo(line: number, overrides: Partial<vscode.DebugConfiguration> = {}) {
  breakAt(line);
  const since = mark();
  const session = await startSession(overrides);
  const stopped = await waitForStopped('breakpoint', since);
  return { session, threadId: stopped.body.threadId as number };
}

/**
 * PIDs of running headless mesen-gdb DAP processes. Tests compare PIDs, not
 * counts: an adapter from an earlier test can still be on its way out (a
 * crash on exit is handed to the system crash reporter first).
 */
export function adapterPids(): Set<number> {
  try {
    // `[m]` keeps the pattern from matching the shell that runs pgrep
    const out = execSync("pgrep -f '[m]esen-gdb --dap --headless'").toString();
    return new Set(out.split('\n').filter(Boolean).map(Number));
  } catch {
    return new Set(); // pgrep exits 1 when nothing matches
  }
}

/** Adapter PIDs running now that were not in `before`. */
export function newAdapterPids(before: Set<number>): number[] {
  return [...adapterPids()].filter(pid => !before.has(pid));
}

export function isRunning(pid: number): boolean {
  return adapterPids().has(pid);
}

/** Poll until `check` holds or `ms` passes; returns the last result. */
export async function eventually(check: () => boolean, ms = 10_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await sleep(100);
  }
  return check();
}

export function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

/** Common teardown: no breakpoints left, no session left. */
export async function cleanUp(): Promise<void> {
  vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
  await stopSession();
}
