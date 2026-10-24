import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { findOnPath } from './findOnPath';
import { runStep } from './toolchainSetup';

/** GNU Make for Windows, as winget installs it */
export const WINGET_MAKE_ID = 'ezwinports.make';
export const WINGET_URL = 'https://aka.ms/getwinget';

/**
 * Where winget links the programs it installs, e.g. make.exe. winget adds
 * the folder to the user's PATH, but VS Code keeps the PATH it started with.
 */
function wingetLinks(env: NodeJS.ProcessEnv): string | undefined {
    return env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links') : undefined;
}

/**
 * Where winget unpacks ezwinports.make, e.g. Packages\ezwinports.make_<source>\bin\make.exe.
 * Without Developer Mode winget can't link it into Links, and puts this bin
 * folder on the user's PATH instead.
 */
function wingetPackageMake(env: NodeJS.ProcessEnv): string | undefined {
    if(!env.LOCALAPPDATA) return undefined;
    const packages = path.join(env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Packages');
    let dirs: string[];
    try {
        dirs = fs.readdirSync(packages);
    } catch {
        return undefined;
    }
    for(const dir of dirs) {
        if(!dir.startsWith(WINGET_MAKE_ID + '_')) continue;
        const make = path.join(packages, dir, 'bin', 'make.exe');
        if(fs.existsSync(make)) return make;
    }
    return undefined;
}

/** make on PATH, else (Windows) the one winget installed; undefined when there is none. */
export function findMake(
    env: NodeJS.ProcessEnv = process.env,
    platform: NodeJS.Platform = process.platform
): string | undefined {
    const onPath = findOnPath('make', env, platform);
    if(onPath || platform !== 'win32') {
        return onPath;
    }
    const links = wingetLinks(env);
    const linked = links && path.join(links, 'make.exe');
    if(linked && fs.existsSync(linked)) {
        return linked;
    }
    return wingetPackageMake(env);
}

/** What the ROM build runs: `make`, or winget's make.exe while VS Code's PATH can't see it. */
export function makeCommand(
    env: NodeJS.ProcessEnv = process.env,
    platform: NodeJS.Platform = process.platform
): string {
    if(platform !== 'win32' || findOnPath('make', env, platform)) {
        return 'make';
    }
    return findMake(env, platform) ?? 'make';
}

/**
 * Before a Windows build: if there is no make, offer to install it with
 * `winget install ezwinports.make`, and say whether the build can go ahead.
 */
export async function ensureMake(
    env: NodeJS.ProcessEnv = process.env,
    platform: NodeJS.Platform = process.platform
): Promise<boolean> {
    if(platform !== 'win32' || findMake(env, platform)) {
        return true;
    }

    const INSTALL = 'Install';
    const choice = await vscode.window.showWarningMessage(
        `Building the ROM needs make, which isn't installed. Install it with "winget install ${WINGET_MAKE_ID}"?`,
        { modal: true },
        INSTALL
    );
    if(choice !== INSTALL) {
        return false;
    }

    const winget = findOnPath('winget', env, platform);
    if(!winget) {
        const GET = 'Get winget';
        const answer = await vscode.window.showErrorMessage(
            'winget, which installs make, isn\'t available. Install App Installer (winget) from Microsoft, then launch again.',
            GET
        );
        if(answer === GET) await vscode.env.openExternal(vscode.Uri.parse(WINGET_URL));
        return false;
    }

    const exitCode = await runStep({ label: 'make', command: winget, args: ['install', WINGET_MAKE_ID] });
    if(exitCode !== 0) {
        void vscode.window.showErrorMessage('Installing make failed. See the terminal for why.');
        return false;
    }
    if(!findMake(env, platform)) {
        void vscode.window.showWarningMessage('make is installed, but VS Code can\'t find it yet. Restart VS Code, then launch again.');
        return false;
    }
    return true;
}
