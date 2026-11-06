import * as vscode from 'vscode';

const IDENT_RE = /\b[a-zA-Z_][a-zA-Z0-9_]*/g;

/** Words a pattern can hold that never bind a name. */
const PATTERN_WORDS = new Set(['mut', 'far', 'near', 'ref', 'self', 'true', 'false', '_']);

/**
 * Blank out comments, string literals and char literals (`'a'`, `b'\n'`),
 * keeping columns intact. Loop labels (`'outer`) have no closing quote and stay.
 * With `keepStrings`, string literals are left as written (for `asm!` scans).
 */
export function maskCode(lines: string[], keepStrings = false): string[] {
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
        out += keepStrings ? line.substring(i, j) : ' '.repeat(j - i);
        i = j;
        continue;
      }
      if (line[i] === "'") {
        const len = charLiteralLength(line, i);
        if (len > 0) {
          // A byte literal's `b` prefix goes with it
          if (out.endsWith('b') && !/\w/.test(out[out.length - 2] ?? '')) out = out.slice(0, -1) + ' ';
          out += ' '.repeat(len);
          i += len;
          continue;
        }
      }
      out += line[i];
      i++;
    }
    return out;
  });
}

/** Length of the char literal opening at `i` (`'a'`, `'\n'`, `'\x41'`), else 0 for a label. */
function charLiteralLength(line: string, i: number): number {
  if (line[i + 1] === '\\') {
    const close = line.indexOf("'", i + 3);
    return close > 0 && close - i <= 6 ? close - i + 1 : 0;
  }
  return line[i + 2] === "'" && line[i + 1] !== undefined ? 3 : 0;
}

/** A name bound inside a fn body: a parameter, `let`, `for` or pattern binding. */
export interface LocalBinding {
  name: string;
  /** Offset of the name where it's declared. */
  decl: number;
  /** Uses at offsets in [start, end) see this binding, unless a later one shadows it. */
  start: number;
  end: number;
}

/**
 * One file's text, masked once, with offset ↔ position conversion, brace
 * matching and the local bindings of every fn in it.
 */
export class SourceText {
  readonly lines: string[];
  /** Comments and strings blanked, lines joined with `\n`; offsets match `text`. */
  readonly masked: string;
  private lineStarts: number[] = [];
  private pairs: [number, number][] | undefined;
  private closeOf: Map<number, number> | undefined;
  private bindingCache: LocalBinding[] | undefined;

  constructor(readonly uri: vscode.Uri, readonly text: string) {
    this.lines = text.split('\n');
    this.masked = maskCode(this.lines).join('\n');
    let at = 0;
    for (const line of this.lines) {
      this.lineStarts.push(at);
      at += line.length + 1;
    }
  }

  offsetAt(line: number, character: number): number {
    return this.lineStarts[line] + character;
  }

