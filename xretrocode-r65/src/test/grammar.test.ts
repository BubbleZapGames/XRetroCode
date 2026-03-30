import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import * as vsctm from 'vscode-textmate';
import * as oniguruma from 'vscode-oniguruma';

// Load oniguruma WASM for regex engine
const wasmPath = path.resolve(__dirname, '..', '..', 'node_modules', 'vscode-oniguruma', 'release', 'onig.wasm');
const wasmBin = fs.readFileSync(wasmPath).buffer;
const vscodeOnigurumaLib = oniguruma.loadWASM(wasmBin).then(() => ({
    createOnigScanner: (patterns: string[]) => new oniguruma.OnigScanner(patterns),
    createOnigString: (s: string) => new oniguruma.OnigString(s),
}));

let registry: vsctm.Registry;
let grammar: vsctm.IGrammar;

function tokenizeLine(line: string, ruleStack?: vsctm.StateStack): vsctm.ITokenizeLineResult {
    return grammar.tokenizeLine(line, ruleStack || vsctm.INITIAL);
}

function getScopes(line: string): Array<{text: string, scopes: string[]}> {
    const result = tokenizeLine(line);
    return result.tokens.map(t => ({
        text: line.substring(t.startIndex, t.endIndex),
        scopes: t.scopes,
    }));
}

function assertHasScope(line: string, expectedText: string, scopeFragment: string) {
    const tokens = getScopes(line);
    const match = tokens.find(t => t.text === expectedText);
    assert.ok(match, `Token "${expectedText}" not found in: ${JSON.stringify(tokens.map(t => t.text))}`);
    const hasScope = match.scopes.some(s => s.includes(scopeFragment));
    assert.ok(hasScope, `Token "${expectedText}" should have scope containing "${scopeFragment}", got: ${match.scopes.join(', ')}`);
}

before(async function() {
    this.timeout(10000);
    const grammarPath = path.resolve(__dirname, '..', '..', 'syntaxes', 'r65.tmLanguage.json');
    registry = new vsctm.Registry({
        onigLib: vscodeOnigurumaLib,
        loadGrammar: async (scopeName: string) => {
            if (scopeName === 'source.r65') {
                const content = fs.readFileSync(grammarPath, 'utf8');
                return vsctm.parseRawGrammar(content, grammarPath);
            }
            return null;
        },
    });
    const g = await registry.loadGrammar('source.r65');
    assert.ok(g, 'Failed to load grammar');
    grammar = g;
});

