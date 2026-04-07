import * as assert from 'assert';
import { Uri, Position, Range, Location, workspace } from './vscode-mock';
import { parseSymbolsFromText, R65SymbolKind, R65SymbolIndex } from '../symbolIndex';
import { R65DefinitionProvider } from '../definitionProvider';
import { R65DocumentSymbolProvider } from '../documentSymbolProvider';

function parse(text: string, path = '/test/file.r65') {
  return parseSymbolsFromText(text, Uri.file(path) as any);
}

function findByName(syms: ReturnType<typeof parse>, name: string) {
  return syms.find(s => s.name === name);
}

function findByKind(syms: ReturnType<typeof parse>, kind: R65SymbolKind) {
  return syms.filter(s => s.kind === kind);
}

function createMockDocument(content: string, path = '/test/file.r65'): any {
  const lines = content.split('\n');
  return {
    uri: Uri.file(path),
    getText: (range?: any) => {
      if (!range) return content;
      return lines[range.start.line].substring(range.start.character, range.end.character);
    },
    getWordRangeAtPosition: (pos: any, regex?: RegExp) => {
      const line = lines[pos.line];
      const re = new RegExp((regex || /[a-zA-Z_][a-zA-Z0-9_]*/).source, 'g');
      let match;
      while ((match = re.exec(line)) !== null) {
        if (match.index <= pos.character && match.index + match[0].length > pos.character) {
          return new Range(pos.line, match.index, pos.line, match.index + match[0].length);
        }
      }
      return undefined;
    },
    lineAt: (line: number) => ({ text: lines[line] }),
    lineCount: lines.length,
  };
}

// ── Symbol Parsing ──────────────────────────────────────────

