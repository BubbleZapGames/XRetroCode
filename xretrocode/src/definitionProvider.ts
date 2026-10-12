import * as vscode from 'vscode';
import { R65Symbol, R65SymbolIndex } from './symbolIndex';

/** `oam_buffer.` or `oam[i].` immediately before the cursor word */
const RECEIVER_RE = /([a-zA-Z_][a-zA-Z0-9_]*)\s*(?:\[[^\]]*\])?\s*\.\s*$/;

/** `impl Trait for Type {` / `impl Type {` */
const IMPL_RE = /\bimpl\s+(?:far\s+)?([A-Z][a-zA-Z0-9_]*)(?:\s+for\s+([A-Z][a-zA-Z0-9_]*))?\s*\{/;

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

    const receiverMatch = before.match(RECEIVER_RE);

    if (receiverMatch) {
      const receiver = receiverMatch[1];
      const type = receiver === 'self'
        ? this.enclosingImpl(document, position.line)
        : this.resolveReceiverType(document, position.line, receiver);

      if (type) {
        const byType = candidates.filter(c => c.container === type);
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

  /** Type of a local `let` binding, else the declared type of a const/static. */
  private resolveReceiverType(
    document: vscode.TextDocument,
    line: number,
    receiver: string
  ): string | undefined {
    const localRe = new RegExp(
      `\\blet\\s+(?:mut\\s+)?${receiver}\\s*:\\s*\\[?\\s*([a-zA-Z_][a-zA-Z0-9_]*)`
    );
    for (let i = line; i >= 0; i--) {
      const m = document.lineAt(i).text.match(localRe);
      if (m) return m[1];
    }

    for (const sym of this.index.lookup(receiver)) {
      if (sym.declaredType) return sym.declaredType;
    }
    return undefined;
  }

  /** Name of the impl block containing `line`, if any. */
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
          } else {
            depth--;
          }
        }
      }
    }
    return undefined;
  }
}
