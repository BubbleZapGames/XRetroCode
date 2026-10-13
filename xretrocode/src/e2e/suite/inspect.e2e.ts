// Pause, and read threads, registers and expressions while stopped.
import * as assert from 'assert';
import {
  LINES, cleanUp, installTracker, mark, runTo, staysRunning, startSession, topFrame,
  waitForStopped,
} from './helpers';

describe('Pause and inspection', () => {
  before(installTracker);
  afterEach(cleanUp);

  it('pauses a running session and resumes it', async () => {
    const started = mark();
    const session = await startSession();
    assert.ok(await staysRunning(started, 500));

    const since = mark();
    await session.customRequest('pause', { threadId: 1 });
    const stopped = await waitForStopped('pause', since);

    const resumed = mark();
    await session.customRequest('continue', { threadId: stopped.body.threadId });
    assert.ok(await staysRunning(resumed, 500), 'continue should leave it running');
  });

  it('lists the SNES CPU and the sound CPU as threads', async () => {
    const { session } = await runTo(LINES.NMI);
    const { threads } = await session.customRequest('threads');
    const names = threads.map((t: { name: string }) => t.name);
    assert.ok(names.includes('SNES 65816'), JSON.stringify(names));
    assert.ok(names.includes('SNES SPC700'), JSON.stringify(names));
  });

  it('shows the program counter in the registers and to evaluate', async () => {
    const { session, threadId } = await runTo(LINES.NMI);
    const top = await topFrame(session, threadId);
    const address = parseInt(top.instructionPointerReference!, 16);

    const frameId = (await session.customRequest('stackTrace', { threadId })).stackFrames[0].id;
    const { scopes } = await session.customRequest('scopes', { frameId });
    const registers = scopes.find((s: { name: string }) => s.name === 'Registers');
    assert.ok(registers, `scopes: ${JSON.stringify(scopes)}`);
    const { variables } = await session.customRequest('variables', { variablesReference: registers.variablesReference });
    const pc = variables.find((v: { name: string }) => v.name === 'PC');
    // SNES PC reads "$BB:AAAA"; compare the address within the bank
    const pcValue = parseInt(pc.value.split(':').pop().replace('$', ''), 16);
    assert.strictEqual(pcValue, address & 0xFFFF, `PC ${pc.value} vs frame ${top.instructionPointerReference}`);

    const evaluated = await session.customRequest('evaluate', { expression: 'pc', frameId, context: 'watch' });
    assert.ok(evaluated.result.startsWith(`$${(address & 0xFFFF).toString(16).toUpperCase()}`), evaluated.result);
  });
});
