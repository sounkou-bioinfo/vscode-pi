import {
	CAPTURE_SAMPLE_RATE,
	MicrophoneCapture,
	getAvailableMicrophones,
} from "@earendil-works/pi-transcribe/src/audio.js";
import * as vscode from "vscode";
import { resolveDictationModel } from "./model.js";
import { insertTranscript } from "./terminalBridge.js";

interface TranscribeModelInstance {
	readonly capabilities: { languages: readonly string[] };
	transcribe(
		pcm: Float32Array,
		options: { language?: string; timestamps: "none"; signal?: AbortSignal },
	): Promise<{ text: string }>;
	dispose(): void;
}

class LocalTranscriptionBackend {
	private model: TranscribeModelInstance | undefined;
	private loading: Promise<TranscribeModelInstance> | undefined;

	constructor(
		private readonly modelPath: string,
		private readonly language?: string,
	) {}

	async prepare(): Promise<void> {
		if (this.model) return;
		if (!this.loading) {
			this.loading = import("transcribe-cpp").then(async ({ TranscribeModel }) => {
				const model = (await TranscribeModel.load(this.modelPath)) as TranscribeModelInstance;
				if (this.language && !model.capabilities.languages.includes(this.language)) {
					model.dispose();
					throw new Error(`The selected model does not support language ${this.language}`);
				}
				this.model = model;
				return model;
			});
		}
		try {
			await this.loading;
		} finally {
			this.loading = undefined;
		}
	}

