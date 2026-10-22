import * as vscode from 'vscode';

export const STEP_INSTRUCTION_COMMAND = 'xretrocode.stepInstruction';

/**
 * "Step Instruction": run one CPU instruction, entering a JSR/JSL like GDB's
 * stepi. mesen-gdb steps by instruction for a stepIn with instruction
 * granularity, which VS Code itself only sends from its Disassembly editor.
 */
export class InstructionStepper implements vscode.Disposable {
  private disposables: vscode.Disposable[] = [];
  // The thread each session last stopped on, by session id
  private stoppedThreads = new Map<string, number>();

  constructor() {
    this.disposables.push(
      vscode.commands.registerCommand(STEP_INSTRUCTION_COMMAND, () => this.step()),
      vscode.debug.registerDebugAdapterTrackerFactory('xretrocode', {
        createDebugAdapterTracker: session => ({
          onDidSendMessage: (message: any) => {
            if (message.type === 'event' && message.event === 'stopped' && message.body?.threadId !== undefined) {
              this.stoppedThreads.set(session.id, message.body.threadId);
            }
          },
          onWillStopSession: () => { this.stoppedThreads.delete(session.id); },
        }),
      }),
    );
  }

  /** Step the focused thread of the active session; false when there is none to step. */
  async step(): Promise<boolean> {
    const session = vscode.debug.activeDebugSession;
    if (!session || session.type !== 'xretrocode') return false;

    // The thread focused in Call Stack (VS Code 1.90+), else the one that stopped
    const item = vscode.debug.activeStackItem;
    const threadId = item && item.session.id === session.id ? item.threadId : this.stoppedThreads.get(session.id);
    if (threadId === undefined) return false;

    await session.customRequest('stepIn', { threadId, granularity: 'instruction' });
    return true;
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
  }
}