  positionAt(offset: number): { line: number; character: number } {
    let lo = 0;
    let hi = this.lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.lineStarts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo, character: offset - this.lineStarts[lo] };
  }

  range(offset: number, length: number): vscode.Range {
    const s = this.positionAt(offset);
    return new vscode.Range(s.line, s.character, s.line, s.character + length);
  }

  /** The LineSource view the resolver reads. */
  get lineSource() {
    return { lineAt: (n: number) => ({ text: this.lines[n] }), lineCount: this.lines.length };
  }

  /** Every `{` with its matching `}` (the text's end when unclosed), in source order. */
  bracePairs(): [number, number][] {
    if (!this.pairs) {
      this.pairs = [];
      this.closeOf = new Map();
      const stack: number[] = [];
      const m = this.masked;
      for (let i = 0; i < m.length; i++) {
        if (m[i] === '{') stack.push(i);
        else if (m[i] === '}' && stack.length > 0) this.closeOf.set(stack.pop()!, i);
      }
      for (const open of stack) this.closeOf.set(open, m.length);
      this.pairs = [...this.closeOf.entries()].sort((a, b) => a[0] - b[0]);
    }
    return this.pairs;
  }

  /** The `}` matching the `{` at `open`. */
  matchingBrace(open: number): number {
    this.bracePairs();
    return this.closeOf!.get(open) ?? this.masked.length;
  }

  /** The innermost `{ ... }` holding `offset`, if any. */
  enclosingBlock(offset: number): [number, number] | undefined {
    let best: [number, number] | undefined;
    for (const pair of this.bracePairs()) {
      if (pair[0] >= offset) break;
      if (pair[1] >= offset) best = pair;
    }
    return best;
  }

  /** All local bindings in the file. */
  bindings(): LocalBinding[] {
    this.bindingCache ??= this.scanBindings();
    return this.bindingCache;
  }

  /** The binding named `name` that a use at `offset` sees, or the one declared there. */
  bindingAt(name: string, offset: number): LocalBinding | undefined {
    let best: LocalBinding | undefined;
    for (const b of this.bindings()) {
      if (b.name !== name) continue;
      if (b.decl === offset) return b;
      if (b.start <= offset && offset < b.end && (!best || b.start > best.start)) best = b;
    }
    return best;
  }

  /**
   * Whether the word at `offset` is a struct literal or declaration key,
   * `Owner { name: ... }`; returns `Owner`, else undefined.
   */
  fieldKeyOwner(offset: number, length: number): string | undefined {
    const m = this.masked;
    let p = offset - 1;
    while (p >= 0 && /\s/.test(m[p])) p--;
    if (m[p] !== '{' && m[p] !== ',') return undefined;
    let q = offset + length;
    while (q < m.length && /[ \t]/.test(m[q])) q++;
    if (m[q] !== ':' || m[q + 1] === ':') return undefined;
    const block = this.enclosingBlock(offset);
    if (!block) return undefined;
    // Inside parens or brackets it's a parameter, not a key: `fn f(a: u8, b: u8)` in an impl
    let depth = 0;
    for (let i = block[0] + 1; i < offset; i++) {
      if (m[i] === '(' || m[i] === '[') depth++;
      else if (m[i] === ')' || m[i] === ']') depth--;
    }
    if (depth !== 0) return undefined;
    const owner = m.substring(0, block[0]).match(/\b([A-Z][a-zA-Z0-9_]*)\s*$/);
    return owner?.[1];
  }

  private scanBindings(): LocalBinding[] {
    const found: LocalBinding[] = [];
    const m = this.masked;
    const add = (names: { name: string; at: number }[], start: number, end: number) => {
      for (const n of names) found.push({ name: n.name, decl: n.at, start, end });
    };

    // Parameters: bound in the fn's body
    for (const fn of m.matchAll(/\bfn\s+[a-zA-Z_][a-zA-Z0-9_]*\s*\(/g)) {
      const open = fn.index! + fn[0].length - 1;
      const close = this.skipBalanced(open);
      if (close < 0) continue;
      const body = this.nextBodyOpen(close + 1);
      if (body < 0) continue;
      add(paramNames(m, open + 1, close), body, this.matchingBrace(body));
    }

    for (const kw of m.matchAll(/\blet\b/g)) {
      const at = kw.index!;
      const before = m.substring(Math.max(0, at - 12), at);
      const patternEnd = this.patternEnd(at + 3);
      const names = patternNames(m, at + 3, patternEnd);
      if (/\b(?:if|while)\s*$/.test(before)) {
        // `if let` / `while let`: bound in the block that follows
        const body = this.nextBodyOpen(patternEnd);
        if (body >= 0) add(names, body, this.matchingBrace(body));
        continue;
      }
      // A plain `let` (or `let ... else`): from the end of the statement to the end of its block
      const semi = this.statementEnd(at);
      const block = this.enclosingBlock(at);
      add(names, semi, block ? block[1] : m.length);
    }

    for (const f of m.matchAll(/\bfor\s+([a-zA-Z_][a-zA-Z0-9_]*)\s+in\b/g)) {
      const body = this.nextBodyOpen(f.index! + f[0].length);
      if (body >= 0) add([{ name: f[1], at: f.index! + f[0].indexOf(f[1], 3) }], body, this.matchingBrace(body));
    }

    // Match arms with payload bindings: `Shape::Circle(c) =>`
    for (const arm of m.matchAll(/::\s*[a-zA-Z_][a-zA-Z0-9_]*\s*\(([^()]*)\)\s*(?:if\b[^=]*)?=>/g)) {
      const argsAt = arm.index! + arm[0].indexOf('(') + 1;
      const names = patternNames(m, argsAt, argsAt + arm[1].length);
      const arrow = arm.index! + arm[0].length;
      add(names, arrow, this.armEnd(arrow));
    }

    return found;
  }

  /** Offset of the `)` / `]` / `}` matching the opener at `open`, else -1. */
  private skipBalanced(open: number): number {
    const m = this.masked;
    let depth = 0;
    for (let i = open; i < m.length; i++) {
      const ch = m[i];
      if (ch === '(' || ch === '[' || ch === '{') depth++;
      else if (ch === ')' || ch === ']' || ch === '}') {
        depth--;
        if (depth === 0) return i;
        if (depth < 0) return -1;
      }
    }
    return -1;
  }

  /** The `{` opening the body after a header, or -1 when a `;` ends it first. */
  private nextBodyOpen(from: number): number {
    const m = this.masked;
    let depth = 0;
    for (let i = from; i < m.length; i++) {
      const ch = m[i];
      if (ch === '(' || ch === '[') depth++;
      else if (ch === ')' || ch === ']') depth--;
      else if (depth === 0 && ch === '{') return i;
      else if (depth === 0 && (ch === ';' || ch === '}')) return -1;
    }
    return -1;
  }

  /** Where a `let` pattern ends: its top-level `=` (not `==`/`=>`), `;` or the end. */
  private patternEnd(from: number): number {
    const m = this.masked;
    let depth = 0;
    for (let i = from; i < m.length; i++) {
      const ch = m[i];
      if (ch === '(' || ch === '[') depth++;
      else if (ch === ')' || ch === ']') depth--;
      else if (depth === 0 && ch === '=' && m[i + 1] !== '=' && m[i + 1] !== '>' && !'!<>='.includes(m[i - 1])) return i;
      else if (depth === 0 && (ch === ';' || ch === '{' || ch === '}')) return i;
    }
    return m.length;
  }

  /** The `;` ending the statement that starts at `from` (past any nested braces), plus one. */
  private statementEnd(from: number): number {
    const m = this.masked;
    let depth = 0;
    for (let i = from; i < m.length; i++) {
      const ch = m[i];
      if (ch === '(' || ch === '[' || ch === '{') depth++;
      else if (ch === ')' || ch === ']' || ch === '}') {
        if (--depth < 0) return i;
      } else if (depth === 0 && ch === ';') return i + 1;
    }
    return m.length;
  }

  /** The end of a match arm's body starting after `=>`: its block, else the next top-level `,` or `}`. */
  private armEnd(from: number): number {
    const m = this.masked;
    let i = from;
    while (i < m.length && /\s/.test(m[i])) i++;
    if (m[i] === '{') return this.matchingBrace(i) + 1;
    let depth = 0;
    for (; i < m.length; i++) {
      const ch = m[i];
      if (ch === '(' || ch === '[' || ch === '{') depth++;
      else if (ch === ')' || ch === ']' || ch === '}') {
        if (--depth < 0) return i;
      } else if (depth === 0 && ch === ',') return i;
    }
    return m.length;
  }
}

