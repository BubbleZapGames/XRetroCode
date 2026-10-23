import * as vscode from 'vscode';
import { hasMakefile } from './makefile';
import { makeCommand } from './makeInstall';
import { buildEnv } from './wlaTools';

export const TASK_TYPE = 'xretrocode';
export const ROM_TASK_NAME = 'rom';
/** VSCode labels a provider task "<source>: <name>". */
export const ROM_TASK_LABEL = `${TASK_TYPE}: ${ROM_TASK_NAME}`;

/**
 * `make` in a workspace folder.
 *
 * No problem matcher: the makefile may drive any toolchain, and guessing wrong
 * turns another compiler's output into bogus entries in the Problems panel.
 * Build output goes to the task terminal.
 */
export function createRomTask(
    folder: vscode.WorkspaceFolder,
    definition?: vscode.TaskDefinition
): vscode.Task {
    const taskDef: vscode.TaskDefinition = definition ?? { type: TASK_TYPE, command: ROM_TASK_NAME };
    const args: string[] = definition?.args ?? [];
    const execution = new vscode.ShellExecution(makeCommand(), args, { cwd: folder.uri.fsPath, env: buildEnv() });
    const task = new vscode.Task(
        taskDef,
        folder,
        ROM_TASK_NAME,
        TASK_TYPE,
        execution
    );
    task.detail = 'Build the ROM (make)';
    task.group = vscode.TaskGroup.Build;
    return task;
}

export class RomTaskProvider implements vscode.TaskProvider {
    async provideTasks(): Promise<vscode.Task[]> {
        const tasks: vscode.Task[] = [];
        for(const folder of vscode.workspace.workspaceFolders ?? []) {
            if(await hasMakefile(folder)) {
                tasks.push(createRomTask(folder));
            }
        }
        return tasks;
    }

    resolveTask(task: vscode.Task): vscode.ProviderResult<vscode.Task> {
        // A task written by hand in tasks.json arrives with its definition but
        // no execution, so it has to be rebuilt here — returning it unchanged
        // yields a task that silently runs nothing.
        if(task.definition.command !== ROM_TASK_NAME) {
            return undefined;
        }
        const folder = folderOf(task);
        return folder ? createRomTask(folder, task.definition) : undefined;
    }
}

function folderOf(task: vscode.Task): vscode.WorkspaceFolder | undefined {
    const scope = task.scope as vscode.WorkspaceFolder | undefined;
    if(scope && typeof scope === 'object' && 'uri' in scope) {
        return scope;
    }
    return (vscode.workspace.workspaceFolders ?? [])[0];
}

/**
 * Run the ROM build and wait for it.
 *
 * The debug session needs this to finish before it looks for the ROM, and a
 * preLaunchTask cannot do that: VSCode runs those *after* the configuration is
 * resolved, so on a clean tree the ROM would still be missing at the moment we
 * search for it.
 *
 * Returns the exit code, or undefined if the task could not be started.
 */
export async function buildRom(folder: vscode.WorkspaceFolder): Promise<number | undefined> {
    const execution = await vscode.tasks.executeTask(createRomTask(folder));
    return new Promise<number | undefined>(resolve => {
        const subscription = vscode.tasks.onDidEndTaskProcess(event => {
            if(event.execution === execution) {
                subscription.dispose();
                resolve(event.exitCode);
            }
        });
    });
}
