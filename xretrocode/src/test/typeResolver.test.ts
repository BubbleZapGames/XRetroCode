import * as assert from 'assert';
import { Uri, Position, SymbolKind, workspace } from './vscode-mock';
import {
  baseTypeName, declTypeText, elementTypeText, parseFnHeader, ValueShape, valueShape, parseSymbolsFromText, R65SymbolIndex, R65SymbolKind,
} from '../symbolIndex';
import { R65DefinitionProvider } from '../definitionProvider';
import { R65DocumentSymbolProvider } from '../documentSymbolProvider';
import { createMockDocument, noCancel, positionOf } from './mockDocument';

function parse(text: string) {
  return parseSymbolsFromText(text, Uri.file('/test/file.r65') as any);
}

async function indexed(files: Record<string, string>): Promise<R65SymbolIndex> {
  workspace._reset();
  const index = new R65SymbolIndex();
  for (const [path, content] of Object.entries(files)) {
    workspace._setFileContent(path, content);
    await index.indexFile(Uri.file(path) as any);
  }
  return index;
}

/** Line Go to Definition lands on for `marker` (+offset) in `caller`, or the candidate count. */
function definitionLine(index: R65SymbolIndex, caller: string, marker: string, offset = 0): number | number[] | undefined {
  const pos = positionOf(caller, marker, offset);
  const result = new R65DefinitionProvider(index).provideDefinition(
    createMockDocument(caller, '/test/caller.r65'), new Position(pos.line, pos.character) as any, noCancel
  ) as any;
  if (!result) return undefined;
  return Array.isArray(result) ? result.map((l: any) => l.range.start.line) : result.range.start.line;
}

describe('baseTypeName', () => {
  it('should reduce pointer, dyn and array types to the named type', () => {
    assert.strictEqual(baseTypeName('*OamEntry'), 'OamEntry');
    assert.strictEqual(baseTypeName('far *dyn Shape'), 'Shape');
    assert.strictEqual(baseTypeName('[Enemy; 8]'), 'Enemy');
    assert.strictEqual(baseTypeName(' Q10 '), 'Q10');
  });

  it('should give nothing for primitives, never, fn types and value lists', () => {
    assert.strictEqual(baseTypeName('far *u8'), undefined);
    assert.strictEqual(baseTypeName('!'), undefined);
    assert.strictEqual(baseTypeName('fn(u8) -> u8'), undefined);
    assert.strictEqual(baseTypeName('u8, u16'), undefined);
  });
});

describe('declTypeText and valueShape', () => {
  it('should fold a pattern-side pointer onto the type', () => {
    assert.strictEqual(declTypeText('src: far *u8'), 'far *u8');
    assert.strictEqual(declTypeText('far *src: u8'), 'far *u8');
    assert.strictEqual(declTypeText('let far mut *p: u8'), 'far *u8');
    assert.strictEqual(declTypeText('*src: u8'), '*u8');
    assert.strictEqual(declTypeText('channel @ A: u8'), 'u8');
    assert.strictEqual(declTypeText('far *self'), undefined);
  });

  it('should classify by the outermost type only', () => {
    assert.strictEqual(valueShape('far *u8'), ValueShape.FarPointer);
    assert.strictEqual(valueShape('[far *u8; 4]'), ValueShape.Array);
    assert.strictEqual(valueShape('i16'), ValueShape.Integer);
    for (const t of ['*u8', 'near *u8', '*far *u8', 'bool', 'Q10', 'u8x']) {
      assert.strictEqual(valueShape(t), undefined, t);
    }
  });

  it('should peel one array or pointer level', () => {
    assert.strictEqual(elementTypeText('[far *u8; 4]'), 'far *u8');
    assert.strictEqual(elementTypeText('[[u8; 4]; 2]'), '[u8; 4]');
    assert.strictEqual(elementTypeText('far *[u8; 4]'), '[u8; 4]');
    assert.strictEqual(elementTypeText('u8'), undefined);
  });
});

