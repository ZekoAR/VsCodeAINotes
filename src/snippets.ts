import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { notesHome, writeFileAtomic } from './store';

/** One saved prompt. */
export interface Snippet {
	id: string;
	/** Optional. The list falls back to the prompt's first line when it is empty. */
	title: string;
	prompt: string;
}

/** The whole content of the snippets file. */
interface SnippetsDoc {
	version: 1;
	snippets: Snippet[];
}

/** How much of a label the status bar confirmation repeats. */
const LABEL_LIMIT = 40;

/**
 * The prompt snippets: one list for every workspace on this machine, in `~/.ainotes/snippets.json`.
 *
 * A file of its own rather than a key in a folder's notes file. A prompt is about how Claude is
 * worked with, not about one folder, so a list per folder would have to be typed in again in every
 * project - and a window with no folder open can still use it.
 *
 * Written whole on every add, update and remove. Those are single clicks, not keystrokes, so there is
 * nothing to debounce. Another window's writes arrive through the watcher, and every change also
 * re-reads the file first when it moved, so a window that has not heard yet cannot write its stale
 * list over an addition made elsewhere.
 */
export class SnippetLibrary implements vscode.Disposable {
	private doc: SnippetsDoc = { version: 1, snippets: [] };
	/** The file's text as last read or written, `null` when it did not exist. */
	private seen: string | null = null;
	/**
	 * Why the file could not be read, when it exists and could not be. Writing then is refused: the
	 * file is written whole, so a write from an empty list would replace whatever is in it.
	 */
	private unreadable: string | undefined;
	private watcher: vscode.FileSystemWatcher | undefined;
	private readonly onChanged = new vscode.EventEmitter<void>();

	/** Fires when the list changed, from here or from the file being written elsewhere. */
	readonly onDidChange = this.onChanged.event;

	constructor(readonly filePath: string = path.join(notesHome(), 'snippets.json')) {
		this.load();
		this.watch();
	}

	list(): readonly Snippet[] {
		return this.doc.snippets;
	}

	get(id: string): Snippet | undefined {
		return this.doc.snippets.find(snippet => snippet.id === id);
	}

	/**
	 * Add a snippet above `beforeId`, or at the end when there is none - including when that one has
	 * been removed since the placement was chosen. The new snippet, or nothing when it could not be
	 * written, which was reported.
	 */
	add(title: string, prompt: string, beforeId?: string): Snippet | undefined {
		this.catchUp();
		const snippet: Snippet = { id: randomUUID(), title: title.trim(), prompt };
		const snippets = [...this.doc.snippets];
		const at = beforeId === undefined ? -1 : snippets.findIndex(candidate => candidate.id === beforeId);
		snippets.splice(at < 0 ? snippets.length : at, 0, snippet);
		return this.commit(snippets) ? snippet : undefined;
	}

	/**
	 * False when there is no such snippet any more, or the write failed. An edit that changes nothing
	 * is true without a write: the side panel saves as it is typed, and the Update press that ends an
	 * edit usually repeats what is already stored.
	 */
	update(id: string, title: string, prompt: string): boolean {
		this.catchUp();
		const current = this.get(id);
		if (!current) {
			return false;
		}
		const next: Snippet = { id, title: title.trim(), prompt };
		if (current.title === next.title && current.prompt === next.prompt) {
			return true;
		}
		return this.commit(this.doc.snippets.map(snippet => (snippet.id === id ? next : snippet)));
	}

	remove(id: string): boolean {
		this.catchUp();
		if (!this.get(id)) {
			return false;
		}
		return this.commit(this.doc.snippets.filter(snippet => snippet.id !== id));
	}

	dispose(): void {
		this.watcher?.dispose();
		this.onChanged.dispose();
	}

	// ---------------------------------------------------------------- internals

	private commit(snippets: Snippet[]): boolean {
		if (this.unreadable !== undefined) {
			void vscode.window.showErrorMessage(
				`AI Notes could not read ${this.filePath} (${this.unreadable}), so it will not overwrite it.`
			);
			return false;
		}
		const doc: SnippetsDoc = { version: 1, snippets };
		const serialised = JSON.stringify(doc, null, 2) + '\n';
		try {
			writeFileAtomic(this.filePath, serialised);
		} catch (err) {
			void vscode.window.showErrorMessage(
				`AI Notes could not write ${this.filePath}: ${(err as Error).message}`
			);
			return false;
		}
		this.doc = doc;
		this.seen = serialised;
		this.onChanged.fire();
		return true;
	}

