# Phase 4: Rich Features

## Goal
Full variable inspection, memory access, expression evaluation, multi-CPU support.

## DAP Requests to Implement

### Expression Evaluation
- `evaluate` request
  - `expression`: Mesen expression syntax (e.g., "A+X", "$8000", "GetHealth()")
  - `context`: "watch", "repl", "hover"
  - Use ExpressionEvaluator::EvaluateExpression()
  - Return value format: `{result, type, variablesReference}`

### Memory Access
- `readMemory` request
  - Call MemoryDumper::GetMemoryValues(address, count, memoryType)
  - Return base64-encoded bytes or hex string
  - Support offset adjustment
- `writeMemory` request
  - Write bytes to memory
  - Validate boundaries
  - Optional verify

### Variable Inspection
- Enhanced `variables` response
  - Nested objects/arrays via `variablesReference`
  - Type information in variable display
  - Memory view for pointers

### Conditional Breakpoints
- `condition` in `setBreakpoints`
  - Pass to MessageManager::EvaluateExpression()
  - Break only if condition evaluates to non-zero
  - Use Mesen's expression evaluator

### Call Stack
- Full call stack with:
  - Function names from LabelManager/SymbolManager
  - NMI/IRQ/Reset frame annotations
  - Stack frame ID hierarchy
  - Local variables per frame

### Multiple CPU Support
- Report all active CPUs as DAP threads
- `threads` returns: `{id, name, name: "SNES CPU"}, {id, name, name: "SPC700"}`
- Per-CPU state serialization
- Select current thread via `setContext`

## Implementation Details

### Expression Evaluator
- Mesen has `ExpressionEvaluator` class per CPU
- Parse expression string → AST → evaluate
- Return values: integer, float, string, boolean
- Variable references for complex objects

### Memory Access Pattern
```cpp
// Read 16 bytes from $7E0000 (SNES WRAM)
MemoryType memType = ConsoleInfo::GetCpuMemoryType(cpu);
auto values = MemoryDumper::GetMemoryValues(address, count, memType);
// Return as base64 or hex array
```

### Variable References
- Encode scope in `variablesReference`:
  - `frameId << 16 | scopeType` (Registers=1, Flags=2)
  - Nested objects use increasing refs
  - Managed map: `map<int, VariableData>`

### Multi-CPU Implementation
1. Enumerate all active CPU types from Emulator
2. For each CPU, create thread entry
3. Per-CPU state: each `variables` request specifies threadId
4. Break/resume affects all threads (allThreadsContinued: true)

## Files to Add/Modify

### New Files
1. **ExpressionEvaluator.h/cpp** - DAP-facing wrapper
2. **MemoryAccess.h/cpp** - readMemory/writeMemory handlers
3. **VariableManager.h/cpp** - variable references, nested access

### Modify
1. **DapServer.cpp** - add evaluate, readMemory, writeMemory handlers
2. **CpuStateSerializer.cpp** - per-CPU serialization (GB, GBA, PCE, SMS, WS)
3. **DapTypes.h** - add variable type enum

## Verification
1. Evaluate expressions in watch window
2. Read/write memory from debug console
3. Set conditional breakpoint (e.g., "A==5")
4. Full call stack with function names
5. Multi-CPU debugging (SNES + SPC700)