describe('R65 TextMate Grammar', () => {
    describe('comments', () => {
        it('should highlight line comments', () => {
            assertHasScope('// this is a comment', '// this is a comment', 'comment.line');
        });

        it('should highlight block comments', () => {
            const tokens = getScopes('/* block */ code');
            const block = tokens.find(t => t.text.includes('block'));
            assert.ok(block);
            assert.ok(block.scopes.some(s => s.includes('comment.block')));
        });
    });

    describe('strings', () => {
        it('should highlight string literals', () => {
            assertHasScope('"hello world"', 'hello world', 'string.quoted.double');
        });

        it('should highlight escape sequences', () => {
            assertHasScope('"test\\n"', '\\n', 'constant.character.escape');
        });
    });

    describe('numbers', () => {
        it('should highlight hex literals', () => {
            assertHasScope('let x = 0xFF;', '0xFF', 'constant.numeric.hex');
        });

        it('should highlight binary literals', () => {
            assertHasScope('let x = 0b1010;', '0b1010', 'constant.numeric.binary');
        });

        it('should highlight decimal literals', () => {
            assertHasScope('let x = 42;', '42', 'constant.numeric.decimal');
        });

        it('should highlight numbers with type suffix', () => {
            assertHasScope('let x = 255u8;', '255u8', 'constant.numeric.decimal');
        });
    });

    describe('keywords', () => {
        it('should highlight control flow keywords', () => {
            assertHasScope('if x > 0 { }', 'if', 'keyword.control');
            assertHasScope('while true { }', 'while', 'keyword.control');
            assertHasScope('return 0;', 'return', 'keyword.control');
            assertHasScope('match x {', 'match', 'keyword.control');
            assertHasScope('for i in 0..10 {', 'for', 'keyword.control');
        });

        it('should highlight declaration keywords', () => {
            assertHasScope('let mut x = 5;', 'let', 'keyword.other');
            assertHasScope('let mut x = 5;', 'mut', 'keyword.other');
            assertHasScope('const X: u8 = 5;', 'const', 'keyword.other');
            assertHasScope('static mut val: u8;', 'static', 'keyword.other');
            assertHasScope('impl Player {', 'impl', 'keyword.other');
        });
    });

    describe('types', () => {
        it('should highlight primitive types', () => {
            assertHasScope('let x: u8 = 0;', 'u8', 'support.type.primitive');
            assertHasScope('let y: u16 = 0;', 'u16', 'support.type.primitive');
            assertHasScope('let z: bool = true;', 'bool', 'support.type.primitive');
        });
    });

    describe('booleans', () => {
        it('should highlight true/false', () => {
            assertHasScope('let x = true;', 'true', 'constant.language.boolean');
            assertHasScope('let x = false;', 'false', 'constant.language.boolean');
        });
    });

    describe('function definitions', () => {
        it('should highlight fn keyword and function name', () => {
            assertHasScope('fn my_func() {', 'fn', 'keyword.other.fn');
            assertHasScope('fn my_func() {', 'my_func', 'entity.name.function');
        });

        it('should highlight far functions', () => {
            assertHasScope('far fn init() {', 'far', 'keyword.other');
            assertHasScope('far fn init() {', 'fn', 'keyword.other.fn');
            assertHasScope('far fn init() {', 'init', 'entity.name.function');
        });
    });

    describe('type definitions', () => {
        it('should highlight struct definitions', () => {
            assertHasScope('struct Player {', 'struct', 'keyword.other');
            assertHasScope('struct Player {', 'Player', 'entity.name.type');
        });

        it('should highlight enum definitions', () => {
            assertHasScope('enum Direction {', 'enum', 'keyword.other');
            assertHasScope('enum Direction {', 'Direction', 'entity.name.type');
        });

        it('should highlight trait definitions', () => {
            assertHasScope('trait Drawable {', 'trait', 'keyword.other');
            assertHasScope('trait Drawable {', 'Drawable', 'entity.name.type');
        });
    });

    describe('attributes', () => {
        it('should highlight attribute brackets', () => {
            const tokens = getScopes('#[bank(0)]');
            const bankToken = tokens.find(t => t.text === 'bank');
            assert.ok(bankToken);
            assert.ok(bankToken.scopes.some(s => s.includes('attribute-name')));
        });

        it('should highlight hw attribute', () => {
            const tokens = getScopes('#[hw(0x2100)]');
            const hwToken = tokens.find(t => t.text === 'hw');
            assert.ok(hwToken);
            assert.ok(hwToken.scopes.some(s => s.includes('attribute-name')));
        });

        it('should highlight zeropage attribute', () => {
            const tokens = getScopes('#[zeropage]');
            const zpToken = tokens.find(t => t.text === 'zeropage');
            assert.ok(zpToken);
            assert.ok(zpToken.scopes.some(s => s.includes('attribute-name')));
        });
    });

    describe('macros', () => {
        it('should highlight macro definition', () => {
            assertHasScope('macro_rules! set_bg($x:expr) {', 'macro_rules', 'keyword.other.macro');
            assertHasScope('macro_rules! set_bg($x:expr) {', 'set_bg', 'entity.name.function.macro');
        });

        it('should highlight macro invocation', () => {
            assertHasScope('set_bg!(10);', 'set_bg', 'entity.name.function.macro');
        });

        it('should highlight macro variables', () => {
            assertHasScope('$x + $y', '$x', 'variable.other.macro');
            assertHasScope('$x + $y', '$y', 'variable.other.macro');
        });
    });

    describe('labels', () => {
        it('should highlight loop label definitions', () => {
            const tokens = getScopes("'outer: loop {");
            const label = tokens.find(t => t.text.includes("'outer:"));
            assert.ok(label, 'Label token not found');
            assert.ok(label.scopes.some(s => s.includes('label')));
        });
    });

    describe('operators', () => {
        it('should highlight arithmetic operators', () => {
            assertHasScope('a + b', '+', 'keyword.operator');
        });

        it('should highlight comparison operators', () => {
            assertHasScope('a == b', '==', 'keyword.operator.comparison');
        });

        it('should highlight arrow operator', () => {
            assertHasScope('fn f() -> u8', '->', 'keyword.operator.arrow');
        });

        it('should highlight range operators', () => {
            assertHasScope('0..10', '..', 'keyword.operator.range');
        });
    });

    describe('real R65 code snippets', () => {
        it('should tokenize a function with register binding', () => {
            const line = 'far fn player_horz_div(n @ A: u8) -> u8 {';
            assertHasScope(line, 'far', 'keyword.other');
            assertHasScope(line, 'fn', 'keyword.other.fn');
            assertHasScope(line, 'player_horz_div', 'entity.name.function');
            assertHasScope(line, 'u8', 'support.type.primitive');
        });

        it('should tokenize static with attribute', () => {
            const tokens = getScopes('#[hw(0x2100)]');
            // Just verify it parses without error and has attribute scope
            assert.ok(tokens.length > 0);
            assert.ok(tokens.some(t => t.scopes.some(s => s.includes('meta.attribute'))));
        });

        it('should tokenize include! macro', () => {
            assertHasScope('include!("../../stdlib/sneslib.r65")', 'include', 'keyword.other.include');
        });

        it('should tokenize asm! macro', () => {
            assertHasScope('asm!("WAI")', 'asm', 'keyword.other.asm');
        });
    });
});
