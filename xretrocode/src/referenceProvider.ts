import * as vscode from 'vscode';
import { R65SymbolIndex } from './symbolIndex';
import { R65ReferenceFinder } from './references';

export class R65ReferenceProvider implements vscode.ReferenceProvider {
  private finder: R65ReferenceFinder;

  constructor(index: R65SymbolIndex) {
    this.finder = new R65ReferenceFinder(index);
  }

  async provideReferences(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: vscode.ReferenceContext,
    token?: vscode.CancellationToken
  ): Promise<vscode.Location[] | undefined> {
    const target = this.finder.target(document, position);
    if (!target) return undefined;

    const hits = target.kind === 'local'
      ? this.finder.localHits(target.source, target.binding)
      : await this.finder.symbolHits(
        target.word.word, target.symbols, await vscode.workspace.findFiles('**/*.r65'), token
      );
    return hits
      ?.filter(h => context.includeDeclaration || h.kind !== 'decl')
      .map(h => new vscode.Location(h.uri, h.range));
  }
}
