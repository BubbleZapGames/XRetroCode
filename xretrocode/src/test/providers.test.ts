import * as assert from 'assert';
import { Uri, Position, CompletionItemKind, SymbolKind, workspace } from './vscode-mock';
import { R65SymbolIndex } from '../symbolIndex';
import { R65HoverProvider } from '../hoverProvider';
import { R65CompletionProvider } from '../completionProvider';
import { R65ReferenceProvider, maskCode } from '../referenceProvider';
import { R65WorkspaceSymbolProvider } from '../workspaceSymbolProvider';
import { createMockDocument, noCancel, positionOf } from './mockDocument';

async function indexed(files: Record<string, string>): Promise<R65SymbolIndex> {
  workspace._reset();
  const index = new R65SymbolIndex();
  for (const [path, content] of Object.entries(files)) {
    workspace._setFileContent(path, content);
    await index.indexFile(Uri.file(path) as any);
  }
  return index;
}

const LIB = [
  '/// A hardware sprite.',
  'struct OamEntry { x: u8, y: u8, tile: u8 }',
  'impl OamEntry {',
  '    /// Move the sprite.',
  '    fn move_to(far *self, x: u8, y: u8) {',
  '    }',
  '    fn blank() -> OamEntry {',
  '    }',
  '    macro_rules! set($x:expr) {',
  '    }',
  '}',
  'enum Shape { Circle(Circle), None }',
  'impl Shape {',
  '    fn origin() -> Shape {',
  '    }',
  '}',
  '// Wait for vertical blank',
  'fn wait_vblank() {',
  '}',
].join('\n');

describe('Hover', () => {
  function hover(index: R65SymbolIndex, content: string, marker: string, offset = 0): string | undefined {
    const pos = positionOf(content, marker, offset);
    const h = new R65HoverProvider(index).provideHover(
      createMockDocument(content, '/test/caller.r65'), new Position(pos.line, pos.character) as any, noCancel
    ) as any;
    return h?.contents.value;
  }

  it('should show a function signature and its doc', async () => {
    const index = await indexed({ '/test/lib.r65': LIB });
    const text = hover(index, 'fn main() {\n    wait_vblank();', 'wait_vblank')!;
    assert.ok(text.includes('```r65\nfn wait_vblank()\n```'), text);
    assert.ok(text.includes('Wait for vertical blank'), text);
  });

  it('should show a method with its impl and /// doc', async () => {
    const index = await indexed({ '/test/lib.r65': LIB });
    const text = hover(index, 'fn f(e: *OamEntry) {\n    e.move_to(1, 2);', 'move_to')!;
    assert.ok(text.includes('fn move_to(far *self, x: u8, y: u8)'), text);
    assert.ok(text.includes('impl OamEntry'), text);
    assert.ok(text.includes('Move the sprite.'), text);
  });

  it('should show a field and a variant with their owners', async () => {
    const index = await indexed({ '/test/lib.r65': LIB });
    const field = hover(index, 'fn f(e: *OamEntry) {\n    let t: u8 = e.tile;', 'tile')!;
    assert.ok(field.includes('tile: u8') && field.includes('field of OamEntry'), field);
    const variant = hover(index, 'fn f() {\n    s = Shape::Circle(c);', 'Circle')!;
    assert.ok(variant.includes('Shape::Circle(Circle)') && variant.includes('variant of enum Shape'), variant);
  });

  it('should collapse identical copies of a declaration', async () => {
    const index = await indexed({ '/a/lib.r65': LIB, '/b/lib.r65': LIB });
    const text = hover(index, 'fn main() {\n    wait_vblank();', 'wait_vblank')!;
    assert.strictEqual(text.split('fn wait_vblank()').length, 2, text);
  });

  it('should show how a local is bound', async () => {
    const index = await indexed({ '/test/lib.r65': LIB });
    const text = hover(index, 'fn f(src: far *u8) {\n    let mut p: *OamEntry = &oam[0];\n    p.y = src;', 'src;')!;
    assert.ok(text.includes('src: far *u8'), text);
    const let_ = hover(index, 'fn f() {\n    let mut p: *OamEntry = &oam[0];\n    p.y = 1;', 'p.y')!;
    assert.ok(let_.includes('let mut p: *OamEntry'), let_);
  });
});

