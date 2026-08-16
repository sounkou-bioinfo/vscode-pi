# vscode-pi

<!-- README.md is generated from README.Rmd. Edit README.Rmd and run `npm run render:readme`. -->

A local-input companion for the [Pi coding agent](https://pi.dev) TUI running in VS Code's integrated terminal.

`vscode-pi` does **not** replace Pi with a sidebar or start a second agent. It lets the existing Pi TUI receive a Windows clipboard image or local microphone transcript when the terminal itself is running in Windows, WSL, Remote-SSH, or a Dev Container.

## What it does

With the terminal running Pi focused:

| Action | Default shortcut | Result |
|---|---|---|
| Paste clipboard image | `Ctrl+Alt+V` | Copies the local image to the Pi host and inserts its path at the TUI cursor |
| Start/stop dictation | `Ctrl+Alt+Z` | Records and transcribes locally, then inserts text at the TUI cursor |

Neither command presses Enter. You can inspect or edit the inserted path/transcript before submitting it to Pi.

## Architecture

```text
Windows VS Code UI extension
  ├─ reads the Windows image clipboard
  ├─ records the Windows microphone
  └─ transcribes with the pi-transcribe engine
                 │
                 │ VS Code filesystem + terminal APIs
                 ▼
Pi TUI in local / WSL / SSH / container terminal
  ├─ receives a host-visible temporary image path
  └─ receives transcript text
```

The extension declares `extensionKind: ["ui"]`, so attached devices and the clipboard are accessed on the machine displaying VS Code. VS Code's remote filesystem provider writes clipboard images to `/tmp` on the workspace host. `Terminal.sendText(..., false)` inserts the resulting path or transcript into the active terminal without submitting it.

There is no Pi RPC backend, webview, session database, or alternative conversation UI.

## Install

The extension is not yet on the VS Code Marketplace. Install the Windows build from **Windows PowerShell**, not a WSL or Remote-SSH terminal:

```powershell
Invoke-WebRequest `
  https://github.com/sounkou-bioinfo/vscode-pi/releases/latest/download/vscode-pi-win32-x64.vsix `
  -OutFile vscode-pi-win32-x64.vsix
code --install-extension .\vscode-pi-win32-x64.vsix --force
```

To build from source, run the following on the machine that displays VS Code. Native dictation dependencies make the resulting VSIX platform-specific.

```powershell
# Node.js 22+ is required for the build.
git clone https://github.com/sounkou-bioinfo/vscode-pi
cd vscode-pi
npm ci
npm run vsce:package
code --install-extension .\vscode-pi.vsix --force
```

Then run **Developer: Reload Window**. In a remote window, **Developer: Show Running Extensions** should list **Pi TUI Companion** under local extensions.

A Windows VSIX is also produced by CI as the `vscode-pi-win32-x64` artifact.

## Paste an image into Pi

1. Copy an image or take a Windows screenshot with `Win+Shift+S`.
2. Focus the VS Code terminal containing Pi's TUI.
3. Press `Ctrl+Alt+V`, or run **Pi: Paste Clipboard Image into Terminal**.
4. The extension writes a PNG to the Pi host and inserts the host path into Pi's editor.

For WSL, Remote-SSH, and Dev Containers, open a folder on that host first. The remote folder URI supplies the authority used to write `/tmp/vscode-pi-clipboard-*.png` through VS Code. Here, WSL means a VS Code window opened with **Remote - WSL**; a `wsl.exe` shell inside an otherwise local VS Code window has no remote filesystem URI and is not supported by the bridge.

Attachments are deleted after 24 hours, and stale files are collected on the next paste. Local files are created with mode `0600`; VS Code's remote filesystem API does not expose `chmod`, so remote file permissions follow the remote host's umask. The random UUID filename reduces discovery but does not replace an appropriately private remote environment.

Pi already supports image clipboard access by itself when Pi and the clipboard are on the same machine. This command provides one consistent shortcut and handles the remote boundary.

## Dictate into Pi

1. Focus the terminal containing Pi.
2. Press `Ctrl+Alt+Z` to start recording.
3. Speak, then press `Ctrl+Alt+Z` again.
4. The transcript is inserted into Pi's editor without being submitted.

Capture uses the official [`pi-transcribe`](https://github.com/earendil-works/pi-transcribe) `MicrophoneCapture` implementation and its `transcribe-cpp` runtime. Audio, model loading, and transcription stay in the local VS Code extension host; only transcript text reaches WSL or the remote machine.

On first use, the extension tries the local `~/.pi/agent/pi-transcribe.json`. If no usable local configuration exists, choose either:

- download **Canary 180M Flash** from the verified official `pi-transcribe` catalog (208 MiB); or
- select an existing transcribe.cpp GGUF model.

Commands:

- **Pi: Select Dictation Microphone**
- **Pi: Configure Dictation Model**
- **Pi: Start/Stop Dictation**

The recording status is shown in the VS Code status bar. Recordings are capped at five minutes by default.

## Settings

| Setting | Default | Meaning |
|---|---:|---|
| `vscodePi.dictation.modelPath` | empty | Local GGUF model path |
| `vscodePi.dictation.language` | `en` | Language passed to the model; empty enables model detection |
| `vscodePi.dictation.microphone` | empty | Exact local device name; empty uses the system default |
| `vscodePi.dictation.microphoneOccurrence` | `0` | Disambiguates duplicate device names; normally set by the microphone picker |
| `vscodePi.dictation.maxRecordingSeconds` | `300` | Maximum recording duration |

Shortcuts can be changed through **Preferences: Open Keyboard Shortcuts**.

## Development

Requirements:

- Node.js 22+
- VS Code 1.109+

```sh
npm ci
npm run check
```

Press `F5` to launch an Extension Development Host. Test native dictation on the target desktop platform; Linux CI validates source/tests, while Windows CI packages the Windows native runtime.

`README.Rmd` is authoritative. Regenerate `README.md` with:

```sh
npm run render:readme
```

## License

MIT. The dictation integration consumes the MIT-licensed official `pi-transcribe` package pinned to an immutable upstream commit.
