import * as vscode from 'vscode';
import { R65TaskProvider } from './tasks';

let taskProvider: vscode.Disposable | undefined;

export function activate(context: vscode.ExtensionContext) {
    taskProvider = vscode.tasks.registerTaskProvider('r65', new R65TaskProvider());
    context.subscriptions.push(taskProvider);
}

export function deactivate() {
    taskProvider?.dispose();
}
