// @ts-check
(function () {
	'use strict';

	const vscode = acquireVsCodeApi();

	const newButton = /** @type {HTMLButtonElement} */ (document.getElementById('new'));
	const rows = /** @type {HTMLElement} */ (document.getElementById('rows'));

	/** @type {Array<{id: string, label: string, live: boolean, lastActivity?: number, pid?: number, hasNote: boolean}>} */
	let sessions = [];

	newButton.addEventListener('click', () => vscode.postMessage({ type: 'newNote' }));

	window.addEventListener('message', event => {
		const message = event.data;
		if (message && message.type === 'rows') {
			sessions = message.rows || [];
			render();
		}
	});

	function render() {
		if (sessions.length === 0) {
			const none = document.createElement('div');
			none.className = 'row-none';
			none.textContent = 'No Claude sessions running in this folder';
			rows.replaceChildren(none);
			return;
		}
		rows.replaceChildren(...sessions.map(makeRow));
	}

	/** @param {{id: string, label: string, live: boolean, lastActivity?: number, pid?: number, hasNote: boolean}} session */
	function makeRow(session) {
		const row = document.createElement('div');
		// Sessions that are not running are dimmed. They are only listed at all because they
		// already have a note, which would otherwise be unreachable.
		row.className = 'row' + (session.live ? '' : ' dim') + (session.hasNote ? ' noted' : '');
		row.dataset.id = session.id;
		row.setAttribute('role', 'option');
		row.tabIndex = 0;
		row.title = session.hasNote
			? 'Double-click to open these notes'
			: 'Double-click to start notes for this session';

		const title = document.createElement('div');
		title.className = 'row-title';
		// textContent, never innerHTML: a title is whatever was typed into that session.
		title.textContent = session.label;

		const meta = document.createElement('div');
		meta.className = 'row-meta';
		const bits = [formatAge(session.lastActivity), session.id.slice(0, 8)];
		if (session.pid) {
			bits.push('pid ' + session.pid);
		}
		if (session.hasNote) {
			bits.push('has notes');
		}
		for (const bit of bits) {
			if (!bit) {
				continue;
			}
			const span = document.createElement('span');
			span.textContent = bit;
			meta.appendChild(span);
		}

		row.append(title, meta);
		row.addEventListener('dblclick', () => open(session.id));
		row.addEventListener('keydown', event => {
			if (event.key === 'Enter' || event.key === ' ') {
				event.preventDefault();
				open(session.id);
			}
		});
		return row;
	}

	/** @param {string} id */
	function open(id) {
		vscode.postMessage({ type: 'openSession', sessionId: id });
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

	vscode.postMessage({ type: 'ready' });
})();
