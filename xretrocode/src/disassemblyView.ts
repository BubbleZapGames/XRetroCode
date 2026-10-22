import * as vscode from 'vscode';
import { RESUMING_REQUESTS } from './macroDefinitionAid';

export const DISASSEMBLY_VIEW_ID = 'xretrocode.disassembly';
/** Instructions shown before the PC; the rest of the listing follows it */
export const INSTRUCTIONS_BEFORE = 10;
export const INSTRUCTION_COUNT = 30;

/** A DAP DisassembledInstruction, as mesen-gdb sends it */
export interface Instruction {
  address: string;
  instruction: string;
  instructionBytes?: string;
  symbol?: string;
}

export interface Listing {
  /** The frame's instructionPointerReference, e.g. "0x808154" */
  pc: string;
  instructions: Instruction[];
}

/**
 * The instructions around a frame's PC (the top frame unless `frameId` names
 * another), from mesen-gdb's disassembly.
 */
export async function loadDisassembly(
  session: vscode.DebugSession, threadId: number, frameId?: number
): Promise<Listing | undefined> {
  const trace = await session.customRequest('stackTrace', {
    threadId, startFrame: 0, levels: frameId === undefined ? 1 : 64,
  });
  const frames: any[] = trace?.stackFrames ?? [];
  const frame = frameId === undefined ? frames[0] : frames.find(f => f.id === frameId);
  const pc: string | undefined = frame?.instructionPointerReference;
  if (!pc) return undefined;

  const dis = await session.customRequest('disassemble', {
    memoryReference: pc,
    instructionOffset: -INSTRUCTIONS_BEFORE,
    instructionCount: INSTRUCTION_COUNT,
  });
  return { pc, instructions: dis?.instructions ?? [] };
}

/** "0x8154" → "$8154", "0x808154" → "$80:8154" */
export function formatAddress(address: string): string {
  const value = parseInt(address, 16);
  if (isNaN(value)) return address;
  const hex = (n: number, width: number) => n.toString(16).toUpperCase().padStart(width, '0');
  return value > 0xFFFF ? `$${hex(value >> 16, 2)}:${hex(value & 0xFFFF, 4)}` : `$${hex(value, 4)}`;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
}

function sameAddress(a: string, b: string): boolean {
  return parseInt(a, 16) === parseInt(b, 16);
}

/** The listing as rows for the view: a label row above each named address, the PC's row marked. */
export function renderRows(listing: Listing): string {
  const rows: string[] = [];
  for (const instr of listing.instructions) {
    if (instr.symbol) {
      rows.push(`<div class="label">${escapeHtml(instr.symbol)}:</div>`);
    }
    const isPc = sameAddress(instr.address, listing.pc);
    rows.push(
      `<div class="row${isPc ? ' pc' : ''}">` +
      `<span class="arrow">${isPc ? '&#9654;' : ''}</span>` +
      `<span class="addr">${escapeHtml(formatAddress(instr.address))}</span>` +
      `<span class="bytes">${escapeHtml(instr.instructionBytes ?? '')}</span>` +
      `<span class="op">${escapeHtml(instr.instruction)}</span>` +
      '</div>'
    );
  }
  return rows.join('');
}

type ViewState =
  | { kind: 'idle' }
  | { kind: 'stopped'; rows: string }
  | { kind: 'running'; rows: string };

/**
 * "Disassembly" in Run and Debug: mesen-gdb's disassembly around the PC of
 * the stopped (or selected) frame, refreshed on every stop.
 */
export class DisassemblyView implements vscode.WebviewViewProvider, vscode.Disposable {
  private disposables: vscode.Disposable[] = [];
  private view: vscode.WebviewView | undefined;
  private state: ViewState = { kind: 'idle' };
  // Each stop bumps this, so a slow load for an older stop is dropped
  private loadSeq = 0;
  /** The load for the latest stop, while it runs */
  pending: Promise<void> | undefined;

