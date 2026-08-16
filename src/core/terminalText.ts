const TERMINAL_CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;

/**
 * Terminal.sendText() writes directly to a pseudo-terminal. Keep generated text
 * on one line and remove control bytes so neither a transcript nor a path can
 * inject terminal control sequences.
 */
export function sanitizeTerminalInsertion(value: string): string {
	return value
		.replace(/\r\n?|\n/g, " ")
		.replace(TERMINAL_CONTROL_CHARACTERS, "")
		.replace(/[\t ]+/g, " ")
		.trim();
}

export function formatPathInsertion(path: string): string {
	if (!path) {
		throw new Error("The attachment path is empty");
	}
	if (path !== path.replace(/\r\n?|\n/g, "").replace(TERMINAL_CONTROL_CHARACTERS, "")) {
		throw new Error("The attachment path contains terminal control characters");
	}
	return `${path} `;
}
