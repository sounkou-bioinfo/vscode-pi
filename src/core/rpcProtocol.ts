import { StringDecoder } from "node:string_decoder";
import { isJsonObject, type JsonObject } from "./json.js";

export { isJsonObject, type JsonObject } from "./json.js";

export interface RpcResponse<T = unknown> extends JsonObject {
	type: "response";
	command: string;
	success: boolean;
	id?: string;
	data?: T;
	error?: string;
}

export interface RpcRequest extends JsonObject {
	type: string;
	id?: string;
}

export function isRpcResponse(value: unknown): value is RpcResponse {
	return (
		isJsonObject(value) &&
		value.type === "response" &&
		typeof value.command === "string" &&
		typeof value.success === "boolean"
	);
}

export function parseRpcLine(line: string): JsonObject {
	const normalized = line.endsWith("\r") ? line.slice(0, -1) : line;
	const value: unknown = JSON.parse(normalized);
	if (!isJsonObject(value)) throw new Error("Pi RPC line must contain a JSON object");
	return value;
}

/** Strict LF-delimited UTF-8 decoder for Pi's JSONL protocol. */
export class JsonLineDecoder {
	private readonly decoder = new StringDecoder("utf8");
	private buffered = "";

	constructor(private readonly maxBufferedBytes = 16 * 1024 * 1024) {
		if (!Number.isSafeInteger(maxBufferedBytes) || maxBufferedBytes <= 0) {
			throw new Error("maxBufferedBytes must be a positive safe integer");
		}
	}

	push(chunk: Buffer | Uint8Array | string): string[] {
		this.buffered +=
			typeof chunk === "string" ? chunk : this.decoder.write(Buffer.from(chunk));
		this.assertBounded();
		return this.takeCompleteLines();
	}

	end(): string[] {
		this.buffered += this.decoder.end();
		this.assertBounded();
		const lines = this.takeCompleteLines();
		if (this.buffered.length > 0) {
			throw new Error("Pi RPC stream ended with an incomplete JSONL line");
		}
		return lines;
	}

	private takeCompleteLines(): string[] {
		const lines: string[] = [];
		let newline = this.buffered.indexOf("\n");
		while (newline >= 0) {
			const line = this.buffered.slice(0, newline);
			this.buffered = this.buffered.slice(newline + 1);
			lines.push(line);
			newline = this.buffered.indexOf("\n");
		}
		return lines;
	}

	private assertBounded(): void {
		if (Buffer.byteLength(this.buffered, "utf8") > this.maxBufferedBytes) {
			throw new Error(
				`Pi RPC line exceeds ${this.maxBufferedBytes} buffered bytes`,
			);
		}
	}
}
