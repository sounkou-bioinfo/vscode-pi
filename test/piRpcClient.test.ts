import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PiRpcClient } from "../src/core/piRpcClient.js";

test("Pi RPC client correlates responses and forwards events", async () => {
	const directory = await mkdtemp(join(tmpdir(), "vscode-pi-rpc-"));
	const script = join(directory, "fake-pi.mjs");
	await writeFile(
		script,
		`import { createInterface } from "node:readline";
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
  const request = JSON.parse(line);
  if (request.type === "get_state") {
    process.stdout.write(JSON.stringify({ type: "response", command: request.type, success: true, id: request.id, data: { sessionName: "test" } }) + "\\n");
  } else if (request.type === "prompt") {
    process.stdout.write(JSON.stringify({ type: "response", command: request.type, success: true, id: request.id }) + "\\n");
    process.stdout.write(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hello" } }) + "\\n");
  }
}
`,
		"utf8",
	);

	const client = new PiRpcClient({
		executable: process.execPath,
		arguments: [script],
		cwd: directory,
		requestTimeoutMs: 2_000,
	});
	const event = new Promise<Record<string, unknown>>((resolve) => {
		const dispose = client.onEvent((value) => {
			dispose();
			resolve(value);
		});
	});

	try {
		client.start();
		const state = await client.request<{ sessionName: string }>({ type: "get_state" });
		assert.equal(state.data?.sessionName, "test");
		await client.request({ type: "prompt", message: "hello" });
		assert.deepEqual(await event, {
			type: "message_update",
			assistantMessageEvent: {
				type: "text_delta",
				contentIndex: 0,
				delta: "hello",
			},
		});
	} finally {
		await client.stop();
		await rm(directory, { recursive: true, force: true });
	}
});

test("Pi RPC client rejects uncorrelated responses", async () => {
	const directory = await mkdtemp(join(tmpdir(), "vscode-pi-rpc-invalid-"));
	const script = join(directory, "fake-pi.mjs");
	await writeFile(
		script,
		`process.stdout.write(JSON.stringify({ type: "response", command: "ghost", success: true, id: "unknown" }) + "\\n");
setInterval(() => {}, 1000);
`,
		"utf8",
	);
	const client = new PiRpcClient({
		executable: process.execPath,
		arguments: [script],
		cwd: directory,
	});
	const exited = new Promise<Error | undefined>((resolve) => client.onExit(resolve));
	try {
		client.start();
		const error = await exited;
		assert.match(error?.message ?? "", /Unexpected Pi RPC response id/);
	} finally {
		await client.stop();
		await rm(directory, { recursive: true, force: true });
	}
});
