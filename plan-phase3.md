# Phase 3: Source-Level Debugging

## Goal
Set breakpoints in .asm/.c source files, see source in stack traces, full symbol support.

## Key Components

### 1. .dbg File Parser
- Parse .dbg format from `UI/Debugger/Integration/DbgImporter.cs` (~1200 lines)
- Extract:
  - Files: source file paths
  - Lines: address ↔ source line mapping
  - Segments: code/data segments with base addresses
  - Spans: code ranges with symbol info
  - Symbols: function names, labels

### 2. SourceMapper
- `GetSourceLocation(address)` → {file, line}
- `GetAddress(file, line)` → address
- Bidirectional mapping for source ↔ disassembly

### 3. Enhanced Breakpoints
- `setBreakpoints` with source file + line
- Resolve to address via SourceMapper
- Handle multiple breakpoints per line (e.g., inline functions)

### 4. Stack Traces with Source
- Use CallstackManager::GetCallstack() for full call stack
- Map each frame to source location
- Return proper `StackFrame` with:
  - `name`: function name or "0xNNNN"
  - `line`: source line
  - `column`: character position
  - `source`: {path, name, lines, checksums}

### 5. Launch Config Updates
- `dbgPath` option for explicit symbol file path
- Auto-detect: `romPath` → replace extension with .dbg
- Support multiple symbol file formats

## Implementation Tasks

### Files to Add
1. **DbgFileParser.h/cpp** (~400 lines)
   - Parse segments, files, lines, spans, symbols
   - Store in structured format
2. **SourceMapper.h/cpp** (~200 lines)
   - Address ↔ source line lookups
   - caching for performance
3. **SymbolManager.h/cpp** (~100 lines)
   - Symbol resolution (function names, labels)
   - Use LabelManager from Mesen

### Files to Modify
1. **DapServer.cpp** - Update `setBreakpoints`, `stackTrace` handlers
2. **DapNotificationListener.cpp** - Extract function names for stopped events
3. **GDB/DapMain.cpp** - Load .dbg file on ROM load

### DAP Changes
- `setBreakpoints` now accepts `source.path` + `line`
- `stackTrace` returns full call stack with source info
- Add `loadedSources` response for symbol file status

## Verification
1. Open .asm file in VSCode
2. Set breakpoint on line
3. Launch ROM → hits breakpoint at correct location
4. Call stack shows function names + source lines
5. Step through source code

## .dbg Format Reference
```
; Mesen .dbg format
[Segments]
Bank0=$00:0000
Bank1=$01:0000
CPU=$00:8000

[Files]
0=source/main.asm
1=source/sub.asm

[Lines]
$8000,0,1     ; address, bank, line
$8003,0,2

[Spans]
$8000,$8010,1,0  ; start, end, file, line

[Symbols]
$8000=Reset
$8003=Initialize
```
