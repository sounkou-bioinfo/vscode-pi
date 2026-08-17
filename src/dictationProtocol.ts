export const DICTATION_PROTOCOL_VERSION = 1 as const;

export interface SelectedMicrophone {
	name: string;
	occurrence: number;
}

export interface StartRecordingOptions {
	modelPath: string;
	language?: string;
	microphone?: SelectedMicrophone;
}

export type DictationMethod =
	| "getAvailableMicrophones"
	| "startRecording"
	| "stopAndTranscribe"
	| "cancelTranscription"
	| "shutdown";

interface RequestBase {
	protocol: typeof DICTATION_PROTOCOL_VERSION;
	type: "request";
	id: number;
}

export type DictationRequest =
	| (RequestBase & {
			method: "getAvailableMicrophones";
			params: Record<string, never>;
	  })
	| (RequestBase & {
			method: "startRecording";
			params: StartRecordingOptions;
	  })
	| (RequestBase & {
			method: "stopAndTranscribe";
			params: Record<string, never>;
	  })
	| (RequestBase & {
			method: "cancelTranscription";
			params: { requestId: number };
	  })
	| (RequestBase & {
			method: "shutdown";
			params: Record<string, never>;
	  });

interface ResponseBase {
	protocol: typeof DICTATION_PROTOCOL_VERSION;
	type: "response";
	id: number;
}

export type DictationSuccessResponse =
	| (ResponseBase & {
			method: "getAvailableMicrophones";
			ok: true;
			result: { microphones: string[] };
	  })
	| (ResponseBase & {
			method: "startRecording";
			ok: true;
			result: { started: true };
	  })
	| (ResponseBase & {
			method: "stopAndTranscribe";
			ok: true;
			result: { text: string; sampleCount: number; sampleRate: number };
	  })
	| (ResponseBase & {
			method: "cancelTranscription";
			ok: true;
			result: { cancelled: boolean };
	  })
	| (ResponseBase & {
			method: "shutdown";
			ok: true;
			result: { shuttingDown: true };
	  });

export interface DictationErrorResponse extends ResponseBase {
	method: DictationMethod;
	ok: false;
	error: {
		name: string;
		message: string;
	};
}

export type DictationResponse = DictationSuccessResponse | DictationErrorResponse;

export type ParseResult<T> =
	| { ok: true; value: T }
	| { ok: false; error: string };

function accepted<T>(value: T): ParseResult<T> {
	return { ok: true, value };
}

