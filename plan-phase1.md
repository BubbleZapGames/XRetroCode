# Phase 1 Implementation Plan: XRetroCode DAP Debug Adapter

## Context

XRetroCode enables real-time source-level debugging of retro console games through VSCode. Phase 1 delivers a minimal end-to-end debugging experience: launch an NES ROM from VSCode, see the game running in an SDL window with audio, break on entry, inspect CPU registers and flags, continue execution, and disconnect.

The `mesen-dap` binary is a standalone C++ executable with **full SDL window and audio** (not headless). The user sees the game running while debugging from VSCode.

## Architecture

```
┌──────────────┐    stdin/stdout     ┌──────────────────────────────────────┐
│   VSCode     │◄──── DAP JSON ────►│  mesen-dap (SDL window + audio)      │
│  Extension   │   (Content-Length   │                                      │
│  (TypeScript)│    framed)          │  Main Thread: DapServer::Run()       │
└──────────────┘                     │    reads stdin, writes stdout        │
                                     │                                      │
                                     │  Emu Thread: Emulator::Run()         │
                                     │    spawned by LoadRom()              │
                                     │                                      │
                                     │  Video Thread: VideoRenderer →       │
                                     │    DapRenderer (SDL_Window)          │
                                     │                                      │
                                     │  Audio: SDL callback thread          │
                                     │    SdlSoundManager ring buffer       │
                                     └──────────────────────────────────────┘
```

## Files to Create/Modify

All paths relative to `Mesen-GDB/` for C++ files, repo root for extension.

### Layer 1: JSON Infrastructure

**`Core/Debugger/DAP/DapJson.h`** (~120 lines)
- Move-only `JsonValue` class with type discriminant (Object, Array, String, Number, Bool, Null)
- Object stored as `vector<pair<string, JsonValue>>` (preserves insertion order)
- Static builders: `JsonValue::MakeObject()`, `JsonValue::MakeArray()`
- Mutation: `.Set(key, value)` for objects, `.Push(value)` for arrays
- Access: `.Get(key)`, `.operator[](key)`, `.GetBool()`, `.GetInt()`, `.GetString()`
- `string Serialize() const` — compact JSON output
- Free function `optional<JsonValue> ParseJson(const string& input)`

**`Core/Debugger/DAP/DapJson.cpp`** (~280 lines)
- Recursive-descent parser: `ParseValue` → `ParseObject`/`ParseArray`/`ParseString`/`ParseNumber`/`ParseLiteral`
- String escaping: `\"`, `\\`, `\/`, `\n`, `\t`, `\r`, `\b`, `\f`, `\uXXXX`
- Serializer: compact JSON, numbers as integer when whole else `%.17g`

### Layer 2: Protocol Framing

**`Core/Debugger/DAP/DapTypes.h`** (~50 lines)
- Namespace `DapCommand` — string constants: `"initialize"`, `"launch"`, `"configurationDone"`, `"threads"`, `"stackTrace"`, `"scopes"`, `"variables"`, `"continue"`, `"pause"`, `"disconnect"`
- Namespace `DapEvent` — `"initialized"`, `"stopped"`, `"continued"`, `"terminated"`, `"exited"`
- Namespace `DapStoppedReason` — `"entry"`, `"breakpoint"`, `"step"`, `"pause"`
- `enum class ScopeType : uint16_t { Registers = 1, Flags = 2 }` for variable reference encoding

**`Core/Debugger/DAP/DapMessageReader.h`** + **`.cpp`** (~85 lines total)
- `DapMessageReader(FILE* input = stdin)`
- `optional<JsonValue> ReadMessage()` — blocking: reads `Content-Length: N\r\n\r\n` header, then N bytes, returns `ParseJson()` result; `nullopt` on EOF

**`Core/Debugger/DAP/DapMessageWriter.h`** + **`.cpp`** (~45 lines total)
- `DapMessageWriter(FILE* output = stdout)`
- `void SendMessage(JsonValue&& message)` — `SimpleLock`-protected: serialize, write `Content-Length: N\r\n\r\n{json}`, `fflush()`

### Layer 3: CPU State & Notification Bridge

