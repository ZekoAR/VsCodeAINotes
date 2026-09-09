import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
	ClaudeSession,
	claudeHome,
	isSessionRunning,
	lookupSessionLabel,
	scanSessions,
	sessionLabel,
	truncate
} from './sessions';
import { BoundSession, Note, NotesDoc, NotesStore, newNote } from './store';

/**
 * How often every bound note's title and liveness are re-read.
 *
 * Liveness has its own watcher and does not wait for this, so the poll is really about the title,
 * which Claude Code rewrites as a session's topic moves and which nothing notifies us about. It is
 * also the backstop for a watcher that never started or stopped delivering, which is why it is slow
 * rather than absent.
 */
const POLL_MS = 60_000;

/** Collapses the burst of events `fs.watch` emits for a single change. */
const WATCH_DEBOUNCE_MS = 150;

/**
 * What separates notes carried into a session from the notes already there.
 *
 * A horizontal rule on its own line: visible in the panel, meaningful in the dot-file, and not
 * something a reader has to undo before carrying on typing.
 */
const APPEND_SEPARATOR = '\n\n---\n\n';

/** What changed, and which surface already knows about it. */
export interface NoteChange {
	/** The note that changed, or `undefined` when the set of notes itself changed. */
	noteId?: string;
	/** True when the note's text changed, so surfaces must re-render it. */
	textChanged: boolean;
	/** The surface that caused the change. It already shows the new text; others do not. */
	origin?: unknown;
}

/** One row in a note editor's own session list. */
export interface SessionRow {
	id: string;
	label: string;
	live: boolean;
	lastActivity?: number;
	pid?: number;
}

/** One row in the side panel: a session you can open a note editor for. */
export interface SideRow extends SessionRow {
	/** True when a note for this session already exists, so opening reveals rather than creates. */
	hasNote: boolean;
}

/**
 * Owns the notes dot-file, every note in it, and the one watcher and poll that keep their session
 * state fresh.
 *
 * There is one of these per workspace folder. Editors reference a note by id and read through here,
 * so the file is written from a single place and the registry is watched once rather than once per
 * open editor.
 */
export class NotesWorkspace implements vscode.Disposable {
	private doc: NotesDoc;
	private dirty = false;
	private saveTimer: NodeJS.Timeout | undefined;
	private readonly pollTimer: NodeJS.Timeout;
	private fileWatcher: vscode.FileSystemWatcher | undefined;
	private registryWatcher: fs.FSWatcher | undefined;
	private watchDebounce: NodeJS.Timeout | undefined;
	private readonly configListener: vscode.Disposable;
	/** Per note: the label its session resolves to, and whether that session is running. */
	private readonly resolved = new Map<string, { label?: string; running: boolean }>();
	/** The last list handed to an editor, so a row it sends back can be resolved to a session. */
	private scanned: ClaudeSession[] = [];
	private readonly onChanged = new vscode.EventEmitter<NoteChange>();

	/** Fires when the state some surface renders has changed. */
	readonly onDidChange = this.onChanged.event;

