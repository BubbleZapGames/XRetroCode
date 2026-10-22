# XRetroCode

Source-level debugging of retro console games in VS Code, plus language support
for the [R65](https://github.com/BubbleZapGames/R65) compiler.

XRetroCode is a VS Code extension (`xretrocode/`) that drives
[Mesen-GDB](https://github.com/BubbleZapGames/Mesen-GDB) over the Debug Adapter
Protocol. Mesen-GDB runs the ROM on Mesen2's emulation core and maps addresses
back to source lines through the build's symbols (a cc65-format `.dbg`, or a
WLA-DX `.sym`). You set breakpoints in source, step, and inspect registers and
memory from the VS Code debugger. That works for R65 and for C (see
[Debugging C](#debugging-c)).

![Paused on a breakpoint in R65 source, with the 65816 registers, call stack and Debug Console](docs/debugging.png)

Mesen-GDB emulates NES, SNES, Game Boy, Game Boy Advance, PC Engine,
SMS/Game Gear and WonderSwan. SNES with R65 is the most complete path.

## Features

**Debugging**

- Launch a ROM. A workspace with a single ROM starts with no configuration,
  and a workspace with several shows a picker.
- Breakpoints in `.r65`, `.c` and assembly (`.s`, `.asm`, `.inc`) source,
  including conditional breakpoints evaluated by Mesen's expression engine
- Function breakpoints by name (**Run → New Breakpoint → Function
  Breakpoint**): a function, or any label in the symbol file. A C function
  matches with or without cc65's leading `_`.
- Step over, in and out, pause and continue. Each emulated CPU appears as its
  own thread.
- Registers, flags and memory in the Variables view, plus expression evaluation
  in the Debug Console
- Runs `make` before launching when the workspace has a makefile
- Headless mode with no game window, for CI and remote sessions
- **Go to Macro Definition** for macros on the stopped line. The debugger steps
  over macro expansions, so this takes you to their source.

**R65 language**

- Syntax highlighting
- Go to Definition, Find All References, hover, completion, the Outline view and
  workspace symbol search (Ctrl+T)
- `r65c` build and check tasks with a problem matcher
- Toolchain setup: opening an `.r65` file without `r65c` or WLA-DX offers to
  install them (below)

## Repository layout

| Path | Contents |
|---|---|
| `xretrocode/` | The VS Code extension (TypeScript) |
| `Mesen-GDB/` | Submodule: the emulator and its DAP server (C++) |

## Getting started

### 1. Get mesen-gdb

Download a build from
[Mesen-GDB releases](https://github.com/BubbleZapGames/Mesen-GDB/releases):

- **Linux** (`linux-x64.tar.gz`): needs SDL2 installed (`libsdl2-2.0-0` on
  Debian/Ubuntu).
- **Windows** (`windows-x64.zip`): a single self-contained `mesen-gdb.exe`.
- **macOS** (`macos-arm64.tar.gz` for Apple Silicon, `macos-x64.tar.gz` for
  Intel; macOS 11 or later): self-contained. The binary is unsigned, so clear
  the quarantine once after unpacking:

  ```bash
  tar -xzf mesen-gdb-*-macos-*.tar.gz
  xattr -d com.apple.quarantine mesen-gdb
  ```

Put `mesen-gdb` on your `PATH`, or set `xretrocode.mesenDapPath` to it.

The extension looks for `mesen-gdb` in this order:

1. `mesenDapPath` in `launch.json`
2. The `xretrocode.mesenDapPath` setting
3. A build under `Mesen-GDB/bin/linux-x64/{Release,Debug}/`, next to the
   workspace or the extension
4. `PATH`, then `/usr/local/bin`, `/usr/bin` and `~/.local/bin`

If none of these turns up a binary, the extension offers to download one or
lets you browse for it. It remembers the binary you pick.

### 2. Install the extension

Package it as a `.vsix` and install that:

```bash
cd xretrocode
npm install
npm run package                                # → xretrocode-0.2.0.vsix
code --install-extension xretrocode-0.2.0.vsix
```

You can also install it from the Extensions view: open the `...` menu and
choose **Install from VSIX...**. The package doesn't include `mesen-gdb`.
Install that separately, as described in step 1.

To run the extension in development, open `xretrocode/` in VS Code and press F5.

### 3. The R65 toolchain

Building R65 needs the `r65c` compiler and WLA-DX (`wla-65816`, `wlalink`).
When you open an `.r65` file and either is missing from `PATH`, the extension
offers to install it, running the
[setup guide](https://r65.dev/docs/getting-started/setup)'s commands in a
terminal:

- WLA-DX: `brew install wla-dx`. Without Homebrew it links to the
  [WLA-DX releases](https://github.com/vhelin/wla-dx/releases) instead; put
  `wla-65816` and `wlalink` on your `PATH`.
- R65: `pipx install git+https://github.com/BubbleZapGames/R65.git@release`,
  or `python3 -m pip install --user ...` (`py -m pip` on Windows) without pipx.

**Don't Ask Again** turns the prompt off; **XRetroCode: Install R65
Toolchain** in the Command Palette runs the install any time.

### 3. Debug a ROM

Open your game's folder and press F5. To pin the ROM or other options, add a
launch configuration:

```json
{
  "name": "Launch ROM",
  "type": "xretrocode",
  "request": "launch",
  "romPath": "${workspaceFolder}/build/game.sfc"
}
```

| Attribute | Default | Description |
|---|---|---|
| `romPath` | prompt | ROM to load. If empty or `${command:xretrocode.pickRom}`, you are prompted to choose one. |
| `dbgPath` | auto | Symbol file: a `.dbg` (R65, cc65) or a WLA-DX `.sym`. Defaults to the ROM name with `.dbg`, then with `.sym`, then `<rom dir>/main.dbg`. |
| `stopOnEntry` | `false` | Break at the entry point instead of running |
| `headless` | `false` | Run without the game window |
| `mesenDapPath` | auto | Path to `mesen-gdb`, overriding the setting |

The game window plays with your installed Mesen's settings: keys and gamepads,
video, audio and console options, from MesenCE or else Mesen2. Change them in
Mesen. For a portable Mesen, set `xretrocode.mesenFolder`. A `headless` session
uses built-in defaults. See
[Settings](https://github.com/BubbleZapGames/Mesen-GDB#settings) in Mesen-GDB.

## Debugging C

Any C project works if its build leaves three things: a Makefile (run before
each launch), a ROM, and a symbol file next to the ROM.

**cc65** (NES and other 6502 targets) gives full source-level debugging:
breakpoints in `.c` files, stepping one C statement at a time, and C function
names in the call stack. Build with debug info at every step:

```make
cc65 -g -t nes game.c -o game.s
ca65 -g -t nes game.s -o game.o
ld65 -C nes.cfg --dbgfile game.dbg -o game.nes game.o nes.lib
```

Step Into skips cc65's runtime helpers (`pusha`, `incsp2`, ...) and stops at
the next C line. Frames in code with no source on disk, like cc65's runtime
library, show their address and open in the disassembly view.

**816-tcc / PVSnesLib** (SNES): 816-tcc records no line numbers at all, so
no debugger can stop on a `.c` line in a PVSnesLib build. PVSnesLib's link
step writes `<rom>.sym` with every function's label, which this extension
loads by default: set a function breakpoint (**Run → New Breakpoint →
Function Breakpoint**) on a C function, and the call stack and disassembly
view show function names.

**ca65 on the SNES** (for example with [libSFX](https://github.com/Optiroc/libSFX))
gets breakpoints on assembly source lines from ld65's debug file. libSFX
writes it with `make debug=2`, as `<name>.dnfo`: point `dbgPath` at it.

### Assembly

An assembly-only project debugs the same way: build with `ca65 -g` and
`ld65 --dbgfile`, and set breakpoints on `.s` lines, step over and into
subroutines, and see each `.proc` named in the call stack. WLA-DX projects get
function breakpoints and named frames from their `.sym`.

The extension opens `.s`, `.asm` and `.inc` files as **Retro Assembly**, a
language with `;` comments and no highlighting, so the gutter takes
breakpoints. If you use an assembly extension for highlighting, associate the
files with its language instead (`files.associations`) and turn on
`debug.allowBreakpointsEverywhere` so breakpoints still work.

### Editing C

The extension doesn't add C highlighting or IntelliSense. VS Code highlights C
already, and [clangd](https://marketplace.visualstudio.com/items?itemName=llvm-vs-code-extensions.vscode-clangd)
or Microsoft's [C/C++ extension](https://marketplace.visualstudio.com/items?itemName=ms-vscode.cpptools)
does IntelliSense once it knows the toolchain's headers. These keep the host's
own headers out and give cc65's keywords a definition. For clangd, a `.clangd`
in the project root:

```yaml
# cc65 (NES)
CompileFlags:
  Add: [-ffreestanding, -nostdinc, -isystem, /path/to/cc65/include,
        -D__CC65__, -D__NES__, -D__fastcall__=, -D__cdecl__=, -D__near__=, -D__far__=]
Diagnostics:
  # cc65's headers declare drivers as `extern void name[]`, which clang rejects
  Suppress: [err_array_incomplete_or_sizeless_type]
```

```yaml
# PVSnesLib (SNES)
CompileFlags:
  Add: [-ffreestanding, -nostdinc, -isystem, /path/to/pvsneslib/include,
        -isystem, /path/to/devkitsnes/include]
```

For the C/C++ extension, the same in `.vscode/c_cpp_properties.json`:

```json
{
  "version": 4,
  "configurations": [{
    "name": "cc65",
    "compilerPath": "",
    "cStandard": "c89",
    "includePath": ["${workspaceFolder}/**", "/path/to/cc65/include"],
    "defines": ["__CC65__", "__NES__", "__fastcall__=", "__cdecl__=", "__near__=", "__far__="]
  }]
}
```

## Settings

| Setting | Default | Description |
|---|---|---|
| `xretrocode.mesenDapPath` | `""` | Path to `mesen-gdb` |
| `xretrocode.mesenFolder` | `""` | Folder of a portable Mesen's `settings.json`. Empty: MesenCE's, then Mesen2's, in their usual places |
| `xretrocode.buildBeforeLaunch` | `true` | Run `make` before each debug session when the folder has a makefile |
| `xretrocode.checkToolchain` | `true` | Offer to install `r65c` and WLA-DX when an `.r65` file is opened without them |
| `r65.compilerPath` | `r65c` | R65 compiler |
| `r65.includePaths` | `[]` | Extra include search paths |
| `r65.targetPlatform` | `snes` | `snes` or `nes` |
| `r65.cfgOptions` | `[]` | Conditional compilation options, e.g. `["snes", "debug"]` |

## Testing

```bash
cd xretrocode
npm test                      # unit tests against a mocked vscode API
xvfb-run -a npm run test:e2e  # real VS Code + mesen-gdb on Mesen-GDB's test ROMs
```

The e2e suite needs a built `mesen-gdb` (run `make` in `Mesen-GDB/`). It
downloads VS Code into `.vscode-test/` unless `VSCODE_EXECUTABLE` points at an
installed copy, e.g. `VSCODE_EXECUTABLE=/usr/share/code/code`.

Mesen-GDB's C++ tests, including the DAP server, run with `make test` in
`Mesen-GDB/`.

## License

Apache License 2.0. See [LICENSE](LICENSE).
