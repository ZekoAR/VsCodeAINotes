// @ts-check
(function () {
	'use strict';

	const vscode = acquireVsCodeApi();

	const notes = /** @type {HTMLTextAreaElement} */ (document.getElementById('notes'));
	const empty = /** @type {HTMLElement} */ (document.getElementById('empty'));
	const banner = /** @type {HTMLElement} */ (document.getElementById('banner'));
	const editor = /** @type {HTMLElement} */ (document.getElementById('editor'));
	const status = /** @type {HTMLElement} */ (document.getElementById('status'));
	const actions = /** @type {HTMLElement} */ (document.getElementById('actions'));
	const statusText = /** @type {HTMLElement} */ (document.getElementById('status-text'));
	const fileName = /** @type {HTMLElement} */ (document.getElementById('file-name'));
	const picker = /** @type {HTMLElement} */ (document.getElementById('picker'));
	const pickerBack = /** @type {HTMLButtonElement} */ (document.getElementById('picker-back'));
	const search = /** @type {HTMLInputElement} */ (document.getElementById('picker-search'));
	const list = /** @type {HTMLElement} */ (document.getElementById('picker-list'));

	/** Whether the panel is showing its session list. Owned here: the host does not know about it. */
	let picking = false;
	/**
	 * What picking a row will do: 'switch' shows that session's notes instead of these, 'continue'
	 * copies these notes into it first and follows them there. The list is the same list; only this
	 * and the placeholder differ, so there is one picker rather than two that drift apart.
	 */
	let pickerMode = 'switch';
	/** @type {any} The last state the host sent. */
	let current = null;
	/** @type {Array<{id: string, label: string, live: boolean, lastActivity?: number, pid?: number}>} */
	let sessions = [];

	for (const id of ['select', 'switch', 'banner-switch']) {
		const el = document.getElementById(id);
		if (el) {
			el.addEventListener('click', () => openPicker('switch'));
		}
	}
	for (const id of ['continue', 'banner-continue']) {
		const el = document.getElementById(id);
		if (el) {
			el.addEventListener('click', () => openPicker('continue'));
		}
	}
	const bindActive = document.getElementById('banner-bind');
	if (bindActive) {
		bindActive.addEventListener('click', () => {
			vscode.postMessage({ type: 'bindActive' });
		});
	}
	pickerBack.addEventListener('click', closePicker);
	search.addEventListener('input', renderList);

	search.addEventListener('keydown', event => {
		if (event.key === 'Escape') {
			// Only a connected panel has something to go back to.
			if (current && current.session) {
				closePicker();
			}
		} else if (event.key === 'Enter') {
			const first = list.querySelector('.row');
			if (first instanceof HTMLElement && first.dataset.id) {
				select(first.dataset.id);
			}
		}
	});

	notes.addEventListener('input', () => {
		vscode.postMessage({ type: 'input', text: notes.value });
	});

	notes.addEventListener('keydown', event => {
		if ((event.ctrlKey || event.metaKey) && event.key === 's') {
			event.preventDefault();
			vscode.postMessage({ type: 'save' });
		}
	});

	window.addEventListener('message', event => {
		const message = event.data;
		if (!message) {
			return;
		}
		if (message.type === 'state') {
			current = message;
			// Persisted so VS Code can hand the note id back after a window reload and the right
			// tab is restored into the right note.
			vscode.setState({ noteId: message.noteId });
			applyText(message);
			apply();
		} else if (message.type === 'sessions') {
			sessions = message.sessions || [];
			renderList();
		}
	});

	/** @param {string} mode 'switch' or 'continue' */
	function openPicker(mode) {
		picking = true;
		pickerMode = mode;
		search.value = '';
		search.placeholder = mode === 'continue' ? 'Continue in Session' : 'Select AI Session';
		list.replaceChildren();
		vscode.postMessage({ type: 'requestSessions' });
		apply();
		search.focus();
	}

	function closePicker() {
		picking = false;
		apply();
	}

	/** @param {string} id */
	function select(id) {
		const carry = pickerMode === 'continue';
		picking = false;
		vscode.postMessage({ type: 'selectSession', sessionId: id, carry: carry });
		apply();
	}

	/**
	 * Four states, exactly one on screen:
	 *   picking     -> the search field and the session list, over everything else;
	 *   no session  -> the "Select AI Session" button, centred, and no text field at all;
	 *   running     -> the notes, with "Continue in Session" and "Switch AI Session" in the corner;
	 *   ended       -> the notes disabled, under a banner carrying those actions instead.
	 */
	function apply() {
		if (!current) {
			return;
		}
		const connected = Boolean(current.session);
		const ended = connected && Boolean(current.readOnly);

		picker.hidden = !picking;
		empty.hidden = picking || connected;
		editor.hidden = picking || !connected;
		status.hidden = picking || !connected;
		banner.hidden = picking || !ended;
		// One way in is enough: while the banner is up it carries the links.
		actions.hidden = ended;
		// Nothing to go back to until a session is already connected.
		pickerBack.hidden = !connected;

		// Hiding the editor already puts the text out of reach when nothing is connected; disabling
		// it says so outright, so a note can never take keystrokes it has no session to file under.
		notes.disabled = ended || !connected;
		notes.title = ended ? 'This session is no longer running' : '';

		statusText.textContent = current.dirty
			? 'Unsaved'
			: current.updatedAt
				? 'Saved ' + formatTime(current.updatedAt)
				: 'Not saved yet';
		fileName.textContent = current.fileName || '';
		fileName.title = current.session ? 'Session ' + current.session.id : '';
	}

	/** @param {{ replaceText: boolean, text: string }} state */
	function applyText(state) {
		// Only replace the textarea when the host says the text changed underneath us; otherwise
		// every autosave would move the caret to the end of the note.
		if (!state.replaceText || notes.value === state.text) {
			return;
		}
		const atEnd = notes.selectionStart === notes.value.length;
		const start = notes.selectionStart;
		const end = notes.selectionEnd;
		notes.value = state.text;
		if (!atEnd) {
			notes.setSelectionRange(Math.min(start, state.text.length), Math.min(end, state.text.length));
		}
	}

	function renderList() {
		const query = search.value.trim().toLowerCase();
		const bound = current && current.session ? current.session.id : null;
		// Notes cannot be filed under a session that has ended, and "continue in" means somewhere
		// work carries on, so that mode offers running sessions only.
		const offered = pickerMode === 'continue' ? sessions.filter(s => s.live) : sessions;
		const rows = offered
			.filter(s => !query || s.label.toLowerCase().indexOf(query) >= 0 || s.id.indexOf(query) >= 0)
			.map(s => makeRow(s, s.id === bound));
		if (rows.length === 0) {
			const none = document.createElement('div');
			none.className = 'row-none';
			none.textContent = offered.length === 0
				? pickerMode === 'continue'
					? 'No running Claude sessions to continue in'
					: 'No Claude sessions found for this folder'
				: 'No session matches "' + search.value.trim() + '"';
			list.replaceChildren(none);
			return;
		}
		list.replaceChildren(...rows);
	}

	/**
	 * @param {{id: string, label: string, live: boolean, lastActivity?: number, pid?: number}} session
	 * @param {boolean} isBound
	 */
	function makeRow(session, isBound) {
		const row = document.createElement('div');
		// Sessions that are not running are dimmed. The host already sorted them to the bottom.
		row.className = 'row' + (session.live ? '' : ' dim') + (isBound ? ' bound' : '');
		row.dataset.id = session.id;
		row.setAttribute('role', 'option');
		row.tabIndex = 0;

		const title = document.createElement('div');
		title.className = 'row-title';
		// textContent, never innerHTML: a title is whatever was typed into that session.
		title.textContent = session.label;

		const meta = document.createElement('div');
		meta.className = 'row-meta';
		for (const bit of [formatAge(session.lastActivity), session.id.slice(0, 8),
			session.pid ? 'pid ' + session.pid : '']) {
			if (!bit) {
				continue;
			}
			const span = document.createElement('span');
			span.textContent = bit;
			meta.appendChild(span);
		}

		row.append(title, meta);
		row.addEventListener('click', () => select(session.id));
		row.addEventListener('keydown', event => {
			if (event.key === 'Enter' || event.key === ' ') {
				event.preventDefault();
				select(session.id);
			}
		});
		return row;
	}

	/** @param {number|undefined} at */
	function formatAge(at) {
		if (!at) {
			return '';
		}
		const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
		if (seconds < 60) {
			return seconds + 's ago';
		}
		const minutes = Math.round(seconds / 60);
		if (minutes < 60) {
			return minutes + 'm ago';
		}
		const hours = Math.round(minutes / 60);
		return hours < 24 ? hours + 'h ago' : Math.round(hours / 24) + 'd ago';
	}

	/** @param {string} iso */
	function formatTime(iso) {
		const date = new Date(iso);
		if (Number.isNaN(date.getTime())) {
			return iso;
		}
		const today = new Date();
		const sameDay =
			date.getFullYear() === today.getFullYear() &&
			date.getMonth() === today.getMonth() &&
			date.getDate() === today.getDate();
		const time = String(date.getHours()).padStart(2, '0') + ':' + String(date.getMinutes()).padStart(2, '0');
		if (sameDay) {
			return time;
		}
		return String(date.getDate()).padStart(2, '0') + '.' + String(date.getMonth() + 1).padStart(2, '0') + ' ' + time;
	}

	vscode.postMessage({ type: 'ready' });
})();
