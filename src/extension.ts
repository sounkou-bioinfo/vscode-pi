import * as vscode from "vscode";
import { configureDictationModel } from "./model.js";
import { pasteClipboardImageIntoTerminal } from "./terminalBridge.js";

type DictationController = import("./dictation.js").DictationController;

let dictation: DictationController | undefined;
let loadingDictation: Promise<DictationController> | undefined;

function showError(error: unknown): void {
	const message = error instanceof Error ? error.message : String(error);
	void vscode.window.showErrorMessage(`Pi: ${message}`);
}

function command<Arguments extends unknown[]>(
	handler: (...args: Arguments) => void | Promise<void>,
): (...args: Arguments) => void {
	return (...args) => {
		try {
			void Promise.resolve(handler(...args)).catch(showError);
		} catch (error) {
			showError(error);
		}
	};
}

function getDictation(context: vscode.ExtensionContext): Promise<DictationController> {
	if (dictation) return Promise.resolve(dictation);
	if (loadingDictation) return loadingDictation;
	const loading = import("./dictation.js")
		.then(({ DictationController: Controller }) => {
			dictation = new Controller(context);
			return dictation;
		})
		.finally(() => {
			if (loadingDictation === loading) loadingDictation = undefined;
		});
	loadingDictation = loading;
	return loading;
}

export function activate(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		{ dispose: () => dictation?.dispose() },
		vscode.commands.registerCommand(
			"vscodePi.pasteImageIntoTerminal",
			command((terminal?: vscode.Terminal) => pasteClipboardImageIntoTerminal(terminal)),
		),
		vscode.commands.registerCommand(
			"vscodePi.toggleDictation",
			command(async (terminal?: vscode.Terminal) => (await getDictation(context)).toggle(terminal)),
		),
		vscode.commands.registerCommand(
			"vscodePi.selectMicrophone",
			command(async () => (await getDictation(context)).selectMicrophone()),
		),
		vscode.commands.registerCommand(
			"vscodePi.configureDictationModel",
			command(() => configureDictationModel(context)),
		),
	);
}

export async function deactivate(): Promise<void> {
	const controller = dictation ?? (await loadingDictation?.catch(() => undefined));
	dictation = undefined;
	loadingDictation = undefined;
	await controller?.shutdown();
}
