import * as vscode from "vscode";
import { PiViewProvider } from "./piViewProvider.js";

export function activate(context: vscode.ExtensionContext): void {
	const output = vscode.window.createOutputChannel("Pi");
	const provider = new PiViewProvider(context.extensionUri, output);

	context.subscriptions.push(
		output,
		provider,
		vscode.window.registerWebviewViewProvider(PiViewProvider.viewType, provider, {
			webviewOptions: { retainContextWhenHidden: true },
		}),
		vscode.commands.registerCommand("vscodePi.newSession", () => provider.newSession()),
		vscode.commands.registerCommand("vscodePi.restartBackend", () => provider.restart()),
		vscode.commands.registerCommand("vscodePi.abort", () => provider.abort()),
	);
}

export function deactivate(): void {}
