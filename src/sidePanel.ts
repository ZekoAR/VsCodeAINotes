import { execFile } from 'child_process';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import * as vscode from 'vscode';
import { isClaudeTab } from './claudeTabs';
import { NoteChange, NotesWorkspace } from './notesWorkspace';

/**
 * The comment the patch script leaves in `workbench.html`. Detection reads this; the scripts below
 * carry their own copy, and the two must stay in step.
 */
const INJECT_MARKER = '<!-- AI Notes spike -->';

/**
 * The session a tab caption names, matched against a scan already taken.
 *
 * Returns the session rather than just its title, because the row needs its id as well - that is
 * what the note is read by.
 *
 * VS Code truncates a long caption with an ellipsis - `Claude capabilities over…` - so the exact
 * comparison only succeeds for captions short enough to have survived intact. The prefix pass covers
 * the rest, and insists on a unique hit: two sessions sharing an opening is a tie, and picking either
 * would be a guess.
 */
function matchSession<T extends { label: string }>(caption: string, sessions: T[]): T | undefined {
	const wanted = caption.trim();
	const exact = sessions.find(session => session.label.trim() === wanted);
	if (exact) {
		return exact;
	}
	const stem = wanted.replace(/[….\s]+$/, '').trim();
	if (!stem || stem === wanted) {
		return undefined;
	}
	const hits = sessions.filter(session => session.label.trim().startsWith(stem));
	return hits.length === 1 ? hits[0] : undefined;
}

/**
 * How much of a note travels to the side panel for one row's tooltip.
 *
 * The rows are rebuilt on every note change, so on every autosave, and a note has no size limit.
 * Long enough that a real note arrives whole; short enough that a pathological one cannot make each
 * save carry it again.
 */
const ROW_NOTE_LIMIT = 4000;

/** Where the folder note's panel size and open state live - view state, so per machine. */
const GENERAL_HEIGHT_KEY = 'ainotes.general.height';
const GENERAL_OPEN_KEY = 'ainotes.general.open';

/** A per-render nonce, so the webview's CSP can name the one script it will run. */
function makeNonce(): string {
	const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	let out = '';
	for (let i = 0; i < 32; i++) {
		out += alphabet[Math.floor(Math.random() * alphabet.length)];
	}
	return out;
}

/** A message sent from the side panel's webview to the extension host. */
type InboundMessage =
	| { type: 'ready' }
	| { type: 'spikePatch' }
	| { type: 'spikeUnpatch' }
	| { type: 'injectedRegister'; panel: string; caption: string; version?: string }
	| { type: 'injectedSave'; panel: string; caption: string; text: string }
	| { type: 'injectedHeight'; panel: string; caption: string; height: number }
	| { type: 'generalSave'; text: string }
	| { type: 'generalHeight'; height: number }
	| { type: 'generalOpen'; open: boolean }
	| { type: 'runInjector' };

/**
 * Copies `media/ainotes-inject.js` in as `ainotes.js` beside every `workbench.html` under
 * `%LOCALAPPDATA%\Programs\Microsoft VS Code` and injects a script tag for it, then reports what it
 * did per install tree.
 *
 * The payload is copied from a real file rather than written from a string here: it is ordinary JS
 * that has to stay readable and syntax-checkable, and escaping it through PowerShell would cost
 * both. Its path arrives in `AINOTES_INJECT_SRC`.
 *
 * Every tree is patched, not only the running one: an update already staged beside it becomes the
 * live app root on the next restart, so patching one tree alone would look like a silent failure.
 * Each tree is decided on its own, so a mixed estate - one patched by an earlier run, one fresh from
 * an update - ends up uniformly patched rather than the whole run stopping at the first one it finds
 * already done.
 *
 * The payload is re-copied on every run, injected tag or not. Skipping a tree that already carries
 * the tag would leave it running whatever `ainotes.js` it was first given, so a rebuilt payload would
 * never reach it and the next restart would test the previous version while looking like a success.
 *
 * The layout check is the whole safety of this: the file is only touched when its tail is exactly
 * the startup comment, the `workbench.js` module tag and `</html>`. The insertion reuses the file's
 * own newline and indentation through the captured groups, and every write goes out as UTF-8
 * without a BOM, because PowerShell's own `Set-Content -Encoding UTF8` would add one.
 */
