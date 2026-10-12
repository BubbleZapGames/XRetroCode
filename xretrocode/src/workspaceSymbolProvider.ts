import * as vscode from 'vscode';
import { R65SymbolIndex } from './symbolIndex';
import { mapKind } from './documentSymbolProvider';

/** Whether `query`'s characters appear in `name` in order, ignoring case. */
function fuzzyMatch(query: string, name: string): boolean {
  let q = 0;
  const lowerName = name.toLowerCase();
  for (let i = 0; i < lowerName.length && q < query.length; i++) {
    if (lowerName[i] === query[q]) q++;
  }
  return q === query.length;
}

export class R65WorkspaceSymbolProvider implements vscode.WorkspaceSymbolProvider {
  constructor(private index: R65SymbolIndex) {}

  provideWorkspaceSymbols(
    query: string,
    _token: vscode.CancellationToken
  ): vscode.ProviderResult<vscode.SymbolInformation[]> {
    const q = query.toLowerCase();
    return this.index.allSymbols()
      .filter(s => fuzzyMatch(q, s.name))
      .map(s => new vscode.SymbolInformation(
        s.name, mapKind(s.kind), s.container ?? '', new vscode.Location(s.uri, s.selectionRange)
      ));
  }
}
