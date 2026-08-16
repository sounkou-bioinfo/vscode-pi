import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import * as vscode from "vscode";
import { readClipboardImage } from "./clipboardImage.js";
import { formatPathInsertion, sanitizeTerminalInsertion } from "./core/terminalText.js";

function selectedTerminal(preferred?: vscode.Terminal): vscode.Terminal {
	const terminal =
		preferred && vscode.window.terminals.includes(preferred)
			? preferred
			: vscode.window.activeTerminal;
	if (!terminal) {
		throw new Error("Open and focus the terminal running Pi first");
	}
	return terminal;
}

function ensureTerminalIsOpen(terminal: vscode.Terminal): void {
	if (!vscode.window.terminals.includes(terminal)) {
		throw new Error("The Pi terminal was closed before input could be inserted");
	}
}

function remoteBaseUri(): vscode.Uri | undefined {
	return (
		vscode.workspace.workspaceFolders?.[0]?.uri ??
		vscode.window.activeTextEditor?.document.uri
	);
}

const ATTACHMENT_PREFIX = "vscode-pi-clipboard-";
const ATTACHMENT_LIFETIME_MS = 24 * 60 * 60 * 1_000;

function attachmentTarget(fileName: string): { uri: vscode.Uri; terminalPath: string } {
	if (!vscode.env.remoteName) {
		const path = join(tmpdir(), fileName);
		return { uri: vscode.Uri.file(path), terminalPath: path };
	}

	const base = remoteBaseUri();
	if (!base || base.scheme !== "vscode-remote") {
		throw new Error("Open a folder on the remote host before pasting an image");
	}

	const uri = base.with({
		path: posix.join("/tmp", fileName),
		query: "",
		fragment: "",
	});
	return { uri, terminalPath: uri.path };
}

function attachmentDirectory(uri: vscode.Uri): vscode.Uri {
	return uri.scheme === "file"
		? vscode.Uri.file(dirname(uri.fsPath))
		: uri.with({ path: posix.dirname(uri.path), query: "", fragment: "" });
}

async function deleteStaleAttachments(directory: vscode.Uri): Promise<void> {
	const cutoff = Date.now() - ATTACHMENT_LIFETIME_MS;
	let entries: [string, vscode.FileType][];
	try {
		entries = await vscode.workspace.fs.readDirectory(directory);
	} catch {
		return;
	}
	await Promise.all(
		entries
			.filter(([name, type]) => name.startsWith(ATTACHMENT_PREFIX) && type === vscode.FileType.File)
			.map(async ([name]) => {
				const uri = vscode.Uri.joinPath(directory, name);
				try {
					const info = await vscode.workspace.fs.stat(uri);
					if (info.mtime > 0 && info.mtime < cutoff) {
						await vscode.workspace.fs.delete(uri);
					}
				} catch {
					// Cleanup is best-effort; attachment insertion must still proceed.
				}
			}),
	);
}

function scheduleAttachmentDeletion(uri: vscode.Uri): void {
	const timer = setTimeout(() => {
		void (async () => {
			try {
				await vscode.workspace.fs.delete(uri);
			} catch {
				// A closed remote or an already-removed file needs no follow-up.
			}
		})();
	}, ATTACHMENT_LIFETIME_MS);
	timer.unref();
}

export async function pasteClipboardImageIntoTerminal(
	preferredTerminal?: vscode.Terminal,
): Promise<void> {
	const terminal = selectedTerminal(preferredTerminal);
	await vscode.window.withProgress(
		{
			location: vscode.ProgressLocation.Notification,
			title: "Pi: Reading clipboard image",
			cancellable: false,
		},
		async () => {
			const image = await readClipboardImage();
			const target = attachmentTarget(`${ATTACHMENT_PREFIX}${randomUUID()}.png`);
			await deleteStaleAttachments(attachmentDirectory(target.uri));
			if (target.uri.scheme === "file") {
				await writeFile(target.uri.fsPath, image.bytes, { mode: 0o600 });
			} else {
				await vscode.workspace.fs.writeFile(target.uri, image.bytes);
			}
			scheduleAttachmentDeletion(target.uri);
			ensureTerminalIsOpen(terminal);
			terminal.sendText(formatPathInsertion(target.terminalPath), false);
		},
	);
}

export function insertTranscript(terminal: vscode.Terminal, transcript: string): void {
	ensureTerminalIsOpen(terminal);
	const text = sanitizeTerminalInsertion(transcript);
	if (!text) {
		throw new Error("No speech was detected");
	}
	terminal.sendText(`${text} `, false);
}