describe('parseFnHeader', () => {
  it('should read params with pointer types, bindings and a return type', () => {
    const h = parseFnHeader('far fn blit(channel @ A: u8, src: far *u8, p: *Player) -> Q10 {')!;
    assert.deepStrictEqual(h.params.map(p => [p.name, p.type]), [['channel', undefined], ['src', undefined], ['p', 'Player']]);
    assert.strictEqual(h.returnType, 'Q10');
    assert.strictEqual(h.hasSelf, false);
  });

  it('should recognise far *self and give no type for -> ! or a value list', () => {
    const h = parseFnHeader('    fn stop(far *self) -> ! {')!;
    assert.strictEqual(h.hasSelf, true);
    assert.strictEqual(h.returnType, undefined);
    assert.strictEqual(parseFnHeader('fn split(v: u16) -> u8, u8 {')!.returnType, undefined);
  });
});

describe('Index: fields, types, signatures and docs', () => {
  it('should index fields of a single-line struct', () => {
    const syms = parse('struct Player { x: u8, y: u8, sprite: *OamEntry }');
    const fields = syms.filter(s => s.kind === R65SymbolKind.Field);
    assert.deepStrictEqual(fields.map(f => f.name), ['x', 'y', 'sprite']);
    assert.ok(fields.every(f => f.container === 'Player'));
    assert.strictEqual(fields[2].declaredType, 'OamEntry');
    assert.strictEqual(fields[1].selectionRange.start.character, 'struct Player { x: u8, '.length);
  });

  it('should index fields of a multi-line struct with array types, docs and trailing comments', () => {
    const syms = parse([
      'struct OamBuffer {',
      '    /// The 128 hardware sprites',
      '    sprites: [OamEntry; 128],',
      '    ext: [u8; 32], // high bits',
      '    far *next: OamBuffer,',
      '}',
      'fn after() {',
    ].join('\n'));
    const fields = syms.filter(s => s.kind === R65SymbolKind.Field);
    assert.deepStrictEqual(fields.map(f => [f.name, f.declaredType, f.signature]), [
      ['sprites', 'OamEntry', 'sprites: [OamEntry; 128]'],
      ['ext', undefined, 'ext: [u8; 32]'],
      ['next', 'OamBuffer', 'far *next: OamBuffer'],
    ]);
    assert.strictEqual(fields[0].doc, 'The 128 hardware sprites');
    assert.strictEqual(fields[1].doc, 'high bits');
    assert.strictEqual(syms.find(s => s.name === 'after')!.container, undefined);
  });

  it('should index fields of a one-line #[soa] struct and only 0 for a newtype', () => {
    const syms = parse('#[soa] struct Launcher { armed: u8 }\nstruct Meters(u16);');
    assert.deepStrictEqual(syms.filter(s => s.kind === R65SymbolKind.Field).map(f => [f.container, f.name]), [
      ['Launcher', 'armed'], ['Meters', '0'],
    ]);
    assert.strictEqual(syms.find(s => s.name === 'Launcher')!.signature, 'struct Launcher');
  });

  it('should type statics through pointers and accept a name-side *', () => {
    const syms = parse('static mut cur: far *Player;\nstatic mut *p: Enemy;\n#[lowram] static mut oam: [OamEntry; 128];');
    assert.strictEqual(syms.find(s => s.name === 'cur')!.declaredType, 'Player');
    assert.strictEqual(syms.find(s => s.name === 'p')!.declaredType, 'Enemy');
    const oam = syms.find(s => s.name === 'oam')!;
    assert.strictEqual(oam.declaredType, 'OamEntry');
    assert.strictEqual(oam.signature, 'static mut oam: [OamEntry; 128]');
  });

  it('should cut a signature at the body or initializer', () => {
    const syms = parse('const MAX: u8 = 10;\nfn draw(*self) { /* inline */ }\ntrait Area {\n  fn area(*self) -> u8;\n}');
    assert.strictEqual(syms.find(s => s.name === 'MAX')!.signature, 'const MAX: u8');
    assert.strictEqual(syms.find(s => s.name === 'draw')!.signature, 'fn draw(*self)');
    assert.strictEqual(syms.find(s => s.name === 'area')!.signature, 'fn area(*self) -> u8');
  });

  it('should prefer /// docs and carry them across an attribute line', () => {
    const syms = parse([
      '// plain note',
      '/// Wait for vertical blank.',
      '/// Blocks until NMI.',
      '#[inline(never)]',
      'fn wait_vblank() {',
    ].join('\n'));
    assert.strictEqual(syms[0].doc, 'Wait for vertical blank.\nBlocks until NMI.');
  });

  it('should fall back to plain // comments, after the last banner', () => {
    const syms = parse([
      '// ============',
      '// Section: DMA',
      '// ============',
      'fn untitled() {',
      '}',
      '',
      '// DMA copy to VRAM',
      'far fn dma_copy_vram(src: far *u8) {',
    ].join('\n'));
    assert.strictEqual(syms.find(s => s.name === 'untitled')!.doc, undefined);
    assert.strictEqual(syms.find(s => s.name === 'dma_copy_vram')!.doc, 'DMA copy to VRAM');
  });

  it('should ignore //! lines and drop docs across a blank line', () => {
    const syms = parse('//! let player_x: Q10\nfn a() {\n}\n/// stale\n\nfn b() {');
    assert.strictEqual(syms.find(s => s.name === 'a')!.doc, undefined);
    assert.strictEqual(syms.find(s => s.name === 'b')!.doc, undefined);
  });

  it('should record return type and self on functions', () => {
    const syms = parse('impl Q10 {\n  fn from_int(v: u8) -> Q10 {\n  }\n  fn div(far *self, d: u8) -> Q10 {\n  }\n}');
    const from = syms.find(s => s.name === 'from_int')!;
    const div = syms.find(s => s.name === 'div')!;
    assert.strictEqual(from.returnType, 'Q10');
    assert.strictEqual(from.hasSelf, false);
    assert.strictEqual(div.hasSelf, true);
  });

  it('should index a newtype payload as field 0', () => {
    const syms = parseSymbolsFromText('struct TileId(u8);\nstruct Cb(fn(u8) -> u8); // callback\nstruct H(*Player);', Uri.file('/t.r65') as any);
    const zeros = syms.filter(s => s.name === '0');
    assert.deepStrictEqual(zeros.map(z => [z.container, z.kind, z.declaredType, z.typeText, z.signature]), [
      ['TileId', R65SymbolKind.Field, undefined, 'u8', '0: u8'],
      ['Cb', R65SymbolKind.Field, undefined, 'fn(u8) -> u8', '0: fn(u8) -> u8'],
      ['H', R65SymbolKind.Field, 'Player', '*Player', '0: *Player'],
    ]);
    assert.strictEqual(zeros[0].selectionRange.start.character, 'struct TileId('.length);
  });

  it('should nest fields under their struct in the Outline', () => {
    const result = new R65DocumentSymbolProvider().provideDocumentSymbols(
      createMockDocument('struct Player {\n  x: u8,\n  y: u8,\n}\nimpl Player {\n  fn init() {\n  }\n}'), noCancel
    ) as any[];
    assert.deepStrictEqual(result.map(s => s.name), ['Player', 'Player']);
    assert.deepStrictEqual(result[0].children.map((c: any) => c.name), ['x', 'y']);
    assert.strictEqual(result[0].children[0].kind, SymbolKind.Field);
    assert.deepStrictEqual(result[1].children.map((c: any) => c.name), ['init']);
  });
});