	constructor(
		private readonly store: NotesStore,
		private readonly workspaceRoot: string
	) {
		this.doc = this.store.read();
		this.watchFile();
		this.resolveAll();
		this.pollTimer = setInterval(() => this.refresh(), POLL_MS);
		this.watchRegistry();
		// The watcher is aimed at one directory, so a change of that setting must re-aim it.
		this.configListener = vscode.workspace.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration('ainotes.claudeHome')) {
				this.watchRegistry();
			}
		});
	}

	get filePath(): string {
		return this.store.filePath;
	}

	get isDirty(): boolean {
		return this.dirty;
	}

	notes(): Note[] {
		return this.doc.notes;
	}

	note(id: string): Note | undefined {
		return this.doc.notes.find(candidate => candidate.id === id);
	}

	/** A new note, bound to nothing. The editor that opens it picks its session. */
	createNote(): Note {
		const note = newNote();
		this.doc = { ...this.doc, notes: [...this.doc.notes, note] };
		this.dirty = true;
		this.saveNow();
		this.onChanged.fire({ textChanged: false });
		return note;
	}

	/** The note for a session, creating and binding one if it has none yet. */
	noteForSession(sessionId: string): Note {
		const existing = this.doc.notes.find(note => note.session?.id === sessionId);
		if (existing) {
			return existing;
		}
		const note = newNote();
		this.doc = { ...this.doc, notes: [...this.doc.notes, note] };
		this.dirty = true;
		this.bind(note.id, sessionId);
		return this.note(note.id) ?? note;
	}

	/** The note already filed under a session, if any. */
	noteIdForSession(sessionId: string): string | undefined {
		return this.doc.notes.find(note => note.session?.id === sessionId)?.id;
	}

	/**
	 * Add text to the end of a session's notes, filing a note under that session if it has none.
	 *
	 * Appending never destroys what is already there, which is why it needs no confirmation: the two
	 * bodies of text end up separated by a rule and both survive. The source note is not touched -
	 * this copies, so the notes written for one session stay under it.
	 *
	 * Returns the note the text landed in, or nothing when the session cannot be written to - it was
	 * never resolvable, or it stopped running between being listed and being chosen, and a note whose
	 * session has ended is history rather than a place to file new text.
	 */
	appendToSession(sessionId: string, text: string): string | undefined {
		const target = this.noteForSession(sessionId);
		if (target.session?.id !== sessionId) {
			// Nothing in the scan or on disk names that session, so `noteForSession` left the note it
			// created unbound. Take it back out rather than leaving an orphan in the file.
			this.deleteNote(target.id);
			return undefined;
		}
		if (!text) {
			return target.id;
		}
		if (this.isReadOnly(target.id)) {
			return undefined;
		}
		const existing = target.text.replace(/\s+$/, '');
		this.setText(target.id, existing ? `${existing}${APPEND_SEPARATOR}${text}` : text);
		return target.id;
	}

	/** Drop a note from the file. */
	deleteNote(id: string): void {
		if (!this.doc.notes.some(note => note.id === id)) {
			return;
		}
		this.doc = { ...this.doc, notes: this.doc.notes.filter(note => note.id !== id) };
		this.resolved.delete(id);
		this.dirty = true;
		this.saveNow();
		this.onChanged.fire({ textChanged: false });
	}

	setText(id: string, text: string, origin?: unknown): void {
		const note = this.note(id);
		if (!note || this.isReadOnly(id)) {
			// The surfaces disable their input, so this only catches a webview that has not yet
			// been told the session died. Its keystrokes are not ours to keep.
			return;
		}
		if (note.text === text) {
			return;
		}
		// Stamped where it is edited, not where it is written: a save flushes every note at once,
		// and only the one that changed should move its timestamp.
		this.replace(id, { ...note, text, updatedAt: new Date().toISOString() });
		this.dirty = true;
		this.scheduleSave();
		this.onChanged.fire({ noteId: id, textChanged: true, origin });
	}

	setSession(id: string, session: BoundSession | null): void {
		const note = this.note(id);
		if (!note) {
			return;
		}
		this.replace(id, { ...note, session, updatedAt: new Date().toISOString() });
		this.dirty = true;
		this.saveNow();
		this.resolveNote(id);
		this.onChanged.fire({ noteId: id, textChanged: false });
	}

	/** Write immediately, cancelling any pending autosave. */
	saveNow(): void {
		if (this.saveTimer) {
			clearTimeout(this.saveTimer);
			this.saveTimer = undefined;
		}
		if (!this.dirty && this.store.exists()) {
			return;
		}
		try {
			this.store.write(this.doc);
			this.dirty = false;
		} catch (err) {
			void vscode.window.showErrorMessage(
				`AI Notes could not write ${this.store.filePath}: ${(err as Error).message}`
			);
			return;
		}
		this.onChanged.fire({ textChanged: false });
	}

	/**
	 * What to call a note's session on screen: the session's own title, else the first thing that
	 * was asked of it, else its short id. The pretty name in the live registry (`zod-ea`) is
	 * deliberately not used - it belongs to a process, so it changes when Claude restarts under the
	 * same session id and does not exist at all once the session has exited.
	 */
	labelFor(id: string): string | undefined {
		const note = this.note(id);
		if (!note?.session) {
			return undefined;
		}
		const label = this.resolved.get(id)?.label;
		// Generous: real titles run to ~52 characters, and VS Code shortens a tab caption itself.
		// The cap only guards against a first-prompt fallback running away.
		return label ? truncate(label, 80) : note.session.id.slice(0, 8);
	}

	/**
	 * True when a note belongs to a session that is not running any more. Its text is history at
	 * that point, so the surfaces present it read-only. An unbound note is NOT read-only - it is a
	 * scratchpad that has not been filed yet.
	 */
	isReadOnly(id: string): boolean {
		const note = this.note(id);
		return Boolean(note?.session) && !this.resolved.get(id)?.running;
	}

	/**
	 * The cheap half of `refresh`: are the bound sessions running? No transcript is read.
	 *
	 * Public because a restored tab polls it while it waits for Claude Code to come back after a
	 * window reload, and paying a 512 KB transcript read per note per attempt would be waste.
	 */
	refreshLiveness(): void {
		const home = this.claudeHomeSetting();
		let changed = false;
		for (const note of this.doc.notes) {
			const running = note.session ? isSessionRunning(note.session.id, home) : false;
			const previous = this.resolved.get(note.id);
			if (previous?.running === running) {
				continue;
			}
			this.resolved.set(note.id, { label: previous?.label, running });
			changed = true;
		}
		if (changed) {
			this.onChanged.fire({ textChanged: false });
		}
	}

	/** Re-read every bound note's title and whether its session is still running. */
	refresh(): void {
		let changed = false;
		for (const note of this.doc.notes) {
			if (this.resolveNote(note.id)) {
				changed = true;
			}
		}
		if (changed) {
			this.onChanged.fire({ textChanged: false });
		}
	}

	/**
	 * The rows for a note editor's own session list: running sessions first, then most recent
	 * activity, then title. "Most recent activity" is the transcript's mtime, falling back to when
	 * the process started for a live session that has not written anything yet.
	 */
	listSessions(): SessionRow[] {
		this.scanned = this.scan();
		return sortRows(
			this.scanned.map(session => ({
				id: session.sessionId,
				label: sessionLabel(session),
				live: session.live,
				lastActivity: session.lastActivity ?? session.startedAt,
				pid: session.pid
			}))
		);
	}

	/**
	 * The session a Claude Code tab caption names, or nothing when that cannot be told for certain.
	 *
	 * Claude Code sets its tab caption to the session's own title, so the caption is compared against
	 * the title read out of that same transcript. A caption that matches nothing, or that two
	 * sessions answer to, resolves to nothing at all - the caller falls back to the picker rather
	 * than filing a note against a guess.
	 */
	sessionIdForLabel(label: string): string | undefined {
		const wanted = label.trim();
		if (!wanted) {
			return undefined;
		}
		this.scanned = this.scan();
		const matches = this.scanned.filter(
			session => session.title?.trim() === wanted || session.firstPrompt?.trim() === wanted
		);
		return matches.length === 1 ? matches[0].sessionId : undefined;
	}

	/**
	 * The one Claude session running in this workspace, when there is exactly one.
	 *
	 * The fallback for identifying a window's session when no tab caption resolves - at startup a
	 * Claude tab is often still captioned "Claude Code", before its session has been titled. Two
	 * running sessions is a genuine tie and resolves to nothing.
	 */
	soleLiveSessionId(): string | undefined {
		this.scanned = this.scan();
		const live = this.scanned.filter(session => session.live);
		return live.length === 1 ? live[0].sessionId : undefined;
	}

	/**
	 * The side panel's rows: every running session, plus any session that already has a note but is
	 * no longer running. Without that second group, closing such a note's tab would strand it in the
	 * file with no way back to it.
	 */
	sidePanelRows(): SideRow[] {
		this.scanned = this.scan();
		const noted = new Set(
			this.doc.notes.map(note => note.session?.id).filter((id): id is string => Boolean(id))
		);
		const rows: SideRow[] = [];
		const seen = new Set<string>();
		for (const session of this.scanned) {
			if (!session.live && !noted.has(session.sessionId)) {
				continue;
			}
			seen.add(session.sessionId);
			rows.push({
				id: session.sessionId,
				label: sessionLabel(session),
				live: session.live,
				lastActivity: session.lastActivity ?? session.startedAt,
				pid: session.pid,
				hasNote: noted.has(session.sessionId)
			});
		}
		// A note whose session is older than the history limit is not in the scan at all, and it
		// still has to be reachable.
		for (const note of this.doc.notes) {
			const session = note.session;
			if (!session || seen.has(session.id)) {
				continue;
			}
			rows.push({
				id: session.id,
				label: this.labelFor(note.id) ?? session.id.slice(0, 8),
				live: false,
				lastActivity: undefined,
				pid: session.pid,
				hasNote: true
			});
		}
		return sortRows(rows);
	}

	/** Bind a note to a session. False when this workspace can resolve no such session. */
	bind(noteId: string, sessionId: string): boolean {
		let session = this.scanned.find(candidate => candidate.sessionId === sessionId);
		if (!session) {
			// The scan cache is only warm once some list has been drawn. Binding must not depend
			// on that having happened, or a bind from a cold start silently does nothing.
			this.scanned = this.scan();
			session = this.scanned.find(candidate => candidate.sessionId === sessionId);
		}
		const stored = this.doc.notes.find(note => note.session?.id === sessionId)?.session;
		if (!session && !stored) {
			return false;
		}
		this.setSession(noteId, {
			id: sessionId,
			name: session?.name ?? stored?.name,
			cwd: session?.cwd ?? stored?.cwd,
			pid: session?.pid ?? stored?.pid,
			boundAt: new Date().toISOString()
		});
		return true;
	}

	/**
	 * Move an editor onto the session it should now show, and answer which note it lands on.
	 *
	 * A note belongs to a session, so switching an editor's session is NOT a rename of the note on
	 * screen: the note being left keeps its own text under its own session, and the editor lands on
	 * the target session's note - the existing one, or a fresh empty one. Without this, switching
	 * re-filed one session's notes under another and the first session was left with none.
	 *
	 * The one exception is a note connected to nothing, which has no session to leave anything behind
	 * in and is filed under the target in place. A new note is always empty when that happens - an
	 * editor connected to nothing shows no text field - and a note parked by disconnecting gets its
	 * text back when it is filed again.
	 *
	 * A note left behind holding nothing is dropped rather than kept as an empty row in the file.
	 */
	attachToSession(noteId: string, sessionId: string): string {
		const note = this.note(noteId);
		if (!note || note.session?.id === sessionId) {
			return noteId;
		}
		const existing = this.doc.notes.find(
			candidate => candidate.id !== noteId && candidate.session?.id === sessionId
		);
		if (existing) {
			this.discardIfEmpty(noteId);
			return existing.id;
		}
		if (!note.session) {
			this.bind(noteId, sessionId);
			return noteId;
		}
		const fresh = newNote();
		this.doc = { ...this.doc, notes: [...this.doc.notes, fresh] };
		this.dirty = true;
		if (!this.bind(fresh.id, sessionId)) {
			// Neither the scan nor the file names that session, so there is nowhere to move to.
			this.doc = { ...this.doc, notes: this.doc.notes.filter(entry => entry.id !== fresh.id) };
			return noteId;
		}
		this.discardIfEmpty(noteId);
		return fresh.id;
	}

	/**
	 * The quick-pick session picker, for entry points with no panel open to draw a list in.
	 *
	 * It only ASKS. Applying the answer is the caller's, because moving an editor onto another
	 * session's notes is more than a field change on this note - see `attachToSession`.
	 *
	 * Returns the chosen session id, `null` to disconnect the note, or `undefined` when dismissed.
	 */
	async pickSession(noteId: string): Promise<string | null | undefined> {
		const rows = this.listSessions();
		const current = this.note(noteId)?.session?.id;
		const items: (vscode.QuickPickItem & { row?: SessionRow; clears?: boolean })[] = [];
		const live = rows.filter(row => row.live);
		const past = rows.filter(row => !row.live);
		const toItem = (row: SessionRow) => ({
			label: `${row.live ? '$(pulse) ' : '$(history) '}${row.label}`,
			description: [
				row.id.slice(0, 8),
				row.pid ? `pid ${row.pid}` : '',
				row.id === current ? 'connected' : ''
			]
				.filter(Boolean)
				.join(' · '),
			row
		});
		if (live.length) {
			items.push({ label: 'Running now', kind: vscode.QuickPickItemKind.Separator });
			items.push(...live.map(toItem));
		}
		if (past.length) {
			items.push({ label: 'Earlier in this folder', kind: vscode.QuickPickItemKind.Separator });
			items.push(...past.map(toItem));
		}
		items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
		items.push({ label: '$(circle-slash) Not connected to a session', clears: true, alwaysShow: true });

		const chosen = await vscode.window.showQuickPick(items, {
			title: 'AI Notes - which Claude session do these notes belong to?',
			placeHolder: 'Pick a session',
			matchOnDescription: true
		});
		if (!chosen) {
			return undefined;
		}
		return chosen.clears ? null : chosen.row?.id;
	}

	dispose(): void {
		if (this.dirty) {
			this.saveNow();
		}
		if (this.saveTimer) {
			clearTimeout(this.saveTimer);
		}
		if (this.watchDebounce) {
			clearTimeout(this.watchDebounce);
		}
		clearInterval(this.pollTimer);
		this.registryWatcher?.close();
		this.configListener.dispose();
		this.fileWatcher?.dispose();
		this.onChanged.dispose();
	}

	// ---------------------------------------------------------------- internals

	/** An editor moving off a note leaves nothing behind when the note held nothing. */
	private discardIfEmpty(id: string): void {
		if (this.note(id) && !this.note(id)?.text) {
			this.deleteNote(id);
		}
	}

	private replace(id: string, note: Note): void {
		this.doc = {
			...this.doc,
			notes: this.doc.notes.map(candidate => (candidate.id === id ? note : candidate))
		};
	}

	private scheduleSave(): void {
		if (this.saveTimer) {
			clearTimeout(this.saveTimer);
		}
		const delay = vscode.workspace.getConfiguration('ainotes').get<number>('autosaveDelayMs', 800);
		this.saveTimer = setTimeout(() => {
			this.saveTimer = undefined;
			this.saveNow();
		}, delay);
	}

	private scan(): ClaudeSession[] {
		const config = vscode.workspace.getConfiguration('ainotes');
		return scanSessions({
			workspaceRoot: this.workspaceRoot,
			claudeHomeOverride: config.get<string>('claudeHome', ''),
			historyLimit: config.get<number>('sessionHistoryLimit', 25)
		});
	}

	private claudeHomeSetting(): string {
		return vscode.workspace.getConfiguration('ainotes').get<string>('claudeHome', '');
	}

	private resolveAll(): void {
		for (const note of this.doc.notes) {
			this.resolveNote(note.id);
		}
	}

	/** Resolve one note's label and liveness. Returns whether either changed. */
	private resolveNote(id: string): boolean {
		const note = this.note(id);
		const session = note?.session;
		const home = this.claudeHomeSetting();
		const label = session
			? lookupSessionLabel(session.id, this.workspaceRoot, home)
			: undefined;
		const running = session ? isSessionRunning(session.id, home) : false;
		const previous = this.resolved.get(id);
		const changed = previous?.label !== label || previous?.running !== running;
		this.resolved.set(id, { label, running });
		return changed;
	}

	/**
	 * Reload when the dot-file is edited outside the panels. Without this, having the file open in
	 * an editor and in a panel at once silently loses whichever side saves second.
	 */
	private watchFile(): void {
		const pattern = new vscode.RelativePattern(
			this.workspaceRoot,
			path.basename(this.store.filePath)
		);
		this.fileWatcher = vscode.workspace.createFileSystemWatcher(pattern);
		const reload = () => {
			if (!this.store.changedExternally() || this.dirty) {
				// Our unsaved keystrokes are newer than what landed on disk; keep them.
				return;
			}
			this.doc = this.store.read();
			this.resolveAll();
			// No origin: the change came from outside, so every surface re-renders.
			this.onChanged.fire({ textChanged: true });
		};
		this.fileWatcher.onDidChange(reload);
		this.fileWatcher.onDidCreate(reload);
		this.fileWatcher.onDidDelete(reload);
	}

	/**
	 * Watch the live-session registry, so a session closing or reopening reaches the panels at once
	 * rather than at the next poll.
	 *
	 * A watch event triggers only the CHEAP half of the refresh. Those registry files are rewritten
	 * as a session works, not just when one starts or stops, so this fires often - paying a 512 KB
	 * transcript read per note on each event would be waste. Titles stay on the poll.
	 */
	private watchRegistry(): void {
		this.registryWatcher?.close();
		this.registryWatcher = undefined;

		const dir = path.join(claudeHome(this.claudeHomeSetting()), 'sessions');
		let watcher: fs.FSWatcher;
		try {
			watcher = fs.watch(dir, () => {
				if (this.watchDebounce) {
					clearTimeout(this.watchDebounce);
				}
				this.watchDebounce = setTimeout(() => {
					this.watchDebounce = undefined;
					this.refreshLiveness();
				}, WATCH_DEBOUNCE_MS);
			});
		} catch {
			// No registry directory yet. The poll still notices, just late, and a change of the
			// claudeHome setting re-aims this.
			return;
		}
		// A watcher whose directory goes away must not take the extension down with it.
		watcher.on('error', () => {
			watcher.close();
			if (this.registryWatcher === watcher) {
				this.registryWatcher = undefined;
			}
		});
		this.registryWatcher = watcher;
	}

}

/** Running first, then most recent activity, then title. */
function sortRows<T extends SessionRow>(rows: T[]): T[] {
	return rows.sort(
		(a, b) =>
			Number(b.live) - Number(a.live) ||
			(b.lastActivity ?? 0) - (a.lastActivity ?? 0) ||
			a.label.localeCompare(b.label)
	);
}
