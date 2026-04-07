import * as vscode from 'vscode';
import { parseSymbolsFromText, R65Symbol, R65SymbolKind } from './symbolIndex';

export class R65DocumentSymbolProvider implements vscode.DocumentSymbolProvider {
  provideDocumentSymbols(
    document: vscode.TextDocument,
    _token: vscode.CancellationToken
  ): vscode.ProviderResult<vscode.DocumentSymbol[]> {
    const text = document.getText();
    const symbols = parseSymbolsFromText(text, document.uri);
    return buildHierarchy(symbols);
  }
}

function mapKind(kind: R65SymbolKind): vscode.SymbolKind {
  switch (kind) {
    case R65SymbolKind.Function: return vscode.SymbolKind.Function;
    case R65SymbolKind.Struct: return vscode.SymbolKind.Struct;
    case R65SymbolKind.Enum: return vscode.SymbolKind.Enum;
    case R65SymbolKind.Trait: return vscode.SymbolKind.Interface;
    case R65SymbolKind.TypeAlias: return vscode.SymbolKind.TypeParameter;
    case R65SymbolKind.Constant: return vscode.SymbolKind.Constant;
    case R65SymbolKind.Static: return vscode.SymbolKind.Variable;
    case R65SymbolKind.Macro: return vscode.SymbolKind.Function;
    case R65SymbolKind.Impl: return vscode.SymbolKind.Namespace;
  }
}

function buildHierarchy(symbols: R65Symbol[]): vscode.DocumentSymbol[] {
  const result: vscode.DocumentSymbol[] = [];
  // Collect impl block symbols as containers
  const implSymbols: Map<string, vscode.DocumentSymbol> = new Map();

  // First pass: create all DocumentSymbols
  for (const sym of symbols) {
    if (sym.kind === R65SymbolKind.Impl) {
      // The display name includes "Trait for Type" or just "Type"
      const ds = new vscode.DocumentSymbol(
        sym.name, 'impl', mapKind(sym.kind), sym.range, sym.selectionRange
      );
      // Use the container target name (last word) as lookup key
      const target = sym.name.includes(' for ') ? sym.name.split(' for ')[1] : sym.name;
      implSymbols.set(target, ds);
      result.push(ds);
      continue;
    }

    const ds = new vscode.DocumentSymbol(
      sym.name, '', mapKind(sym.kind), sym.range, sym.selectionRange
    );

    if (sym.container && implSymbols.has(sym.container)) {
      implSymbols.get(sym.container)!.children.push(ds);
    } else {
      result.push(ds);
    }
  }

  return result;
}
