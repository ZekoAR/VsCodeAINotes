import * as path from 'path';
import * as vscode from 'vscode';
import { NotesWorkspace } from './notesWorkspace';

const EDITOR_VIEW_TYPE = 'ainotes.editor';

/** A message sent from a note editor's webview to the extension host. */
type InboundMessage =
	| { type: 'ready' }
	| { type: 'input'; text: string }
	| { type: 'save' }
	| { type: 'requestSessions' }
	| { type: 'selectSession'; sessionId: string };

/** The rendered webview of one note editor, wired to its note. */
class NotesSurface {
	private readonly disposables: vscode.Disposable[] = [];

	constructor(
		private readonly webview: vscode.Webview,
		extensionUri: vscode.Uri,
		private readonly workspace: NotesWorkspace,
		private readonly noteId: string
	) {
		webview.options = {
			enableScripts: true,
			localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')]
		};
		webview.html = renderHtml(webview, extensionUri);

		this.disposables.push(
			webview.onDidReceiveMessage((message: InboundMessage) => this.handle(message)),
			this.workspace.onDidChange(change => {
				if (change.noteId !== undefined && change.noteId !== this.noteId) {
					return;
				}
				// A change from ANOTHER surface on this note must replace this one's text; a change
				// this surface typed itself must not, or the caret jumps to the end per keystroke.
				this.post(change.textChanged && change.origin !== this);
			})
		);
	}

	post(replaceText: boolean): void {
		const note = this.workspace.note(this.noteId);
		if (!note) {
			return;
		}
		void this.webview.postMessage({
			type: 'state',
			noteId: this.noteId,
			replaceText,
			text: note.text,
			session: note.session,
			// Resolved by the workspace so the tab title and the panel agree.
			sessionLabel: this.workspace.labelFor(this.noteId),
			readOnly: this.workspace.isReadOnly(this.noteId),
			updatedAt: note.updatedAt,
			dirty: this.workspace.isDirty,
			fileName: path.basename(this.workspace.filePath)
		});
	}

	private handle(message: InboundMessage): void {
		switch (message.type) {
			case 'ready':
				this.post(true);
				return;
			case 'input':
				this.workspace.setText(this.noteId, message.text, this);
				return;
			case 'save':
				this.workspace.saveNow();
				return;
			case 'requestSessions':
				void this.webview.postMessage({
					type: 'sessions',
					sessions: this.workspace.listSessions()
				});
				return;
			case 'selectSession':
				this.workspace.bind(this.noteId, message.sessionId);
				return;
		}
	}

	dispose(): void {
		for (const disposable of this.disposables) {
			disposable.dispose();
		}
		this.disposables.length = 0;
	}
}

/**
 * One note, as a webview EDITOR rather than a view.
 *
 * The editor area hosts editors and nothing else, which is why this is an editor - it is the only
 * way notes can be docked above, below or beside another tab, split across groups, or floated into
 * their own window, the way a Claude Code tab can. One panel per note: opening a note that is
 * already open reveals its tab rather than a duplicate that would fight it over the same text.
 */
export class NotesEditorPanel {
	static readonly viewType = EDITOR_VIEW_TYPE;

	private static readonly open = new Map<string, NotesEditorPanel>();

	/** The note whose editor currently has focus, for the commands that act on "this" note. */
	static activeNoteId: string | undefined;

	static show(extensionUri: vscode.Uri, workspace: NotesWorkspace, noteId: string): void {
		const existing = NotesEditorPanel.open.get(noteId);
		if (existing) {
			existing.panel.reveal(existing.panel.viewColumn);
			return;
		}
		const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.Active;
		const panel = vscode.window.createWebviewPanel(EDITOR_VIEW_TYPE, 'AI Notes', column, {
			enableScripts: true,
			retainContextWhenHidden: true,
			localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')]
		});
		NotesEditorPanel.open.set(noteId, new NotesEditorPanel(panel, extensionUri, workspace, noteId));
	}