  constructor() {
    this.disposables.push(
      vscode.window.registerWebviewViewProvider(DISASSEMBLY_VIEW_ID, this),
      vscode.debug.registerDebugAdapterTrackerFactory('xretrocode', {
        createDebugAdapterTracker: session => ({
          onDidSendMessage: (message: any) => {
            if (message.type !== 'event') return;
            if (message.event === 'stopped') {
              this.pending = this.load(session, message.body?.threadId);
            } else if (message.event === 'continued') {
              this.running();
            } else if (message.event === 'terminated') {
              this.clear();
            }
          },
          onWillReceiveMessage: (message: any) => {
            if (RESUMING_REQUESTS.has(message.command)) this.running();
          },
          onWillStopSession: () => this.clear(),
        }),
      }),
    );

    // A frame picked in Call Stack (VS Code 1.90+)
    const onActiveStackItem = vscode.debug.onDidChangeActiveStackItem;
    if (onActiveStackItem) {
      this.disposables.push(onActiveStackItem(item => {
        if (item && 'frameId' in item && item.session.type === 'xretrocode' && this.state.kind === 'stopped') {
          this.pending = this.load(item.session, item.threadId, item.frameId);
        }
      }));
    }
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = page(view.webview.cspSource);
    view.webview.onDidReceiveMessage(message => {
      if (message?.type === 'ready') this.post();
    });
    view.onDidDispose(() => {
      if (this.view === view) this.view = undefined;
    });
  }

  private async load(session: vscode.DebugSession, threadId: number, frameId?: number): Promise<void> {
    const seq = ++this.loadSeq;
    let rows = '';
    try {
      const listing = await loadDisassembly(session, threadId, frameId);
      if (listing) rows = renderRows(listing);
    } catch {
      // No frame, or no disassembly at its address: show an empty listing
    }
    if (seq !== this.loadSeq) return;
    this.state = { kind: 'stopped', rows };
    this.post();
  }

  private running(): void {
    this.loadSeq++;
    if (this.state.kind === 'running') return;
    this.state = { kind: 'running', rows: this.state.kind === 'stopped' ? this.state.rows : '' };
    this.post();
  }

  private clear(): void {
    this.loadSeq++;
    this.pending = undefined;
    this.state = { kind: 'idle' };
    this.post();
  }

  private post(): void {
    const state = this.state;
    const message =
      state.kind === 'idle' ? 'Not debugging.' :
      state.kind === 'running' ? 'Running…' :
      state.rows ? '' : 'No disassembly at this address.';
    void this.view?.webview.postMessage({
      type: 'show',
      rows: state.kind === 'idle' ? '' : state.rows,
      running: state.kind === 'running',
      message,
    });
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
  }
}

function nonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let i = 0; i < 32; i++) text += chars.charAt(Math.floor(Math.random() * chars.length));
  return text;
}

function page(cspSource: string): string {
  const n = nonce();
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'nonce-${n}'; script-src 'nonce-${n}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style nonce="${n}">
  body {
    padding: 0;
    font-family: var(--vscode-editor-font-family);
    font-size: var(--vscode-editor-font-size);
    color: var(--vscode-foreground);
  }
  #message { padding: 4px 12px; color: var(--vscode-descriptionForeground); font-family: var(--vscode-font-family); }
  #message:empty { display: none; }
  #rows.running { opacity: 0.5; }
  .row { display: flex; white-space: pre; padding: 0 4px; line-height: 1.5; }
  .row.pc { background: var(--vscode-editor-stackFrameHighlightBackground, rgba(255, 255, 0, 0.2)); }
  .arrow { width: 1.4em; flex: none; color: var(--vscode-debugIcon-stopForeground, var(--vscode-foreground)); }
  .addr { width: 6.5em; flex: none; color: var(--vscode-debugTokenExpression-number, var(--vscode-descriptionForeground)); }
  .bytes { width: 7.5em; flex: none; color: var(--vscode-descriptionForeground); }
  .op { flex: auto; }
  .label { padding: 4px 4px 0 calc(1.4em + 4px); color: var(--vscode-symbolIcon-functionForeground, var(--vscode-foreground)); }
</style>
</head>
<body>
<div id="message">Not debugging.</div>
<div id="rows"></div>
<script nonce="${n}">
  const vscode = acquireVsCodeApi();
  const rows = document.getElementById('rows');
  const message = document.getElementById('message');
  window.addEventListener('message', event => {
    const data = event.data;
    if (data.type !== 'show') return;
    message.textContent = data.message;
    rows.innerHTML = data.rows;
    rows.classList.toggle('running', data.running);
    const pc = rows.querySelector('.pc');
    if (pc && !data.running) pc.scrollIntoView({ block: 'center' });
  });
  vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
}
