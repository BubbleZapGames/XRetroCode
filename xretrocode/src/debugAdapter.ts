import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

export const MESEN_BINARY_NAME = 'mesen-gdb';

/** Prebuilt mesen-gdb binaries, offered when none is installed. */
export const MESEN_RELEASES_URL = 'https://github.com/BubbleZapGames/Mesen-GDB/releases';

/** Where this extension is installed; set at activation. */
let extensionPath: string | undefined;

export function setExtensionPath(p: string | undefined) {
    extensionPath = p;
}

const BUILD_FLAVOURS = ['Release', 'Debug'];

/** <root>/[Mesen-GDB/]bin/linux-x64/{Release,Debug}/mesen-gdb */
function buildCandidates(root: string): string[] {
    const out: string[] = [];
    for(const prefix of ['Mesen-GDB', '.']) {
        for(const flavour of BUILD_FLAVOURS) {
            out.push(path.join(root, prefix, 'bin', 'linux-x64', flavour, MESEN_BINARY_NAME));
        }
    }
    return out;
}

function searchPathEnv(): string | undefined {
    const raw = process.env.PATH;
    if(!raw) return undefined;
    for(const dir of raw.split(path.delimiter)) {
        if(!dir) continue;
        const candidate = path.join(dir, MESEN_BINARY_NAME);
        if(fs.existsSync(candidate)) {
            return candidate;
        }
    }
    return undefined;
}

/**
 * Locate the mesen-gdb binary, or undefined if it can't be found.
 * Order: launch.json override, setting, a build in the workspace,
 * then the usual install prefixes.
 */
export function locateMesenGdb(session?: vscode.DebugSession): string | undefined {
    const fromLaunch = session?.configuration?.mesenDapPath;
    if(fromLaunch) {
        return fromLaunch;
    }

    const config = vscode.workspace.getConfiguration('xretrocode');
    const pathFromConfig = config.get<string>('mesenDapPath');
    if(pathFromConfig) {
        return pathFromConfig;
    }

    // Release first — that is what plain `make` produces; Debug only exists
    // after `make DEBUG=1`.
    const roots: string[] = [];

    // The open workspace, in case the user is working inside the XRetroCode repo
    for(const folder of vscode.workspace.workspaceFolders ?? []) {
        roots.push(folder.uri.fsPath);
    }

    // Next to the extension itself — in a repo checkout Mesen-GDB is our sibling,
    // and the debugged game is usually a different workspace entirely.
    if(extensionPath) {
        roots.push(path.dirname(extensionPath));
        roots.push(path.dirname(path.dirname(extensionPath)));
        roots.push(extensionPath);
    }

    for(const root of roots) {
        for(const candidate of buildCandidates(root)) {
            if(fs.existsSync(candidate)) {
                return candidate;
            }
        }
    }

    const onPath = searchPathEnv();
    if(onPath) {
        return onPath;
    }

    for(const dir of ['/usr/local/bin', '/usr/bin', path.join(process.env.HOME ?? '', '.local', 'bin')]) {
        const candidate = path.join(dir, MESEN_BINARY_NAME);
        if(fs.existsSync(candidate)) {
            return candidate;
        }
    }

    return undefined;
}

/**
 * Ask the user to point at mesen-gdb and remember the answer, so this is a
 * one-time prompt rather than a hand-edited setting. Without a binary at all,
 * offer the releases page; the launch stops so they can retry once installed.
 */
export async function promptForMesenGdb(): Promise<string | undefined> {
    const LOCATE = 'Locate mesen-gdb...';
    const DOWNLOAD = 'Download mesen-gdb';
    const choice = await vscode.window.showErrorMessage(
        `Could not find the ${MESEN_BINARY_NAME} debug adapter. Download a release, build it with "make" in Mesen-GDB, or point XRetroCode at an existing build.`,
        LOCATE,
        DOWNLOAD
    );
    if(choice === DOWNLOAD) {
        await vscode.env.openExternal(vscode.Uri.parse(MESEN_RELEASES_URL));
        return undefined;
    }
    if(choice !== LOCATE) {
        return undefined;
    }

    const picked = await vscode.window.showOpenDialog({
        canSelectMany: false,
        openLabel: 'Use this binary',
        title: `Select the ${MESEN_BINARY_NAME} executable`,
    });
    if(!picked || picked.length === 0) {
        return undefined;
    }

    const chosen = picked[0].fsPath;
    await vscode.workspace.getConfiguration('xretrocode')
        .update('mesenDapPath', chosen, vscode.ConfigurationTarget.Global);
    return chosen;
}

export class DebugAdapterDescriptorFactory implements vscode.DebugAdapterDescriptorFactory {
    createDebugAdapterDescriptor(session: vscode.DebugSession, executable: vscode.DebugAdapterExecutable | undefined): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {
        // Fall through to a bare name so a binary on PATH still works
        const mesenDapPath = locateMesenGdb(session) ?? MESEN_BINARY_NAME;
        // Headless: no game window — for CI, remote sessions and tests
        const headless = !!session?.configuration?.headless;
        const args = headless ? ['--dap', '--headless'] : ['--dap'];
        // A session with a window uses Mesen's settings; a portable Mesen's
        // aren't where mesen-gdb looks by itself
        const mesenFolder = vscode.workspace.getConfiguration('xretrocode').get<string>('mesenFolder');
        if(!headless && mesenFolder) {
            args.push('--mesen-folder', mesenFolder);
        }
        return new vscode.DebugAdapterExecutable(mesenDapPath, args);
    }
}
