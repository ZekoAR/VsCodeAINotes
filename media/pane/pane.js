// The note pane's behaviour, pushed from the extension into the framed page and run there.
//
// It runs in the framed document, which has no CSP of its own, so this is an ordinary inline script
// once the loader appends it. It is NOT part of the payload copied into the VS Code install, so
// changing it takes effect on the next VS Code start without re-patching anything.
(function () {
	'use strict';

	// Matches the extension's own `ainotes.autosaveDelayMs` default, so a note typed here and a note
	// typed in the editor settle at the same pace.
	const SAVE_DELAY_MS = 800;

	const els = {
		session: document.getElementById('session'),
		status: document.getElementById('status'),
		text: document.getElementById('text'),
		box: document.getElementById('box'),
		pick: document.getElementById('pick'),
		sessions: document.getElementById('sessions'),
		list: document.getElementById('sessions-list'),
		close: document.getElementById('sessions-close')
	};

	let saveTimer;
	/** Set while a push writes into the textarea, so arriving text is not itself an edit. */
	let loading = false;
	/**
	 * The text last handed to the host, or null before anything has arrived.
	 *
	 * The field is locally modified exactly when its value differs from this - which stays true for
	 * anything typed while a save was in flight. The flag this replaces was cleared by the save's
	 * acknowledgement, which declared the field settled while newer keystrokes were sitting in it,
	 * and the next push then overwrote them.
	 */
	let lastSent = null;

	function status(text, kind) {
		els.status.textContent = text;
		els.status.className = kind || '';
	}

	// Handed to this frame in its url by the script that built it, and returned on every message so
	// the host can route the answer without relying on window identity.
	const panel = new URLSearchParams(location.search).get('panel');

	function ask(kind, extra) {
		const message = { source: 'ainotes-ui', panel: panel, kind: kind };
		if (extra) {
			for (const name of Object.keys(extra)) {
				message[name] = extra[name];
			}
		}
		parent.postMessage(message, '*');
	}

	els.text.addEventListener('input', () => {
		if (loading) {
			return;
		}
		status('');
		clearTimeout(saveTimer);
		saveTimer = setTimeout(() => {
			// Fire and forget. Nothing comes back on success, so nothing can arrive and declare the
			// field settled while it is still being typed into.
			lastSent = els.text.value;
			ask('save', { text: lastSent });
		}, SAVE_DELAY_MS);
	});

	// ------------------------------------------------------------------ the session picker

	/** Whether the picker is showing, so an arriving note does not close it under the reader. */
	let picking = false;

	/**
	 * Open or close the picker.
	 *
	 * The list is asked for on every open rather than cached: sessions start and stop while a tab
	 * sits there, and a remembered list is exactly the stale thing this picker exists to escape.
	 */
	function setPicking(open) {
		picking = open;
		els.sessions.hidden = !open;
		if (!open) {
			return;
		}
		message('Looking for running sessions...');
		ask('sessions');
		// Focus moves into the list as it opens, not when the reader gets there with the mouse: the
		// escape and arrow keys are handled on the picker, and a key pressed while focus was still on
		// the link that opened it would reach nothing at all.
		els.list.focus();
	}

	/** A line in place of the rows - looking, empty, or a reason. Never a row, so nothing to click. */
	function message(text) {
		const line = document.createElement('div');
		line.className = 'empty';
		line.textContent = text;
		els.list.replaceChildren(line);
	}

	/**
	 * Draw the rows the extension sent.
	 *
	 * Built with `createElement` and `textContent` throughout. The labels are session titles and
	 * prompts - text a human typed, arriving from another process - and this document has no CSP to
	 * fall back on, so none of it is ever handed to an HTML sink.
	 */
	function showSessions(sessions) {
		if (!picking) {
			return;
		}
		const rows = Array.isArray(sessions) ? sessions : [];
		if (rows.length === 0) {
			message('No Claude session is running in this folder.');
			return;
		}
		const out = [];
		for (const session of rows) {
			if (!session || typeof session.id !== 'string') {
				continue;
			}
			const row = document.createElement('button');
			row.type = 'button';
			row.className = 'session-row';
			row.setAttribute('role', 'option');
			row.dataset.id = session.id;

			const label = document.createElement('span');
			label.className = 'row-label';
			label.textContent = session.label || session.id.slice(0, 8);
			row.appendChild(label);

			// What is left to choose by when two sessions carry the same title, and the answer to
			// "which one is this note going into": the address the footer shows, how long ago the
			// session last wrote anything, and whether it has notes for this text to be added to.
			const parts = [];
			if (session.agent) {
				parts.push(session.agent);
			}
			if (session.age) {
				parts.push(session.age);
			}
			if (session.hasNote) {
				parts.push('has notes');
			}
			if (session.current) {
				parts.push('this panel');
			}
			if (parts.length > 0) {
				const detail = document.createElement('span');
				detail.className = 'row-detail';
				detail.textContent = parts.join(' · ');
				row.appendChild(detail);
			}
			out.push(row);
		}
		if (out.length === 0) {
			message('No Claude session is running in this folder.');
			return;
		}
		els.list.replaceChildren.apply(els.list, out);
		// The rows arrive a moment after the picker opens, so the focus put on the list then has
		// nothing to land on yet. Moved to the first row once there is one, which makes Enter pick the
		// session listed first - the one running here that wrote most recently. Only ever while focus
		// is still inside the picker: the reader may have clicked back into the note while waiting.
		if (els.sessions.contains(document.activeElement)) {
			out[0].focus();
		}
	}

	/**
	 * Link this panel to the session that was picked, and take the text along.
	 *
	 * `lastSent` moves to what is on screen before the request goes out, because the request carries
	 * it: the host has this text now. Without that the note it sends back - the target's notes with
	 * this text already merged into them - would look older than the field and be dropped, and the
	 * field would then be saved over the merge.
	 */
	function choose(sessionId) {
		clearTimeout(saveTimer);
		lastSent = els.text.value;
		ask('pick', { sessionId: sessionId, text: lastSent });
		setPicking(false);
		status('linking...');
	}

	els.pick.addEventListener('click', event => {
		event.preventDefault();
		setPicking(!picking);
	});

	els.close.addEventListener('click', event => {
		event.preventDefault();
		setPicking(false);
	});

	// Enter and space on the two links. They are anchors with a role rather than buttons, so the
	// keyboard activation a button gets for free has to be spelled out here.
	for (const link of [els.pick, els.close]) {
		link.addEventListener('keydown', event => {
			if (event.key === 'Enter' || event.key === ' ') {
				event.preventDefault();
				link.click();
			}
		});
	}

	els.list.addEventListener('click', event => {
		const row = event.target.closest ? event.target.closest('.session-row') : null;
		if (row && row.dataset.id) {
			choose(row.dataset.id);
		}
	});

	// Escape closes the picker from anywhere in it, and the arrows walk the rows. A list you can only
	// leave with the mouse is the wrong thing to put over a text field.
	els.sessions.addEventListener('keydown', event => {
		if (event.key === 'Escape') {
			event.preventDefault();
			setPicking(false);
			els.text.focus();
			return;
		}
		if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') {
			return;
		}
		const rows = [].slice.call(els.list.querySelectorAll('.session-row'));
		if (rows.length === 0) {
			return;
		}
		event.preventDefault();
		const at = rows.indexOf(document.activeElement);
		const step = event.key === 'ArrowDown' ? 1 : -1;
		const next = at < 0 ? (step > 0 ? 0 : rows.length - 1) : (at + step + rows.length) % rows.length;
		rows[next].focus();
	});

	// ------------------------------------------------------------------ the host

	function onMessage(event) {
		const data = event.data;
		if (!data || data.source !== 'ainotes-host') {
			return;
		}
		if (data.kind === 'notes') {
			// Whatever the host sends, whenever it sends it. Nothing is awaited here, so there is no
			// deadline to miss and nothing to retry - a note that arrives late, or again because it
			// changed elsewhere, is handled by the same path.
			const incoming = data.text || '';
			// Locally modified means the field differs from what was last sent. Anything arriving
			// then is older than what is on screen, so it is dropped rather than applied - this is
			// the guard that stops a push eating keystrokes.
			const modified = lastSent !== null && els.text.value !== lastSent;
			if (!modified && incoming !== els.text.value) {
				loading = true;
				els.text.value = incoming;
				loading = false;
				lastSent = incoming;
			} else if (lastSent === null) {
				lastSent = els.text.value;
			}
			els.text.disabled = false;
			// The messaging address, not the session uuid: this is the name Claude quotes when asked
			// how to reach it, so it is the one worth being able to read off the panel. It exists
			// only while the process does, hence the fallback rather than a stale one.
			els.session.textContent = data.agent || 'not running';
			// No address means this note belongs to a session that is not running any more: its text
			// is history, the field is read-only, and picking another session is the way out.
			els.pick.hidden = Boolean(data.agent);
			if (modified) {
				// Reconnected holding text the host has not seen. Sent again, still without waiting
				// for anything back.
				lastSent = els.text.value;
				ask('save', { text: lastSent });
			}
			return;
		}
		if (data.kind === 'sessions') {
			showSessions(data.sessions);
			return;
		}
		if (data.kind === 'error') {
			// Only locked when there is nothing at risk. Text typed but not yet accepted stays
			// editable: it survives here, the `lastSent` comparison protects it from being
			// overwritten, and it is re-sent when the panel reconnects. Disabling mid-sentence would
			// strand the reader for a condition that recovers on its own.
			els.text.disabled = lastSent !== null && els.text.value === lastSent;
			els.session.textContent = 'not connected';
			// Attached to nothing at all, which is the other state the picker is the remedy for.
			els.pick.hidden = false;
			// Not final: the host keeps announcing this panel, so a session that becomes resolvable
			// later arrives as a `notes` event with nothing pressed here.
			status(data.problem || 'failed', 'bad');
			if (picking) {
				// The list was asked for and this came back instead. Said where it was asked for,
				// rather than leaving "Looking for running sessions..." on screen for good.
				message(data.problem || 'AI Notes could not reach the extension.');
			}
		}
	}

	// A pane pushed again - the extension updated while this frame stayed open - must replace the
	// one running, not join it. Two listeners would mean two saves per keystroke.
	if (typeof window.ainotesPaneDispose === 'function') {
		window.ainotesPaneDispose();
	}
	window.addEventListener('message', onMessage);
	window.ainotesPaneDispose = function () {
		window.removeEventListener('message', onMessage);
		clearTimeout(saveTimer);
	};

	// Say we exist. The loader said it first, for itself; this says the pane is running and is what
	// brings the note. The host announces this panel until the notes arrive, so there is nothing to
	// retry from here and no deadline to arm.
	status('connecting...');
	ask('ready');
})();
