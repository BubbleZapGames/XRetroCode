import * as vscode from 'vscode';

/** ROM extensions Mesen can load, by console. */
export const ROM_EXTENSIONS = [
    'sfc', 'smc',          // SNES
    'nes', 'fds', 'unf',   // NES
    'gb', 'gbc',           // Game Boy
    'gba',                 // Game Boy Advance
    'pce', 'sgx',          // PC Engine
    'sms', 'gg',           // Master System / Game Gear
    'ws', 'wsc',           // WonderSwan
];

const ROM_GLOB = `**/*.{${ROM_EXTENSIONS.join(',')}}`;
const EXCLUDE_GLOB = '**/{node_modules,.git}/**';

/** ROMs in the workspace, build outputs first — that's usually the fresh one. */
export async function findRoms(): Promise<vscode.Uri[]> {
    const found = await vscode.workspace.findFiles(ROM_GLOB, EXCLUDE_GLOB);
    return [...found].sort((a, b) => {
        const aBuild = /(^|\/)(build|bin|out|dist)\//.test(a.fsPath) ? 0 : 1;
        const bBuild = /(^|\/)(build|bin|out|dist)\//.test(b.fsPath) ? 0 : 1;
        if (aBuild !== bBuild) return aBuild - bBuild;
        return a.fsPath.localeCompare(b.fsPath);
    });
}

export interface PickRomOptions {
    /** Skip the picker and return silently when exactly one ROM is in the workspace. */
    autoSelectSingle?: boolean;
}

/**
 * Resolve a ROM path: use the only workspace ROM, else offer a quick pick,
 * else fall back to a file dialog. Returns undefined if the user cancels.
 */
export async function pickRom(options: PickRomOptions = {}): Promise<string | undefined> {
    const roms = await findRoms();

    if (roms.length === 0) {
        return browseForRom();
    }
    if (roms.length === 1 && options.autoSelectSingle) {
        return roms[0].fsPath;
    }

    const BROWSE = '$(folder-opened) Browse for a ROM file...';
    const items = roms.map(uri => ({
        label: '$(file-binary) ' + baseName(uri.fsPath),
        description: vscode.workspace.asRelativePath
            ? vscode.workspace.asRelativePath(uri)
            : uri.fsPath,
        path: uri.fsPath,
    }));
    items.push({ label: BROWSE, description: '', path: '' });

    const choice = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select a ROM to debug',
        matchOnDescription: true,
    });
    if (!choice) return undefined;
    return choice.path ? choice.path : browseForRom();
}

async function browseForRom(): Promise<string | undefined> {
    const picked = await vscode.window.showOpenDialog({
        canSelectMany: false,
        openLabel: 'Debug this ROM',
        filters: { 'ROM files': ROM_EXTENSIONS, 'All files': ['*'] },
    });
    return picked && picked.length > 0 ? picked[0].fsPath : undefined;
}

function baseName(p: string): string {
    const i = p.lastIndexOf('/');
    return i >= 0 ? p.substring(i + 1) : p;
}
