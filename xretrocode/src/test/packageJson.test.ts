import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

describe('package.json', () => {
    let pkg: any;

    before(() => {
        const pkgPath = path.resolve(__dirname, '..', '..', 'package.json');
        pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    });

    it('should have correct extension name', () => {
        assert.strictEqual(pkg.name, 'xretrocode');
    });

    it('should define r65 language', () => {
        const langs = pkg.contributes.languages;
        assert.ok(langs);
        assert.strictEqual(langs.length, 2);
        assert.strictEqual(langs[0].id, 'r65');
        assert.ok(langs[0].extensions.includes('.r65'));
    });

    it('should define a minimal assembly language so .s/.asm files take breakpoints', () => {
        const asm = pkg.contributes.languages.find((l: any) => l.id === 'retroasm');
        assert.ok(asm);
        assert.deepStrictEqual(asm.extensions, ['.s', '.asm', '.inc']);
        // Comments only: no grammar, so another extension's highlighting still applies
        assert.ok(!pkg.contributes.grammars.some((g: any) => g.language === 'retroasm'));
        const config = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', asm.configuration), 'utf8'));
        assert.strictEqual(config.comments.lineComment, ';');
    });

    it('should reference language configuration', () => {
        assert.strictEqual(pkg.contributes.languages[0].configuration, './language-configuration.json');
    });

    it('should define TextMate grammar', () => {
        const grammars = pkg.contributes.grammars;
        assert.ok(grammars);
        assert.strictEqual(grammars[0].language, 'r65');
        assert.strictEqual(grammars[0].scopeName, 'source.r65');
    });

    it('should define r65 task type', () => {
        const tasks = pkg.contributes.taskDefinitions;
        assert.ok(tasks);
        assert.strictEqual(tasks[0].type, 'r65');
        assert.ok(tasks[0].required.includes('command'));
    });

    it('should define problem matcher for r65c', () => {
        const matchers = pkg.contributes.problemMatchers;
        assert.ok(matchers);
        assert.strictEqual(matchers[0].name, 'r65c');
        assert.ok(matchers[0].pattern.length >= 2);
    });

    it('should define compiler configuration', () => {
        const props = pkg.contributes.configuration.properties;
        assert.ok(props['r65.compilerPath']);
        assert.strictEqual(props['r65.compilerPath'].type, 'string');
        assert.ok(props['r65.targetPlatform']);
        assert.ok(props['r65.targetPlatform'].enum.includes('snes'));
        assert.ok(props['r65.targetPlatform'].enum.includes('nes'));
        assert.ok(props['r65.includePaths']);
        assert.ok(props['r65.cfgOptions']);
    });

    it('should define a debugger contribution', () => {
        assert.ok(pkg.contributes.debuggers);
        assert.strictEqual(pkg.contributes.debuggers.length, 1);
        assert.strictEqual(pkg.contributes.debuggers[0].type, 'xretrocode');
    });

    it('should define romPath without forcing it up front', () => {
        const launch = pkg.contributes.debuggers[0].configurationAttributes.launch;
        assert.strictEqual(launch.properties.romPath.type, 'string');
        // The provider resolves a ROM when it is absent, so marking it required
        // would block F5 before that code ever runs.
        assert.ok(!launch.required.includes('romPath'));
    });

    it('should define dbgPath so it gets completion in launch.json', () => {
        const props = pkg.contributes.debuggers[0].configurationAttributes.launch.properties;
        assert.ok(props.dbgPath);
        assert.strictEqual(props.dbgPath.type, 'string');
    });

    it('should contribute the pickRom command', () => {
        assert.ok(pkg.contributes.commands);
        assert.ok(pkg.contributes.commands.some((c: any) => c.command === 'xretrocode.pickRom'));
    });

    it('should default romPath to the pickRom command', () => {
        const initial = pkg.contributes.debuggers[0].initialConfigurations[0];
        assert.strictEqual(initial.romPath, '${command:xretrocode.pickRom}');
    });

    it('should define stopOnEntry as boolean defaulting to true', () => {
        const props = pkg.contributes.debuggers[0].configurationAttributes.launch.properties;
        assert.strictEqual(props.stopOnEntry.type, 'boolean');
        assert.strictEqual(props.stopOnEntry.default, true);
    });

    it('should define mesenDapPath as an optional string', () => {
        const props = pkg.contributes.debuggers[0].configurationAttributes.launch.properties;
        assert.ok(props.mesenDapPath);
        assert.strictEqual(props.mesenDapPath.type, 'string');
    });

    it('should have an initial debug configuration', () => {
        const initial = pkg.contributes.debuggers[0].initialConfigurations;
        assert.ok(initial && initial.length > 0);
        assert.strictEqual(initial[0].type, 'xretrocode');
        assert.strictEqual(initial[0].request, 'launch');
    });

    it('should carry configurationSnippets inside the debugger contribution', () => {
        // As a top-level contributes key VSCode silently ignores it
        assert.ok(pkg.contributes.debuggers[0].configurationSnippets);
        assert.strictEqual(pkg.contributes.configurationSnippets, undefined);
    });

    it('should allow breakpoints in r65, C and assembly files', () => {
        // Without this VSCode refuses to place breakpoints in the gutter.
        // VS Code opens .c as c and .h as cpp.
        assert.ok(pkg.contributes.breakpoints);
        for (const language of ['r65', 'c', 'cpp', 'retroasm']) {
            assert.ok(pkg.contributes.breakpoints.some((b: any) => b.language === language), language);
        }
    });

    it('should offer the debugger for r65, C and assembly files', () => {
        // F5 with no launch.json lists the debuggers for the active file's language
        assert.deepStrictEqual(pkg.contributes.debuggers[0].languages, ['r65', 'c', 'cpp', 'retroasm']);
    });

    it('should define the xretrocode.mesenDapPath setting', () => {
        const props = pkg.contributes.configuration.properties;
        assert.ok(props['xretrocode.mesenDapPath']);
        assert.strictEqual(props['xretrocode.mesenDapPath'].type, 'string');
    });

    it('should activate for both r65 files and xretrocode debug sessions', () => {
        assert.ok(pkg.activationEvents.includes('onLanguage:r65'));
        // Starting a session, and VS Code asking for launch.json's first configurations
        assert.ok(pkg.activationEvents.includes('onDebugResolve:xretrocode'));
        assert.ok(pkg.activationEvents.includes('onDebugInitialConfigurations'));
    });

    it('should only use activation events VS Code recognises', () => {
        // A malformed event (e.g. "debug: xretrocode") is silently ignored
        const known = /^(onLanguage|workspaceContains|onDebugResolve|onCommand):\S+$|^onDebugInitialConfigurations$/;
        for (const event of pkg.activationEvents) {
            assert.ok(known.test(event), `unrecognised activation event: ${event}`);
        }
    });

    it('should declare both language and debugger categories', () => {
        assert.ok(pkg.categories.includes('Programming Languages'));
        assert.ok(pkg.categories.includes('Debuggers'));
    });

    it('should have compile and test scripts', () => {
        assert.ok(pkg.scripts.compile);
        assert.ok(pkg.scripts.test);
    });
});

