import * as path from 'path';
import * as vscode from 'vscode';
import { NotesWorkspace } from './notesWorkspace';
import { SidePanelProvider } from './sidePanel';
import { NotesStore } from './store';

let workspace: NotesWorkspace | undefined;

export function activate(context: vscode.ExtensionContext): void {
	const folder = vscode.workspace.workspaceFolders?.[0];
	if (!folder) {
		// Nothing to store notes beside. Register the side panel anyway: a view whose provider never
		// registers shows a loading bar forever, and VS Code restarts the extension host when a
		// folder is opened into this window, so activation runs again with one.
		const emptyPanel = new SidePanelProvider(context.extensionUri, undefined);
		context.subscriptions.push(
			emptyPanel,
			vscode.window.registerWebviewViewProvider(SidePanelProvider.viewType, emptyPanel, {
				webviewOptions: { retainContextWhenHidden: true }
			})
		);
		// Register the commands anyway so they explain themselves.
		context.subscriptions.push(
			...['ainotes.save', 'ainotes.openStoreFile'].map(id =>
				vscode.commands.registerCommand(id, () =>
					vscode.window.showInformationMessage(
						'AI Notes needs an open folder to store its notes file.'
					)
				)
			)
		);
		return;
	}

	const fileName = vscode.workspace
		.getConfiguration('ainotes')
		.get<string>('storeFileName', '.ainotes.json');
	const store = new NotesStore(path.join(folder.uri.fsPath, fileName));
	workspace = new NotesWorkspace(store, folder.uri.fsPath);
	context.subscriptions.push(workspace);

	// Notes live in panels injected into the Claude tabs themselves, so the side panel is both the
	// window's status display and the relay those panels reach the notes file through.
	const sidePanel = new SidePanelProvider(context.extensionUri, workspace, context.workspaceState);

	context.subscriptions.push(
		sidePanel,
		// The side panel is the only road between a panel injected into a Claude tab and the notes
		// file, so its webview has to survive the view being hidden. Without this, selecting any
		// other view container disposes it and every injected panel goes mute - measured, a stuck
		// panel reporting `sidePanelFrames: 0` while the Claude Code view held the sidebar.
		vscode.window.registerWebviewViewProvider(SidePanelProvider.viewType, sidePanel, {
			webviewOptions: { retainContextWhenHidden: true }
		}),
		vscode.commands.registerCommand('ainotes.save', () => workspace?.saveNow()),
		vscode.commands.registerCommand('ainotes.openStoreFile', async () => {
			workspace?.saveNow();
			const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(store.filePath));
			await vscode.window.showTextDocument(doc);
		})
	);
}

export function deactivate(): void {
	// `dispose` flushes unsaved keystrokes; the subscription does the same on a normal shutdown.
	workspace?.dispose();
	workspace = undefined;
}
