// Injected into VS Code's workbench renderer by the spike patch button, as `ainotes.js` beside
// `workbench.html`.
//
// It fits a panel into each Claude Code tab, frames `ainotes-ui.html` inside it, and acts as the hub
// between those frames and the AI Notes side panel webview. It owns no notes state and makes no
// decisions about sessions - the extension does that. This file only knows which panels exist and
// where each one sits.
//
// Event driven, not request/response. A panel announces itself and is sent its notes when the other
// side is ready; it never waits on a reply or times out. The side panel cannot enumerate panels - it
// can only reach `window.top` - so its `serverReady` broadcast arrives here and is fanned out.
//
// A poll, deliberately, NOT a MutationObserver on the workbench. The workbench mutates constantly,
// so a per-mutation subtree query is unbounded work in the busiest DOM in the application. One
// selector query a second over a document holding a handful of iframes is bounded whatever the UI is
// doing, and it doubles as the repair pass: new tabs, closed tabs and panels still waiting to be
// registered are all picked up by the same sweep.
(function () {
	'use strict';

	const TAG = '[AI Notes]';
	/**
	 * Stamped into this file by the patch script as it copies it in, from a hash of the payload the
	 * extension ships. A hand-written version only changes when someone remembers to change it, and
	 * the stale payload that cost an evening reported a version that was perfectly correct.
	 */
	const VERSION = '__AINOTES_VERSION__';
	const POLL_MS = 1000;
	/** How long a panel waits before announcing itself again, while it has no notes. */
	const REGISTER_RETRY_MS = 3000;
	/** How long a panel may go unanswered before it reports its own state to the console. */
	const STUCK_AFTER_MS = 8000;
	/**
	 * How long a tab reading must hold, with its container still showing, before it is believed. A tab
	 * switch is several separate writes, and this is past all of them. A tab viewed for the first time
	 * waits it once; a tab already bound never does.
	 */
	const SETTLE_MS = 250;
	/** The label VS Code renders on this extension's activity bar item. */
	const SIDE_PANEL_LABEL = 'AI Notes';
	/** How long to wait for the side panel's webview to turn up after its item is pressed. */
	const WAKE_TIMEOUT_MS = 3000;
	/** A floor between attempts, so a window where this does not work is not poked on every retry. */
	const WAKE_RETRY_MS = 60000;
	/**
	 * How long after this script loads the side panel is opened by itself.
	 *
	 * Close to load, where the workbench is still settling and a side bar opening and closing is least
	 * noticeable - but not immediately: VS Code restores its own layout as it starts, and putting the
	 * side bar back before it has decided what the side bar is would be putting it back to nothing.
	 */
	const WAKE_AFTER_LOAD_MS = 2000;
	const CLAUDE_EXTENSION = 'Anthropic.claude-code';
	/**
	 * How a Claude tab names itself in the DOM.
	 *
	 * VS Code stamps `data-resource-name` on every tab from the basename of its editor's resource,
	 * and a webview editor's resource is built as
	 * `webview-panel://webview-panel/webview-${providerId}-${resourceId}` - where `providerId` is
	 * the view type the extension asked for and `resourceId` is a uuid minted per editor. Read in
	 * the shipped workbench, both the resource getter and the `providedId: e.providedViewType` that
	 * feeds it.
	 *
	 * So a Claude tab's attribute reads `webview-claudeVSCodePanel-<uuid>`. Two things follow, and
	 * both matter here: it identifies a tab AS a Claude tab, using the same view type the extension
	 * matches on, and it is unique per tab. It is also on the tab element itself, so it is readable
	 * while that tab is inactive - which nothing else about a webview editor is.
	 *
	 * It is NOT the Claude session id. The session id is not anywhere in this document: it lives
	 * inside the Claude webview's own page, which is another origin, and in Claude's session files,
	 * which only the extension host can read. The caption remains the only bridge to a session.
	 */
	const CLAUDE_TAB_RESOURCE = 'claudeVSCodePanel';
	/** Every Claude tab in a document, in the order that document holds them. */
	const TAB_SELECTOR = `.tab[data-resource-name*="${CLAUDE_TAB_RESOURCE}"]`;
	/**
	 * A ceiling on the reported list.
	 *
	 * It crosses to the extension, where every caption becomes a session lookup, so a pathological
	 * document must not be able to turn one sweep into a thousand of them.
	 */
	const TAB_LIMIT = 200;
	const NOTES_EXTENSION = 'arcticrobots.ainotes';
	/** Marks a container already fitted, so the poll never doubles up. */
	const MARK = 'ainotesAnchored';
	const BUTTON_GAP = 8;
	/** Halved from the first attempt: 320 dominated the tab. */
	const PANEL_HEIGHT = 160;
	const SPLITBAR_PX = 4;
	const PANEL_MIN = 80;

	/**
	 * Our framed page, resolved once and absolutely.
	 *
	 * A relative `./ainotes-ui.html` is resolved against the document holding the frame, and that
	 * document can be an auxiliary window whose url is `about:blank` rather than this directory. The
	 * patch copies the file in beside `workbench.html`, and `frame-src 'self' vscode-webview:`
	 * allows it in both windows: an auxiliary window gets a copy of this CSP with only `script-src`
	 * rewritten.
	 */
	const UI_URL = new URL('./ainotes-ui.html', location.href).href;

	/** Every panel this script built: {id, overlay, frame, connected, lastRegister}. */
	const panels = [];

	/**
	 * The auxiliary windows this workbench has opened - the windows "Move Editor into New Window"
	 * makes.
	 *
	 * They are why this file is written against a SET of documents rather than one, and three facts
	 * read out of the shipped workbench decide how it treats them. From `createContainer` in
	 * `workbench.desktop.main.js`:
	 *
	 *   - an auxiliary window is `window.open("about:blank", ...)`, so it loads no html and no
	 *     script tag of ours can ever be in it;
	 *   - `e.document.createElement` is REPLACED there with a function that throws, on purpose, so
	 *     that `x instanceof HTMLElement` keeps working across windows. So every element below is
	 *     created with THIS document and appended into the other one, which adopts it;
	 *   - the workbench CSP meta is copied across with `script-src` rewritten to `'none'`, so
	 *     putting a script of our own in there is not merely awkward, it is forbidden.
	 *
	 * And from the webview code: the overlay container is appended to
	 * `layoutService.getContainer(this.window)`, the window the editor is currently in. A moved
	 * editor's Claude frame therefore sits in a document this script has to go looking for.
	 */
	const auxWindows = [];

	/**
	 * Whether this node is still in a document belonging to a window that is still open.
	 *
	 * `document.contains` was the test until an editor could be in another window: it answers "is it
	 * in THIS document", which is false for a panel that is alive and on screen elsewhere.
	 * `isConnected` alone is not enough either - a closed popup's nodes stay connected to a document
	 * nobody can see - so the owning window is checked too.
	 */
	function isLive(node) {
		if (!node || !node.isConnected) {
			return false;
		}
		const win = node.ownerDocument && node.ownerDocument.defaultView;
		if (!win) {
			return false;
		}
		try {
			return !win.closed;
		} catch {
			return false;
		}
	}

	/** VS Code stamps `vscodeWindowId` on every window it opens. Logged, so a report says where. */
	function windowIdOf(node) {
		try {
			const win = node && node.ownerDocument && node.ownerDocument.defaultView;
			return win ? win.vscodeWindowId : null;
		} catch {
			return null;
		}
	}

	/**
	 * The windows to sweep: this one, plus every auxiliary window still open and still ours.
	 *
	 * Closed and unreachable ones are dropped here rather than in a pass of their own, because this
	 * is the only place that has to touch them to find out.
	 */
	function liveViews() {
		const views = [{ win: window, doc: document }];
		for (let i = auxWindows.length - 1; i >= 0; i--) {
			const win = auxWindows[i];
			let doc = null;
			try {
				doc = win.closed ? null : win.document;
			} catch {
				// A popup that has navigated somewhere cross-origin: reading its document throws.
				// It cannot be one of ours, so it goes, rather than throwing again every second.
				doc = null;
			}
			if (!doc) {
				auxWindows.splice(i, 1);
				console.log(`${TAG} auxiliary window gone, ${auxWindows.length} left`);
				continue;
			}
			// Inserted rather than appended: the walk above runs backwards so it can splice out a
			// dead window, and appending would hand back the auxiliary windows in reverse. The row
			// list is built from this order, and a list that reshuffled itself between sweeps would
			// read as tabs jumping about.
			views.splice(1, 0, { win, doc });
		}
		return views;
	}

	/** Take an opened window under this script's care, once. */
	function adoptWindow(win) {
		if (auxWindows.indexOf(win) !== -1) {
			return;
		}
		try {
			// Our framed page posts to `parent`, and for a panel in an auxiliary window that is the
			// auxiliary window, not this one, so the same handler has to listen there as well.
			// Allowed because the popup is `about:blank` opened from here and so shares our origin.
			win.addEventListener('message', onMessage);
		} catch (err) {
			console.warn(`${TAG} not adopting a window we cannot listen to`, err);
			return;
		}
		auxWindows.push(win);
		console.log(`${TAG} adopted auxiliary window ${win.vscodeWindowId}, ${auxWindows.length} total`);
	}

	/** The `extensionId` VS Code puts in a webview iframe's src, or nothing if it is not a webview. */
	function paramOf(iframe, name) {
		try {
			return new URL(iframe.getAttribute('src') || '', location.href).searchParams.get(name);
		} catch {
			return null;
		}
	}

	function iframesFor(doc, extensionId) {
		const out = [];
		for (const frame of doc.querySelectorAll('iframe.webview')) {
			if (paramOf(frame, 'extensionId') === extensionId) {
				out.push(frame);
			}
		}
		return out;
	}

	/**
	 * True for a webview docked as a view rather than opened as an editor.
	 *
	 * Claude Code runs in both shapes, and a panel only belongs in the editor one: the sidebar view
	 * is narrow, is not a tab, and has no caption to resolve a session from. `purpose=webviewView`
	 * is VS Code's own marking, observed on the docked instance.
	 */
	function isDockedView(iframe) {
		return paramOf(iframe, 'purpose') === 'webviewView';
	}

	/**
	 * Send to the AI Notes side panel.
	 *
	 * A VS Code webview is not one frame - the iframe loads VS Code's own host page and the
	 * extension's document runs nested inside it - so post to the host window AND to each child
	 * frame and let whichever one is listening answer.
	 */
	function toSidePanel(payload) {
		const targets = [];
		// This document, always: the side panel is a view in the main window, and a panel in an
		// auxiliary window has no sidebar of its own to talk to.
		for (const frame of iframesFor(document, NOTES_EXTENSION)) {
			const win = frame.contentWindow;
			if (!win) {
				continue;
			}
			targets.push(win);
			try {
				for (let i = 0; i < win.length; i++) {
					targets.push(win[i]);
				}
			} catch {
				// Reading the child list of a cross-origin frame may be refused; the host still gets it.
			}
		}
		if (targets.length === 0) {
			// Not silent: at startup the panel exists before the side panel webview does, and a quiet
			// return here is indistinguishable from a message delivered and ignored. The sweep will
			// try again, so this is a note rather than a failure.
			console.debug(`${TAG} no AI Notes webview yet, will retry`, payload.kind);
			return false;
		}
		for (const target of targets) {
			try {
				target.postMessage(payload, '*');
			} catch (err) {
				console.warn(`${TAG} postMessage to one target failed`, err);
			}
		}
		return true;
	}

	/**
	 * The caption of the tab this container belongs to.
	 *
	 * The only bridge between the DOM and a Claude session, since the Claude webview's own url
	 * carries a webview id and no session id. Measured: `data-parent-flow-to-element-id` is empty on
	 * a live Claude container, so it is not the route. The container's `position-anchor` names an
	 * element carrying the matching `anchor-name`, that element sits inside `.editor-group-container`,
	 * and the group's selected tab is the one the container is showing.
	 *
	 * These are VS Code's private class names and the likeliest thing here to break on an update -
	 * hence returning null rather than guessing, so a miss reports "no caption" instead of reading
	 * some other tab.
	 */
	/**
	 * A tab's own text.
	 *
	 * The same element `captionOf` reads, without its fallbacks: this is for a tab found in the DOM
	 * rather than resolved from a container, where there is no editor group to disambiguate an
	 * `aria-label` against.
	 */
	function labelOf(tab) {
		const label = tab.querySelector('.label-name');
		return ((label && label.textContent) || '').trim();
	}

	function tabFor(overlay) {
		const anchor = overlay.style.getPropertyValue('position-anchor');
		if (!anchor) {
			return null;
		}
		// The overlay's OWN document, not this one: a container in an auxiliary window carries its
		// anchor element and its editor group there, and looking here would find neither.
		const doc = overlay.ownerDocument;
		const target = Array.prototype.find.call(
			doc.querySelectorAll('[style*="anchor-name"]'),
			el => el.style.getPropertyValue('anchor-name') === anchor
		);
		const group = target && target.closest('.editor-group-container');
		// The active tab, or the group's title control when the group has no tab bar at all, which
		// is a shape an editor moved into its own window can take. Guarded on there being no tab
		// rather than no ACTIVE tab: with a tab bar present, the title control's `.label-name` is
		// the first tab's label, and a confidently wrong caption is worse than none.
		const tab =
			(group && group.querySelector('.tab.active')) ||
			(group && !group.querySelector('.tab') && group.querySelector('.title'));
		return tab || null;
	}

	/**
	 * Whether this container is the one its editor group is showing.
	 *
	 * The only time a tab reading means anything. Every webview editor in a group anchors its
	 * container to the same element, and a hidden container keeps that anchor - read in the shipped
	 * workbench: `release()` only sets `visibility = "hidden"`, `_show()` sets it back to `"visible"`,
	 * and neither touches `position-anchor`. So `tabFor` on a hidden container finds the group's
	 * active tab, which belongs to a different container. Reading it anyway is what pointed every
	 * hidden panel at the visible tab's session, so a tab switched to showed the note of the tab just
	 * left until the next sweep caught up.
	 */
	function isShowing(overlay) {
		return isLive(overlay) && overlay.style.visibility !== 'hidden';
	}

	/**
	 * The tab this container belongs to: its caption and its unique id, from one walk so the two
	 * cannot name different tabs. Only to be believed while `isShowing`.
	 *
	 * The id is `data-resource-name`, which VS Code sets from the basename of that editor's resource:
	 * `webview-claudeVSCodePanel-<uuid>`, minted per editor. It is what the extension binds the note
	 * to, so two sessions carrying the same title are two bindings rather than one ambiguous lookup
	 * that resolves to neither.
	 */
	function readTab(overlay) {
		const tab = tabFor(overlay);
		const caption = captionOf(tab);
		return caption ? { caption, tabKey: tab.getAttribute('data-resource-name') || null } : null;
	}

	function captionOf(tab) {
		if (!tab) {
			return null;
		}
		// The label element first. `aria-label` looks equivalent until a second editor group exists,
		// at which point it becomes "Claude capabilities over…, Editor Group 2" - measured - and that
		// suffix matches no session. It stays as a fallback with the suffix removed.
		// `title` is null on these tabs because VS Code renders its own hover, and both sources carry
		// the same ellipsis for a long name, so neither is the untruncated title.
		const labelEl = tab.querySelector('.label-name');
		const fromLabel = labelEl && labelEl.textContent && labelEl.textContent.trim();
		if (fromLabel) {
			return fromLabel;
		}
		const aria = (tab.getAttribute('aria-label') || '').replace(/,\s*Editor Group\s*\d+\s*$/, '');
		return aria.trim() || null;
	}

	/**
	 * Announce one panel, under the tab it is bound to. Idempotent: the extension treats a repeat as a
	 * refresh.
	 *
	 * A panel not bound yet has nothing true to announce, so it goes to `checkTab` instead, which
	 * waits for its container to be showing. Until then its frame says it is connecting - seen by
	 * nobody, since a hidden tab's panel is hidden with it.
	 */
	function register(entry) {
		entry.lastRegister = Date.now();
		if (!entry.bound) {
			checkTab(entry);
			return;
		}
		// The tab's own id travels with the caption, and is what the note is bound to. The caption
		// stays because it is how a session is FOUND the first time - the id means nothing to Claude.
		const sent = toSidePanel({
			source: 'ainotes-inject',
			kind: 'register',
			panel: entry.id,
			caption: entry.caption,
			tabKey: entry.tabKey,
			version: VERSION,
			loader: entry.loader
		});
		if (!sent) {
			// Nothing to talk to. The AI Notes view is resolved lazily, so in a window where it has
			// never been shown there is no webview to relay through. Opening it once is something this
			// script can do from here, masked and put back; the message is what is left when it cannot
			// - no item in the activity bar, or an attempt too recent to repeat. "Not open" rather than
			// "never opened": a view hidden from the activity bar is disposed the same way.
			if (!wakeSidePanel()) {
				toFrame(entry, {
					kind: 'error',
					problem:
						'The AI Notes side panel is not open in this window - open it once from the activity bar to connect.'
				});
			}
		}
	}

	/**
	 * Learn which tab this panel belongs to, or notice that its tab has been retitled - only while its
	 * container is showing, and only from a reading that still holds SETTLE_MS later.
	 *
	 * Two readings, because a tab switch is not one write: the tab strip changing, the old container
	 * being hidden and the new one shown are separate steps, and a reading taken between them could
	 * name the tab being switched to from the container being switched away from. The same reading a
	 * quarter of a second later, with the container still showing, is past all of them.
	 *
	 * A hidden panel is never read. It keeps its tab and its session, which is exactly what lets
	 * switching back to it show its own note at once, with nothing to reload.
	 */
	function checkTab(entry) {
		if (entry.stale || entry.settling || !isShowing(entry.overlay)) {
			return;
		}
		const first = readTab(entry.overlay);
		if (!first) {
			// Said, but at the retry pace rather than every sweep.
			if (!entry.bound && Date.now() - entry.lastRegister >= REGISTER_RETRY_MS) {
				entry.lastRegister = Date.now();
				toFrame(entry, { kind: 'error', problem: 'could not read this tab’s caption' });
			}
			return;
		}
		if (entry.bound && first.caption === entry.caption && first.tabKey === entry.tabKey) {
			return;
		}
		entry.settling = setTimeout(() => {
			entry.settling = null;
			if (entry.stale || !isShowing(entry.overlay) || !isLive(entry.frame)) {
				return;
			}
			const second = readTab(entry.overlay);
			if (!second || second.caption !== first.caption || second.tabKey !== first.tabKey) {
				// Still moving. The next sweep, or VS Code showing this container again, reads anew.
				return;
			}
			console.log(
				`${TAG} panel ${entry.id} ${entry.bound ? 'rebound' : 'bound'} to tab`,
				second.tabKey,
				second.caption
			);
			if (!entry.bound) {
				entry.waitingSince = Date.now();
			}
			entry.caption = second.caption;
			entry.tabKey = second.tabKey;
			entry.bound = true;
			register(entry);
		}, SETTLE_MS);
	}

	function toFrame(entry, event) {
		const win = entry.frame.contentWindow;
		if (!win) {
			// A detached frame belongs to a tab that has gone. Said out loud because this was the
			// shape of a bug where a lingering entry swallowed every push and the live panel sat on
			// "loading" for ever.
			console.warn(`${TAG} dropping ${event.kind} for a dead frame`, entry.id);
			entry.connected = false;
			return;
		}
		try {
			// `source` last: a forwarded payload carries its own, and spreading it over the top would
			// rewrite the field the framed page filters on.
			win.postMessage({ ...event, source: 'ainotes-host' }, '*');
		} catch (err) {
			console.warn(`${TAG} could not reach a panel frame`, err);
		}
	}

	/**
	 * The panel with this id, preferring one whose frame is still in the document.
	 *
	 * A closed and reopened Claude tab can leave a stale entry carrying the same id as the live one,
	 * and answering the stale one delivers the notes into a frame nobody can see.
	 */
	/**
	 * Show on the button whether this session has a note at all.
	 *
	 * The one piece of state visible while the panel is shut, so it is worth keeping honest: an empty
	 * note and no note look the same to a reader and are treated the same here.
	 */
	function markNote(entry, hasNote) {
		entry.hasNote = hasNote;
		if (entry.button) {
			entry.button.textContent = hasNote ? 'N' : 'n';
			entry.button.style.fontWeight = hasNote ? '700' : '400';
		}
	}

	/**
	 * Claude's own tabs, in the order the documents hold them.
	 *
	 * This is the row list the side panel shows, and it is built here rather than in the extension
	 * because only the DOM has an identity for a webview tab: `data-resource-name` is unique per
	 * editor and no extension API exposes it. A row that carries it can be focused exactly, with
	 * nothing counted and nothing guessed. A tab is listed whether or not its webview has been
	 * created, because the attribute is on the tab element itself.
	 */
	function claudeTabs() {
		const out = [];
		for (const view of liveViews()) {
			for (const tab of view.doc.querySelectorAll(TAB_SELECTOR)) {
				if (out.length >= TAB_LIMIT) {
					console.warn(`${TAG} more than ${TAB_LIMIT} Claude tabs, reporting the first`);
					return out;
				}
				out.push({
					key: tab.getAttribute('data-resource-name'),
					caption: labelOf(tab),
					active: tab.classList.contains('active'),
					window: view.win.vscodeWindowId
				});
			}
		}
		return out;
	}

	/** The last list handed over, flattened, so an unchanged list is not sent every second. */
	let lastTabs = null;

	/**
	 * Hand the tab list over when it has changed.
	 *
	 * `force` is for the moment the side panel announces itself: it has just rendered and holds no
	 * list, and what this script sent to a webview that did not exist yet is no reason to stay
	 * quiet now.
	 */
	function reportTabs(force) {
		const tabs = claudeTabs();
		const signature = tabs.map(t => `${t.key}${t.caption}${t.active}`).join('');
		if (!force && signature === lastTabs) {
			return;
		}
		const sent = toSidePanel({ source: 'ainotes-inject', kind: 'tabs', tabs });
		// Only counted as sent when it went somewhere. Remembering a list that could not be
		// delivered would leave the panel empty until the next time a tab happened to change.
		lastTabs = sent ? signature : null;
	}

	/** The first Claude tab, in any window, that a test accepts. */
	function findTab(accept) {
		for (const view of liveViews()) {
			for (const tab of view.doc.querySelectorAll(TAB_SELECTOR)) {
				if (accept(tab)) {
					return { view, tab };
				}
			}
		}
		return null;
	}

	/**
	 * Bring one Claude tab to the front, named by the key its row was built with.
	 *
	 * Exact, and nothing is counted: the key is that tab's own `data-resource-name`, unique per
	 * editor, and it came from this document in the first place. Two sessions sharing a title are
	 * no longer a problem here, and neither is the order the extension holds its tab groups in.
	 *
	 * There is no API for activating an arbitrary tab - `Tab` exposes `isActive` and no way to set
	 * it - so the tab header is pressed the way a mouse would, which is what `pressElement` is for.
	 */
	function focusTab(key, caption) {
		let hit = key ? findTab(tab => tab.getAttribute('data-resource-name') === key) : null;
		if (!hit && caption) {
			// The key names no tab any more: the editor was closed and reopened, and a new editor
			// gets a new id - or this row is older than the sweep that would have refreshed it. The
			// caption is the weaker handle, since it can name more than one tab, but pressing the
			// first tab carrying it beats doing nothing.
			hit = findTab(tab => labelOf(tab) === caption.trim());
			if (hit) {
				console.warn(`${TAG} no tab carries ${key}, fell back to the caption`, caption);
			}
		}
		if (!hit) {
			console.warn(`${TAG} no tab found to focus`, key || caption);
			return;
		}
		const tab = hit.tab;
		if (hit.view.win !== window) {
			// Raising the tab without raising the window it is in would look like the double click
			// did nothing at all.
			try {
				hit.view.win.focus();
			} catch (err) {
				console.warn(`${TAG} could not raise the window holding the tab`, err);
			}
		}
		pressElement(tab);
		// Measured after the press, and on the element that exists then: activating a tab makes VS
		// Code restyle and can move it, so a rectangle taken beforehand may be the wrong one by the
		// time the overlay is drawn.
		flashElement(tab);
		console.log(`${TAG} focused tab`, caption, 'in window', windowIdOf(tab), key);
	}


	/**
	 * Press an element the way a mouse would.
	 *
	 * `el.click()` alone does nothing here: it dispatches a lone `click`, and VS Code activates a tab
	 * on `mousedown` - measured, the earlier `click()` version did not switch tabs. So the whole
	 * gesture is synthesised, pointer events included, with real coordinates because a handler is
	 * entitled to read them. Each event is separately guarded: PointerEvent is the part most likely
	 * to be unavailable, and losing it must not cost us the mouse events that do the work.
	 */
	function pressElement(el) {
		const box = el.getBoundingClientRect();
		const common = {
			bubbles: true,
			cancelable: true,
			// The element's own window, so a handler reading `view` is not told the wrong one. The
			// event CONSTRUCTORS stay this window's on purpose: the workbench forces element
			// creation through the main window precisely so its `instanceof` checks keep working,
			// and its handlers test against these same constructors.
			view: el.ownerDocument.defaultView || window,
			button: 0,
			clientX: Math.round(box.left + box.width / 2),
			clientY: Math.round(box.top + box.height / 2)
		};
		const pointer = { ...common, pointerId: 1, pointerType: 'mouse', isPrimary: true };

		const send = (Kind, type, extra) => {
			try {
				el.dispatchEvent(new Kind(type, extra));
			} catch (err) {
				console.warn(`${TAG} could not synthesise ${type}`, err);
			}
		};

		if (typeof PointerEvent === 'function') {
			send(PointerEvent, 'pointerdown', { ...pointer, buttons: 1 });
		}
		send(MouseEvent, 'mousedown', { ...common, buttons: 1 });
		if (typeof PointerEvent === 'function') {
			send(PointerEvent, 'pointerup', { ...pointer, buttons: 0 });
		}
		send(MouseEvent, 'mouseup', { ...common, buttons: 0 });
		send(MouseEvent, 'click', { ...common, buttons: 0 });
	}

	/** The keyframes the flash uses, added once. The workbench CSP allows `style-src 'unsafe-inline'`. */
	function ensureFlashStyle(doc) {
		if (doc.getElementById('ainotes-flash-style')) {
			return;
		}
		// Created with THIS document even when it is bound for another window's head: an auxiliary
		// window's own `createElement` throws by design, and appending adopts the node anyway.
		const style = document.createElement('style');
		style.id = 'ainotes-flash-style';
		// `textContent` on a style element, not `innerHTML`: this document enforces Trusted Types.
		style.textContent =
			'@keyframes ainotes-flash {' +
			'0% { background-color: transparent }' +
			'40% { background-color: rgba(201, 100, 66, 0.9) }' +
			'100% { background-color: transparent } }';
		doc.head.appendChild(style);
	}

	/**
	 * Blink over the tab so the eye can find it.
	 *
	 * Focusing a tab in a crowded bar is invisible if it was already partly in view, so the click
	 * gets an acknowledgement.
	 *
	 * Drawn as a separate overlay rather than by animating the tab, because animating the tab does
	 * not work: VS Code's stylesheet carries
	 * `.tabs-container>.tab { background-color: transparent !important }` for the modern-ui tabs this
	 * workbench uses, and a CSS animation loses to `!important`. `box-shadow` is `!important` in the
	 * same rule, so there is nothing left on the tab worth animating. An element of our own has no
	 * competing declaration, and is positioned over the tab's rectangle instead.
	 *
	 * `position: fixed` against the measured rect, so it needs nothing of the tab's own positioning
	 * context, and `pointer-events: none` so it cannot intercept anything during its 600ms.
	 */
	function flashElement(el) {
		const doc = el.ownerDocument;
		ensureFlashStyle(doc);
		const box = el.getBoundingClientRect();
		if (!box.width || !box.height) {
			return;
		}
		const flash = document.createElement('div');
		flash.className = 'ainotes-flash';
		flash.style.cssText = [
			'position:fixed',
			`top:${Math.round(box.top)}px`,
			`left:${Math.round(box.left)}px`,
			`width:${Math.round(box.width)}px`,
			`height:${Math.round(box.height)}px`,
			'border-radius:4px',
			'pointer-events:none',
			'z-index:1000',
			'animation:ainotes-flash 200ms ease-in-out 3'
		].join(';');
		doc.body.appendChild(flash);
		const done = () => flash.remove();
		flash.addEventListener('animationend', done, { once: true });
		// A flash left on screen would be worse than no flash, so its removal does not depend on an
		// event firing.
		setTimeout(done, 1200);
	}

	/** Set while a wake is running, and when the last one started. */
	let waking = false;
	let lastWake = 0;
	/** When this script started, and whether the one unprompted wake has been tried. */
	const loadedAt = Date.now();
	let wakeTried = false;

	/** Whether this workbench has a Claude tab at all, in any of its windows. */
	function anyClaudeTab() {
		for (const view of liveViews()) {
			if (view.doc.querySelector(TAB_SELECTOR)) {
				return true;
			}
		}
		return false;
	}

	/** The activity bar item for a view container, by the label VS Code puts on it. */
	function activityItem(doc, label) {
		const bar = doc.querySelector('.part.activitybar');
		if (!bar) {
			return null;
		}
		for (const el of bar.querySelectorAll('[aria-label], [title]')) {
			const name = el.getAttribute('aria-label') || el.getAttribute('title') || '';
			// The label alone, or with a keybinding or a badge after it.
			if (name.slice(0, label.length) === label) {
				return el.querySelector('.action-label') || el;
			}
		}
		return null;
	}

	/** The item the activity bar shows as selected, so it can be pressed again afterwards. */
	function checkedItem(doc) {
		const bar = doc.querySelector('.part.activitybar');
		const item = bar && bar.querySelector('.action-item.checked');
		return item ? item.querySelector('.action-label') || item : null;
	}

	/** The container VS Code parks the AI Notes webview in, once that webview exists. */
	function sidePanelOverlay() {
		const frame = iframesFor(document, NOTES_EXTENSION)[0];
		return frame ? frame.closest('.webview-overlay-content') : null;
	}

	/**
	 * Hide the parts that would otherwise be seen changing while the side panel is opened and closed
	 * again: the side bar and the activity bar.
	 *
	 * `visibility`, never `display` or a width. Those relayout the workbench, which is the very thing
	 * that would be seen. It cannot hide everything: with the side bar CLOSED, opening it moves the
	 * editor, and no styling here can prevent that.
	 */
	function mask(doc) {
		const parts = [];
		for (const selector of ['.part.sidebar', '.part.activitybar']) {
			const el = doc.querySelector(selector);
			if (el) {
				parts.push({ el, was: el.style.visibility });
				el.style.visibility = 'hidden';
			}
		}
		return parts;
	}

	function unmask(parts) {
		for (const part of parts) {
			part.el.style.visibility = part.was || '';
		}
	}

	/** Whether the AI Notes view is what the side bar is showing right now. */
	function sidePanelShowing(doc, ours) {
		const workbench = doc.querySelector('.monaco-workbench');
		if (workbench && workbench.classList.contains('nosidebar')) {
			return false;
		}
		return checkedItem(doc) === ours;
	}

	/**
	 * Open the AI Notes view once, so that its webview exists, and put the side bar back as it was.
	 *
	 * The relay IS that webview, and VS Code only creates a view's webview when the view is shown -
	 * there is no setting for that and no API to create one unseen. The extension cannot do this for
	 * itself either: it can reveal its own view, but nothing in the extension API says which container
	 * was showing before or whether the side bar was open, so it could not put anything back. Here in
	 * the workbench both facts are on screen - the activity bar marks the selected item `checked`, and
	 * a closed side bar marks the workbench element `nosidebar` - which is why this lives here.
	 *
	 * False when it did not even try, which is the caller's cue to say so in the panel instead.
	 */
	function wakeSidePanel() {
		if (waking || Date.now() - lastWake < WAKE_RETRY_MS) {
			return false;
		}
		const doc = document;
		const ours = activityItem(doc, SIDE_PANEL_LABEL);
		if (!ours) {
			console.warn(`${TAG} no "${SIDE_PANEL_LABEL}" item in the activity bar to open`);
			return false;
		}
		waking = true;
		lastWake = Date.now();
		const workbench = doc.querySelector('.monaco-workbench');
		const wasClosed = Boolean(workbench && workbench.classList.contains('nosidebar'));
		const previous = wasClosed ? null : checkedItem(doc);
		const focused = doc.activeElement;
		const masked = mask(doc);
		console.log(`${TAG} opening the AI Notes view to connect (side bar ${wasClosed ? 'closed' : 'open'})`);
		pressElement(ours);

		const started = Date.now();
		const finish = found => {
			try {
				// Pressing the selected item again is what closes the side bar, which is the state to
				// return to when it was closed to begin with.
				if (wasClosed || !previous || previous === ours) {
					pressElement(ours);
				} else if (isLive(previous)) {
					pressElement(previous);
				}
			} catch (err) {
				console.warn(`${TAG} could not put the side bar back`, err);
			}
			// Read back rather than assumed: whether the reader is now looking at the AI Notes view
			// decides whether its webview may stay hidden. Left hidden while it is on screen would be
			// an empty panel, which is worse than the flash this avoids.
			setTimeout(() => {
				const showing = sidePanelShowing(doc, ours);
				const overlay = sidePanelOverlay();
				if (overlay) {
					overlay.style.visibility = showing ? 'visible' : 'hidden';
				}
				unmask(masked);
				if (focused && typeof focused.focus === 'function') {
					try {
						focused.focus();
					} catch (err) {
						console.warn(`${TAG} could not restore focus`, err);
					}
				}
				waking = false;
				console.log(
					`${TAG} side panel ${found ? 'connected' : 'did not appear'}, ` +
						`side bar ${showing ? 'still showing AI Notes' : 'restored'}`
				);
			}, 60);
		};

		const step = () => {
			const overlay = sidePanelOverlay();
			if (overlay) {
				// Hidden the moment it exists. VS Code parks it at the window root rather than inside
				// the side bar, so the mask above does not cover it, and one painted frame of it is
				// exactly the flash this is here to avoid. The webview keeps loading while hidden -
				// the view is registered with `retainContextWhenHidden`.
				overlay.style.visibility = 'hidden';
				finish(true);
				return;
			}
			if (Date.now() - started >= WAKE_TIMEOUT_MS) {
				finish(false);
				return;
			}
			setTimeout(step, 50);
		};
		setTimeout(step, 50);
		return true;
	}

	function panelFor(id) {
		const matches = panels.filter(entry => entry.id === id);
		return matches.find(entry => isLive(entry.frame)) || matches[0] || null;
	}

	/**
	 * Turn the overlay container into a column so the panel takes real space instead of covering
	 * Claude's content.
	 *
	 * The container is sized by VS Code to the tab through CSS anchor positioning, and the iframe is
	 * inline-styled to fill it. Making the container a flex column and letting the iframe flex means
	 * the panel's height is subtracted from the iframe rather than painted over it. `min-height: 0`
	 * is what stops a flex item refusing to shrink below its content.
	 */
	function fit(overlay, frame) {
		if (overlay.style.display !== 'flex') {
			overlay.style.display = 'flex';
			overlay.style.flexDirection = 'column';
		}
		if (frame.style.flex !== '1 1 auto') {
			frame.style.flex = '1 1 auto';
			frame.style.height = 'auto';
			frame.style.minHeight = '0';
		}
	}

	/**
	 * The panel, framing our own page.
	 *
	 * Built as the panel is injected rather than on first open, so the document is loaded and holding
	 * its notes before anyone presses the button - opening then costs nothing and never flashes
	 * blank. A hidden iframe still loads; only its layout is deferred.
	 *
	 * `./ainotes-ui.html` resolves against `workbench.html`, the directory the patch copies both
	 * files into, and the workbench CSP allows it: `frame-src 'self' vscode-webview:`.
	 */
	function buildPanel(panelId) {
		const panel = document.createElement('div');
		panel.id = 'ainotes-panel';
		// Toggled through `display`, NOT the `hidden` attribute: `hidden` works off a UA rule that an
		// element's own inline `display` beats, so with `display:flex` set here `hidden` is ignored.
		// The same trap is why main.css carries `[hidden] { display: none !important }`.
		panel.style.cssText = [
			`flex:0 0 ${PANEL_HEIGHT}px`,
			`height:${PANEL_HEIGHT}px`,
			'display:none',
			'flex-direction:column',
			'box-sizing:border-box'
		].join(';');

		const frame = document.createElement('iframe');
		// The panel's id travels in the url and comes back on every message, so routing never depends
		// on comparing `event.source` to `frame.contentWindow` - that comparison silently matched
		// nothing here, and a dropped message is indistinguishable from a slow one.
		frame.src = UI_URL + '?panel=' + encodeURIComponent(panelId);
		frame.style.cssText = 'flex:1 1 auto;border:none;width:100%;height:100%';

		// Transparent at rest, so it does not draw a line across the tab, but still taking its space
		// so the panel below never jumps when it lights up. Three dots mark it as a grip - the only
		// thing that says "drag me" once the bar itself is invisible.
		const splitbar = document.createElement('div');
		splitbar.style.cssText = [
			`flex:0 0 ${SPLITBAR_PX}px`,
			'cursor:row-resize',
			'display:flex',
			'align-items:center',
			'justify-content:center',
			'background:transparent',
			'transition:background 150ms',
			'z-index:10'
		].join(';');

		const grip = document.createElement('div');
		grip.style.cssText = 'display:flex;align-items:center;gap:3px;transition:opacity 150ms';
		for (let i = 0; i < 3; i++) {
			const dot = document.createElement('div');
			dot.style.cssText = 'width:2px;height:2px;border-radius:50%;background:#6a6a6a';
			grip.appendChild(dot);
		}
		splitbar.appendChild(grip);

		splitbar.addEventListener('pointerenter', () => paintSplitbar(splitbar, true));
		splitbar.addEventListener('pointerleave', () => {
			if (!splitbar.dataset.dragging) {
				paintSplitbar(splitbar, false);
			}
		});

		panel.append(splitbar, frame);
		return { panel, frame, splitbar };
	}

	/**
	 * Make the splitbar resize the panel, following ZUI's splitbar shape.
	 *
	 * Pointer capture on the bar itself, so the drag survives the cursor leaving a 4px strip and
	 * crossing into the iframe - without it the pointer events would be delivered to the frame and
	 * the drag would die on the first fast movement. Both `height` and `flexBasis` are written,
	 * because the panel is a flex item and the basis is what actually decides its size.
	 *
	 * Live on move, committed once on release: the height is persisted per session, and writing to
	 * the store on every pointermove would be a save per frame.
	 */
	function makeResizable(entry, splitbar, panel, button) {
		splitbar.addEventListener('pointerdown', event => {
			event.preventDefault();
			splitbar.setPointerCapture(event.pointerId);
			splitbar.dataset.dragging = '1';
			paintSplitbar(splitbar, true);

			const startY = event.clientY;
			const startH = panel.getBoundingClientRect().height;

			const onMove = move => {
				// The panel is anchored to the bottom of the tab, so dragging UP makes it taller.
				const height = Math.max(PANEL_MIN, Math.round(startH - (move.clientY - startY)));
				setPanelHeight(entry, panel, button, height);
			};
			const onUp = () => {
				delete splitbar.dataset.dragging;
				paintSplitbar(splitbar, false);
				splitbar.removeEventListener('pointermove', onMove);
				sendHeight(entry, Math.round(panel.getBoundingClientRect().height));
			};

			splitbar.addEventListener('pointermove', onMove);
			splitbar.addEventListener('pointerup', onUp, { once: true });
			splitbar.addEventListener('pointercancel', onUp, { once: true });
		});
	}

	/**
	 * The bar's two looks, in one place so hover and drag cannot disagree about it.
	 *
	 * Active: a solid orange line, dots hidden because the line already says where the edge is.
	 * Idle: nothing but the dots.
	 */
	function paintSplitbar(splitbar, active) {
		splitbar.style.background = active ? '#c96442' : 'transparent';
		const grip = splitbar.firstElementChild;
		if (grip) {
			grip.style.opacity = active ? '0' : '1';
		}
	}

	/** One place that writes the height, so the floating button always steps with it. */
	function setPanelHeight(entry, panel, button, height) {
		entry.height = height;
		panel.style.flexBasis = height + 'px';
		panel.style.height = height + 'px';
		if (button && panel.style.display !== 'none') {
			button.style.bottom = height + BUTTON_GAP + 'px';
		}
	}

	/** Remember this height against the session, so the next tab for it opens the same size. */
	function sendHeight(entry, height) {
		if (!entry.bound) {
			return;
		}
		toSidePanel({
			source: 'ainotes-inject',
			kind: 'height',
			panel: entry.id,
			caption: entry.caption,
			tabKey: entry.tabKey,
			height
		});
	}

	function addControls(overlay) {
		const panelId = overlay.id || `p${panels.length}-${Date.now()}`;
		// VS Code can hand a reopened tab the id its predecessor had. Two entries under one id means
		// every push is a coin toss, so the older one goes.
		for (let i = panels.length - 1; i >= 0; i--) {
			if (panels[i].id === panelId) {
				forget(i, 'replaced by a new panel with the same id');
			}
		}
		// Anything of ours already inside this container is a leftover: a container VS Code moved
		// between windows brings our button and panel with it, and a second set would mean two
		// buttons and a frame nobody is listening to. Removed rather than reused, so the entry and
		// the DOM cannot disagree about which panel is the live one.
		for (const old of overlay.querySelectorAll('#ainotes-anchor-button, #ainotes-panel')) {
			old.remove();
		}
		const { panel, frame, splitbar } = buildPanel(panelId);
		const entry = {
			id: panelId,
			overlay,
			frame,
			connected: false,
			stale: false,
			lastRegister: 0,
			// The tab this panel belongs to, learned while its container was showing and kept while it
			// is hidden. `bound` says whether they have been learned at all.
			bound: false,
			caption: null,
			tabKey: null,
			/** The timer of a tab reading waiting to be confirmed, or null. */
			settling: null,
			observer: null,
			/** What the observer last saw, so it acts on a change of visibility and nothing else. */
			wasShowing: false,
			loader: null,
			// When this panel started waiting for notes it could have had. Kept current while it is
			// hidden and unbound: a tab nobody has looked at yet is not stuck.
			waitingSince: Date.now(),
			diagnosed: false,
			height: PANEL_HEIGHT
		};
		panels.push(entry);

		// Told the moment VS Code shows this container, so a tab viewed for the first time binds at once
		// rather than on the next sweep. The `style` attribute of this one element only - never a
		// subtree, never the workbench, whose constant churn made an earlier observer here unbounded
		// work - and the callback does nothing unless visibility actually changed, so a style write
		// for any other reason costs one comparison. Built with the container's own window, as VS Code
		// builds its own observers for elements that may live in an auxiliary window.
		const Observer = (overlay.ownerDocument.defaultView || window).MutationObserver;
		entry.observer = new Observer(() => {
			const showing = isShowing(overlay);
			if (showing && !entry.wasShowing) {
				checkTab(entry);
			}
			entry.wasShowing = showing;
		});
		entry.observer.observe(overlay, { attributes: true, attributeFilter: ['style'] });

		// A small rounded square with an 'n' in it, matching the controls along the Claude prompt.
		// Its weight carries one bit of state: bold means this session already has a note, so the
		// reader can tell from the closed panel whether there is anything in it.
		const button = document.createElement('button');
		button.id = 'ainotes-anchor-button';
		button.textContent = 'n';
		button.title = 'AI Notes';
		button.style.cssText = [
			'position:absolute',
			`bottom:${BUTTON_GAP}px`,
			'left:8px',
			'z-index:10',
			'display:flex',
			'align-items:center',
			'justify-content:center',
			'width:24px',
			'height:22px',
			'padding:0',
			'border:1px solid #4a4a4a',
			'border-radius:5px',
			'background:#2b2b2b',
			'color:#d6d6d6',
			'font:400 13px/1 "Segoe UI", sans-serif',
			'cursor:pointer'
		].join(';');
		entry.button = button;
		markNote(entry, false);
		makeResizable(entry, splitbar, panel, button);

		let open = false;
		button.addEventListener('click', event => {
			event.preventDefault();
			event.stopPropagation();
			open = !open;
			panel.style.display = open ? 'flex' : 'none';
			// The button floats over the iframe, so it steps above the panel when the panel is holding
			// the bottom of the tab, or it would sit on top of it. The remembered height, not the
			// default: a panel dragged taller must reopen where it was left.
			button.style.bottom = open ? `${entry.height + BUTTON_GAP}px` : `${BUTTON_GAP}px`;
			// Opening is a good moment to catch up if this panel never connected.
			if (open && !entry.connected) {
				register(entry);
			}
		});

		overlay.append(button, panel);
		console.log(`${TAG} panel added to Claude tab`, panelId, 'in window', windowIdOf(overlay));
	}

	function onMessage(event) {
		const data = event.data;
		if (!data || typeof data !== 'object') {
			return;
		}

		// Our own framed page. Same origin, and it names itself in every message.
		if (data.source === 'ainotes-ui') {
			const entry = panelFor(data.panel);
			if (!entry) {
				console.warn(`${TAG} message from an unknown panel`, data.panel, panels.map(p => p.id));
				return;
			}
			if (data.kind === 'ready') {
				// The loader reports what it can run for a pushed pane. Remembered on the entry so
				// every later registration carries it too, including the sweep's retries.
				if (typeof data.loader === 'number') {
					entry.loader = data.loader;
				}
				register(entry);
			} else if (data.kind === 'updateInjections') {
				// The banner link in a stale panel. Passed straight through - deciding what "update"
				// means is the extension's business, not this file's.
				toSidePanel({ source: 'ainotes-inject', kind: 'updateInjections' });
			} else if (data.kind === 'save') {
				// Filed under the tab this panel is bound to, never a fresh reading: a save can fire just
				// after its tab was switched away from, when a reading would name the tab now showing.
				if (!entry.bound) {
					toFrame(entry, {
						kind: 'error',
						problem: 'could not tell which tab this panel is in - your text is unsaved'
					});
					return;
				}
				markNote(entry, Boolean((data.text || '').trim()));
			if (typeof data.height === 'number' && data.height >= PANEL_MIN) {
				setPanelHeight(entry, entry.frame.parentElement, entry.button, data.height);
			}
				const sent = toSidePanel({
					source: 'ainotes-inject',
					kind: 'save',
					panel: entry.id,
					caption: entry.caption,
					tabKey: entry.tabKey,
					text: data.text || ''
				});
				if (!sent) {
					// A save with nowhere to go must be reported, not swallowed: the text is still in
					// the box, and the frame keeps it marked unsaved so a later push cannot overwrite
					// it. Marking this unconnected makes the sweep re-register and recover.
					entry.connected = false;
					toFrame(entry, {
						kind: 'error',
						problem: 'AI Notes side panel is not available - your text is unsaved'
					});
				}
			}
			return;
		}

		// The side panel. Its document is nested inside VS Code's own webview host page, so
		// `window.top` is its only route here.
		if (data.source !== 'ainotes-relay') {
			return;
		}
		if (data.kind === 'serverReady') {
			// Whichever side came up last triggers the sync; this is that, from the other direction.
			console.log(`${TAG} side panel ready, re-registering ${panels.length} panel(s)`);
			for (const entry of panels) {
				register(entry);
			}
			reportTabs(true);
			return;
		}
		if (data.kind === 'focusTab') {
			focusTab(data.key, data.caption);
			return;
		}
		if (data.kind === 'patched') {
			// Every panel was running the payload that has just been replaced, so no panel id and no
			// lookup: they all need telling, and none of them is usable until the window reloads.
			for (const panel of panels) {
				panel.stale = true;
				toFrame(panel, { kind: 'patched' });
			}
			return;
		}
		const entry = panelFor(data.panel);
		if (!entry) {
			return;
		}
		if (data.kind === 'stale') {
			// Stops announcing itself: re-registering cannot help until the payload is replaced and
			// the window reloaded, and the extension would answer identically every three seconds.
			entry.stale = true;
			entry.connected = false;
			toFrame(entry, { kind: 'stale', installed: data.installed, expected: data.expected });
			return;
		}
		if (data.kind === 'ui') {
			toFrame(entry, {
				kind: 'ui',
				css: data.css,
				html: data.html,
				js: data.js,
				revision: data.revision,
				needs: data.needs
			});
			return;
		}
		if (data.kind === 'notes') {
			entry.connected = true;
			entry.diagnosed = false;
			markNote(entry, Boolean((data.text || '').trim()));
			toFrame(entry, {
				kind: 'notes',
				sessionId: data.sessionId,
				agent: data.agent,
				text: data.text || ''
			});
			return;
		}
		if (data.kind === 'error') {
			// Stays unconnected on purpose, so the sweep keeps announcing it. A session that is not
			// resolvable yet - a tab just reopened, a session still starting - becomes resolvable
			// without anyone pressing anything.
			entry.connected = false;
			toFrame(entry, { kind: 'error', problem: data.problem });
		}
	}

	window.addEventListener('message', onMessage);

	/** Forget a panel, by index, saying why. */
	function forget(index, why) {
		const entry = panels[index];
		console.log(`${TAG} forgetting panel ${entry.id}: ${why}`);
		if (entry.observer) {
			entry.observer.disconnect();
		}
		clearTimeout(entry.settling);
		panels.splice(index, 1);
	}

	let timer;
	function sweep() {
		try {
			// Pruned BEFORE anything is added, so a reopened tab cannot be matched against the entry
			// its closed predecessor left behind.
			for (let i = panels.length - 1; i >= 0; i--) {
				if (isLive(panels[i].overlay) && isLive(panels[i].frame)) {
					continue;
				}
				// The mark goes with the entry, in both cases. It is the thing that stops a
				// container being fitted twice, so leaving it set on a container we have just given
				// up on would leave that tab bare for good - and a container is not only emptied,
				// it can also be moved to another window, which is a disconnect we would otherwise
				// never recover from.
				const reason = isLive(panels[i].overlay)
					? 'its frame was removed from a container that stayed'
					: 'its tab is gone';
				delete panels[i].overlay.dataset[MARK];
				forget(i, reason);
			}

			for (const view of liveViews()) {
				for (const frame of iframesFor(view.doc, CLAUDE_EXTENSION)) {
					if (isDockedView(frame)) {
						continue;
					}
					const overlay = frame.closest('.webview-overlay-content');
					if (!overlay) {
						continue;
					}
					// Re-applied every pass, not just once: if VS Code reasserts its own inline styles on
					// a layout, the column would silently collapse back and the panel would overlap again.
					fit(overlay, frame);
					if (!overlay.dataset[MARK]) {
						overlay.dataset[MARK] = '1';
						addControls(overlay);
					}
				}
			}

			// Anything still waiting keeps announcing itself. This is the whole reconnection story:
			// a reopened Claude tab, a session that had not started yet, a side panel opened later -
			// all recover here without a round trip or a deadline. Tabs are read only for panels that
			// are showing: an unbound one learns its tab, a bound one notices a retitle. A hidden panel
			// is left exactly as it is - see `isShowing` for why reading it would be wrong.
			const now = Date.now();
			for (const entry of panels) {
				if (entry.stale) {
					continue;
				}
				// Every panel reads its tab, including one the extension answered with an error. A new
				// tab binds while it is still captioned "Claude Code", is told no session matches, and
				// is retitled a moment later - skipping the read here left it re-sending "Claude Code"
				// for as long as it stayed on screen. `checkTab` returns at once when nothing changed.
				checkTab(entry);
				// The retry re-sends what the panel is bound to, so it waits while a new reading is
				// settling: that reading registers by itself, and the old caption would only fetch
				// the error again.
				if (
					entry.bound &&
					!entry.connected &&
					!entry.settling &&
					now - entry.lastRegister >= REGISTER_RETRY_MS
				) {
					register(entry);
				}
				if (entry.connected) {
					continue;
				}
				if (!entry.bound && !isShowing(entry.overlay)) {
					entry.waitingSince = now;
					continue;
				}
				// A panel that has been asking for a while and getting nowhere reports its whole
				// state once, so "loading for ever" names its own cause instead of being silent.
				if (!entry.diagnosed && now - entry.waitingSince >= STUCK_AFTER_MS) {
					entry.diagnosed = true;
					console.warn(`${TAG} panel stuck, state follows`, {
						panel: entry.id,
						bound: entry.bound,
						caption: entry.caption,
						showing: isShowing(entry.overlay),
						window: windowIdOf(entry.overlay),
						overlayLive: isLive(entry.overlay),
						frameLive: isLive(entry.frame),
						frameWindow: Boolean(entry.frame.contentWindow),
						sidePanelFrames: iframesFor(document, NOTES_EXTENSION).length,
						secondsWaiting: Math.round((now - entry.waitingSince) / 1000)
					});
				}
			}

			// The relay is the side panel's webview, and VS Code makes it only when that view is shown.
			// Opened here rather than when a panel first needs it: a Claude tab restored in the
			// background has no panel until it is clicked, so waiting would move this to the middle of
			// the reader's work, where it is most visible. Once per window, and only where there is a
			// Claude tab to serve.
			if (
				!wakeTried &&
				Date.now() - loadedAt >= WAKE_AFTER_LOAD_MS &&
				iframesFor(document, NOTES_EXTENSION).length === 0 &&
				anyClaudeTab()
			) {
				wakeTried = true;
				wakeSidePanel();
			}

			// Last, so a tab that appeared this pass is reported together with the panel it got.
			reportTabs(false);
		} catch (err) {
			// Stop rather than repeat the same throw every second for the life of the window.
			clearInterval(timer);
			console.error(`${TAG} sweep failed, polling stopped`, err);
		}
	}

	/**
	 * Learn about auxiliary windows as they are opened.
	 *
	 * There is no way to enumerate them: the workbench keeps the handles to itself and no DOM in
	 * this window refers to them. But it opens them with `pt.open(...)`, and `var pt = window` in
	 * the shipped bundle - read there, not assumed - so this is the very property lookup it
	 * performs. Called through first and unconditionally, so a blocked popup still returns exactly
	 * what the workbench expects and nothing here can cost it a window.
	 */
	const nativeOpen = window.open;
	window.open = function () {
		const child = nativeOpen.apply(this, arguments);
		try {
			if (child && child !== window) {
				adoptWindow(child);
			}
		} catch (err) {
			console.warn(`${TAG} could not adopt an opened window`, err);
		}
		return child;
	};

	sweep();
	timer = setInterval(sweep, POLL_MS);

	console.log(
		`${TAG} injected payload ${VERSION}, polling every ${POLL_MS}ms, watching for auxiliary windows`
	);
})();