**`Core/Debugger/DAP/CpuStateSerializer.h`** + **`.cpp`** (~120 lines total)
- `static JsonValue SerializeRegisters(CpuType, BaseState&)` — returns JSON array of `{name, value, type}` Variable objects
- `static JsonValue SerializeFlags(CpuType, BaseState&)` — individual flag variables
- Phase 1: NES only. Cast to `NesCpuState`, emit A/X/Y/SP/PC/P (hex-formatted) + individual N/V/D/I/Z/C flag booleans
- Uses `PSFlags` enum from `Core/NES/NesTypes.h` for bit extraction

**`Core/Debugger/DAP/DapNotificationListener.h`** (~25 lines, header-only declaration)
- Implements `INotificationListener`
- `ProcessNotification()` — on `CodeBreak`: casts `parameter` to `BreakEvent*`, maps `BreakEvent::Source` to DAP stopped reason, calls `_server->SendStoppedEvent(reason, cpuType)`
- Thread safety: called on emulation thread (blocked in `SleepUntilResume()`); stdout write protected by `DapMessageWriter`'s `SimpleLock`

### Layer 4: DAP Server & Renderer

**`Core/Debugger/DAP/DapServer.h`** (~60 lines)
- Constructor takes `Emulator*`
- `void Run()` — main blocking message loop
- `void SendStoppedEvent(const char* reason, CpuType)` — called from notification listener
- Private handlers: `HandleInitialize`, `HandleLaunch`, `HandleConfigurationDone`, `HandleThreads`, `HandleStackTrace`, `HandleScopes`, `HandleVariables`, `HandleContinue`, `HandlePause`, `HandleDisconnect`
- `atomic<int> _seq` for thread-safe sequence counter
- Helper: `CpuTypeToThreadId()` / `ThreadIdToCpuType()` — maps `(int)CpuType + 1` ↔ DAP threadId

**`Core/Debugger/DAP/DapServer.cpp`** (~450 lines)

Handler details:
- **`HandleInitialize`**: Respond with capabilities (`supportsConfigurationDoneRequest: true`), send `initialized` event
- **`HandleLaunch`**: Extract `romPath`/`stopOnEntry` from args. Set `EmulationFlags::ConsoleMode`. Call `_emu->LoadRom()`. Enable debugger flags via `SetDebuggerFlag()` for each active `CpuType`. If `stopOnEntry`: call `debugger->Step(mainCpu, 1, StepType::Step)` to break on first instruction
- **`HandleConfigurationDone`**: Mark ready, respond success
- **`HandleThreads`**: `_emu->GetCpuTypes()` → map each to `{id: (int)cpu+1, name: "NES CPU"}`
- **`HandleStackTrace`**: Map threadId→CpuType, get PC via `debugger->GetProgramCounter(cpu, true)`, return single frame `{id:1, name:"0xNNNN", line:0, column:0}`
- **`HandleScopes`**: Return two scopes: "Registers" and "Flags" with encoded `variablesReference = (frameId << 16) | scopeType`
- **`HandleVariables`**: Decode variablesReference, get CPU state via `DebuggerRequest` + `GetCpuState()`, call `CpuStateSerializer::SerializeRegisters/SerializeFlags`
- **`HandleContinue`**: `debugger->Run()` → returns `{allThreadsContinued: true}`
- **`HandlePause`**: `debugger->Step(cpu, 1, StepType::Step, BreakSource::Pause)` to break on next instruction
- **`HandleDisconnect`**: `_emu->Stop(true)`, set exit flag

Key Mesen break/resume flow:
1. Emulation thread hits break → `SleepUntilResume()` sets `_waitForBreakResume = true`, sends `CodeBreak` notification with `BreakEvent*`, blocks in while loop
2. Our `DapNotificationListener` receives `CodeBreak` on emulation thread → sends DAP `stopped` event via `DapMessageWriter`
3. DAP main thread reads `continue` request → calls `Debugger::Run()` which sets `_waitForBreakResume = false` → emulation thread wakes up

Critical: Must call `_emu->GetSettings()->SetDebuggerFlag(DebuggerFlags::NesDebuggerEnabled, true)` after ROM load. Without this, `Debugger::IsDebugWindowOpened()` returns false and `BreakImmediately()` / step-to-break silently does nothing. (See `Debugger.cpp:777-793`, `SettingTypes.h:1085-1100`)

