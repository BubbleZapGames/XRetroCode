import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { execFileSync } from 'child_process';
import { findOnPath } from './findOnPath';

/** What r65.dev's setup guide has pip install. */
export const R65_PIP_SOURCE = 'git+https://github.com/BubbleZapGames/R65.git@release';
export const SETUP_DOCS_URL = 'https://r65.dev/docs/getting-started/setup';
/** Its installers include pip, which R65's install needs. */
export const PYTHON_DOWNLOAD_URL = 'https://www.python.org/downloads/';
/** Prebuilt WLA-DX, for machines without Homebrew. */
export const WLA_RELEASES_URL = 'https://github.com/vhelin/wla-dx/releases';
export const WLA_TOOLS = ['wla-65816', 'wlalink'];
/**
 * How R65 makefiles run the compiler: `python -m r65.compiler.main`. R65 is
 * installed when that runs, whether or not an r65c script is on PATH.
 */
export const PYTHON = 'python';
export const R65_MODULE = 'r65.compiler.main';

/** Set by "Don't Ask Again"; the setupToolchain command ignores it. */
export const DISMISSED_KEY = 'xretrocode.toolchainPromptDismissed';

export interface ToolchainStatus {
    /** `python -m r65.compiler.main` runs */
    r65: boolean;
    wla: boolean;
}

/**
 * Where Homebrew puts tools, on Apple silicon, Intel and Linux, which may not
 * be on VS Code's PATH.
 */
function defaultExtraDirs(): string[] {
    return [
        '/opt/homebrew/bin',
        '/usr/local/bin',
        '/home/linuxbrew/.linuxbrew/bin',
    ];
}

let extraDirsOverride: string[] | undefined;

/** Search these folders instead of the installers' usual ones (tests); undefined restores them. */
export function setExtraDirs(dirs: string[] | undefined): void {
    extraDirsOverride = dirs;
}

function extraDirs(): string[] {
    return extraDirsOverride ?? defaultExtraDirs();
}

/** `name` on PATH, else in an installer's usual folder. */
function findTool(name: string): string | undefined {
    return findOnPath(name) ?? findInDirs(name, extraDirs());
}

function findInDirs(name: string, dirs: string[]): string | undefined {
    for(const dir of dirs) {
        const candidate = path.join(dir, name);
        if(fs.existsSync(candidate)) {
            return candidate;
        }
    }
    return undefined;
}

/** Whether R65 (`python -m r65.compiler.main`) and WLA-DX can be run. */
export function checkToolchain(): ToolchainStatus {
    const python = findPython();
    const r65 = !!python && runsOk(python, ['-m', R65_MODULE, '--help']);
    const wla = WLA_TOOLS.every(tool => !!findOnPath(tool));
    return { r65, wla };
}

/** The `python` R65 makefiles run, skipping Windows' Microsoft Store placeholder. */
function findPython(): string | undefined {
    const python = findOnPath(PYTHON);
    return python && !isWindowsStoreStub(python) ? python : undefined;
}

