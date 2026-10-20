# XRetroCode — VSCode DAP Debug Extension for Mesen-GDB

## Project Overview

XRetroCode enables real-time source-level debugging of retro console games through VSCode. The Mesen-GDB submodule is a multi-system emulator (NES, SNES, GB, GBA, PCE, SMS, WS) with a rich C++ debugging API. This project adds a DAP (Debug Adapter Protocol) server directly into Mesen-GDB so VSCode can act as the debug frontend.

## Architecture

```
┌──────────────┐    stdin/stdout     ┌─────────────────────────────────┐
│   VSCode     │◄───── DAP JSON ────►│  mesen-dap (headless executable)│
│  Extension   │    (Content-Length   │                                 │
│  (TypeScript)│     framed)         │  ┌─────────┐  ┌─────────────┐  │
└──────────────┘                     │  │DapServer │──│ Debugger API│  │
                                     │  └─────────┘  └─────────────┘  │
                                     │  ┌─────────┐  ┌─────────────┐  │
                                     │  │DbgParser│──│ LabelManager│  │
                                     │  └─────────┘  └─────────────┘  │
                                     │  ┌──────────────────────────┐  │
                                     │  │   Emulator Core (no UI)  │  │
                                     │  └──────────────────────────┘  │
                                     └─────────────────────────────────┘
```

- **mesen-dap**: Standalone C++ executable linking Mesen's Core. Runs headless (no SDL/audio). Speaks DAP over stdin/stdout.
- **VSCode Extension** (`xretrocode/`): Single TypeScript extension providing both R65 language support (syntax highlighting, go-to-definition, outline, build tasks) and the debug adapter — launches `mesen-gdb --dap` as a subprocess and provides launch configuration schemas.

## Key Design Decisions

1. **DAP implemented in C++** inside Mesen-GDB, not as a TypeScript adapter translating to GDB RSP
2. **Standalone `mesen-dap` binary** — avoids conflicts with the C#/.NET Avalonia UI
3. **Direct C++ API access** — calls Debugger/Emulator classes directly, not through InteropDLL C exports
4. **Custom minimal JSON library** — DAP messages are structurally simple; avoids large nlohmann/json dependency
5. **Port .dbg parser from C# to C++** — source-level debugging requires address↔source line mapping
6. **CpuType maps to DAP thread** — each active CPU (e.g., SNES 65816 + SPC700) is a separate DAP thread

## Project Structure

### C++ DAP Module (in `Mesen-GDB/`)

```
Mesen-GDB/
  Core/Debugger/DAP/
    DapServer.h/cpp           — Main server: message loop, request dispatch, event emission
    DapTypes.h                — DAP protocol enums/structs (request types, event types, capabilities)
    DapMessageReader.h/cpp    — stdin reader with Content-Length framing
    DapMessageWriter.h/cpp    — Thread-safe stdout writer with Content-Length framing
    DapJson.h/cpp             — Minimal JSON parser/builder
    DapNotificationListener.h — INotificationListener impl bridging Mesen events → DAP events
    CpuStateSerializer.h/cpp  — Per-CPU-type register state → JSON serialization
    DbgFileParser.h/cpp       — .dbg symbol file parser (ported from UI/Debugger/Integration/DbgImporter.cs)
    WlaSymParser.h/cpp        — WLA-DX .sym parser: labels, [addr-to-line mapping] (ported
                                from the deleted WlaDxImporter.cs)
    SourceMapper.h/cpp        — Bidirectional address ↔ source file+line mapping, from
                                either file. A cc65 C line (type=1) beats the assembly
                                generated for it, so stops and steps land in the .c file
  DapMain/
    DapMain.cpp               — main() entry point for mesen-dap executable
```

### VSCode Extension (in `xretrocode/`)

Language support and debugging ship as one extension — the debugger's
`contributes.breakpoints` must name the `r65` language id, so splitting them
means a broken experience if only one half is installed.