	/** Re-read the file when it is not what was last seen. True when the list was replaced. */
	private load(): boolean {
		let raw: string | null;
		try {
			raw = fs.readFileSync(this.filePath, 'utf8');
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
				this.unreadable = (err as Error).message;
				return false;
			}
			raw = null;
		}
		this.unreadable = undefined;
		if (raw === this.seen) {
			return false;
		}
		this.seen = raw;
		this.doc = raw === null ? { version: 1, snippets: [] } : normalise(raw);
		return true;
	}

	private catchUp(): void {
		if (this.load()) {
			this.onChanged.fire();
		}
	}

	/**
	 * Follow the file when another window, or a hand edit, writes it. Our own writes land here too and
	 * are recognised by their text, so they cost one small read and fire nothing.
	 */
	private watch(): void {
		const dir = path.dirname(this.filePath);
		try {
			fs.mkdirSync(dir, { recursive: true });
		} catch {
			// A folder that cannot be created cannot be written either, and the write reports that.
		}
		this.watcher = vscode.workspace.createFileSystemWatcher(
			new vscode.RelativePattern(vscode.Uri.file(dir), path.basename(this.filePath))
		);
		const reload = () => this.catchUp();
		this.watcher.onDidChange(reload);
		this.watcher.onDidCreate(reload);
		this.watcher.onDidDelete(reload);
	}
}

/**
 * Accept anything JSON-shaped. A hand-edited file must not lose a prompt that is still in it: a bare
 * array is taken as the list, and a file that is not JSON at all becomes one snippet holding its
 * text, which the next write then stores properly.
 */
function normalise(raw: string): SnippetsDoc {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return { version: 1, snippets: raw.trim() ? [{ id: randomUUID(), title: '', prompt: raw }] : [] };
	}
	const entries = Array.isArray(parsed)
		? parsed
		: parsed && typeof parsed === 'object' && Array.isArray((parsed as Record<string, unknown>).snippets)
			? ((parsed as Record<string, unknown>).snippets as unknown[])
			: [];
	const ids = new Set<string>();
	const snippets: Snippet[] = [];
	for (const entry of entries) {
		if (!entry || typeof entry !== 'object') {
			continue;
		}
		const rec = entry as Record<string, unknown>;
		// A copied entry repeats its id, and two rows answering to one id would select and remove
		// together, so the copy is given its own.
		let id = typeof rec.id === 'string' && rec.id ? rec.id : randomUUID();
		if (ids.has(id)) {
			id = randomUUID();
		}
		ids.add(id);
		snippets.push({
			id,
			title: typeof rec.title === 'string' ? rec.title : '',
			prompt: typeof rec.prompt === 'string' ? rec.prompt : ''
		});
	}
	return { version: 1, snippets };
}

/** What a snippet is called on screen: its title, else the first line of its prompt. */
function snippetLabel(snippet: Snippet): string {
	const label = snippet.title.trim() || snippet.prompt.trim().split(/\r?\n/)[0].trim();
	return label.length > LABEL_LIMIT ? label.slice(0, LABEL_LIMIT) + '…' : label;
}

/**
 * Put a snippet's prompt - never its title - on the clipboard.
 *
 * Through the extension host rather than `navigator.clipboard` in the webview, which is not reliably
 * granted there. The status bar says so, because a double click has no other visible effect.
 */
export async function copySnippet(library: SnippetLibrary, id: string): Promise<void> {
	const snippet = library.get(id);
	if (!snippet) {
		return;
	}
	await vscode.env.clipboard.writeText(snippet.prompt);
	vscode.window.setStatusBarMessage(`$(copy) Copied "${snippetLabel(snippet)}"`, 2000);
}

/**
 * The entries of a snippet row's right-click menu.
 *
 * VS Code's own context menu rather than one drawn in the webview: the side panel's rows carry
 * `data-vscode-context`, and VS Code hands the command that object, merged from the row and its
 * ancestors, with `webview` added. Hidden from the command palette in the manifest, since each only
 * means something at the place its menu was opened.
 *
 * `insert` is the side panel's: Insert New... is about the form, which only the webview has. It is
 * offered on a row, where the new snippet goes above that row, and on the empty part of the list,
 * which carries no id and adds at the end.
 */
export function registerSnippetCommands(
	library: SnippetLibrary,
	insert: (beforeId: string | undefined) => void
): vscode.Disposable[] {
	const idOf = (context: unknown): string | undefined => {
		const id = (context as { snippetId?: unknown } | undefined)?.snippetId;
		return typeof id === 'string' ? id : undefined;
	};
	return [
		vscode.commands.registerCommand('ainotes.snippetInsert', (context: unknown) => {
			insert(idOf(context));
		}),
		vscode.commands.registerCommand('ainotes.snippetCopy', (context: unknown) => {
			const id = idOf(context);
			if (id) {
				void copySnippet(library, id);
			}
		}),
		vscode.commands.registerCommand('ainotes.snippetRemove', (context: unknown) => {
			const id = idOf(context);
			if (id) {
				library.remove(id);
			}
		})
	];
}
