import * as vscode from 'vscode';
import { getConfig, R65Config } from './config';

export class R65TaskProvider implements vscode.TaskProvider {
    provideTasks(): vscode.ProviderResult<vscode.Task[]> {
        const config = getConfig();
        return [
            this.createTask('build', 'Build R65 project', config, ['-o', '${fileDirname}/${fileBasenameNoExtension}.asm', '--debug']),
            this.createTask('check', 'Check R65 project', config, ['--stop-after', 'typeck']),
        ];
    }

    resolveTask(task: vscode.Task): vscode.ProviderResult<vscode.Task> {
        return task;
    }

    private createTask(name: string, detail: string, config: R65Config, extraArgs: string[]): vscode.Task {
        const args = ['${file}', ...extraArgs];

        for (const inc of config.includePaths) {
            args.push('--include', inc);
        }
        for (const cfg of config.cfgOptions) {
            args.push('--cfg', cfg);
        }

        const taskDef: vscode.TaskDefinition = { type: 'r65', command: name };
        const execution = new vscode.ShellExecution(config.compilerPath, args);
        const task = new vscode.Task(
            taskDef,
            vscode.TaskScope.Workspace,
            name,
            'r65',
            execution,
            '$r65c'
        );
        task.detail = detail;
        task.group = name === 'build' ? vscode.TaskGroup.Build : vscode.TaskGroup.Build;
        return task;
    }
}
