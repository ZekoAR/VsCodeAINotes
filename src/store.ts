import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

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

/** The whole content of the dot-file. */
export interface NotesDoc {
	version: 2;
	notes: Note[];
}

export function emptyDoc(): NotesDoc {
	return { version: 2, notes: [] };
}

export function newNote(): Note {
	return { id: randomUUID(), session: null, text: '', updatedAt: null };
}

/**
 * The notes dot-file. One per workspace folder, JSON, written whole.
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
		const dir = path.dirname(this.filePath);
		fs.mkdirSync(dir, { recursive: true });
		const temp = path.join(dir, `.${path.basename(this.filePath)}.${process.pid}.tmp`);
		fs.writeFileSync(temp, serialised, 'utf8');
		fs.renameSync(temp, this.filePath);
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

	if (Array.isArray(rec.notes)) {
		const notes = rec.notes
			.map(entry => readNote(entry as Record<string, unknown>))
			.filter((note): note is Note => note !== undefined);
		return { version: 2, notes };
	}

	// Version 1: one note, its fields at the top level. Migrate rather than discard.
	if (typeof rec.text === 'string' || rec.session) {
		const migrated = readNote(rec);
		return { version: 2, notes: migrated ? [migrated] : [] };
	}
	return emptyDoc();
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
