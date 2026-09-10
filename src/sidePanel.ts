import { execFile } from 'child_process';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import * as vscode from 'vscode';
import { NoteChange, NotesWorkspace, SessionRow } from './notesWorkspace';

/**
 * The comment the patch script leaves in `workbench.html`. Detection reads this; the scripts below
 * carry their own copy, and the two must stay in step.
 */
const INJECT_MARKER = '<!-- AI Notes spike -->';

/**
 * The sessions a tab caption could name, best first, matched against a scan already taken.
 *
 * Returns every candidate rather than insisting on one, because the caller assigns them: two tabs
 * with the same caption take one session each. Which is the whole point - a caption is not an
 * identity, and Claude Code will happily give two sessions the same title.
 *
 * The two passes are treated differently on purpose. Titles that are EXACTLY equal are
 * indistinguishable by definition, so all of them are offered and any one-to-one assignment is as
 * good as another. A truncated caption - VS Code cuts a long one with an ellipsis, so
 * `Claude capabilities over…` - is matched by prefix, and there the sessions ARE distinguishable:
 * two different titles sharing an opening is a tie, and guessing would file a note against the
 * wrong session. That still resolves to nothing.
 */
function matchSessions<T extends { label: string }>(caption: string, sessions: T[]): T[] {
	const wanted = caption.trim();
	const exact = sessions.filter(session => session.label.trim() === wanted);
	if (exact.length > 0) {
		return exact;
	}
	const stem = wanted.replace(/[….\s]+$/, '').trim();
	if (!stem || stem === wanted) {
		return [];
	}
	const hits = sessions.filter(session => session.label.trim().startsWith(stem));
	return hits.length === 1 ? hits : [];
}

/**
 * How much of a note travels to the side panel for one row's tooltip.
 *
 * The rows are rebuilt on every note change, so on every autosave, and a note has no size limit.
 * Long enough that a real note arrives whole; short enough that a pathological one cannot make each
 * save carry it again.
 */
const ROW_NOTE_LIMIT = 4000;

/** A ceiling on the reported tab list, matching the one the injected script applies. */
const DOM_TAB_LIMIT = 200;

/**
* The loader version this extension's note pane needs.
*
* The pane - its markup, its styling and its behaviour - lives in `media/pane` and is pushed into
* the framed page at runtime, so changing it reaches a Claude tab without re-patching VS Code. What
* IS installed is the loader, `media/ainotes-ui.html`, and only a change to what the loader offers a
* pane bumps this number. A panel reporting an older loader is told to update, exactly as a stale
* payload is: an old loader cannot be trusted to run a newer pane.
*/
const PANE_LOADER = 1;

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
	| {
			type: 'injectedRegister';
			panel: string;
			caption: string;
			tabKey?: string;
			version?: string;
			loader?: number;
	  }
	| { type: 'injectedSave'; panel: string; caption: string; tabKey?: string; text: string }
	| { type: 'injectedHeight'; panel: string; caption: string; tabKey?: string; height: number }
	| { type: 'generalSave'; text: string }
	| { type: 'generalHeight'; height: number }
	| { type: 'generalOpen'; open: boolean }
	| { type: 'injectedTabs'; tabs: Array<{ key: string; caption: string; active: boolean }> }
	| { type: 'runInjector' };