**`Core/Debugger/DAP/DapRenderer.h`** + **`.cpp`** (~160 lines total)
- Implements `IRenderingDevice` — same interface as `Sdl/SdlRenderer.h`
- Takes `SDL_Window*` from DapMain (NOT `void* windowHandle` like SdlRenderer)
- Creates `SDL_Renderer` and `SDL_Texture` internally
- `OnRendererThreadStarted()` → `Reset()` → recreates `SDL_Renderer` on new thread (required by SDL, same pattern as `SdlRenderer.cpp:125-141`)
- `UpdateFrame()` — copies frame buffer under `SimpleLock`
- `Render()` — uploads texture, `SDL_RenderCopy`, `SDL_RenderPresent`
- No HUD overlay textures (simplified from SdlRenderer)

### Layer 5: Entry Point & Build

**`DapMain/DapMain.cpp`** (~80 lines)
```
main():
  1. SDL_Init(SDL_INIT_VIDEO | SDL_INIT_AUDIO | SDL_INIT_GAMECONTROLLER)
  2. FolderUtilities::SetHomeFolder("~/.config/mesen-dap")
  3. Emulator emu; emu.Initialize(false)  // false = no shortcut handler
  4. SDL_CreateWindow("XRetroCode - Mesen DAP", 512, 480, SHOWN|RESIZABLE)
  5. DapRenderer renderer(&emu, window)   // registers with VideoRenderer
  6. SdlSoundManager sound(&emu)          // registers with SoundMixer
  7. LinuxKeyManager keys(&emu)           // gamepad input via libevdev
  8. emu.GetSettings()->SetFlag(EmulationFlags::ConsoleMode)
  9. DapServer server(&emu); server.Run() // blocks on stdin
  10. Cleanup: emu.Stop(), emu.Release(), SDL_DestroyWindow, SDL_Quit
```
- All diagnostic output → stderr (stdout reserved for DAP)
- SDL window stays open while debugging; game renders in real-time
- Window cannot be closed via X button (main thread blocked on stdin); user disconnects via VSCode

**`makefile` modification** — Add after `pgohelper` target (~10 lines added):
```makefile
DAPSRC := $(shell find DapMain -name '*.cpp')
DAPOBJ := $(DAPSRC:.cpp=.o)

dap: $(SEVENZIPOBJ) $(LUAOBJ) $(UTILOBJ) $(COREOBJ) $(SDLOBJ) $(LIBEVDEVOBJ) $(LINUXOBJ) $(DAPOBJ)
	mkdir -p bin
	$(CXX) $(CXXFLAGS) $(LINKOPTIONS) -o bin/mesen-dap $(DAPOBJ) $(SEVENZIPOBJ) $(LUAOBJ) $(LINUXOBJ) $(LIBEVDEVOBJ) $(UTILOBJ) $(SDLOBJ) $(COREOBJ) -pthread $(FSLIB) $(SDL2LIB) $(LIBEVDEVLIB) $(X11LIB)
```
- No `-shared` (executable, not .so), no `$(DLLOBJ)` (InteropDLL not needed)
- `$(COREOBJ)` auto-includes `Core/Debugger/DAP/*.o` via `find Core -name '*.cpp'`
- Add `$(DAPOBJ)` and `bin/mesen-dap` to `clean` target

### Layer 6: VSCode Extension

**`xretrocode-debug/package.json`** (~80 lines)
- `contributes.debuggers`: type `"xretrocode"`, label `"XRetroCode"`
- `configurationAttributes.launch`: `romPath` (required string), `stopOnEntry` (bool, default true), `mesenDapPath` (optional string)
- `initialConfigurations` + `configurationSnippets` for NES ROM
- `contributes.configuration`: `xretrocode.mesenDapPath` setting
- devDependencies: `@types/vscode`, `typescript`

**`xretrocode-debug/tsconfig.json`** — Standard: `module: commonjs`, `target: ES2020`, `outDir: out`, `strict: true`

**`xretrocode-debug/src/extension.ts`** (~15 lines) — Registers `DebugAdapterDescriptorFactory` for type `"xretrocode"`