/** Names a pattern binds between `from` and `to`, skipping types, paths, keywords and `@` locations. */
function patternNames(m: string, from: number, to: number): { name: string; at: number }[] {
  let text = m.substring(from, to);
  // A type annotation: the first `:` that isn't part of `::`
  const colon = text.search(/(?<!:):(?!:)/);
  if (colon >= 0) text = text.substring(0, colon);
  const names: { name: string; at: number }[] = [];
  for (const w of text.matchAll(IDENT_RE)) {
    const name = w[0];
    const before = text.substring(0, w.index!);
    const after = text.substring(w.index! + name.length);
    if (PATTERN_WORDS.has(name)) continue;
    if (/::\s*$/.test(before) || /^\s*::/.test(after)) continue;
    if (/@\s*$/.test(before) || /^\s*\(/.test(after)) continue;
    if (/^[A-Z]$/.test(name)) continue;
    names.push({ name, at: from + w.index! });
  }
  return names;
}

/** Parameter names between a fn header's parens. */
function paramNames(m: string, from: number, to: number): { name: string; at: number }[] {
  const names: { name: string; at: number }[] = [];
  let depth = 0;
  let start = from;
  const take = (end: number) => {
    const item = m.substring(start, end);
    const p = item.match(/^(\s*(?:(?:far|near)\s+)?\*?\s*)([a-zA-Z_][a-zA-Z0-9_]*)\s*(?:@\s*[a-zA-Z_][a-zA-Z0-9_]*\s*)?:/);
    if (p && p[2] !== 'self') names.push({ name: p[2], at: start + p[1].length });
  };
  for (let i = from; i < to; i++) {
    const ch = m[i];
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (ch === ',' && depth === 0) {
      take(i);
      start = i + 1;
    }
  }
  take(to);
  return names;
}
