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
	const NOTES_EXTENSION = 'arcticrobots.ainotes';
	/** Marks a container already fitted, so the poll never doubles up. */
	const MARK = 'ainotesAnchored';
	const BUTTON_GAP = 8;
	/** Halved from the first attempt: 320 dominated the tab. */
	const PANEL_HEIGHT = 160;
	const SPLITBAR_PX = 4;
	const PANEL_MIN = 80;

	/** Every panel this script built: {id, overlay, frame, connected, lastRegister}. */
	const panels = [];

	/** The `extensionId` VS Code puts in a webview iframe's src, or nothing if it is not a webview. */
	function paramOf(iframe, name) {
		try {
			return new URL(iframe.getAttribute('src') || '', location.href).searchParams.get(name);
		} catch {
			return null;
		}
	}

	function iframesFor(extensionId) {
		const out = [];
		for (const frame of document.querySelectorAll('iframe.webview')) {
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
		for (const frame of iframesFor(NOTES_EXTENSION)) {
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
	function captionFor(overlay) {
		const anchor = overlay.style.getPropertyValue('position-anchor');
		if (!anchor) {
			return null;
		}
		const target = Array.prototype.find.call(
			document.querySelectorAll('[style*="anchor-name"]'),
			el => el.style.getPropertyValue('anchor-name') === anchor
		);
		const group = target && target.closest('.editor-group-container');
		const tab = group && group.querySelector('.tab.active');
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
		const sent = toSidePanel({
			source: 'ainotes-inject',
			kind: 'register',
			panel: entry.id,
			caption,
			version: VERSION
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
	 * Bring a Claude tab to the front by clicking its header.
	 *
	 * There is no API for activating an arbitrary tab - `Tab` exposes `isActive` and no way to set
	 * it - so the side panel asks this script instead, because the tab header is an ordinary element
	 * in the workbench DOM and a click on it is what a reader would do anyway.
	 *
	 * Matched on the label element's own text, the same source `captionFor` reads, so a caption that
	 * came from the extension's tab list matches what is on screen. Reported either way: a silent
	 * miss here would look like a dead double click.
	 */
	function focusTab(caption) {
		if (!caption) {
			return;
		}
		for (const label of document.querySelectorAll('.tab .label-name')) {
			if ((label.textContent || '').trim() !== caption.trim()) {
				continue;
			}
			const tab = label.closest('.tab');
			if (tab) {
				pressElement(tab);
				flashElement(tab);
				console.log(`${TAG} focused tab`, caption);
				return;
			}
		}
		console.warn(`${TAG} no tab found to focus`, caption);
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
			view: window,
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
	function ensureFlashStyle() {
		if (document.getElementById('ainotes-flash-style')) {
			return;
		}
		const style = document.createElement('style');
		style.id = 'ainotes-flash-style';
		// `textContent` on a style element, not `innerHTML`: this document enforces Trusted Types.
		style.textContent =
			'@keyframes ainotes-flash {' +
			'0% { background-color: transparent }' +
			'40% { background-color: rgba(201, 100, 66, 0.9) }' +
			'100% { background-color: transparent } }';
		document.head.appendChild(style);
	}

	/**
	 * Blink the tab so the eye can find it.
	 *
	 * Focusing a tab in a crowded tab bar is invisible if the tab was already partly in view, so the
	 * click gets an acknowledgement. The inline animation is cleared afterwards: the element belongs
	 * to VS Code, and leaving our style on it would outlive the reason for it.
	 */
	function flashElement(el) {
		ensureFlashStyle();
		el.style.animation = 'none';
		// Reading a layout property forces the restart, or a second flash on the same tab does
		// nothing because the animation name has not changed.
		void el.offsetWidth;
		el.style.animation = 'ainotes-flash 200ms ease-in-out 3';
		el.addEventListener(
			'animationend',
			() => {
				el.style.animation = '';
			},
			{ once: true }
		);
	}

	function panelFor(id) {
		const matches = panels.filter(entry => entry.id === id);
		return matches.find(entry => document.contains(entry.frame)) || matches[0] || null;
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
		frame.src = './ainotes-ui.html?panel=' + encodeURIComponent(panelId);
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
		toSidePanel({ source: 'ainotes-inject', kind: 'height', panel: entry.id, caption, height });
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
		const { panel, frame, splitbar } = buildPanel(panelId);
		const entry = {
			id: panelId,
			overlay,
			frame,
			connected: false,
			stale: false,
			lastRegister: 0,
			caption: null,
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
		console.log(`${TAG} panel added to Claude tab`, panelId);
	}

	window.addEventListener('message', event => {
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
			return;
		}
		if (data.kind === 'focusTab') {
			focusTab(data.caption);
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
	});

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
				if (!document.contains(panels[i].overlay)) {
					forget(i, 'its tab is gone');
				} else if (!document.contains(panels[i].frame)) {
					// The container survived but VS Code emptied it. The mark below is cleared too, so
					// the pass that follows rebuilds the panel rather than leaving the tab bare.
					delete panels[i].overlay.dataset[MARK];
					forget(i, 'its frame was removed from a container that stayed');
				}
			}

			for (const frame of iframesFor(CLAUDE_EXTENSION)) {
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
							overlayInDocument: document.contains(entry.overlay),
							frameInDocument: document.contains(entry.frame),
							frameWindow: Boolean(entry.frame.contentWindow),
							sidePanelFrames: iframesFor(NOTES_EXTENSION).length,
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
		} catch (err) {
			// Stop rather than repeat the same throw every second for the life of the window.
			clearInterval(timer);
			console.error(`${TAG} sweep failed, polling stopped`, err);
		}
	}

	sweep();
	timer = setInterval(sweep, POLL_MS);

	console.log(`${TAG} injected payload ${VERSION}, polling every ${POLL_MS}ms`);
})();
