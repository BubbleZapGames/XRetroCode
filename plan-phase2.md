# Phase 2: Core Debugging Features

## Goal
Full stepping, breakpoints, disassembly, and proper break/resume flow.

## DAP Requests to Implement

### 9. Stepping
- `next` → Debugger::Step(cpu, count, StepType::StepOver)
- `stepIn` → Debugger::Step(cpu, count, StepType::Step)
- `stepOut` → Debugger::Step(cpu, count, StepType::StepOut)
- `pause` → Debugger::BreakImmediately()

### 10. Breakpoints
- `setBreakpoints` with address breakpoints
  - Extract address from `source.path` (hex format)
  - Call BreakpointManager::SetBreakpoints()
  - Map DAP breakpointId ↔ Mesen breakpoint ID
- `breakpointLocations` (optional)
  - Return address range for given source/line

### 11. Disassembly
- `disassemble` request
  - Call Disassembler::GetDisassemblyOutput(address, count)
  - Return array of `{address, instruction, bytes}`
  - Highlight current PC

### 12. Stopped Events
- Properly map `BreakEvent::Source` to DAP stopped reason:
  - `BreakSource::Breakpoint` → `"breakpoint"`
  - `BreakSource::Step` → `"step"`
  - `BreakSource::Pause` → `"pause"`
  - `BreakSource::Entry` → `"entry"`
- Send `allThreadsStopped: true`

## Implementation Details

### DAP Server Enhancements
- Store `BreakpointManager*` in DapServer
- Track breakpoints: `map<int, Breakpoint>` for DAP ↔ Mesen mapping
- Implement `setBreakpoints` handler:
  ```cpp
  void HandleSetBreakpointsRequest(const JsonValue& request) {
    // Parse source/line → address (for source breakpoints)
    // Or use address directly (for disassembly view)
    // Set breakpoint via BreakpointManager
    // Return {breakpoints: [{id, verified, line, column}, ...]}
  }
  ```

### Notification Listener
- Implement `ProcessNotification()` for CodeBreak:
  ```cpp
  void DapNotificationListener::ProcessNotification(ConsoleNotificationType type, void* parameter) {
    if(type == ConsoleNotificationType::CodeBreak) {
      BreakEvent* event = static_cast<BreakEvent*>(parameter);
      const char* reason = MapBreakSourceToReason(event->Source);
      SendStoppedEvent(reason, event->CpuType);
    }
  }
  ```

### Step Type Mapping
```cpp
StepType StepTypeFromDap(const string& command) {
  if(command == "stepIn") return StepType::Step;
  if(command == "next") return StepType::StepOver;
  if(command == "stepOut") return StepType::StepOut;
  if(command == "pause") return StepType::Step;  // Break on next instruction
}
```

## Files to Modify

1. **DapServer.cpp** - Add `setBreakpoints`, `disassemble`, `stepIn`, `next`, `stepOut`, `pause` handlers
2. **DapNotificationListener.cpp** - Full break notification handling
3. **DapServer.h** - Add breakpoint tracking, step type helpers
4. **GDB/DapMain.cpp** - Wire up notification listener properly

## Verification Steps

1. Launch ROM → breaks on entry
2. Set breakpoint by address in disassembly view
3. `continue` → hits breakpoint
4. `stepIn` / `next` / `stepOut` work correctly
5. `pause` interrupts running emulation

## Notes

- DAP `stepIn` = Mesen `StepType::Step` (single instruction)
- DAP `next` = Mesen `StepType::StepOver` (step over function call)
- DAP `stepOut` = Mesen `StepType::StepOut` (finish current function)
