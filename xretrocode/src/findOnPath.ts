import * as path from 'path';
import * as fs from 'fs';

/**
 * The first `name` in a PATH directory, or undefined. On Windows, also tries
 * each PATHEXT extension (mesen-gdb → mesen-gdb.exe).
 */
export function findOnPath(
    name: string,
    env: NodeJS.ProcessEnv = process.env,
    platform: NodeJS.Platform = process.platform
): string | undefined {
    const windows = platform === 'win32';
    // Windows spells it Path, and env lookups there ignore case
    const raw = windows ? (env.PATH ?? env.Path) : env.PATH;
    if(!raw) return undefined;
    const exts = windows
        ? ['', ...(env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(e => e)]
        : [''];
    for(const dir of raw.split(windows ? ';' : ':')) {
        if(!dir) continue;
        for(const ext of exts) {
            const candidate = path.join(dir, name + ext);
            if(isFile(candidate)) {
                return candidate;
            }
        }
    }
    return undefined;
}

function isFile(p: string): boolean {
    try {
        return fs.statSync(p).isFile();
    } catch {
        return false;
    }
}
