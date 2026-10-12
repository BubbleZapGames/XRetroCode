import * as vscode from 'vscode';

export interface R65Config {
    compilerPath: string;
    includePaths: string[];
    targetPlatform: string;
    cfgOptions: string[];
}

export function getConfig(): R65Config {
    const config = vscode.workspace.getConfiguration('r65');
    return {
        compilerPath: config.get<string>('compilerPath', 'r65c'),
        includePaths: config.get<string[]>('includePaths', []),
        targetPlatform: config.get<string>('targetPlatform', 'snes'),
        cfgOptions: config.get<string[]>('cfgOptions', []),
    };
}
