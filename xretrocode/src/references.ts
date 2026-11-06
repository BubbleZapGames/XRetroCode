import * as vscode from 'vscode';
import { R65Symbol, R65SymbolIndex, R65SymbolKind, scanText } from './symbolIndex';
import { PATH_RE, R65Resolver, Word, wordAt } from './typeResolver';
import { LocalBinding, SourceText } from './sourceText';

export type Certainty = 'sure' | 'likely';

export interface RefHit {
  uri: vscode.Uri;
  range: vscode.Range;
  kind: 'decl' | 'use';
  certainty: Certainty;
  /** Why a `likely` hit isn't sure, for the rename preview. */
  reason?: string;
}

export const UNRESOLVED_RECEIVER = 'Unresolved receiver type';

/** What the word at a position names: workspace symbols, or a local in one file. */
export type RefTarget =
  | { kind: 'symbols'; word: Word; symbols: R65Symbol[] }
  | { kind: 'local'; word: Word; source: SourceText; binding: LocalBinding };

export function symbolKey(s: R65Symbol): string {
  return `${s.uri.toString()}#${s.selectionRange.start.line}:${s.selectionRange.start.character}`;
}

const MEMBER_KINDS = new Set([R65SymbolKind.Field, R65SymbolKind.EnumMember]);

/**
 * Finds what a name refers to and every place that refers to the same thing.
 * Shared by Find All References and Rename; each hit says how sure it is.
 */
export class R65ReferenceFinder {
  readonly resolver: R65Resolver;

  constructor(private index: R65SymbolIndex) {
    this.resolver = new R65Resolver(index);
  }

  /** What the word at `position` refers to, if anything. */
  target(document: vscode.TextDocument, position: vscode.Position): RefTarget | undefined {
    const w = wordAt(document, position.line, position.character);
    if (!w) return undefined;
    const source = new SourceText(document.uri, document.getText());
    const offset = source.offsetAt(w.line, w.start);
    if (source.masked[offset] !== w.word[0]) return undefined; // in a comment or string

    if (!this.isMemberPosition(source, offset, w.word.length)) {
      const binding = source.bindingAt(w.word, offset);
      if (binding) return { kind: 'local', word: w, source, binding };
    }
    const symbols = this.resolveAt(source, offset, w);
    return symbols.length > 0 ? { kind: 'symbols', word: w, symbols } : undefined;
  }

  /** Every use of `binding` in its file, its declaration first. */
  localHits(source: SourceText, binding: LocalBinding): RefHit[] {
    const hits: RefHit[] = [];
    const re = new RegExp(`\\b${binding.name}\\b`, 'g');
    for (const m of source.masked.matchAll(re)) {
      const at = m.index!;
      if (at !== binding.decl && (at < binding.start || at >= binding.end)) continue;
      if (this.isMemberPosition(source, at, binding.name.length)) continue;
      if (source.bindingAt(binding.name, at) !== binding) continue;
      hits.push({
        uri: source.uri, range: source.range(at, binding.name.length),
        kind: at === binding.decl ? 'decl' : 'use', certainty: 'sure',
      });
    }
    return hits;
  }

  /**
   * Every reference to `targets` (all named `name`) in `uris`, read from
   * open documents where they're open. Uses bound to a local of the same
   * name are skipped.
   */
  async symbolHits(
    name: string, targets: R65Symbol[], uris: vscode.Uri[], token?: vscode.CancellationToken
  ): Promise<RefHit[] | undefined> {
    const targetKeys = new Set(targets.map(symbolKey));
    const isTarget = (s: R65Symbol) => targetKeys.has(symbolKey(s));
    const candidates = this.index.lookup(name);
    // Where every same-named symbol is declared: a hit there is that symbol's, never a use.
    // An `impl Type {` line names the type rather than declaring anything.
    const declKeys = new Set(candidates.filter(c => c.kind !== R65SymbolKind.Impl).map(symbolKey));
    const re = new RegExp(`\\b${name}\\b`, 'g');
    const hits: RefHit[] = [];

    for (const uri of uris) {
      if (token?.isCancellationRequested) return undefined;
      const source = new SourceText(uri, await readText(uri));
      let containers: (string | undefined)[] | undefined;
      const containerAt = (line: number) => {
        containers ??= scanText(source.text, uri).lineContainers;
        return containers[line];
      };

      for (const m of source.masked.matchAll(re)) {
        const at = m.index!;
        const pos = source.positionAt(at);
        const range = source.range(at, name.length);
        const key = `${uri.toString()}#${pos.line}:${pos.character}`;
        if (targetKeys.has(key)) {
          hits.push({ uri, range, kind: 'decl', certainty: 'sure' });
          continue;
        }
        if (declKeys.has(key)) continue;
        const certainty = this.classify(source, at, name, candidates, isTarget, containerAt);
        if (certainty) {
          hits.push({
            uri, range, kind: 'use', certainty,
            reason: certainty === 'likely' ? UNRESOLVED_RECEIVER : undefined,
          });
        }
      }
    }
    return hits;
  }