describe('Type resolution', () => {
  const LIB = [
    'impl OamEntry {',            // 0
    '    macro_rules! set($x:expr) {',
    '    }',
    '}',
    'impl OamBuffer {',           // 4
    '    macro_rules! set($i:expr) {',
    '    }',
    '}',
  ].join('\n');

  it('should type a let whose pointer sits on the type', async () => {
    const index = await indexed({ '/test/lib.r65': LIB });
    const caller = 'fn draw() {\n    let mut p: *OamEntry = &self.sprites[0];\n    p.set!(1);';
    assert.strictEqual(definitionLine(index, caller, 'set!'), 1);
  });

  it('should type a far pointer parameter', async () => {
    const index = await indexed({ '/test/lib.r65': LIB });
    const caller = 'far fn fill(n: u8, buf: far *OamBuffer) {\n    buf.set!(n);';
    assert.strictEqual(definitionLine(index, caller, 'set!'), 5);
  });

  it('should not borrow a binding from a previous function', async () => {
    const index = await indexed({ '/test/lib.r65': LIB });
    const caller = 'fn a() {\n    let q: OamEntry = x;\n}\nfn b() {\n    q.set!(1);';
    assert.ok(Array.isArray(definitionLine(index, caller, 'set!')), 'q is unknown in b, so offer both');
  });

  it('should follow a field chain from far *self', async () => {
    const index = await indexed({
      '/test/lib.r65': [
        'struct Level { tilemap: Tilemap }',
        'struct Tilemap { bmp: *Bitmap }',
        'impl Bitmap {',
        '    fn draw(far *self) {',          // 3
        '    }',
        '}',
        'impl Other {',
        '    fn draw(far *self) {',
        '    }',
        '}',
      ].join('\n'),
    });
    const caller = 'impl Level {\n    fn render(far *self) {\n        self.tilemap.bmp.draw();';
    assert.strictEqual(definitionLine(index, caller, 'draw'), 3);
  });

  it('should go to a field through (*p) and not from a bare local of the same name', async () => {
    const index = await indexed({ '/test/lib.r65': 'struct Player {\n    x: u8,\n}' });
    const caller = 'fn f(p: *Player) {\n    let x: u8 = (*p).x;';
    assert.strictEqual(definitionLine(index, caller, ').x', 2), 1);
    assert.strictEqual(definitionLine(index, caller, 'let x', 4), undefined, 'a local x is not Player.x');
  });

  it('should type the result of an associated fn call', async () => {
    const index = await indexed({
      '/test/lib.r65': [
        'impl Q10 {',
        '    fn from_int(v: u8) -> Q10 {',
        '    }',
        '    fn div(far *self, d: u8) -> Q10 {',   // 3
        '    }',
        '}',
        'impl U32 {',
        '    fn div(far *self, d: u8) -> U32 {',
        '    }',
        '}',
      ].join('\n'),
    });
    const caller = 'fn f() {\n    let r: Q10 = Q10::from_int(3).div(2);';
    assert.strictEqual(definitionLine(index, caller, '.div', 1), 3);
  });
});