```
xretrocode/
  package.json                — Manifest: languages, grammars, taskDefinitions,
                                problemMatchers, debuggers, breakpoints, configuration
  tsconfig.json               — TypeScript config
  language-configuration.json — Comments, brackets, auto-closing, indentation
  asm-language-configuration.json — `;` comments for "retroasm" (.s/.asm/.inc): a
                                language with no grammar, so assembly files take breakpoints
  syntaxes/
    r65.tmLanguage.json       — TextMate grammar for .r65
  src/
    main.ts                   — activate/deactivate; wires up both halves
    debugAdapter.ts           — Factory: launches mesen-gdb --dap as subprocess
    debugConfiguration.ts     — Launch configuration provider + validation
    symbolIndex.ts            — Workspace-wide .r65 symbol index (fields, variants,
                                signatures, docs)
    typeResolver.ts           — Shared receiver/binding type resolution
    definitionProvider.ts     — Go to Definition (receiver-typed disambiguation)
    documentSymbolProvider.ts — Outline view
    hoverProvider.ts          — Hover: signature, owner, doc comment
    completionProvider.ts     — Completion after `.`, `Type::` and bare names
    referenceProvider.ts      — Find All References
    workspaceSymbolProvider.ts — Ctrl+T symbol search
    macroDefinitionAid.ts     — While debugging: "Go to Macro Definition" for the
                                macros on the stopped line (the debugger steps over them)
    tasks.ts                  — r65c build/check task provider
    config.ts                 — Compiler settings (r65.*)
    e2e/                      — Real VS Code + mesen-gdb on Mesen-GDB's test ROMs
                                (npm run test:e2e): green (R65, SNES) for breakpoints and
                                conditions, stepping, pause and inspection, launch path,
                                lifecycle, macro definitions, .sym labels; hello_c (cc65
                                C, NES) for C breakpoints and stepping. e2e/fixtures/ is
                                copied into its workspace
  .vscode/
    launch.json               — For developing/debugging the extension itself
```

## DAP ↔ Mesen Mapping

| DAP Concept | Mesen Mapping |
|---|---|
| Thread | CpuType (Nes, Snes, Spc, Gameboy, Gba, etc.) |
| StackFrame | CallstackManager::GetCallstack() + source mapping |
| Scope "Registers" | GetCpuState() → per-CPU register struct |
| Scope "Flags" | CPU status flags (N,V,D,I,Z,C etc.) |
| Scope "Memory" | MemoryDumper::GetMemoryValues() |
| Breakpoint | Breakpoint struct → BreakpointManager |
| Step In/Over/Out | Debugger::Step(cpuType, count, StepType) |
| Continue | Debugger::Run() |
| Pause | Debugger::BreakImmediately() |
| Evaluate | ExpressionEvaluator::EvaluateExpression() |
| Disassemble | Disassembler::GetDisassemblyOutput() |
| ReadMemory | MemoryDumper::GetMemoryValues() |
| Source mapping | .dbg file parser (ported from DbgImporter.cs) |

## Thread Safety

- **DapMessageWriter**: Protected by `SimpleLock` — events fire from emulation thread, responses from reader thread
- **Debugger API calls**: Use `DebuggerRequest` RAII wrapper (pattern from `DebugApiWrapper.cpp:31-48`)
- **Break/resume flow**: `SleepUntilResume()` blocks emulation thread; CodeBreak notification fires while emulation is paused, so state reads are safe
- **Variable reference map**: Only accessed from reader thread (sequential request handling), no extra locking needed

## Critical Reference Files in Mesen-GDB

- `Core/Debugger/Debugger.h/cpp` — Central debug facade (Run, Step, SetBreakpoints, GetCpuState, SleepUntilResume)
- `Core/Shared/Emulator.h` — Emulator lifecycle (LoadRom, InitDebugger, Run, Stop), notification manager
- `InteropDLL/DebugApiWrapper.cpp` — Reference pattern for safe external Debugger calls
- `Core/Shared/Interfaces/INotificationListener.h` — Interface for receiving CodeBreak/DebuggerResumed events
- `Core/Debugger/DebugTypes.h` — StepType, BreakSource, Breakpoint, StackFrameInfo structs
- `Core/Debugger/CallstackManager.h` — Call stack retrieval
- `Core/Debugger/BreakpointManager.h` — Breakpoint management
- `Core/Debugger/Disassembler.h` — Disassembly output
- `UI/Debugger/Integration/DbgImporter.cs` — .dbg parser to port to C++ (~1200 lines)
- `UI/Debugger/Integration/ISymbolProvider.cs` — Interface showing required symbol provider methods

## Implementation Phases

### Phase 1: Foundation — Minimal End-to-End
**Goal**: Launch a ROM from VSCode, break on entry, see registers, continue.