/** One open Claude tab, as the side panel lists it. */
type TabRow = {
	caption: string;
	label: string;
	note: string;
	active: boolean;
	/**
	 * The tab this row IS, as VS Code names it.
	 *
	 * `data-resource-name` on the tab element, which for a webview editor is
	 * `webview-<providedViewType>-<uuid>` - unique per editor, and the string the injected script
	 * hands over with the list. It goes back down on a double click, so focusing presses that exact
	 * tab: nothing is counted, and two sessions sharing a title are not a problem.
	 *
	 * Nothing here can invent it. No extension API exposes a webview tab's resource - a `Tab`
	 * carries `label`, `group` and the flags, and a `TabInputWebview` carries only a `viewType`
	 * identical for every Claude tab - which is why the list is sourced from the DOM at all.
	 */
	key: string;
};

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

	/** The Claude tabs the injected script last reported, in the order it walked the documents. */
	private domTabs: Array<{ key: string; caption: string; active: boolean }> = [];
	/** Whether a list has ever arrived, which is not the same as the list being empty. */
	private domTabsSeen = false;
	/** The pane files, read once. */
	private pane: { css: string; html: string; js: string; revision: string } | undefined;
	/** Which pane revision each panel has been given, so it is not pushed on every register. */
	private readonly paneSent = new Map<string, string>();

	/**
	 * Which session each tab holds, by the tab's own unique id.
	 *
	 * The binding the whole feature rests on. A tab reports the id VS Code stamps on it, and that id
	 * gets ONE session - so two tabs whose sessions share a title take one each instead of both
	 * resolving to the same one, or, as before, to none at all.
	 *
	 * In memory only, and that is not laziness: the id is minted per editor, so a restored tab is a
	 * new tab with a new id and nothing stored under the old one could be believed.
	 */
	private readonly claims = new Map<string, string>();

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
					// Only a real edit from somewhere else. Both halves of this matter: `saveNow`
					// fires `textChanged: false` with NO origin once a debounced write lands, and
					// treating that as news pushed the file's text back over whatever had been typed
					// while it was being written - the field overwriting itself a moment after a save.
					if (change.textChanged && change.origin !== this) {
						this.postGeneral();
					}
					this.pushChange(change);
				})
			);
		}
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
					this.runSpike('Patching workbench.html', SPIKE_PATCH_SCRIPT, () => this.afterSpike());
					return;
				case 'spikeUnpatch':
					this.runSpike('Removing the workbench.html injection', SPIKE_UNPATCH_SCRIPT, () =>
						this.afterSpike()
					);
					return;
				case 'injectedRegister':
					// A stale panel is offered the update instead of a note, so the version gate
					// decides whether registering proceeds at all.
					if (this.checkPayloadVersion(message.panel, message.version, message.loader)) {
						this.injectedRegister(message.panel, message.caption, message.tabKey);
					}
					return;
				case 'injectedTabs':
					this.setDomTabs(message.tabs);
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
					this.injectedSave(message.panel, message.caption, message.text, message.tabKey);
					return;
				case 'injectedHeight':
					this.injectedHeight(message.caption, message.height, message.tabKey);
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
	 * The open Claude tabs, as the injected script last reported them.
	 *
	 * Sourced from the DOM rather than from `vscode.window.tabGroups`, because only the DOM has an
	 * identity for a webview tab. Each row therefore carries the handle that presses that exact
	 * tab, and focusing counts nothing and matches no text. Two costs, both accepted deliberately:
	 * the list is only as fresh as the injected script's one-second sweep, and it only exists while
	 * the injection is live - which is already the condition for showing a list at all, since an
	 * unpatched window shows the activation banner in its place.
	 */
	private claudeTabRows(): TabRow[] {
		// `caption` is what the tab actually shows; `label` is what the reader sees, and becomes
		// the untruncated session title when one can be matched.
		const rows: TabRow[] = this.domTabs.map(tab => ({
			key: tab.key,
			caption: tab.caption,
			label: tab.caption,
			note: '',
			active: tab.active
		}));
		this.resolveRows(rows);
		return rows;
	}

	/**
	 * Take the tab list the injected script reported.
	 *
	 * Checked rather than trusted. It arrives through the webview relay, it decides what the panel
	 * renders, and every distinct caption in it costs a session lookup - so a list that is not the
	 * shape this expects is dropped whole rather than half-rendered, and said out loud in the log.
	 */
	private setDomTabs(tabs: Array<{ key: string; caption: string; active: boolean }>): void {
		if (!Array.isArray(tabs) || tabs.length > DOM_TAB_LIMIT) {
			this.trace(`ignored a tab list of ${Array.isArray(tabs) ? tabs.length : typeof tabs}`);
			return;
		}
		const clean: Array<{ key: string; caption: string; active: boolean }> = [];
		const seen = new Set<string>();
		for (const tab of tabs) {
			if (!tab || typeof tab.key !== 'string' || typeof tab.caption !== 'string') {
				continue;
			}
			// A duplicate key cannot happen - the id is minted per editor - so if one arrives the
			// assumption behind this whole list is wrong, and the second copy is not to be shown.
			if (!tab.key || tab.key.length > 300 || tab.caption.length > 500 || seen.has(tab.key)) {
				continue;
			}
			seen.add(tab.key);
			clean.push({ key: tab.key, caption: tab.caption, active: Boolean(tab.active) });
		}
		this.domTabs = clean;
		this.domTabsSeen = true;
		this.releaseClosedTabs();
		this.postRows();
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
	private resolveRows(rows: TabRow[]): void {
		const workspace = this.workspace;
		if (!workspace || rows.length === 0) {
			return;
		}
		// Keyed by tab as well as caption: two tabs sharing a caption are two different bindings,
		// and a cache keyed on captions alone would collapse them back into one.
		const key = rows.map(row => `${row.key}\u001f${row.caption}`).join(' ');
		if (key !== this.titleKey) {
			this.titleKey = key;
			this.matched = new Map();
			const sessions = workspace.listSessions();
			for (const row of rows) {
				const session = this.bindTab(row.key, row.caption, sessions);
				if (session) {
					this.matched.set(row.key, { label: session.label, sessionId: session.id });
				}
			}
		}
		for (const row of rows) {
			const match = this.matched.get(row.key);
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
			// "No tabs open" and "no list has arrived yet" are different facts, and only one of them
			// is worth saying on screen. The list is reported by the injected script, so at startup -
			// and for the whole life of an unpatched window - this is false and the panel says
			// nothing about open tabs rather than claiming there are none.
			listed: this.domTabsSeen,
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
	 * The note pane, as text to be pushed into a framed page.
	 *
	 * Read from disk rather than compiled in, so the pane stays a css file, an html file and a js
	 * file that can be read, linted and diffed. Cached behind their own hash, because a register
	 * arrives per panel and can repeat while a panel is waiting to connect - and hashing three
	 * small files is cheaper than reading them, but reading them once is cheaper still.
	 */
	private paneAssets(): { css: string; html: string; js: string; revision: string } | undefined {
		if (this.pane) {
			return this.pane;
		}
		try {
			const read = (name: string) =>
				readFileSync(vscode.Uri.joinPath(this.extensionUri, 'media', 'pane', name).fsPath, 'utf8');
			const css = read('pane.css');
			const html = read('pane.html');
			const js = read('pane.js');
			const revision = createHash('sha256').update(css).update(html).update(js).digest('hex').slice(0, 12);
			this.pane = { css, html, js, revision };
			this.trace(`pane assets read, revision ${revision}`);
		} catch (err) {
			// Nothing to draw with. Said out loud, because the panel would otherwise sit on the
			// loader's "connecting" line with no reason given anywhere.
			this.trace(`pane assets could not be read: ${err instanceof Error ? err.message : String(err)}`);
			this.pane = undefined;
		}
		return this.pane;
	}

	/**
	 * Hand a panel the pane to draw, once per revision.
	 *
	 * Sent before the note, so the pane exists to receive it. Repeats are cheap but not free - a
	 * register repeats every few seconds while a panel is unresolved - so a panel already holding
	 * this revision is left alone.
	 */
	private pushPane(panel: string): void {
		const pane = this.paneAssets();
		if (!pane || this.paneSent.get(panel) === pane.revision) {
			return;
		}
		this.paneSent.set(panel, pane.revision);
		this.trace(`pane ${pane.revision} -> panel ${panel}`);
		void this.view?.webview.postMessage({
			type: 'injectedUi',
			panel,
			css: pane.css,
			html: pane.html,
			js: pane.js,
			revision: pane.revision,
			needs: PANE_LOADER
		});
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
	private checkPayloadVersion(panel: string, reported: string | undefined, loader?: number): boolean {
		// The loader is checked first and on its own terms: a payload can carry the right revision
		// and still be running a loader too old for this pane, and that fails in the one way this
		// whole mechanism exists to prevent - silently, with a pane that never appears.
		if (typeof loader === 'number' && loader < PANE_LOADER) {
			this.trace(`loader too old: panel reports ${loader}, pane needs ${PANE_LOADER}`);
			void this.view?.webview.postMessage({
				type: 'injectedStale',
				panel,
				installed: `loader ${loader}`,
				expected: `loader ${PANE_LOADER}`
			});
			return false;
		}
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

	/**
	 * The menu has done what it was opened for, so it closes.
	 *
	 * The install state is re-read at the same time, because the button just changed it: without
	 * this the panel would go on claiming the workbench is patched after an un-patch, and only
	 * notice on the next reload. Reached from `runSpike`'s completion, which fires only when the
	 * script exited cleanly - a failure leaves the menu open to retry, with the reason in the
	 * output channel that was already brought to the front.
	 */
	private afterSpike(): void {
		void this.view?.webview.postMessage({ type: 'spikeDone' });
		this.postInjectState();
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
	private sessionForTab(tabKey: string | undefined, caption: string): string | undefined {
		const workspace = this.workspace;
		if (!workspace) {
			this.trace('  resolve: no workspace folder open');
			return undefined;
		}
		const sessions = workspace.listSessions();
		const bound = this.bindTab(tabKey, caption, sessions);
		if (bound) {
			this.trace(`  resolve: tab ${tabKey ? tabKey.slice(-12) : '(no id)'} -> ${bound.id.slice(0, 8)} "${bound.label}"`);
			return bound.id;
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

	/**
	 * The session this tab holds, claiming one if it has none yet.
	 *
	 * Order matters and is deliberate: an existing claim wins, so a tab keeps its session for as
	 * long as it is open even if a session with the same title appears later. Otherwise the first
	 * candidate no OTHER tab has claimed is taken, which is what makes two same-titled tabs land on
	 * two different sessions. If every candidate is claimed - more tabs than sessions - the best
	 * candidate is used anyway rather than leaving that panel with nothing, since sharing a note is
	 * a better failure than refusing to save.
	 */
	private bindTab(tabKey: string | undefined, caption: string, sessions: SessionRow[]): SessionRow | undefined {
		const claimed = tabKey ? this.claims.get(tabKey) : undefined;
		if (claimed) {
			const held = sessions.find(session => session.id === claimed);
			if (held) {
				return held;
			}
			// The session it held is gone from the scan; the claim is worthless, so it goes.
			this.claims.delete(tabKey as string);
		}
		const candidates = matchSessions(caption, sessions);
		if (candidates.length === 0) {
			return undefined;
		}
		const taken = new Set(
			[...this.claims.entries()].filter(([key]) => key !== tabKey).map(([, id]) => id)
		);
		const chosen = candidates.find(session => !taken.has(session.id)) ?? candidates[0];
		if (tabKey) {
			this.claims.set(tabKey, chosen.id);
		}
		return chosen;
	}

	/** Forget the claims of tabs that are no longer open, so their sessions are free again. */
	private releaseClosedTabs(): void {
		const open = new Set(this.domTabs.map(tab => tab.key));
		for (const key of [...this.claims.keys()]) {
			if (!open.has(key)) {
				this.claims.delete(key);
				this.trace(`released the claim of a closed tab ${key.slice(-12)}`);
			}
		}
	}

	private pushNotes(panel: string, sessionId: string): void {
		this.pushPane(panel);
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
	private injectedRegister(panel: string, caption: string, tabKey?: string): void {
		// Acknowledged before anything can fail, so the log always shows the panel arriving even when
		// resolving it does not work - "did the server see me at all" is the first question.
		const again = this.registered.has(panel) ? ' (again)' : '';
		this.trace(`ACK register${again} panel=${panel} caption="${caption}"`);
		const sessionId = this.sessionForTab(tabKey, caption);
		if (!sessionId) {
			this.pushPane(panel);
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
	private injectedHeight(caption: string, height: number, tabKey?: string): void {
		const sessionId = this.sessionForTab(tabKey, caption);
		if (!sessionId || !this.state || !Number.isFinite(height)) {
			return;
		}
		void this.state.update(this.heightKey(sessionId), Math.round(height));
		this.trace(`height ${Math.round(height)}px remembered for ${sessionId.slice(0, 8)}`);
	}

	private injectedSave(panel: string, caption: string, text: string, tabKey?: string): void {
		const known = this.registered.get(panel);
		const sessionId = known?.sessionId ?? this.sessionForTab(tabKey, caption);
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
		// Deliberately no acknowledgement. A reply here invited the panel to act on it, and acting on
		// it meant treating the field as settled - which it is not, because more may have been typed
		// while the write was in flight. Failures still travel; success is silence.
		this.trace(`save ${panel} session=${sessionId.slice(0, 8)} ${text.length} chars`);
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