import * as vscode from 'vscode';
import { R65Symbol, R65SymbolIndex, R65SymbolKind } from './symbolIndex';

/** `oam_buffer.` or `oam[i].` immediately before the cursor word */
const RECEIVER_RE = /([a-zA-Z_][a-zA-Z0-9_]*)\s*(?:\[[^\]]*\])?\s*\.\s*$/;

/** `Shape::` immediately before the cursor word: a variant, associated fn or `Type::name!` */
const PATH_RE = /\b([A-Z][a-zA-Z0-9_]*)\s*::\s*$/;

/** `impl Trait for Type {` / `impl Type {` */
const IMPL_RE = /\bimpl\s+(?:far\s+)?([A-Z][a-zA-Z0-9_]*)(?:\s+for\s+([A-Z][a-zA-Z0-9_]*))?\s*\{/;

/** `trait Name {` / `trait Sub: Super {` — default method bodies live here */
const TRAIT_RE = /\btrait\s+([A-Z][a-zA-Z0-9_]*)[^{]*\{/;

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
    const candidates = this.index.lookup(word);

    if (candidates.length === 0) return undefined;
    if (candidates.length === 1) {
      return new vscode.Location(candidates[0].uri, candidates[0].selectionRange);
    }

    const narrowed = this.narrow(document, position, wordRange, candidates);
    if (narrowed.length === 1) {
      return new vscode.Location(narrowed[0].uri, narrowed[0].selectionRange);
    }
    return narrowed.map(s => new vscode.Location(s.uri, s.selectionRange));
  }

  /**
   * Several impl blocks can define the same method name (e.g. `set!` on both
   * OamEntry and OamBuffer). Use the call's receiver to pick the right one;
   * fall back to the full candidate list whenever the type can't be resolved.
   */
  private narrow(
    document: vscode.TextDocument,
    position: vscode.Position,
    wordRange: vscode.Range,
    candidates: R65Symbol[]
  ): R65Symbol[] {
    const lineText = document.lineAt(position.line).text;
    const before = lineText.substring(0, wordRange.start.character);

    const pathMatch = before.match(PATH_RE);
    if (pathMatch) {
      const members = this.membersOf(pathMatch[1], candidates);
      return members.length > 0 ? members : candidates;
    }

    const receiverMatch = before.match(RECEIVER_RE);

    if (receiverMatch) {
      const receiver = receiverMatch[1];
      const type = receiver === 'self'
        ? this.enclosingImpl(document, position.line)
        : this.resolveReceiverType(document, position.line, receiver);

      if (type) {
        const byType = this.membersOf(type, candidates);
        if (byType.length > 0) return byType;
      }
      return candidates;
    }

    // No receiver — this is not a method call. Prefer the enclosing impl's own
    // members, then free (container-less) symbols.
    const enclosing = this.enclosingImpl(document, position.line);
    if (enclosing) {
      const own = candidates.filter(c => c.container === enclosing);
      if (own.length > 0) return own;
    }
    const free = candidates.filter(c => !c.container);
    return free.length > 0 ? free : candidates;
  }

  /**
   * Candidates that belong to `type`: its own impl members first, else the
   * default methods of traits it implements (an impl that omits a method
   * inherits the trait's body).
   */
  private membersOf(type: string, candidates: R65Symbol[]): R65Symbol[] {
    const own = candidates.filter(c => c.container === type);
    if (own.length > 0) return own;
    const traits = this.index.traitsImplementedBy(type);
    return candidates.filter(c => c.container !== undefined && traits.has(c.container));
  }

  /**
   * Type of a local `let` binding or of an enum payload binding
   * (`if let Shape::Circle(c) = ...`, `let ... else`, match arms), else the
   * declared type of a const/static.
   */
  private resolveReceiverType(
    document: vscode.TextDocument,
    line: number,
    receiver: string
  ): string | undefined {
    const localRe = new RegExp(
      `\\blet\\s+(?:mut\\s+)?${receiver}\\s*:\\s*\\[?\\s*([a-zA-Z_][a-zA-Z0-9_]*)`
    );
    const payloadRe = new RegExp(
      `\\b([A-Z][a-zA-Z0-9_]*)\\s*::\\s*([a-zA-Z_][a-zA-Z0-9_]*)\\s*\\(\\s*${receiver}\\s*\\)`
    );
    for (let i = line; i >= 0; i--) {
      const text = document.lineAt(i).text;
      const m = text.match(localRe);
      if (m) return m[1];
      const p = text.match(payloadRe);
      if (p) {
        const variant = this.index.lookup(p[2]).find(
          s => s.kind === R65SymbolKind.EnumMember && s.container === p[1]
        );
        if (variant?.declaredType) return variant.declaredType;
      }
    }

    for (const sym of this.index.lookup(receiver)) {
      if (sym.declaredType) return sym.declaredType;
    }
    return undefined;
  }

  /** Name of the impl block (its target type) or trait containing `line`, if any. */
  private enclosingImpl(document: vscode.TextDocument, line: number): string | undefined {
    let depth = 0;
    for (let i = line; i >= 0; i--) {
      const text = document.lineAt(i).text;
      const trimmed = text.trimStart();
      if (trimmed.startsWith('//')) continue;

      // Walking backwards, a `}` opens a nested block and a `{` closes it.
      for (let c = text.length - 1; c >= 0; c--) {
        const ch = text[c];
        if (ch === '}') depth++;
        else if (ch === '{') {
          if (depth === 0) {
            const m = text.match(IMPL_RE);
            if (m) return m[2] || m[1];
            const t = text.match(TRAIT_RE);
            if (t) return t[1];
          } else {
            depth--;
          }
        }
      }
    }
    return undefined;
  }
}
