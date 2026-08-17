import { join } from "node:path";
import * as vscode from "vscode";
import {
	DictationProcessClient,
	type TranscriptionResult,
} from "./dictationProcess.js";
import type { SelectedMicrophone } from "./dictationProtocol.js";
import { resolveDictationModel } from "./model.js";
import { insertTranscript } from "./terminalBridge.js";

interface ActiveRecording {
	terminal: vscode.Terminal;
	timeout: NodeJS.Timeout;
}

function selectedMicrophone(): SelectedMicrophone | undefined {
	const configuration = vscode.workspace.getConfiguration("vscodePi.dictation");
	const name = configuration.get<string>("microphone", "");
	if (!name.trim()) return undefined;
	return {
		name,
		occurrence: Math.max(
			0,
			Math.floor(configuration.get<number>("microphoneOccurrence", 0)),
		),
	};
}

export class DictationController implements vscode.Disposable {
	private active: ActiveRecording | undefined;
	private operation: Promise<void> | undefined;
	private readonly status: vscode.StatusBarItem;
	private readonly helper: DictationProcessClient;
	private readonly stopListeningForFailure: () => void;
	private disposed = false;
	private starting = false;
	private startFailure: Error | undefined;
	private shutdownPromise: Promise<void> | undefined;

	constructor(private readonly context: vscode.ExtensionContext) {
		this.helper = new DictationProcessClient(
			context.asAbsolutePath(join("dist", "dictationHelper.js")),
		);
		this.stopListeningForFailure = this.helper.onFailure((error) =>
			this.handleHelperFailure(error),
		);
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
		const devices = await this.helper.getAvailableMicrophones();
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
		if (!vscode.window.terminals.includes(terminal)) {
			throw new Error("The Pi terminal was closed before recording began");
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
		const microphone = selectedMicrophone();
		this.starting = true;
		this.startFailure = undefined;
		try {
			await this.helper.startRecording({
				modelPath: configured.path,
				...(configured.language ? { language: configured.language } : {}),
				...(microphone ? { microphone } : {}),
			});
			if (this.startFailure) throw this.startFailure;
			if (this.disposed) return;

			const timeout = setTimeout(() => {
				if (!this.operation) {
					void this.toggle().catch((error) => {
						const message = error instanceof Error ? error.message : String(error);
						void vscode.window.showErrorMessage(`Pi: ${message}`);
					});
				}
			}, maxSeconds * 1_000);
			this.active = { terminal, timeout };
			this.status.text = "$(record) Pi recording";
			this.status.tooltip = "Recording locally; click or press Ctrl+Alt+Z to transcribe";
			this.status.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
			void vscode.window.showInformationMessage("Pi dictation recording started");
		} finally {
			this.starting = false;
		}
	}

	private async stopAndTranscribe(): Promise<void> {
		const active = this.active;
		if (!active) return;
		this.active = undefined;
		clearTimeout(active.timeout);
		this.status.text = "$(loading~spin) Pi transcribing";
		this.status.tooltip = "Transcribing locally";
		this.status.backgroundColor = undefined;

		const controller = new AbortController();
		try {
			let result: TranscriptionResult;
			try {
				result = await vscode.window.withProgress(
					{
						location: vscode.ProgressLocation.Notification,
						title: "Pi: Transcribing locally",
						cancellable: true,
					},
					async (_progress, token) => {
						token.onCancellationRequested(() => controller.abort());
						return this.helper.stopAndTranscribe(controller.signal);
					},
				);
			} catch (error) {
				if (controller.signal.aborted) {
					void vscode.window.showInformationMessage("Pi transcription cancelled");
					return;
				}
				throw error;
			}
			if (this.disposed) return;
			insertTranscript(active.terminal, result.text);
			const seconds = result.sampleCount / result.sampleRate;
			void vscode.window.showInformationMessage(`Pi transcribed ${seconds.toFixed(1)}s locally`);
		} finally {
			this.showIdleStatus();
		}
	}

	private handleHelperFailure(error: Error): void {
		if (this.starting) {
			this.startFailure = error;
			return;
		}
		const active = this.active;
		if (!active || this.disposed) return;
		this.active = undefined;
		clearTimeout(active.timeout);
		this.showIdleStatus();
		void vscode.window.showErrorMessage(`Pi: Dictation stopped: ${error.message}`);
	}

	private showIdleStatus(): void {
		this.status.text = "$(mic) Pi dictate";
		this.status.tooltip = "Dictate into the active Pi terminal (Ctrl+Alt+Z)";
		this.status.backgroundColor = undefined;
	}

	shutdown(): Promise<void> {
		if (!this.shutdownPromise) this.shutdownPromise = this.performShutdown();
		return this.shutdownPromise;
	}

	private async performShutdown(): Promise<void> {
		this.disposed = true;
		this.stopListeningForFailure();
		const active = this.active;
		this.active = undefined;
		if (active) clearTimeout(active.timeout);
		await this.helper.shutdown();
		await this.operation?.catch(() => undefined);
		this.status.dispose();
	}

	dispose(): void {
		void this.shutdown();
	}
}
