// Minimal VSCode API mock for unit testing
export namespace workspace {
    let _config: Record<string, any> = {};
    let _fileContents: Map<string, string> = new Map();

    export function getConfiguration(section?: string): any {
        return {
            get<T>(key: string, defaultValue?: T): T | undefined {
                const val = _config[`${section}.${key}`];
                return val !== undefined ? val as T : defaultValue;
            }
        };
    }

    export const workspaceFolders: any[] | undefined = undefined;

    export function findFiles(include: string, _exclude?: string): Promise<Uri[]> {
        // Return URIs for all files set via _setFileContent
        const uris: Uri[] = [];
        for (const path of _fileContents.keys()) {
            if (path.endsWith('.r65')) {
                uris.push(Uri.file(path));
            }
        }
        return Promise.resolve(uris);
    }

    export function createFileSystemWatcher(_glob: string): any {
        return {
            onDidCreate: () => ({ dispose: () => {} }),
            onDidChange: () => ({ dispose: () => {} }),
            onDidDelete: () => ({ dispose: () => {} }),
            dispose: () => {},
        };
    }

    export const fs = {
        readFile: (uri: any): Promise<Uint8Array> => {
            const path = uri.fsPath || uri.path || uri.toString();
            const content = _fileContents.get(path) || '';
            return Promise.resolve(new TextEncoder().encode(content));
        }
    };

    export function _setConfig(key: string, value: any) { _config[key] = value; }
    export function _setFileContent(path: string, content: string) { _fileContents.set(path, content); }
    export function _reset() { _config = {}; _fileContents.clear(); }
}

export namespace tasks {
    export function registerTaskProvider(type: string, provider: any): any {
        return { dispose: () => {} };
    }
}

export namespace languages {
    export function registerDefinitionProvider(_selector: any, _provider: any): any {
        return { dispose: () => {} };
    }
    export function registerDocumentSymbolProvider(_selector: any, _provider: any): any {
        return { dispose: () => {} };
    }
}

export namespace window {
    export function showErrorMessage(msg: string) { return Promise.resolve(undefined); }
    export function showInformationMessage(msg: string) { return Promise.resolve(undefined); }
}

export class Uri {
    readonly scheme: string;
    readonly path: string;
    readonly fsPath: string;

    private constructor(scheme: string, path: string) {
        this.scheme = scheme;
        this.path = path;
        this.fsPath = path;
    }

    static file(path: string): Uri {
        return new Uri('file', path);
    }

    static parse(value: string): Uri {
        return new Uri('file', value);
    }

    toString(): string {
        return `${this.scheme}://${this.path}`;
    }
}

export class Position {
    constructor(public readonly line: number, public readonly character: number) {}
}

export class Range {
    readonly start: Position;
    readonly end: Position;
    constructor(startLine: number, startChar: number, endLine: number, endChar: number);
    constructor(start: Position, end: Position);
    constructor(a: number | Position, b: number | Position, c?: number, d?: number) {
        if (typeof a === 'number') {
            this.start = new Position(a, b as number);
            this.end = new Position(c!, d!);
        } else {
            this.start = a;
            this.end = b as Position;
        }
    }
}

export class Location {
    constructor(public uri: Uri, public range: Range) {}
}

export class DocumentSymbol {
    public children: DocumentSymbol[] = [];
    constructor(
        public name: string,
        public detail: string,
        public kind: number,
        public range: Range,
        public selectionRange: Range
    ) {}
}

export const SymbolKind = {
    File: 0, Module: 1, Namespace: 2, Package: 3, Class: 4,
    Method: 5, Property: 6, Field: 7, Constructor: 8, Enum: 9,
    Interface: 10, Function: 11, Variable: 12, Constant: 13,
    String: 14, Number: 15, Boolean: 16, Array: 17, Object: 18,
    Key: 19, Null: 20, EnumMember: 21, Struct: 22, Event: 23,
    Operator: 24, TypeParameter: 25,
};

export class Disposable {
    constructor(private _callOnDispose: () => void) {}
    dispose() { this._callOnDispose(); }
    static from(...disposables: { dispose: () => any }[]): Disposable {
        return new Disposable(() => disposables.forEach(d => d.dispose()));
    }
}

export class ShellExecution {
    constructor(public command: string, public args?: string[]) {}
}

export class Task {
    public detail?: string;
    public group?: any;
    constructor(
        public definition: any,
        public scope: any,
        public name: string,
        public source: string,
        public execution: any,
        public problemMatchers?: string | string[]
    ) {}
}

export const TaskScope = { Workspace: 1, Global: 2 };
export const TaskGroup = { Build: { _id: 'build' }, Test: { _id: 'test' } };
export type ExtensionContext = { subscriptions: any[] };
export type TaskDefinition = { type: string; [key: string]: any };
export type TaskProvider = { provideTasks(): any; resolveTask(task: any): any };
export type ProviderResult<T> = T;
export type CancellationToken = { isCancellationRequested: boolean };
