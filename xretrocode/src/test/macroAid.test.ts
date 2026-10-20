import * as assert from 'assert';
import { Uri, workspace } from './vscode-mock';
import { R65SymbolIndex } from '../symbolIndex';
import { findMacroInvocations, isR65Path, resolveMacroDefinitions } from '../macroDefinitionAid';
import { createMockDocument } from './mockDocument';

const names = (line: string) => findMacroInvocations(line).map(m => m.name);

describe('findMacroInvocations', () => {
  it('should find plain, nested, path and method invocations', () => {
    assert.deepStrictEqual(names('    set_backdrop!(Color::rgb!(0, 31, 0));'), ['set_backdrop', 'rgb']);
    assert.deepStrictEqual(names('    oam_buffer.set!(spr, ox);'), ['set']);
    assert.deepStrictEqual(names('    wait_nmi!();'), ['wait_nmi']);
    assert.deepStrictEqual(names('    clear_nmi!()'), ['clear_nmi']);
  });

  it('should report the column of the macro name', () => {
    const [outer, inner] = findMacroInvocations('    set_backdrop!(Color::rgb!(0, 31, 0));');
    assert.strictEqual(outer.column, 4);
    assert.strictEqual(inner.column, '    set_backdrop!(Color::'.length);
  });

  it('should ignore !=, comments, strings and macro definitions', () => {
    assert.deepStrictEqual(names('    if a != (b) {'), []);
    assert.deepStrictEqual(names('    x = 1; // wait_nmi!()'), []);
    assert.deepStrictEqual(names('    print("set!(x)");'), []);
    assert.deepStrictEqual(names('macro_rules! wait_nmi() {'), []);
  });
});

describe('isR65Path', () => {
  it('should offer macros only for stops in R65 source', () => {
    assert.ok(isR65Path('/game/src/main.r65'));
    assert.ok(isR65Path('C:\\game\\MAIN.R65'));
    // `return !(x)` in C is a negation, not a macro called `return`
    assert.ok(!isR65Path('/game/hello.c'));
    assert.ok(!isR65Path('/game/hello.s'));
  });
});

describe('resolveMacroDefinitions', () => {
  const LIB = [
    'macro_rules! wait_nmi() {',          // 0
    '    asm!("WAI");',
    '}',
    'impl OamEntry {',
    '    macro_rules! set($x:expr) {',    // 4
    '    }',
    '}',
    'impl OamBuffer {',
    '    macro_rules! set($i:expr) {',    // 8
    '    }',
    '}',
    'impl Color {',
    '    macro_rules! rgb($r:expr, $g:expr, $b:expr) {',  // 12
    '    }',
    '}',
  ].join('\n');

  async function indexed(): Promise<R65SymbolIndex> {
    workspace._reset();
    workspace._setFileContent('/game/lib.r65', LIB);
    const index = new R65SymbolIndex();
    await index.indexFile(Uri.file('/game/lib.r65') as any);
    return index;
  }

  function resolve(index: R65SymbolIndex, content: string, line: number) {
    return resolveMacroDefinitions(index, createMockDocument(content, '/game/main.r65'), line)
      .map(m => [m.name, m.definitions.map(d => d.selectionRange.start.line)]);
  }

  it('should resolve a free macro and a Type:: macro on the same line', async () => {
    const index = await indexed();
    assert.deepStrictEqual(resolve(index, '    wait_nmi!(Color::rgb!(1, 2, 3));', 0), [['wait_nmi', [0]], ['rgb', [12]]]);
  });

  it('should pick the impl macro of a typed receiver', async () => {
    const index = await indexed();
    const caller = 'fn f(buf: *OamBuffer) {\n    buf.set!(1);';
    assert.deepStrictEqual(resolve(index, caller, 1), [['set', [8]]]);
  });

  it('should leave out invocations with no known definition', async () => {
    const index = await indexed();
    assert.deepStrictEqual(resolve(index, '    mystery!(1);', 0), []);
    assert.deepStrictEqual(resolve(index, '    x = 1;', 0), []);
  });

  it('should keep only the nearest of vendored copies', async () => {
    workspace._reset();
    workspace._setFileContent('/a/src/lib/snes.r65', 'macro_rules! wait_nmi() {\n}');
    workspace._setFileContent('/b/src/lib/snes.r65', 'macro_rules! wait_nmi() {\n}');
    const index = new R65SymbolIndex();
    await index.indexFile(Uri.file('/a/src/lib/snes.r65') as any);
    await index.indexFile(Uri.file('/b/src/lib/snes.r65') as any);
    const [macro] = resolveMacroDefinitions(index, createMockDocument('    wait_nmi!();', '/b/src/main.r65'), 0);
    assert.deepStrictEqual(macro.definitions.map(d => d.uri.path), ['/b/src/lib/snes.r65']);
  });
});
