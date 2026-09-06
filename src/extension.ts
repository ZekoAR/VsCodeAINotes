import * as path from 'path';
import * as vscode from 'vscode';
import { NotesEditorPanel } from './notesEditor';
import { NotesWorkspace } from './notesWorkspace';
import { SidePanelProvider } from './sidePanel';
import { NotesStore } from './store';

let workspace: NotesWorkspace | undefined;

export function activate(context: vscode.ExtensionContext): void {
	const folder = vscode.workspace.workspaceFolders?.[0];
	if (!folder) {
		// Nothing to store notes beside. Register the commands anyway so they explain themselves.
		context.subscriptions.push(
			...['ainotes.newNote', 'ainotes.pickSession', 'ainotes.save', 'ainotes.openStoreFile'].map(
				id =>
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

	const openNote = (noteId: string) =>
		NotesEditorPanel.show(context.extensionUri, workspace!, noteId);

	const sidePanel = new SidePanelProvider(context.extensionUri, workspace, openNote);
	context.subscriptions.push(
		sidePanel,
		vscode.window.registerWebviewViewProvider(SidePanelProvider.viewType, sidePanel),
		vscode.commands.registerCommand('ainotes.newNote', () => {
			if (workspace) {
				openNote(workspace.createNote().id);
			}
		}),
		vscode.commands.registerCommand('ainotes.pickSession', () => {
			const noteId = NotesEditorPanel.activeNoteId;
			if (!noteId) {
				void vscode.window.showInformationMessage(
					'AI Notes: open a note editor first, then pick its session.'
				);
				return;
			}
			void workspace?.pickSession(noteId);
		}),
		vscode.commands.registerCommand('ainotes.save', () => workspace?.saveNow()),
		vscode.commands.registerCommand('ainotes.openStoreFile', async () => {
			workspace?.saveNow();
			const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(store.filePath));
			await vscode.window.showTextDocument(doc);
		}),
		// Without this a restored tab comes back dead: VS Code restores it either way, and only a
		// serializer can put the webview back inside it and tell it which note it was showing.
		vscode.window.registerWebviewPanelSerializer(NotesEditorPanel.viewType, {
			async deserializeWebviewPanel(panel: vscode.WebviewPanel, state: unknown): Promise<void> {
				if (workspace) {
					NotesEditorPanel.revive(panel, context.extensionUri, workspace, state);
				} else {
					panel.dispose();
				}
			}
		})
	);
}

export function deactivate(): void {
	// `dispose` flushes unsaved keystrokes; the subscription does the same on a normal shutdown.
	workspace?.dispose();
	workspace = undefined;
}
