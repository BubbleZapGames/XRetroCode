import * as assert from 'assert';
import { Uri, Position, workspace } from './vscode-mock';
import { R65SymbolIndex } from '../symbolIndex';
import { R65RenameProvider } from '../renameProvider';
import { maskCode } from '../sourceText';
import { createMockDocument, noCancel, positionOf } from './mockDocument';

async function indexed(files: Record<string, string>): Promise<R65SymbolIndex> {
  workspace._reset();
  const index = new R65SymbolIndex();
  for (const [path, content] of Object.entries(files)) {
    workspace._setFileContent(path, content);
    if (path.endsWith('.r65')) await index.indexFile(Uri.file(path) as any);
  }
  return index;
}

/** The rename's edits as `path:line:col`, with ` ?label` on those needing confirmation. */
async function rename(
  files: Record<string, string>, path: string, marker: string, offset: number, newName: string
): Promise<string[]> {
  const index = await indexed(files);
  const content = files[path];
  const pos = positionOf(content, marker, offset);
  const provider = new R65RenameProvider(index);
  const doc = createMockDocument(content, path);
  const edit: any = await provider.provideRenameEdits(doc, new Position(pos.line, pos.character) as any, newName, noCancel);
  for (const e of edit._edits) assert.strictEqual(e.newText, newName);
  return edit._edits.map((e: any) =>
    `${e.uri.path}:${e.range.start.line}:${e.range.start.character}${e.metadata?.needsConfirmation ? ` ?${e.metadata.label}` : ''}`
  ).sort();
}

async function rejects(
  files: Record<string, string>, path: string, marker: string, offset: number, newName: string, message: RegExp
) {
  await assert.rejects(() => rename(files, path, marker, offset, newName), message);
}

async function prepareFails(files: Record<string, string>, path: string, marker: string, offset: number, message: RegExp) {
  const index = await indexed(files);
  const pos = positionOf(files[path], marker, offset);
  assert.throws(
    () => new R65RenameProvider(index).prepareRename(createMockDocument(files[path], path), new Position(pos.line, pos.character) as any),
    message
  );
}

