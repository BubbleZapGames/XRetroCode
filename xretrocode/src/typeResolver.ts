import {
  R65Symbol, R65SymbolIndex, R65SymbolKind, ValueShape, baseTypeName, declTypeText, elementTypeText,
  parseFnHeader, valueShape,
} from './symbolIndex';

/** The slice of a TextDocument the resolver reads; files off disk satisfy it too. */
export interface LineSource {
  lineAt(line: number): { text: string };
  lineCount: number;
}

export interface Word {
  word: string;
  line: number;
  start: number;
  end: number;
}

/** How a name is bound in the code around a position. */
export interface Binding {
  /** Reduced type name; undefined for primitives. */
  type?: string;
  /** The binding as written, e.g. `let mut p: *OamEntry` or `src: far *u8`. */
  decl: string;
  /** The type as written, pattern-side pointer folded in, e.g. `far *u8`. */
  typeText?: string;
}

/** What a receiver chain evaluates to. */
export interface Receiver {
  /** Reduced type name; undefined for primitives. */
  type?: string;
  /** Which compiler intrinsics the value itself takes, if any. */
  shape?: ValueShape;
}

const IDENT = '[a-zA-Z_][a-zA-Z0-9_]*';

/** `Shape::` immediately before the cursor word: a variant, associated fn or `Type::name!` */
export const PATH_RE = /\b([A-Z][a-zA-Z0-9_]*)\s*::\s*$/;

/**
 * A receiver chain immediately before the cursor word, ending in `.`:
 * `self.tilemap.bmp.`, `oam[i].`, `(*p).`, `Q10::from_int(3).`, `tile.0.`. The head may
 * not follow a `.` itself — a call in mid-chain (`a.b(c).d.`) isn't followed.
 */
const CHAIN_RE = new RegExp(
  `(?<![.\\w])(?:\\(\\s*\\*\\s*(?<deref>${IDENT})\\s*\\)|(?<pathType>[A-Z][a-zA-Z0-9_]*)\\s*::\\s*(?<pathFn>${IDENT})\\s*\\([^()]*\\)|(?<head>${IDENT}))` +
  `(?:\\s*\\[[^\\]]*\\])*(?<fields>(?:\\s*\\.\\s*(?:${IDENT}|\\d+)(?:\\s*\\[[^\\]]*\\])*)*)\\s*\\.\\s*$`
);

