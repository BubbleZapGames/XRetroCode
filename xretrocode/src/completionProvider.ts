import * as vscode from 'vscode';
import { R65Symbol, R65SymbolIndex, R65SymbolKind, maskLineComment, parseSymbolsFromText } from './symbolIndex';
import { PATH_RE, R65Resolver } from './typeResolver';

const KEYWORDS = [
  'fn', 'far', 'near', 'let', 'mut', 'const', 'static', 'struct', 'union', 'enum',
  'type', 'trait', 'impl', 'self', 'as', 'asm', 'extern', 'include', 'include_bytes',
  'include_asm', 'macro_rules', 'dyn', 'if', 'else', 'loop', 'while', 'for', 'in',
  'break', 'continue', 'return', 'match', 'true', 'false',
];
const PRIMITIVE_TYPES = ['u8', 'u16', 'i8', 'i16', 'bool'];

function completionKind(s: R65Symbol): vscode.CompletionItemKind {
  switch (s.kind) {
    case R65SymbolKind.Function: return s.container ? vscode.CompletionItemKind.Method : vscode.CompletionItemKind.Function;
    case R65SymbolKind.Struct: return vscode.CompletionItemKind.Struct;
    case R65SymbolKind.Union: return vscode.CompletionItemKind.Struct;
    case R65SymbolKind.Enum: return vscode.CompletionItemKind.Enum;
    case R65SymbolKind.Trait: return vscode.CompletionItemKind.Interface;
    case R65SymbolKind.TypeAlias: return vscode.CompletionItemKind.TypeParameter;
    case R65SymbolKind.Constant: return vscode.CompletionItemKind.Constant;
    case R65SymbolKind.Static: return vscode.CompletionItemKind.Variable;
    case R65SymbolKind.Macro: return vscode.CompletionItemKind.Function;
    case R65SymbolKind.EnumMember: return vscode.CompletionItemKind.EnumMember;
    case R65SymbolKind.Field: return vscode.CompletionItemKind.Field;
    case R65SymbolKind.Impl: return vscode.CompletionItemKind.Module;
  }
}

/** Members offered after `value.`: fields, methods and method macros. */
function isDotMember(s: R65Symbol): boolean {
  return s.kind === R65SymbolKind.Field
    || s.kind === R65SymbolKind.Macro
    || (s.kind === R65SymbolKind.Function && s.hasSelf === true);
}

/** Members offered after `Type::`: variants, associated fns, consts and macros. */
function isPathMember(s: R65Symbol): boolean {
  return s.kind === R65SymbolKind.EnumMember
    || s.kind === R65SymbolKind.Function
    || s.kind === R65SymbolKind.Constant
    || s.kind === R65SymbolKind.Macro;
}

export class R65CompletionProvider implements vscode.CompletionItemProvider {
  private resolver: R65Resolver;

  constructor(private index: R65SymbolIndex) {
    this.resolver = new R65Resolver(index);
  }

  provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    _token: vscode.CancellationToken,
    _context?: vscode.CompletionContext
  ): vscode.ProviderResult<vscode.CompletionItem[]> {
    const prefix = document.lineAt(position.line).text.substring(0, position.character);
    // Nothing to offer inside a comment or string
    if (maskLineComment(prefix) !== prefix || (prefix.match(/"/g)?.length ?? 0) % 2 === 1) {
      return undefined;
    }

    const partial = prefix.match(/[a-zA-Z_][a-zA-Z0-9_]*$/)?.[0] ?? '';
    const before = prefix.substring(0, prefix.length - partial.length);

    const path = before.match(PATH_RE);
    if (path) {
      const members = this.resolver.allMembers(path[1]).filter(isPathMember);
      return members.length > 0 ? this.items(members) : undefined;
    }

    // `value.` but not a `..` range or a number's decimal point
    if (/(?<![.\d])\.\s*$/.test(before)) {
      const type = this.resolver.receiverType(document, position.line, before);
      if (!type) return undefined;
      return this.items(this.resolver.allMembers(type).filter(isDotMember));
    }

    // A lone `:` begins a type annotation, not a path
    if (/:\s*$/.test(before) && !partial) return undefined;

    return this.bareItems(document, position);
  }

  private bareItems(document: vscode.TextDocument, position: vscode.Position): vscode.CompletionItem[] {
    const items: vscode.CompletionItem[] = [];

    // Locals first. A provider that returns items switches off VS Code's
    // word-based suggestions, so the names in scope must come from here.
    for (const [name, decl] of this.resolver.localNames(document, position.line)) {
      const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Variable);
      item.detail = decl;
      items.push(item);
    }

    // The open file as typed, then the rest of the workspace as last saved
    const live = parseSymbolsFromText(document.getText(), document.uri);
    const fromIndex = this.index.allSymbols().filter(s => s.uri.toString() !== document.uri.toString());
    const topLevel = [...live, ...fromIndex].filter(s =>
      !s.container && s.kind !== R65SymbolKind.Impl
    );
    items.push(...this.items(topLevel));

    for (const kw of KEYWORDS) items.push(new vscode.CompletionItem(kw, vscode.CompletionItemKind.Keyword));
    for (const t of PRIMITIVE_TYPES) items.push(new vscode.CompletionItem(t, vscode.CompletionItemKind.Keyword));
    return items;
  }

  /** One item per distinct declaration; vendored copies of a file collapse. */
  private items(symbols: R65Symbol[]): vscode.CompletionItem[] {
    const seen = new Set<string>();
    const items: vscode.CompletionItem[] = [];
    for (const s of symbols) {
      const label = s.kind === R65SymbolKind.Macro ? `${s.name}!` : s.name;
      const key = `${label}|${s.kind}|${s.container ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const item = new vscode.CompletionItem(label, completionKind(s));
      item.detail = s.signature;
      if (s.doc) item.documentation = new vscode.MarkdownString(s.doc);
      items.push(item);
    }
    return items;
  }
}
