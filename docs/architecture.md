# Architecture

`vscode-pi` is a TUI companion, not a Pi frontend.

## Execution location

The extension is `extensionKind: ["ui"]` and therefore runs on the desktop machine in a normal VS Code Remote window. The UI extension owns clipboard access, status/model UI, and terminal insertion. It spawns a second process on that same desktop machine for microphone and transcription work; native addons are never loaded into the VS Code extension host.

Pi itself continues to run in the integrated terminal's environment:

- Windows locally;
- WSL;
- Remote-SSH;
- a Dev Container.

## Image path

1. The command reads the desktop clipboard and converts the image to PNG.
2. In a local window, the PNG is written to the local temporary directory.
3. In a remote window, the first remote workspace URI supplies the filesystem scheme and authority. `vscode.workspace.fs.writeFile()` writes `/tmp/vscode-pi-clipboard-<uuid>.png` through the registered remote filesystem provider.
4. `Terminal.sendText(path, false)` inserts the path at Pi's current editor cursor. Terminal context-menu invocations retain the selected terminal; keybindings use the active terminal.

Image input is bounded to 32 MiB. Generated paths reject terminal control characters without rewriting valid spaces, and no command submits the editor. Local files use mode `0600`. Remote permissions follow the remote filesystem provider/host umask because the VS Code filesystem API has no chmod operation. Attachments are deleted after 24 hours and stale files are collected on later pastes.

A WSL target means a Remote - WSL window. A `wsl.exe` profile in a local window does not expose a remote filesystem URI and is outside the supported transport.

## Dictation path

1. `Ctrl+Alt+Z` resolves the local model in the UI extension and sends a validated request to a local child process.
2. The child resolves the configured exact microphone name/occurrence, starts official `pi-transcribe` capture, and preloads the transcribe.cpp GGUF model while recording.
3. A second invocation asks the child to stop capture and transcribe its 16 kHz mono PCM. PCM never crosses IPC.
4. The UI extension validates the response, removes control characters and line breaks from the transcript, and calls `Terminal.sendText(transcript, false)` for the terminal that was focused when recording began.

Requests are serialized. A child error or exit rejects pending work, clears recording state/status, and permits a fresh helper on the next operation. Cancellation aborts transcription and force-terminates an unresponsive child after a bounded grace period. Extension shutdown first requests native cleanup, then force-kills the helper on a bounded timer. The helper also cleans up or exits if its parent IPC channel disappears.

The child is launched with the VS Code/Electron executable in Node mode (`ELECTRON_RUN_AS_NODE=1`), without inherited extension-host `execArgv`, and with its Windows console hidden. PCM buffers and loaded model state remain in the helper, and no audio or model data is sent to the workspace host; only device names, model configuration, control messages, and the final transcript cross local IPC.

## Native packaging

The build emits `dist/extension.js` and a separate bundled `dist/dictationHelper.js`. The official `pi-transcribe` deep import is compiled into the helper. Platform-native `@picovoice/pvrecorder-node` and `transcribe-cpp` remain external so their packaged native artifacts resolve normally. The Windows helper explicitly selects the CPU backend, and the Windows VSIX omits `ggml-vulkan.dll`; this avoids the Vulkan initialization path implicated by a native access violation during a real Remote-SSH smoke test. A VSIX must therefore be built on/for the desktop target platform. CI checks portable TypeScript on Linux and packages the distributable on `windows-latest`.

## Non-goals

- owning or proxying a Pi session;
- JSONL or CBOR Pi RPC;
- rendering conversations in a webview;
- replacing Pi's TUI, tools, sessions, extensions, or skills;
- submitting terminal input without an explicit user action.
