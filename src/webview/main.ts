import {
	parseHostMessage,
	type WebviewToHostMessage,
} from "../core/uiProtocol.js";

interface VsCodeApi<State> {
	postMessage(message: WebviewToHostMessage): void;
	getState(): State | undefined;
	setState(state: State): void;
}

declare function acquireVsCodeApi<State = unknown>(): VsCodeApi<State>;

const vscode = acquireVsCodeApi<Record<string, never>>();
const status = requiredElement<HTMLSpanElement>("status");
const session = requiredElement<HTMLElement>("session");
const messages = requiredElement<HTMLElement>("messages");
const widgets = requiredElement<HTMLElement>("widgets");
const form = requiredElement<HTMLFormElement>("composer");
const prompt = requiredElement<HTMLTextAreaElement>("prompt");
const stop = requiredElement<HTMLButtonElement>("stop");
const send = requiredElement<HTMLButtonElement>("send");
const tools = new Map<string, HTMLDetailsElement>();
const widgetNodes = new Map<string, HTMLElement>();
let assistantBody: HTMLPreElement | undefined;

form.addEventListener("submit", (event) => {
	event.preventDefault();
	const text = prompt.value.trim();
	if (!text) return;
	appendMessage("user", text);
	vscode.postMessage({ type: "prompt", text });
	prompt.value = "";
	prompt.focus();
});

prompt.addEventListener("keydown", (event) => {
	if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
		event.preventDefault();
		form.requestSubmit();
	}
});

stop.addEventListener("click", () => vscode.postMessage({ type: "abort" }));

window.addEventListener("message", (event: MessageEvent<unknown>) => {
	const message = parseHostMessage(event.data);
	if (!message) return;
	switch (message.type) {
		case "connection":
			status.textContent = message.detail ? `${message.state}: ${message.detail}` : message.state;
			status.dataset.state = message.state;
			stop.disabled = message.state !== "busy";
			send.disabled = message.state === "starting";
			break;
		case "assistantDelta":
			if (!assistantBody) assistantBody = appendMessage("assistant", "");
			assistantBody.append(document.createTextNode(message.text));
			messages.scrollTop = messages.scrollHeight;
			break;
		case "assistantEnd":
			assistantBody = undefined;
			break;
		case "toolStart": {
			const details = document.createElement("details");
			details.className = "tool";
			const summary = document.createElement("summary");
			summary.textContent = message.name;
			const body = document.createElement("pre");
			body.textContent = safeJson(message.args);
			details.append(summary, body);
			messages.append(details);
			tools.set(message.id, details);
			break;
		}
		case "toolEnd": {
			const details = tools.get(message.id);
			if (details) {
				details.classList.add(message.isError ? "failed" : "complete");
				tools.delete(message.id);
			}
			break;
		}
		case "error":
			appendMessage("error", message.message);
			assistantBody = undefined;
			break;
		case "session":
			session.textContent = [message.name, message.model].filter(Boolean).join(" · ");
			break;
		case "setEditorText":
			prompt.value = message.text;
			prompt.focus();
			break;
		case "widget": {
			let node = widgetNodes.get(message.key);
			if (!node) {
				node = document.createElement("pre");
				node.className = "widget";
				widgetNodes.set(message.key, node);
				widgets.append(node);
			}
			node.textContent = message.lines.join("\n");
			break;
		}
	}
});

vscode.postMessage({ type: "ready" });

function appendMessage(role: "user" | "assistant" | "error", text: string): HTMLPreElement {
	const article = document.createElement("article");
	article.className = `message ${role}`;
	const label = document.createElement("strong");
	label.textContent = role === "assistant" ? "Pi" : role === "user" ? "You" : "Error";
	const body = document.createElement("pre");
	body.textContent = text;
	article.append(label, body);
	messages.append(article);
	messages.scrollTop = messages.scrollHeight;
	return body;
}

function safeJson(value: unknown): string {
	try {
		return JSON.stringify(value, null, 2) ?? "";
	} catch {
		return String(value);
	}
}

function requiredElement<T extends HTMLElement>(id: string): T {
	const element = document.getElementById(id);
	if (!element) throw new Error(`Missing webview element: ${id}`);
	return element as T;
}
