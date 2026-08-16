import assert from "node:assert/strict";
import test from "node:test";
import { formatPathInsertion, sanitizeTerminalInsertion } from "../src/core/terminalText.js";

test("sanitizeTerminalInsertion removes newlines and terminal controls", () => {
	assert.equal(
		sanitizeTerminalInsertion(" hello\r\nworld\u001b[31m\u0007 "),
		"hello world[31m",
	);
});

test("formatPathInsertion preserves path spaces and adds a trailing separator", () => {
	assert.equal(
		formatPathInsertion("C:\\Users\\Pi User\\pi-clipboard.png"),
		"C:\\Users\\Pi User\\pi-clipboard.png ",
	);
});

test("formatPathInsertion rejects empty and control-bearing paths", () => {
	assert.throws(() => formatPathInsertion(""), /empty/);
	assert.throws(() => formatPathInsertion("/tmp/image\u001b.png"), /control/);
});
