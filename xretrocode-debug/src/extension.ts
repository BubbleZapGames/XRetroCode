import * as vscode from 'vscode';
import { DebugAdapterDescriptorFactory } from './debugAdapter';

export function activate(context: vscode.ExtensionContext) {
    const factory = new DebugAdapterDescriptorFactory();
    context.subscriptions.push(
        vscode.debug.registerDebugAdapterDescriptorFactory('xretrocode', factory)
    );
}

export function deactivate() {}
