import * as vscode from 'vscode';
import { R65Symbol, R65SymbolIndex, R65SymbolKind } from './symbolIndex';
import { LineSource, R65Resolver } from './typeResolver';
import { maskCode } from './referenceProvider';
import { nearestCopy } from './definitionProvider';

export const GO_TO_MACRO_COMMAND = 'xretrocode.goToMacroDefinition';
export const STEP_INTO_MACRO_COMMAND = 'xretrocode.stepIntoMacro';
// While set, F11 goes to the macro definition instead of stepping: once per stop
const STEP_INTO_CONTEXT_KEY = 'xretrocode.stepIntoMacro';

/** Requests that set the program running again, after which the stop is stale. */
const RESUMING_REQUESTS = new Set([
  'continue', 'next', 'stepIn', 'stepOut', 'stepBack', 'reverseContinue', 'pause', 'restart', 'disconnect', 'terminate',
]);

export interface MacroInvocation {
  name: string;
  /** Column of the macro name */
  column: number;
}

/** Whether a stop in this file can be on an R65 macro: C has none, and `!(` there is a negation. */
export function isR65Path(path: string): boolean {
  return path.toLowerCase().endsWith('.r65');
}

/** Macro invocations on a line: `name!(`, `Type::name!(`, `value.name!(`; never `!=`. */
export function findMacroInvocations(lineText: string): MacroInvocation[] {
  const masked = maskCode([lineText])[0];
  const found: MacroInvocation[] = [];
  for (const m of masked.matchAll(/\b([a-zA-Z_][a-zA-Z0-9_]*)\s*!(?!=)\s*\(/g)) {
    if (m[1] === 'macro_rules') continue;
    found.push({ name: m[1], column: m.index! });
  }
  return found;
}

export interface ResolvedMacro {
  name: string;
  definitions: R65Symbol[];
}

/**
 * The definitions of the macros invoked on `line`. The resolver already
 * narrows `Type::name!` and `value.name!` to the right impl; of several
 * copies of one definition (a stdlib vendored into each game), the one
 * nearest the source is kept.
 */
export function resolveMacroDefinitions(
  index: R65SymbolIndex, src: LineSource & { uri: vscode.Uri }, line: number
): ResolvedMacro[] {
  const resolver = new R65Resolver(index);
  const resolved: ResolvedMacro[] = [];
  for (const invocation of findMacroInvocations(src.lineAt(line).text)) {
    const macros = resolver.resolveSymbols(src, line, invocation.column)
      .filter(s => s.kind === R65SymbolKind.Macro);
    const definitions = nearestCopy(macros, src.uri);
    if (definitions.length > 0) {
      resolved.push({ name: invocation.name, definitions });
    }
  }
  return resolved;
}

interface StoppedOnMacros {
  uri: vscode.Uri;
  line: number;
  macros: ResolvedMacro[];
  // Step Into already went to the definition for this stop
  steppedIn?: boolean;
}

/**
 * The debugger steps over macros: their code is attributed to the line that
 * invokes them. When a session stops on such a line, offer to open the macro
 * definitions instead — a status bar item and the "Go to Macro Definition"
 * command, which peeks them in place.
 */
export class MacroDefinitionAid implements vscode.Disposable {
  private disposables: vscode.Disposable[] = [];
  private statusItem: vscode.StatusBarItem;
  private current: StoppedOnMacros | undefined;
  // Stopped on a line with no macros: the stop, not the cursor, is what the
  // palette command is about
  private stoppedElsewhere = false;
  // Each stop bumps this, so a slow lookup for an older stop is dropped
  private stopSeq = 0;
  // The lookup for the latest stop, while it runs: the command waits for it
  // rather than answer from a stale stop or the cursor
  private pending: Promise<void> | undefined;

  constructor(private index: R65SymbolIndex) {
    this.statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.statusItem.command = GO_TO_MACRO_COMMAND;
    this.statusItem.tooltip = 'Go to the macro definition (or press Step Into) — the debugger runs a macro as one statement';

    this.disposables.push(
      this.statusItem,
      vscode.commands.registerCommand(GO_TO_MACRO_COMMAND, (arg?: unknown) => this.goToDefinition(arg)),
      vscode.commands.registerCommand(STEP_INTO_MACRO_COMMAND, () => this.stepInto()),
      vscode.debug.registerDebugAdapterTrackerFactory('xretrocode', {
        createDebugAdapterTracker: session => ({
          onDidSendMessage: (message: any) => {
            if (message.type !== 'event') return;
            if (message.event === 'stopped') {
              this.pending = this.onStopped(session, message.body?.threadId);
            } else if (message.event === 'terminated' || message.event === 'continued') {
              this.clear();
            }
          },
          onWillReceiveMessage: (message: any) => {
            if (RESUMING_REQUESTS.has(message.command)) this.clear();
          },
          onWillStopSession: () => this.clear(),
        }),
      }),
    );
  }

  private async onStopped(session: vscode.DebugSession, threadId: number): Promise<void> {
    const seq = ++this.stopSeq;
    try {
      const trace = await session.customRequest('stackTrace', { threadId, startFrame: 0, levels: 1 });
      const frame = trace?.stackFrames?.[0];
      if (seq !== this.stopSeq) return;
      if (!frame?.source?.path || !frame.line || !isR65Path(frame.source.path)) {
        this.show(undefined, true);
        return;
      }
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(frame.source.path));
      if (seq !== this.stopSeq) return;
      const line = frame.line - 1;
      const macros = line < document.lineCount ? resolveMacroDefinitions(this.index, document, line) : [];
      this.show(macros.length > 0 ? { uri: document.uri, line, macros } : undefined, true);
    } catch {
      // No stack, or the source can't be opened: nothing to offer
      if (seq === this.stopSeq) this.clear();
    }
  }

  private show(stop: StoppedOnMacros | undefined, stopped = false): void {
    this.current = stop;
    this.stoppedElsewhere = stopped && !stop;
    void vscode.commands.executeCommand('setContext', STEP_INTO_CONTEXT_KEY, !!stop && !stop.steppedIn);
    if (!stop) {
      this.statusItem.hide();
      return;
    }
    const names = stop.macros.map(m => `${m.name}!`);
    this.statusItem.text = `$(symbol-misc) ${names[0]}${names.length > 1 ? ` +${names.length - 1}` : ''}`;
    this.statusItem.show();
  }

  private clear(): void {
    this.stopSeq++;
    this.pending = undefined;
    if (this.current || this.stoppedElsewhere) this.show(undefined);
  }

  /**
   * Peek the definitions of the macros on the stopped line — or on the
   * cursor's line when not stopped, or when run from the editor's context
   * menu (which passes the document's URI). Returns the locations shown.
   */
  async goToDefinition(arg?: unknown): Promise<vscode.Location[]> {
    const fromEditor = arg instanceof vscode.Uri;
    if (!fromEditor && this.pending) {
      await this.pending;
    }
    let stop = fromEditor ? undefined : this.current;
    if (!stop && (fromEditor || !this.stoppedElsewhere)) {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.languageId !== 'r65') return [];
      const line = editor.selection.active.line;
      const macros = resolveMacroDefinitions(this.index, editor.document, line);
      stop = macros.length > 0 ? { uri: editor.document.uri, line, macros } : undefined;
    }
    if (!stop) {
      void vscode.window.showInformationMessage('No macro invocation on this line.');
      return [];
    }

    const locations = stop.macros.flatMap(m => m.definitions.map(d => new vscode.Location(d.uri, d.selectionRange)));
    const document = await vscode.workspace.openTextDocument(stop.uri);
    const editor = await vscode.window.showTextDocument(document, { preserveFocus: false });
    const column = findMacroInvocations(document.lineAt(stop.line).text)[0]?.column ?? 0;
    const at = new vscode.Position(stop.line, column);
    editor.selection = new vscode.Selection(at, at);
    await vscode.commands.executeCommand('editor.action.peekLocations', document.uri, at, locations, 'peek');
    return locations;
  }

  /**
   * Step Into on a line that invokes macros. The debugger runs a macro as
   * one statement, so the first Step Into goes to the definition of the
   * outermost macro on the line instead; a second one steps as usual (the
   * line may call a function too).
   */
  async stepInto(): Promise<vscode.Location[]> {
    if (this.pending) {
      await this.pending;
    }
    const stop = this.current;
    if (!stop || stop.steppedIn) {
      await vscode.commands.executeCommand('workbench.action.debug.stepInto');
      return [];
    }

    stop.steppedIn = true;
    void vscode.commands.executeCommand('setContext', STEP_INTO_CONTEXT_KEY, false);

    const definitions = stop.macros[0].definitions;
    const locations = definitions.map(d => new vscode.Location(d.uri, d.selectionRange));
    if (definitions.length === 1) {
      const document = await vscode.workspace.openTextDocument(definitions[0].uri);
      await vscode.window.showTextDocument(document, {
        selection: definitions[0].selectionRange,
        preserveFocus: false,
      });
    } else {
      // Several candidates (e.g. an unresolved receiver): let the user pick
      const document = await vscode.workspace.openTextDocument(stop.uri);
      await vscode.window.showTextDocument(document);
      const at = new vscode.Position(stop.line, findMacroInvocations(document.lineAt(stop.line).text)[0]?.column ?? 0);
      await vscode.commands.executeCommand('editor.action.peekLocations', document.uri, at, locations, 'peek');
    }
    return locations;
  }

  dispose(): void {
    void vscode.commands.executeCommand('setContext', STEP_INTO_CONTEXT_KEY, false);
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
  }
}
