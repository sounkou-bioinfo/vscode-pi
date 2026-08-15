import { isJsonObject } from "./json.js";

export type WebviewToHostMessage =
	| { type: "ready" }
	| { type: "prompt"; text: string }
	| { type: "abort" }
	| { type: "newSession" };

export type HostToWebviewMessage =
	| { type: "connection"; state: "stopped" | "starting" | "ready" | "busy"; detail?: string }
	| { type: "assistantDelta"; text: string }
	| { type: "assistantEnd" }
	| { type: "toolStart"; id: string; name: string; args: unknown }
	| { type: "toolEnd"; id: string; isError: boolean }
	| { type: "error"; message: string }
	| { type: "session"; name?: string; model?: string }
	| { type: "setEditorText"; text: string }
	| { type: "widget"; key: string; lines: string[] };

export function parseHostMessage(value: unknown): HostToWebviewMessage | undefined {
	if (!isJsonObject(value) || typeof value.type !== "string") return undefined;
	switch (value.type) {
		case "connection":
			return isConnectionState(value.state) && optionalString(value.detail)
				? { type: "connection", state: value.state, detail: value.detail }
				: undefined;
		case "assistantDelta":
			return typeof value.text === "string"
				? { type: "assistantDelta", text: value.text }
				: undefined;
		case "assistantEnd":
			return { type: "assistantEnd" };
		case "toolStart":
			return typeof value.id === "string" && typeof value.name === "string"
				? { type: "toolStart", id: value.id, name: value.name, args: value.args }
				: undefined;
		case "toolEnd":
			return (
				typeof value.id === "string" && typeof value.isError === "boolean"
			)
				? { type: "toolEnd", id: value.id, isError: value.isError }
				: undefined;
		case "error":
			return typeof value.message === "string"
				? { type: "error", message: value.message }
				: undefined;
		case "session":
			return optionalString(value.name) && optionalString(value.model)
				? { type: "session", name: value.name, model: value.model }
				: undefined;
		case "setEditorText":
			return typeof value.text === "string"
				? { type: "setEditorText", text: value.text }
				: undefined;
		case "widget":
			return (
				typeof value.key === "string" &&
				Array.isArray(value.lines) &&
				value.lines.every((line) => typeof line === "string")
			)
				? { type: "widget", key: value.key, lines: value.lines as string[] }
				: undefined;
		default:
			return undefined;
	}
}

export function parseWebviewMessage(value: unknown): WebviewToHostMessage | undefined {
	if (!isJsonObject(value) || typeof value.type !== "string") return undefined;
	switch (value.type) {
		case "ready":
		case "abort":
		case "newSession":
			return { type: value.type };
		case "prompt":
			return (
				typeof value.text === "string" &&
				value.text.trim().length > 0 &&
				value.text.length <= 2_000_000
			)
				? { type: "prompt", text: value.text }
				: undefined;
		default:
			return undefined;
	}
}

function optionalString(value: unknown): value is string | undefined {
	return value === undefined || typeof value === "string";
}

function isConnectionState(
	value: unknown,
): value is "stopped" | "starting" | "ready" | "busy" {
	return value === "stopped" || value === "starting" || value === "ready" || value === "busy";
}
