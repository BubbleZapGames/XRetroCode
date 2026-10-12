import * as vscode from 'vscode';
import { R65Symbol, R65SymbolIndex, scanText } from './symbolIndex';
import { LineSource, PATH_RE, R65Resolver, Word, wordAt } from './typeResolver';

const FN_LINE_RE = /\bfn\s+[a-zA-Z_][a-zA-Z0-9_]*\s*\(/;

/** Blank out comments and string literals, keeping columns intact. */
export function maskCode(lines: string[]): string[] {
  let inBlock = false;
  return lines.map(line => {
    let out = '';
    let i = 0;
    while (i < line.length) {
      if (inBlock) {
        const end = line.indexOf('*/', i);
        const stop = end < 0 ? line.length : end + 2;
        out += ' '.repeat(stop - i);
        i = stop;
        if (end >= 0) inBlock = false;
        continue;
      }
      if (line.startsWith('//', i)) {
        out += ' '.repeat(line.length - i);
        break;
      }
      if (line.startsWith('/*', i)) {
        inBlock = true;
        out += '  ';
        i += 2;
        continue;
      }
      if (line[i] === '"') {
        let j = i + 1;
        while (j < line.length && line[j] !== '"') {
          if (line[j] === '\\') j++;
          j++;
        }
        j = Math.min(j + 1, line.length);
        out += ' '.repeat(j - i);
        i = j;
        continue;
      }
      out += line[i];
      i++;
    }
    return out;
  });
}

function symbolKey(s: R65Symbol): string {
  return `${s.uri.toString()}#${s.selectionRange.start.line}:${s.selectionRange.start.character}`;
}

export class R65ReferenceProvider implements vscode.ReferenceProvider {
  private resolver: R65Resolver;

  constructor(private index: R65SymbolIndex) {
    this.resolver = new R65Resolver(index);
  }

  async provideReferences(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: vscode.ReferenceContext,
    token?: vscode.CancellationToken
  ): Promise<vscode.Location[] | undefined> {
    const w = wordAt(document, position.line, position.character);
    if (!w) return undefined;

    const targets = this.resolver.resolveSymbols(document, position.line, position.character);
    if (targets.length === 0) return this.localReferences(document, w);

    const targetKeys = new Set(targets.map(symbolKey));
    const isTarget = (s: R65Symbol) => targetKeys.has(symbolKey(s));
    const candidates = this.index.lookup(w.word);
    // Every declaration of the name is a target (e.g. stdlib vendored into each
    // game): any textual hit counts, no need to resolve it
    const everyCandidate = candidates.every(isTarget);
    const wordRe = new RegExp(`\\b${w.word}\\b`, 'g');

    const results: vscode.Location[] = [];
    for (const uri of await vscode.workspace.findFiles('**/*.r65')) {
      if (token?.isCancellationRequested) return undefined;
      const text = await this.readText(uri);
      const lines = text.split('\n');
      const masked = maskCode(lines);
      const src: LineSource = { lineAt: (n: number) => ({ text: lines[n] }), lineCount: lines.length };
      let containers: (string | undefined)[] | undefined;
      const containerAt = (line: number) => {
        containers ??= scanText(text, uri).lineContainers;
        return containers[line];
      };

      for (let i = 0; i < lines.length; i++) {
        for (const m of masked[i].matchAll(wordRe)) {
          const col = m.index!;
          if (targetKeys.has(`${uri.toString()}#${i}:${col}`)) {
            if (context.includeDeclaration) results.push(this.location(uri, i, col, w.word));
            continue;
          }
          if (everyCandidate || this.hitIsTarget(src, masked[i], i, col, candidates, isTarget, containerAt)) {
            results.push(this.location(uri, i, col, w.word));
          }
        }
      }
    }
    return results;
  }

  /**
   * Whether the hit at `line`:`col` means one of the targets. Classified by the
   * text before it, the way `resolveSymbols` narrows, without its backward scans
   * for the common cases.
   */
  private hitIsTarget(
    src: LineSource, maskedLine: string, line: number, col: number, candidates: R65Symbol[],
    isTarget: (s: R65Symbol) => boolean, containerAt: (line: number) => string | undefined
  ): boolean {
    const before = maskedLine.substring(0, col);

    const path = before.match(PATH_RE);
    if (path) {
      const members = this.resolver.definitionMembers(path[1], candidates);
      return (members.length > 0 ? members : candidates).some(isTarget);
    }
    if (/\.\s*$/.test(before)) {
      return this.resolver.resolveSymbols(src, line, col).some(isTarget);
    }
    return this.resolver.narrowBare(candidates, containerAt(line)).some(isTarget);
  }

  /** Uses of a local or parameter, within the fn that binds it. */
  private localReferences(document: vscode.TextDocument, w: Word): vscode.Location[] | undefined {
    if (!this.resolver.bindingAt(document, w.line, w.word)) return undefined;

    let start = w.line;
    while (start > 0 && !FN_LINE_RE.test(document.lineAt(start).text)) start--;
    const lines: string[] = [];
    for (let i = 0; i < document.lineCount; i++) lines.push(document.lineAt(i).text);
    const masked = maskCode(lines);

    const results: vscode.Location[] = [];
    const wordRe = new RegExp(`\\b${w.word}\\b`, 'g');
    let depth = 0;
    let opened = false;
    for (let i = start; i < lines.length; i++) {
      for (const m of masked[i].matchAll(wordRe)) {
        // A field or path member of the same name is someone else's
        if (/(?:\.|::)\s*$/.test(masked[i].substring(0, m.index!))) continue;
        results.push(this.location(document.uri, i, m.index!, w.word));
      }
      for (const ch of masked[i]) {
        if (ch === '{') { depth++; opened = true; }
        if (ch === '}') depth--;
      }
      if (opened && depth <= 0) break;
    }
    return results;
  }

  private location(uri: vscode.Uri, line: number, col: number, word: string): vscode.Location {
    return new vscode.Location(uri, new vscode.Range(line, col, line, col + word.length));
  }

  /** An open document's unsaved text, else the file on disk. */
  private async readText(uri: vscode.Uri): Promise<string> {
    const open = vscode.workspace.textDocuments.find(d => d.uri.toString() === uri.toString());
    if (open) return open.getText();
    return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
  }
}