const SPIKE_PATCH_SCRIPT = `
$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)
$pattern = "$env:LOCALAPPDATA/Programs/Microsoft VS Code/*/resources/app/out/vs/code/electron-browser/workbench/workbench.html"
$marker = '<!-- AI Notes spike -->'
$expected = '(?s)<!-- Startup \\(do not modify order of script tags!\\) -->\\s*<script src="\\./workbench\\.js" type="module"></script>\\s*</html>\\s*$'
$anchor = '(\\r?\\n)([ \\t]*)<script src="\\./workbench\\.js" type="module"></script>'
$insert = '$1$2<script src="./workbench.js" type="module"></script>$1$2<!-- AI Notes spike -->$1$2<script src="./ainotes.js" type="module"></script>'
$source = $env:AINOTES_INJECT_SRC
if (-not $source -or -not (Test-Path $source)) { "ABORTED: injected script not found at '$source'"; return }
$ui = Join-Path (Split-Path $source) 'ainotes-ui.html'
if (-not (Test-Path $ui)) { "ABORTED: framed UI not found at '$ui'"; return }

$files = @(Get-ChildItem -Path $pattern -File -ErrorAction SilentlyContinue)
if ($files.Count -eq 0) { 'No workbench.html found.'; return }
foreach ($f in $files) {
  $text = [IO.File]::ReadAllText($f.FullName)
  $target = Join-Path $f.DirectoryName 'ainotes.js'
  $injected = $text.Contains($marker)
  if (-not $injected) {
    if ($text -notmatch $expected) { "SKIPPED (layout not as expected)  $($f.FullName)"; continue }
    $new = [regex]::Replace($text, $anchor, $insert)
    if ($new -eq $text) { "SKIPPED (anchor not matched)  $($f.FullName)"; continue }
    [IO.File]::WriteAllText($f.FullName, $new, $utf8)
  }
  $before = if (Test-Path $target) { (Get-FileHash $target -Algorithm SHA256).Hash } else { '' }
  Copy-Item $source $target -Force
  Copy-Item $ui (Join-Path $f.DirectoryName 'ainotes-ui.html') -Force
  # Stamp the revision into the copy, so the running payload reports which build installed it and a
  # stale injection can say so itself instead of being diagnosed by hand.
  $stamped = ([IO.File]::ReadAllText($target)).Replace('__AINOTES_VERSION__', $env:AINOTES_VERSION)
  [IO.File]::WriteAllText($target, $stamped, $utf8)
  $after = (Get-FileHash $target -Algorithm SHA256).Hash
  $payload = if ($before -eq $after) { 'payload unchanged' } else { 'payload updated' }
  $what = if ($injected) { 'ALREADY INJECTED' } else { 'PATCHED' }
  "{0}, {1}  {2}" -f $what, $payload, $f.FullName
}
`;

