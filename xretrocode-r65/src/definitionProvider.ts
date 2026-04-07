import * as vscode from 'vscode';
import { R65SymbolIndex } from './symbolIndex';

export class R65DefinitionProvider implements vscode.DefinitionProvider {
  constructor(private index: R65SymbolIndex) {}

  provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position,
    _token: vscode.CancellationToken
  ): vscode.ProviderResult<vscode.Definition> {
    const wordRange = document.getWordRangeAtPosition(position, /[a-zA-Z_][a-zA-Z0-9_]*/);
    if (!wordRange) return undefined;

    const word = document.getText(wordRange);
    const symbols = this.index.lookup(word);

    if (symbols.length === 0) return undefined;
    if (symbols.length === 1) {
      return new vscode.Location(symbols[0].uri, symbols[0].selectionRange);
    }
    return symbols.map(s => new vscode.Location(s.uri, s.selectionRange));
  }
}
