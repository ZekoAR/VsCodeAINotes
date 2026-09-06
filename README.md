# AI Notes

A VS Code panel for writing notes that belong to a specific Claude Code session, stored in a
dot-file in the workspace.

## What it does

- **The notes are an editor tab**, not a side-bar view. Being an editor is what lets you dock them
  above, below or beside any other tab, split them across editor groups, or float them into their
  own window - exactly the way a Claude Code tab docks. The editor area hosts editors and nothing
  else, so a view could never go there. The tab is captioned `Notes: <session title>` once a
  session is connected, and `AI Notes` before that.
- **The panel has four states.** Not connected: a single centred **Select AI Session** button.
  Connected: the notes, with a small **Switch AI Session** link in the textarea's top-right corner.
  Connected but the session has ended: the notes disabled under a banner reading *The connected AI
  session is not running.* with the same link. Picking: a search field and a scrollable list that
  take over the whole panel.
- **The session list lives in the panel**, not in the quick-pick dropdown at the top of the window.
  Each row shows the session's title, its age, the first eight characters of its id and its pid.
  Running sessions come first, most recently active at the top, ties broken alphabetically by
  title; sessions that are not running are dimmed and sorted below them. Typing in the search field
  filters by title or id, `Enter` takes the first match, and `Escape` cancels. A back arrow appears
  in front of the search field only when a session is already connected, since only then is there
  something to go back to.
- **A side panel in the activity bar**: a **New Note Editor** button on top, and below it the Claude
  sessions you can open notes for. **Double-click** a session to open its notes, creating them if
  that session has none yet. It is a webview rather than a tree because the VS Code API has no
  double-click event at all - `TreeItem.command` fires on single-click selection. `Enter` opens the
  focused row too, so it stays keyboard-reachable.
- **One note per session, several notes per workspace.** Opening a session that already has notes
  reveals that tab rather than making a second view of the same text. The side panel lists every
  running session, plus any session that already has notes and is no longer running - dimmed, and
  below the rest, so those notes cannot become unreachable.
- **Autosave** to `.ainotes.json` in the workspace root: each note's text, the session it belongs
  to, and when it was last updated. `Ctrl+S` inside a textarea saves immediately.
- **Read-only once the connected session stops running**, and **editable again the moment it comes
  back**. The notes of a finished session are history, but nothing needs reconnecting: the panel is
  bound to a session *id*, and a resumed session reappears under the same id with a fresh pid. A
  watch on the live-session registry picks both transitions up in about 170 ms, measured. The panel
  also re-checks whenever its tab regains focus, and a 60-second poll is the backstop for a watch
  that never started.

Every tab survives a window reload with its text, its note and its docked position intact.

## The notes file

`.ainotes.json` in the workspace root (configurable). It is written whole, through a temp file and
a rename, so a crash mid-write cannot leave a half-written file where the notes used to be.

```json
{
  "version": 2,
  "notes": [
    {
      "id": "0d6f8e2a-3c4b-4f19-9a77-1b2c3d4e5f60",
      "session": {
        "id": "cd71c47e-bc1d-43eb-8fa4-654d2fb7f013",
        "name": "zod-ea",
        "cwd": "c:\\D\\ArcticRobots\\ZOD",
        "pid": 63672,
        "boundAt": "2026-09-06T13:41:33.469Z"
      },
      "text": "Notes for this session\u2026",
      "updatedAt": "2026-09-06T13:52:10.882Z"
    }
  ]
}
```

A **version 1** file, which held one note with its fields at the top level, migrates into the array
on first read. Nothing is discarded, including a file that has been hand-edited into something that
is not valid JSON at all - its contents become the text of a note rather than being dropped.

The file is watched. Editing it in a normal editor tab reloads the panels, so the two views cannot
silently overwrite each other - unless a panel has unsaved keystrokes, which are newer and win.

`.ainotes.json` is git-ignored by default: it is per-developer state, not a deliverable. Remove the
entry from `.gitignore` if you want the notes committed.

## How sessions are found

Two sources, because they answer different questions:

| Source | Answers | Gives |
| --- | --- | --- |
| `~/.claude/sessions/<pid>.json` | what is **running now** | session id, cwd, pid, start time, and the session's **name** (`zod-ea`) |
| `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl` | what has **ever run** in this folder | session id, last activity, the session's **title**, and the first prompt the human typed |

A session is listed as live only when a process with its pid is still running - a registry file
outlives its process, so without that check the picker lists ghosts.

### Two different names, and why the title wins

A session has two names, and only one of them is worth showing.

The **registry name** (`zod-ea`, `ainotes-b0`) belongs to a **process**. Restarting Claude under the
same session id produces a different one: session `d79fa84e-b5b8-45a8-9aa0-4f9948115545` was
`ainotes-cb` one hour and `ainotes-b0` the next. It is not derivable from the session id either - the
prefix is the folder basename lowercased, but the two-hex suffix matched none of eight candidate
hashes of the id, pid or cwd. It is shown in the picker's detail line, to tell two live sessions on
the same topic apart, and nowhere else.

The **title** belongs to the session. Claude Code writes an `ai-title` record into the transcript
once the topic is clear and rewrites it as the topic moves (`"Shattering Sphere determinism
investigation"`, `"GUI2D editor refinements"`), and a `custom-title` record when the session is
renamed by hand. It survives restarts, and it survives the session exiting. A rename beats the
generated title, which is the same precedence the Claude Code extension itself uses.

So the label everywhere - tab caption, side panel row, session list - is **title, else first prompt,
else short session id**, re-resolved on the 60-second poll.

Titles are read from the last 512 KB of the transcript rather than by parsing the whole file.
Measured on transcripts up to 14.4 MB, the last `ai-title` sat between 2.5 KB and 31 KB from the end.
The window is the one real limit: a `custom-title` written once and then buried under more than
512 KB of later conversation is not found, which is the same failure the official extension has with
its 64 KB window, with eight times the margin.

The transcript folder name is the workspace path with every non-alphanumeric character replaced by
a dash (`c:\D\AINotes` becomes `c--D-AINotes`). VS Code and Claude Code do not always agree on the
drive letter's case, so the folder is matched case-insensitively against what is on disk.

## Commands

| Command | Does |
| --- | --- |
| `AI Notes: New Note Editor` | Opens a new, unconnected note editor |
| `AI Notes: Pick Claude Session` | Connects the note editor that has focus, as a quick-pick. Each editor has its own list; this is for the command palette |
| `AI Notes: Save Notes Now` | Flushes pending keystrokes to disk |
| `AI Notes: Open Notes File` | Opens `.ainotes.json` in an editor tab |

## Settings

| Setting | Default | Does |
| --- | --- | --- |
| `ainotes.storeFileName` | `.ainotes.json` | Name of the dot-file, relative to the workspace root |
| `ainotes.autosaveDelayMs` | `800` | Idle time after the last keystroke before writing |
| `ainotes.sessionHistoryLimit` | `25` | How many past sessions the picker lists below the live ones |
| `ainotes.claudeHome` | `""` | Override the scanned Claude home. Empty means `$CLAUDE_CONFIG_DIR`, else `~/.claude` |

## Developing

```
npm install
npm run compile      # or: npm run watch
```

Then press `F5` ("Run Extension") to launch an Extension Development Host.

`build.cmd` does the same from a shell, and `build.cmd --install` additionally packages
`dist/ainotes-<version>.vsix` and installs it with `code --install-extension --force`. Reload the
window afterwards to pick it up.

Agent rules for this repository are in `AGENTS.md` (not shipped in the .vsix).
