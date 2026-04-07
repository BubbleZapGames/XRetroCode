import * as vscode from 'vscode';
import { R65TaskProvider } from './tasks';
import { R65SymbolIndex } from './symbolIndex';
import { R65DefinitionProvider } from './definitionProvider';
import { R65DocumentSymbolProvider } from './documentSymbolProvider';

let taskProvider: vscode.Disposable | undefined;

export function activate(context: vscode.ExtensionContext) {
    taskProvider = vscode.tasks.registerTaskProvider('r65', new R65TaskProvider());
    context.subscriptions.push(taskProvider);

    const symbolIndex = new R65SymbolIndex();
    context.subscriptions.push(symbolIndex);

    symbolIndex.initialize();
    context.subscriptions.push(symbolIndex.startWatching());

    const selector: vscode.DocumentSelector = { language: 'r65', scheme: 'file' };
    context.subscriptions.push(
        vscode.languages.registerDefinitionProvider(selector, new R65DefinitionProvider(symbolIndex))
    );
    context.subscriptions.push(
        vscode.languages.registerDocumentSymbolProvider(selector, new R65DocumentSymbolProvider())
    );
}

export function deactivate() {
    taskProvider?.dispose();
}