**`xretrocode-debug/src/debugAdapter.ts`** (~40 lines) — `DapAdapterFactory` creates `DebugAdapterExecutable` pointing to `mesen-dap` binary (from config, PATH, or known locations)

**`xretrocode-debug/src/configuration.ts`** (~30 lines) — `DebugConfigurationProvider` resolves/validates launch configs

**`xretrocode-debug/.vscode/launch.json`** — Extension development config (F5 launches Extension Host)

## Implementation Order

| Step | File | Est. Lines |
|------|------|-----------|
| 1 | `Core/Debugger/DAP/DapJson.h` | 120 |
| 2 | `Core/Debugger/DAP/DapJson.cpp` | 280 |
| 3 | `Core/Debugger/DAP/DapTypes.h` | 50 |
| 4 | `Core/Debugger/DAP/DapMessageReader.h` + `.cpp` | 85 |
| 5 | `Core/Debugger/DAP/DapMessageWriter.h` + `.cpp` | 45 |
| 6 | `Core/Debugger/DAP/CpuStateSerializer.h` + `.cpp` | 120 |
| 7 | `Core/Debugger/DAP/DapNotificationListener.h` | 25 |
| 8 | `Core/Debugger/DAP/DapServer.h` | 60 |
| 9 | `Core/Debugger/DAP/DapServer.cpp` | 450 |
| 10 | `Core/Debugger/DAP/DapRenderer.h` + `.cpp` | 160 |
| 11 | `DapMain/DapMain.cpp` | 80 |
| 12 | `makefile` (modify) | +10 |
| 13-17 | `xretrocode-debug/` (5 files) | 180 |

**Total: ~1,665 lines across 17 new files + 1 modified file**

## Thread Safety

| Operation | Thread | Protection |
|---|---|---|
| Read stdin (DAP requests) | Main | Single reader |
| Write stdout (responses) | Main | DapMessageWriter SimpleLock |
| Write stdout (events) | Emulation (via notification) | DapMessageWriter SimpleLock |
| `_seq` counter | Main + Emulation | `atomic<int>` |
| Debugger API calls | Main | `DebuggerRequest` RAII (`Emulator::GetDebugger(true)`) |
| CPU state reads | Main (emu paused) | Emulation blocked in `SleepUntilResume` |
| Frame buffer | Video + Emulation | DapRenderer `_frameLock` SimpleLock |

## Critical Reference Files

- `Core/Debugger/Debugger.cpp:466-525` — `SleepUntilResume()`: sends `CodeBreak` notification, blocks emulation thread
- `Core/Debugger/Debugger.cpp:673-682` — `Run()`: sets `_waitForBreakResume = false`, unblocks emulation
- `Core/Debugger/Debugger.cpp:707-731` — `Step()`: sets up step request then unblocks emulation
- `Core/Debugger/Debugger.cpp:777-796` — `IsDebugWindowOpened()`: checks `DebuggerFlags` per CpuType
- `Core/Shared/Emulator.cpp:362-541` — `LoadRom()`: spawns emulation thread, auto-inits debugger with `ConsoleMode` flag
- `Core/Shared/SettingTypes.h:1085-1100` — `DebuggerFlags` enum (one flag per CpuType)
- `Core/NES/NesTypes.h` — `NesCpuState` struct (PC, SP, A, X, Y, PS, CycleCount)
- `Core/Shared/CpuType.h` — `CpuType` enum (Nes=8, etc.)
- `InteropDLL/EmuApiWrapper.cpp:80-126` — Reference for SDL/renderer/sound initialization sequence
- `Sdl/SdlRenderer.cpp` — Reference for `IRenderingDevice` implementation

## Verification

```bash
# Build
cd Mesen-GDB && make dap -j$(nproc) DEBUG=1

# Smoke test (send initialize, expect JSON response)
printf 'Content-Length: 95\r\n\r\n{"seq":1,"type":"request","command":"initialize","arguments":{"adapterID":"xretrocode"}}' \
  | timeout 5 ./bin/mesen-dap 2>/dev/null

# Build extension
cd xretrocode-debug && npm install && npm run compile

# Full test: Open xretrocode-debug/ in VSCode → F5 → create launch.json with romPath → F5
# Expected: SDL window opens with game → VSCode stops on entry → registers panel shows A,X,Y,SP,PC,P → continue resumes
```
