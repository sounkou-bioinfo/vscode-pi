# Changelog

## 0.1.2

- Select the CPU transcription backend on Windows and omit the optional Vulkan module after a real Remote-SSH smoke test exposed a native `0xC0000005` access violation immediately after capture while automatic model initialization began.
- Preserve native-helper phase diagnostics so any remaining process crash identifies whether capture, runtime loading, or model loading was active.

## 0.1.1

- Isolate native microphone capture, model loading, and transcription in a local helper process so failures cannot terminate VS Code's UI extension host or its Remote-SSH connection.
- Recover cleanly from helper crashes and hangs, with bounded cancellation, shutdown, and control-request timeouts.
- Add non-native IPC regression tests for serialization, crash recovery, timeout recovery, and forced shutdown.

## 0.1.0

- Pivot from an RPC sidebar to a local companion for Pi's existing terminal TUI.
- Add local clipboard-image transfer into local, WSL, Remote-SSH, and Dev Container terminals.
- Add local microphone capture and transcription using the official `pi-transcribe` capture/runtime stack.
- Insert image paths and transcripts without submitting terminal input.
- Run as a VS Code UI extension so local devices remain available in remote windows.

## 0.0.2

- Add `Pi: Open` and a stable `vscode-pi.vsix` package name.
- Document source and Remote-SSH installation.

## 0.0.1

- Initial experimental Pi RPC sidebar.
