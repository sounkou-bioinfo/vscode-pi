import { spawn, type ChildProcess } from "node:child_process";
import {
	DICTATION_PROTOCOL_VERSION,
	parseDictationResponse,
	type DictationMethod,
	type DictationRequest,
	type DictationSuccessResponse,
	type StartRecordingOptions,
} from "./dictationProtocol.js";

const STDERR_LIMIT = 4_096;
const DEFAULT_SHUTDOWN_GRACE_MS = 1_500;
const DEFAULT_FORCE_KILL_WAIT_MS = 1_000;
const DEFAULT_CANCELLATION_GRACE_MS = 2_000;
const DEFAULT_CONTROL_REQUEST_TIMEOUT_MS = 30_000;

interface RunningChild {
	process: ChildProcess;
	stderr: string;
	expectedExit: boolean;
	exited: Promise<void>;
	resolveExited: () => void;
}

interface PendingRequest {
	method: DictationMethod;
	resolve: (response: DictationSuccessResponse) => void;
	reject: (error: Error) => void;
}

interface RequestHandle {
	id: number;
	state: RunningChild;
	response: Promise<DictationSuccessResponse>;
}

export interface TranscriptionResult {
	text: string;
	sampleCount: number;
	sampleRate: number;
}

export interface DictationProcessOptions {
	shutdownGraceMs?: number;
	forceKillWaitMs?: number;
	cancellationGraceMs?: number;
	controlRequestTimeoutMs?: number;
}

function toError(value: unknown): Error {
	return value instanceof Error ? value : new Error(String(value));
}

function cancellationError(): Error {
	const error = new Error("Transcription cancelled");
	error.name = "AbortError";
	return error;
}

function remoteError(name: string, message: string): Error {
	const error = new Error(message);
	error.name = name;
	return error;
}

function positiveDuration(value: number | undefined, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? value
		: fallback;
}

function appendStderr(existing: string, chunk: unknown): string {
	const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
	return `${existing}${text}`.slice(-STDERR_LIMIT);
}

function exitError(state: RunningChild, code: number | null, signal: NodeJS.Signals | null): Error {
	const reason = signal ? `signal ${signal}` : `code ${code ?? "unknown"}`;
	const detail = state.stderr.trim();
	return new Error(
		`Dictation helper exited unexpectedly (${reason})${detail ? `: ${detail}` : ""}`,
	);
}

export class DictationProcessClient {
	private child: RunningChild | undefined;
	private nextRequestId = 1;
	private readonly pending = new Map<number, PendingRequest>();
	private readonly failureListeners = new Set<(error: Error) => void>();
	private operationTail: Promise<void> = Promise.resolve();
	private failureVersion = 0;
	private lastProcessFailure: Error | undefined;
	private disposed = false;
	private shutdownPromise: Promise<void> | undefined;
	private readonly shutdownGraceMs: number;
	private readonly forceKillWaitMs: number;
	private readonly cancellationGraceMs: number;
	private readonly controlRequestTimeoutMs: number;

	constructor(
		private readonly helperPath: string,
		options: DictationProcessOptions = {},
	) {
		this.shutdownGraceMs = positiveDuration(
			options.shutdownGraceMs,
			DEFAULT_SHUTDOWN_GRACE_MS,
		);
		this.forceKillWaitMs = positiveDuration(
			options.forceKillWaitMs,
			DEFAULT_FORCE_KILL_WAIT_MS,
		);
		this.cancellationGraceMs = positiveDuration(
			options.cancellationGraceMs,
			DEFAULT_CANCELLATION_GRACE_MS,
		);
		this.controlRequestTimeoutMs = positiveDuration(
			options.controlRequestTimeoutMs,
			DEFAULT_CONTROL_REQUEST_TIMEOUT_MS,
		);
	}

	onFailure(listener: (error: Error) => void): () => void {
		this.failureListeners.add(listener);
		return () => this.failureListeners.delete(listener);
	}

	getAvailableMicrophones(): Promise<string[]> {
		return this.enqueue(async () => {
			const handle = this.sendControlRequest({
				protocol: DICTATION_PROTOCOL_VERSION,
				type: "request",
				id: this.allocateRequestId(),
				method: "getAvailableMicrophones",
				params: {},
			});
			const response = await handle.response;
			if (response.method !== "getAvailableMicrophones") {
				throw new Error("Dictation helper returned the wrong microphone response");
			}
			return response.result.microphones;
		});
	}

	startRecording(options: StartRecordingOptions): Promise<void> {
		return this.enqueue(async () => {
			const handle = this.sendControlRequest({
				protocol: DICTATION_PROTOCOL_VERSION,
				type: "request",
				id: this.allocateRequestId(),
				method: "startRecording",
				params: options,
			});
			const response = await handle.response;
			if (response.method !== "startRecording") {
				throw new Error("Dictation helper returned the wrong start response");
			}
		});
	}

