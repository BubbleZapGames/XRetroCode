import * as vscode from 'vscode';

export enum R65SymbolKind {
  Function,
  Struct,
  Enum,
  Trait,
  TypeAlias,
  Constant,
  Static,
  Macro,
  Impl,
}

export interface R65Symbol {
  name: string;
  kind: R65SymbolKind;
  uri: vscode.Uri;
  range: vscode.Range;
  selectionRange: vscode.Range;
  container?: string;
  /** For const/static: the declared type name, used to resolve method receivers. */
  declaredType?: string;
}

interface PatternDef {
  pattern: RegExp;
  kind: R65SymbolKind;
  nameGroup: string;
  typeGroup?: string;
}

const PATTERNS: PatternDef[] = [
  { pattern: /\b(?:const\s+)?(?:far\s+)?fn\s+(?<fn_name>[a-zA-Z_][a-zA-Z0-9_]*)\s*\(/, kind: R65SymbolKind.Function, nameGroup: 'fn_name' },
  { pattern: /\bstruct\s+(?<struct_name>[A-Z][a-zA-Z0-9_]*)/, kind: R65SymbolKind.Struct, nameGroup: 'struct_name' },
  { pattern: /\benum\s+(?<enum_name>[A-Z][a-zA-Z0-9_]*)/, kind: R65SymbolKind.Enum, nameGroup: 'enum_name' },
  { pattern: /\btrait\s+(?<trait_name>[A-Z][a-zA-Z0-9_]*)/, kind: R65SymbolKind.Trait, nameGroup: 'trait_name' },
  { pattern: /\btype\s+(?<type_name>[A-Z][a-zA-Z0-9_]*)\s*=/, kind: R65SymbolKind.TypeAlias, nameGroup: 'type_name' },
  { pattern: /\bconst\s+(?!fn\b)(?<const_name>[a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*\[?\s*(?<const_type>[a-zA-Z_][a-zA-Z0-9_]*)?/, kind: R65SymbolKind.Constant, nameGroup: 'const_name', typeGroup: 'const_type' },
  { pattern: /\bstatic\s+(?:mut\s+)?(?<static_name>[a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*\[?\s*(?<static_type>[a-zA-Z_][a-zA-Z0-9_]*)?/, kind: R65SymbolKind.Static, nameGroup: 'static_name', typeGroup: 'static_type' },
  { pattern: /\bmacro_rules!\s*(?<macro_name>[a-zA-Z_][a-zA-Z0-9_]*)/, kind: R65SymbolKind.Macro, nameGroup: 'macro_name' },
];

const IMPL_PATTERN = /\bimpl\s+(?:far\s+)?(?<traitOrType>[A-Z][a-zA-Z0-9_]*)(?:\s+for\s+(?<implTarget>[A-Z][a-zA-Z0-9_]*))?\s*\{/;

export function parseSymbolsFromText(text: string, uri: vscode.Uri): R65Symbol[] {
  const lines = text.split('\n');
  const symbols: R65Symbol[] = [];
  let insideBlockComment = false;
  let currentContainer: string | undefined;
  let containerBraceDepth = 0;
  let braceDepth = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Track block comments
    if (insideBlockComment) {
      if (line.includes('*/')) {
        insideBlockComment = false;
      }
      continue;
    }

    const trimmed = line.trimStart();
    if (trimmed.startsWith('//')) {
      // Still count braces in comments? No — skip entirely
      continue;
    }
    if (trimmed.startsWith('/*')) {
      if (!line.includes('*/')) {
        insideBlockComment = true;
      }
      continue;
    }

    // Count braces for impl container tracking
    for (const ch of line) {
      if (ch === '{') braceDepth++;
      if (ch === '}') braceDepth--;
    }

    // Check if we've exited the current impl block
    if (currentContainer && braceDepth <= containerBraceDepth) {
      currentContainer = undefined;
    }

    // Try each definition pattern
    for (const def of PATTERNS) {
      const match = line.match(def.pattern);
      if (!match || !match.groups) continue;

      const name = match.groups[def.nameGroup];
      if (!name) continue;

      // Find the exact position of the name in the line
      const nameStart = line.indexOf(name, match.index!);
      const nameEnd = nameStart + name.length;

      const sym: R65Symbol = {
        name,
        kind: def.kind,
        uri,
        range: new vscode.Range(i, 0, i, line.length),
        selectionRange: new vscode.Range(i, nameStart, i, nameEnd),
        container: currentContainer,
        declaredType: def.typeGroup ? match.groups[def.typeGroup] : undefined,
      };
      symbols.push(sym);
      break; // Only match one pattern per line
    }

    // Track impl blocks for container context
    const implMatch = line.match(IMPL_PATTERN);
    if (implMatch?.groups) {
      const implName = implMatch.groups.implTarget || implMatch.groups.traitOrType;
      currentContainer = implName;
      // braceDepth already includes the { on this line, so container depth is one less
      containerBraceDepth = braceDepth - 1;

      // Add impl as a symbol too (for Outline view)
      const traitOrType = implMatch.groups.traitOrType;
      const target = implMatch.groups.implTarget;
      const displayName = target ? `${traitOrType} for ${target}` : traitOrType;
      const nameInLine = target || traitOrType;
      const nameStart = line.indexOf(nameInLine, implMatch.index!);

      symbols.push({
        name: displayName,
        kind: R65SymbolKind.Impl,
        uri,
        range: new vscode.Range(i, 0, i, line.length),
        selectionRange: new vscode.Range(i, nameStart, i, nameStart + nameInLine.length),
      });
    }
  }

  return symbols;
}

export class R65SymbolIndex implements vscode.Disposable {
  // name -> symbols (supports duplicates across files)
  private symbols: Map<string, R65Symbol[]> = new Map();
  // uri.toString() -> symbols in that file
  private fileSymbols: Map<string, R65Symbol[]> = new Map();
  private disposables: vscode.Disposable[] = [];

  async initialize(): Promise<void> {
    const files = await vscode.workspace.findFiles('**/*.r65');
    for (const uri of files) {
      await this.indexFile(uri);
    }
  }

  async indexFile(uri: vscode.Uri): Promise<void> {
    // Remove old symbols for this file first
    this.removeFile(uri);

    const bytes = await vscode.workspace.fs.readFile(uri);
    const text = new TextDecoder().decode(bytes);
    const syms = parseSymbolsFromText(text, uri);

    this.fileSymbols.set(uri.toString(), syms);

    for (const sym of syms) {
      const existing = this.symbols.get(sym.name);
      if (existing) {
        existing.push(sym);
      } else {
        this.symbols.set(sym.name, [sym]);
      }
    }
  }

  removeFile(uri: vscode.Uri): void {
    const key = uri.toString();
    const old = this.fileSymbols.get(key);
    if (old) {
      for (const sym of old) {
        const arr = this.symbols.get(sym.name);
        if (arr) {
          const filtered = arr.filter(s => s.uri.toString() !== key);
          if (filtered.length > 0) {
            this.symbols.set(sym.name, filtered);
          } else {
            this.symbols.delete(sym.name);
          }
        }
      }
      this.fileSymbols.delete(key);
    }
  }

  lookup(name: string): R65Symbol[] {
    return this.symbols.get(name) || [];
  }

  getFileSymbols(uri: vscode.Uri): R65Symbol[] {
    return this.fileSymbols.get(uri.toString()) || [];
  }

  startWatching(): vscode.Disposable {
    const watcher = vscode.workspace.createFileSystemWatcher('**/*.r65');
    this.disposables.push(watcher);
    this.disposables.push(watcher.onDidCreate((uri: vscode.Uri) => this.indexFile(uri)));
    this.disposables.push(watcher.onDidChange((uri: vscode.Uri) => this.indexFile(uri)));
    this.disposables.push(watcher.onDidDelete((uri: vscode.Uri) => this.removeFile(uri)));
    return vscode.Disposable.from(...this.disposables);
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];
    this.symbols.clear();
    this.fileSymbols.clear();
  }
}
