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
	 * The same element `captionFor` reads, without its fallbacks: this is for a tab found in the DOM
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
	 * The unique id of the tab this panel lives in.
	 *
	 * `data-resource-name`, which VS Code sets from the basename of that editor's resource:
	 * `webview-claudeVSCodePanel-<uuid>`, minted per editor. It is what the extension binds the note
	 * to, so two sessions carrying the same title are two bindings rather than one ambiguous lookup
	 * that resolves to neither.
	 *
	 * Read through the same walk as the caption, so it names the same tab the caption came from -
	 * they must agree or the binding would be filed against the wrong session.
	 */
	function tabKeyFor(overlay) {
		const tab = tabFor(overlay);
		return (tab && tab.getAttribute('data-resource-name')) || null;
	}

	function captionFor(overlay) {
		const tab = tabFor(overlay);
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

	/** Announce one panel. Idempotent: the extension treats a repeat as a refresh. */
	function register(entry) {
		const caption = captionFor(entry.overlay);
		entry.lastRegister = Date.now();
		if (!caption) {
			entry.connected = false;
			toFrame(entry, { kind: 'error', problem: 'could not read this tab’s caption' });
			return;
		}
		// Remembered so the sweep can notice the caption changing under a container VS Code reused
		// for a different session - otherwise that panel would keep showing the previous note.
		entry.caption = caption;
		// The tab's own id travels with the caption, and is what the note is bound to. The caption
		// stays because it is how a session is FOUND the first time - the id means nothing to Claude.
		entry.tabKey = tabKeyFor(entry.overlay);
		const sent = toSidePanel({
			source: 'ainotes-inject',
			kind: 'register',
			panel: entry.id,
			caption,
			tabKey: entry.tabKey,
			version: VERSION,
			loader: entry.loader
		});
		if (!sent) {
			// Nothing to talk to. The AI Notes view is resolved lazily, so in a window where it has
			// never been shown there is no webview to relay through - and that is fixable by the
			// reader, which makes it worth saying rather than retrying in silence.
			toFrame(entry, {
				kind: 'error',
				problem: 'Open the AI Notes view in the sidebar once to connect'
			});
		}
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
		const caption = captionFor(entry.overlay);
		if (!caption) {
			return;
		}
		toSidePanel({
			source: 'ainotes-inject',
			kind: 'height',
			panel: entry.id,
			caption,
			tabKey: tabKeyFor(entry.overlay) || entry.tabKey,
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
			caption: null,
			tabKey: null,
			loader: null,
			born: Date.now(),
			diagnosed: false,
			height: PANEL_HEIGHT
		};
		panels.push(entry);

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
				const caption = captionFor(entry.overlay);
				if (!caption) {
					toFrame(entry, { kind: 'error', problem: 'could not read this tab’s caption' });
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
					caption,
					tabKey: tabKeyFor(entry.overlay) || entry.tabKey,
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
		console.log(`${TAG} forgetting panel ${panels[index].id}: ${why}`);
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
			// all recover here without a round trip or a deadline. And a connected panel whose tab
			// caption has changed under it re-registers, which covers a container VS Code handed to
			// a different session and a session that has since been retitled.
			const now = Date.now();
			for (const entry of panels) {
				if (entry.stale) {
					continue;
				}
				if (!entry.connected) {
					if (now - entry.lastRegister >= REGISTER_RETRY_MS) {
						register(entry);
					}
					// A panel that has been asking for a while and getting nowhere reports its whole
					// state once, so "loading for ever" names its own cause instead of being silent.
					if (!entry.diagnosed && entry.born && now - entry.born >= STUCK_AFTER_MS) {
						entry.diagnosed = true;
						console.warn(`${TAG} panel stuck, state follows`, {
							panel: entry.id,
							caption: captionFor(entry.overlay),
							window: windowIdOf(entry.overlay),
							overlayLive: isLive(entry.overlay),
							frameLive: isLive(entry.frame),
							frameWindow: Boolean(entry.frame.contentWindow),
							sidePanelFrames: iframesFor(document, NOTES_EXTENSION).length,
							secondsWaiting: Math.round((now - entry.born) / 1000)
						});
					}
					continue;
				}
				const caption = captionFor(entry.overlay);
				if (caption && caption !== entry.caption) {
					console.log(`${TAG} caption changed, re-registering`, entry.id);
					register(entry);
				}
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