// @ts-check
(function () {
	'use strict';

	const vscode = acquireVsCodeApi();

	// Printed on load so a stale build is visible at a glance rather than inferred from behaviour.
	// An evening was lost to a current injected payload talking to a side panel from an older VSIX.
	const BUILD = 'contract-1';
	console.log('[AI Notes] side.js build ' + BUILD);

	const devTools = /** @type {HTMLElement} */ (document.getElementById('dev-tools'));
	const menuButton = /** @type {HTMLButtonElement} */ (document.getElementById('menu'));
	const spikePatchButton = /** @type {HTMLButtonElement} */ (document.getElementById('spike-patch'));
	const spikeUnpatchButton = /** @type {HTMLButtonElement} */ (document.getElementById('spike-unpatch'));
	const rows = /** @type {HTMLElement} */ (document.getElementById('rows'));
	const stale = /** @type {HTMLElement} */ (document.getElementById('stale'));
	const tip = /** @type {HTMLElement} */ (document.getElementById('tip'));
	const general = /** @type {HTMLElement} */ (document.getElementById('general'));
	const generalSplit = /** @type {HTMLElement} */ (document.getElementById('general-split'));
	const generalText = /** @type {HTMLTextAreaElement} */ (document.getElementById('general-text'));
	const generalToggle = /** @type {HTMLButtonElement} */ (document.getElementById('general-toggle'));

	/** The open Claude tabs, newest state pushed by the extension. @type {Array<{caption: string, label: string, note: string, active: boolean}>} */
	let sessions = [];

	// The menu is the only thing that reveals the patch actions now, so they start hidden and no
	// longer depend on whether a payload has reported a revision.
	function setMenuOpen(open) {
		if (open) {
			devTools.removeAttribute('hidden');
		} else {
			devTools.setAttribute('hidden', '');
		}
		menuButton.setAttribute('aria-expanded', String(open));
	}

	menuButton.addEventListener('click', () => setMenuOpen(devTools.hasAttribute('hidden')));

	/** Matches the extension's own autosave delay, so both surfaces settle at the same pace. */
	const GENERAL_SAVE_MS = 800;
	const GENERAL_MIN = 60;
	const GENERAL_DEFAULT = 140;

	let generalOpen = false;
	let generalHeight = GENERAL_DEFAULT;
	let generalSaveTimer;
	/** Set while a push writes into the field, so arriving text is not mistaken for an edit. */
	let generalLoading = false;
	/** The text last handed to the extension. The field is modified when it differs from this. */
	let generalLastSent = null;

	/** One place that writes the height, so the flex basis and the inline height cannot disagree. */
	function setGeneralHeight(height) {
		generalHeight = Math.max(GENERAL_MIN, Math.round(height));
		general.style.flexBasis = generalHeight + 'px';
		general.style.height = generalHeight + 'px';
	}

	function applyGeneralOpen(open) {
		generalOpen = open;
		if (open) {
			general.removeAttribute('hidden');
		} else {
			general.setAttribute('hidden', '');
		}
		generalToggle.setAttribute('aria-expanded', String(open));
	}

	/** Capital and bold when the folder has a note, so the closed button still says whether it does. */
	function markGeneral() {
		const has = Boolean(generalText.value.trim());
		generalToggle.textContent = has ? 'N' : 'n';
		generalToggle.style.fontWeight = has ? '700' : '400';
	}

	generalToggle.addEventListener('click', () => {
		applyGeneralOpen(!generalOpen);
		vscode.postMessage({ type: 'generalOpen', open: generalOpen });
		if (generalOpen) {
			generalText.focus();
		}
	});

	generalText.addEventListener('input', () => {
		if (generalLoading) {
			return;
		}
		markGeneral();
		clearTimeout(generalSaveTimer);
		// Fire and forget: nothing is expected back, so nothing can arrive later and overwrite what
		// has been typed since.
		generalSaveTimer = setTimeout(() => {
			generalLastSent = generalText.value;
			vscode.postMessage({ type: 'generalSave', text: generalLastSent });
		}, GENERAL_SAVE_MS);
	});

	// Pointer capture, so the drag survives the cursor leaving a 4px strip; committed once on
	// release, because persisting on every pointermove would be a write per frame.
	generalSplit.addEventListener('pointerdown', event => {
		event.preventDefault();
		generalSplit.setPointerCapture(event.pointerId);
		generalSplit.classList.add('dragging');
		const startY = event.clientY;
		const startH = general.getBoundingClientRect().height;

		const onMove = move => setGeneralHeight(startH - (move.clientY - startY));
		const onUp = () => {
			generalSplit.classList.remove('dragging');
			generalSplit.removeEventListener('pointermove', onMove);
			vscode.postMessage({ type: 'generalHeight', height: generalHeight });
		};
		generalSplit.addEventListener('pointermove', onMove);
		generalSplit.addEventListener('pointerup', onUp, { once: true });
		generalSplit.addEventListener('pointercancel', onUp, { once: true });
	});

	spikePatchButton.addEventListener('click', () => vscode.postMessage({ type: 'spikePatch' }));
	spikeUnpatchButton.addEventListener('click', () => vscode.postMessage({ type: 'spikeUnpatch' }));

	/** Long enough that a double click lands before the card appears. */
	const TIP_DELAY_MS = 550;

	let tipTimer;
	function hideTip() {
		clearTimeout(tipTimer);
		tip.hidden = true;
	}
	// Registered once, on the list rather than on each row: the rows are rebuilt on every push, so
	// attaching this per row would add a listener per row per render, for the life of the window.
	rows.addEventListener('scroll', hideTip, { passive: true });

	/** True in a window with no folder open, where notes have nowhere to be stored. */
	let noFolder = false;
	/**
	 * Whether a tab list has ever arrived, which is not the same as the list being empty.
	 *
	 * The list is reported by the injected script, so there is a moment at startup - and the whole
	 * life of an unpatched window - where nothing is known about open tabs. Saying "No Claude Code
	 * tabs open" then would be a claim this panel is in no position to make.
	 */
	let listed = false;

	window.addEventListener('message', event => {
		const message = event.data;
		// Spike: a message from the script injected into the workbench renderer, offering a Claude
		// tab's overlay container as an anchor. It arrives as a plain window message like the
		// extension host's own, so the marker on it is what tells the two apart.
		if (message && message.source === 'ainotes-inject') {
			console.log('[AI Notes] message from injected script', {
				origin: event.origin,
				data: message
			});
			// The injected panel cannot reach the extension host itself, so this webview is the only
			// road between it and the notes file. Nothing is decided here - the request is carried
			// across with its id intact and the answer is carried back.
			// The link in a stale panel's banner, arriving the long way round: the framed page cannot
			// reach the extension host, so it asks the injected script, which asks this webview.
			if (message.kind === 'tabs') {
				// The row list, straight from the workbench DOM. Only the extension can turn a
				// caption into a session title and a note, so it goes up and comes back as rows.
				vscode.postMessage({ type: 'injectedTabs', tabs: message.tabs || [] });
				return;
			}
			if (message.kind === 'updateInjections') {
				console.log('[AI Notes] side -> extension runInjector (from a panel)');
				vscode.postMessage({ type: 'runInjector' });
				return;
			}
			if (message.kind === 'sessions' || message.kind === 'pick') {
				// The pane's session picker, both halves of it: the request for the list of running
				// sessions, and the session that was picked with the text to carry into it. Carried
				// across with the panel and tab ids intact; the extension decides everything else.
				const outbound = {
					type: message.kind === 'sessions' ? 'injectedSessions' : 'injectedPick',
					panel: message.panel,
					caption: message.caption,
					tabKey: message.tabKey,
					sessionId: message.sessionId,
					text: message.text || ''
				};
				console.log('[AI Notes] side -> extension', outbound);
				vscode.postMessage(outbound);
				return;
			}
			if (message.kind === 'register' || message.kind === 'save' || message.kind === 'height') {
				const outbound = {
					type:
						message.kind === 'register'
							? 'injectedRegister'
							: message.kind === 'height'
								? 'injectedHeight'
								: 'injectedSave',
					panel: message.panel,
					caption: message.caption,
					// The id of the tab it lives in. Carried across untouched: nothing is decided here,
					// and the extension binds the note to it.
					tabKey: message.tabKey,
					// Both halves of what the panel is RUNNING: the revision stamped into the injected
					// payload, and what its loader can do for a pushed pane. Neither was carried before,
					// and the effect was silent - the extension saw no revision, treated every panel as
					// a development build, and the update offer could never appear.
					version: message.version,
					loader: message.loader,
					text: message.text || '',
					height: message.height
				};
				console.log('[AI Notes] side -> extension', outbound);
				vscode.postMessage(outbound);
				return;
			}
			showInjectBanner(message);
			return;
		}
		if (message && message.type === 'injectedUi') {
			// The note pane itself, on its way to a framed page. Carried across as text: only that
			// document can run it, and it is the one place in this chain with no CSP to fight.
			toInjected({
				kind: 'ui',
				panel: message.panel,
				css: message.css,
				html: message.html,
				js: message.js,
				revision: message.revision,
				needs: message.needs
			});
			return;
		}
		if (message && message.type === 'injectedSessionList') {
			// The running sessions, on their way to the pane that asked. Only the extension can turn
			// a transcript into a title and an address, which is why the list is built up there and
			// only drawn down here.
			toInjected({
				kind: 'sessions',
				panel: message.panel,
				sessions: message.sessions || []
			});
			return;
		}
		if (message && (message.type === 'injectedNotes' || message.type === 'injectedError')) {
			console.log('[AI Notes] side <- extension', message);
			toInjected({
				kind: message.type === 'injectedNotes' ? 'notes' : 'error',
				panel: message.panel,
				sessionId: message.sessionId,
				agent: message.agent,
				text: message.text,
				problem: message.problem,
				at: message.at
			});
			return;
		}
		if (message && message.type === 'spikeDone') {
			// Whatever was opened for has happened, and the result is in the output channel rather
			// than in this menu.
			setMenuOpen(false);
			return;
		}
		if (message && message.type === 'injectState') {
			if (message.patched === false) {
				showActivate();
			} else if (message.patched === true && !awaitingRestart) {
				stale.style.display = 'none';
			}
			return;
		}
		if (message && message.type === 'injectedStale') {
			showStale(message.installed, message.expected);
			// The panel in the Claude tab shows the same offer in place of its note, so it needs the
			// revisions too - it cannot compute them itself.
			toInjected({
				kind: 'stale',
				panel: message.panel,
				installed: message.installed,
				expected: message.expected
			});
			return;
		}
		if (message && message.type === 'injectedPatched') {
			// No panel id: every panel was running the payload that has just been replaced.
			toInjected({ kind: 'patched' });
			// Deliberately not "done": the new files are on disk but the running window still has the
			// old ones loaded, because workbench.html is only read when the document loads.
			stale.replaceChildren(
				document.createTextNode('Please restart VS Code for the changes to take effect.')
			);
			return;
		}
		if (message && message.type === 'generalState') {
			// No folder means nowhere to store a folder note, so the button is not offered at all.
			if (!message.available) {
				generalToggle.setAttribute('hidden', '');
				applyGeneralOpen(false);
				return;
			}
			generalToggle.removeAttribute('hidden');
			setGeneralHeight(message.height || GENERAL_DEFAULT);
			// Applied only when the field is not locally modified. Modified means it differs from
			// what was last sent, which includes text typed while a save was being written - the case
			// that used to be overwritten a moment after saving.
			const modified = generalLastSent !== null && generalText.value !== generalLastSent;
			if (!modified && message.text !== generalText.value) {
				generalLoading = true;
				generalText.value = message.text || '';
				generalLoading = false;
				generalLastSent = generalText.value;
			} else if (generalLastSent === null) {
				generalLastSent = generalText.value;
			}
			markGeneral();
			applyGeneralOpen(Boolean(message.open));
			return;
		}
		if (message && message.type === 'snippets') {
			snippets = Array.isArray(message.snippets) ? message.snippets : [];
			reconcileSelection();
			renderSnippets();
			return;
		}
		if (message && message.type === 'snippetSaved') {
			// An add, or the edit an Update press ended, was stored, and either way the form starts over
			// as a fresh Add. Cleared only when it still holds what was stored: a failed write sends
			// nothing, so the text stays, and anything typed while the write was in flight stays too.
			if (snippetTitle.value === message.title && snippetPrompt.value === message.prompt) {
				clearTimeout(snippetSaveTimer);
				snippetSaveTimer = undefined;
				selectedId = null;
				insertBeforeId = null;
				fillForm('', '');
				syncForm();
			}
			return;
		}
		if (message && message.type === 'snippetInsert') {
			// Leaving an edit empties the fields, as a click on the selected row does. A draft already
			// being typed as a new snippet is kept - it is what gets inserted.
			if (selectedId !== null) {
				deselectSnippet();
			}
			insertBeforeId = typeof message.beforeId === 'string' ? message.beforeId : null;
			syncForm();
			snippetTitle.focus();
			return;
		}
		if (message && message.type === 'rows') {
			sessions = message.rows || [];
			listed = Boolean(message.listed);
			noFolder = Boolean(message.noFolder);
			render();
		}
	});

	/**
	 * Answer the injected script.
	 *
	 * This document sits in a frame nested inside VS Code's own webview host page, so `parent` is
	 * that host and not the workbench. `window.top` is the workbench document where the injected
	 * script listens, and posting to it cross-origin is allowed - sending always is; it is receiving
	 * that same-origin policy governs.
	 */
	function toInjected(event) {
		try {
			// `source` last so a forwarded payload carrying its own `source` cannot overwrite the
			// field the receiving side filters on - that mistake silently discarded every reply once.
			window.top.postMessage({ ...event, source: 'ainotes-relay' }, '*');
			console.log('[AI Notes] side -> injected (via window.top)', event.kind, event.panel);
		} catch (err) {
			console.error('[AI Notes] send to injected script failed', err);
		}
	}

	/**
	 * Once the injector has run, nothing observable improves until the window reloads - so the
	 * restart notice must survive a later `injectState` saying the workbench is patched now, which
	 * it is, while this window is still running the old one.
	 */
	let awaitingRestart = false;

	/** Build a banner with one action link, keyboard reachable, without any HTML sink. */
	function banner(text, linkText, onRun, detail) {
		const line = document.createElement('div');
		line.textContent = text;

		const link = document.createElement('a');
		link.textContent = linkText;
		link.setAttribute('role', 'button');
		link.tabIndex = 0;
		link.addEventListener('click', onRun);
		link.addEventListener('keydown', event => {
			if (event.key === 'Enter' || event.key === ' ') {
				event.preventDefault();
				onRun();
			}
		});
		line.appendChild(link);

		const children = [line];
		if (detail) {
			const note = document.createElement('div');
			note.style.cssText = 'opacity:0.7;margin-top:2px';
			note.textContent = detail;
			children.push(note);
		}
		stale.replaceChildren(...children);
		stale.style.display = 'block';
	}

	function runInjector() {
		awaitingRestart = true;
		stale.replaceChildren(document.createTextNode('Updating the injected script...'));
		vscode.postMessage({ type: 'runInjector' });
	}

	/** The workbench in this window carries no injection at all. */
	function showActivate() {
		banner('Click here to activate in vscode. Requires restart. ', 'Click here', runInjector);
	}

	/**
	 * The injected script is running code this extension did not ship.
	 *
	 * Built with `createElement` and `textContent`, never `innerHTML` - the revisions are strings
	 * that arrived from another process, and this webview's CSP would not save us from markup in one.
	 * Shown once and left up until the reader acts on it: it is not an error to dismiss, it means the
	 * panels inside Claude tabs are stale.
	 */
	function showStale(installed, expected) {
		banner(
			'You Must Update The Injected Script ',
			'Click here',
			runInjector,
			'injected ' + installed + ', extension ships ' + expected
		);
	}

	/** Spike: proof on screen that the injected script reached this webview. */
	function showInjectBanner(message) {
		const banner = document.getElementById('inject-banner') || document.createElement('div');
		banner.id = 'inject-banner';
		banner.className = 'row-none';
		banner.style.cssText = 'background:#c8321e;color:#fff;padding:6px 8px;margin:4px';
		banner.textContent = `${message.open ? 'Opened' : 'Closed'} - anchor ${
			message.containerId || 'unknown container'
		}`;
		// Replaced rather than stacked: every click would otherwise leave another banner behind.
		rows.prepend(banner);
	}

	function render() {
		if (sessions.length === 0 && !listed) {
			rows.replaceChildren();
			return;
		}
		if (sessions.length === 0) {
			const none = document.createElement('div');
			none.className = 'row-none';
			none.textContent = noFolder
				? 'Open a folder to start taking notes - AI Notes stores them beside it.'
				: 'No Claude Code tabs open';
			rows.replaceChildren(none);
			return;
		}
		rows.replaceChildren(...sessions.map(makeRow));
	}

	/**
	 * One open Claude tab: its session title, and the note underneath.
	 *
	 * Double click asks the injected script to focus it. There is no API for activating an arbitrary
	 * tab - `Tab` exposes `isActive` and no way to set it - but the tab header is an element in the
	 * workbench DOM, and the injected script is already in there, so a click on it is the one route
	 * available. Best effort by nature, hence "try to focus".
	 */
	/** @param {{key: string, caption: string, label: string, note: string, active: boolean}} session */
	function makeRow(session) {
		const row = document.createElement('div');
		row.className = 'row' + (session.active ? ' noted' : '');
		row.setAttribute('role', 'option');
		row.tabIndex = 0;

		const title = document.createElement('div');
		title.className = 'row-title';
		// The full session title where one was matched, falling back to the tab's own caption.
		// textContent, never innerHTML: a title is whatever was typed into that session.
		title.textContent = session.label || session.caption;

		const meta = document.createElement('div');
		meta.className = 'row-meta';
		// Collapsed to one line here rather than in the extension, because the tooltip needs the
		// note with its line breaks intact and the row needs it without them.
		const preview = (session.note || '').replace(/\s+/g, ' ').trim();
		meta.textContent = preview || 'no notes';
		if (!preview) {
			meta.classList.add('empty');
		}

		row.append(title, meta);
		if (session.note && session.note.trim()) {
			attachTip(row, session.note.trim());
		}
		row.addEventListener('dblclick', () => focusTab(session.key, session.caption));
		row.addEventListener('keydown', event => {
			if (event.key === 'Enter' || event.key === ' ') {
				event.preventDefault();
				focusTab(session.key, session.caption);
			}
		});
		return row;
	}

	/**
	 * Show a row's note in the hover card, after a pause.
	 *
	 * The pause is the point: the card appearing under the pointer the instant it lands would be in
	 * the way of the double click that focuses the tab. It is also cancelled by that double click,
	 * by leaving the row, and by scrolling - a card left floating over a list that has moved is
	 * pointing at the wrong row.
	 */
	function attachTip(row, note) {
		row.addEventListener('mouseenter', () => {
			clearTimeout(tipTimer);
			tipTimer = setTimeout(() => show(row, note), TIP_DELAY_MS);
		});
		row.addEventListener('mouseleave', hideTip);
		row.addEventListener('mousedown', hideTip);
	}

	/**
	 * Place the card so it stays inside the panel.
	 *
	 * This one lives in the webview, unlike an OS tooltip, so it cannot spill past the panel edges -
	 * it is measured after filling and then clamped, preferring below the row and flipping above
	 * when there is no room.
	 */
	function show(row, note) {
		// textContent, never innerHTML: a note is whatever was typed into that session.
		tip.textContent = note;
		tip.hidden = false;

		const at = row.getBoundingClientRect();
		const size = tip.getBoundingClientRect();
		const margin = 6;
		const below = at.bottom + 2;
		const top =
			below + size.height + margin <= window.innerHeight
				? below
				: Math.max(margin, at.top - size.height - 2);
		const left = Math.max(margin, Math.min(at.left, window.innerWidth - size.width - margin));
		tip.style.top = Math.round(top) + 'px';
		tip.style.left = Math.round(left) + 'px';
	}

	/** Straight to the injected script: the extension host cannot activate a tab, but the DOM can. */
	function focusTab(key, caption) {
		// The caption travels as well, as the fallback for a row whose tab has been closed and
		// reopened since the list was built - a new editor gets a new key.
		toInjected({ kind: 'focusTab', key, caption });
	}

	// ---------------------------------------------------------------- tabs

	const tabButtons = /** @type {HTMLButtonElement[]} */ (Array.from(document.querySelectorAll('.tab')));

	/**
	 * Show one tab and hide the other. Hiding only: nothing is torn down, because the Session Notes
	 * tab is also the relay every injected panel talks through, and it must keep running unseen.
	 */
	function selectTab(name) {
		for (const button of tabButtons) {
			const on = button.dataset.tab === name;
			button.setAttribute('aria-selected', String(on));
			const panel = document.getElementById(button.getAttribute('aria-controls') || '');
			if (panel) {
				panel.hidden = !on;
			}
		}
	}

	for (const button of tabButtons) {
		button.addEventListener('click', () => {
			if (button.getAttribute('aria-selected') === 'true') {
				return;
			}
			selectTab(button.dataset.tab);
			// A card left up would float over the other tab's content.
			hideTip();
			vscode.postMessage({ type: 'tabSelected', tab: button.dataset.tab });
		});
	}

	// The extension renders the remembered tab into the page, so the first paint is already right;
	// this only brings the buttons and panels into step with it.
	selectTab(document.body.dataset.tab === 'snippets' ? 'snippets' : 'notes');

	// ---------------------------------------------------------------- prompt snippets

	const snippetList = /** @type {HTMLElement} */ (document.getElementById('snippet-list'));
	const snippetForm = /** @type {HTMLFormElement} */ (document.getElementById('snippet-form'));
	const snippetTitle = /** @type {HTMLInputElement} */ (document.getElementById('snippet-title'));
	const snippetPrompt = /** @type {HTMLTextAreaElement} */ (document.getElementById('snippet-prompt'));
	const snippetSave = /** @type {HTMLButtonElement} */ (document.getElementById('snippet-save'));

	/** Every stored snippet, as the extension last pushed them. @type {Array<{id: string, title: string, prompt: string}>} */
	let snippets = [];
	/** The snippet the form is editing, or null when the form adds a new one. @type {string | null} */
	let selectedId = null;
	/** What the fields were filled with, so a later push can tell typed text from loaded text. */
	let loaded = { title: '', prompt: '' };
	/**
	 * What a deselecting click cleared out of the fields, kept in case that click was the first half
	 * of a double click - which must copy and leave the row selected, typed changes and all.
	 * @type {{id: string, title: string, prompt: string, loaded: {title: string, prompt: string}} | null}
	 */
	let undoDeselect = null;
	/**
	 * The snippet a new one goes above, set by Insert New... on its row, or null to add at the end.
	 * That row carries a line along its top until the snippet is added or the placement cancelled.
	 * @type {string | null}
	 */
	let insertBeforeId = null;
	/** Armed while an edit to the selected snippet waits for a pause in typing to be saved. */
	let snippetSaveTimer;

	/** Only when different: assigning a field's value moves its caret to the end. */
	function setField(field, value) {
		if (field.value !== value) {
			field.value = value;
		}
	}

	function fillForm(title, prompt) {
		setField(snippetTitle, title);
		setField(snippetPrompt, prompt);
		loaded = { title, prompt };
	}

	function formModified() {
		return snippetTitle.value !== loaded.title || snippetPrompt.value !== loaded.prompt;
	}

	/** The button, the highlighted row and the insertion line, derived from the state above. */
	function syncForm() {
		snippetSave.textContent = selectedId === null ? 'Add' : 'Update';
		// Update is the way back to Add, and that is never something to refuse.
		snippetSave.disabled = selectedId === null && !snippetPrompt.value.trim();
		for (const row of Array.from(snippetList.children)) {
			const el = /** @type {HTMLElement} */ (row);
			if (el.dataset.id !== undefined) {
				const on = el.dataset.id === selectedId;
				el.classList.toggle('selected', on);
				el.setAttribute('aria-selected', String(on));
				el.classList.toggle('insert-before', el.dataset.id === insertBeforeId);
			}
		}
	}

	/**
	 * Send the snippet being edited as it stands. `done` marks an Update press, which the extension
	 * acknowledges so the form can clear. False when there was nothing to send: no snippet is being
	 * edited, or its prompt is empty, which is never stored.
	 */
	function sendSnippetEdit(done) {
		clearTimeout(snippetSaveTimer);
		snippetSaveTimer = undefined;
		if (selectedId === null || !snippetPrompt.value.trim()) {
			return false;
		}
		vscode.postMessage({
			type: 'snippetUpdate',
			id: selectedId,
			title: snippetTitle.value,
			prompt: snippetPrompt.value,
			done
		});
		return true;
	}

	/** Save a waiting edit now, before the form moves away from the snippet it belongs to. */
	function flushSnippetEdit() {
		if (snippetSaveTimer !== undefined) {
			sendSnippetEdit(false);
		}
	}

	function selectSnippet(snippet) {
		flushSnippetEdit();
		selectedId = snippet.id;
		insertBeforeId = null;
		fillForm(snippet.title, snippet.prompt);
		syncForm();
	}

	function deselectSnippet() {
		flushSnippetEdit();
		selectedId = null;
		insertBeforeId = null;
		fillForm('', '');
		syncForm();
	}

	/**
	 * Keep the form honest after the list changed underneath it - an update landing, a remove, or
	 * another window writing the file.
	 *
	 * Typed text is never thrown away. A selected snippet that has gone takes the form back to Add,
	 * and only empties the fields when they still hold what was loaded; with changes in them they
	 * stay, ready to be added again. A snippet still there refreshes the fields when nothing was
	 * typed, and adopts what is stored when it now matches the fields - which is what an edit saved
	 * as it was typed looks like, arriving back.
	 */
	function reconcileSelection() {
		if (insertBeforeId !== null && !snippets.some(candidate => candidate.id === insertBeforeId)) {
			// The row it was to go above has gone, so the new snippet goes at the end instead.
			insertBeforeId = null;
		}
		if (selectedId === null) {
			return;
		}
		const snippet = snippets.find(candidate => candidate.id === selectedId);
		const modified = formModified();
		if (!snippet) {
			selectedId = null;
			// A waiting edit has nowhere to go any more.
			clearTimeout(snippetSaveTimer);
			snippetSaveTimer = undefined;
			if (modified) {
				loaded = { title: '', prompt: '' };
			} else {
				fillForm('', '');
			}
			return;
		}
		if (snippetTitle.value.trim() === snippet.title.trim() && snippetPrompt.value === snippet.prompt) {
			// Adopted as the fields stand, so a trailing space the store trimmed off the title is not
			// taken out from under someone still typing it.
			loaded = { title: snippetTitle.value, prompt: snippetPrompt.value };
		} else if (!modified) {
			fillForm(snippet.title, snippet.prompt);
		}
	}

	/** Rebuilt whole on each push; the list is small, and the scroll position and focus survive it. */
	function renderSnippets() {
		const scroll = snippetList.scrollTop;
		const active = /** @type {HTMLElement | null} */ (document.activeElement);
		const focusedId = active && snippetList.contains(active) ? active.dataset.id : undefined;
		if (snippets.length === 0) {
			const none = document.createElement('div');
			none.className = 'row-none';
			none.textContent = 'No prompt snippets yet. Write one below and press Add.';
			snippetList.replaceChildren(none);
		} else {
			snippetList.replaceChildren(...snippets.map(makeSnippetRow));
		}
		snippetList.scrollTop = scroll;
		if (focusedId !== undefined) {
			const again = Array.from(snippetList.children).find(
				row => /** @type {HTMLElement} */ (row).dataset.id === focusedId
			);
			if (again) {
				/** @type {HTMLElement} */ (again).focus();
			}
		}
		syncForm();
	}

	/**
	 * One snippet: its title, and underneath, the prompt text the title does not already show.
	 *
	 * The right-click menu is VS Code's own. `data-vscode-context` is what it reads: the section
	 * picks the menu entries, the id tells the command which snippet, and the last flag drops
	 * VS Code's default Cut/Copy/Paste, which mean nothing on a row.
	 */
	/** @param {{id: string, title: string, prompt: string}} snippet */
	function makeSnippetRow(snippet) {
		const row = document.createElement('div');
		row.className = 'row';
		row.setAttribute('role', 'option');
		row.tabIndex = 0;
		row.dataset.id = snippet.id;
		row.dataset.vscodeContext = JSON.stringify({
			webviewSection: 'snippet',
			snippetId: snippet.id,
			preventDefaultContextMenuItems: true
		});

		const lines = snippet.prompt.trim().split(/\r?\n/);
		const titled = Boolean(snippet.title.trim());
		const title = document.createElement('div');
		title.className = 'row-title';
		// textContent, never innerHTML: a snippet is whatever was typed or pasted into it.
		title.textContent = titled ? snippet.title : lines[0];

		const meta = document.createElement('div');
		meta.className = 'row-meta';
		const rest = (titled ? snippet.prompt : lines.slice(1).join(' ')).replace(/\s+/g, ' ').trim();
		// A no-break space rather than nothing, so an untitled one-line prompt keeps the row height.
		meta.textContent = rest || ' ';

		row.append(title, meta);

		row.addEventListener('click', event => {
			// The second click of a double click. The first already did what a click does, and
			// toggling again would undo it.
			if (event.detail > 1) {
				return;
			}
			if (selectedId === snippet.id) {
				undoDeselect = {
					id: snippet.id,
					title: snippetTitle.value,
					prompt: snippetPrompt.value,
					loaded
				};
				deselectSnippet();
			} else {
				undoDeselect = null;
				selectSnippet(snippet);
			}
		});
		row.addEventListener('dblclick', () => {
			if (undoDeselect && undoDeselect.id === snippet.id) {
				// The first click deselected a row that was already selected. Put back exactly what
				// the fields held, rather than reloading and losing what was typed.
				selectedId = snippet.id;
				setField(snippetTitle, undoDeselect.title);
				setField(snippetPrompt, undoDeselect.prompt);
				loaded = undoDeselect.loaded;
				syncForm();
			} else if (selectedId !== snippet.id) {
				selectSnippet(snippet);
			}
			undoDeselect = null;
			// The stored prompt, not the fields: the copy is of the snippet, whatever is being edited.
			vscode.postMessage({ type: 'snippetCopy', id: snippet.id });
		});
		row.addEventListener('keydown', event => {
			if (event.key === 'Enter' || event.key === ' ') {
				event.preventDefault();
				if (selectedId === snippet.id) {
					deselectSnippet();
				} else {
					selectSnippet(snippet);
				}
			}
		});
		return row;
	}

	snippetForm.addEventListener('submit', event => {
		event.preventDefault();
		const title = snippetTitle.value;
		const prompt = snippetPrompt.value;
		// Nothing is changed here on sending. The form clears when the extension says the text is
		// stored, so a write that failed leaves it where it was.
		if (selectedId === null) {
			if (!prompt.trim()) {
				return;
			}
			vscode.postMessage({
				type: 'snippetAdd',
				title,
				prompt,
				beforeId: insertBeforeId === null ? undefined : insertBeforeId
			});
		} else if (!sendSnippetEdit(true)) {
			// Edits are saved as they are typed, so Update is only the way back to Add. With the prompt
			// emptied there is nothing to store and nothing to wait for; the snippet keeps the last
			// prompt it had.
			deselectSnippet();
		}
	});

	/**
	 * Typing in the fields. The button follows, and a snippet being edited is saved as it goes - a
	 * moment after each pause, at the folder note's pace, rather than a whole-file write per keystroke.
	 */
	function onSnippetInput() {
		syncForm();
		if (selectedId === null) {
			return;
		}
		clearTimeout(snippetSaveTimer);
		snippetSaveTimer = setTimeout(() => sendSnippetEdit(false), GENERAL_SAVE_MS);
	}

	snippetTitle.addEventListener('input', onSnippetInput);
	snippetPrompt.addEventListener('input', onSnippetInput);
	// Ahead of VS Code opening its menu, so Copy to clipboard copies what was just typed. Not
	// cancelled: VS Code only shows its menu for an event nobody prevented.
	snippetList.addEventListener('contextmenu', flushSnippetEdit);

	// The splitter above the form: the same control as the folder note's, trading list room for
	// prompt room. The stored height is rendered into the page, so it applies before the first paint.
	const snippetSplit = /** @type {HTMLElement} */ (document.getElementById('snippet-split'));
	/** Roughly two lines: the prompt keeps this however far the form is squeezed. */
	const SNIPPET_PROMPT_MIN = 48;
	/** What the list keeps however far the form is dragged up. main.css caps the form with the same number. */
	const SNIPPET_LIST_MIN = 60;

	/** One place that writes the height, so the flex basis and the inline height cannot disagree. */
	function setSnippetFormHeight(height) {
		const px = Math.round(height) + 'px';
		snippetForm.style.flexBasis = px;
		snippetForm.style.height = px;
	}

	const storedFormHeight = Number(snippetForm.dataset.height);
	if (storedFormHeight > 0) {
		setSnippetFormHeight(storedFormHeight);
	}

	// Pointer capture, so the drag survives the cursor leaving a 4px strip; committed once on
	// release, because persisting on every pointermove would be a write per frame.
	snippetSplit.addEventListener('pointerdown', event => {
		event.preventDefault();
		snippetSplit.setPointerCapture(event.pointerId);
		snippetSplit.classList.add('dragging');
		const startY = event.clientY;
		const startH = snippetForm.getBoundingClientRect().height;
		// Everything in the form that is not the prompt - title, button, gaps, padding - measured
		// rather than assumed, so the floor holds whatever the font sizes are.
		const minH = startH - snippetPrompt.getBoundingClientRect().height + SNIPPET_PROMPT_MIN;
		const panel = /** @type {HTMLElement} */ (snippetForm.parentElement);
		const maxH = Math.max(minH, panel.clientHeight - snippetSplit.offsetHeight - SNIPPET_LIST_MIN);
		let height = startH;

		const onMove = move => {
			height = Math.min(maxH, Math.max(minH, startH - (move.clientY - startY)));
			setSnippetFormHeight(height);
		};
		const onUp = () => {
			snippetSplit.classList.remove('dragging');
			snippetSplit.removeEventListener('pointermove', onMove);
			vscode.postMessage({ type: 'snippetsHeight', height: Math.round(height) });
		};
		snippetSplit.addEventListener('pointermove', onMove);
		snippetSplit.addEventListener('pointerup', onUp, { once: true });
		snippetSplit.addEventListener('pointercancel', onUp, { once: true });
	});

	for (const field of [snippetTitle, snippetPrompt]) {
		field.addEventListener('keydown', event => {
			if (event.key !== 'Escape') {
				return;
			}
			if (selectedId !== null) {
				event.preventDefault();
				deselectSnippet();
			} else if (insertBeforeId !== null) {
				// Cancels the placement only. What was typed stays, and Add appends it.
				event.preventDefault();
				insertBeforeId = null;
				syncForm();
			}
		});
	}

	renderSnippets();

	vscode.postMessage({ type: 'ready' });

	// Announce the relay to any panel already injected into a Claude tab. This webview only exists
	// because the extension resolved the view, so its existence IS the readiness signal - no round
	// trip needed. Panels re-register on hearing it, which is what makes startup order irrelevant:
	// whichever side comes up last triggers the sync.
	toInjected({ kind: 'serverReady' });
})();