1. DapJson — Minimal recursive-descent JSON parser + fluent builder
2. DapMessageReader/Writer — Content-Length framing over stdin/stdout
3. DapServer skeleton — Handlers for: `initialize`, `launch`, `configurationDone`, `threads`, `stackTrace`, `scopes`, `variables`, `continue`, `disconnect`
4. DapNotificationListener — Bridge `ConsoleNotificationType::CodeBreak` → DAP `stopped` event
5. CpuStateSerializer — NES 6502 registers first (A, X, Y, SP, PC, P flags)
6. DapMain — Entry point: create Emulator, create DapServer, run message loop
7. Makefile `dap` target — Build `mesen-dap` binary
8. VSCode extension — `package.json` debugger contribution, `DebugAdapterDescriptorFactory`, launch config schema

**Verify**: Launch NES ROM → breaks on entry → registers visible → continue works.

### Phase 2: Core Debugging
**Goal**: Full stepping, breakpoints, disassembly.

9. Stepping — `next`→StepOver, `stepIn`→Step, `stepOut`→StepOut, `pause`→BreakImmediately
10. Address-based breakpoints — `setBreakpoints` with address breakpoints in disassembly view
11. Disassembly — `disassemble` request → `Disassembler::GetDisassemblyOutput()`
12. Stopped events — Correct reason (breakpoint, step, pause, entry) + allThreadsStopped:true

**Verify**: Set breakpoint by address → run → hits breakpoint → step through instructions.

### Phase 3: Source-Level Debugging
**Goal**: Set breakpoints in .asm/.c source files, see source in stack traces.

13. Port DbgImporter.cs → DbgFileParser.cpp — Parse .dbg files (segments, files, lines, spans, symbols)
14. SourceMapper — `GetSourceLocation(address)` and `GetAddress(file, line)` lookups
15. Source breakpoints — `setBreakpoints` with source file + line → resolve to address via SourceMapper
16. Stack traces with source — Return DAP StackFrames with source file + line info
17. Symbol loading in launch config — `dbgPath` launch config option (a `.dbg` or a WLA-DX `.sym`); auto-detect from ROM filename

**Verify**: Open .asm file → set breakpoint on line → launch ROM → hits breakpoint → source shown in call stack.

### Phase 4: Rich Features
**Goal**: Full variable inspection, memory access, expression evaluation.

18. CpuStateSerializer for all CPUs — SNES 65816, SPC700, GB LR35902, GBA ARM7, PCE HuC6280, SMS Z80, WS V30MZ
19. Expression evaluation — `evaluate` request → ExpressionEvaluator
20. Memory read/write — `readMemory`/`writeMemory` → MemoryDumper
21. Conditional breakpoints — Pass condition string to Mesen's ExpressionEvaluator
22. Full call stack — CallstackManager::GetCallstack() with NMI/IRQ frame annotations
23. Labels in stack frames — Use LabelManager for function names

### Phase 5: Polish & Extensions

24. Multi-console validation — Test all 7 console types
25. Exception breakpoints — Map BreakSource exceptions to DAP exception filters
26. StepBack support — DAP `stepBack` using Mesen's StepBackManager
27. Emulator-specific stepping — Custom DAP commands for PPU step, scanline step, frame advance
28. VSCode extension enhancements — Per-console launch snippets, ROM type auto-detection

## Build Commands

```bash
# Setup: initialize submodules
./setup.sh

# Build mesen-dap (headless DAP binary)
cd Mesen-GDB && make dap -j$(nproc)

# Build VSCode extension
cd xretrocode && npm install && npm run compile

# Extension unit tests (mocked vscode API)
cd xretrocode && npm test

# Extension e2e tests: real VS Code + mesen-gdb (needs `make` in Mesen-GDB).
# VSCODE_EXECUTABLE=/usr/share/code/code skips downloading VS Code into .vscode-test/
cd xretrocode && xvfb-run -a npm run test:e2e

# Run extension in development
# Open xretrocode/ in VSCode → press F5
```

## Conventions

- C++ code follows Mesen's existing style: PascalCase for classes/methods, camelCase for locals, tabs for indentation
- TypeScript code uses standard VSCode extension conventions: camelCase, 2-space indent
- DAP JSON keys are camelCase per the DAP specification
- All new C++ files go under `Mesen-GDB/Core/Debugger/DAP/` except the entry point in `Mesen-GDB/DapMain/`
- Use `SimpleLock` (from Mesen's `Utilities/SimpleLock.h`) for thread synchronization, not raw mutexes
