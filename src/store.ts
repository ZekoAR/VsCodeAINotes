import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { encodeProjectDirName } from './sessions';

/** The session a note is bound to, as recorded on disk. */
export interface BoundSession {
	id: string;
	name?: string;
	cwd?: string;
	pid?: number;
	/** ISO timestamp of when this note was bound to the session. */
	boundAt: string;
}

/** One note. A workspace holds several, at most one per session. */
export interface Note {
	id: string;
	session: BoundSession | null;
	text: string;
	/** ISO timestamp of the last write. */
	updatedAt: string | null;
}

/** The whole content of a notes file. */
export interface NotesDoc {
	version: 2;
	notes: Note[];
	/**
	 * The folder's own note, belonging to no session.
	 *
	 * Kept here rather than in a file of its own: this is the workspace's notes file, it already
	 * writes atomically and is already watched for outside edits, and `.claude/` belongs to Claude
	 * Code rather than to us. Absent until something is written, so an untouched file gains no key.
	 */
	general?: string;
}

export function emptyDoc(): NotesDoc {
	return { version: 2, notes: [] };
}

export function newNote(): Note {
	return { id: randomUUID(), session: null, text: '', updatedAt: null };
}

/**
 * Replace a file's content through a sibling temp file and a rename, so a crash mid-write cannot
 * leave a half-written file where the old content used to be. Creates the folder if it is missing.
 */
export function writeFileAtomic(filePath: string, text: string): void {
	const dir = path.dirname(filePath);
	fs.mkdirSync(dir, { recursive: true });
	const temp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.tmp`);
	fs.writeFileSync(temp, text, 'utf8');
	fs.renameSync(temp, filePath);
}

/**
 * One workspace folder's notes file. JSON, written whole.
 *
 * Writes go through a sibling temp file and a rename so a crash mid-write cannot leave a
 * half-written file where the notes used to be.
 */
export class NotesStore {
	/** What we last wrote, so the file watcher can tell our own write from an external edit. */
	private lastWritten: string | undefined;

	constructor(public readonly filePath: string) {}

	read(): NotesDoc {
		let raw: string;
		try {
			raw = fs.readFileSync(this.filePath, 'utf8');
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
				return emptyDoc();
			}
			throw err;
		}
		return normalise(raw);
	}

	write(doc: NotesDoc): void {
		const serialised = JSON.stringify(doc, null, 2) + '\n';
		writeFileAtomic(this.filePath, serialised);
		this.lastWritten = serialised;
	}

	/** True when the file on disk differs from what this extension last wrote. */
	changedExternally(): boolean {
		let raw: string;
		try {
			raw = fs.readFileSync(this.filePath, 'utf8');
		} catch {
			// A deleted file is an external change worth reacting to.
			return this.lastWritten !== undefined;
		}
		return raw !== this.lastWritten;
	}

	exists(): boolean {
		return fs.existsSync(this.filePath);
	}
}

/**
 * The folder every workspace's notes file lives in: the user's own, never the workspace.
 *
 * A file inside the working tree belongs to git as much as to us. Committed by accident, checking
 * out an older branch swapped it for that branch's copy - measured, 34 notes became 10 in the
 * panels. Git-ignored, it is still expendable to git, which overwrites an ignored file from any
 * branch that tracks it. The notes are bound to session ids that exist only in this machine's
 * `~/.claude`, so they live on the machine too, out of reach of anything git does.
 */
export function notesHome(): string {
	return path.join(os.homedir(), '.ainotes');
}

/**
 * The notes file for a workspace folder, named with the encoding Claude Code gives that folder's
 * transcripts: `d:\ClaudeCodeNotes` -> `~/.ainotes/c--D-AINotes.json`.
 *
 * Matched case-insensitively against what is on disk before falling back to the computed name, for
 * the same reason `projectTranscriptDir` is: VS Code and Claude Code do not always agree on the
 * drive letter's case, and a different case must not open an empty notes file.
 */
export function notesFileFor(workspaceRoot: string): string {
	const home = notesHome();
	const wanted = `${encodeProjectDirName(workspaceRoot)}.json`;
	try {
		for (const entry of fs.readdirSync(home, { withFileTypes: true })) {
			if (entry.isFile() && entry.name.toLowerCase() === wanted.toLowerCase()) {
				return path.join(home, entry.name);
			}
		}
	} catch {
		// No notes folder yet - the first write creates it.
	}
	return path.join(home, wanted);
}

/**
 * Copy the notes file earlier versions kept in the workspace root into `store`. True when something
 * was imported.
 *
 * Only while `store` has no file of its own. After that the old file is history: reading it again
 * would bring back whatever a branch switch last left in it. The old file is never modified or
 * deleted, and it goes through the same `normalise` as any read, so a version 1 or hand-edited file
 * arrives migrated.
 */
export function importLegacyNotes(store: NotesStore, legacyPath: string): boolean {
	if (store.exists()) {
		return false;
	}
	const legacy = new NotesStore(legacyPath);
	if (!legacy.exists()) {
		return false;
	}
	store.write(legacy.read());
	return true;
}

/**
 * Accept anything JSON-shaped and coerce it into a `NotesDoc`, including the version 1 format that
 * held a single note at the top level. A hand-edited file with a missing field must not throw away
 * note text that is still in it.
 */
function normalise(raw: string): NotesDoc {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		// Not JSON at all - keep whatever a human typed rather than silently dropping it.
		return { version: 2, notes: [{ ...newNote(), text: raw }] };
	}
	const rec = (parsed ?? {}) as Record<string, unknown>;

	// Carried through every branch below: a hand-edited file that has a general note but nothing else
	// recognisable must not lose it.
	const general = typeof rec.general === 'string' ? rec.general : undefined;
	const withGeneral = (notes: Note[]): NotesDoc =>
		general === undefined ? { version: 2, notes } : { version: 2, notes, general };

	if (Array.isArray(rec.notes)) {
		const notes = rec.notes
			.map(entry => readNote(entry as Record<string, unknown>))
			.filter((note): note is Note => note !== undefined);
		return withGeneral(notes);
	}

	// Version 1: one note, its fields at the top level. Migrate rather than discard.
	if (typeof rec.text === 'string' || rec.session) {
		const migrated = readNote(rec);
		return withGeneral(migrated ? [migrated] : []);
	}
	return withGeneral([]);
}

function readNote(rec: Record<string, unknown> | undefined): Note | undefined {
	if (!rec || typeof rec !== 'object') {
		return undefined;
	}
	const sessionRec = rec.session as Record<string, unknown> | null | undefined;
	const session: BoundSession | null =
		sessionRec && typeof sessionRec.id === 'string'
			? {
					id: sessionRec.id,
					name: typeof sessionRec.name === 'string' ? sessionRec.name : undefined,
					cwd: typeof sessionRec.cwd === 'string' ? sessionRec.cwd : undefined,
					pid: typeof sessionRec.pid === 'number' ? sessionRec.pid : undefined,
					boundAt: typeof sessionRec.boundAt === 'string' ? sessionRec.boundAt : ''
				}
			: null;
	return {
		id: typeof rec.id === 'string' && rec.id ? rec.id : randomUUID(),
		session,
		text: typeof rec.text === 'string' ? rec.text : '',
		updatedAt: typeof rec.updatedAt === 'string' ? rec.updatedAt : null
	};
}