describe('Rename', () => {
  const LIB = 'fn wait_vblank() {\n}\n';
  const MAIN = [
    'fn main() {',
    '    wait_vblank();',          // 1
    '    // wait_vblank in a comment',
    '    print("wait_vblank");',
    '}',
  ].join('\n');

  it('should rename a free fn and its calls across files, not comments or strings', async () => {
    const edits = await rename({ '/test/lib.r65': LIB, '/test/main.r65': MAIN }, '/test/main.r65', 'wait_vblank', 0, 'frame_wait');
    assert.deepStrictEqual(edits, ['/test/lib.r65:0:3', '/test/main.r65:1:4']);
  });

  it('should rename from the end of a double-clicked word, as the context menu sends it', async () => {
    const edits = await rename({ '/test/lib.r65': LIB, '/test/main.r65': MAIN }, '/test/main.r65', 'wait_vblank', 11, 'frame_wait');
    assert.deepStrictEqual(edits, ['/test/lib.r65:0:3', '/test/main.r65:1:4']);
  });

  it('should rename a method but not a same-named method on another type', async () => {
    const player = [
      'impl Player {',
      '    fn update(far *self) {',          // 1
      '    }',
      '}',
      'impl Enemy {',
      '    fn update(far *self) {',          // 5
      '    }',
      '}',
    ].join('\n');
    const game = [
      'fn tick(p: *Player, e: *Enemy) {',
      '    p.update();',                       // 1
      '    e.update();',
      '    Player::update(p);',                // 3
      '}',
    ].join('\n');
    const edits = await rename({ '/test/lib.r65': player, '/test/game.r65': game }, '/test/game.r65', 'p.update', 2, 'step');
    assert.deepStrictEqual(edits, ['/test/game.r65:1:6', '/test/game.r65:3:12', '/test/lib.r65:1:7']);
  });

  it('should rename a field in struct literals and accesses, flagging an untyped receiver', async () => {
    const content = [
      'struct Point { x: u8, y: u8 }',
      'struct Size { x: u8 }',
      'fn f(p: *Point) {',
      '    let q = Point { x: 1, y: 2 };',   // 3
      '    let s = Size { x: 3 };',
      '    p.x = q.x;',                       // 5
      '}',
    ].join('\n');
    const edits = await rename({ '/test/a.r65': content }, '/test/a.r65', 'x: u8, y', 0, 'left');
    assert.deepStrictEqual(edits, [
      '/test/a.r65:0:15', '/test/a.r65:3:20', '/test/a.r65:5:12 ?Unresolved receiver type', '/test/a.r65:5:6',
    ]);
  });

  it('should rename a field from a struct literal key', async () => {
    const content = [
      'struct Point { x: u8 }',
      'fn f() {',
      '    let q = Point {',
      '        x: 1,',                         // 3
      '    };',
      '}',
    ].join('\n');
    const edits = await rename({ '/test/a.r65': content }, '/test/a.r65', 'x: 1', 0, 'left');
    assert.deepStrictEqual(edits, ['/test/a.r65:0:15', '/test/a.r65:3:8']);
  });

  it('should rename an enum variant in paths and match arms', async () => {
    const content = [
      'enum Dir { Up, Down }',
      'fn f(d: Dir) {',
      '    match d {',
      '        Dir::Up => go(),',              // 3
      '        Dir::Down => stop(),',
      '    }',
      '    let e = Dir::Up;',                  // 6
      '}',
    ].join('\n');
    const edits = await rename({ '/test/a.r65': content }, '/test/a.r65', 'Up,', 0, 'North');
    assert.deepStrictEqual(edits, ['/test/a.r65:0:11', '/test/a.r65:3:13', '/test/a.r65:6:17']);
  });

  it('should rename a trait method in the trait and every impl, starting from one impl', async () => {
    const content = [
      'trait Shape {',
      '    fn area(*self) -> u8;',             // 1
      '}',
      'impl Shape for Circle {',
      '    fn area(*self) -> u8 { 1 }',        // 4
      '}',
      'impl Shape for Square {',
      '    fn area(*self) -> u8 { 2 }',        // 7
      '}',
      'impl Board {',
      '    fn area(*self) -> u8 { 3 }',
      '}',
      'fn f(c: *Circle, b: *Board) {',
      '    c.area();',                         // 13
      '    b.area();',
      '}',
    ].join('\n');
    const edits = await rename({ '/test/a.r65': content }, '/test/a.r65', 'area(*self) -> u8 { 1', 0, 'size');
    assert.deepStrictEqual(edits, ['/test/a.r65:13:6', '/test/a.r65:1:7', '/test/a.r65:4:7', '/test/a.r65:7:7']);
  });

  it('should rename a type in annotations, impl lines, literals and paths', async () => {
    const content = [
      'struct Player { hp: u8 }',
      'impl Player {',
      '    fn new() -> Player { Player { hp: 3 } }',
      '}',
      'impl Drawable for Player {',
      '}',
      'fn f(p: *Player) {',
      '    let q = Player::new();',
      '}',
    ].join('\n');
    const edits = await rename({ '/test/a.r65': content }, '/test/a.r65', 'Player', 0, 'Hero');
    assert.deepStrictEqual(edits, [
      '/test/a.r65:0:7', '/test/a.r65:1:5', '/test/a.r65:2:16', '/test/a.r65:2:25',
      '/test/a.r65:4:18', '/test/a.r65:6:9', '/test/a.r65:7:12',
    ]);
    await rejects({ '/test/a.r65': content }, '/test/a.r65', 'Player', 0, 'hero', /uppercase/);
  });

  it('should leave a same-named variant alone when renaming a type', async () => {
    const content = [
      'struct Launcher { ammo: u8 }',
      'enum Order { Idle, Launcher(Launcher) }',
      'fn f(l: Launcher) {',
      '    let o = Order::Launcher(l);',
      '}',
    ].join('\n');
    const edits = await rename({ '/test/a.r65': content }, '/test/a.r65', 'Launcher', 0, 'Rocket');
    assert.deepStrictEqual(edits, ['/test/a.r65:0:7', '/test/a.r65:1:28', '/test/a.r65:2:8']);
  });

  it('should rename a const used as a range bound', async () => {
    const content = 'const COUNT: u16 = 4;\nfn f() {\n    for c in 0..COUNT {\n    }\n}';
    const edits = await rename({ '/test/a.r65': content }, '/test/a.r65', 'COUNT', 0, 'TOTAL');
    assert.deepStrictEqual(edits, ['/test/a.r65:0:6', '/test/a.r65:2:16']);
  });

  it('should refuse a symbol declared in a generated file, and flag uses in one', async () => {
    const generated = '// GENERATED by make - DO NOT EDIT, and do not commit.\nconst TILES: u16 = 4;\nconst MORE: u16 = SIZE + 1;';
    const main = 'const SIZE: u16 = 2;\nfn f() {\n    load(TILES, SIZE);\n}';
    const files = { '/test/assets.r65': generated, '/test/main.r65': main };
    await rejects(files, '/test/main.r65', 'TILES', 0, 'CHR', /generated file/);
    const edits = await rename(files, '/test/main.r65', 'SIZE', 0, 'BYTES');
    assert.deepStrictEqual(edits, [
      '/test/assets.r65:2:18 ?Generated file (rebuilt from its source)', '/test/main.r65:0:6', '/test/main.r65:2:16',
    ]);
  });

  describe('locals', () => {
    const SHADOW = [
      'fn f() {',
      '    let x = 1;',                        // 1
      '    {',
      '        let x = x + 1;',                // 3
      '        use_it(x);',                    // 4
      '    }',
      '    use_it(x);',                        // 6
      '}',
    ].join('\n');

    it('should rename the outer binding, including its use in a shadowing initializer', async () => {
      const edits = await rename({ '/test/a.r65': SHADOW }, '/test/a.r65', 'x = 1', 0, 'y');
      assert.deepStrictEqual(edits, ['/test/a.r65:1:8', '/test/a.r65:3:16', '/test/a.r65:6:11']);
    });

    it('should rename only the inner binding inside its block', async () => {
      const edits = await rename({ '/test/a.r65': SHADOW }, '/test/a.r65', 'use_it(x)', 7, 'z');
      assert.deepStrictEqual(edits, ['/test/a.r65:3:12', '/test/a.r65:4:15']);
    });

    it('should rename a parameter of a multi-line fn header', async () => {
      const content = 'fn f(\n    a: u8,\n    count: u8,\n) {\n    let b = count;\n}';
      const edits = await rename({ '/test/a.r65': content }, '/test/a.r65', '= count', 2, 'n');
      assert.deepStrictEqual(edits, ['/test/a.r65:2:4', '/test/a.r65:4:12']);
    });

    it('should refuse a name already used in the binding\'s scope', async () => {
      const content = 'fn f() {\n    let x = 1;\n    let y = 2;\n    use_it(x + y);\n}';
      await rejects({ '/test/a.r65': content }, '/test/a.r65', 'x = 1', 0, 'y', /already used in the scope/);
    });
  });

  it('should rename a macro variable within its own macro only', async () => {
    const content = [
      'macro_rules! twice($v:expr) {',
      '    ($v) + ($v)',
      '}',
      'macro_rules! other($v:expr) {',
      '    $v',
      '}',
    ].join('\n');
    const edits = await rename({ '/test/a.r65': content }, '/test/a.r65', '($v)', 2, 'w');
    assert.deepStrictEqual(edits, ['/test/a.r65:0:20', '/test/a.r65:1:13', '/test/a.r65:1:6']);
  });

  describe('assembly', () => {
    const GAME = [
      'extern fn snd_play(id: u8);',
      'impl Player {',
      '    fn update(far *self) {',
      '        asm!("JSL snd_play");',         // 3
      '    }',
      '}',
      'fn main() {',
      '    snd_play(1);',                      // 7
      '}',
    ].join('\n');
    const FILES = {
      '/test/game.r65': GAME,
      '/test/sound.s': '; snd_play plays a sound\nsnd_play:\n    RTL\n    JSL snd_play_long\n',
      '/test/build/game.asm': '; Generated by R65 Compiler\nsnd_play:\n    JSL Player__update\n',
      '/test/player.asm': '    JSL Player__update\n',
    };

    it('should flag an extern fn\'s labels in assembly and asm! strings, leaving generated output alone', async () => {
      const edits = await rename(FILES, '/test/game.r65', 'snd_play(1)', 0, 'sfx_play');
      assert.deepStrictEqual(edits, [
        '/test/game.r65:0:10', '/test/game.r65:3:18 ?Inline asm!', '/test/game.r65:7:4',
        '/test/sound.s:1:0 ?Assembly reference',
      ]);
    });

    it('should flag a method\'s Type__method label', async () => {
      const edits = await rename(FILES, '/test/game.r65', 'update', 0, 'tick');
      assert.deepStrictEqual(edits, ['/test/game.r65:2:7', '/test/player.asm:0:16 ?Assembly reference']);
    });

    it('should flag the type part of Type__member labels when renaming a type', async () => {
      const files = { ...FILES, '/test/game.r65': 'struct Player { hp: u8 }\n' + GAME };
      const edits = await rename(files, '/test/game.r65', 'Player {', 0, 'Hero');
      assert.deepStrictEqual(edits, [
        '/test/game.r65:0:7', '/test/game.r65:2:5', '/test/player.asm:0:8 ?Assembly reference',
      ]);
    });
  });

  describe('scope', () => {
    it('should keep to the project when another one vendors the same file', async () => {
      const files = {
        '/a/Makefile': 'all:\n', '/a/lib.r65': LIB, '/a/main.r65': MAIN,
        '/b/Makefile': 'all:\n', '/b/lib.r65': LIB, '/b/main.r65': MAIN,
      };
      const edits = await rename(files, '/a/main.r65', 'wait_vblank', 0, 'frame_wait');
      assert.deepStrictEqual(edits, ['/a/lib.r65:0:3', '/a/main.r65:1:4']);
    });

    it('should flag uses in other projects when the declaration is shared from outside', async () => {
      const files = {
        '/w/common/lib.r65': LIB,
        '/w/a/Makefile': 'all:\n', '/w/a/main.r65': MAIN,
        '/w/b/Makefile': 'all:\n', '/w/b/main.r65': MAIN,
      };
      const edits = await rename(files, '/w/a/main.r65', 'wait_vblank', 0, 'frame_wait');
      assert.deepStrictEqual(edits, [
        '/w/a/main.r65:1:4',
        '/w/b/main.r65:1:4 ?Outside this project',
        '/w/common/lib.r65:0:3 ?Outside this project',
      ]);
    });

    it('should never edit package code under .r65/deps', async () => {
      const files = { '/p/r65.toml': '[package]\n', '/p/.r65/deps/std/lib.r65': LIB, '/p/main.r65': MAIN };
      await prepareFails(files, '/p/main.r65', 'wait_vblank', 0, /\.r65\/deps/);
    });
  });

  describe('refusals', () => {
    const FILES = { '/test/lib.r65': LIB, '/test/main.r65': MAIN };

    it('should refuse keywords, registers and names in comments', async () => {
      const files = { '/test/a.r65': 'fn f() {\n    let mut v @ A: u8 = 0; // note\n}' };
      await prepareFails(files, '/test/a.r65', 'let', 0, /keyword/);
      await prepareFails(files, '/test/a.r65', 'A:', 0, /keyword, type or register/);
      await prepareFails(files, '/test/a.r65', 'note', 0, /comments and strings/);
    });

    it('should refuse a name with no indexed declaration', async () => {
      await prepareFails({ '/test/a.r65': 'fn f() {\n    made_by_macro();\n}' }, '/test/a.r65', 'made_by_macro', 0, /declaration/);
    });

    it('should refuse invalid and reserved new names', async () => {
      await rejects(FILES, '/test/main.r65', 'wait_vblank', 0, '1st', /valid R65 identifier/);
      await rejects(FILES, '/test/main.r65', 'wait_vblank', 0, 'loop', /keyword/);
    });

    it('should refuse a name another global already has', async () => {
      await rejects(FILES, '/test/main.r65', 'wait_vblank', 0, 'main', /already declared/);
    });

    it('should refuse a member name the type already has', async () => {
      const content = 'struct Point { x: u8, y: u8 }';
      await rejects({ '/test/a.r65': content }, '/test/a.r65', 'x:', 0, 'y', /already has a member 'y'/);
    });

    it('should refuse a new name a local would capture', async () => {
      const content = 'fn count() -> u8 {\n}\nfn f() {\n    let n = 1;\n    let m = count();\n}';
      await rejects({ '/test/a.r65': content }, '/test/a.r65', 'count()', 0, 'n', /local 'n' would hide/);
    });
  });
});

describe('Masking', () => {
  it('should blank char and byte literals but keep loop labels', () => {
    assert.deepStrictEqual(
      maskCode(["let c = b'x'; let d = '\\n'; break 'outer;"]),
      ["let c =     ; let d =     ; break 'outer;"]
    );
  });

  it('should keep strings when asked', () => {
    assert.deepStrictEqual(maskCode(['asm!("LDA #1"); // c'], true), ['asm!("LDA #1");     ']);
  });
});

describe('Symbol index from unsaved text', () => {
  it('should replace a file\'s symbols with those of the given text', async () => {
    const index = await indexed({ '/test/a.r65': 'fn old_name() {\n}' });
    index.indexText(Uri.file('/test/a.r65') as any, 'fn new_name() {\n}');
    assert.strictEqual(index.lookup('old_name').length, 0);
    assert.strictEqual(index.lookup('new_name').length, 1);
  });
});