describe('Completion', () => {
  function complete(index: R65SymbolIndex, content: string): any[] | undefined {
    const lines = content.split('\n');
    const pos = new Position(lines.length - 1, lines[lines.length - 1].length);
    return new R65CompletionProvider(index).provideCompletionItems(
      createMockDocument(content, '/test/caller.r65'), pos as any, noCancel
    ) as any[] | undefined;
  }
  const labels = (items: any[] | undefined) => (items ?? []).map(i => i.label);

  it('should offer fields, methods and method macros after a typed receiver', async () => {
    const index = await indexed({ '/test/lib.r65': LIB });
    const items = complete(index, 'fn f(e: far *OamEntry) {\n    e.');
    assert.deepStrictEqual(labels(items).sort(), ['bank_byte', 'move_to', 'set!', 'tile', 'x', 'y']);
    const tile = items!.find(i => i.label === 'tile');
    assert.strictEqual(tile.kind, CompletionItemKind.Field);
    assert.strictEqual(tile.detail, 'tile: u8');
  });

  it('should offer bank_byte() on far pointers only', async () => {
    const index = await indexed({
      '/test/lib.r65': LIB,
      '/test/dma.r65': [
        'struct Dma { src: far *u8, near_src: *u8, srcs: [far *u8; 4] }',
        'static mut BUF_PTR: far *u8;',
      ].join('\n'),
    });
    const bank = (content: string) => labels(complete(index, content)).includes('bank_byte');

    assert.deepStrictEqual(labels(complete(index, 'fn f(src: far *u8) {\n    src.')), ['bank_byte']);
    const item = complete(index, 'fn f(src: far *u8) {\n    src.')![0];
    assert.strictEqual(item.kind, CompletionItemKind.Method);
    assert.strictEqual(item.insertText, 'bank_byte()');
    assert.ok(bank('fn f() {\n    let mut q: far *u8 = 0;\n    q.'), 'type-side let');
    assert.ok(bank('fn f() {\n    let far *q: u8 = 0;\n    q.'), 'pattern-side let');
    assert.ok(bank('fn f(d: *Dma) {\n    d.src.'), 'far pointer field');
    assert.ok(bank('fn f() {\n    BUF_PTR.'), 'far pointer static');

    assert.ok(!bank('fn f(p: *OamEntry) {\n    p.'), 'near pointer');
    assert.strictEqual(complete(index, 'fn f(d: *Dma) {\n    d.near_src.'), undefined);
    assert.ok(!bank('fn f(d: *Dma) {\n    d.srcs.'), 'array of far pointers');
    assert.ok(!bank('fn f(e: far *OamEntry) {\n    (*e).'), 'dereferenced');
    assert.ok(!bank('fn f(e: far *OamEntry) {\n    e[0].'), 'indexed');
  });

  it('should offer len() on arrays and the rotates on integers', async () => {
    const index = await indexed({
      '/test/lib.r65': LIB,
      '/test/buf.r65': [
        'struct Buf { data: [u8; 16], rows: [[u8; 4]; 2], count: u16 }',
        'static BUFFER: [u8; 256];',
      ].join('\n'),
    });
    const of = (content: string) => labels(complete(index, content)).sort();

    assert.deepStrictEqual(of('fn f() {\n    BUFFER.'), ['len']);
    assert.deepStrictEqual(of('fn f(b: *Buf) {\n    b.data.'), ['len']);
    assert.deepStrictEqual(of('fn f(b: *Buf) {\n    b.rows[0].'), ['len'], 'inner array');
    assert.deepStrictEqual(of('fn f(b: *Buf) {\n    b.count.'), ['rotate_left', 'rotate_right']);
    assert.deepStrictEqual(of('fn f(b: *Buf, i: u8) {\n    b.data[i].'), ['rotate_left', 'rotate_right'], 'element');
    assert.deepStrictEqual(of('fn f(x: i8) {\n    x.'), ['rotate_left', 'rotate_right']);
    assert.deepStrictEqual(of('fn f() {\n    let mut v: u16 = 0;\n    v.'), ['rotate_left', 'rotate_right']);
    assert.deepStrictEqual(of('fn f(p: *u8) {\n    (*p).'), ['rotate_left', 'rotate_right'], 'deref');
    const rot = complete(index, 'fn f(x: u8) {\n    x.')!.find(i => i.label === 'rotate_left');
    assert.strictEqual(rot.insertText, 'rotate_left(1)');

    assert.strictEqual(complete(index, 'fn f(p: *u8) {\n    p.'), undefined, 'near pointer');
    assert.strictEqual(complete(index, 'fn f(ok: bool) {\n    ok.'), undefined, 'bool');
    assert.strictEqual(complete(index, 'fn f(p: *[u8; 4]) {\n    p.'), undefined, 'pointer to array');
  });

  it('should leave an unknown receiver to word-based suggestions', async () => {
    const index = await indexed({ '/test/lib.r65': LIB });
    assert.strictEqual(complete(index, 'fn f() {\n    mystery.'), undefined);
  });

  it('should offer variants and associated fns after Type::', async () => {
    const index = await indexed({ '/test/lib.r65': LIB });
    assert.deepStrictEqual(labels(complete(index, 'fn f() {\n    s = Shape::')).sort(), ['Circle', 'None', 'origin']);
    assert.ok(labels(complete(index, 'fn f() {\n    e = OamEntry::bl')).includes('blank'));
  });

  it('should offer locals, params, unsaved and indexed symbols, and keywords for a bare name', async () => {
    const index = await indexed({ '/test/lib.r65': LIB });
    const items = labels(complete(index, [
      'fn helper_not_saved() {',
      '}',
      'fn f(count: u8) {',
      '    let mut p: *OamEntry = &oam[0];',
      '    if let Shape::Circle(c) = s {',
      '        wa',
    ].join('\n')));
    for (const expected of ['count', 'p', 'c', 'helper_not_saved', 'wait_vblank', 'OamEntry', 'while', 'u8']) {
      assert.ok(items.includes(expected), `missing ${expected}`);
    }
    assert.ok(!items.includes('move_to'), 'methods are not free names');
    assert.ok(!items.includes('tile'), 'fields are not free names');
  });

  it('should offer nothing in a comment, a string or after a lone colon', async () => {
    const index = await indexed({ '/test/lib.r65': LIB });
    assert.strictEqual(complete(index, 'fn f() {\n    // e.'), undefined);
    assert.strictEqual(complete(index, 'fn f() {\n    print("e.'), undefined);
    assert.strictEqual(complete(index, 'fn f() {\n    let x:'), undefined);
  });
});

