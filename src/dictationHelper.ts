import {
	CAPTURE_SAMPLE_RATE,
	MicrophoneCapture,
	getAvailableMicrophones,
} from "@earendil-works/pi-transcribe/src/audio.js";
import {
	DICTATION_PROTOCOL_VERSION,
	parseDictationRequest,
	type DictationErrorResponse,
	type DictationRequest,
	type DictationSuccessResponse,
} from "./dictationProtocol.js";

type TranscribeCppModule = typeof import("transcribe-cpp");
type TranscribeModelInstance = Awaited<
	ReturnType<TranscribeCppModule["TranscribeModel"]["load"]>
>;

class LocalTranscriptionBackend {
	private model: TranscribeModelInstance | undefined;
	private loading: Promise<TranscribeModelInstance> | undefined;

	constructor(
		private readonly modelPath: string,
		private readonly language?: string,
	) {}

	async prepare(): Promise<void> {
		if (this.model) return;
		const loading = this.loading ?? this.load();
		this.loading = loading;
		try {
			await loading;
		} finally {
			if (this.loading === loading) this.loading = undefined;
		}
	}

	async transcribe(pcm: Float32Array, signal?: AbortSignal): Promise<string> {
		if (pcm.length === 0) throw new Error("No microphone samples were captured");
		await this.prepare();
		const model = this.model;
		if (!model) throw new Error("The transcription model did not finish loading");
		const result = await model.transcribe(pcm, {
			timestamps: "none",
			signal,
			...(this.language ? { language: this.language } : {}),
		});
		return result.text.trim();
	}

	async dispose(): Promise<void> {
		await this.loading?.catch(() => undefined);
		this.model?.dispose();
		this.model = undefined;
	}

	private async load(): Promise<TranscribeModelInstance> {
		console.error("Pi dictation helper: loading transcription runtime");
		const { TranscribeModel } = await import("transcribe-cpp");
		const backend = process.platform === "win32" ? "cpu" : "auto";
		console.error(`Pi dictation helper: loading model with ${backend} backend`);
		const model = await TranscribeModel.load(this.modelPath, { backend });
		console.error("Pi dictation helper: transcription model ready");
		if (this.language && !model.capabilities.languages.includes(this.language)) {
			model.dispose();
			throw new Error(`The selected model does not support language ${this.language}`);
		}
		this.model = model;
		return model;
	}
}

interface ActiveRecording {
	capture: MicrophoneCapture;
	backend: LocalTranscriptionBackend;
	preparation: Promise<void>;
}

class NativeDictationService {
	private active: ActiveRecording | undefined;

	constructor(private readonly onBackgroundFailure: (error: Error) => void) {}

	getAvailableMicrophones(): string[] {
		return getAvailableMicrophones();
	}

	startRecording(request: Extract<DictationRequest, { method: "startRecording" }>): void {
		if (this.active) throw new Error("Microphone capture is already active");
		const capture = new MicrophoneCapture(request.params.microphone);
		capture.start();
		console.error("Pi dictation helper: microphone capture started");

		const backend = new LocalTranscriptionBackend(
			request.params.modelPath,
			request.params.language,
		);
		const preparation = backend.prepare();
		void preparation.catch((error: unknown) => {
			this.onBackgroundFailure(
				error instanceof Error ? error : new Error(String(error)),
			);
		});
		this.active = { capture, backend, preparation };
	}

	async stopAndTranscribe(signal: AbortSignal): Promise<{
		text: string;
		sampleCount: number;
		sampleRate: number;
	}> {
		const active = this.active;
		if (!active) throw new Error("Microphone capture is not active");
		this.active = undefined;

		try {
			// Always stop the recorder, even if cancellation arrived before this request ran.
			const { pcm } = await active.capture.stop();
			signal.throwIfAborted();
			await active.preparation;
			signal.throwIfAborted();
			const text = await active.backend.transcribe(pcm, signal);
			return {
				text,
				sampleCount: pcm.length,
				sampleRate: CAPTURE_SAMPLE_RATE,
			};
		} finally {
			await active.backend.dispose();
		}
	}

	async shutdown(): Promise<void> {
		const active = this.active;
		this.active = undefined;
		if (!active) return;
		await active.capture.stop().catch(() => undefined);
		await active.backend.dispose().catch(() => undefined);
	}
}

const service = new NativeDictationService((error) =>
	emergencyExit(`Transcription model preparation failed: ${error.message}`),
);
let operationTail: Promise<void> = Promise.resolve();
let activeTranscription:
	| { requestId: number; controller: AbortController }
	| undefined;
