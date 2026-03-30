import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

export class DebugAdapterDescriptorFactory implements vscode.DebugAdapterDescriptorFactory {
    createDebugAdapterDescriptor(session: vscode.DebugSession, executable: vscode.DebugAdapterExecutable | undefined): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {
        const mesenDapPath = this.getMesenDapPath();
        
        return new vscode.DebugAdapterExecutable(mesenDapPath, ['--dap']);
    }

    private getMesenDapPath(): string {
        const config = vscode.workspace.getConfiguration('xretrocode');
        const pathFromConfig = config.get<string>('mesenDapPath');
        
        if(pathFromConfig) {
            return pathFromConfig;
        }
        
        // Check in the workspace folder
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if(workspaceFolders) {
            const possiblePaths = [
                path.join(workspaceFolders[0].uri.fsPath, 'Mesen-GDB', 'bin', 'linux-x64', 'Debug', 'mesen-gdb'),
                path.join(workspaceFolders[0].uri.fsPath, 'bin', 'linux-x64', 'Debug', 'mesen-gdb'),
                '/usr/local/bin/mesen-gdb',
            ];
            
            for(const p of possiblePaths) {
                if(fs.existsSync(p)) {
                    return p;
                }
            }
        }
        
        return 'mesen-gdb';
    }
}
