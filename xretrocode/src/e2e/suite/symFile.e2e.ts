// Debug with a WLA-DX .sym instead of a .dbg: labels name the code.
import * as assert from 'assert';
import * as path from 'path';
import { WORKSPACE, cleanUp, installTracker, mark, startSession, topFrame, waitForStopped } from './helpers';

describe('WLA-DX symbol files', () => {
  before(installTracker);
  afterEach(cleanUp);

  it('names frames and disassembly from the .sym labels', async () => {
    const since = mark();
    const session = await startSession({ dbgPath: path.join(WORKSPACE, 'green.sym'), stopOnEntry: true });
    const stopped = await waitForStopped('entry', since);
    const threadId = stopped.body.threadId as number;

    const top = await topFrame(session, threadId);
    assert.strictEqual(top.name, 'init_reset');

    const dis = await session.customRequest('disassemble', { memoryReference: '0x8000', instructionCount: 6 });
    const clearVram = dis.instructions.find((i: any) => i.address === '0x8001');
    assert.strictEqual(clearVram?.symbol, 'clear_vram', JSON.stringify(dis.instructions));
  });
});
