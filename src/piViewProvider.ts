import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import * as vscode from "vscode";
import { PiRpcClient } from "./core/piRpcClient.js";
import { isJsonObject, type JsonObject } from "./core/rpcProtocol.js";
import {
	parseWebviewMessage,
	type HostToWebviewMessage,
} from "./core/uiProtocol.js";

export class PiViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
	static readonly viewType = "vscodePi.chat";

	private view: vscode.WebviewView | undefined;
	private client: PiRpcClient | undefined;
	private clientDisposers: Array<() => void> = [];
	private connectionState: "stopped" | "starting" | "ready" | "busy" = "stopped";

	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly output: vscode.OutputChannel,
	) {}

	resolveWebviewView(view: vscode.WebviewView): void {
		this.view = view;
		view.webview.options = {
			enableScripts: true,
			localResourceRoots: [
				vscode.Uri.joinPath(this.extensionUri, "dist"),
				vscode.Uri.joinPath(this.extensionUri, "media"),
			],
		};
		view.webview.html = this.renderHtml(view.webview);
		view.webview.onDidReceiveMessage((value: unknown) => {
			void this.handleWebviewMessage(value);
		});
		view.onDidDispose(() => {
			if (this.view === view) this.view = undefined;
		});
	}

	async start(): Promise<void> {
		if (this.client?.running) return;
		if (!vscode.workspace.isTrusted) {
			this.send({ type: "error", message: "Trust this workspace before starting Pi." });
			return;
		}

		const folder = vscode.workspace.workspaceFolders?.[0];
		if (folder && folder.uri.scheme !== "file") {
			this.send({ type: "error", message: "Pi requires a filesystem-backed workspace." });
			return;
		}
		const cwd = folder?.uri.fsPath ?? homedir();
		const config = vscode.workspace.getConfiguration("vscodePi");
		const executable = config.get<string>("executablePath", "pi").trim() || "pi";
		const additionalArguments = config.get<string[]>("additionalArguments", []);

		this.setConnection("starting", `Starting Pi in ${cwd}`);
		const client = new PiRpcClient({
			executable,
			arguments: additionalArguments,
			cwd,
			log: (message) => this.output.appendLine(message),
		});
		this.replaceClient(client);
		try {
			client.start();
			const response = await client.request<{ model?: unknown; sessionName?: unknown }>({
				type: "get_state",
			});
			if (this.client !== client) {
				await client.stop();
				return;
			}
			this.setConnection("ready");
			this.sendSession(response.data);
		} catch (error) {
			if (this.client !== client) {
				await client.stop();
				return;
			}
			this.reportError(error);
			this.replaceClient(undefined);
			await client.stop();
			this.setConnection("stopped");
		}
	}

	async restart(): Promise<void> {
		await this.stop();
		await this.start();
	}

	async stop(): Promise<void> {
		const client = this.client;
		this.replaceClient(undefined);
		await client?.stop();
		this.setConnection("stopped");
	}

	async abort(): Promise<void> {
		if (!this.client?.running) return;
		try {
			await this.client.request({ type: "abort" });
		} catch (error) {
			this.reportError(error);
		}
	}

	async newSession(): Promise<void> {
		await this.ensureStarted();
		if (!this.client) return;
		try {
			await this.client.request({ type: "new_session" });
			const state = await this.client.request<{ model?: unknown; sessionName?: unknown }>({
				type: "get_state",
			});
			this.sendSession(state.data);
			this.setConnection("ready");
		} catch (error) {
			this.reportError(error);
		}
	}

	dispose(): void {
		void this.stop();
	}

	private async handleWebviewMessage(value: unknown): Promise<void> {
		const message = parseWebviewMessage(value);
		if (!message) {
			this.output.appendLine("Ignored malformed webview message");
			return;
		}
		switch (message.type) {
			case "ready":
				this.setConnection(this.connectionState);
				if (vscode.workspace.getConfiguration("vscodePi").get("autoStart", true)) {
					await this.start();
				}
				break;
			case "prompt":
				await this.prompt(message.text);
				break;
			case "abort":
				await this.abort();
				break;
			case "newSession":
				await this.newSession();
				break;
		}
	}

	private async prompt(text: string): Promise<void> {
		await this.ensureStarted();
		if (!this.client) return;
		this.setConnection("busy");
		try {
			await this.client.request({ type: "prompt", message: text });
		} catch (error) {
			this.reportError(error);
			this.setConnection("ready");
		}
	}

	private async ensureStarted(): Promise<void> {
		if (!this.client?.running) await this.start();
	}

	private replaceClient(client: PiRpcClient | undefined): void {
		for (const dispose of this.clientDisposers) dispose();
		this.clientDisposers = [];
		this.client = client;
		if (!client) return;
		this.clientDisposers.push(
			client.onEvent((event) => {
				void this.handleRpcEvent(client, event).catch((error: unknown) =>
					this.reportError(error),
				);
			}),
			client.onExit((error) => {
				if (this.client !== client) return;
				this.client = undefined;
				this.setConnection("stopped");
				if (error) this.reportError(error);
			}),
		);
	}

	private async handleRpcEvent(client: PiRpcClient, event: JsonObject): Promise<void> {
		switch (event.type) {
			case "message_update": {
				const update = event.assistantMessageEvent;
				if (
					isJsonObject(update) &&
					update.type === "text_delta" &&
					typeof update.delta === "string"
				) {
					this.send({ type: "assistantDelta", text: update.delta });
				}
				break;
			}
			case "message_end":
			case "turn_end":
				this.send({ type: "assistantEnd" });
				break;
			case "agent_settled":
				this.setConnection("ready");
				break;
			case "tool_execution_start":
				if (
					typeof event.toolCallId === "string" &&
					typeof event.toolName === "string"
				) {
					this.send({
						type: "toolStart",
						id: event.toolCallId,
						name: event.toolName,
						args: event.args,
					});
				}
				break;
			case "tool_execution_end":
				if (typeof event.toolCallId === "string") {
					this.send({
						type: "toolEnd",
						id: event.toolCallId,
						isError: event.isError === true,
					});
				}
				break;
			case "extension_ui_request":
				await this.handleExtensionUi(client, event);
				break;
			case "extension_error":
				if (typeof event.error === "string") this.reportError(event.error);
				break;
		}
	}

	private async handleExtensionUi(
		client: PiRpcClient,
		request: JsonObject,
	): Promise<void> {
		const method = request.method;
		const id = request.id;
		if (typeof method !== "string" || typeof id !== "string") return;

		if (method === "notify") {
			const message = typeof request.message === "string" ? request.message : "Pi notification";
			if (request.notifyType === "error") void vscode.window.showErrorMessage(message);
			else if (request.notifyType === "warning") void vscode.window.showWarningMessage(message);
			else void vscode.window.showInformationMessage(message);
			return;
		}
		if (method === "set_editor_text" && typeof request.text === "string") {
			this.send({ type: "setEditorText", text: request.text });
			return;
		}
		if (method === "setTitle" && typeof request.title === "string" && this.view) {
			this.view.title = request.title;
			return;
		}
		if (method === "setWidget") {
			const lines = Array.isArray(request.widgetLines)
				? request.widgetLines.filter((line): line is string => typeof line === "string")
				: [];
			this.send({
				type: "widget",
				key: typeof request.widgetKey === "string" ? request.widgetKey : "pi",
				lines,
			});
			return;
		}
		if (method === "setStatus") return;

		let response: JsonObject;
		if (method === "select") {
			const options = Array.isArray(request.options)
				? request.options.filter((item): item is string => typeof item === "string")
				: [];
			const result = await this.runUiRequest(request, (token) =>
				vscode.window.showQuickPick(
					options,
					{ title: typeof request.title === "string" ? request.title : undefined },
					token,
				),
			);
			if (result.timedOut) return;
			response = result.value === undefined
				? { type: "extension_ui_response", id, cancelled: true }
				: { type: "extension_ui_response", id, value: result.value };
		} else if (method === "confirm") {
			const result = await this.runUiRequest(request, (token) =>
				vscode.window.showQuickPick(
					["Confirm", "Cancel"],
					{
						title: typeof request.title === "string" ? request.title : undefined,
						placeHolder:
							typeof request.message === "string" ? request.message : "Confirm?",
					},
					token,
				),
			);
			if (result.timedOut) return;
			response = {
				type: "extension_ui_response",
				id,
				confirmed: result.value === "Confirm",
			};
		} else if (method === "input" || method === "editor") {
			const result = await this.runUiRequest(request, (token) =>
				vscode.window.showInputBox(
					{
						title: typeof request.title === "string" ? request.title : undefined,
						prompt:
							method === "input" && typeof request.placeholder === "string"
								? request.placeholder
								: undefined,
						value:
							method === "editor" && typeof request.prefill === "string"
								? request.prefill
								: undefined,
					},
					token,
				),
			);
			if (result.timedOut) return;
			response = result.value === undefined
				? { type: "extension_ui_response", id, cancelled: true }
				: { type: "extension_ui_response", id, value: result.value };
		} else {
			this.output.appendLine(`Unsupported Pi extension UI method: ${method}`);
			response = { type: "extension_ui_response", id, cancelled: true };
		}
		if (!client.running) return;
		client.write(response);
	}

	private async runUiRequest<T>(
		request: JsonObject,
		operation: (token: vscode.CancellationToken) => Thenable<T | undefined>,
	): Promise<{ value: T | undefined; timedOut: boolean }> {
		const cancellation = new vscode.CancellationTokenSource();
		let timedOut = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		if (
			typeof request.timeout === "number" &&
			Number.isFinite(request.timeout) &&
			request.timeout > 0
		) {
			timer = setTimeout(() => {
				timedOut = true;
				cancellation.cancel();
			}, request.timeout);
		}
		try {
			const value = await operation(cancellation.token);
			return { value, timedOut };
		} finally {
			if (timer) clearTimeout(timer);
			cancellation.dispose();
		}
	}

	private sendSession(data: unknown): void {
		if (!isJsonObject(data)) return;
		const model = isJsonObject(data.model)
			? typeof data.model.name === "string"
				? data.model.name
				: typeof data.model.id === "string"
					? data.model.id
					: undefined
			: undefined;
		this.send({
			type: "session",
			name: typeof data.sessionName === "string" ? data.sessionName : undefined,
			model,
		});
	}

	private setConnection(
		state: "stopped" | "starting" | "ready" | "busy",
		detail?: string,
	): void {
		this.connectionState = state;
		this.send({ type: "connection", state, detail });
	}

	private reportError(value: unknown): void {
		const message = value instanceof Error ? value.message : String(value);
		this.output.appendLine(message);
		this.send({ type: "error", message });
	}

	private send(message: HostToWebviewMessage): void {
		void this.view?.webview.postMessage(message);
	}

	private renderHtml(webview: vscode.Webview): string {
		const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "dist", "webview.js"));
		const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "main.css"));
		const nonce = randomBytes(16).toString("base64");
		return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${styleUri}">
<title>Pi</title>
</head>
<body>
<header><strong>Pi</strong><span id="status" aria-live="polite">stopped</span></header>
<section id="session" aria-live="polite"></section>
<main id="messages" aria-live="polite"></main>
<section id="widgets"></section>
<form id="composer">
<label class="sr-only" for="prompt">Message Pi</label>
<textarea id="prompt" rows="3" placeholder="Message Pi…"></textarea>
<div class="actions"><button id="stop" type="button" disabled>Stop</button><button id="send" type="submit">Send</button></div>
</form>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
	}
}