  /** Whether the word at `offset` follows `.` / `::` / `$`, or is a `Struct { key: ... }` key. */
  private isMemberPosition(source: SourceText, offset: number, length: number): boolean {
    const before = source.masked.substring(Math.max(0, offset - 40), offset);
    // `.` is member access, but `..` is a range: `0..COUNT`
    if (/(?:(?<!\.)\.|::|\$)\s*$/.test(before)) return true;
    return source.fieldKeyOwner(offset, length) !== undefined;
  }

  /** The symbols the word at `offset` means, narrowed as `classify` narrows a hit. */
  private resolveAt(source: SourceText, offset: number, w: Word): R65Symbol[] {
    const owner = source.fieldKeyOwner(offset, w.word.length);
    if (owner) {
      const members = this.resolver.definitionMembers(owner, this.index.lookup(w.word));
      if (members.length > 0) return members;
    }
    return this.resolver.resolveSymbols(source.lineSource, w.line, w.start);
  }

  /**
   * Whether the hit at `at` is one of the targets, and how sure that is.
   * Classified by the text around it, the way `resolveSymbols` narrows.
   */
  private classify(
    source: SourceText, at: number, name: string, all: R65Symbol[],
    isTarget: (s: R65Symbol) => boolean, containerAt: (line: number) => string | undefined
  ): Certainty | undefined {
    const pos = source.positionAt(at);
    const maskedLine = source.masked.substring(at - pos.character, at + name.length + 200).split('\n')[0];
    const before = maskedLine.substring(0, pos.character);
    const after = maskedLine.substring(pos.character + name.length);
    if (/\$\s*$/.test(before)) return undefined; // a macro variable

    const candidates = byInvocation(all, before, after);
    if (!candidates.some(isTarget)) return undefined;
    // Nothing else has this name here: any hit means a target
    const sureIfOnly = (pool: R65Symbol[]): Certainty | undefined =>
      pool.some(isTarget) ? (pool.every(isTarget) ? 'sure' : 'likely') : undefined;

    const owner = source.fieldKeyOwner(at, name.length);
    if (owner) {
      const members = this.resolver.definitionMembers(owner, candidates);
      return members.length > 0 ? (members.some(isTarget) ? 'sure' : undefined) : undefined;
    }

    const path = before.match(PATH_RE);
    if (path) {
      const members = this.resolver.definitionMembers(path[1], candidates);
      if (members.length > 0) return members.some(isTarget) ? 'sure' : undefined;
      return sureIfOnly(candidates.filter(c => c.container !== undefined));
    }

    if (/(?<!\.)\.\s*$/.test(before)) {
      const members = candidates.filter(c => c.container !== undefined);
      const type = this.resolver.receiverType(source.lineSource, pos.line, before);
      if (type) {
        const byType = this.resolver.definitionMembers(type, members);
        if (byType.length > 0) return byType.some(isTarget) ? 'sure' : undefined;
      }
      return sureIfOnly(members);
    }

    // A bare name: a local of the same name hides every symbol
    if (source.bindingAt(name, at)) return undefined;
    const bare = this.resolver.narrowBare(candidates, containerAt(pos.line))
      .filter(c => !MEMBER_KINDS.has(c.kind));
    return bare.some(isTarget) ? 'sure' : undefined;
  }
}

/**
 * `name!(` invokes a macro and `name(` doesn't, so an impl with both a
 * `fn print` and a `print!` macro resolves to the one written.
 */
function byInvocation(candidates: R65Symbol[], before: string, after: string): R65Symbol[] {
  const isMacro = (s: R65Symbol) => s.kind === R65SymbolKind.Macro;
  const wantMacro = /^\s*!(?!=)/.test(after) || /macro_rules!\s*$/.test(before);
  const matching = candidates.filter(s => isMacro(s) === wantMacro);
  return matching.length > 0 ? matching : candidates;
}

/** An open document's unsaved text, else the file on disk. */
export async function readText(uri: vscode.Uri): Promise<string> {
  const open = vscode.workspace.textDocuments.find(d => d.uri.toString() === uri.toString());
  if (open) return open.getText();
  return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
}
