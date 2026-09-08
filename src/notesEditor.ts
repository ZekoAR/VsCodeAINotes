import * as path from 'path';
import * as vscode from 'vscode';
import { SessionResolution } from './claudeTabs';
import { NotesWorkspace } from './notesWorkspace';

const EDITOR_VIEW_TYPE = 'ainotes.editor';

/** Answers which session this window is working with. Supplied by the extension's composition root. */
export type SessionResolver = () => SessionResolution;

/** A message sent from a note editor's webview to the extension host. */
type InboundMessage =
	| { type: 'ready' }
	| { type: 'input'; text: string }
	| { type: 'save' }
	| { type: 'requestSessions' }
	| { type: 'bindActive' }
	| { type: 'selectSession'; sessionId: string };

/** The rendered webview of one note editor, wired to its note. */
class NotesSurface {
	private readonly disposables: vscode.Disposable[] = [];

	constructor(
		private readonly webview: vscode.Webview,
		extensionUri: vscode.Uri,
		private readonly workspace: NotesWorkspace,
		private noteId: string,
		private readonly onSelectSession: (sessionId: string) => void,
		private readonly onBindActive: () => void
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

	/**
	 * Show a different note. Its text REPLACES what is on screen unconditionally: the text standing
	 * there belongs to the note being left, so merging it in would carry one session's notes into
	 * another.
	 */
	retarget(noteId: string): void {
		this.noteId = noteId;
		this.post(true);
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
			case 'bindActive':
				this.onBindActive();
				return;
			case 'selectSession':
				this.onSelectSession(message.sessionId);
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

	private static activePanel: NotesEditorPanel | undefined;

	/** The note editor that currently has focus, for the commands that act on "this" note. */
	static active(): NotesEditorPanel | undefined {
		return NotesEditorPanel.activePanel;
	}

	static show(
		extensionUri: vscode.Uri,
		workspace: NotesWorkspace,
		noteId: string,
		resolveSession: SessionResolver
	): void {
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
		NotesEditorPanel.open.set(
			noteId,
			new NotesEditorPanel(panel, extensionUri, workspace, noteId, resolveSession)
		);
	}

	/** Rebuild a tab VS Code restored after a window reload, into the note it was showing. */
	static revive(
		panel: vscode.WebviewPanel,
		extensionUri: vscode.Uri,
		workspace: NotesWorkspace,
		state: unknown,
		resolveSession: SessionResolver
	): void {
		const noteId = (state as { noteId?: unknown } | undefined)?.noteId;
		// A tab whose note is gone from the file has nothing to show, and a tab that would be a
		// second view of an already open note would fight it.
		if (typeof noteId !== 'string' || !workspace.note(noteId) || NotesEditorPanel.open.has(noteId)) {
			panel.dispose();
			return;
		}
		const revived = new NotesEditorPanel(panel, extensionUri, workspace, noteId, resolveSession);
		NotesEditorPanel.open.set(noteId, revived);
		revived.scheduleReconnect();
	}

	/**
	 * When a restored tab looks again for the session it is bound to, in milliseconds after restore.
	 *
	 * A window reload restarts Claude Code's own session, and the notes tab comes back first -
	 * measured on this machine, 18 seconds passed between the reload and the session registering in
	 * `~/.claude/sessions`. So the first look always says "not running" and means nothing. Only the
	 * last attempt is allowed to conclude the session is gone; the ones before it exist so a session
	 * that is merely slow is never abandoned for a different one.
	 */
	private static readonly RECONNECT_STEPS_MS = [400, 1200, 2500, 4000, 6000];

	private readonly surface: NotesSurface;
	private readonly disposables: vscode.Disposable[] = [];
	private readonly timers: NodeJS.Timeout[] = [];
	private disposed = false;

	private constructor(
		private readonly panel: vscode.WebviewPanel,
		extensionUri: vscode.Uri,
		private readonly workspace: NotesWorkspace,
		private noteId: string,
		private readonly resolveSession: SessionResolver
	) {
		// A tab icon is rendered as an image, not masked to the theme colour the way the activity
		// bar container's icon is, so `currentColor` in the SVG resolves to black. Ship one file
		// per theme kind instead: white ink on a dark theme, dark ink on a light one.
		panel.iconPath = {
			light: vscode.Uri.joinPath(extensionUri, 'media', 'icon-black.svg'),
			dark: vscode.Uri.joinPath(extensionUri, 'media', 'icon-white.svg')
		};
		this.surface = new NotesSurface(
			panel.webview,
			extensionUri,
			workspace,
			noteId,
			sessionId => this.attach(sessionId),
			() => this.bindActive()
		);
		this.updateTitle();
		if (panel.active) {
			NotesEditorPanel.activePanel = this;
		}
		this.disposables.push(
			workspace.onDidChange(change => {
				if (change.noteId === undefined || change.noteId === this.noteId) {
					this.updateTitle();
				}
			}),
			panel.onDidChangeViewState(() => {
				if (panel.active) {
					NotesEditorPanel.activePanel = this;
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

	/** The note this editor is showing. It changes when the editor is switched to another session. */
	get currentNoteId(): string {
		return this.noteId;
	}

	/**
	 * Switch this editor to a session. It lands on THAT session's notes rather than carrying the
	 * ones on screen across, which is the whole of the switching rule - see `attachToSession`.
	 *
	 * Returns false when the target session's notes are already open in another tab, which is
	 * revealed instead: two tabs on one note would fight each other over its text.
	 */
	attach(sessionId: string): boolean {
		const target = this.workspace.noteIdForSession(sessionId);
		if (target && target !== this.noteId) {
			const other = NotesEditorPanel.open.get(target);
			if (other && other !== this) {
				other.panel.reveal(other.panel.viewColumn);
				return false;
			}
		}
		this.retarget(this.workspace.attachToSession(this.noteId, sessionId));
		return true;
	}

	/** Leave the note connected to nothing. It keeps its text - it is the same note, unfiled. */
	disconnect(): void {
		this.workspace.setSession(this.noteId, null);
		this.retarget(this.noteId);
	}

	/** Ask which session these notes belong to, and move this editor onto the answer. */
	async askForSession(): Promise<void> {
		const chosen = await this.workspace.pickSession(this.noteId);
		if (chosen === undefined) {
			return;
		}
		if (chosen === null) {
			this.disconnect();
			return;
		}
		this.attachAndReport(chosen);
	}

	/**
	 * Bind this editor to the session this window is working with, falling back to the picker when
	 * that cannot be told. This is what the title-bar button, the banner's link and the command all
	 * run, so the three can never behave differently.
	 */
	bindActive(): void {
		const { sessionId, problem } = this.resolveSession();
		if (sessionId) {
			this.attachAndReport(sessionId);
			return;
		}
		void vscode.window.showInformationMessage(
			`AI Notes: ${problem ?? 'could not tell which Claude session to use.'} Pick it instead.`
		);
		void this.askForSession();
	}

	/**
	 * Look again for the session this tab is bound to, a few times across the first seconds after a
	 * window reload, and move onto the session this window is working with only if it never returns.
	 *
	 * Restore beats Claude Code back, so the first look is not evidence of anything - see
	 * `RECONNECT_STEPS_MS`. Nothing here fires for a note that is connected to nothing: an editor
	 * that was never bound has nothing to reconnect to, and binding it would be a decision the
	 * reader did not make.
	 */
	private scheduleReconnect(): void {
		const steps = NotesEditorPanel.RECONNECT_STEPS_MS;
		const attempt = (index: number): void => {
			if (this.disposed || !this.workspace.note(this.noteId)?.session) {
				return;
			}
			this.workspace.refreshLiveness();
			if (!this.workspace.isReadOnly(this.noteId)) {
				// It came back. Re-read the title too, so the tab caption is not left stale.
				this.workspace.refresh();
				return;
			}
			if (index + 1 < steps.length) {
				this.timers.push(setTimeout(() => attempt(index + 1), steps[index + 1] - steps[index]));
				return;
			}
			// Out of attempts: the session really is gone.
			const { sessionId } = this.resolveSession();
			if (!sessionId || sessionId === this.workspace.note(this.noteId)?.session?.id) {
				// Nothing to move onto, so the banner stands and its button is the way out.
				return;
			}
			if (this.attach(sessionId)) {
				// Say so: this moved the editor onto another session's notes without being asked,
				// so the text on screen changed by itself.
				vscode.window.setStatusBarMessage(
					`AI Notes: reconnected to ${this.workspace.labelFor(this.noteId) ?? 'the running session'}`,
					5000
				);
			}
		};
		this.timers.push(setTimeout(() => attempt(0), steps[0]));
	}

	private attachAndReport(sessionId: string): void {
		if (!this.attach(sessionId)) {
			void vscode.window.showInformationMessage(
				'AI Notes: that session already has a notes tab open, and it has been revealed.'
			);
		}
	}

	/** Point this editor at another note, moving the one-panel-per-note registration with it. */
	private retarget(noteId: string): void {
		if (noteId !== this.noteId) {
			if (NotesEditorPanel.open.get(this.noteId) === this) {
				NotesEditorPanel.open.delete(this.noteId);
			}
			this.noteId = noteId;
			NotesEditorPanel.open.set(noteId, this);
		}
		this.surface.retarget(noteId);
		this.updateTitle();
	}

	/** `Notes: <session title>` once a session is connected, and just `AI Notes` before that. */
	private updateTitle(): void {
		const label = this.workspace.labelFor(this.noteId);
		this.panel.title = label ? `Notes: ${label}` : 'AI Notes';
	}

	dispose(): void {
		this.disposed = true;
		for (const timer of this.timers) {
			clearTimeout(timer);
		}
		this.timers.length = 0;
		if (NotesEditorPanel.open.get(this.noteId) === this) {
			NotesEditorPanel.open.delete(this.noteId);
		}
		if (NotesEditorPanel.activePanel === this) {
			NotesEditorPanel.activePanel = undefined;
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
  <button id="banner-bind" class="link" type="button">Reconnect to Active</button>
  <span class="banner-sep">&#183;</span>
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
