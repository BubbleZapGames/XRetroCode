import * as vscode from 'vscode';

export class ConfigurationProvider implements vscode.DebugConfigurationProvider {
    provideDebugConfigurations(folder: vscode.WorkspaceFolder | undefined, token?: vscode.CancellationToken): vscode.ProviderResult<vscode.DebugConfiguration[]> {
        return [
            {
                name: "Launch SNES ROM",
                type: "xretrocode",
                request: "launch",
                romPath: "",
                stopOnEntry: true
            }
        ];
    }

    resolveDebugConfiguration(folder: vscode.WorkspaceFolder | undefined, debugConfiguration: vscode.DebugConfiguration, token?: vscode.CancellationToken): vscode.ProviderResult<vscode.DebugConfiguration> {
        if(!debugConfiguration.romPath) {
            vscode.window.showErrorMessage("ROM path is required for XRetroCode debugging");
            return null;
        }
        return debugConfiguration;
    }
}
