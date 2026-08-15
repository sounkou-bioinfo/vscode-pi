import assert from "node:assert/strict";
import test from "node:test";
import { parseHostMessage, parseWebviewMessage } from "../src/core/uiProtocol.js";

test("webview protocol accepts only bounded command shapes", () => {
	assert.deepEqual(parseWebviewMessage({ type: "ready" }), { type: "ready" });
	assert.deepEqual(parseWebviewMessage({ type: "prompt", text: "  hello  " }), {
		type: "prompt",
		text: "  hello  ",
	});
	assert.equal(parseWebviewMessage({ type: "prompt", text: "  " }), undefined);
	assert.equal(parseWebviewMessage({ type: "prompt", text: 1 }), undefined);
	assert.equal(parseWebviewMessage({ type: "unknown" }), undefined);
	assert.equal(parseWebviewMessage(null), undefined);
});

test("webview validates every host message before rendering", () => {
	assert.deepEqual(parseHostMessage({ type: "assistantDelta", text: "hello" }), {
		type: "assistantDelta",
		text: "hello",
	});
	assert.deepEqual(
		parseHostMessage({ type: "connection", state: "ready", detail: undefined }),
		{ type: "connection", state: "ready", detail: undefined },
	);
	assert.equal(parseHostMessage({ type: "connection", state: "unknown" }), undefined);
	assert.equal(parseHostMessage({ type: "widget", key: "x", lines: [1] }), undefined);
	assert.equal(parseHostMessage({ type: "error", message: { html: "unsafe" } }), undefined);
});
