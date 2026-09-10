import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * A Claude Code session that could own this panel's notes.
 *
 * Two sources feed this, and they answer different questions:
 *   - the live registry (`<claudeHome>/sessions/<pid>.json`) knows what is RUNNING right now,
 *     and is the only place a session's name lives;
 *   - the transcript store (`<claudeHome>/projects/<encoded-cwd>/<sessionId>.jsonl`) knows what
 *     has EVER run in this folder, and is the only place a past session's first prompt lives.
 */
export interface ClaudeSession {
	sessionId: string;
	cwd: string;
	/** Live sessions only - the name other sessions address it by, e.g. "zod-ea". */
	name?: string;
	pid?: number;
	startedAt?: number;
	version?: string;
	entrypoint?: string;
	kind?: string;
	/** True when a process with this pid is still running. */
	live: boolean;
	/** Transcript mtime - the last time this session wrote anything. */
	lastActivity?: number;
	/** The session's own title, as Claude Code writes it into the transcript. */
	title?: string;
	/** First human prompt of the session, used only when the session has no title yet. */
	firstPrompt?: string;
	transcriptPath?: string;
}

/** Root of the Claude Code configuration directory that holds `sessions/` and `projects/`. */
export function claudeHome(override?: string): string {
	if (override && override.trim().length > 0) {
		return expandHome(override.trim());
	}
	const fromEnv = process.env.CLAUDE_CONFIG_DIR;
	if (fromEnv && fromEnv.trim().length > 0) {
		return expandHome(fromEnv.trim());
	}
	return path.join(os.homedir(), '.claude');
}

function expandHome(p: string): string {
	if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) {
		return path.join(os.homedir(), p.slice(1));
	}
	return p;
}

/**
 * Claude Code names a project's transcript folder after its absolute path with every character
 * that is not a letter or a digit replaced by a dash: `c:\D\AINotes` -> `c--D-AINotes`.
 */
