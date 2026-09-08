import * as path from 'path';
import * as vscode from 'vscode';
import { ClaudeTabTracker, SessionResolution } from './claudeTabs';
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
			...[
				'ainotes.newNote',
				'ainotes.pickSession',
				'ainotes.bindActiveSession',
				'ainotes.save',
				'ainotes.openStoreFile'
			].map(
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

	const claudeTabs = new ClaudeTabTracker();

	/**
	 * Which Claude session this window is working with.
	 *
	 * The caption of the active Claude tab first, because that is the tab the reader is looking at.
	 * Failing that, the one session running in this folder, which is both the common case and the
	 * answer at startup, when a restored Claude tab is still captioned "Claude Code" because its
	 * session has not been titled yet.
	 */
	const resolveSession = (): SessionResolution => {
		const label = claudeTabs.target();
		const byLabel = label ? workspace?.sessionIdForLabel(label) : undefined;
		if (byLabel) {
			return { sessionId: byLabel };
		}
		const sole = workspace?.soleLiveSessionId();
		if (sole) {
			return { sessionId: sole };
		}
		return {
			problem: !claudeTabs.anyOpen()
				? 'no Claude Code tab is open.'
				: label
					? `could not tell which session "${label}" is.`
					: 'could not tell which Claude tab to use.'
		};
	};

	const openNote = (noteId: string) =>
		NotesEditorPanel.show(context.extensionUri, workspace!, noteId, resolveSession);

	const sidePanel = new SidePanelProvider(context.extensionUri, workspace, openNote);

	/** The editor a session command acts on, with the message that explains an empty answer. */
	const targetPanel = (): NotesEditorPanel | undefined => {
		const panel = NotesEditorPanel.active();
		if (!panel) {
			void vscode.window.showInformationMessage(
				'AI Notes: open a note editor first, then pick its session.'
			);
		}
		return panel;
	};

	context.subscriptions.push(
		sidePanel,
		claudeTabs,
		vscode.window.registerWebviewViewProvider(SidePanelProvider.viewType, sidePanel),
		vscode.commands.registerCommand('ainotes.newNote', () => {
			if (workspace) {
				openNote(workspace.createNote().id);
			}
		}),
		vscode.commands.registerCommand('ainotes.pickSession', () => {
			void targetPanel()?.askForSession();
		}),
		// The drop event a Claude tab dragged into this editor delivers is empty - VS Code writes no
		// resource for a webview editor, and webviews are not a documented drop target at all - so
		// the tab is identified out of band instead, by the caption it is showing.
		vscode.commands.registerCommand('ainotes.bindActiveSession', () => {
			targetPanel()?.bindActive();
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
					NotesEditorPanel.revive(panel, context.extensionUri, workspace, state, resolveSession);
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