let acceptingRequests = true;
let exiting = false;

function errorResponse(request: DictationRequest, value: unknown): DictationErrorResponse {
	const error = value instanceof Error ? value : new Error(String(value));
	return {
		protocol: DICTATION_PROTOCOL_VERSION,
		type: "response",
		id: request.id,
		method: request.method,
		ok: false,
		error: {
			name: error.name || "Error",
			message: error.message || String(value) || "Unknown dictation error",
		},
	};
}

async function execute(request: DictationRequest): Promise<DictationSuccessResponse> {
	const base = {
		protocol: DICTATION_PROTOCOL_VERSION,
		type: "response" as const,
		id: request.id,
	};
	switch (request.method) {
		case "getAvailableMicrophones":
			return {
				...base,
				method: request.method,
				ok: true,
				result: { microphones: service.getAvailableMicrophones() },
			};
		case "startRecording":
			service.startRecording(request);
			return {
				...base,
				method: request.method,
				ok: true,
				result: { started: true },
			};
		case "stopAndTranscribe": {
			const controller = new AbortController();
			activeTranscription = { requestId: request.id, controller };
			try {
				const result = await service.stopAndTranscribe(controller.signal);
				return { ...base, method: request.method, ok: true, result };
			} finally {
				if (activeTranscription?.requestId === request.id) activeTranscription = undefined;
			}
		}
		case "cancelTranscription": {
			const cancelled = activeTranscription?.requestId === request.params.requestId;
			if (cancelled) activeTranscription?.controller.abort();
			return {
				...base,
				method: request.method,
				ok: true,
				result: { cancelled },
			};
		}
		case "shutdown":
			activeTranscription?.controller.abort();
			await service.shutdown();
			return {
				...base,
				method: request.method,
				ok: true,
				result: { shuttingDown: true },
			};
	}
}

function sendResponse(response: DictationSuccessResponse | DictationErrorResponse): Promise<void> {
	return new Promise((resolve, reject) => {
		if (!process.send || !process.connected) {
			reject(new Error("Parent IPC channel is closed"));
			return;
		}
		process.send(response, (error) => {
			if (error) reject(error);
			else resolve();
		});
	});
}

function finishNormally(): void {
	if (exiting) return;
	exiting = true;
	setImmediate(() => process.exit(0));
}

function emergencyExit(reason: string, code = 1): void {
	if (exiting) return;
	exiting = true;
	acceptingRequests = false;
	activeTranscription?.controller.abort();
	console.error(reason);
	const timer = setTimeout(() => process.exit(code), 1_000);
	void operationTail
		.catch(() => undefined)
		.then(() => service.shutdown())
		.catch(() => undefined)
		.finally(() => {
			clearTimeout(timer);
			process.exit(code);
		});
}

function completeRequest(
	request: DictationRequest,
	operation: Promise<DictationSuccessResponse>,
): void {
	void operation.then(
		(response) => {
			void sendResponse(response).then(
				() => {
					if (request.method === "shutdown") finishNormally();
				},
				(error) => emergencyExit(`Could not send dictation response: ${String(error)}`),
			);
		},
		(error) => {
			void sendResponse(errorResponse(request, error)).catch((sendError) =>
				emergencyExit(`Could not send dictation error: ${String(sendError)}`),
			);
		},
	);
}

function acceptRequest(request: DictationRequest): void {
	if (request.method === "cancelTranscription") {
		completeRequest(request, execute(request));
		return;
	}
	if (request.method === "shutdown") {
		acceptingRequests = false;
		activeTranscription?.controller.abort();
	}
	const operation = operationTail.then(() => execute(request));
	operationTail = operation.then(
		() => undefined,
		() => undefined,
	);
	completeRequest(request, operation);
}

if (!process.send) {
	console.error("Dictation helper must be launched with a Node IPC channel");
	process.exit(1);
} else {
	process.on("message", (message: unknown) => {
		if (!acceptingRequests) return;
		const parsed = parseDictationRequest(message);
		if (!parsed.ok) {
			emergencyExit(`Invalid dictation request: ${parsed.error}`);
			return;
		}
		acceptRequest(parsed.value);
	});
	process.once("disconnect", () => emergencyExit("Dictation parent disconnected", 0));
	process.once("SIGINT", () => emergencyExit("Dictation helper interrupted", 0));
	process.once("SIGTERM", () => emergencyExit("Dictation helper terminated", 0));
}
