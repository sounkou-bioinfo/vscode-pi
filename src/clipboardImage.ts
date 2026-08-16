import { execFile } from "node:child_process";

export interface ClipboardImage {
	bytes: Uint8Array;
	mimeType: "image/png";
}

const MAX_CLIPBOARD_IMAGE_BYTES = 32 * 1024 * 1024;
const MAX_PROCESS_OUTPUT_BYTES = Math.ceil((MAX_CLIPBOARD_IMAGE_BYTES * 4) / 3) + 1024 * 1024;
const PNG_SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const WINDOWS_CLIPBOARD_SCRIPT = [
	"Add-Type -AssemblyName System.Windows.Forms",
	"Add-Type -AssemblyName System.Drawing",
	"$image = [System.Windows.Forms.Clipboard]::GetImage()",
	"if ($null -eq $image) { [Console]::Error.Write('The clipboard does not contain an image.'); exit 3 }",
	"$stream = New-Object System.IO.MemoryStream",
	"try {",
	"  $image.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)",
	"  [Console]::Out.Write([Convert]::ToBase64String($stream.ToArray()))",
	"} finally { $stream.Dispose(); $image.Dispose() }",
].join("\n");

interface ProcessResult {
	stdout: Buffer;
	stderr: Buffer;
}

function run(
	command: string,
	args: readonly string[],
	options: { timeoutMs?: number } = {},
): Promise<ProcessResult> {
	return new Promise((resolve, reject) => {
		execFile(
			command,
			[...args],
			{
				encoding: "buffer",
				maxBuffer: MAX_PROCESS_OUTPUT_BYTES,
				timeout: options.timeoutMs ?? 8_000,
				windowsHide: true,
			},
			(error, stdout, stderr) => {
				if (error) {
					const detail = Buffer.from(stderr).toString("utf8").trim();
					reject(new Error(detail || error.message));
					return;
				}
				resolve({ stdout: Buffer.from(stdout), stderr: Buffer.from(stderr) });
			},
		);
	});
}

export function decodePngBase64(value: string): Uint8Array {
	const normalized = value.replace(/\s/g, "");
	if (!normalized) {
		throw new Error("The clipboard does not contain an image");
	}
	if (normalized.length > MAX_PROCESS_OUTPUT_BYTES) {
		throw new Error("The clipboard image exceeds the 32 MiB limit");
	}
	const bytes = Buffer.from(normalized, "base64");
	if (bytes.byteLength > MAX_CLIPBOARD_IMAGE_BYTES) {
		throw new Error("The clipboard image exceeds the 32 MiB limit");
	}
	if (
		bytes.byteLength < PNG_SIGNATURE.byteLength ||
		!PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)
	) {
		throw new Error("The clipboard image could not be converted to PNG");
	}
	return bytes;
}

async function readWindowsClipboardImage(): Promise<ClipboardImage> {
	const { stdout } = await run(
		"powershell.exe",
		["-NoLogo", "-NoProfile", "-NonInteractive", "-STA", "-Command", WINDOWS_CLIPBOARD_SCRIPT],
		{ timeoutMs: 10_000 },
	);
	return { bytes: decodePngBase64(stdout.toString("ascii")), mimeType: "image/png" };
}

async function readCommandPng(command: string, args: readonly string[]): Promise<ClipboardImage> {
	const { stdout } = await run(command, args);
	if (stdout.byteLength > MAX_CLIPBOARD_IMAGE_BYTES) {
		throw new Error("The clipboard image exceeds the 32 MiB limit");
	}
	return { bytes: decodePngBase64(stdout.toString("base64")), mimeType: "image/png" };
}

export async function readClipboardImage(platform: NodeJS.Platform = process.platform): Promise<ClipboardImage> {
	switch (platform) {
		case "win32":
			return readWindowsClipboardImage();
		case "darwin":
			return readCommandPng("pngpaste", ["-"]);
		case "linux":
			try {
				return await readCommandPng("wl-paste", ["--type", "image/png", "--no-newline"]);
			} catch {
				return readCommandPng("xclip", ["-selection", "clipboard", "-t", "image/png", "-o"]);
			}
		default:
			throw new Error(`Clipboard images are not supported on ${platform}`);
	}
}
