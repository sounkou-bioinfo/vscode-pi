# vscode-pi

A native VS Code frontend for the [Pi coding agent](https://pi.dev).

> Early foundation: the first milestone is an end-to-end sidebar backed by Pi's JSONL RPC mode. It is not yet published to the VS Code Marketplace.

## Why

Pi already provides the agent runtime, model/provider support, sessions, tools, extensions, and skills. This project makes those capabilities available through VS Code without reimplementing the agent.

Unlike `vscode-pi-companion`, which bridges editor context into a separate Pi terminal session over SSE/MCP, `vscode-pi` owns a Pi RPC session and presents it directly in VS Code.

## Architecture

```text
VS Code renderer                     Workspace extension host
(local desktop)                      (remote under Remote-SSH/WSL)

Pi sidebar webview  <--- VS Code --->  vscode-pi extension
                                            |
                                            | JSONL over stdio
                                            v
                                      pi --mode rpc
```

Declaring the extension as `workspace` makes the backend and Pi process run beside the checked-out repository. VS Code transports webview messages between the local renderer and the remote extension host.

See [`docs/architecture.md`](docs/architecture.md) for the frontend, editor-context, approvals, and dictation plan.

## Development

Requirements:

- Node.js 22+
- VS Code 1.100+
- `pi` installed in the extension host (`pi` must also be installed remotely for Remote-SSH)

```sh
npm install
npm run check
```

Press `F5` in VS Code to launch the Extension Development Host.

## Scope

The intended endpoint is a real Pi frontend, not another independent agent implementation:

- streaming Pi conversations and tool calls
- Pi model, thinking, session, extension, and skill support
- workspace selections, diagnostics, diffs, and navigation
- explicit approvals and trust boundaries
- Remote-SSH, WSL, and Dev Containers
- local dictation that sends text—not microphone audio—to the workspace host
- an optional VS Code Chat participant adapter after the native Pi view is solid

## License

MIT.