/** `impl Trait for Type {` / `impl Type {` */
const IMPL_RE = /\bimpl\s+(?:far\s+)?([A-Z][a-zA-Z0-9_]*)(?:\s+for\s+([A-Z][a-zA-Z0-9_]*))?\s*\{/;

/** `trait Name {` / `trait Sub: Super {` — default method bodies live here */
const TRAIT_RE = /\btrait\s+([A-Z][a-zA-Z0-9_]*)[^{]*\{/;

const FN_LINE_RE = /\bfn\s+[a-zA-Z_][a-zA-Z0-9_]*\s*\(/;

/** The identifier under `character` on `line`, if any. */
export function wordAt(src: LineSource, line: number, character: number): Word | undefined {
  const text = src.lineAt(line).text;
  const re = new RegExp(IDENT, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index <= character && m.index + m[0].length > character) {
      return { word: m[0], line, start: m.index, end: m.index + m[0].length };
    }
  }
  return undefined;
}

export class R65Resolver {
  constructor(private index: R65SymbolIndex) {}

  /**
   * Symbols the word at a position may refer to. Several impl blocks can
   * define the same method name (e.g. `set!` on both OamEntry and OamBuffer),
   * so the call's receiver picks the right one; fall back to the full
   * candidate list whenever the type can't be resolved.
   */
  resolveSymbols(src: LineSource, line: number, character: number): R65Symbol[] {
    const w = wordAt(src, line, character);
    if (!w) return [];
    const text = src.lineAt(line).text;
    const before = text.substring(0, w.start);
    const candidates = this.byInvocation(this.index.lookup(w.word), before, text.substring(w.end));
    if (candidates.length === 0) return [];

    const pathMatch = before.match(PATH_RE);
    if (pathMatch) {
      const members = this.definitionMembers(pathMatch[1], candidates);
      return members.length > 0 ? members : candidates;
    }

    if (CHAIN_RE.test(before)) {
      const type = this.receiverType(src, line, before);
      if (type) {
        const byType = this.definitionMembers(type, candidates);
        if (byType.length > 0) return byType;
      }
      return candidates;
    }

    return this.narrowBare(candidates, this.enclosingContainer(src, line));
  }

  /**
   * `name!(` invokes a macro and `name(` doesn't, so an impl with both a
   * `fn print` and a `print!` macro resolves to the one written.
   */
  private byInvocation(candidates: R65Symbol[], before: string, after: string): R65Symbol[] {
    const isMacro = (s: R65Symbol) => s.kind === R65SymbolKind.Macro;
    const wantMacro = /^\s*!/.test(after) || /macro_rules!\s*$/.test(before);
    const matching = candidates.filter(s => isMacro(s) === wantMacro);
    return matching.length > 0 ? matching : candidates;
  }

  /**
   * A name with no receiver: never a field. Prefer the enclosing impl's or
   * trait's own members, then free (container-less) symbols.
   */
  narrowBare(candidates: R65Symbol[], enclosing: string | undefined): R65Symbol[] {
    const named = candidates.filter(c => c.kind !== R65SymbolKind.Field);
    if (named.length <= 1) return named;
    if (enclosing) {
      const own = named.filter(c => c.container === enclosing);
      if (own.length > 0) return own;
    }
    const free = named.filter(c => !c.container);
    return free.length > 0 ? free : named;
  }

  /**
   * Candidates that belong to `type`: its own members first, else the
   * default methods of traits it implements (an impl that omits a method
   * inherits the trait's body).
   */
  definitionMembers(type: string, candidates: R65Symbol[]): R65Symbol[] {
    const own = candidates.filter(c => c.container === type);
    if (own.length > 0) return own;
    const traits = this.index.traitsImplementedBy(type);
    return candidates.filter(c => c.container !== undefined && traits.has(c.container));
  }

  /** Everything reachable on `type`: its fields, variants, methods and macros, plus its traits' methods. */
  allMembers(type: string): R65Symbol[] {
    const members = [...this.index.membersOfContainer(type)];
    const own = new Set(members.map(m => m.name));
    for (const trait of this.index.traitsImplementedBy(type)) {
      for (const m of this.index.membersOfContainer(trait)) {
        if (!own.has(m.name)) members.push(m);
      }
    }
    return members;
  }

  /** Type of the receiver chain that `before` (text up to the cursor word) ends with. */
  receiverType(src: LineSource, line: number, before: string): string | undefined {
    return this.receiver(src, line, before)?.type;
  }

  /** The receiver chain that `before` ends with: its type and the intrinsics it takes. */
  receiver(src: LineSource, line: number, before: string): Receiver | undefined {
    const m = before.match(CHAIN_RE);
    if (!m?.groups) return undefined;
    const g = m.groups;

    let type: string | undefined;
    // The last segment's written type; each `(*p)` or trailing `[i]` peels a level
    let typeText: string | undefined;
    let peel = (before.match(/((?:\s*\[[^\]]*\])*)\s*\.\s*$/)![1].match(/\[/g) ?? []).length;
    if (g.deref) {
      const binding = this.bindingAt(src, line, g.deref);
      type = binding?.type;
      typeText = binding?.typeText;
      if (!g.fields) peel++;
    } else if (g.pathType) {
      type = this.definitionMembers(g.pathType, this.index.lookup(g.pathFn))
        .find(s => s.kind === R65SymbolKind.Function)?.returnType;
    } else if (g.head === 'self') {
      type = this.enclosingContainer(src, line);
    } else {
      const binding = this.bindingAt(src, line, g.head);
      type = binding?.type;
      typeText = binding?.typeText;
    }

    for (const field of g.fields.split('.').map(f => f.replace(/\[.*$/, '').trim()).filter(Boolean)) {
      if (!type) return undefined;
      const sym = this.fieldSymbol(type, field);
      type = sym?.declaredType;
      typeText = sym?.typeText;
    }

    for (; peel > 0 && typeText !== undefined; peel--) typeText = elementTypeText(typeText);
    const shape = peel === 0 ? valueShape(typeText) : undefined;
    return type || shape !== undefined ? { type, shape } : undefined;
  }

  private fieldSymbol(type: string, field: string): R65Symbol | undefined {
    return this.index.lookup(field)
      .find(s => s.kind === R65SymbolKind.Field && s.container === type);
  }

  /**
   * How `name` is bound at `line`, nearest first: a `let`, an enum payload
   * binding (`if let`, `let ... else`, match arms), a `for` variable, a
   * parameter of the enclosing fn — scanning no further back than its header —
   * else a const/static.
   */
  bindingAt(src: LineSource, line: number, name: string): Binding | undefined {
    const letRe = new RegExp(
      `\\blet\\s+(?:(?:far|near)\\s+)?(?:mut\\s+)?\\*?\\s*${name}\\s*(?:@\\s*${IDENT})?\\s*:\\s*([^=;]+)`
    );
    const payloadRe = new RegExp(`\\b([A-Z][a-zA-Z0-9_]*)\\s*::\\s*(${IDENT})\\s*\\(\\s*${name}\\s*\\)`);
    const forRe = new RegExp(`\\bfor\\s+${name}\\s+in\\b`);

    for (let i = line; i >= 0; i--) {
      const text = src.lineAt(i).text;
      const m = text.match(letRe);
      if (m) {
        const decl = text.substring(m.index!, m.index! + m[0].length).trim();
        return { type: baseTypeName(m[1]), decl, typeText: declTypeText(decl) };
      }
      const p = text.match(payloadRe);
      if (p) {
        const variant = this.index.lookup(p[2]).find(
          s => s.kind === R65SymbolKind.EnumMember && s.container === p[1]
        );
        if (variant) return { type: variant.declaredType, decl: `${p[1]}::${p[2]}(${name})` };
      }
      if (forRe.test(text)) return { decl: `for ${name} in ..` };
      if (FN_LINE_RE.test(text)) {
        const param = parseFnHeader(text)?.params.find(p => p.name === name);
        if (param) {
          return name === 'self'
            ? { type: this.enclosingContainer(src, i), decl: param.text }
            : { type: param.type, decl: param.text, typeText: param.typeText };
        }
        break;
      }
    }

    for (const sym of this.index.lookup(name)) {
      if ((sym.kind === R65SymbolKind.Static || sym.kind === R65SymbolKind.Constant) && (sym.declaredType || sym.typeText)) {
        return { type: sym.declaredType, decl: sym.signature ?? name, typeText: sym.typeText };
      }
    }
    return undefined;
  }

  /**
   * Names bound inside the fn enclosing `line`: lets, payload and `for`
   * bindings above it, and the fn's parameters.
   */
  localNames(src: LineSource, line: number): Map<string, string> {
    const names = new Map<string, string>();
    const letRe = new RegExp(`\\blet\\s+(?:(?:far|near)\\s+)?(?:mut\\s+)?\\*?\\s*(${IDENT})`, 'g');
    const payloadRe = new RegExp(`::\\s*${IDENT}\\s*\\(\\s*([a-z_][a-zA-Z0-9_]*)\\s*\\)`, 'g');
    const forRe = new RegExp(`\\bfor\\s+(${IDENT})\\s+in\\b`, 'g');
    const add = (name: string, decl: string) => { if (!names.has(name)) names.set(name, decl); };

    for (let i = line; i >= 0; i--) {
      const text = src.lineAt(i).text;
      if (FN_LINE_RE.test(text)) {
        for (const p of parseFnHeader(text)?.params ?? []) add(p.name, p.text);
        break;
      }
      for (const m of text.matchAll(letRe)) add(m[1], 'let');
      for (const m of text.matchAll(forRe)) add(m[1], 'for');
      if (/\blet\b|=>/.test(text)) {
        for (const m of text.matchAll(payloadRe)) add(m[1], 'binding');
      }
    }
    return names;
  }

  /** Name of the impl block (its target type) or trait containing `line`, if any. */
  enclosingContainer(src: LineSource, line: number): string | undefined {
    let depth = 0;
    for (let i = line; i >= 0; i--) {
      const text = src.lineAt(i).text;
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
