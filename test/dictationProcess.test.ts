import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { DictationProcessClient } from "../src/dictationProcess.js";

const fixturePath = resolve("test", "fixtures", "dictationHelperFixture.cjs");

test("dictation IPC validates responses and serializes native-style operations", async (t) => {
	const client = new DictationProcessClient(fixturePath);
	t.after(() => client.shutdown());

	const microphonesPromise = client.getAvailableMicrophones();
	const startPromise = client.startRecording({
		modelPath: "fixture.gguf",
		language: "en",
		microphone: { name: "Fixture microphone", occurrence: 1 },
	});
	const [microphones] = await Promise.all([microphonesPromise, startPromise]);
	assert.deepEqual(microphones, [
		"Fixture microphone",
		"Fixture microphone",
		"Other microphone",
	]);

	const result = await client.stopAndTranscribe();
	assert.deepEqual(result, {
		text: "fixture transcript from Fixture microphone occurrence 1",
		sampleCount: 32_000,
		sampleRate: 16_000,
	});
});

test("a child exit rejects pending work and the next operation starts a fresh helper", async (t) => {
	const client = new DictationProcessClient(fixturePath);
	t.after(() => client.shutdown());
	const failures: Error[] = [];
	const stopListening = client.onFailure((error) => failures.push(error));
	t.after(stopListening);

	await client.startRecording({ modelPath: "exit-on-stop" });
	await assert.rejects(client.stopAndTranscribe(), /exited unexpectedly \(code 23\)/);
	assert.equal(failures.length, 1);
	assert.match(failures[0]?.message ?? "", /code 23/);

	assert.deepEqual(await client.getAvailableMicrophones(), [
		"Fixture microphone",
		"Fixture microphone",
		"Other microphone",
	]);
});

test("an unresponsive control request is killed and the helper can restart", async (t) => {
	const client = new DictationProcessClient(fixturePath, {
		controlRequestTimeoutMs: 500,
		forceKillWaitMs: 500,
	});
	t.after(() => client.shutdown());

	await assert.rejects(
		client.startRecording({ modelPath: "ignore-start" }),
		/did not respond to startRecording/,
	);
	assert.deepEqual(await client.getAvailableMicrophones(), [
		"Fixture microphone",
		"Fixture microphone",
		"Other microphone",
	]);
});

test("shutdown force-kills an unresponsive helper within bounded time", async () => {
	const client = new DictationProcessClient(fixturePath, {
		shutdownGraceMs: 75,
		forceKillWaitMs: 500,
	});
	await client.startRecording({ modelPath: "ignore-shutdown" });

	const startedAt = Date.now();
	await client.shutdown();
	const elapsed = Date.now() - startedAt;
	assert.ok(elapsed >= 50, `shutdown returned before its grace period (${elapsed}ms)`);
	assert.ok(elapsed < 1_500, `shutdown exceeded its bounded timers (${elapsed}ms)`);
	await assert.rejects(client.getAvailableMicrophones(), /shut down/);
});