describe('References', () => {
  const PLAYER = [
    'impl Player {',
    '    fn update(far *self) {',           // 1
    '    }',
    '}',
    'impl Enemy {',
    '    fn update(far *self) {',           // 5
    '    }',
    '}',
  ].join('\n');
  const GAME = [
    'fn tick(p: *Player, e: *Enemy) {',
    '    p.update();',                       // 1
    '    e.update();',                       // 2
    '    Player::update(p);',                // 3
    '    // p.update() in a comment',
    '}',
  ].join('\n');

  async function references(files: Record<string, string>, path: string, marker: string, offset: number, includeDeclaration: boolean) {
    const index = await indexed(files);
    const content = files[path];
    const pos = positionOf(content, marker, offset);
    const result = await new R65ReferenceProvider(index).provideReferences(
      createMockDocument(content, path), new Position(pos.line, pos.character) as any, { includeDeclaration } as any, noCancel
    );
    return (result ?? []).map(l => `${l.uri.path}:${l.range.start.line}:${l.range.start.character}`).sort();
  }

  it('should find a method\'s uses across files, but not a same-named method on another type', async () => {
    const files = { '/test/lib.r65': PLAYER, '/test/game.r65': GAME };
    const refs = await references(files, '/test/game.r65', 'p.update', 2, true);
    assert.deepStrictEqual(refs, ['/test/game.r65:1:6', '/test/game.r65:3:12', '/test/lib.r65:1:7']);
  });

  it('should leave out the declaration when asked', async () => {
    const files = { '/test/lib.r65': PLAYER, '/test/game.r65': GAME };
    const refs = await references(files, '/test/lib.r65', 'update', 0, false);
    assert.deepStrictEqual(refs, ['/test/game.r65:1:6', '/test/game.r65:3:12']);
  });

  it('should count every copy of a vendored declaration and its calls', async () => {
    const lib = 'fn wait_vblank() {\n}';
    const files = { '/a/lib.r65': lib, '/b/lib.r65': lib, '/a/main.r65': 'fn main() {\n    wait_vblank();\n}' };
    const refs = await references(files, '/a/main.r65', 'wait_vblank', 0, true);
    assert.deepStrictEqual(refs, ['/a/lib.r65:0:3', '/a/main.r65:1:4', '/b/lib.r65:0:3']);
  });

  it('should find a local only inside its fn, skipping fields of the same name', async () => {
    const content = [
      'fn a() {',
      '    let mut count: u8 = 0;',
      '    count += 1;',
      '    self.count = count;',
      '}',
      'fn b() {',
      '    count = 2;',
      '}',
    ].join('\n');
    const refs = await references({ '/test/x.r65': content }, '/test/x.r65', 'count +=', 0, true);
    assert.deepStrictEqual(refs, ['/test/x.r65:1:12', '/test/x.r65:2:4', '/test/x.r65:3:17']);
  });

  it('should mask comments and strings without moving columns', () => {
    assert.deepStrictEqual(maskCode(['a /* b', 'c */ d "e\\"f" g // h']), ['a     ', '     d        g     ']);
  });
});

describe('Workspace symbols', () => {
  it('should match a query as an in-order subsequence, ignoring case', async () => {
    const index = await indexed({ '/test/lib.r65': LIB });
    const result = new R65WorkspaceSymbolProvider(index).provideWorkspaceSymbols('wvb', noCancel) as any[];
    assert.deepStrictEqual(result.map(s => s.name), ['wait_vblank']);
    assert.strictEqual(result[0].kind, SymbolKind.Function);

    const methods = new R65WorkspaceSymbolProvider(index).provideWorkspaceSymbols('MOVE', noCancel) as any[];
    assert.deepStrictEqual(methods.map(s => [s.name, s.containerName]), [['move_to', 'OamEntry']]);
  });
});
