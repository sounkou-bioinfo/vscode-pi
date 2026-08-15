# Architecture

## Product boundary

`vscode-pi` is a frontend for Pi. Pi remains authoritative for agent state, model/provider behavior, sessions, tools, extensions, and skills. The VS Code extension owns presentation, IDE context, editor actions, and local/remote host placement.

The project does not emulate Pi prompts or maintain a second tool runtime.

## Host placement

The main extension declares `extensionKind: ["workspace"]`:

- local folder: extension and Pi run locally;
- Remote-SSH, WSL, or Dev Container: extension and Pi run in that workspace host;
- the sidebar webview still renders in the local VS Code window.

This gives Pi native filesystem/process access beside the workspace while VS Code carries UI messages across its existing authenticated remote channel.

## Backend transport

The workspace extension launches Pi without a shell:

```text
pi [configured arguments] --mode rpc
```

Requests and events use Pi's newline-delimited JSON RPC protocol over stdin/stdout. Stderr goes only to a dedicated VS Code output channel. The client bounds incomplete lines and rejects malformed protocol data rather than treating process output as UI markup.

## UI

The first UI is a dedicated Activity Bar webview rather than a VS Code Chat participant. This preserves Pi-specific controls—provider/model selection, thinking level, sessions, compaction, extension UI, and tool detail—without depending on another agent product's interaction contract.

The webview uses:

- `default-src 'none'` CSP;
- nonce-authorized scripts;
- `localResourceRoots` restricted to packaged media and bundles;
- structured messages validated at both sides;
- text rendering through DOM text nodes, never model-provided HTML.

A Chat Participant adapter can be added later as a thin second view over the same session service.

## Editor context

The extension host already has VS Code APIs, so it does not need an unauthenticated localhost SSE server. Context enters Pi explicitly and with bounds:

- active file URI and cursor;
- selected text only when requested or attached;
- diagnostics and open editors on demand;
- editor commands for reveal, diff, and apply workflows.

A bundled Pi extension or narrow RPC-side tool bridge may be introduced only where prompt attachments are insufficient.

## Dictation

A workspace extension cannot directly open a microphone attached to the local desktop when it runs under Remote-SSH. The existing `pi-transcribe` package opens `PvRecorder` in the Pi process host, so installing it remotely cannot solve that boundary.

The robust native-transcription design has two extension hosts:

1. a small companion extension declared `extensionKind: ["ui"]` captures and transcribes on the desktop;
2. it sends the resulting text through a registered VS Code command to this workspace extension;
3. only text crosses the VS Code remote channel.

VS Code chooses one host for a given extension, so the UI and workspace pieces must be separate extension IDs, shipped from this repository as an extension pack. Browser/WASM transcription inside the local webview remains a possible single-extension alternative, but is not assumed until microphone permissions, model execution, and offline behavior are proven across desktop platforms.

## Security

- Workspace trust is required.
- Pi is spawned directly, never through a shell.
- Remote mode resolves the Pi executable and working directory on the workspace host.
- No network listener is required for the core architecture.
- Secret/provider storage remains owned by Pi.
- Tool execution and approvals must remain visible and abortable.
- Dictation must default to local transcription and must not silently transmit audio.

## Milestones

1. RPC lifecycle, streaming chat, abort, new session, tests, and VSIX packaging.
2. Model/thinking/session controls and durable UI state.
3. Tool-call rendering, approvals, diffs, navigation, selections, and diagnostics.
4. Local dictation companion and extension pack.
5. Optional VS Code Chat participant adapter.
