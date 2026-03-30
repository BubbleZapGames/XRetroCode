// Minimal VSCode API mock for unit testing
export namespace workspace {
    let _config: Record<string, any> = {};

    export function getConfiguration(section?: string): any {
        return {
            get<T>(key: string, defaultValue?: T): T | undefined {
                const val = _config[`${section}.${key}`];
                return val !== undefined ? val as T : defaultValue;
            }
        };
    }

    export const workspaceFolders: any[] | undefined = undefined;

    export function _setConfig(key: string, value: any) { _config[key] = value; }
    export function _reset() { _config = {}; }
}

export namespace tasks {
    export function registerTaskProvider(type: string, provider: any): any {
        return { dispose: () => {} };
    }
}

export namespace window {
    export function showErrorMessage(msg: string) { return Promise.resolve(undefined); }
    export function showInformationMessage(msg: string) { return Promise.resolve(undefined); }
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
export type Disposable = { dispose(): void };
export type ExtensionContext = { subscriptions: any[] };
export type TaskDefinition = { type: string; [key: string]: any };
export type TaskProvider = { provideTasks(): any; resolveTask(task: any): any };
export type ProviderResult<T> = T;