	async transcribe(pcm: Float32Array, signal?: AbortSignal): Promise<string> {
		if (pcm.length === 0) throw new Error("No microphone samples were captured");
		await this.prepare();
		const result = await this.model!.transcribe(pcm, {
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
}

interface ActiveRecording {
	capture: MicrophoneCapture;
	backend: LocalTranscriptionBackend;
	preparation: Promise<void>;
	terminal: vscode.Terminal;
	startedAt: number;
	timeout: NodeJS.Timeout;
}

function selectedMicrophone(): { name: string; occurrence: number } | undefined {
	const configuration = vscode.workspace.getConfiguration("vscodePi.dictation");
	const wanted = configuration.get<string>("microphone", "").trim();
	if (!wanted) return undefined;
	const occurrence = Math.max(
		0,
		Math.floor(configuration.get<number>("microphoneOccurrence", 0)),
	);
	const matchingDevices = getAvailableMicrophones().filter((device) => device === wanted);
	if (occurrence >= matchingDevices.length) {
		throw new Error(`Configured microphone is unavailable: ${wanted}`);
	}
	return { name: wanted, occurrence };
}

export class DictationController implements vscode.Disposable {
	private active: ActiveRecording | undefined;
	private operation: Promise<void> | undefined;
	private readonly status: vscode.StatusBarItem;
	private disposed = false;
	private shutdownPromise: Promise<void> | undefined;

	constructor(private readonly context: vscode.ExtensionContext) {
		this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
		this.status.command = "vscodePi.toggleDictation";
		this.showIdleStatus();
		this.status.show();
	}

	toggle(preferredTerminal?: vscode.Terminal): Promise<void> {
		if (this.operation) return this.operation;
		const operation = (
			this.active ? this.stopAndTranscribe() : this.start(preferredTerminal)
		).finally(() => {
			if (this.operation === operation) this.operation = undefined;
		});
		this.operation = operation;
		return operation;
	}

	async selectMicrophone(): Promise<void> {
		const devices = getAvailableMicrophones();
		if (devices.length === 0) throw new Error("No microphones were found on the local machine");
		const configuration = vscode.workspace.getConfiguration("vscodePi.dictation");
		const currentName = configuration.get<string>("microphone", "");
		const currentOccurrence = configuration.get<number>("microphoneOccurrence", 0);
		const occurrences = new Map<string, number>();
		const choices = devices.map((device) => {
			const occurrence = occurrences.get(device) ?? 0;
			occurrences.set(device, occurrence + 1);
			return {
				label: device,
				description: occurrence > 0 ? `device ${occurrence + 1}` : undefined,
				name: device,
				occurrence,
				picked: device === currentName && occurrence === currentOccurrence,
			};
		});
		const selected = await vscode.window.showQuickPick(
			[
				{ label: "System default", name: "", occurrence: 0, picked: !currentName },
				...choices,
			],
			{ placeHolder: "Select the local microphone used for Pi dictation" },
		);
		if (!selected) return;
		await configuration.update("microphone", selected.name, vscode.ConfigurationTarget.Global);
		await configuration.update(
			"microphoneOccurrence",
			selected.occurrence,
			vscode.ConfigurationTarget.Global,
		);
	}

	private async start(preferredTerminal?: vscode.Terminal): Promise<void> {
		if (this.disposed) return;
		const terminal =
			preferredTerminal && vscode.window.terminals.includes(preferredTerminal)
				? preferredTerminal
				: vscode.window.activeTerminal;
		if (!terminal) throw new Error("Open and focus the terminal running Pi first");
		const configured = await resolveDictationModel(this.context);
		if (!configured || this.disposed) return;

		const capture = new MicrophoneCapture(selectedMicrophone());
		const backend = new LocalTranscriptionBackend(configured.path, configured.language);
		const preparation = backend.prepare();
		void preparation.catch(() => undefined);

		try {
			capture.start();
		} catch (error) {
			await backend.dispose();
			throw error;
		}

		const maxSeconds = Math.min(
			1_800,
			Math.max(
				10,
				vscode.workspace
					.getConfiguration("vscodePi.dictation")
					.get<number>("maxRecordingSeconds", 300),
			),
		);
		const timeout = setTimeout(() => {
			if (!this.operation) {
				void this.toggle().catch((error) => {
					const message = error instanceof Error ? error.message : String(error);
					void vscode.window.showErrorMessage(`Pi: ${message}`);
				});
			}
		}, maxSeconds * 1_000);
		this.active = {
			capture,
			backend,
			preparation,
			terminal,
			startedAt: Date.now(),
			timeout,
		};
		this.status.text = "$(record) Pi recording";
		this.status.tooltip = "Recording locally; click or press Ctrl+Alt+Z to transcribe";
		this.status.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
		void vscode.window.showInformationMessage("Pi dictation recording started");
	}

	private async stopAndTranscribe(): Promise<void> {
		const active = this.active;
		if (!active) return;
		this.active = undefined;
		clearTimeout(active.timeout);
		this.status.text = "$(loading~spin) Pi transcribing";
		this.status.tooltip = "Transcribing locally";
		this.status.backgroundColor = undefined;

		try {
			const { pcm } = await active.capture.stop();
			const controller = new AbortController();
			let text: string;
			try {
				text = await vscode.window.withProgress(
					{
						location: vscode.ProgressLocation.Notification,
						title: "Pi: Transcribing locally",
						cancellable: true,
					},
					async (_progress, token) => {
						token.onCancellationRequested(() => controller.abort());
						await active.preparation;
						return active.backend.transcribe(pcm, controller.signal);
					},
				);
			} catch (error) {
				if (controller.signal.aborted) {
					void vscode.window.showInformationMessage("Pi transcription cancelled");
					return;
				}
				throw error;
			}
			insertTranscript(active.terminal, text);
			const seconds = pcm.length / CAPTURE_SAMPLE_RATE;
			void vscode.window.showInformationMessage(`Pi transcribed ${seconds.toFixed(1)}s locally`);
		} finally {
			await active.backend.dispose();
			this.showIdleStatus();
		}
	}

	private showIdleStatus(): void {
		this.status.text = "$(mic) Pi dictate";
		this.status.tooltip = "Dictate into the active Pi terminal (Ctrl+Alt+Z)";
		this.status.backgroundColor = undefined;
	}

	shutdown(): Promise<void> {
		if (this.shutdownPromise) return this.shutdownPromise;
		this.shutdownPromise = this.performShutdown();
		return this.shutdownPromise;
	}

	private async performShutdown(): Promise<void> {
		this.disposed = true;
		await this.operation?.catch(() => undefined);
		const active = this.active;
		this.active = undefined;
		if (active) {
			clearTimeout(active.timeout);
			await active.capture.stop().catch(() => undefined);
			await active.backend.dispose().catch(() => undefined);
		}
		this.status.dispose();
	}

	dispose(): void {
		void this.shutdown();
	}
}
