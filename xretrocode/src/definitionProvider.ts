import * as vscode from 'vscode';
import { R65Symbol, R65SymbolIndex } from './symbolIndex';
import { R65Resolver } from './typeResolver';

/** Number of leading path segments two paths share. */
function sharedSegments(a: string, b: string): number {
  const as = a.split('/');
  const bs = b.split('/');
  let n = 0;
  while (n < as.length && n < bs.length && as[n] === bs[n]) n++;
  return n;
}

/**
 * Games vendor the stdlib into their own `src/lib`, so one declaration can be
 * indexed several times — and the copies drift (`fn` in one, `far fn` in
 * another). One program can't declare the same kind of thing twice under one
 * name and owner, so candidates that agree on those are copies: jump to the
 * one nearest the file being edited instead of offering a picker.
 */
export function nearestCopy(symbols: R65Symbol[], from: vscode.Uri): R65Symbol[] {
  if (symbols.length < 2) return symbols;
  const id = (s: R65Symbol) => `${s.kind}|${s.container ?? ''}|${s.name}`;
  if (!symbols.every(s => id(s) === id(symbols[0]))) return symbols;
  const here = from.toString();
  const best = Math.max(...symbols.map(s => sharedSegments(s.uri.toString(), here)));
  return symbols.filter(s => sharedSegments(s.uri.toString(), here) === best);
}

export class R65DefinitionProvider implements vscode.DefinitionProvider {
  private resolver: R65Resolver;

  constructor(index: R65SymbolIndex) {
    this.resolver = new R65Resolver(index);
  }

  provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position,
    _token: vscode.CancellationToken
  ): vscode.ProviderResult<vscode.Definition> {
    const symbols = nearestCopy(
      this.resolver.resolveSymbols(document, position.line, position.character), document.uri
    );
    if (symbols.length === 0) return undefined;
    if (symbols.length === 1) {
      return new vscode.Location(symbols[0].uri, symbols[0].selectionRange);
    }
    return symbols.map(s => new vscode.Location(s.uri, s.selectionRange));
  }
}