	stopAndTranscribe(signal?: AbortSignal): Promise<TranscriptionResult> {
		return this.enqueue(async () => {
			if (signal?.aborted) throw cancellationError();
			const requestId = this.allocateRequestId();
			const handle = this.sendRequest({
				protocol: DICTATION_PROTOCOL_VERSION,
				type: "request",
				id: requestId,
				method: "stopAndTranscribe",
				params: {},
			});

			let cancellationRequested = false;
			let cancellationTimer: NodeJS.Timeout | undefined;
			const requestCancellation = () => {
				if (cancellationRequested) return;
				cancellationRequested = true;
				this.sendCancellation(handle.state, requestId);
				cancellationTimer = setTimeout(() => {
					if (this.child === handle.state && this.pending.has(requestId)) {
						this.forceTerminate(handle.state, cancellationError(), false);
					}
				}, this.cancellationGraceMs);
			};
			signal?.addEventListener("abort", requestCancellation, { once: true });
			if (signal?.aborted) requestCancellation();

			try {
				const response = await handle.response;
				if (signal?.aborted) throw cancellationError();
				if (response.method !== "stopAndTranscribe") {
					throw new Error("Dictation helper returned the wrong transcription response");
				}
				return response.result;
			} finally {
				signal?.removeEventListener("abort", requestCancellation);
				if (cancellationTimer) clearTimeout(cancellationTimer);
			}
		});
	}

	shutdown(): Promise<void> {
		if (!this.shutdownPromise) this.shutdownPromise = this.performShutdown();
		return this.shutdownPromise;
	}

