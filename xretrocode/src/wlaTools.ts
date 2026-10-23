import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as https from 'https';
import * as path from 'path';
import { execFile } from 'child_process';
import { findOnPath } from './findOnPath';

/**
 * Where WLA-DX's wla-65816 and wlalink live, without the user editing PATH:
 * on Windows XRetroCode downloads the official release into its own storage;
 * elsewhere Homebrew's folder counts even when VS Code's PATH lacks it. Those
 * folders go on the PATH of XRetroCode's builds and of new terminals.
 */

export const WLA_TOOLS = ['wla-65816', 'wlalink'];
export const WLA_VERSION = 'v10.7';
const WLA_WIN64_NAME = `wla_dx_${WLA_VERSION}_Win64`;
/** The official Windows build: every assembler, wlalink.exe and its vcruntime140.dll */
export const WLA_WIN64_URL = `https://github.com/vhelin/wla-dx/releases/download/${WLA_VERSION}/${WLA_WIN64_NAME}.zip`;
export const WLA_WIN64_SHA256 = '82922a530ae989bd5f8057fa4cfef3d0022d7353b5aeb7858b9320eae9b56ebd';

/** Where Homebrew puts tools, on Apple silicon, Intel and Linux. */
function defaultBrewDirs(): string[] {
    return ['/opt/homebrew/bin', '/usr/local/bin', '/home/linuxbrew/.linuxbrew/bin'];
}

let brewDirsOverride: string[] | undefined;

/** Search these folders instead of Homebrew's (tests); undefined restores them. */
export function setExtraDirs(dirs: string[] | undefined): void {
    brewDirsOverride = dirs;
}

export function brewDirs(): string[] {
    return brewDirsOverride ?? defaultBrewDirs();
}

export function findInDirs(name: string, dirs: string[]): string | undefined {
    for(const dir of dirs) {
        const candidate = path.join(dir, name);
        if(fs.existsSync(candidate)) {
            return candidate;
        }
    }
    return undefined;
}

let storageDir: string | undefined;
let envCollection: vscode.EnvironmentVariableCollection | undefined;
let toolDirs: string[] = [];

/** At activation: remember the extension's storage, and put WLA-DX's folder on PATH. */
export function initWlaTools(context: vscode.ExtensionContext): void {
    storageDir = context.globalStorageUri.fsPath;
    envCollection = context.environmentVariableCollection;
    applyToolPath();
}

/** The folder XRetroCode unpacks WLA-DX into (Windows) */
export function managedWlaDir(): string | undefined {
    return storageDir && path.join(storageDir, 'wla-dx', WLA_VERSION, WLA_WIN64_NAME);
}

function hasTools(dir: string, platform: NodeJS.Platform): boolean {
    const ext = platform === 'win32' ? '.exe' : '';
    return WLA_TOOLS.every(tool => fs.existsSync(path.join(dir, tool + ext)));
}

/** The folders to add to PATH so WLA-DX runs; none when PATH already has it. */
export function wlaDirs(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string[] {
    if(WLA_TOOLS.every(tool => findOnPath(tool, env, platform))) {
        return [];
    }
    const managed = managedWlaDir();
    if(managed && hasTools(managed, platform)) {
        return [managed];
    }
    if(platform !== 'win32') {
        const brew = brewDirs().find(dir => hasTools(dir, platform));
        if(brew) return [brew];
    }
    return [];
}

/** Put wlaDirs() on the PATH of new terminals, and of the builds buildEnv() is given to. */
export function applyToolPath(): void {
    toolDirs = wlaDirs();
    if(!envCollection) return;
    if(toolDirs.length > 0) {
        // Replaces this collection's earlier PATH entry
        envCollection.prepend('PATH', toolDirs.join(path.delimiter) + path.delimiter);
    } else {
        envCollection.delete('PATH');
    }
}

/**
 * The environment for a build task, with WLA-DX's folder first on PATH, or
 * undefined when nothing needs adding. The terminal collection may not reach
 * task terminals, so XRetroCode's own tasks say it outright.
 */
export function buildEnv(env: NodeJS.ProcessEnv = process.env): { [key: string]: string } | undefined {
    if(toolDirs.length === 0) return undefined;
    // Windows spells it Path; keep the process's own spelling
    const key = Object.keys(env).find(k => k.toUpperCase() === 'PATH') ?? 'PATH';
    return { [key]: [...toolDirs, env[key] ?? ''].join(path.delimiter) };
}

/** What downloadWla fetches, how, and the hash it must have */
export interface WlaDownload {
    url: string;
    sha256: string;
    fetch: (url: string, dest: string) => Promise<void>;
    extract: (zip: string, dir: string) => Promise<void>;
}

/** GET url into dest, following GitHub's redirects to its download host. */
export function fetchFile(url: string, dest: string, redirects = 5): Promise<void> {
    return new Promise((resolve, reject) => {
        https.get(url, { headers: { 'User-Agent': 'xretrocode' } }, response => {
            const status = response.statusCode ?? 0;
            if(status >= 300 && status < 400 && response.headers.location && redirects > 0) {
                response.resume();
                fetchFile(new URL(response.headers.location, url).toString(), dest, redirects - 1).then(resolve, reject);
                return;
            }
            if(status !== 200) {
                response.resume();
                reject(new Error(`${url} answered ${status}`));
                return;
            }
            const file = fs.createWriteStream(dest);
            response.pipe(file);
            file.on('finish', () => file.close(() => resolve()));
            file.on('error', reject);
            response.on('error', reject);
        }).on('error', reject);
    });
}

/** Unzip with Windows' own tar.exe (bsdtar, Windows 10+); Git's GNU tar can't read zips. */
export function extractZip(zip: string, dir: string): Promise<void> {
    const systemTar = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
    const tar = fs.existsSync(systemTar) ? systemTar : 'tar';
    return new Promise((resolve, reject) => {
        execFile(tar, ['-xf', zip, '-C', dir], error => error ? reject(error) : resolve());
    });
}

export function sha256(data: Buffer): string {
    return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * Download the official Windows WLA-DX into extension storage, check it is
 * the release it should be, unpack it and put it on PATH. Throws, saying
 * why, when it can't.
 */
export const WLA_DOWNLOAD: WlaDownload = {
    url: WLA_WIN64_URL,
    sha256: WLA_WIN64_SHA256,
    fetch: fetchFile,
    extract: extractZip,
};

export async function downloadWla(download: WlaDownload = WLA_DOWNLOAD): Promise<void> {
    const target = managedWlaDir();
    if(!target) {
        throw new Error('XRetroCode has no storage folder to put it in');
    }
    const parent = path.dirname(target);
    await fs.promises.mkdir(parent, { recursive: true });
    const zip = path.join(parent, `${WLA_WIN64_NAME}.zip`);
    try {
        await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `Downloading WLA-DX ${WLA_VERSION}` },
            async () => {
                await download.fetch(download.url, zip);
                const hash = sha256(await fs.promises.readFile(zip));
                if(hash !== download.sha256) {
                    throw new Error(`the download isn't the WLA-DX ${WLA_VERSION} release (SHA-256 ${hash})`);
                }
                await download.extract(zip, parent);
            }
        );
    } finally {
        await fs.promises.rm(zip, { force: true });
    }
    if(!hasTools(target, 'win32')) {
        throw new Error(`the download has no ${WLA_TOOLS.map(t => t + '.exe').join(' or ')}`);
    }
    applyToolPath();
}
