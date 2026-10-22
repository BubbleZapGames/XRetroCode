import * as assert from 'assert';
import { window, debug } from './vscode-mock';
import {
  DisassemblyView, DISASSEMBLY_VIEW_ID, INSTRUCTION_COUNT, INSTRUCTIONS_BEFORE,
  formatAddress, renderRows,
} from '../disassemblyView';

const LISTING = {
  pc: '0x8154',
  instructions: [
    { address: '0x8151', instruction: 'STA $4200', instructionBytes: '8D 00 42' },
    { address: '0x8154', instruction: 'WAI', instructionBytes: 'CB', symbol: 'wait_frame' },
    { address: '0x8155', instruction: 'BRA $008154', instructionBytes: '80 FD' },
  ],
};

describe('formatAddress', () => {
  it('shows a bank only above $FFFF', () => {
    assert.strictEqual(formatAddress('0x8154'), '$8154');
    assert.strictEqual(formatAddress('0x808154'), '$80:8154');
    assert.strictEqual(formatAddress('0x7E0010'), '$7E:0010');
    assert.strictEqual(formatAddress('0x12'), '$0012');
  });
});

describe('renderRows', () => {
  it('marks the PC row, and only it', () => {
    const html = renderRows(LISTING);
    assert.strictEqual(html.match(/class="row pc"/g)?.length, 1);
    assert.ok(/class="row pc">.*?\$8154.*?WAI/.test(html), html);
  });

  it('puts a label row above a named instruction', () => {
    const html = renderRows(LISTING);
    assert.ok(html.indexOf('wait_frame:') < html.indexOf('WAI'), html);
    assert.ok(html.indexOf('STA $4200') < html.indexOf('wait_frame:'), html);
  });

  it('escapes what it shows', () => {
    const html = renderRows({ pc: '0x0', instructions: [{ address: '0x1', instruction: 'LDA <x>', symbol: 'a&b' }] });
    assert.ok(html.includes('LDA &#60;x&#62;'), html);
    assert.ok(html.includes('a&#38;b:'), html);
  });

  it('matches the PC whatever the hex spelling', () => {
    const html = renderRows({ pc: '0x808154', instructions: [{ address: '0x808154', instruction: 'WAI' }] });
    assert.ok(html.includes('class="row pc"'));
  });

  it('is empty for no instructions', () => {
    assert.strictEqual(renderRows({ pc: '0x8000', instructions: [] }), '');
  });
});

/** A webview view that records what the provider posts */
function fakeView() {
  const posted: any[] = [];
  let onMessage: (m: any) => void = () => {};
  const view = {
    webview: {
      options: {},
      html: '',
      cspSource: 'vscode-resource:',
      postMessage: (m: any) => { posted.push(m); return Promise.resolve(true); },
      onDidReceiveMessage: (cb: (m: any) => void) => { onMessage = cb; return { dispose() {} }; },
    },
    onDidDispose: () => ({ dispose() {} }),
  };
  return { view, posted, ready: () => onMessage({ type: 'ready' }) };
}

/** A session answering stackTrace and disassemble, recording the requests */
function fakeSession() {
  const requests: { command: string; args: any }[] = [];
  return {
    type: 'xretrocode',
    requests,
    customRequest: async (command: string, args: any) => {
      requests.push({ command, args });
      if (command === 'stackTrace') {
        return { stackFrames: [{ id: 65536, instructionPointerReference: '0x8154' }] };
      }
      if (command === 'disassemble') {
        return { instructions: LISTING.instructions };
      }
      return {};
    },
  };
}

describe('DisassemblyView', () => {
  let provider: DisassemblyView;
  beforeEach(() => {
    window._reset();
    debug._reset();
    provider = new DisassemblyView();
  });
  afterEach(() => provider.dispose());

  function setUp() {
    assert.deepStrictEqual(window._webviewViewProviders.map(p => p.id), [DISASSEMBLY_VIEW_ID]);
    const { view, posted, ready } = fakeView();
    provider.resolveWebviewView(view as any);
    ready();
    const session = fakeSession();
    const tracker = debug._trackerFactories[0].factory.createDebugAdapterTracker(session);
    return { view, posted, session, tracker };
  }

  it('says it is idle before a session stops', () => {
    const { view, posted } = setUp();
    assert.ok(view.webview.html.includes("script-src 'nonce-"), 'a CSP that only runs its own script');
    assert.deepStrictEqual(posted.pop(), { type: 'show', rows: '', running: false, message: 'Not debugging.' });
  });

  it('loads the instructions around the PC on a stop', async () => {
    const { posted, session, tracker } = setUp();
    tracker.onDidSendMessage({ type: 'event', event: 'stopped', body: { threadId: 1 } });
    await provider.pending;

    assert.deepStrictEqual(session.requests, [
      { command: 'stackTrace', args: { threadId: 1, startFrame: 0, levels: 1 } },
      { command: 'disassemble', args: { memoryReference: '0x8154', instructionOffset: -INSTRUCTIONS_BEFORE, instructionCount: INSTRUCTION_COUNT } },
    ]);
    const shown = posted.pop();
    assert.strictEqual(shown.running, false);
    assert.strictEqual(shown.message, '');
    assert.strictEqual(shown.rows, renderRows(LISTING));
  });

  it('keeps the listing, dimmed, while running, and clears it when the session ends', async () => {
    const { posted, tracker } = setUp();
    tracker.onDidSendMessage({ type: 'event', event: 'stopped', body: { threadId: 1 } });
    await provider.pending;

    tracker.onWillReceiveMessage({ type: 'request', command: 'continue' });
    const running = posted.pop();
    assert.strictEqual(running.running, true);
    assert.strictEqual(running.rows, renderRows(LISTING));
    assert.strictEqual(running.message, 'Running…');

    tracker.onWillStopSession();
    assert.deepStrictEqual(posted.pop(), { type: 'show', rows: '', running: false, message: 'Not debugging.' });
  });

  it('drops a load that a resume overtook', async () => {
    const { posted, tracker } = setUp();
    tracker.onDidSendMessage({ type: 'event', event: 'stopped', body: { threadId: 1 } });
    tracker.onWillReceiveMessage({ type: 'request', command: 'next' });
    await provider.pending;
    assert.strictEqual(posted.pop().running, true);
  });
});