describe('Symbol Parsing', () => {
  it('should parse fn definition', () => {
    const syms = parse('fn my_func() {');
    const sym = findByName(syms, 'my_func');
    assert.ok(sym);
    assert.strictEqual(sym.kind, R65SymbolKind.Function);
  });

  it('should parse far fn definition', () => {
    const syms = parse('far fn init(far *self) {');
    const sym = findByName(syms, 'init');
    assert.ok(sym);
    assert.strictEqual(sym.kind, R65SymbolKind.Function);
  });

  it('should parse const fn definition', () => {
    const syms = parse('const fn size() -> u8 {');
    const sym = findByName(syms, 'size');
    assert.ok(sym);
    assert.strictEqual(sym.kind, R65SymbolKind.Function);
  });

  it('should parse fn with register binding', () => {
    const syms = parse('far fn add(a @ A: u8, b @ X: u16) -> u8 {');
    const sym = findByName(syms, 'add');
    assert.ok(sym);
    assert.strictEqual(sym.kind, R65SymbolKind.Function);
  });

  it('should parse struct definition', () => {
    const syms = parse('struct Player {');
    const sym = findByName(syms, 'Player');
    assert.ok(sym);
    assert.strictEqual(sym.kind, R65SymbolKind.Struct);
  });

  it('should parse enum definition', () => {
    const syms = parse('enum Direction {');
    const sym = findByName(syms, 'Direction');
    assert.ok(sym);
    assert.strictEqual(sym.kind, R65SymbolKind.Enum);
  });

  it('should parse trait definition', () => {
    const syms = parse('trait Drawable {');
    const sym = findByName(syms, 'Drawable');
    assert.ok(sym);
    assert.strictEqual(sym.kind, R65SymbolKind.Trait);
  });

  it('should parse type alias', () => {
    const syms = parse('type Score = u16;');
    const sym = findByName(syms, 'Score');
    assert.ok(sym);
    assert.strictEqual(sym.kind, R65SymbolKind.TypeAlias);
  });

  it('should parse const definition', () => {
    const syms = parse('const MAX_HP: u8 = 100;');
    const sym = findByName(syms, 'MAX_HP');
    assert.ok(sym);
    assert.strictEqual(sym.kind, R65SymbolKind.Constant);
  });

  it('should not parse const fn as constant', () => {
    const syms = parse('const fn size() -> u8 {');
    const constants = findByKind(syms, R65SymbolKind.Constant);
    assert.strictEqual(constants.length, 0);
    assert.ok(findByName(syms, 'size'));
  });

  it('should parse static mut definition', () => {
    const syms = parse('static mut PLAYER_X: u8;');
    const sym = findByName(syms, 'PLAYER_X');
    assert.ok(sym);
    assert.strictEqual(sym.kind, R65SymbolKind.Static);
  });

  it('should parse static without mut', () => {
    const syms = parse('static COUNTER: u8;');
    const sym = findByName(syms, 'COUNTER');
    assert.ok(sym);
    assert.strictEqual(sym.kind, R65SymbolKind.Static);
  });

  it('should parse macro_rules definition', () => {
    const syms = parse('macro_rules! set_bg($x:expr) {');
    const sym = findByName(syms, 'set_bg');
    assert.ok(sym);
    assert.strictEqual(sym.kind, R65SymbolKind.Macro);
  });

  it('should skip line-commented definitions', () => {
    const syms = parse('// fn not_a_function() {');
    assert.strictEqual(syms.length, 0);
  });

  it('should skip block-commented definitions', () => {
    const syms = parse('/* fn not_a_function() { */');
    assert.strictEqual(syms.length, 0);
  });

  it('should skip multi-line block comments', () => {
    const syms = parse('/*\nfn hidden() {\n}\n*/\nfn visible() {');
    assert.strictEqual(syms.length, 1);
    assert.ok(findByName(syms, 'visible'));
  });

  it('should record correct selection range', () => {
    const syms = parse('    far fn my_func() {');
    const sym = findByName(syms, 'my_func');
    assert.ok(sym);
    assert.strictEqual(sym.selectionRange.start.line, 0);
    assert.strictEqual(sym.selectionRange.start.character, 11);
    assert.strictEqual(sym.selectionRange.end.character, 18);
  });

  it('should track impl container for methods', () => {
    const code = 'impl Player {\n  far fn init(far *self) {\n  }\n}';
    const syms = parse(code);
    const init = findByName(syms, 'init');
    assert.ok(init);
    assert.strictEqual(init.container, 'Player');
  });

  it('should track impl Trait for Type', () => {
    const code = 'impl Drawable for Player {\n  fn draw(*self) {\n  }\n}';
    const syms = parse(code);
    const draw = findByName(syms, 'draw');
    assert.ok(draw);
    assert.strictEqual(draw.container, 'Player');
  });

  it('should clear container after impl block closes', () => {
    const code = 'impl Player {\n  fn init() {\n  }\n}\nfn standalone() {';
    const syms = parse(code);
    const standalone = findByName(syms, 'standalone');
    assert.ok(standalone);
    assert.strictEqual(standalone.container, undefined);
  });

  it('should parse impl as a symbol', () => {
    const syms = parse('impl Player {');
    const impls = findByKind(syms, R65SymbolKind.Impl);
    assert.strictEqual(impls.length, 1);
    assert.strictEqual(impls[0].name, 'Player');
  });

  it('should parse impl Trait for Type as symbol', () => {
    const syms = parse('impl Drawable for Player {');
    const impls = findByKind(syms, R65SymbolKind.Impl);
    assert.strictEqual(impls.length, 1);
    assert.strictEqual(impls[0].name, 'Drawable for Player');
  });

  it('should parse multiple definitions', () => {
    const code = 'struct Player {\n  x: u8,\n}\nfn update() {\n}\nconst MAX: u8 = 10;';
    const syms = parse(code);
    assert.ok(findByName(syms, 'Player'));
    assert.ok(findByName(syms, 'update'));
    assert.ok(findByName(syms, 'MAX'));
  });
});

// ── Symbol Index ────────────────────────────────────────────

describe('Symbol Index', () => {
  beforeEach(() => {
    workspace._reset();
  });

  it('should index a file and return symbols by name', async () => {
    workspace._setFileContent('/test/a.r65', 'fn my_func() {\n}\nstruct Player {');
    const index = new R65SymbolIndex();
    await index.indexFile(Uri.file('/test/a.r65') as any);
    assert.strictEqual(index.lookup('my_func').length, 1);
    assert.strictEqual(index.lookup('Player').length, 1);
    index.dispose();
  });

  it('should handle duplicate names across files', async () => {
    workspace._setFileContent('/test/a.r65', 'fn init() {');
    workspace._setFileContent('/test/b.r65', 'fn init() {');
    const index = new R65SymbolIndex();
    await index.indexFile(Uri.file('/test/a.r65') as any);
    await index.indexFile(Uri.file('/test/b.r65') as any);
    assert.strictEqual(index.lookup('init').length, 2);
    index.dispose();
  });

  it('should clear symbols on removeFile', async () => {
    workspace._setFileContent('/test/a.r65', 'fn my_func() {');
    const index = new R65SymbolIndex();
    await index.indexFile(Uri.file('/test/a.r65') as any);
    assert.strictEqual(index.lookup('my_func').length, 1);
    index.removeFile(Uri.file('/test/a.r65') as any);
    assert.strictEqual(index.lookup('my_func').length, 0);
    index.dispose();
  });

  it('should re-index on change', async () => {
    workspace._setFileContent('/test/a.r65', 'fn old_func() {');
    const index = new R65SymbolIndex();
    await index.indexFile(Uri.file('/test/a.r65') as any);
    assert.strictEqual(index.lookup('old_func').length, 1);
    workspace._setFileContent('/test/a.r65', 'fn new_func() {');
    await index.indexFile(Uri.file('/test/a.r65') as any);
    assert.strictEqual(index.lookup('old_func').length, 0);
    assert.strictEqual(index.lookup('new_func').length, 1);
    index.dispose();
  });

  it('should return file symbols', async () => {
    workspace._setFileContent('/test/a.r65', 'fn foo() {\n}\nfn bar() {');
    const index = new R65SymbolIndex();
    await index.indexFile(Uri.file('/test/a.r65') as any);
    const syms = index.getFileSymbols(Uri.file('/test/a.r65') as any);
    assert.strictEqual(syms.length, 2);
    index.dispose();
  });
});

