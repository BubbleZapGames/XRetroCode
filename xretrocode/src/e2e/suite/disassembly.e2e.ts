// Run and Debug's Disassembly view: mesen-gdb's instructions around the PC.
import * as assert from 'assert';
import { INSTRUCTIONS_BEFORE, Instruction, loadDisassembly } from '../../disassemblyView';
import { LINES, cleanUp, installTracker, runTo, topFrame } from './helpers';

const address = (i: Instruction) => parseInt(i.address, 16);
const length = (i: Instruction) => (i.instructionBytes ?? '').split(' ').filter(b => b).length;

describe('Disassembly view', () => {
  before(installTracker);
  afterEach(cleanUp);

  it('lists whole instructions before and after the PC', async () => {
    const { session, threadId } = await runTo(LINES.NMI);
    const listing = await loadDisassembly(session, threadId);
    assert.ok(listing, 'no listing');
    const { pc, instructions } = listing;
    assert.strictEqual(pc, (await topFrame(session, threadId)).instructionPointerReference);

    // About INSTRUCTIONS_BEFORE instructions lead up to it (a row that is no
    // instruction, like a data block, is left out); 10 bytes would be ~4
    const at = instructions.findIndex(i => address(i) === parseInt(pc, 16));
    assert.ok(at >= INSTRUCTIONS_BEFORE - 2 && at <= INSTRUCTIONS_BEFORE, `PC at row ${at}: ${JSON.stringify(instructions)}`);
    assert.ok(instructions.length > at + 1, 'nothing after the PC');

    // instructionOffset steps whole instructions: each one before the PC ends
    // where the next begins, so none starts mid-instruction
    for (let i = 0; i < at; i++) {
      assert.strictEqual(address(instructions[i]) + length(instructions[i]), address(instructions[i + 1]),
        `row ${i} does not reach row ${i + 1}: ${JSON.stringify(instructions.slice(0, at + 1))}`);
    }

    const direct = await session.customRequest('disassemble', { memoryReference: pc, instructionCount: 1 });
    assert.strictEqual(instructions[at].instruction, direct.instructions[0].instruction);
  });
});