	/** Rebuild a tab VS Code restored after a window reload, into the note it was showing. */
	static revive(
		panel: vscode.WebviewPanel,
		extensionUri: vscode.Uri,
		workspace: NotesWorkspace,
		state: unknown
	): void {
		const noteId = (state as { noteId?: unknown } | undefined)?.noteId;
		// A tab whose note is gone from the file has nothing to show, and a tab that would be a
		// second view of an already open note would fight it.
		if (typeof noteId !== 'string' || !workspace.note(noteId) || NotesEditorPanel.open.has(noteId)) {
			panel.dispose();
			return;
		}
		NotesEditorPanel.open.set(noteId, new NotesEditorPanel(panel, extensionUri, workspace, noteId));
	}

	private readonly surface: NotesSurface;
	private readonly disposables: vscode.Disposable[] = [];

	private constructor(
		private readonly panel: vscode.WebviewPanel,
		extensionUri: vscode.Uri,
		private readonly workspace: NotesWorkspace,
		private readonly noteId: string
	) {
		// A tab icon is rendered as an image, not masked to the theme colour the way the activity
		// bar container's icon is, so `currentColor` in the SVG resolves to black. Ship one file
		// per theme kind instead: white ink on a dark theme, dark ink on a light one.
		panel.iconPath = {
			light: vscode.Uri.joinPath(extensionUri, 'media', 'icon-black.svg'),
			dark: vscode.Uri.joinPath(extensionUri, 'media', 'icon-white.svg')
		};
		this.surface = new NotesSurface(panel.webview, extensionUri, workspace, noteId);
		this.updateTitle();
		if (panel.active) {
			NotesEditorPanel.activeNoteId = noteId;
		}
		this.disposables.push(
			workspace.onDidChange(change => {
				if (change.noteId === undefined || change.noteId === noteId) {
					this.updateTitle();
				}
			}),
			panel.onDidChangeViewState(() => {
				if (panel.active) {
					NotesEditorPanel.activeNoteId = noteId;
				}
				if (panel.visible) {
					// Re-check on the way in rather than making the reader wait out the poll to
					// find out the session behind these notes has ended.
					workspace.refresh();
				} else {
					workspace.saveNow();
				}
			}),
			panel.onDidDispose(() => this.dispose())
		);
	}

	/** `Notes: <session title>` once a session is connected, and just `AI Notes` before that. */
	private updateTitle(): void {
		const label = this.workspace.labelFor(this.noteId);
		this.panel.title = label ? `Notes: ${label}` : 'AI Notes';
	}

	dispose(): void {
		if (NotesEditorPanel.open.get(this.noteId) === this) {
			NotesEditorPanel.open.delete(this.noteId);
		}
		if (NotesEditorPanel.activeNoteId === this.noteId) {
			NotesEditorPanel.activeNoteId = undefined;
		}
		this.surface.dispose();
		for (const disposable of this.disposables) {
			disposable.dispose();
		}
		this.panel.dispose();
	}
}

function renderHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
	const nonce = makeNonce();
	const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'main.css'));
	const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'main.js'));
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${styleUri}" rel="stylesheet">
<title>AI Notes</title>
</head>
<body>
<div id="empty" class="empty" hidden>
  <button id="select" class="primary" type="button">Select AI Session</button>
</div>
<div id="banner" class="banner" hidden>
  <span>The connected AI session is not running.</span>
  <button id="banner-switch" class="link" type="button">Switch AI Session</button>
</div>
<div id="editor" class="editor" hidden>
  <textarea id="notes" class="notes" spellcheck="false" placeholder="Notes for this session&#10;&#10;Saved to the workspace dot-file as you type."></textarea>
  <button id="switch" class="link switch" type="button">Switch AI Session</button>
</div>
<div id="picker" class="picker" hidden>
  <div class="picker-bar">
    <button id="picker-back" class="iconbtn" type="button" title="Keep the current session" aria-label="Back">&#8592;</button>
    <input id="picker-search" class="search" type="text" placeholder="Select AI Session" autocomplete="off" spellcheck="false">
  </div>
  <div id="picker-list" class="picker-list" role="listbox" tabindex="-1"></div>
</div>
<div id="status" class="status" hidden>
  <span id="status-text">&nbsp;</span>
  <span id="file-name" class="file-name"></span>
</div>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

export function makeNonce(): string {
	const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	let out = '';
	for (let i = 0; i < 32; i++) {
		out += alphabet[Math.floor(Math.random() * alphabet.length)];
	}
	return out;
}
