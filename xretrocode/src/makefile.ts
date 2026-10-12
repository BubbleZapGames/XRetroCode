import * as vscode from 'vscode';
import * as path from 'path';

/** Names GNU make looks for, in the order it looks for them. */
const MAKEFILE_NAMES = ['GNUmakefile', 'makefile', 'Makefile'];

/**
 * Whether the folder has a makefile.
 *
 * This is the whole contract for building a debuggable ROM: a makefile, a ROM
 * it produces, and a .dbg beside it. Which compiler runs in between is not our
 * business — R65, cc65, gcc and friends are all just `make` from here.
 *
 * An empty file counts as absent; an empty makefile builds nothing anyway.
 */
export async function hasMakefile(folder: vscode.WorkspaceFolder | undefined): Promise<boolean> {
    if(!folder) {
        return false;
    }
    for(const name of MAKEFILE_NAMES) {
        const uri = vscode.Uri.file(path.join(folder.uri.fsPath, name));
        try {
            const bytes = await vscode.workspace.fs.readFile(uri);
            if(Buffer.from(bytes).toString('utf8').trim()) {
                return true;
            }
        } catch {
            // Not this name — try the next.
        }
    }
    return false;
}
