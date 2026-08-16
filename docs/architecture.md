# Architecture

`vscode-pi` is a TUI companion, not a Pi frontend.

## Execution location

The extension is `extensionKind: ["ui"]` and therefore runs on the desktop machine in a normal VS Code Remote window. This is required for the local clipboard, microphone, and native transcription libraries.

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

1. `Ctrl+Alt+Z` starts official `pi-transcribe` microphone capture in the local extension host.
2. The selected transcribe.cpp GGUF model is prepared concurrently.
3. A second invocation stops capture and transcribes 16 kHz mono PCM locally.
4. Control characters and line breaks are removed from the transcript.
5. `Terminal.sendText(transcript, false)` inserts text into the same terminal that was focused when recording began.

No PCM or model data is sent to the workspace host.

## Native packaging

`pi-transcribe` depends on platform-native `pvrecorder` and `transcribe-cpp` artifacts. A VSIX must therefore be built on/for the desktop target platform. CI checks portable TypeScript on Linux and packages the distributable on `windows-latest`.

## Non-goals

- owning or proxying a Pi session;
- JSONL or CBOR Pi RPC;
- rendering conversations in a webview;
- replacing Pi's TUI, tools, sessions, extensions, or skills;
- submitting terminal input without an explicit user action.
