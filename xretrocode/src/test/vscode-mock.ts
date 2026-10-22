// Minimal VSCode API mock for unit testing
export namespace workspace {
    let _config: Record<string, any> = {};
    let _fileContents: Map<string, string> = new Map();

    export function getConfiguration(section?: string): any {
        return {
            get<T>(key: string, defaultValue?: T): T | undefined {
                const val = _config[`${section}.${key}`];
                return val !== undefined ? val as T : defaultValue;
            },
            update(key: string, value: any, _target?: any): Promise<void> {
                _config[`${section}.${key}`] = value;
                _updates.push({ key: `${section}.${key}`, value, target: _target });
                return Promise.resolve();
            }
        };
    }

    export const _updates: { key: string; value: any; target: any }[] = [];

    export let workspaceFolders: any[] | undefined = undefined;

    // Open editors' documents, for providers that prefer unsaved text
    export const textDocuments: any[] = [];

    let _openHandlers: ((document: any) => void)[] = [];
    export function onDidOpenTextDocument(handler: (document: any) => void): any {
        _openHandlers.push(handler);
        return { dispose: () => { _openHandlers = _openHandlers.filter(h => h !== handler); } };
    }
    export function _openDocument(document: any) {
        for(const handler of [..._openHandlers]) handler(document);
    }