/** Undoes {@link SPIKE_PATCH_SCRIPT} - drops the injected tag and deletes `ainotes.js`. */
const SPIKE_UNPATCH_SCRIPT = `
$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)
$pattern = "$env:LOCALAPPDATA/Programs/Microsoft VS Code/*/resources/app/out/vs/code/electron-browser/workbench/workbench.html"
$marker = '<!-- AI Notes spike -->'
$injected = '(\\r?\\n)[ \\t]*<!-- AI Notes spike -->(\\r?\\n)[ \\t]*<script src="\\./ainotes\\.js" type="module"></script>'

$files = @(Get-ChildItem -Path $pattern -File -ErrorAction SilentlyContinue)
if ($files.Count -eq 0) { 'No workbench.html found.'; return }
foreach ($f in $files) {
  $text = [IO.File]::ReadAllText($f.FullName)
  $dropped = @('ainotes.js', 'ainotes-ui.html') | ForEach-Object { Join-Path $f.DirectoryName $_ }
  if (-not $text.Contains($marker)) {
    $stray = @($dropped | Where-Object { Test-Path $_ })
    if ($stray.Count -gt 0) { $stray | Remove-Item -Force; "REMOVED STRAY FILES  $($f.DirectoryName)" }
    else { "NOT PATCHED  $($f.FullName)" }
    continue
  }
  $new = [regex]::Replace($text, $injected, '')
  [IO.File]::WriteAllText($f.FullName, $new, $utf8)
  $dropped | Where-Object { Test-Path $_ } | Remove-Item -Force
  "UNPATCHED  $($f.FullName)"
}
`;

/**
 * The activity-bar panel: the state of the injection, and the Claude tabs currently open.
 *
 * It is also the relay. A panel injected into a Claude tab cannot reach the extension host, so every
 * note it reads or writes travels through this webview - which is why its webview is retained while
 * hidden.
 *
 * A webview rather than a tree, because a tree cannot tell a double click from a single one - the
 * VS Code API has no double-click event at all, and `TreeItem.command` fires on selection.
 */
export class SidePanelProvider implements vscode.WebviewViewProvider {
	static readonly viewType = 'ainotes.sidePanel';

	private view: vscode.WebviewView | undefined;
	private readonly disposables: vscode.Disposable[] = [];
	private spikeOutput: vscode.OutputChannel | undefined;
	/** Cached hash of the shipped payload - the files cannot change while the host is running. */
	private revision: string | undefined;
	/** So the development case is noted in the log once, not on every register. */
	private unstampedNoted = false;
	/** The caption set the cache was resolved for; a change is what triggers a rescan. */
	private titleKey = '';
	/** Caption -> what the scan matched it to. The note itself is NOT cached here - it changes. */
	private matched = new Map<string, { label: string; sessionId: string }>();
	/**
	 * Panels currently showing a note, by the id the injected script gave them.
	 *
	 * `pushed` is the text last sent to that panel, which is what stops a change event bouncing
	 * back out as a fresh push. A panel is removed on error so that it resumes announcing itself.
	 */
	private readonly registered = new Map<
		string,
		{ sessionId: string; noteId?: string; pushed: string }
	>();

