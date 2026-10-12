import * as vscode from 'vscode';
import { R65Symbol, R65SymbolIndex, R65SymbolKind } from './symbolIndex';
import { R65Resolver, wordAt } from './typeResolver';

export class R65HoverProvider implements vscode.HoverProvider {
  private resolver: R65Resolver;

  constructor(private index: R65SymbolIndex) {
    this.resolver = new R65Resolver(index);
  }

  provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
    _token: vscode.CancellationToken
  ): vscode.ProviderResult<vscode.Hover> {
    const w = wordAt(document, position.line, position.character);
    if (!w) return undefined;
    const range = new vscode.Range(w.line, w.start, w.line, w.end);

    const symbols = this.resolver.resolveSymbols(document, position.line, position.character);
    if (symbols.length > 0) {
      return new vscode.Hover(this.describe(symbols), range);
    }

    // A local or parameter: show how it is bound
    const binding = this.resolver.bindingAt(document, position.line, w.word);
    if (binding) {
      const md = new vscode.MarkdownString();
      md.appendCodeblock(binding.decl, 'r65');
      return new vscode.Hover(md, range);
    }
    return undefined;
  }

  private describe(symbols: R65Symbol[]): vscode.MarkdownString {
    // Copies of one declaration (e.g. stdlib vendored into each game) read as one
    const distinct = new Map<string, R65Symbol>();
    for (const s of symbols) {
      const key = `${s.container ?? ''}|${s.signature ?? s.name}`;
      if (!distinct.has(key)) distinct.set(key, s);
    }

    const md = new vscode.MarkdownString();
    for (const s of distinct.values()) {
      md.appendCodeblock(s.signature ?? s.name, 'r65');
      const where = this.containerLabel(s);
      if (where) md.appendMarkdown(`*${where}*\n\n`);
      if (s.doc && distinct.size === 1) md.appendText(s.doc);
    }
    return md;
  }

  private containerLabel(s: R65Symbol): string | undefined {
    if (!s.container) return undefined;
    if (s.kind === R65SymbolKind.EnumMember) return `variant of enum ${s.container}`;
    if (s.kind === R65SymbolKind.Field) return `field of ${s.container}`;
    const isTrait = this.index.lookup(s.container).some(c => c.kind === R65SymbolKind.Trait);
    return isTrait ? `trait ${s.container}` : `impl ${s.container}`;
  }
}