    export function findFiles(include: string, _exclude?: string): Promise<Uri[]> {
        // Honour the extensions named by the glob: **/*.r65 or **/*.{sfc,smc,...}
        const braces = include.match(/\{([^}]*)\}/);
        const exts = braces
            ? braces[1].split(',').map(e => '.' + e.trim())
            : [include.substring(include.lastIndexOf('.'))];
        const uris: Uri[] = [];
        for (const path of _fileContents.keys()) {
            if (exts.some(e => path.endsWith(e))) {
                uris.push(Uri.file(path));
            }
        }
        return Promise.resolve(uris);
    }

    export function asRelativePath(uri: any): string {
        const p = typeof uri === 'string' ? uri : (uri.fsPath || uri.path);
        return p.replace(/^\/test\//, '');
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
    export function _setWorkspaceFolders(folders: any[] | undefined) { workspaceFolders = folders; }
    export function _reset() { _config = {}; _fileContents.clear(); workspaceFolders = undefined; _updates.length = 0; textDocuments.length = 0; _openHandlers = []; }
}

export namespace tasks {
    let _endHandlers: ((event: any) => void)[] = [];
    let _exitCode: number | undefined = 0;

    export const _executed: any[] = [];

    export function registerTaskProvider(type: string, provider: any): any {
        return { dispose: () => {} };
    }

    export function executeTask(task: any): Promise<any> {
        const execution = { task };
        _executed.push(task);
        // The real API reports completion later; a macrotask keeps the caller's
        // onDidEndTaskProcess subscription ahead of the event.
        setTimeout(() => {
            for(const handler of [..._endHandlers]) {
                handler({ execution, exitCode: _exitCode });
            }
        }, 0);
        return Promise.resolve(execution);
    }

    export function onDidEndTaskProcess(handler: (event: any) => void): any {
        _endHandlers.push(handler);
        return { dispose: () => { _endHandlers = _endHandlers.filter(h => h !== handler); } };
    }

    export function _setExitCode(code: number | undefined) { _exitCode = code; }
    export function _reset() { _endHandlers = []; _executed.length = 0; _exitCode = 0; }
}

export namespace languages {
    export function registerDefinitionProvider(_selector: any, _provider: any): any {
        return { dispose: () => {} };
    }
    export function registerDocumentSymbolProvider(_selector: any, _provider: any): any {
        return { dispose: () => {} };
    }
    export function registerHoverProvider(_selector: any, _provider: any): any {
        return { dispose: () => {} };
    }
    export function registerCompletionItemProvider(_selector: any, _provider: any, ..._triggers: string[]): any {
        return { dispose: () => {} };
    }
    export function registerReferenceProvider(_selector: any, _provider: any): any {
        return { dispose: () => {} };
    }
    export function registerWorkspaceSymbolProvider(_provider: any): any {
        return { dispose: () => {} };
    }
}

export namespace env {
    export const _opened: Uri[] = [];
    export function openExternal(uri: Uri): Promise<boolean> {
        _opened.push(uri);
        return Promise.resolve(true);
    }
    export function _reset() { _opened.length = 0; }
}

export namespace window {
    export const _messages: string[] = [];

    let _errorChoice: any = undefined;

    export function showErrorMessage(msg: string, ..._items: any[]) {
        _messages.push(msg);
        return Promise.resolve(_errorChoice);
    }

    export function _setErrorMessageChoice(choice: any) { _errorChoice = choice; }
    export function showInformationMessage(msg: string, ..._items: any[]) {
        _messages.push(msg);
        return Promise.resolve(undefined);
    }

    let _warningChoice: any = undefined;
    export const _warnings: { msg: string; items: any[] }[] = [];
    export function showWarningMessage(msg: string, ...items: any[]) {
        _messages.push(msg);
        _warnings.push({ msg, items });
        return Promise.resolve(_warningChoice);
    }
    export function _setWarningMessageChoice(choice: any) { _warningChoice = choice; }

    // Scripted responses for the ROM picker
    let _quickPickResult: any = undefined;
    let _openDialogResult: any[] | undefined = undefined;
    export const _quickPickCalls: any[][] = [];
    export const _openDialogCalls: any[] = [];

    export function showQuickPick(items: any[], _options?: any): Promise<any> {
        _quickPickCalls.push(items);
        return Promise.resolve(_quickPickResult);
    }

    export function showOpenDialog(options?: any): Promise<any[] | undefined> {
        _openDialogCalls.push(options);
        return Promise.resolve(_openDialogResult);
    }

    export function _setQuickPickResult(result: any) { _quickPickResult = result; }
    export function _setOpenDialogResult(result: any[] | undefined) { _openDialogResult = result; }

    export function _reset() {
        _messages.length = 0;
        _errorChoice = undefined;
        _warningChoice = undefined;
        _warnings.length = 0;
        _quickPickResult = undefined;
        _openDialogResult = undefined;
        _quickPickCalls.length = 0;
        _openDialogCalls.length = 0;
    }
}

export const ConfigurationTarget = { Global: 1, Workspace: 2, WorkspaceFolder: 3 };

export namespace commands {
    export const _registered: string[] = [];
    export function registerCommand(id: string, _handler: any): any {
        _registered.push(id);
        return { dispose: () => {} };
    }
}

export namespace debug {
    export function registerDebugAdapterDescriptorFactory(_type: string, _factory: any): any {
        return { dispose: () => {} };
    }
    export function registerDebugConfigurationProvider(_type: string, _provider: any): any {
        return { dispose: () => {} };
    }
}

export class DebugAdapterExecutable {
    constructor(public command: string, public args?: string[]) {}
}

export type DebugAdapterDescriptor = any;
export type DebugSession = any;
export type DebugConfiguration = Record<string, any>;
export type WorkspaceFolder = { uri: { fsPath: string } };

export interface DebugAdapterDescriptorFactory {
    createDebugAdapterDescriptor(session: any, executable: any): any;
}

export interface DebugConfigurationProvider {
    provideDebugConfigurations?(folder: any, token?: any): any;
    resolveDebugConfiguration?(folder: any, config: any, token?: any): any;
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

export class MarkdownString {
    constructor(public value: string = '') {}
    appendText(text: string): MarkdownString { this.value += text; return this; }
    appendMarkdown(text: string): MarkdownString { this.value += text; return this; }
    appendCodeblock(code: string, language = ''): MarkdownString {
        this.value += '\n```' + language + '\n' + code + '\n```\n';
        return this;
    }
}

export class Hover {
    constructor(public contents: MarkdownString, public range?: Range) {}
}

export const CompletionItemKind = {
    Text: 0, Method: 1, Function: 2, Constructor: 3, Field: 4, Variable: 5,
    Class: 6, Interface: 7, Module: 8, Property: 9, Unit: 10, Value: 11,
    Enum: 12, Keyword: 13, Snippet: 14, Color: 15, File: 16, Reference: 17,
    Folder: 18, EnumMember: 19, Constant: 20, Struct: 21, Event: 22,
    Operator: 23, TypeParameter: 24,
};

export class CompletionItem {
    detail?: string;
    documentation?: MarkdownString;
    constructor(public label: string, public kind?: number) {}
}

export class SymbolInformation {
    constructor(
        public name: string,
        public kind: number,
        public containerName: string,
        public location: Location
    ) {}
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
    constructor(
        public command: string,
        public args?: string[],
        public options?: { cwd?: string }
    ) {}
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
