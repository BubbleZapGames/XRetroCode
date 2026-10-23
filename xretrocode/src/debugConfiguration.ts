import * as vscode from 'vscode';
import { pickRom } from './romLocator';
import { locateMesenGdb, promptForMesenGdb } from './debugAdapter';
import { hasMakefile } from './makefile';
import { buildRom } from './romTask';
import { ensureMake } from './makeInstall';

export class ConfigurationProvider implements vscode.DebugConfigurationProvider {
    provideDebugConfigurations(folder: vscode.WorkspaceFolder | undefined, token?: vscode.CancellationToken): vscode.ProviderResult<vscode.DebugConfiguration[]> {
        return [
            {
                name: "Launch SNES ROM",
                type: "xretrocode",
                request: "launch",
                romPath: "${command:xretrocode.pickRom}",
                stopOnEntry: false
            }
        ];
    }

    async resolveDebugConfiguration(
        folder: vscode.WorkspaceFolder | undefined,
        debugConfiguration: vscode.DebugConfiguration,
        token?: vscode.CancellationToken
    ): Promise<vscode.DebugConfiguration | undefined | null> {
        // Build before launching, so the session debugs what the sources say
        // rather than whatever was last left in build/. This runs the task and
        // waits, instead of setting preLaunchTask: VSCode runs those after the
        // configuration is resolved, which is too late for the ROM lookup below
        // to see a freshly built file on a clean tree.
        const buildBeforeLaunch = vscode.workspace
            .getConfiguration('xretrocode')
            .get<boolean>('buildBeforeLaunch', true);
        if(buildBeforeLaunch && folder && await hasMakefile(folder)) {
            // Windows has no make of its own: offer to install it first
            if(!(await ensureMake())) {
                return undefined;
            }
            const exitCode = await buildRom(folder);
            if(exitCode !== 0 && exitCode !== undefined) {
                const DEBUG_ANYWAY = 'Debug Anyway';
                const choice = await vscode.window.showErrorMessage(
                    `Build failed (make exited with ${exitCode}).`,
                    { modal: true },
                    DEBUG_ANYWAY
                );
                if(choice !== DEBUG_ANYWAY) {
                    return undefined;
                }
            }
        }

        if(!debugConfiguration.romPath) {
            // No ROM configured — find one instead of making the user hand-edit
            // launch.json. Silent when the workspace has exactly one ROM.
            const romPath = await pickRom({ autoSelectSingle: true });
            if(!romPath) {
                // User cancelled — abort without an error popup.
                return undefined;
            }
            debugConfiguration.romPath = romPath;
        }

        // type/request are absent when F5 is pressed with no launch.json at all
        if(!debugConfiguration.type) {
            debugConfiguration.type = 'xretrocode';
            debugConfiguration.request = 'launch';
            debugConfiguration.name = 'Launch ROM';
        }

        // Surface a missing adapter here, where we can offer to fix it, rather
        // than as an opaque spawn failure once the session starts.
        if(!debugConfiguration.mesenDapPath && !locateMesenGdb()) {
            const chosen = await promptForMesenGdb();
            if(!chosen) {
                return undefined;
            }
            debugConfiguration.mesenDapPath = chosen;
        }

        return debugConfiguration;
    }
}
