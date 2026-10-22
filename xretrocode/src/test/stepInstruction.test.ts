import * as assert from 'assert';
import { commands, debug } from './vscode-mock';
import { InstructionStepper, STEP_INSTRUCTION_COMMAND } from '../stepInstruction';

function fakeSession(type = 'xretrocode', id = 'session-1') {
  const requests: { command: string; args: any }[] = [];
  return {
    id,
    type,
    requests,
    customRequest: async (command: string, args: any) => { requests.push({ command, args }); return {}; },
  };
}

describe('Step Instruction', () => {
  let stepper: InstructionStepper;
  beforeEach(() => {
    debug._reset();
    stepper = new InstructionStepper();
  });
  afterEach(() => stepper.dispose());

  /** Tell the stepper's tracker that `session` stopped on `threadId` */
  function stop(session: any, threadId: number) {
    const tracker = debug._trackerFactories[0].factory.createDebugAdapterTracker(session);
    tracker.onDidSendMessage({ type: 'event', event: 'stopped', body: { threadId, reason: 'breakpoint' } });
    return tracker;
  }

  it('steps one instruction on the thread that stopped', async () => {
    const session = fakeSession();
    stop(session, 1);
    debug._setActiveDebugSession(session);

    await commands._handlers.get(STEP_INSTRUCTION_COMMAND)!();
    assert.deepStrictEqual(session.requests, [{ command: 'stepIn', args: { threadId: 1, granularity: 'instruction' } }]);
  });

  it('does nothing without an xretrocode session', async () => {
    assert.strictEqual(await stepper.step(), false);

    const other = fakeSession('node');
    debug._setActiveDebugSession(other);
    assert.strictEqual(await stepper.step(), false);
    assert.deepStrictEqual(other.requests, []);
  });

  it('does nothing before the session has stopped, or after it ended', async () => {
    const session = fakeSession();
    debug._setActiveDebugSession(session);
    assert.strictEqual(await stepper.step(), false);

    stop(session, 1).onWillStopSession();
    assert.strictEqual(await stepper.step(), false);
    assert.deepStrictEqual(session.requests, []);
  });
});