describe('Candidate selection', () => {
  it('should tell a fn from a macro of the same name by the ! after it', async () => {
    const index = await indexed({
      '/test/lib.r65': [
        'impl Console {',
        '    fn print(far *self, s: far *u8) {',     // 1
        '    }',
        '    macro_rules! print($fmt:literal) {',   // 3
        '    }',
        '}',
      ].join('\n'),
    });
    const caller = 'impl Console {\n    fn f(far *self) {\n        self.print(s);\n        self.print!("x");';
    assert.strictEqual(definitionLine(index, caller, 'print(s'), 1);
    assert.strictEqual(definitionLine(index, caller, 'print!'), 3);
  });

  it('should jump to the nearest of identical vendored copies', async () => {
    const lib = 'fn wait_vblank() {\n}';
    const index = await indexed({ '/game_a/src/lib/snes.r65': lib, '/game_b/src/lib/snes.r65': lib });
    const pos = positionOf('    wait_vblank();', 'wait_vblank');
    const result = new R65DefinitionProvider(index).provideDefinition(
      createMockDocument('    wait_vblank();', '/game_b/src/main.r65'), new Position(pos.line, pos.character) as any, noCancel
    ) as any;
    assert.ok(result && !Array.isArray(result), 'one target, not a picker');
    assert.strictEqual(result.uri.path, '/game_b/src/lib/snes.r65');
  });

  it('should treat drifted copies as copies', async () => {
    const index = await indexed({
      '/game_a/src/lib/snes.r65': 'fn init() {\n}',
      '/game_b/src/lib/snes.r65': 'far fn init(mode: u8) {\n}',
    });
    const pos = positionOf('    init();', 'init');
    const result = new R65DefinitionProvider(index).provideDefinition(
      createMockDocument('    init();', '/game_b/src/main.r65'), new Position(pos.line, pos.character) as any, noCancel
    ) as any;
    assert.ok(result && !Array.isArray(result), 'one target, not a picker');
    assert.strictEqual(result.uri.path, '/game_b/src/lib/snes.r65');
  });

  it('should still offer a picker when the candidates are different things', async () => {
    const index = await indexed({
      '/game_a/src/lib/snes.r65': 'fn init() {\n}\nmacro_rules! init() {\n}',
      '/game_b/src/lib/snes.r65': 'impl Player {\n  fn init() {\n  }\n}\nimpl Enemy {\n  fn init() {\n  }\n}',
    });
    const caller = 'fn f(x: *Mystery) {\n    x.init();';
    assert.ok(Array.isArray(definitionLine(index, caller, 'init')));
  });
});