function rejected<T>(error: string): ParseResult<T> {
	return { ok: false, error };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRequestId(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isCount(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isEmptyRecord(value: unknown): value is Record<string, never> {
	return isRecord(value) && Object.keys(value).length === 0;
}

function isMethod(value: unknown): value is DictationMethod {
	return (
		value === "getAvailableMicrophones" ||
		value === "startRecording" ||
		value === "stopAndTranscribe" ||
		value === "cancelTranscription" ||
		value === "shutdown"
	);
}

function parseSelectedMicrophone(value: unknown): ParseResult<SelectedMicrophone | undefined> {
	if (value === undefined) return accepted(undefined);
	if (!isRecord(value)) return rejected("microphone must be an object");
	if (typeof value.name !== "string" || value.name.trim().length === 0) {
		return rejected("microphone.name must be a non-empty string");
	}
	if (!isCount(value.occurrence)) {
		return rejected("microphone.occurrence must be a non-negative integer");
	}
	return accepted({ name: value.name, occurrence: value.occurrence });
}

function parseStartOptions(value: unknown): ParseResult<StartRecordingOptions> {
	if (!isRecord(value)) return rejected("startRecording params must be an object");
	if (typeof value.modelPath !== "string" || value.modelPath.trim().length === 0) {
		return rejected("modelPath must be a non-empty string");
	}
	if (value.language !== undefined && typeof value.language !== "string") {
		return rejected("language must be a string when provided");
	}
	const microphone = parseSelectedMicrophone(value.microphone);
	if (!microphone.ok) return microphone;
	return accepted({
		modelPath: value.modelPath,
		...(value.language === undefined ? {} : { language: value.language }),
		...(microphone.value === undefined ? {} : { microphone: microphone.value }),
	});
}

export function parseDictationRequest(value: unknown): ParseResult<DictationRequest> {
	if (!isRecord(value)) return rejected("request must be an object");
	if (value.protocol !== DICTATION_PROTOCOL_VERSION) {
		return rejected(`unsupported protocol version: ${String(value.protocol)}`);
	}
	if (value.type !== "request") return rejected("message type must be request");
	if (!isRequestId(value.id)) return rejected("request id must be a positive integer");
	if (!isMethod(value.method)) return rejected("unknown dictation method");

	const base = {
		protocol: DICTATION_PROTOCOL_VERSION,
		type: "request" as const,
		id: value.id,
	};
	switch (value.method) {
		case "getAvailableMicrophones":
		case "stopAndTranscribe":
		case "shutdown":
			if (!isEmptyRecord(value.params)) {
				return rejected(`${value.method} params must be an empty object`);
			}
			return accepted({ ...base, method: value.method, params: {} });
		case "startRecording": {
			const params = parseStartOptions(value.params);
			if (!params.ok) return params;
			return accepted({ ...base, method: value.method, params: params.value });
		}
		case "cancelTranscription":
			if (!isRecord(value.params) || !isRequestId(value.params.requestId)) {
				return rejected("cancelTranscription.requestId must be a positive integer");
			}
			return accepted({
				...base,
				method: value.method,
				params: { requestId: value.params.requestId },
			});
	}
}

function parseSuccessResponse(
	base: ResponseBase,
	method: DictationMethod,
	result: unknown,
): ParseResult<DictationSuccessResponse> {
	if (!isRecord(result)) return rejected(`${method} result must be an object`);
	switch (method) {
		case "getAvailableMicrophones":
			if (
				!Array.isArray(result.microphones) ||
				!result.microphones.every((item) => typeof item === "string")
			) {
				return rejected("getAvailableMicrophones result contains invalid devices");
			}
			return accepted({
				...base,
				method,
				ok: true,
				result: { microphones: [...result.microphones] },
			});
		case "startRecording":
			if (result.started !== true) return rejected("startRecording result is invalid");
			return accepted({ ...base, method, ok: true, result: { started: true } });
		case "stopAndTranscribe":
			if (
				typeof result.text !== "string" ||
				!isCount(result.sampleCount) ||
				!isCount(result.sampleRate) ||
				result.sampleRate === 0
			) {
				return rejected("stopAndTranscribe result is invalid");
			}
			return accepted({
				...base,
				method,
				ok: true,
				result: {
					text: result.text,
					sampleCount: result.sampleCount,
					sampleRate: result.sampleRate,
				},
			});
		case "cancelTranscription":
			if (typeof result.cancelled !== "boolean") {
				return rejected("cancelTranscription result is invalid");
			}
			return accepted({
				...base,
				method,
				ok: true,
				result: { cancelled: result.cancelled },
			});
		case "shutdown":
			if (result.shuttingDown !== true) return rejected("shutdown result is invalid");
			return accepted({ ...base, method, ok: true, result: { shuttingDown: true } });
	}
}

export function parseDictationResponse(value: unknown): ParseResult<DictationResponse> {
	if (!isRecord(value)) return rejected("response must be an object");
	if (value.protocol !== DICTATION_PROTOCOL_VERSION) {
		return rejected(`unsupported protocol version: ${String(value.protocol)}`);
	}
	if (value.type !== "response") return rejected("message type must be response");
	if (!isRequestId(value.id)) return rejected("response id must be a positive integer");
	if (!isMethod(value.method)) return rejected("response has an unknown method");

	const base = {
		protocol: DICTATION_PROTOCOL_VERSION,
		type: "response" as const,
		id: value.id,
	};
	if (value.ok === true) {
		return parseSuccessResponse(base, value.method, value.result);
	}
	if (value.ok !== false || !isRecord(value.error)) {
		return rejected("response must contain either a result or an error");
	}
	if (
		typeof value.error.name !== "string" ||
		value.error.name.length === 0 ||
		typeof value.error.message !== "string" ||
		value.error.message.length === 0
	) {
		return rejected("response error is invalid");
	}
	return accepted({
		...base,
		method: value.method,
		ok: false,
		error: { name: value.error.name, message: value.error.message },
	});
}