describe('language-configuration.json', () => {
    let langConfig: any;

    before(() => {
        const cfgPath = path.resolve(__dirname, '..', '..', 'language-configuration.json');
        langConfig = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    });

    it('should define line comment', () => {
        assert.strictEqual(langConfig.comments.lineComment, '//');
    });

    it('should define block comment', () => {
        assert.deepStrictEqual(langConfig.comments.blockComment, ['/*', '*/']);
    });

    it('should define bracket pairs', () => {
        assert.ok(langConfig.brackets.length >= 3);
    });

    it('should define auto-closing pairs', () => {
        assert.ok(langConfig.autoClosingPairs.length >= 4);
    });

    it('should define indentation rules', () => {
        assert.ok(langConfig.indentationRules.increaseIndentPattern);
        assert.ok(langConfig.indentationRules.decreaseIndentPattern);
    });
});

describe('TextMate grammar file', () => {
    let grammar: any;

    before(() => {
        const grammarPath = path.resolve(__dirname, '..', '..', 'syntaxes', 'r65.tmLanguage.json');
        grammar = JSON.parse(fs.readFileSync(grammarPath, 'utf8'));
    });

    it('should have correct scope name', () => {
        assert.strictEqual(grammar.scopeName, 'source.r65');
    });

    it('should include all major pattern groups', () => {
        const includes = grammar.patterns.map((p: any) => p.include);
        assert.ok(includes.includes('#comments'));
        assert.ok(includes.includes('#strings'));
        assert.ok(includes.includes('#attributes'));
        assert.ok(includes.includes('#numbers'));
        assert.ok(includes.includes('#keywords-control'));
        assert.ok(includes.includes('#keywords-declaration'));
        assert.ok(includes.includes('#types'));
        assert.ok(includes.includes('#booleans'));
        assert.ok(includes.includes('#registers'));
        assert.ok(includes.includes('#operators'));
    });

    it('should define all repository groups', () => {
        const repo = grammar.repository;
        assert.ok(repo.comments);
        assert.ok(repo.strings);
        assert.ok(repo.attributes);
        assert.ok(repo.numbers);
        assert.ok(repo['function-definition']);
        assert.ok(repo['type-definition']);
        assert.ok(repo['macro-definition']);
        assert.ok(repo['macro-invocation']);
        assert.ok(repo['keywords-control']);
        assert.ok(repo['keywords-declaration']);
        assert.ok(repo.types);
        assert.ok(repo.booleans);
        assert.ok(repo.registers);
        assert.ok(repo.labels);
        assert.ok(repo['macro-variables']);
        assert.ok(repo.operators);
    });
});
