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
  Field,
}

export interface R65Symbol {
  name: string;
  kind: R65SymbolKind;
  uri: vscode.Uri;
  range: vscode.Range;
  selectionRange: vscode.Range;
  /** Impl target type, trait, or (for an EnumMember/Field) enum/struct that holds this symbol. */
  container?: string;
  /**
   * For const/static/field: the declared type, reduced to a type name by
   * `baseTypeName`, used to resolve method receivers.
   * For an EnumMember: the payload struct, so a binding like `Shape::Circle(c)` types `c`.
   */
  declaredType?: string;
  /** For const/static/field: its type as written, pattern-side pointer folded in (see `declTypeText`). */
  typeText?: string;
  /** For a Function: its single non-primitive return type, if any. */
  returnType?: string;
  /** For a Function: whether it takes `self` (a method rather than an associated fn). */
  hasSelf?: boolean;
  /** The declaration as written, for hover and completion detail. */
  signature?: string;
  /** `///` comments above the declaration, else plain `//` ones. */
  doc?: string;
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
  { pattern: /\bconst\s+(?!fn\b)(?<const_name>[a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(?<const_type>[^=;]*)/, kind: R65SymbolKind.Constant, nameGroup: 'const_name', typeGroup: 'const_type' },
  { pattern: /\bstatic\s+(?:mut\s+)?\*?\s*(?<static_name>[a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(?<static_type>[^=;]*)/, kind: R65SymbolKind.Static, nameGroup: 'static_name', typeGroup: 'static_type' },
  { pattern: /\bmacro_rules!\s*(?<macro_name>[a-zA-Z_][a-zA-Z0-9_]*)/, kind: R65SymbolKind.Macro, nameGroup: 'macro_name' },
];

const IMPL_PATTERN = /\bimpl\s+(?:far\s+)?(?<traitOrType>[A-Z][a-zA-Z0-9_]*)(?:\s+for\s+(?<implTarget>[A-Z][a-zA-Z0-9_]*))?\s*\{/;

/** `trait Name {` / `trait Sub: Super1 + Super2 {` — its methods may carry default bodies */
const TRAIT_PATTERN = /\btrait\s+(?<traitName>[A-Z][a-zA-Z0-9_]*)[^{]*\{/;

/** `enum Name {` / `struct Name {` / `union Name {` — items follow, on this line or the next ones */
const BODY_OPEN_PATTERN = /\b(?<keyword>enum|struct|union)\s+(?<bodyName>[A-Z][a-zA-Z0-9_]*)\s*\{/;

/** A variant at the start of an enum item: `Circle(Circle)`, `None`, `Bpp2 = 16` */
const VARIANT_PATTERN = /(?:^|[{,])\s*(?<variant>[a-zA-Z_][a-zA-Z0-9_]*)(?:\s*\(\s*(?<payload>[a-zA-Z_][a-zA-Z0-9_]*)\s*\))?/g;

/** A struct/union field: `x: u8`, `src: far *u8`, `far *next: Node`, `buf: [u8; 9]` */
const FIELD_PATTERN = /(?:^|[{,])\s*(?<item>(?:(?:far|near)\s+)?\*?\s*(?<field>[a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(?<type>[^,]*))/g;

/** `struct TileId(u8);` / `struct Cb(fn(u8) -> u8);` — a newtype, whose payload reads as `.0` */
const NEWTYPE_PATTERN = /\bstruct\s+(?<newtype>[A-Z][a-zA-Z0-9_]*)\s*\((?<payload>.*)\)\s*;/;

const PRIMITIVES = new Set(['u8', 'u16', 'i8', 'i16', 'bool', 'fn']);

/** `// ====` / `// ----` section banners, which are not documentation */
const BANNER = /^\/\/\s*[=\-#*~]{3,}/;

/** Blank out a trailing `//` comment, keeping columns intact. */
export function maskLineComment(line: string): string {
  const at = line.indexOf('//');
  return at < 0 ? line : line.substring(0, at) + ' '.repeat(line.length - at);
}

/** Split `text` at commas outside any (), [] or {}. */
export function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (ch === ',' && depth === 0) {
      parts.push(text.substring(start, i));
      start = i + 1;
    }
  }
  parts.push(text.substring(start));
  return parts;
}

/**
 * The struct/enum/trait a type expression names: `far *dyn Shape` → `Shape`,
 * `[Enemy; 8]` → `Enemy`. Undefined for primitives, `!`, fn types, and a
 * multi-value list like `u8, u16`.
 */
export function baseTypeName(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const t = text.trim();
  if (splitTopLevel(t).length > 1) return undefined;
  const m = t.replace(/^(?:(?:far|near|dyn)\b\s*|\*\s*|\[\s*)+/, '').match(/^[a-zA-Z_][a-zA-Z0-9_]*/);
  if (!m || PRIMITIVES.has(m[0])) return undefined;
  return m[0];
}

/**
 * The type a declaration gives its name, with a pattern-side pointer moved
 * onto the type: `far *src: u8` → `far *u8`, `src: [u8; 4]` → `[u8; 4]`.
 */
export function declTypeText(decl: string): string | undefined {
  const colon = decl.indexOf(':');
  if (colon < 0) return undefined;
  const type = decl.substring(colon + 1).trim();
  const pattern = decl.substring(0, colon).match(
    /(?:\b(far|near)\s+)?(?:mut\s+)?(\*)?\s*[a-zA-Z_][a-zA-Z0-9_]*\s*(?:@\s*[a-zA-Z_][a-zA-Z0-9_]*\s*)?$/
  );
  if (!pattern?.[2]) return type;
  return `${pattern[1] === 'far' ? 'far ' : ''}*${type}`;
}

/** What a type expression supports beyond its struct members: the compiler's intrinsic methods. */
export enum ValueShape {
  /** `far *T`: `bank_byte()` */
  FarPointer,
  /** `[T; N]`: `len()` */
  Array,
  /** `u8`, `i8`, `u16`, `i16`: `rotate_left(n)`, `rotate_right(n)` */
  Integer,
}

export function valueShape(typeText: string | undefined): ValueShape | undefined {
  const t = typeText?.trim();
  if (!t) return undefined;
  if (/^far\s*\*/.test(t)) return ValueShape.FarPointer;
  if (t.startsWith('[')) return ValueShape.Array;
  if (/^(?:u8|i8|u16|i16)\b/.test(t)) return ValueShape.Integer;
  return undefined;
}

/**
 * The type one index or deref away: `[T; N]` → `T`, `*T` / `far *T` → `T`.
 * Undefined for anything else.
 */
export function elementTypeText(typeText: string): string | undefined {
  const t = typeText.trim();
  const ptr = t.match(/^(?:(?:far|near)\s*)?\*\s*([\s\S]*)$/);
  if (ptr) return ptr[1];
  if (!t.startsWith('[')) return undefined;
  let depth = 0;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (ch === '[' || ch === '(') depth++;
    else if (ch === ']' || ch === ')') depth--;
    else if (ch === ';' && depth === 1) return t.substring(1, i);
  }
  return undefined;
}

export interface FnParam {
  name: string;
  /** Reduced type name; undefined for `self` and primitives. */
  type?: string;
  /** The parameter as written, e.g. `src: far *u8`. */
  text: string;
  /** Its type as written, pattern-side pointer folded in (see `declTypeText`). */
  typeText?: string;
}

export interface FnHeader {
  name: string;
  params: FnParam[];
  returnType?: string;
  hasSelf: boolean;
}

const FN_HEADER = /\bfn\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/;
const SELF_PARAM = /^(?:(?:far|near)\s+)?(?:\*\s*)?self$/;
const PARAM = /^(?:(?:far|near)\s+)?\*?\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*(?:@\s*[a-zA-Z_][a-zA-Z0-9_]*)?\s*:\s*(.+)$/;

/** Name, parameters and return type of a `fn` header written on `line`. */
export function parseFnHeader(line: string): FnHeader | undefined {
  const m = maskLineComment(line).match(FN_HEADER);
  if (!m) return undefined;
  const start = m.index! + m[0].length;
  let depth = 1;
  let i = start;
  while (i < line.length && depth > 0) {
    if (line[i] === '(') depth++;
    else if (line[i] === ')') depth--;
    i++;
  }
  const paramsText = line.substring(start, depth === 0 ? i - 1 : line.length);
  const params: FnParam[] = [];
  for (const raw of splitTopLevel(paramsText)) {
    const item = raw.trim();
    if (!item) continue;
    if (SELF_PARAM.test(item)) {
      params.push({ name: 'self', text: item });
      continue;
    }
    const p = item.match(PARAM);
    if (p) params.push({ name: p[1], type: baseTypeName(p[2]), text: item, typeText: declTypeText(item) });
  }
  const ret = depth === 0 ? line.substring(i).match(/^\s*->\s*([^{;]*)/) : null;
  return {
    name: m[1],
    params,
    returnType: ret ? baseTypeName(ret[1]) : undefined,
    hasSelf: params[0]?.name === 'self',
  };
}

/** The declaration on `line` without attributes, body or initializer. */
function signatureOf(line: string, kind: R65SymbolKind): string {
  let s = maskLineComment(line).trim().replace(/^(?:#\[[^\]]*\]\s*)+/, '');
  if (kind === R65SymbolKind.Constant || kind === R65SymbolKind.Static) {
    const eq = s.indexOf('=');
    if (eq >= 0) s = s.substring(0, eq);
  } else {
    const brace = s.indexOf('{');
    if (brace >= 0) s = s.substring(0, brace);
  }
  return s.trim().replace(/;$/, '').trim();
}

/** The `//` comment trailing code on `line`, if any. */
function trailingComment(line: string): string | undefined {
  const at = line.indexOf('//');
  if (at < 0 || !line.substring(0, at).trim()) return undefined;
  const text = line.substring(at + 2).replace(/^[/!]?\s?/, '').trim();
  return text || undefined;
}

/**
 * Items in `text`, which is one line of an enum or struct body with everything
 * outside the body blanked. Columns are those of the original line.
 */
function parseBodyItems(
  keyword: string, text: string, line: number, container: string, uri: vscode.Uri,
  fullLine: string, doc: string | undefined
): R65Symbol[] {
  const found: R65Symbol[] = [];
  const isEnum = keyword === 'enum';
  for (const m of text.matchAll(isEnum ? VARIANT_PATTERN : FIELD_PATTERN)) {
    const name = isEnum ? m.groups!.variant : m.groups!.field;
    const nameStart = m.index! + m[0].indexOf(name, isEnum ? 0 : m[0].indexOf(m.groups!.item));
    const payload = isEnum ? m.groups!.payload : undefined;
    found.push({
      name,
      kind: isEnum ? R65SymbolKind.EnumMember : R65SymbolKind.Field,
      uri,
      range: new vscode.Range(line, 0, line, fullLine.length),
      selectionRange: new vscode.Range(line, nameStart, line, nameStart + name.length),
      container,
      declaredType: isEnum ? payload : baseTypeName(m.groups!.type),
      typeText: isEnum ? undefined : declTypeText(m.groups!.item),
      signature: isEnum
        ? `${container}::${name}${payload ? `(${payload})` : ''}`
        : m.groups!.item.trim(),
    });
  }
  const itemDoc = doc ?? (found.length === 1 ? trailingComment(fullLine) : undefined);
  if (found.length > 0 && itemDoc) found[0].doc = itemDoc;
  return found;
}

export interface ScanResult {
  symbols: R65Symbol[];
  /** For each line, the impl target type or trait whose block holds it. */
  lineContainers: (string | undefined)[];
}

export function parseSymbolsFromText(text: string, uri: vscode.Uri): R65Symbol[] {
  return scanText(text, uri).symbols;
}

export function scanText(text: string, uri: vscode.Uri): ScanResult {
  const lines = text.split('\n');
  const symbols: R65Symbol[] = [];
  const lineContainers: (string | undefined)[] = new Array(lines.length);
  let insideBlockComment = false;
  let currentContainer: string | undefined;
  let containerBraceDepth = 0;
  let braceDepth = 0;
  // Set while inside an enum/struct/union body that runs past its header line
  let openBody: { keyword: string; name: string } | undefined;
  // Comments directly above the next declaration
  let docLines: string[] = [];
  let plainLines: string[] = [];
  const takeDoc = (): string | undefined => {
    const lines = docLines.length > 0 ? docLines : plainLines;
    docLines = [];
    plainLines = [];
    return lines.length > 0 ? lines.join('\n') : undefined;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    lineContainers[i] = currentContainer;

    // Track block comments
    if (insideBlockComment) {
      if (line.includes('*/')) {
        insideBlockComment = false;
      }
      continue;
    }

    const trimmed = line.trimStart();
    if (trimmed.startsWith('//')) {
      if (/^\/\/\/(?!\/)/.test(trimmed)) {
        docLines.push(trimmed.substring(3).replace(/^ /, ''));
      } else if (trimmed.startsWith('//!') || BANNER.test(trimmed)) {
        plainLines = [];
      } else if (!trimmed.startsWith('////')) {
        plainLines.push(trimmed.substring(2).replace(/^ /, ''));
      }
      continue;
    }
    if (trimmed.startsWith('/*')) {
      if (!line.includes('*/')) {
        insideBlockComment = true;
      }
      docLines = [];
      plainLines = [];
      continue;
    }
    if (!trimmed) {
      docLines = [];
      plainLines = [];
      continue;
    }

    // Body items. A body can't nest braces, so the first `}` closes it.
    if (openBody) {
      const masked = maskLineComment(line);
      const close = masked.indexOf('}');
      const body = close < 0 ? masked : masked.substring(0, close) + ' '.repeat(masked.length - close);
      symbols.push(...parseBodyItems(openBody.keyword, body, i, openBody.name, uri, line, takeDoc()));
      if (close < 0) continue;
      openBody = undefined;
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

    // An attribute on its own line sits between a declaration and its docs
    const doc = /^#\[.*\]\s*$/.test(trimmed) ? undefined : takeDoc();

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
        declaredType: def.typeGroup ? baseTypeName(match.groups[def.typeGroup]) : undefined,
        typeText: def.typeGroup ? declTypeText(match[0]) : undefined,
        signature: signatureOf(line, def.kind),
        doc,
      };
      if (def.kind === R65SymbolKind.Function) {
        const header = parseFnHeader(line);
        sym.returnType = header?.returnType;
        sym.hasSelf = header?.hasSelf;
      }
      symbols.push(sym);
      break; // Only match one pattern per line
    }

    const masked = maskLineComment(line);

    // A newtype's payload is its field `0`
    const newtype = masked.match(NEWTYPE_PATTERN);
    if (newtype?.groups) {
      const payload = newtype.groups.payload.trim();
      const start = line.indexOf(payload, newtype.index! + newtype[0].indexOf('('));
      symbols.push({
        name: '0',
        kind: R65SymbolKind.Field,
        uri,
        range: new vscode.Range(i, 0, i, line.length),
        selectionRange: new vscode.Range(i, start, i, start + payload.length),
        container: newtype.groups.newtype,
        declaredType: baseTypeName(payload),
        typeText: payload,
        signature: `0: ${payload}`,
      });
    }

    // Body header: items may start after its `{` on this same line
    const bodyMatch = masked.match(BODY_OPEN_PATTERN);
    if (bodyMatch?.groups) {
      const open = bodyMatch.index! + bodyMatch[0].length;
      const close = masked.indexOf('}', open);
      const end = close < 0 ? masked.length : close;
      const body = ' '.repeat(open) + masked.substring(open, end) + ' '.repeat(masked.length - end);
      const { keyword, bodyName } = bodyMatch.groups;
      symbols.push(...parseBodyItems(keyword, body, i, bodyName, uri, line, undefined));
      if (close < 0) openBody = { keyword, name: bodyName };
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

  return { symbols, lineContainers };
}

export class R65SymbolIndex implements vscode.Disposable {
  // name -> symbols (supports duplicates across files)
  private symbols: Map<string, R65Symbol[]> = new Map();
  // uri.toString() -> symbols in that file
  private fileSymbols: Map<string, R65Symbol[]> = new Map();
  private disposables: vscode.Disposable[] = [];
  // Derived lookups, rebuilt on first use after any file changes
  private traitCache: Map<string, Set<string>> | undefined;
  private memberCache: Map<string, R65Symbol[]> | undefined;

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
    this.invalidate();

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
      this.invalidate();
    }
  }

  private invalidate(): void {
    this.traitCache = undefined;
    this.memberCache = undefined;
  }

  lookup(name: string): R65Symbol[] {
    return this.symbols.get(name) || [];
  }

  /** Every indexed symbol, across all files. */
  allSymbols(): R65Symbol[] {
    return ([] as R65Symbol[]).concat(...this.fileSymbols.values());
  }

  /** Traits named by an `impl Trait for Type` anywhere in the workspace. */
  traitsImplementedBy(type: string): Set<string> {
    if (!this.traitCache) {
      this.traitCache = new Map();
      for (const s of this.allSymbols()) {
        const m = s.kind === R65SymbolKind.Impl ? s.name.match(/^(\S+) for (\S+)$/) : null;
        if (!m) continue;
        const set = this.traitCache.get(m[2]) ?? new Set<string>();
        set.add(m[1]);
        this.traitCache.set(m[2], set);
      }
    }
    return this.traitCache.get(type) ?? new Set();
  }

  /** Symbols whose container is `name`: methods, macros, fields, variants. */
  membersOfContainer(name: string): R65Symbol[] {
    if (!this.memberCache) {
      this.memberCache = new Map();
      for (const s of this.allSymbols()) {
        if (!s.container) continue;
        const list = this.memberCache.get(s.container) ?? [];
        list.push(s);
        this.memberCache.set(s.container, list);
      }
    }
    return this.memberCache.get(name) ?? [];
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
    this.invalidate();
  }
}
