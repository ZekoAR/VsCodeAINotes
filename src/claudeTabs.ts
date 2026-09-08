import * as vscode from 'vscode';

/**
 * The view type VS Code reports for a Claude Code chat tab.
 *
 * The extension host prefixes an extension's own view type, so the tab reports
 * `mainThreadWebview-claudeVSCodePanel` rather than the bare name Claude Code registered. A
 * substring test is what Claude Code's own extension uses on these same tabs, for the same reason.
 */
const CLAUDE_VIEW_TYPE = 'claudeVSCodePanel';

/**
 * The session this window is working with, or why that could not be told.
 *
 * One resolution serves three callers - the command, the banner's button and the reconnect a
 * restored tab runs on its own - so they can never disagree about which session is "this one".
 * `problem` is written for a person to read and is only shown when a person asked.
 */
export interface SessionResolution {
	sessionId?: string;
	problem?: string;
}

/** True for a Claude Code session tab, and for nothing else in the editor area. */
export function isClaudeTab(tab: vscode.Tab): boolean {
	return (
		tab.input instanceof vscode.TabInputWebview && tab.input.viewType.includes(CLAUDE_VIEW_TYPE)
	);
}

/**
 * Which Claude Code tab a command should act on.
 *
 * Nothing in the VS Code API maps a tab to the session behind it - `TabInputWebview` carries a view
 * type and nothing else, no uri and no panel handle - so the only identity a Claude tab offers is
 * its caption, and the caption is the session's own title. Resolving that caption to a session is
 * the workspace's job; picking WHICH caption is this one's.
 *
 * `Tab.isActive` is per group, so a Claude tab sitting in its own group stays active while the
 * reader works in a notes editor, and reading the tab list at the moment the command runs is enough.
 * It is not enough when Claude and the notes share a group: only one tab there can be active and it
 * is the notes. The remembered caption covers that case, and is only consulted when the live scan
 * finds none.
 *
 * Two Claude tabs active in two groups is a genuine tie, and it resolves to nothing rather than to
 * whichever came first. The caller falls back to the picker.
 */
export class ClaudeTabTracker implements vscode.Disposable {
	private lastLabel: string | undefined;
	private readonly disposables: vscode.Disposable[] = [];

	constructor() {
		this.remember();
		this.disposables.push(vscode.window.tabGroups.onDidChangeTabs(() => this.remember()));
	}

	/** The caption of the Claude tab to act on, or nothing when that cannot be told. */
	target(): string | undefined {
		const active = activeClaudeTabs();
		if (active.length === 1) {
			return active[0].label;
		}
		return active.length === 0 ? this.lastLabel : undefined;
	}

	/** True when a Claude tab is open at all, which is what separates "none" from "ambiguous". */
	anyOpen(): boolean {
		return vscode.window.tabGroups.all.some(group => group.tabs.some(isClaudeTab));
	}

	private remember(): void {
		const active = activeClaudeTabs();
		if (active.length === 1) {
			this.lastLabel = active[0].label;
		}
	}

	dispose(): void {
		for (const disposable of this.disposables) {
			disposable.dispose();
		}
		this.disposables.length = 0;
	}
}

/** Every Claude tab that is the selected tab of its group. */
function activeClaudeTabs(): vscode.Tab[] {
	const out: vscode.Tab[] = [];
	for (const group of vscode.window.tabGroups.all) {
		for (const tab of group.tabs) {
			if (tab.isActive && isClaudeTab(tab)) {
				out.push(tab);
			}
		}
	}
	return out;
}
