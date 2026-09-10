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
		box: document.getElementById('box')
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

	function ask(kind, text) {
		parent.postMessage({ source: 'ainotes-ui', panel, kind, text }, '*');
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
			ask('save', lastSent);
		}, SAVE_DELAY_MS);
	});

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
			if (modified) {
				// Reconnected holding text the host has not seen. Sent again, still without waiting
				// for anything back.
				lastSent = els.text.value;
				ask('save', lastSent);
			}
			return;
		}
		if (data.kind === 'error') {
			// Only locked when there is nothing at risk. Text typed but not yet accepted stays
			// editable: it survives here, the `lastSent` comparison protects it from being
			// overwritten, and it is re-sent when the panel reconnects. Disabling mid-sentence would
			// strand the reader for a condition that recovers on its own.
			els.text.disabled = lastSent !== null && els.text.value === lastSent;
			els.session.textContent = 'not connected';
			// Not final: the host keeps announcing this panel, so a session that becomes resolvable
			// later arrives as a `notes` event with nothing pressed here.
			status(data.problem || 'failed', 'bad');
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
