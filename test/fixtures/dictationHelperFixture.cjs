"use strict";

const PROTOCOL = 1;
if (process.env.ELECTRON_RUN_AS_NODE !== "1" || process.execArgv.length !== 0) {
	process.exit(90);
}

let recording;
let busy = false;

function send(request, result) {
	process.send?.({
		protocol: PROTOCOL,
		type: "response",
		id: request.id,
		method: request.method,
		ok: true,
		result,
	});
}

function sendError(request, message) {
	process.send?.({
		protocol: PROTOCOL,
		type: "response",
		id: request.id,
		method: request.method,
		ok: false,
		error: { name: "Error", message },
	});
}

process.on("message", (request) => {
	if (!request || request.protocol !== PROTOCOL || request.type !== "request") return;
	if (request.method === "cancelTranscription") {
		send(request, { cancelled: false });
		return;
	}
	if (busy) {
		sendError(request, "fixture received overlapping operations");
		return;
	}
	busy = true;

	switch (request.method) {
		case "getAvailableMicrophones":
			setTimeout(() => {
				busy = false;
				send(request, {
					microphones: ["Fixture microphone", "Fixture microphone", "Other microphone"],
				});
			}, 25);
			break;
		case "startRecording":
			recording = request.params;
			if (recording.modelPath === "ignore-start") break;
			busy = false;
			send(request, { started: true });
			break;
		case "stopAndTranscribe":
			if (!recording) {
				busy = false;
				sendError(request, "fixture is not recording");
				break;
			}
			if (recording.modelPath === "exit-on-stop") {
				setTimeout(() => process.exit(23), 10);
				break;
			}
			{
				const microphone = recording.microphone;
				const suffix = microphone
					? ` from ${microphone.name} occurrence ${microphone.occurrence}`
					: "";
				recording = undefined;
				busy = false;
				send(request, {
					text: `fixture transcript${suffix}`,
					sampleCount: 32_000,
					sampleRate: 16_000,
				});
			}
			break;
		case "shutdown":
			if (recording?.modelPath === "ignore-shutdown") break;
			busy = false;
			send(request, { shuttingDown: true });
			setTimeout(() => process.exit(0), 5);
			break;
		default:
			busy = false;
			sendError(request, "unsupported fixture method");
	}
});