export function encodeProjectDirName(cwd: string): string {
	return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

/**
 * Resolve the transcript folder for a workspace. The encoded name embeds the drive letter's case,
 * which VS Code and Claude Code do not always agree on, so match case-insensitively against what
 * is actually on disk before falling back to the computed name.
 */
export function projectTranscriptDir(home: string, workspaceRoot: string): string {
	const projects = path.join(home, 'projects');
	const wanted = encodeProjectDirName(workspaceRoot);
	try {
		for (const entry of fs.readdirSync(projects, { withFileTypes: true })) {
			if (entry.isDirectory() && entry.name.toLowerCase() === wanted.toLowerCase()) {
				return path.join(projects, entry.name);
			}
		}
	} catch {
		// No projects folder yet - fall through to the computed path.
	}
	return path.join(projects, wanted);
}

function samePath(a: string, b: string): boolean {
	return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

/** True when `cwd` is the workspace root or a folder inside it. */
export function isInWorkspace(cwd: string, workspaceRoot: string): boolean {
	if (!cwd) {
		return false;
	}
	if (samePath(cwd, workspaceRoot)) {
		return true;
	}
	const rel = path.relative(path.resolve(workspaceRoot), path.resolve(cwd));
	return rel.length > 0 && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function isProcessAlive(pid: number | undefined): boolean {
	if (typeof pid !== 'number' || !Number.isFinite(pid) || pid <= 0) {
		return false;
	}
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		// EPERM means the process exists but belongs to someone else - still alive.
		return (err as NodeJS.ErrnoException).code === 'EPERM';
	}
}

/**
 * Every Claude session running on this machine right now, from the live registry.
 *
 * This is the only place a session's pretty name exists. It is written per PROCESS, not per
 * session: the same session id restarted under a new pid gets a new name, and nothing in the
 * transcript store records either one. So a name can be looked up while the session runs and can
 * never be recovered afterwards - and it must never be cached and shown as current.
 */
function readRegistry(home: string): ClaudeSession[] {
	const dir = path.join(home, 'sessions');
	let names: string[];
	try {
		names = fs.readdirSync(dir);
	} catch {
		return [];
	}

	const out: ClaudeSession[] = [];
	for (const name of names) {
		if (!name.endsWith('.json')) {
			continue;
		}
		let raw: unknown;
		try {
			raw = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
		} catch {
			continue;
		}
		const rec = raw as Record<string, unknown>;
		const sessionId = typeof rec.sessionId === 'string' ? rec.sessionId : undefined;
		const cwd = typeof rec.cwd === 'string' ? rec.cwd : undefined;
		if (!sessionId || !cwd) {
			continue;
		}
		const pid = typeof rec.pid === 'number' ? rec.pid : undefined;
		if (!isProcessAlive(pid)) {
			// A registry file outlives its process; without this check the picker lists ghosts.
			continue;
		}
		out.push({
			sessionId,
			cwd,
			name: typeof rec.name === 'string' ? rec.name : undefined,
			pid,
			startedAt: typeof rec.startedAt === 'number' ? rec.startedAt : undefined,
			version: typeof rec.version === 'string' ? rec.version : undefined,
			entrypoint: typeof rec.entrypoint === 'string' ? rec.entrypoint : undefined,
			kind: typeof rec.kind === 'string' ? rec.kind : undefined,
			live: true
		});
	}
	return out;
}

/** Sessions currently running with a cwd at or under `workspaceRoot`. */
function readLiveSessions(home: string, workspaceRoot: string): ClaudeSession[] {
	return readRegistry(home).filter(session => isInWorkspace(session.cwd, workspaceRoot));
}

/**
 * True when a process is running the given session right now.
 *
 * Not filtered by workspace: a bound session may have been started in a subfolder. Liveness is the
 * registry's pid still existing, the same check the picker uses to avoid listing ghosts.
 */
export function isSessionRunning(sessionId: string, claudeHomeOverride?: string): boolean {
	return readRegistry(claudeHome(claudeHomeOverride)).some(
		session => session.sessionId === sessionId
	);
}

/**
 * The name a running session answers to for cross-session messaging - `ainotes-devhost-89`.
 *
 * Read from the `name` field of `<claudeHome>/sessions/<pid>.json`, which is also where Claude Code
 * itself gets the address it quotes when asked. The registry only, deliberately: no transcript is
 * touched, so this is cheap enough to call whenever a panel is refreshed.
 *
 * Nothing is cached, because this name belongs to the PROCESS. Restarting a session under the same
 * id produces a different name, and once the process exits the name is gone for good - so a stale
 * one shown as current would be worse than showing none.
 */
export function liveSessionName(sessionId: string, claudeHomeOverride?: string): string | undefined {
	const match = readRegistry(claudeHome(claudeHomeOverride)).find(
		session => session.sessionId === sessionId
	);
	return match?.name;
}

/**
 * How much of a transcript's tail is read looking for a title record.
 *
 * Measured on this machine: in transcripts up to 14.4 MB the last `ai-title` sat between 2.5 KB and
 * 31 KB from the end, so the title is always in the tail and parsing a multi-megabyte file to find
 * it would be waste. The window is the one real limit - a `custom-title` written once and then
 * buried under more than this much later conversation is not found. That is the same failure the
 * official extension has with its 64 KB window, with eight times the margin.
 */
const TITLE_SCAN_BYTES = 512 * 1024;

/**
 * The session's own title, read from the tail of its transcript.
 *
 * Claude Code writes an `ai-title` record once a session's topic is clear and rewrites it as the
 * topic moves, and a `custom-title` record when the session is renamed by hand. The last of each
 * wins, and a hand-written rename beats the generated title - the same precedence the Claude Code
 * extension itself uses.
 */
function readTranscriptTitle(transcriptPath: string): string | undefined {
	let fd: number | undefined;
	try {
		fd = fs.openSync(transcriptPath, 'r');
		const size = fs.fstatSync(fd).size;
		const length = Math.min(size, TITLE_SCAN_BYTES);
		const buf = Buffer.alloc(length);
		fs.readSync(fd, buf, 0, length, size - length);

		let custom: string | undefined;
		let generated: string | undefined;
		for (const line of buf.toString('utf8').split('\n')) {
			// A title record is a rare, tiny line among megabytes of messages, so reject on a
			// substring before paying for a parse.
			if (!line.startsWith('{') || !line.includes('-title"')) {
				continue;
			}
			let rec: Record<string, unknown>;
			try {
				rec = JSON.parse(line) as Record<string, unknown>;
			} catch {
				// The first line of the window is normally cut in half; that is expected.
				continue;
			}
			if (rec.type === 'custom-title' && typeof rec.customTitle === 'string') {
				custom = rec.customTitle;
			} else if (rec.type === 'ai-title' && typeof rec.aiTitle === 'string') {
				generated = rec.aiTitle;
			}
		}
		const title = custom ?? generated;
		return title ? collapse(title) || undefined : undefined;
	} catch {
		return undefined;
	} finally {
		if (fd !== undefined) {
			try {
				fs.closeSync(fd);
			} catch {
				// Nothing useful to do if the handle is already gone.
			}
		}
	}
}

/**
 * What to call a session on screen, resolved from its transcript: its title, else the first thing
 * the human asked it. Both survive the session exiting and both survive it being restarted, which
 * is why neither is the pretty name in the live registry - that one belongs to a process.
 */
export function lookupSessionLabel(
	sessionId: string,
	workspaceRoot: string,
	claudeHomeOverride?: string
): string | undefined {
	const home = claudeHome(claudeHomeOverride);
	const transcript = path.join(projectTranscriptDir(home, workspaceRoot), `${sessionId}.jsonl`);
	return readTranscriptTitle(transcript) ?? readFirstPrompt(transcript);
}

const FIRST_PROMPT_SCAN_BYTES = 256 * 1024;

/**
 * The first prompt a human typed in a session, read from the head of the transcript.
 *
 * Transcripts reach tens of megabytes, so only the first chunk is read. Slash commands, local
 * command output and injected caveats are all `type: "user"` too, so they are skipped explicitly -
 * labelling a session "/model" tells the reader nothing.
 */
function readFirstPrompt(transcriptPath: string): string | undefined {
	let fd: number | undefined;
	try {
		fd = fs.openSync(transcriptPath, 'r');
		const buf = Buffer.alloc(FIRST_PROMPT_SCAN_BYTES);
		const read = fs.readSync(fd, buf, 0, FIRST_PROMPT_SCAN_BYTES, 0);
		const lines = buf.subarray(0, read).toString('utf8').split('\n');
		for (const line of lines) {
			if (!line.startsWith('{')) {
				continue;
			}
			let rec: Record<string, unknown>;
			try {
				rec = JSON.parse(line) as Record<string, unknown>;
			} catch {
				// The final line of the chunk is usually truncated; that is expected.
				continue;
			}
			if (rec.type !== 'user' || rec.isMeta === true || rec.isSidechain === true) {
				continue;
			}
			const message = rec.message as { content?: unknown } | undefined;
			const text = extractText(message?.content);
			if (!text) {
				continue;
			}
			// `<command-name>`, `<local-command-stdout>`, `<local-command-caveat>` and friends.
			if (text.startsWith('<')) {
				continue;
			}
			return collapse(text);
		}
	} catch {
		return undefined;
	} finally {
		if (fd !== undefined) {
			try {
				fs.closeSync(fd);
			} catch {
				// Nothing useful to do if the handle is already gone.
			}
		}
	}
	return undefined;
}

function extractText(content: unknown): string | undefined {
	if (typeof content === 'string') {
		return content.trim() || undefined;
	}
	if (Array.isArray(content)) {
		for (const part of content) {
			const p = part as { type?: unknown; text?: unknown };
			if (p && p.type === 'text' && typeof p.text === 'string' && p.text.trim()) {
				return p.text.trim();
			}
		}
	}
	return undefined;
}

function collapse(text: string): string {
	return text.replace(/\s+/g, ' ').trim();
}

/** Every session that has ever run in this workspace, newest transcript first. */
function readHistorySessions(home: string, workspaceRoot: string): ClaudeSession[] {
	const dir = projectTranscriptDir(home, workspaceRoot);
	let names: string[];
	try {
		names = fs.readdirSync(dir);
	} catch {
		return [];
	}

	const out: ClaudeSession[] = [];
	for (const name of names) {
		if (!name.endsWith('.jsonl')) {
			continue;
		}
		const full = path.join(dir, name);
		let stat: fs.Stats;
		try {
			stat = fs.statSync(full);
		} catch {
			continue;
		}
		if (!stat.isFile()) {
			continue;
		}
		out.push({
			sessionId: name.slice(0, -'.jsonl'.length),
			cwd: workspaceRoot,
			live: false,
			lastActivity: stat.mtimeMs,
			transcriptPath: full
		});
	}
	out.sort((a, b) => (b.lastActivity ?? 0) - (a.lastActivity ?? 0));
	return out;
}

export interface ScanOptions {
	workspaceRoot: string;
	claudeHomeOverride?: string;
	/** How many past sessions to list below the live ones. 0 lists live sessions only. */
	historyLimit: number;
}

/**
 * Live sessions first (they are what "active" means), then past sessions from the transcript
 * store. A live session that also has a transcript appears once, carrying both its name and its
 * last-activity time.
 */
export function scanSessions(options: ScanOptions): ClaudeSession[] {
	const home = claudeHome(options.claudeHomeOverride);
	const live = readLiveSessions(home, options.workspaceRoot);
	const history = readHistorySessions(home, options.workspaceRoot);
	const historyById = new Map(history.map(s => [s.sessionId, s]));

	for (const session of live) {
		const past = historyById.get(session.sessionId);
		if (past) {
			session.lastActivity = past.lastActivity;
			session.transcriptPath = past.transcriptPath;
			historyById.delete(session.sessionId);
		}
	}
	live.sort((a, b) => (b.lastActivity ?? b.startedAt ?? 0) - (a.lastActivity ?? a.startedAt ?? 0));

	const rest = [...historyById.values()].slice(0, Math.max(0, options.historyLimit));
	for (const session of [...live, ...rest]) {
		if (!session.transcriptPath) {
			// A live session started in a subfolder writes under ITS OWN encoded cwd, not the
			// workspace root's, so the history scan above never saw it.
			const own = path.join(
				projectTranscriptDir(home, session.cwd),
				`${session.sessionId}.jsonl`
			);
			if (fs.existsSync(own)) {
				session.transcriptPath = own;
			}
		}
		if (!session.transcriptPath) {
			continue;
		}
		session.title = readTranscriptTitle(session.transcriptPath);
		if (!session.firstPrompt) {
			// Read even when a title was found: the picker shows it as the row's detail line, and
			// it is the fallback label for a session too young to have been titled.
			session.firstPrompt = readFirstPrompt(session.transcriptPath);
		}
	}
	return [...live, ...rest];
}

/** The one-line label for a session: its title, else its first prompt, else its id. */
export function sessionLabel(session: ClaudeSession): string {
	if (session.title) {
		return truncate(session.title, 60);
	}
	if (session.firstPrompt) {
		return truncate(session.firstPrompt, 60);
	}
	return session.sessionId.slice(0, 8);
}

export function truncate(text: string, max: number): string {
	return text.length <= max ? text : text.slice(0, max - 1).trimEnd() + '\u2026';
}

export function describeAge(at: number | undefined, now = Date.now()): string {
	if (!at) {
		return 'unknown';
	}
	const seconds = Math.max(0, Math.round((now - at) / 1000));
	if (seconds < 60) {
		return `${seconds}s ago`;
	}
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) {
		return `${minutes}m ago`;
	}
	const hours = Math.round(minutes / 60);
	if (hours < 24) {
		return `${hours}h ago`;
	}
	return `${Math.round(hours / 24)}d ago`;
}