function runsOk(command: string, args: string[]): boolean {
    try {
        execFileSync(command, args, { timeout: 15000, stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
}

export interface InstallStep {
    label: string;
    command: string;
    args: string[];
}

export interface InstallPlan {
    steps: InstallStep[];
    /** No Homebrew: WLA-DX has to be downloaded by hand */
    needsManualWla: boolean;
    /** No `python` with pip */
    needsPython: boolean;
}

/** The installers this machine has, by path. */
export interface Installers {
    brew?: string;
    /** The `python` R65 makefiles run */
    python?: string;
    /** Whether python has pip; Debian and Ubuntu's doesn't */
    hasPip?: boolean;
    /** In a virtualenv, where pip refuses --user */
    inVirtualEnv?: boolean;
}

/** Windows' python.exe placeholder, which opens the Microsoft Store */
export function isWindowsStoreStub(p: string): boolean {
    return /[\\/]WindowsApps[\\/]/i.test(p);
}

export function findInstallers(platform: NodeJS.Platform = process.platform): Installers {
    const python = findPython();
    return {
        brew: platform === 'win32' ? undefined : findTool('brew'),
        python,
        hasPip: python ? runsOk(python, ['-m', 'pip', '--version']) : undefined,
        inVirtualEnv: !!process.env.VIRTUAL_ENV,
    };
}

/** The setup guide's commands, for what's missing and what this machine has. */
export function installPlan(status: ToolchainStatus, installers: Installers): InstallPlan {
    const steps: InstallStep[] = [];
    let needsManualWla = false;
    let needsPython = false;

    if(!status.wla) {
        if(installers.brew) {
            steps.push({ label: 'WLA-DX', command: installers.brew, args: ['install', 'wla-dx'] });
        } else {
            needsManualWla = true;
        }
    }

    if(!status.r65) {
        // Into the python the makefiles run, so `python -m r65.compiler.main`
        // can import it (pipx's own environment can't be)
        if(installers.python && installers.hasPip) {
            const user = installers.inVirtualEnv ? [] : ['--user'];
            steps.push({
                label: 'R65',
                command: installers.python,
                args: ['-m', 'pip', 'install', ...user, R65_PIP_SOURCE],
            });
        } else {
            needsPython = true;
        }
    }

    return { steps, needsManualWla, needsPython };
}

function describeMissing(status: ToolchainStatus): string {
    const parts: string[] = [];
    if(!status.r65) parts.push(`R65 (${PYTHON} -m ${R65_MODULE})`);
    if(!status.wla) parts.push('WLA-DX (wla-65816, wlalink)');
    return parts.join(' and ');
}

/** Run one step in a terminal and wait for it; undefined if it couldn't start. */
export async function runStep(step: InstallStep): Promise<number | undefined> {
    const task = new vscode.Task(
        { type: 'xretrocode', command: 'setupToolchain' },
        vscode.workspace.workspaceFolders?.length ? vscode.TaskScope.Workspace : vscode.TaskScope.Global,
        `install ${step.label}`,
        'xretrocode',
        new vscode.ShellExecution(step.command, step.args)
    );
    const execution = await vscode.tasks.executeTask(task);
    return new Promise<number | undefined>(resolve => {
        const subscription = vscode.tasks.onDidEndTaskProcess(event => {
            if(event.execution === execution) {
                subscription.dispose();
                resolve(event.exitCode);
            }
        });
    });
}

/** Install what's missing, in a terminal, then say how it went. */
export async function installToolchain(status: ToolchainStatus = checkToolchain()): Promise<void> {
    const plan = installPlan(status, findInstallers());

    // One failure doesn't stop the rest: WLA-DX and R65 install separately
    const failed: string[] = [];
    const succeeded = new Set<string>();
    for(const step of plan.steps) {
        const exitCode = await runStep(step);
        if(exitCode === 0) {
            succeeded.add(step.label);
        } else {
            failed.push(step.label);
        }
    }

    if(plan.needsPython) {
        const PYTHON = 'Install Python';
        const GUIDE = 'Setup Guide';
        const choice = await vscode.window.showErrorMessage(
            `Installing R65 needs Python 3.10+ with pip, as "${PYTHON}" on your PATH (R65 makefiles run ` +
            `"${PYTHON} -m ${R65_MODULE}"; on Windows, tick "Add python.exe to PATH" in its installer). ` +
            'Install Python, restart VS Code, then run "XRetroCode: Install R65 Toolchain" again.',
            PYTHON,
            GUIDE
        );
        if(choice === PYTHON) await vscode.env.openExternal(vscode.Uri.parse(PYTHON_DOWNLOAD_URL));
        if(choice === GUIDE) await vscode.env.openExternal(vscode.Uri.parse(SETUP_DOCS_URL));
    }

    if(plan.needsManualWla) {
        const DOWNLOAD = 'Download WLA-DX';
        const choice = await vscode.window.showWarningMessage(
            'WLA-DX has no installer here without Homebrew. Download a release and put wla-65816 and wlalink on your PATH.',
            DOWNLOAD
        );
        if(choice === DOWNLOAD) await vscode.env.openExternal(vscode.Uri.parse(WLA_RELEASES_URL));
    }

    if(failed.length > 0) {
        const GUIDE = 'Setup Guide';
        const choice = await vscode.window.showErrorMessage(
            `Installing ${failed.join(' and ')} failed. See the terminal for why.`,
            GUIDE
        );
        if(choice === GUIDE) await vscode.env.openExternal(vscode.Uri.parse(SETUP_DOCS_URL));
    }
    if(succeeded.size === 0) {
        return;
    }

    const after = checkToolchain();
    if(failed.length === 0 && after.r65 && after.wla) {
        void vscode.window.showInformationMessage('The R65 toolchain is installed.');
        return;
    }
    if(succeeded.has('R65') && !after.r65) {
        void vscode.window.showWarningMessage(
            `R65 installed, but "${PYTHON} -m ${R65_MODULE}" still doesn't run. See the terminal, and the setup guide.`
        );
    }
    // Installed, but VS Code's PATH doesn't reach it
    const offPath = (succeeded.has('WLA-DX') && !after.wla ? WLA_TOOLS : [])
        .map(name => findInDirs(name, extraDirs()) ?? name);
    if(offPath.length > 0) {
        void vscode.window.showWarningMessage(
            `Installed, but ${offPath.join(', ')} isn't on VS Code's PATH. Add its folder to your PATH, then restart VS Code.`
        );
    }
}

/**
 * Offer to install R65 and WLA-DX the first time an R65 file is opened
 * without them. Once per window; never again after "Don't Ask Again".
 */
export function registerToolchainCheck(context: vscode.ExtensionContext): void {
    let checked = false;
    const check = (document: vscode.TextDocument) => {
        if(checked || document.languageId !== 'r65') return;
        checked = true;
        listener.dispose();
        void promptIfMissing(context);
    };
    const listener = vscode.workspace.onDidOpenTextDocument(check);
    context.subscriptions.push(listener);
    for(const document of vscode.workspace.textDocuments) {
        check(document);
    }

    context.subscriptions.push(
        vscode.commands.registerCommand('xretrocode.setupToolchain', async () => {
            const status = checkToolchain();
            if(status.r65 && status.wla) {
                void vscode.window.showInformationMessage('R65 and WLA-DX are already installed.');
                return;
            }
            await installToolchain(status);
        })
    );
}

export async function promptIfMissing(context: vscode.ExtensionContext): Promise<void> {
    if(!vscode.workspace.getConfiguration('xretrocode').get<boolean>('checkToolchain', true)) return;
    if(context.globalState.get<boolean>(DISMISSED_KEY)) return;
    const status = checkToolchain();
    if(status.r65 && status.wla) return;

    const INSTALL = 'Install';
    const GUIDE = 'Setup Guide';
    const NEVER = "Don't Ask Again";
    const choice = await vscode.window.showWarningMessage(
        `Building R65 needs ${describeMissing(status)}, which ${status.r65 || status.wla ? "isn't" : "aren't"} installed.`,
        INSTALL,
        GUIDE,
        NEVER
    );
    if(choice === INSTALL) {
        await installToolchain(status);
    } else if(choice === GUIDE) {
        await vscode.env.openExternal(vscode.Uri.parse(SETUP_DOCS_URL));
    } else if(choice === NEVER) {
        await context.globalState.update(DISMISSED_KEY, true);
    }
}
