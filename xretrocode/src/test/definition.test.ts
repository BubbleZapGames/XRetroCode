import * as assert from 'assert';
import { Uri, Position, Range, Location, SymbolKind, workspace } from './vscode-mock';
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

  it('should parse lowercase static mut definition', () => {
    // Most globals in real R65 sources are snake_case, not SCREAMING_CASE
    const syms = parse('static mut enemy_free: u8;');
    const sym = findByName(syms, 'enemy_free');
    assert.ok(sym);
    assert.strictEqual(sym.kind, R65SymbolKind.Static);
  });

  it('should parse lowercase static without mut', () => {
    const syms = parse('static back1_gfx: [u8; 32] = [0];');
    const sym = findByName(syms, 'back1_gfx');
    assert.ok(sym);
    assert.strictEqual(sym.kind, R65SymbolKind.Static);
  });

  it('should parse mixedCase static', () => {
    const syms = parse('static mut spriteTable: u8;');
    assert.ok(findByName(syms, 'spriteTable'));
  });

  it('should parse lowercase const definition', () => {
    const syms = parse('const tile_width: u8 = 8;');
    const sym = findByName(syms, 'tile_width');
    assert.ok(sym);
    assert.strictEqual(sym.kind, R65SymbolKind.Constant);
  });

  it('should not treat a static named like a keyword prefix as a fn', () => {
    const syms = parse('static mut fn_table: u8;');
    const sym = findByName(syms, 'fn_table');
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

  it('should parse union definition', () => {
    const sym = findByName(parse('union Reg { lo: u8, hi: u16 }'), 'Reg');
    assert.ok(sym);
    assert.strictEqual(sym.kind, R65SymbolKind.Union);
  });

  it('should parse near fn definition', () => {
    const sym = findByName(parse('near fn tick() {'), 'tick');
    assert.ok(sym);
    assert.strictEqual(sym.kind, R65SymbolKind.Function);
  });

  it('should track trait container for default and required methods', () => {
    const code = 'trait Area: Shape {\n  fn area(*self) -> u8 {\n    0\n  }\n  fn name(*self) -> u8;\n}\nfn free() {';
    const syms = parse(code);
    assert.strictEqual(findByName(syms, 'area')!.container, 'Area');
    assert.strictEqual(findByName(syms, 'name')!.container, 'Area');
    assert.strictEqual(findByName(syms, 'free')!.container, undefined);
  });

  it('should close an impl block opened and closed on one line', () => {
    const syms = parse('impl Player {}\nfn standalone() {');
    assert.strictEqual(findByName(syms, 'standalone')!.container, undefined);
  });

  it('should parse single-line enum variants', () => {
    const syms = parse('enum Screen { BG1 = 0x01, BG2 = 0x02, Obj = 0x10 }');
    const members = findByKind(syms, R65SymbolKind.EnumMember);
    assert.deepStrictEqual(members.map(m => m.name), ['BG1', 'BG2', 'Obj']);
    assert.ok(members.every(m => m.container === 'Screen'));
    assert.strictEqual(members[1].selectionRange.start.character, 'enum Screen { BG1 = 0x01, '.length);
  });

  it('should parse multi-line enum variants with payloads', () => {
    const code = [
      'enum Shape {',
      '    /// round one',
      '    Circle(Circle), // trailing',
      '    Square( Sq ),',
      '    None',
      '}',
      'fn after() {',
    ].join('\n');
    const syms = parse(code);
    const members = findByKind(syms, R65SymbolKind.EnumMember);
    assert.deepStrictEqual(members.map(m => m.name), ['Circle', 'Square', 'None']);
    assert.deepStrictEqual(members.map(m => m.declaredType), ['Circle', 'Sq', undefined]);
    assert.strictEqual(members[0].selectionRange.start.line, 2);
    assert.strictEqual(findByName(syms, 'after')!.container, undefined);
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

  it('should go to definition of a lowercase static variable', async () => {
    workspace._reset();
    workspace._setFileContent('/test/enemy.r65', [
      '#[lowram]',
      'static mut enemy_free: u8;',
    ].join('\n'));
    const index = new R65SymbolIndex();
    await index.indexFile(Uri.file('/test/enemy.r65') as any);

    const provider = new R65DefinitionProvider(index);
    const doc = createMockDocument('enemy_free = 1;', '/test/caller.r65');
    const result = provider.provideDefinition(doc, new Position(0, 3) as any, { isCancellationRequested: false } as any);
    assert.ok(result, 'expected a definition for a snake_case static');
    assert.strictEqual((result as any).range.start.line, 1);
    index.dispose();
  });

  it('should disambiguate same-named methods by receiver type', async () => {
    workspace._reset();
    workspace._setFileContent('/test/lib.r65', [
      'impl OamEntry {',
      '    macro_rules! set($x:expr, $y:expr) {',
      '    }',
      '}',
      '',
      'impl OamBuffer {',
      '    macro_rules! set($idx:expr, $sx:expr) {',
      '    }',
      '}',
    ].join('\n'));
    workspace._setFileContent('/test/game.r65', 'static mut oam_buffer: OamBuffer;');
    const index = new R65SymbolIndex();
    await index.indexFile(Uri.file('/test/lib.r65') as any);
    await index.indexFile(Uri.file('/test/game.r65') as any);

    assert.strictEqual(index.lookup('set').length, 2, 'both impls should be indexed');

    const provider = new R65DefinitionProvider(index);
    const doc = createMockDocument('    oam_buffer.set!(spr, ox);', '/test/enemy.r65');
    const result = provider.provideDefinition(doc, new Position(0, 17) as any, { isCancellationRequested: false } as any);
    assert.ok(result && !Array.isArray(result), 'expected exactly one definition, not a picker');
    assert.strictEqual((result as any).range.start.line, 6, 'should land on the OamBuffer impl');
  });

  it('should resolve a receiver typed by a local let binding', async () => {
    workspace._reset();
    workspace._setFileContent('/test/lib.r65', [
      'impl OamEntry {',
      '    macro_rules! set($x:expr) {',
      '    }',
      '}',
      'impl OamBuffer {',
      '    macro_rules! set($i:expr) {',
      '    }',
      '}',
    ].join('\n'));
    const index = new R65SymbolIndex();
    await index.indexFile(Uri.file('/test/lib.r65') as any);

    const provider = new R65DefinitionProvider(index);
    const doc = createMockDocument([
      'fn draw() {',
      '    let mut e: OamEntry = oam[0];',
      '    e.set!(1);',
    ].join('\n'), '/test/caller.r65');
    const result = provider.provideDefinition(doc, new Position(2, 7) as any, { isCancellationRequested: false } as any);
    assert.ok(result && !Array.isArray(result));
    assert.strictEqual((result as any).range.start.line, 1, 'should land on the OamEntry impl');
  });

  it('should resolve self. to the enclosing impl', async () => {
    workspace._reset();
    workspace._setFileContent('/test/lib.r65', [
      'impl OamEntry {',
      '    macro_rules! set($x:expr) {',
      '    }',
      '}',
      'impl OamBuffer {',
      '    macro_rules! set($i:expr) {',
      '    }',
      '}',
    ].join('\n'));
    const index = new R65SymbolIndex();
    await index.indexFile(Uri.file('/test/lib.r65') as any);

    const provider = new R65DefinitionProvider(index);
    const doc = createMockDocument([
      'impl OamBuffer {',
      '    fn clear(far *self) {',
      '        self.set!(0);',
      '    }',
      '}',
    ].join('\n'), '/test/lib2.r65');
    const result = provider.provideDefinition(doc, new Position(2, 14) as any, { isCancellationRequested: false } as any);
    assert.ok(result && !Array.isArray(result));
    assert.strictEqual((result as any).range.start.line, 5, 'should land on the OamBuffer impl');
  });

  it('should keep every candidate when the receiver type is unknown', async () => {
    workspace._reset();
    workspace._setFileContent('/test/lib.r65', [
      'impl OamEntry {',
      '    macro_rules! set($x:expr) {',
      '    }',
      '}',
      'impl OamBuffer {',
      '    macro_rules! set($i:expr) {',
      '    }',
      '}',
    ].join('\n'));
    const index = new R65SymbolIndex();
    await index.indexFile(Uri.file('/test/lib.r65') as any);

    const provider = new R65DefinitionProvider(index);
    const doc = createMockDocument('    mystery.set!(1);', '/test/caller.r65');
    const result = provider.provideDefinition(doc, new Position(0, 13) as any, { isCancellationRequested: false } as any);
    assert.ok(Array.isArray(result), 'should not guess when the type is unresolvable');
    assert.strictEqual((result as any[]).length, 2);
  });

  it('should narrow Type::name! to that type\'s macro', async () => {
    workspace._reset();
    workspace._setFileContent('/test/lib.r65', [
      'macro_rules! set($x:expr) {',
      '}',
      'impl Oam {',
      '    macro_rules! set($x:expr) {',
      '    }',
      '}',
    ].join('\n'));
    const index = new R65SymbolIndex();
    await index.indexFile(Uri.file('/test/lib.r65') as any);

    const provider = new R65DefinitionProvider(index);
    const doc = createMockDocument('    Oam::set!(1);', '/test/caller.r65');
    const result = provider.provideDefinition(doc, new Position(0, 10) as any, { isCancellationRequested: false } as any);
    assert.ok(result && !Array.isArray(result));
    assert.strictEqual((result as any).range.start.line, 3, 'should land on the Oam impl, not the free macro');
  });

  it('should go to an enum variant rather than a same-named struct', async () => {
    workspace._reset();
    workspace._setFileContent('/test/lib.r65', [
      'struct Circle { r: u8 }',
      'enum Shape { Circle(Circle), None }',
    ].join('\n'));
    const index = new R65SymbolIndex();
    await index.indexFile(Uri.file('/test/lib.r65') as any);
    const provider = new R65DefinitionProvider(index);

    const variantDoc = createMockDocument('    s = Shape::Circle(c);', '/test/caller.r65');
    const variant = provider.provideDefinition(variantDoc, new Position(0, 16) as any, { isCancellationRequested: false } as any);
    assert.ok(variant && !Array.isArray(variant));
    assert.strictEqual((variant as any).range.start.line, 1);
    assert.strictEqual((variant as any).range.start.character, 'enum Shape { '.length);

    const structDoc = createMockDocument('    let c: Circle = Circle { r: 5 };', '/test/caller.r65');
    const struct = provider.provideDefinition(structDoc, new Position(0, 22) as any, { isCancellationRequested: false } as any);
    assert.ok(struct && !Array.isArray(struct));
    assert.strictEqual((struct as any).range.start.line, 0);
  });

  it('should resolve a method a type inherits from a trait default', async () => {
    workspace._reset();
    workspace._setFileContent('/test/lib.r65', [
      'trait Area {',
      '    fn area(*self) -> u8 {',
      '        0',
      '    }',
      '}',
      'impl Area for Meters {',
      '}',
      'impl Other {',
      '    fn area(*self) -> u8 {',
      '    }',
      '}',
    ].join('\n'));
    workspace._setFileContent('/test/game.r65', 'static m: Meters;');
    const index = new R65SymbolIndex();
    await index.indexFile(Uri.file('/test/lib.r65') as any);
    await index.indexFile(Uri.file('/test/game.r65') as any);

    const provider = new R65DefinitionProvider(index);
    const doc = createMockDocument('    m.area();', '/test/caller.r65');
    const result = provider.provideDefinition(doc, new Position(0, 7) as any, { isCancellationRequested: false } as any);
    assert.ok(result && !Array.isArray(result));
    assert.strictEqual((result as any).range.start.line, 1, 'should land on the trait default');
  });

  it('should resolve self. inside a trait default body to the trait', async () => {
    workspace._reset();
    const lib = [
      'trait Area {',
      '    fn name(*self) -> u8;',
      '    fn area(*self) -> u8 {',
      '        self.name()',
      '    }',
      '}',
      'impl Other {',
      '    fn name(*self) -> u8 {',
      '    }',
      '}',
    ].join('\n');
    workspace._setFileContent('/test/lib.r65', lib);
    const index = new R65SymbolIndex();
    await index.indexFile(Uri.file('/test/lib.r65') as any);

    const provider = new R65DefinitionProvider(index);
    const doc = createMockDocument(lib, '/test/lib.r65');
    const result = provider.provideDefinition(doc, new Position(3, 14) as any, { isCancellationRequested: false } as any);
    assert.ok(result && !Array.isArray(result));
    assert.strictEqual((result as any).range.start.line, 1);
  });

  it('should type an enum payload binding from its variant', async () => {
    workspace._reset();
    workspace._setFileContent('/test/lib.r65', [
      'enum Shape { Circle(Circle), Square(Sq) }',
      'impl Circle {',
      '    fn area(*self) -> u8 {',
      '    }',
      '}',
      'impl Sq {',
      '    fn area(*self) -> u8 {',
      '    }',
      '}',
    ].join('\n'));
    const index = new R65SymbolIndex();
    await index.indexFile(Uri.file('/test/lib.r65') as any);
    const provider = new R65DefinitionProvider(index);

    for (const binding of [
      ['    if let Shape::Square(c) = s {', '        c.area();'],
      ['    let Shape::Square(c) = s else { return; };', '    c.area();'],
      ['    match s {', '        Shape::Square(c) => c.area(),'],
    ]) {
      const doc = createMockDocument(['fn f() {', ...binding].join('\n'), '/test/caller.r65');
      const col = binding[1].indexOf('area') + 1;
      const result = provider.provideDefinition(doc, new Position(2, col) as any, { isCancellationRequested: false } as any);
      assert.ok(result && !Array.isArray(result), binding.join(' / '));
      assert.strictEqual((result as any).range.start.line, 6, `${binding.join(' / ')} should land on impl Sq`);
    }
  });

  it('should prefer a free function over a method when there is no receiver', async () => {
    workspace._reset();
    workspace._setFileContent('/test/lib.r65', [
      'fn update() {',
      '}',
      'impl OamBuffer {',
      '    fn update(far *self) {',
      '    }',
      '}',
    ].join('\n'));
    const index = new R65SymbolIndex();
    await index.indexFile(Uri.file('/test/lib.r65') as any);

    const provider = new R65DefinitionProvider(index);
    const doc = createMockDocument('    update();', '/test/caller.r65');
    const result = provider.provideDefinition(doc, new Position(0, 6) as any, { isCancellationRequested: false } as any);
    assert.ok(result && !Array.isArray(result));
    assert.strictEqual((result as any).range.start.line, 0);
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

  it('should nest trait methods and enum variants', () => {
    const code = [
      'trait Area {',
      '  fn area(*self) -> u8;',
      '}',
      'enum Shape { Circle(Circle), None }',
      'impl Shape {',
      '  fn kind(*self) -> u8 {',
      '  }',
      '}',
      'union Reg { lo: u8 }',
    ].join('\n');
    const provider = new R65DocumentSymbolProvider();
    const result = provider.provideDocumentSymbols(createMockDocument(code), { isCancellationRequested: false } as any) as any[];
    assert.deepStrictEqual(result.map((s: any) => s.name), ['Area', 'Shape', 'Shape', 'Reg']);
    assert.deepStrictEqual(result[0].children.map((c: any) => c.name), ['area']);
    assert.deepStrictEqual(result[1].children.map((c: any) => c.name), ['Circle', 'None']);
    assert.strictEqual(result[1].children[0].kind, SymbolKind.EnumMember);
    assert.deepStrictEqual(result[2].children.map((c: any) => c.name), ['kind']);
    assert.strictEqual(result[3].kind, SymbolKind.Struct);
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
