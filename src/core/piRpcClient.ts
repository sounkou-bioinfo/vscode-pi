import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import {
	isRpcResponse,
	JsonLineDecoder,
	parseRpcLine,
	type JsonObject,
	type RpcRequest,
	type RpcResponse,
} from "./rpcProtocol.js";

export interface PiRpcClientOptions {
	executable: string;
	arguments?: readonly string[];
	cwd: string;
	environment?: NodeJS.ProcessEnv;
	requestTimeoutMs?: number;
	log?: (message: string) => void;
}

interface PendingRequest {
	command: string;
	resolve: (response: RpcResponse) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
}

export class PiRpcError extends Error {
	constructor(
		message: string,
		readonly command?: string,
	) {
		super(message);
		this.name = "PiRpcError";
	}
}

export class PiRpcClient {
	private readonly events = new EventEmitter();
	private readonly pending = new Map<string, PendingRequest>();
	private readonly requestTimeoutMs: number;
	private process: ChildProcessWithoutNullStreams | undefined;
	private stopping = false;
	private finished = true;

	constructor(private readonly options: PiRpcClientOptions) {
		this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
	}

	get running(): boolean {
		return this.process !== undefined;
	}

	onEvent(listener: (event: JsonObject) => void): () => void {
		this.events.on("event", listener);
		return () => this.events.off("event", listener);
	}

	onExit(listener: (error: Error | undefined) => void): () => void {
		this.events.on("exit", listener);
		return () => this.events.off("exit", listener);
	}

	start(): void {
		if (this.process) return;
		this.stopping = false;
		this.finished = false;
		const args = [...(this.options.arguments ?? []), "--mode", "rpc"];
		this.options.log?.(
			`Starting ${this.options.executable} ${args.join(" ")} in ${this.options.cwd}`,
		);

		let child: ChildProcessWithoutNullStreams;
		try {
			child = spawn(this.options.executable, args, {
				cwd: this.options.cwd,
				env: this.options.environment ?? process.env,
				stdio: ["pipe", "pipe", "pipe"],
				windowsHide: true,
			});
		} catch (error) {
			this.finished = true;
			throw error;
		}
		this.process = child;

		const decoder = new JsonLineDecoder();
		child.stdout.on("data", (chunk: Buffer) => {
			try {
				for (const line of decoder.push(chunk)) this.handleLine(line);
			} catch (error) {
				this.failProcess(toError(error));
			}
		});
		child.stdout.on("end", () => {
			try {
				for (const line of decoder.end()) this.handleLine(line);
			} catch (error) {
				this.failProcess(toError(error));
			}
		});
		child.stderr.on("data", (chunk: Buffer) => {
			const text = chunk.toString("utf8").trimEnd();
			if (text) this.options.log?.(`[pi stderr] ${text}`);
		});
		const handleProcessError = (error: Error) =>
			this.finish(this.stopping ? undefined : error);
		child.stdin.on("error", handleProcessError);
		child.stdout.on("error", handleProcessError);
		child.stderr.on("error", handleProcessError);
		child.on("error", handleProcessError);
		child.on("exit", (code, signal) => {
			const error =
				this.stopping || code === 0
					? undefined
					: new PiRpcError(
							`Pi RPC process exited with ${signal ? `signal ${signal}` : `code ${code}`}`,
						);
			this.finish(error);
		});
	}

	async request<T = unknown>(request: RpcRequest): Promise<RpcResponse<T>> {
		if (!this.process) throw new PiRpcError("Pi RPC process is not running", request.type);
		const id = request.id ?? randomUUID();
		if (this.pending.has(id)) throw new PiRpcError(`Duplicate RPC request id: ${id}`);

		return new Promise<RpcResponse<T>>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new PiRpcError(`Pi RPC request timed out: ${request.type}`, request.type));
			}, this.requestTimeoutMs);
			this.pending.set(id, {
				command: request.type,
				resolve: resolve as (response: RpcResponse) => void,
				reject,
				timer,
			});

			try {
				this.write({ ...request, id });
			} catch (error) {
				clearTimeout(timer);
				this.pending.delete(id);
				reject(toError(error));
			}
		});
	}

	write(message: JsonObject): void {
		const child = this.process;
		if (!child?.stdin.writable || child.stdin.destroyed) {
			throw new PiRpcError("Pi RPC stdin is not writable");
		}
		child.stdin.write(`${JSON.stringify(message)}\n`, "utf8");
	}

	async stop(): Promise<void> {
		const child = this.process;
		if (!child) return;
		this.stopping = true;
		const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
		child.stdin.end();
		if (child.exitCode === null && child.signalCode === null) child.kill();
		this.rejectPending(new PiRpcError("Pi RPC process stopped"));

		await waitFor(exited, 2_000);
		if (this.process === child && child.exitCode === null && child.signalCode === null) {
			child.kill("SIGKILL");
			await waitFor(exited, 1_000);
		}
		if (this.process === child) this.finish(undefined);
	}

	private handleLine(line: string): void {
		let value: JsonObject;
		try {
			value = parseRpcLine(line);
		} catch (error) {
			throw new PiRpcError(`Invalid Pi RPC output: ${toError(error).message}`);
		}

		if (isRpcResponse(value)) {
			if (typeof value.id !== "string") {
				throw new PiRpcError(`Uncorrelated Pi RPC response for ${value.command}`);
			}
			const pending = this.pending.get(value.id);
			if (!pending) {
				throw new PiRpcError(`Unexpected Pi RPC response id: ${value.id}`);
			}
			this.pending.delete(value.id);
			clearTimeout(pending.timer);
			if (value.success) pending.resolve(value);
			else {
				pending.reject(
					new PiRpcError(
						typeof value.error === "string"
							? value.error
							: `Pi RPC command failed: ${pending.command}`,
						pending.command,
					),
				);
			}
			return;
		}
		this.events.emit("event", value);
	}

	private failProcess(error: Error): void {
		this.options.log?.(error.message);
		const child = this.process;
		if (child && child.exitCode === null && child.signalCode === null) child.kill();
		this.finish(error);
	}

	private finish(error: Error | undefined): void {
		if (this.finished) return;
		this.finished = true;
		this.process = undefined;
		this.rejectPending(error ?? new PiRpcError("Pi RPC process exited"));
		this.events.emit("exit", error);
	}

	private rejectPending(error: Error): void {
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.pending.clear();
	}
}

function toError(value: unknown): Error {
	return value instanceof Error ? value : new Error(String(value));
}

function waitFor(promise: Promise<void>, timeoutMs: number): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, timeoutMs);
		void promise.then(() => {
			clearTimeout(timer);
			resolve();
		});
	});
}
