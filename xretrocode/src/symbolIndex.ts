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
  Union,
  EnumMember,
}

export interface R65Symbol {
  name: string;
  kind: R65SymbolKind;
  uri: vscode.Uri;
  range: vscode.Range;
  selectionRange: vscode.Range;
  /** Impl target type, trait, or (for an EnumMember) enum that holds this symbol. */
  container?: string;
  /**
   * For const/static: the declared type name, used to resolve method receivers.
   * For an EnumMember: the payload struct, so a binding like `Shape::Circle(c)` types `c`.
   */
  declaredType?: string;
}

interface PatternDef {
  pattern: RegExp;
  kind: R65SymbolKind;
  nameGroup: string;
  typeGroup?: string;
}

const PATTERNS: PatternDef[] = [
  { pattern: /\b(?:const\s+)?(?:(?:far|near)\s+)?fn\s+(?<fn_name>[a-zA-Z_][a-zA-Z0-9_]*)\s*\(/, kind: R65SymbolKind.Function, nameGroup: 'fn_name' },
  { pattern: /\bstruct\s+(?<struct_name>[A-Z][a-zA-Z0-9_]*)/, kind: R65SymbolKind.Struct, nameGroup: 'struct_name' },
  { pattern: /\bunion\s+(?<union_name>[A-Z][a-zA-Z0-9_]*)/, kind: R65SymbolKind.Union, nameGroup: 'union_name' },
  { pattern: /\benum\s+(?<enum_name>[A-Z][a-zA-Z0-9_]*)/, kind: R65SymbolKind.Enum, nameGroup: 'enum_name' },
  { pattern: /\btrait\s+(?<trait_name>[A-Z][a-zA-Z0-9_]*)/, kind: R65SymbolKind.Trait, nameGroup: 'trait_name' },
  { pattern: /\btype\s+(?<type_name>[A-Z][a-zA-Z0-9_]*)\s*=/, kind: R65SymbolKind.TypeAlias, nameGroup: 'type_name' },
  { pattern: /\bconst\s+(?!fn\b)(?<const_name>[a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*\[?\s*(?<const_type>[a-zA-Z_][a-zA-Z0-9_]*)?/, kind: R65SymbolKind.Constant, nameGroup: 'const_name', typeGroup: 'const_type' },
  { pattern: /\bstatic\s+(?:mut\s+)?(?<static_name>[a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*\[?\s*(?<static_type>[a-zA-Z_][a-zA-Z0-9_]*)?/, kind: R65SymbolKind.Static, nameGroup: 'static_name', typeGroup: 'static_type' },
  { pattern: /\bmacro_rules!\s*(?<macro_name>[a-zA-Z_][a-zA-Z0-9_]*)/, kind: R65SymbolKind.Macro, nameGroup: 'macro_name' },
];

const IMPL_PATTERN = /\bimpl\s+(?:far\s+)?(?<traitOrType>[A-Z][a-zA-Z0-9_]*)(?:\s+for\s+(?<implTarget>[A-Z][a-zA-Z0-9_]*))?\s*\{/;

/** `trait Name {` / `trait Sub: Super1 + Super2 {` — its methods may carry default bodies */
const TRAIT_PATTERN = /\btrait\s+(?<traitName>[A-Z][a-zA-Z0-9_]*)[^{]*\{/;

/** `enum Name {` — variants follow, on this line or the next ones */
const ENUM_OPEN_PATTERN = /\benum\s+(?<enumName>[A-Z][a-zA-Z0-9_]*)\s*\{/;

/** A variant at the start of an enum item: `Circle(Circle)`, `None`, `Bpp2 = 16` */
const VARIANT_PATTERN = /(?:^|[{,])\s*(?<variant>[a-zA-Z_][a-zA-Z0-9_]*)(?:\s*\(\s*(?<payload>[a-zA-Z_][a-zA-Z0-9_]*)\s*\))?/g;

/** Blank out a trailing `//` comment, keeping columns intact. */
function maskLineComment(line: string): string {
  const at = line.indexOf('//');
  return at < 0 ? line : line.substring(0, at) + ' '.repeat(line.length - at);
}

/**
 * Variants in `text`, which is one line of an enum body with everything
 * outside the body blanked. Columns are those of the original line.
 */
function parseVariants(
  text: string, line: number, enumName: string, uri: vscode.Uri, fullLine: string
): R65Symbol[] {
  const found: R65Symbol[] = [];
  for (const m of text.matchAll(VARIANT_PATTERN)) {
    const name = m.groups!.variant;
    const nameStart = m.index! + m[0].indexOf(name);
    found.push({
      name,
      kind: R65SymbolKind.EnumMember,
      uri,
      range: new vscode.Range(line, 0, line, fullLine.length),
      selectionRange: new vscode.Range(line, nameStart, line, nameStart + name.length),
      container: enumName,
      declaredType: m.groups!.payload,
    });
  }
  return found;
}

export function parseSymbolsFromText(text: string, uri: vscode.Uri): R65Symbol[] {
  const lines = text.split('\n');
  const symbols: R65Symbol[] = [];
  let insideBlockComment = false;
  let currentContainer: string | undefined;
  let containerBraceDepth = 0;
  let braceDepth = 0;
  // Set while inside an enum body that runs past its header line
  let openEnum: string | undefined;

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

    // Enum variants. A body can't nest braces, so the first `}` closes it.
    if (openEnum) {
      const masked = maskLineComment(line);
      const close = masked.indexOf('}');
      const body = close < 0 ? masked : masked.substring(0, close) + ' '.repeat(masked.length - close);
      symbols.push(...parseVariants(body, i, openEnum, uri, line));
      if (close < 0) continue;
      openEnum = undefined;
    }

    // Count braces for impl/trait container tracking
    const depthBeforeLine = braceDepth;
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

    // Enum header: variants may start after its `{` on this same line
    const enumMatch = maskLineComment(line).match(ENUM_OPEN_PATTERN);
    if (enumMatch?.groups) {
      const enumName = enumMatch.groups.enumName;
      const masked = maskLineComment(line);
      const open = enumMatch.index! + enumMatch[0].length;
      const close = masked.indexOf('}', open);
      const end = close < 0 ? masked.length : close;
      const body = ' '.repeat(open) + masked.substring(open, end) + ' '.repeat(masked.length - end);
      symbols.push(...parseVariants(body, i, enumName, uri, line));
      if (close < 0) openEnum = enumName;
      continue;
    }

    // A block left open past this line holds the following methods. Its depth
    // is the one before this line's braces, so `impl Foo {}` closes at once.
    const traitMatch = line.match(TRAIT_PATTERN);
    if (traitMatch?.groups) {
      currentContainer = traitMatch.groups.traitName;
      containerBraceDepth = depthBeforeLine;
      if (braceDepth <= containerBraceDepth) currentContainer = undefined;
    }

    // Track impl blocks for container context
    const implMatch = line.match(IMPL_PATTERN);
    if (implMatch?.groups) {
      const implName = implMatch.groups.implTarget || implMatch.groups.traitOrType;
      currentContainer = implName;
      containerBraceDepth = depthBeforeLine;
      if (braceDepth <= containerBraceDepth) currentContainer = undefined;

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

  /** Traits named by an `impl Trait for Type` anywhere in the workspace. */
  traitsImplementedBy(type: string): Set<string> {
    const suffix = ` for ${type}`;
    const traits = new Set<string>();
    for (const syms of this.fileSymbols.values()) {
      for (const s of syms) {
        if (s.kind === R65SymbolKind.Impl && s.name.endsWith(suffix)) {
          traits.add(s.name.slice(0, -suffix.length));
        }
      }
    }
    return traits;
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