	private enqueue<T>(operation: () => Promise<T>): Promise<T> {
		const queuedAtVersion = this.failureVersion;
		const run = async () => {
			if (this.disposed) throw new Error("Dictation helper has been shut down");
			if (queuedAtVersion !== this.failureVersion) {
				throw (
					this.lastProcessFailure ??
					new Error("Dictation helper stopped before the operation could run")
				);
			}
			return operation();
		};
		const result = this.operationTail.then(run, run);
		this.operationTail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	private allocateRequestId(): number {
		const id = this.nextRequestId;
		this.nextRequestId = this.nextRequestId === Number.MAX_SAFE_INTEGER ? 1 : id + 1;
		return id;
	}

	private startChild(): RunningChild {
		let child: ChildProcess;
		try {
			// VS Code's executable is Electron. Node mode plus an explicit argument list
			// avoids inheriting extension-host debugger/runtime flags.
			child = spawn(process.execPath, [this.helperPath], {
				env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
				stdio: ["ignore", "ignore", "pipe", "ipc"],
				serialization: "json",
				windowsHide: true,
			});
		} catch (error) {
			const failure = new Error(`Could not start dictation helper: ${toError(error).message}`);
			this.recordProcessFailure(failure, true);
			throw failure;
		}

		let resolveExited: () => void = () => {};
		const exited = new Promise<void>((resolve) => {
			resolveExited = resolve;
		});
		const state: RunningChild = {
			process: child,
			stderr: "",
			expectedExit: false,
			exited,
			resolveExited,
		};
		this.child = state;

		child.stderr?.on("data", (chunk: unknown) => {
			state.stderr = appendStderr(state.stderr, chunk);
		});
		child.on("message", (message: unknown) => this.handleMessage(state, message));
		child.once("error", (error) => {
			state.resolveExited();
			if (this.child !== state) return;
			const failure = new Error(`Dictation helper process error: ${error.message}`);
			this.invalidateChild(state, failure, !state.expectedExit && !this.disposed);
			this.killProcess(state);
		});
		child.once("exit", (code, signal) => {
			state.resolveExited();
			if (this.child !== state) return;
			this.invalidateChild(
				state,
				exitError(state, code, signal),
				!state.expectedExit && !this.disposed,
			);
		});
		return state;
	}

	private sendControlRequest(request: DictationRequest): RequestHandle {
		const handle = this.sendRequest(request);
		const timer = setTimeout(() => {
			if (this.child !== handle.state || !this.pending.has(handle.id)) return;
			this.forceTerminate(
				handle.state,
				new Error(
					`Dictation helper did not respond to ${request.method} within ${this.controlRequestTimeoutMs}ms`,
				),
				true,
			);
		}, this.controlRequestTimeoutMs);
		timer.unref();
		return {
			...handle,
			response: handle.response.finally(() => clearTimeout(timer)),
		};
	}

	private sendRequest(request: DictationRequest, requiredState?: RunningChild): RequestHandle {
		const state = requiredState ?? this.child ?? this.startChild();
		if (this.child !== state || !state.process.connected) {
			const error = new Error("Dictation helper IPC channel is not connected");
			if (this.child === state) {
				this.invalidateChild(state, error, !state.expectedExit && !this.disposed);
				this.killProcess(state);
			}
			return {
				id: request.id,
				state,
				response: Promise.reject(error),
			};
		}

		const response = new Promise<DictationSuccessResponse>((resolve, reject) => {
			this.pending.set(request.id, { method: request.method, resolve, reject });
			try {
				state.process.send(request, (error) => {
					if (!error || !this.pending.has(request.id) || this.child !== state) return;
					const failure = new Error(`Could not send request to dictation helper: ${error.message}`);
					this.invalidateChild(state, failure, !state.expectedExit && !this.disposed);
					this.killProcess(state);
				});
			} catch (error) {
				const failure = new Error(
					`Could not send request to dictation helper: ${toError(error).message}`,
				);
				this.invalidateChild(state, failure, !state.expectedExit && !this.disposed);
				this.killProcess(state);
			}
		});
		return { id: request.id, state, response };
	}

	private handleMessage(state: RunningChild, message: unknown): void {
		if (this.child !== state) return;
		const parsed = parseDictationResponse(message);
		if (!parsed.ok) {
			const failure = new Error(`Invalid response from dictation helper: ${parsed.error}`);
			this.invalidateChild(state, failure, !state.expectedExit && !this.disposed);
			this.killProcess(state);
			return;
		}

		const pending = this.pending.get(parsed.value.id);
		if (!pending || pending.method !== parsed.value.method) {
			const failure = new Error("Dictation helper returned an unexpected response");
			this.invalidateChild(state, failure, !state.expectedExit && !this.disposed);
			this.killProcess(state);
			return;
		}
		this.pending.delete(parsed.value.id);
		if (parsed.value.ok) {
			pending.resolve(parsed.value);
		} else {
			pending.reject(remoteError(parsed.value.error.name, parsed.value.error.message));
		}
	}

	private sendCancellation(state: RunningChild, requestId: number): void {
		if (this.child !== state || !state.process.connected) return;
		const handle = this.sendRequest(
			{
				protocol: DICTATION_PROTOCOL_VERSION,
				type: "request",
				id: this.allocateRequestId(),
				method: "cancelTranscription",
				params: { requestId },
			},
			state,
		);
		void handle.response.catch(() => undefined);
	}

	private recordProcessFailure(error: Error, notify: boolean): void {
		this.failureVersion += 1;
		this.lastProcessFailure = error;
		if (!notify) return;
		for (const listener of this.failureListeners) {
			try {
				listener(error);
			} catch {
				// A status listener must not interfere with process cleanup.
			}
		}
	}

	private invalidateChild(state: RunningChild, error: Error, notify: boolean): void {
		if (this.child !== state) return;
		this.child = undefined;
		for (const pending of this.pending.values()) pending.reject(error);
		this.pending.clear();
		this.recordProcessFailure(error, notify);
	}

	private forceTerminate(state: RunningChild, error: Error, notify: boolean): void {
		if (this.child !== state) return;
		state.expectedExit = true;
		this.invalidateChild(state, error, notify);
		this.killProcess(state);
	}

	private killProcess(state: RunningChild): void {
		try {
			state.process.kill("SIGKILL");
		} catch {
			// The process may already have exited between the IPC failure and cleanup.
		}
	}

	private async waitForExit(state: RunningChild, timeoutMs: number): Promise<boolean> {
		let timer: NodeJS.Timeout | undefined;
		const timedOut = new Promise<false>((resolve) => {
			timer = setTimeout(() => resolve(false), timeoutMs);
		});
		const exited = state.exited.then(() => true as const);
		try {
			return await Promise.race([exited, timedOut]);
		} finally {
			if (timer) clearTimeout(timer);
		}
	}

	private async performShutdown(): Promise<void> {
		this.disposed = true;
		const state = this.child;
		if (state) {
			state.expectedExit = true;
			const handle = this.sendRequest(
				{
					protocol: DICTATION_PROTOCOL_VERSION,
					type: "request",
					id: this.allocateRequestId(),
					method: "shutdown",
					params: {},
				},
				state,
			);
			void handle.response.catch(() => undefined);

			if (!(await this.waitForExit(state, this.shutdownGraceMs)) && this.child === state) {
				this.forceTerminate(
					state,
					new Error(`Dictation helper did not shut down within ${this.shutdownGraceMs}ms`),
					false,
				);
				if (!(await this.waitForExit(state, this.forceKillWaitMs))) {
					try {
						if (state.process.connected) state.process.disconnect();
					} catch {
						// The IPC channel may have closed while the force-kill timer elapsed.
					}
					state.process.unref();
				}
			}
		}
		await this.operationTail;
	}
}
