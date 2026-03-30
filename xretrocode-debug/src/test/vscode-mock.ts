// Minimal VSCode API mock for unit testing
// Only stubs the interfaces used by our extension code

export namespace workspace {
  let _config: Record<string, any> = {};
  let _workspaceFolders: any[] | undefined = undefined;

  export function getConfiguration(section?: string): any {
    return {
      get<T>(key: string): T | undefined {
        return _config[`${section}.${key}`] as T;
      }
    };
  }

  export const workspaceFolders = _workspaceFolders;

  // Test helpers
  export function _setConfig(key: string, value: any) {
    _config[key] = value;
  }

  export function _setWorkspaceFolders(folders: any[] | undefined) {
    (_workspaceFolders as any) = folders;
    (workspace as any).workspaceFolders = folders;
  }

  export function _reset() {
    _config = {};
    _setWorkspaceFolders(undefined);
  }
}

export namespace window {
  export const _messages: string[] = [];

  export function showErrorMessage(message: string): Thenable<string | undefined> {
    _messages.push(message);
    return Promise.resolve(undefined);
  }

  export function _reset() {
    _messages.length = 0;
  }
}

export namespace debug {
  export function registerDebugAdapterDescriptorFactory(type: string, factory: any): any {
    return { dispose: () => {} };
  }
}

// Stub types
export class DebugAdapterExecutable {
  constructor(public command: string, public args?: string[]) {}
}

export type DebugAdapterDescriptor = any;
export type DebugSession = any;
export type ProviderResult<T> = T;
export type ExtensionContext = { subscriptions: any[] };
export type DebugConfiguration = Record<string, any>;
export type WorkspaceFolder = { uri: { fsPath: string } };
export type CancellationToken = any;

export interface DebugAdapterDescriptorFactory {
  createDebugAdapterDescriptor(session: any, executable: any): any;
}

export interface DebugConfigurationProvider {
  provideDebugConfigurations?(folder: any, token?: any): any;
  resolveDebugConfiguration?(folder: any, config: any, token?: any): any;
}
