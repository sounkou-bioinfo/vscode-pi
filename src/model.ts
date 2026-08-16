import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import * as vscode from "vscode";

// Recommended small model from the official pi-transcribe catalog at commit
// 45924bd491e5ee2655d4269aa504eab11e27a424.
const DEFAULT_MODEL = {
	name: "Canary 180M Flash",
	repository: "handy-computer/canary-180m-flash-gguf",
	revision: "b147f9dc52b59f0998e410540a84727bd86457fd",
	filename: "canary-180m-flash-Q8_0.gguf",
	size: 218_447_552,
	sha256: "e13c7f5d0952b056a027cfffec13e3a3a134d1608babed24f983568f141e297c",
} as const;

function modelUrl(): string {
	return `https://huggingface.co/${DEFAULT_MODEL.repository}/resolve/${DEFAULT_MODEL.revision}/${DEFAULT_MODEL.filename}`;
}

async function sha256(path: string): Promise<string> {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path)) {
		hash.update(chunk);
	}
	return hash.digest("hex");
}

async function validDefaultModel(path: string): Promise<boolean> {
	if (!existsSync(path)) return false;
	const info = await stat(path).catch(() => undefined);
	return info?.size === DEFAULT_MODEL.size && (await sha256(path)) === DEFAULT_MODEL.sha256;
}

async function downloadDefaultModel(destination: string): Promise<string> {
	await mkdir(dirname(destination), { recursive: true });
	if (await validDefaultModel(destination)) return destination;

	const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
	await rm(temporary, { force: true });

	try {
		await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: `Pi: Downloading ${DEFAULT_MODEL.name} (208 MiB)`,
				cancellable: true,
			},
			async (progress, token) => {
				const controller = new AbortController();
				token.onCancellationRequested(() => controller.abort());
				const response = await fetch(modelUrl(), { signal: controller.signal, redirect: "follow" });
				if (!response.ok || !response.body) {
					throw new Error(`Model download failed: HTTP ${response.status}`);
				}

				let downloaded = 0;
				let lastReported = 0;
				const counter = new Transform({
					transform(chunk: Buffer, _encoding, callback) {
						downloaded += chunk.byteLength;
						const completed = (downloaded / DEFAULT_MODEL.size) * 100;
						progress.report({
							increment: Math.max(0, completed - lastReported),
							message: `${Math.round(downloaded / (1024 * 1024))} / 208 MiB`,
						});
						lastReported = completed;
						callback(null, chunk);
					},
				});
				await pipeline(
					Readable.fromWeb(response.body as unknown as NodeReadableStream),
					counter,
					createWriteStream(temporary, { mode: 0o600 }),
				);
			},
		);

		const info = await stat(temporary);
		if (info.size !== DEFAULT_MODEL.size) {
			throw new Error(`Downloaded model has ${info.size} bytes; expected ${DEFAULT_MODEL.size}`);
		}
		if ((await sha256(temporary)) !== DEFAULT_MODEL.sha256) {
			throw new Error("Downloaded model failed its SHA-256 check");
		}
		await rm(destination, { force: true });
		await rename(temporary, destination);
		return destination;
	} catch (error) {
		await rm(temporary, { force: true });
		throw error;
	}
}

interface PiTranscribeSettings {
	model?: { path?: unknown };
	transcriptionLanguage?: unknown;
}

async function existingPiTranscribeModel(): Promise<{ path: string; language?: string } | undefined> {
	const agentDir = process.env.PI_CODING_AGENT_DIR || join(process.env.USERPROFILE || process.env.HOME || "", ".pi", "agent");
	if (!agentDir) return undefined;
	try {
		const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(join(agentDir, "pi-transcribe.json")));
		const parsed = JSON.parse(Buffer.from(bytes).toString("utf8")) as PiTranscribeSettings;
		const path = parsed.model?.path;
		if (typeof path !== "string" || !existsSync(path)) return undefined;
		return {
			path,
			language:
				typeof parsed.transcriptionLanguage === "string" && parsed.transcriptionLanguage !== "auto"
					? parsed.transcriptionLanguage
					: undefined,
		};
	} catch {
		return undefined;
	}
}

export interface DictationModel {
	path: string;
	language?: string;
}

export async function resolveDictationModel(
	context: vscode.ExtensionContext,
	forceSelection = false,
): Promise<DictationModel | undefined> {
	const configuration = vscode.workspace.getConfiguration("vscodePi.dictation");
	const configuredPath = configuration.get<string>("modelPath", "").trim();
	const configuredLanguage = configuration.get<string>("language", "en").trim();
	if (!forceSelection && configuredPath && existsSync(configuredPath)) {
		return { path: configuredPath, language: configuredLanguage || undefined };
	}

	if (!forceSelection) {
		const official = await existingPiTranscribeModel();
		if (official) return official;
	}

	const choice = await vscode.window.showQuickPick(
		[
			{
				label: `Download ${DEFAULT_MODEL.name}`,
				description: "208 MiB; English, German, Spanish, and French",
				value: "download" as const,
			},
			{
				label: "Choose an existing GGUF transcription model",
				value: "choose" as const,
			},
		],
		{ placeHolder: "Configure local Pi dictation" },
	);
	if (!choice) return undefined;

	let path: string | undefined;
	if (choice.value === "download") {
		path = await downloadDefaultModel(join(context.globalStorageUri.fsPath, "models", DEFAULT_MODEL.filename));
	} else {
		const selected = await vscode.window.showOpenDialog({
			defaultUri: vscode.Uri.file(process.env.USERPROFILE || process.env.HOME || context.globalStorageUri.fsPath),
			canSelectFiles: true,
			canSelectFolders: false,
			canSelectMany: false,
			filters: { "GGUF transcription models": ["gguf"] },
			openLabel: "Use transcription model",
		});
		path = selected?.[0]?.fsPath;
	}
	if (!path) return undefined;

	await configuration.update("modelPath", path, vscode.ConfigurationTarget.Global);
	return { path, language: configuredLanguage || undefined };
}

export async function configureDictationModel(
	context: vscode.ExtensionContext,
): Promise<void> {
	await resolveDictationModel(context, true);
}
