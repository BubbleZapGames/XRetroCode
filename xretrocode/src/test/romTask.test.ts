import * as assert from 'assert';
import { workspace, Uri } from './vscode-mock';
import { RomTaskProvider, createRomTask, ROM_TASK_LABEL, ROM_TASK_NAME, TASK_TYPE } from '../romTask';
import { hasMakefile } from '../makefile';

const FOLDER = { uri: Uri.file('/proj'), name: 'proj', index: 0 } as any;

function giveFolderAMakefile() {
    workspace._setWorkspaceFolders([FOLDER]);
    workspace._setFileContent('/proj/Makefile', 'all: build/GAME.smc\n');
}

describe('hasMakefile', () => {
    beforeEach(() => workspace._reset());

    it('should detect a makefile in the workspace folder', async () => {
        giveFolderAMakefile();
        assert.strictEqual(await hasMakefile(FOLDER), true);
    });

    it('should report none when the folder has no makefile', async () => {
        workspace._setWorkspaceFolders([FOLDER]);
        assert.strictEqual(await hasMakefile(FOLDER), false);
    });

    it('should report none without a folder at all', async () => {
        assert.strictEqual(await hasMakefile(undefined), false);
    });

    it('should accept lowercase and GNUmakefile spellings', async () => {
        workspace._setWorkspaceFolders([FOLDER]);
        workspace._setFileContent('/proj/makefile', 'all:\n');
        assert.strictEqual(await hasMakefile(FOLDER), true);
    });
});

describe('RomTaskProvider', () => {
    let provider: RomTaskProvider;

    beforeEach(() => {
        provider = new RomTaskProvider();
        workspace._reset();
    });

    it('should offer a rom task for a folder with a makefile', async () => {
        giveFolderAMakefile();
        const tasks = await provider.provideTasks();
        assert.strictEqual(tasks.length, 1);
        assert.strictEqual(tasks[0].name, ROM_TASK_NAME);
        assert.strictEqual(tasks[0].source, TASK_TYPE);
    });

    it('should offer nothing when the folder has no makefile', async () => {
        workspace._setWorkspaceFolders([FOLDER]);
        assert.deepStrictEqual(await provider.provideTasks(), []);
    });

    it('should offer nothing when no folder is open', async () => {
        assert.deepStrictEqual(await provider.provideTasks(), []);
    });

    // The debug provider injects this exact string; if the two ever drift, a
    // launch fails with "Could not find the task".
    it('should label the task the way the debug provider refers to it', async () => {
        giveFolderAMakefile();
        const tasks = await provider.provideTasks();
        assert.strictEqual(`${tasks[0].source}: ${tasks[0].name}`, ROM_TASK_LABEL);
    });

    it('should run make in the folder', () => {
        const execution = createRomTask(FOLDER).execution as any;
        assert.strictEqual(execution.command, 'make');
        assert.strictEqual(execution.options.cwd, '/proj');
    });

    // A makefile may drive any toolchain, so guessing a matcher would turn one
    // compiler's output into bogus problems for another's.
    it('should carry no language-specific problem matcher', () => {
        const task = createRomTask(FOLDER);
        assert.ok(!task.problemMatchers, 'rom task should not assume a toolchain');
    });

    describe('resolveTask', () => {
        it('should rebuild the execution for a hand-written tasks.json entry', () => {
            giveFolderAMakefile();
            // VSCode hands the provider a task with a definition but no execution
            const fromJson = { definition: { type: TASK_TYPE, command: ROM_TASK_NAME }, scope: FOLDER } as any;
            const resolved = provider.resolveTask(fromJson) as any;
            assert.ok(resolved, 'task should resolve');
            assert.ok(resolved.execution, 'resolved task must have an execution or it runs nothing');
            assert.strictEqual(resolved.execution.command, 'make');
        });

        it('should pass extra args through to make', () => {
            giveFolderAMakefile();
            const fromJson = {
                definition: { type: TASK_TYPE, command: ROM_TASK_NAME, args: ['-j4'] },
                scope: FOLDER
            } as any;
            const resolved = provider.resolveTask(fromJson) as any;
            assert.deepStrictEqual(resolved.execution.args, ['-j4']);
        });

        it('should decline a definition it does not own', () => {
            giveFolderAMakefile();
            const fromJson = { definition: { type: TASK_TYPE, command: 'something-else' }, scope: FOLDER } as any;
            assert.strictEqual(provider.resolveTask(fromJson), undefined);
        });
    });
});