	/**
	 * `workspace` is absent in a window with no folder open. The provider is registered anyway: a
	 * view whose provider never registers shows a loading bar for the lifetime of the window, so the
	 * panel has to be able to say what is wrong itself.
	 */
	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly workspace: NotesWorkspace | undefined,
		/** Per-machine view state: panel heights, keyed by session. */
		private readonly state?: vscode.Memento
	) {
		// The list shows which sessions already have a note, so it repaints when notes change - and
		// the same event is what carries an edit made elsewhere out to the injected panels.
		if (this.workspace) {
			this.disposables.push(
				this.workspace.onDidChange(change => {
					this.postRows();
					// Skipped when this panel is what caused it: the textarea already holds the text,
					// and pushing it back would fight whatever has been typed since.
					if (change.origin !== this) {
						this.postGeneral();
					}
					this.pushChange(change);
				})
			);
		}
		// The list is of OPEN Claude tabs, so it follows the tab state rather than the notes file.
		this.disposables.push(vscode.window.tabGroups.onDidChangeTabs(() => this.postRows()));
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
					this.postGeneral();
					// The panel has no way to look at the install itself, so the state of the
					// injection is pushed to it the moment it is able to render.
					this.postInjectState();
					return;
				case 'spikePatch':
					this.runSpike('Patching workbench.html', SPIKE_PATCH_SCRIPT);
					return;
				case 'spikeUnpatch':
					this.runSpike('Removing the workbench.html injection', SPIKE_UNPATCH_SCRIPT);
					return;
				case 'injectedRegister':
					// A stale panel is offered the update instead of a note, so the version gate
					// decides whether registering proceeds at all.
					if (this.checkPayloadVersion(message.panel, message.version)) {
						this.injectedRegister(message.panel, message.caption);
					}
					return;
				case 'runInjector':
					this.runSpike('Updating the injected script', SPIKE_PATCH_SCRIPT, () => {
						// No panel id: every panel is running the payload that was just replaced, so
						// they all need telling, and the side panel shows it for the window.
						void this.view?.webview.postMessage({ type: 'injectedPatched' });
						this.postInjectState();
					});
					return;
				case 'injectedSave':
					this.injectedSave(message.panel, message.caption, message.text);
					return;
				case 'injectedHeight':
					this.injectedHeight(message.caption, message.height);
					return;
				case 'generalSave':
					this.workspace?.setGeneralText(message.text, this);
					return;
				case 'generalHeight':
					void this.state?.update(GENERAL_HEIGHT_KEY, Math.round(message.height));
					return;
				case 'generalOpen':
					void this.state?.update(GENERAL_OPEN_KEY, message.open);
					return;
			}
		});

		view.onDidChangeVisibility(() => {
			if (view.visible) {
				this.postRows();
			}
		});
	}

	/**
	 * The open Claude tabs, in the order VS Code holds them.
	 *
	 * Captions, not sessions: this list is about what is on screen, and the caption is also the only
	 * handle the injected script can use to find a tab in the DOM and focus it.
	 */
	private claudeTabRows(): Array<{
		caption: string;
		label: string;
		note: string;
		active: boolean;
	}> {
		const rows: Array<{ caption: string; label: string; note: string; active: boolean }> = [];
		for (const group of vscode.window.tabGroups.all) {
			for (const tab of group.tabs) {
				if (isClaudeTab(tab)) {
					// `caption` is what the tab actually shows, and stays on the row because focusing a
					// tab means finding it in the DOM by that exact text. `label` is what the reader
					// sees, and is the untruncated session title when one can be matched.
					rows.push({ caption: tab.label, label: tab.label, note: '', active: tab.isActive });
				}
			}
		}
		this.resolveRows(rows);
		return rows;
	}

	/**
	 * Fill in each row's title and note.
	 *
	 * Two different lifetimes, deliberately. The caption-to-session match needs a scan, which reads a
	 * 512 KB tail and a 256 KB head per session for up to `sessionHistoryLimit` sessions - and this
	 * runs from `postRows`, which fires on every note change, so on every autosave. That match is
	 * therefore cached against the set of captions, and cannot go stale in the way that matters: a
	 * tab's caption IS its title, so a session being retitled changes the caption and invalidates it.
	 *
	 * The note itself is read fresh every time, from the document already in memory. It changes on
	 * exactly the events that bring us here, so caching it is the one thing that would be wrong.
	 */
	private resolveRows(
		rows: Array<{ caption: string; label: string; note: string; active: boolean }>
	): void {
		const workspace = this.workspace;
		if (!workspace || rows.length === 0) {
			return;
		}
		const key = rows.map(row => row.caption).join(' ');
		if (key !== this.titleKey) {
			this.titleKey = key;
			this.matched = new Map();
			const sessions = workspace.listSessions();
			for (const caption of new Set(rows.map(row => row.caption))) {
				const session = matchSession(caption, sessions);
				if (session) {
					this.matched.set(caption, { label: session.label, sessionId: session.id });
				}
			}
		}
		for (const row of rows) {
			const match = this.matched.get(row.caption);
			row.label = match?.label || row.caption;
			if (!match) {
				continue;
			}
			const noteId = workspace.noteIdForSession(match.sessionId);
			const text = noteId ? (workspace.note(noteId)?.text ?? '') : '';
			row.note = text.length > ROW_NOTE_LIMIT ? text.slice(0, ROW_NOTE_LIMIT) + '…' : text;
		}
	}

	/**
	 * The folder note, its panel size and whether it was left open.
	 *
	 * `available` is what hides the button in a window with no folder open: there is nowhere to
	 * store a folder note without a folder, so offering one would be a dead end.
	 */
	private postGeneral(): void {
		if (!this.view?.visible) {
			return;
		}
		void this.view.webview.postMessage({
			type: 'generalState',
			available: Boolean(this.workspace),
			text: this.workspace?.generalText() ?? '',
			height: this.state?.get<number>(GENERAL_HEIGHT_KEY),
			open: this.state?.get<boolean>(GENERAL_OPEN_KEY) ?? false
		});
	}

	private postRows(): void {
		if (!this.view?.visible) {
			return;
		}
		void this.view.webview.postMessage({
			type: 'rows',
			rows: this.claudeTabRows(),
			noFolder: !this.workspace
		});
	}

	/**
	 * Answer a panel injected into a Claude tab.
	 *
	 * The injected side knows which tab it sits in and nothing more - the Claude webview's own url
	 * carries a webview id, never a session id - so it asks by the tab's caption, which is the
	 * session's title, and resolving that stays here where the transcripts are readable.
	 */
	private payloadPath(name: string): string {
		return vscode.Uri.joinPath(this.extensionUri, 'media', name).fsPath;
	}

	/**
	 * A revision for the injected payload: a hash of the two files this extension would install.
	 *
	 * Content, not a version number. A hand-maintained version changes only when someone remembers,
	 * and the mismatch worth catching is exactly the one where an old payload is running under a new
	 * extension - the payload that cost an evening reported an entirely correct version. Hashing the
	 * files means any edit to either is a new revision, and the placeholder is hashed as it lies on
	 * disk so the value is stable and computable from both ends.
	 */
	private payloadRevision(): string {
		if (!this.revision) {
			try {
				const hash = createHash('sha256');
				for (const name of ['ainotes-inject.js', 'ainotes-ui.html']) {
					hash.update(readFileSync(this.payloadPath(name)));
				}
				this.revision = hash.digest('hex').slice(0, 12);
			} catch {
				// Unreadable payload is not a reason to break the panel; nothing will match it, so a
				// mismatch is reported and pressing update surfaces the real error.
				this.revision = 'unreadable';
			}
		}
		return this.revision;
	}

	/**
	 * Compare what the injection reports against what this extension ships.
	 *
	 * An old payload predating the version stamp reports the placeholder untouched, and one patched
	 * by an older build reports that build's revision. Both are mismatches, and both are the user's
	 * to fix with one press rather than a documented dance.
	 */
	/**
	 * Decide whether a panel may proceed, on the strength of the revision it reports.
	 *
	 * **An unstamped payload is treated as current.** That is the development case - the payload
	 * was copied in by hand, or patched by a build that predates stamping - and blocking it would
	 * mean re-running the injector after every edit to a payload file just to be allowed to test.
	 * Version enforcement only applies once a payload actually carries a revision, which is to say
	 * once it was installed by a build that knew how to stamp one.
	 *
	 */
	private checkPayloadVersion(panel: string, reported: string | undefined): boolean {
		const stamped = reported && reported !== '__AINOTES_VERSION__' ? reported : undefined;
		if (!stamped) {
			if (!this.unstampedNoted) {
				this.unstampedNoted = true;
				this.trace('payload carries no revision - treated as current (development)');
			}
			return true;
		}
		const expected = this.payloadRevision();
		if (stamped === expected) {
			return true;
		}
		this.trace(`payload STALE: injected ${stamped}, extension ships ${expected}`);
		// Both surfaces are told: the side panel raises it once for the window, and the panel itself
		// shows the same offer in place of the note. Showing a note out of an old payload would be
		// the worst of both - it looks like it works, and it is running code we did not ship.
		void this.view?.webview.postMessage({
			type: 'injectedStale',
			panel,
			installed: stamped,
			expected
		});
		return false;
	}

	/**
	 * Whether the workbench this window is running has our tag in it.
	 *
	 * Read from `vscode.env.appRoot` rather than by globbing the install: the app root rotates with
	 * every VS Code update, and the only tree that can affect THIS window is the one it booted from.
	 * Unreadable counts as unknown, which shows nothing - nagging about a file we cannot see would be
	 * a guess.
	 */
	private isWorkbenchPatched(): boolean | undefined {
		try {
			const html = readFileSync(
				join(vscode.env.appRoot, 'out', 'vs', 'code', 'electron-browser', 'workbench', 'workbench.html'),
				'utf8'
			);
			return html.includes(INJECT_MARKER);
		} catch {
			return undefined;
		}
	}

	/** Tell the panel whether this window's workbench carries the injection at all. */
	private postInjectState(): void {
		const patched = this.isWorkbenchPatched();
		this.trace(`workbench patched: ${patched === undefined ? 'unknown' : patched}`);
		void this.view?.webview.postMessage({ type: 'injectState', patched });
	}

	/** Both halves of the contract traffic, in the Output panel, so neither side is taken on trust. */
	private trace(line: string): void {
		if (!this.spikeOutput) {
			this.spikeOutput = vscode.window.createOutputChannel('AI Notes');
		}
		this.spikeOutput.appendLine(`${new Date().toLocaleTimeString()}  ${line}`);
	}

	/**
	 * The session a caption names, or the only one running here.
	 *
	 * Three attempts, weakest last. The exact match is the only one that is certain. VS Code's tab
	 * caption for a long title is truncated with an ellipsis - measured `Claude capabilities over…`,
	 * in `aria-label` as well as in the label text, with no untruncated copy anywhere in the DOM -
	 * and `sessionIdForLabel` compares exactly, so a long title never resolves without the prefix
	 * pass. The sole-live-session fallback then covers a tab still captioned "Claude Code", which is
	 * what `resolveSession` has always leaned on. A prefix that two sessions answer to resolves to
	 * nothing rather than to a guess.
	 */
	private sessionForCaption(caption: string): string | undefined {
		const workspace = this.workspace;
		if (!workspace) {
			this.trace('  resolve: no workspace folder open');
			return undefined;
		}
		const exact = workspace.sessionIdForLabel(caption);
		if (exact) {
			this.trace(`  resolve: exact caption match -> ${exact.slice(0, 8)}`);
			return exact;
		}
		const sessions = workspace.listSessions();
		const stem = caption.replace(/[….\s]+$/, '').trim();
		if (stem && stem !== caption.trim()) {
			const hits = sessions.filter(row => row.label.trim().startsWith(stem));
			if (hits.length === 1) {
				this.trace(`  resolve: prefix "${stem}" -> ${hits[0].id.slice(0, 8)}`);
				return hits[0].id;
			}
			this.trace(`  resolve: prefix "${stem}" matched ${hits.length} sessions`);
		}
		const sole = workspace.soleLiveSessionId();
		if (sole) {
			this.trace(`  resolve: sole live session -> ${sole.slice(0, 8)}`);
			return sole;
		}
		// Everything that was considered, so a failure is diagnosable from the log alone rather than
		// by asking for the session list separately.
		const live = sessions.filter(row => row.live).length;
		this.trace(`  resolve: FAILED. ${sessions.length} sessions known, ${live} live:`);
		for (const row of sessions.slice(0, 8)) {
			this.trace(`    ${row.live ? 'live' : 'past'}  ${row.id.slice(0, 8)}  "${row.label}"`);
		}
		return undefined;
	}

	private pushNotes(panel: string, sessionId: string): void {
		const noteId = this.workspace?.noteIdForSession(sessionId);
		// The non-creating lookup: a panel appearing must not write an empty note into the file for
		// every session anyone glances at. The note is created on the first save.
		const text = noteId ? (this.workspace?.note(noteId)?.text ?? '') : '';
		this.registered.set(panel, { sessionId, noteId, pushed: text });
		const height = this.storedHeight(sessionId);
		// The address the session answers to for cross-session messaging, which is the identity worth
		// showing - the session uuid is not something anyone types anywhere.
		const agent = this.workspace?.liveNameFor(sessionId);
		this.trace(
			`notes -> ${panel} session=${sessionId.slice(0, 8)}${agent ? ` (${agent})` : ''} ` +
				`${text.length} chars` +
				(height ? `, height ${height}px` : '')
		);
		void this.view?.webview.postMessage({
			type: 'injectedNotes',
			panel,
			sessionId,
			agent,
			text,
			height
		});
	}

	private pushError(panel: string, problem: string): void {
		// Left out of `registered` on purpose: an unregistered panel keeps announcing itself, which
		// is what makes a closed and reopened Claude tab reconnect without anyone doing anything.
		this.registered.delete(panel);
		this.trace(`error -> ${panel}: ${problem}`);
		void this.view?.webview.postMessage({ type: 'injectedError', panel, problem });
	}

	/**
	 * A panel announcing itself. Idempotent by design - it arrives on every panel creation, whenever
	 * this webview reports ready, and on repeat for any panel still waiting, so registering twice
	 * must cost nothing.
	 */
	private injectedRegister(panel: string, caption: string): void {
		// Acknowledged before anything can fail, so the log always shows the panel arriving even when
		// resolving it does not work - "did the server see me at all" is the first question.
		const again = this.registered.has(panel) ? ' (again)' : '';
		this.trace(`ACK register${again} panel=${panel} caption="${caption}"`);
		const sessionId = this.sessionForCaption(caption);
		if (!sessionId) {
			this.pushError(
				panel,
				`no session matches "${caption}", and no single session is running in this folder`
			);
			return;
		}
		this.pushNotes(panel, sessionId);
	}

	/** Where a session's panel height lives. Per session, so each tab reopens the size it was left. */
	private heightKey(sessionId: string): string {
		return `ainotes.panelHeight.${sessionId}`;
	}

	private storedHeight(sessionId: string): number | undefined {
		return this.state?.get<number>(this.heightKey(sessionId));
	}

	/**
	 * Remember a dragged panel height against its session.
	 *
	 * Workspace state rather than the notes file: it is a per-machine view preference, and putting it
	 * in the dot-file would make a window size a thing that shows up in a diff.
	 */
	private injectedHeight(caption: string, height: number): void {
		const sessionId = this.sessionForCaption(caption);
		if (!sessionId || !this.state || !Number.isFinite(height)) {
			return;
		}
		void this.state.update(this.heightKey(sessionId), Math.round(height));
		this.trace(`height ${Math.round(height)}px remembered for ${sessionId.slice(0, 8)}`);
	}

	private injectedSave(panel: string, caption: string, text: string): void {
		const known = this.registered.get(panel);
		const sessionId = known?.sessionId ?? this.sessionForCaption(caption);
		if (!sessionId || !this.workspace) {
			this.pushError(panel, `nowhere to save: no session matches "${caption}"`);
			return;
		}
		const note = this.workspace.noteForSession(sessionId);
		if (this.workspace.isReadOnly(note.id)) {
			// `setText` drops these silently, so without this the panel would look like it saved.
			this.pushError(panel, 'this session has ended - notes here are read-only');
			return;
		}
		// The panel id is the origin, so the change event this causes is not echoed back to the
		// panel that typed it - it already shows the text.
		this.workspace.setText(note.id, text, panel);
		this.registered.set(panel, { sessionId, noteId: note.id, pushed: text });
		this.trace(`save ${panel} session=${sessionId.slice(0, 8)} ${text.length} chars`);
		void this.view?.webview.postMessage({ type: 'injectedSaved', panel, at: Date.now() });
	}

	/**
	 * Push a note that changed elsewhere - the notes editor, the dot-file being edited by hand - to
	 * any panel showing it. The panel that caused the change is skipped by origin, and a panel whose
	 * text already matches is skipped too, so this cannot loop.
	 */
	private pushChange(change: NoteChange): void {
		if (!change.textChanged) {
			return;
		}
		for (const [panel, state] of this.registered) {
			if (panel === change.origin) {
				continue;
			}
			if (change.noteId && state.noteId && change.noteId !== state.noteId) {
				continue;
			}
			const noteId = state.noteId ?? this.workspace?.noteIdForSession(state.sessionId);
			const text = noteId ? (this.workspace?.note(noteId)?.text ?? '') : '';
			if (text === state.pushed) {
				continue;
			}
			this.pushNotes(panel, state.sessionId);
		}
	}

	private runSpike(what: string, script: string, done?: () => void): void {
		if (!this.spikeOutput) {
			this.spikeOutput = vscode.window.createOutputChannel('AI Notes');
		}
		const output = this.spikeOutput;
		output.show(true);
		output.appendLine(`${what} ...`);
		// Through the environment rather than into the script text: a path with a quote or a space in
		// it cannot break out of a variable the way it could out of an interpolated command line.
		const injectSource = this.payloadPath('ainotes-inject.js');
		execFile(
			'powershell.exe',
			['-NoProfile', '-NonInteractive', '-Command', script],
			{
				windowsHide: true,
				env: {
					...process.env,
					AINOTES_INJECT_SRC: injectSource,
					AINOTES_VERSION: this.payloadRevision()
				}
			},
			(error, stdout, stderr) => {
				const lines = stdout
					.split(/\r?\n/)
					.map(line => line.trim())
					.filter(line => line.length > 0);
				if (lines.length === 0) {
					output.appendLine('No matches found.');
				}
				for (const line of lines) {
					output.appendLine(line);
				}
				if (stderr.trim()) {
					output.appendLine(`stderr: ${stderr.trim()}`);
				}
				if (error) {
					output.appendLine(`Error: ${error.message}`);
				}
				// Only after the script has actually run: telling the reader to restart before the
				// files were written would send them to restart into the same stale payload.
				if (!error) {
					done?.();
				}
			}
		);
	}

	dispose(): void {
		for (const disposable of this.disposables) {
			disposable.dispose();
		}
		this.spikeOutput?.dispose();
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
<div id="stale" class="stale" role="alert" style="display:none"></div>
<div id="rows" class="side-list" role="listbox" tabindex="-1"></div>
<!-- The folder's own note. Its splitter sits between the list and the field, the same shape the
     panel injected into a Claude tab uses. -->
<div id="general" hidden>
  <div id="general-split" title="Drag to resize"><span class="grip"><i></i><i></i><i></i></span></div>
  <textarea id="general-text" placeholder="Notes for this folder..." spellcheck="false"></textarea>
</div>
<!-- Actions that reach outside the workspace and need a restart to take effect. Kept behind the
     menu rather than in reach: patching VS Code itself is not a thing to click by accident. -->
<div id="dev-tools" class="side-bottom" hidden>
  <button id="spike-patch" class="primary wide" type="button">Patch VS Code</button>
  <button id="spike-unpatch" class="primary wide" type="button">Un-patch VS Code</button>
</div>
<div class="side-menu">
  <button id="general-toggle" class="iconbtn" type="button" aria-expanded="false" aria-controls="general" title="Notes for this folder" hidden>n</button>
  <button id="menu" class="iconbtn" type="button" aria-expanded="false" aria-controls="dev-tools" title="Menu">&#9776;</button>
</div>
<!-- One hover card, reused by every row. Styled like VS Code's own hover rather than left to the
     OS tooltip, which cannot be themed. It lives inside this webview, so unlike the OS tooltip it
     cannot extend past the panel - hence the clamping in side.js. -->
<div id="tip" role="tooltip" hidden></div>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
	}
}
