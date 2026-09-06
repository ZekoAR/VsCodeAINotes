import * as vscode from 'vscode';
import { makeNonce } from './notesEditor';
import { NotesWorkspace } from './notesWorkspace';

/** A message sent from the side panel's webview to the extension host. */
type InboundMessage =
	| { type: 'ready' }
	| { type: 'newNote' }
	| { type: 'openSession'; sessionId: string };

/**
 * The activity-bar panel: a "New Note Editor" button, and below it the Claude sessions you can open
 * a note editor for.
 *
 * A webview rather than a tree, because a tree cannot tell a double click from a single one - the
 * VS Code API has no double-click event at all, and `TreeItem.command` fires on selection.
 */
export class SidePanelProvider implements vscode.WebviewViewProvider {
	static readonly viewType = 'ainotes.sidePanel';

	private view: vscode.WebviewView | undefined;
	private readonly disposables: vscode.Disposable[] = [];

	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly workspace: NotesWorkspace,
		private readonly openNote: (noteId: string) => void
	) {
		// The list shows which sessions already have a note, so it repaints when notes change.
		this.disposables.push(this.workspace.onDidChange(() => this.postRows()));
	}

	resolveWebviewView(view: vscode.WebviewView): void {
		this.view = view;
		view.webview.options = {
			enableScripts: true,
			localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')]
		};
		view.webview.html = this.html(view.webview);

		view.webview.onDidReceiveMessage((message: InboundMessage) => {
			switch (message.type) {
				case 'ready':
					this.postRows();
					return;
				case 'newNote':
					this.openNote(this.workspace.createNote().id);
					return;
				case 'openSession':
					this.openNote(this.workspace.noteForSession(message.sessionId).id);
					return;
			}
		});

		view.onDidChangeVisibility(() => {
			if (view.visible) {
				this.postRows();
			}
		});
	}

	private postRows(): void {
		if (!this.view?.visible) {
			return;
		}
		void this.view.webview.postMessage({ type: 'rows', rows: this.workspace.sidePanelRows() });
	}

	dispose(): void {
		for (const disposable of this.disposables) {
			disposable.dispose();
		}
	}

	private html(webview: vscode.Webview): string {
		const nonce = makeNonce();
		const styleUri = webview.asWebviewUri(
			vscode.Uri.joinPath(this.extensionUri, 'media', 'main.css')
		);
		const scriptUri = webview.asWebviewUri(
			vscode.Uri.joinPath(this.extensionUri, 'media', 'side.js')
		);
		return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${styleUri}" rel="stylesheet">
<title>AI Notes</title>
</head>
<body class="side">
<div class="side-top">
  <button id="new" class="primary wide" type="button">New Note Editor</button>
</div>
<div id="rows" class="side-list" role="listbox" tabindex="-1"></div>
<div class="side-hint">Double-click a session to open its notes</div>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
	}
}