// ── Definition Provider ─────────────────────────────────────

describe('Definition Provider', () => {
  it('should return location for known symbol', async () => {
    workspace._reset();
    workspace._setFileContent('/test/defs.r65', 'fn target() {');
    const index = new R65SymbolIndex();
    await index.indexFile(Uri.file('/test/defs.r65') as any);

    const provider = new R65DefinitionProvider(index);
    const doc = createMockDocument('let x = target();', '/test/caller.r65');
    const result = provider.provideDefinition(doc, new Position(0, 10) as any, { isCancellationRequested: false } as any);
    assert.ok(result);
    assert.ok((result as any).uri);
    index.dispose();
  });

  it('should return undefined for unknown symbol', async () => {
    const index = new R65SymbolIndex();
    const provider = new R65DefinitionProvider(index);
    const doc = createMockDocument('let x = unknown();');
    const result = provider.provideDefinition(doc, new Position(0, 10) as any, { isCancellationRequested: false } as any);
    assert.strictEqual(result, undefined);
    index.dispose();
  });

  it('should return multiple locations for overloaded names', async () => {
    workspace._reset();
    workspace._setFileContent('/test/a.r65', 'fn init() {');
    workspace._setFileContent('/test/b.r65', 'fn init() {');
    const index = new R65SymbolIndex();
    await index.indexFile(Uri.file('/test/a.r65') as any);
    await index.indexFile(Uri.file('/test/b.r65') as any);

    const provider = new R65DefinitionProvider(index);
    const doc = createMockDocument('init();');
    const result = provider.provideDefinition(doc, new Position(0, 1) as any, { isCancellationRequested: false } as any);
    assert.ok(Array.isArray(result));
    assert.strictEqual((result as any[]).length, 2);
    index.dispose();
  });
});

// ── Document Symbol Provider ────────────────────────────────

describe('Document Symbol Provider', () => {
  it('should return flat symbols for file without impl blocks', () => {
    const provider = new R65DocumentSymbolProvider();
    const doc = createMockDocument('fn foo() {\n}\nstruct Bar {\n}\nconst MAX: u8 = 10;');
    const result = provider.provideDocumentSymbols(doc, { isCancellationRequested: false } as any) as any[];
    assert.ok(result);
    assert.strictEqual(result.length, 3);
    assert.strictEqual(result[0].name, 'foo');
    assert.strictEqual(result[1].name, 'Bar');
    assert.strictEqual(result[2].name, 'MAX');
  });

  it('should nest methods under impl blocks', () => {
    const code = 'impl Player {\n  fn init() {\n  }\n  fn update() {\n  }\n}';
    const provider = new R65DocumentSymbolProvider();
    const doc = createMockDocument(code);
    const result = provider.provideDocumentSymbols(doc, { isCancellationRequested: false } as any) as any[];
    assert.ok(result);
    // Should have one top-level impl symbol
    const impl = result.find((s: any) => s.name === 'Player');
    assert.ok(impl);
    assert.strictEqual(impl.children.length, 2);
    assert.strictEqual(impl.children[0].name, 'init');
    assert.strictEqual(impl.children[1].name, 'update');
  });

  it('should not nest standalone functions under impl', () => {
    const code = 'impl Player {\n  fn init() {\n  }\n}\nfn standalone() {';
    const provider = new R65DocumentSymbolProvider();
    const doc = createMockDocument(code);
    const result = provider.provideDocumentSymbols(doc, { isCancellationRequested: false } as any) as any[];
    const standalone = result.find((s: any) => s.name === 'standalone');
    assert.ok(standalone);
    assert.strictEqual(standalone.children.length, 0);
  });
});
