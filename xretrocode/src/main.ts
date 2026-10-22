import * as vscode from 'vscode';
import { R65TaskProvider } from './tasks';
import { RomTaskProvider, TASK_TYPE } from './romTask';
import { R65SymbolIndex } from './symbolIndex';
import { R65DefinitionProvider } from './definitionProvider';
import { R65DocumentSymbolProvider } from './documentSymbolProvider';
import { R65HoverProvider } from './hoverProvider';
import { R65CompletionProvider } from './completionProvider';
import { R65ReferenceProvider } from './referenceProvider';
import { R65WorkspaceSymbolProvider } from './workspaceSymbolProvider';
import { MacroDefinitionAid } from './macroDefinitionAid';
import { DebugAdapterDescriptorFactory, setExtensionPath } from './debugAdapter';
import { ConfigurationProvider } from './debugConfiguration';
import { pickRom } from './romLocator';
import { registerToolchainCheck } from './toolchainSetup';
import { DisassemblyView } from './disassemblyView';
import { InstructionStepper } from './stepInstruction';

let taskProvider: vscode.Disposable | undefined;

export function activate(context: vscode.ExtensionContext) {
    setExtensionPath(context.extensionPath);
    activateLanguage(context);
    activateDebug(context);
}

// R65 language: tasks, symbol index, go-to-definition, outline, hover,
// completion, references, workspace symbols, toolchain setup
function activateLanguage(context: vscode.ExtensionContext) {
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
    context.subscriptions.push(
        vscode.languages.registerHoverProvider(selector, new R65HoverProvider(symbolIndex))
    );
    context.subscriptions.push(
        vscode.languages.registerCompletionItemProvider(selector, new R65CompletionProvider(symbolIndex), '.', ':')
    );
    context.subscriptions.push(
        vscode.languages.registerReferenceProvider(selector, new R65ReferenceProvider(symbolIndex))
    );
    context.subscriptions.push(
        vscode.languages.registerWorkspaceSymbolProvider(new R65WorkspaceSymbolProvider(symbolIndex))
    );
    // The debugger steps over macros; offer their definitions when stopped on one
    context.subscriptions.push(new MacroDefinitionAid(symbolIndex));
    // Offer to install r65c and WLA-DX when an R65 file is opened without them
    registerToolchainCheck(context);
}

// Mesen-GDB debug adapter
function activateDebug(context: vscode.ExtensionContext) {
    // Building the ROM is part of debugging, not of R65 language support — any
    // toolchain with a makefile, a ROM and a .dbg qualifies.
    context.subscriptions.push(
        vscode.tasks.registerTaskProvider(TASK_TYPE, new RomTaskProvider())
    );
    context.subscriptions.push(
        vscode.debug.registerDebugAdapterDescriptorFactory('xretrocode', new DebugAdapterDescriptorFactory())
    );
    context.subscriptions.push(
        vscode.debug.registerDebugConfigurationProvider('xretrocode', new ConfigurationProvider())
    );
    // Usable from launch.json as "romPath": "${command:xretrocode.pickRom}"
    context.subscriptions.push(
        vscode.commands.registerCommand('xretrocode.pickRom', () => pickRom())
    );
    // Run and Debug's "Disassembly": the instructions around the PC
    context.subscriptions.push(new DisassemblyView());
    // Step Instruction: one CPU instruction, from the toolbar or Alt+F11
    context.subscriptions.push(new InstructionStepper());
}

export function deactivate() {
    taskProvider?.dispose();
}
