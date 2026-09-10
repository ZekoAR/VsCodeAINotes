# AI Notes

Notes that live **inside** the Claude Code tab they belong to, stored in a dot-file in the workspace.

One note per Claude session. Open a Claude Code tab, press the small `n` button in its bottom-left
corner, and a note panel opens in the lower part of that tab. The note is bound to the session in
that tab, not to the window or the file you were looking at.

## What it does

- **The note is part of the Claude tab.** Not a side-bar view, not a separate editor tab. Opening the
  panel makes Claude's own content *shrink* to make room rather than being covered, so both are
  usable at once. Drag the splitter at the top of the panel to resize it; the height is remembered
  per session, so the next time that session's tab is open the panel comes back the size you left it.
- **The button says whether there is anything in there.** A rounded square with a lowercase `n` when
  the session has no note, a bold capital `N` when it does - readable without opening the panel.
- **Autosave**, 800 ms after you stop typing. The footer under the note reads `typing…`, `saving…`,
  then `saved 09:14:22`. Only a failure is coloured; everything else stays muted, because saving is
  the expected case and should not compete with the note for attention.
- **The footer shows the session's messaging address** - `ainotes-2f`, the same name Claude quotes
  when you ask it how another session can reach it. It reads `not running` when the session's process
  has gone, because that name belongs to the process and stops existing with it.
- **The side panel** in the activity bar shows the state of the injection and lists the Claude Code
  tabs currently open. **Double-click** a row to focus that tab; it flashes orange three times so you
  can see which one it was. Two tabs whose sessions share a title are told apart by position, so each
  row still reaches its own tab. The hamburger button at the bottom reveals **Patch VS Code** and
  **Un-patch VS Code**.
- **A note edited elsewhere reaches the panel.** Editing `.ainotes.json` by hand reloads any panel
  showing that note. Text you have typed but not yet saved is never overwritten by an incoming
  update, and it is re-sent automatically if the panel reconnects.

## Why it patches VS Code

This is the part worth understanding before installing it, because it modifies your VS Code
installation.

There is no supported way to put anything inside another extension's tab, and every route was tried:

- `contributes.menus` only reaches menu locations VS Code itself defines, or views the extension
  registers. There is no contribution point that reaches into a webview owned by a different
  extension.
- Claude Code's tab is a webview, which VS Code renders in an iframe with its own
  `vscode-webview://` origin specifically so extensions cannot reach each other's content. That is a
  same-origin-policy wall, not a missing API, so nothing gets inside that frame.
- A companion editor group underneath the tab does not follow it. Editor groups are independent of
  tab identity, and VS Code exposes no event or API to make one chase another, so dragging the Claude
  tab anywhere would leave the notes behind.

What *does* work: VS Code parks every webview in a top-level overlay container and glues it over the
editor with CSS anchor positioning. A panel added to that container is positioned by VS Code's own
layout, so it tracks the tab through splits, drags between groups and resizes with no code of ours
involved. Reaching that container needs a script running in the workbench, and the only way in is to
add a `<script>` tag to VS Code's `workbench.html`.

**Two consequences, both real:**

- VS Code checksums its own files and will eventually show **"Your Code installation appears to be
  corrupt"**. Nothing is broken; the banner has a *Don't Show Again* on its gear. Anyone running a
  custom CSS/JS loader lives with the same one.
- Every VS Code update installs a fresh app directory, which does not contain the patch. The side
  panel notices and offers to re-apply it.

**Un-patch VS Code** reverses it completely: the injected tag is removed and the two payload files are
deleted, leaving `workbench.html` byte-identical to how it started.

## Activating it

1. Open the **AI Notes** view in the activity bar.
2. If the banner says *Click here to activate in vscode. Requires restart.*, press it - or open the
   hamburger menu and press **Patch VS Code**.
3. **Restart VS Code fully.** A window reload is not enough: `workbench.html` is only read when the
   window's document loads.

The view must be opened at least once per window, because it is the road between the panels and the
notes file (see below). A panel that cannot find it says so rather than sitting blank.

### Keeping the injection current

The injected payload carries a **revision**: a hash of the two files the extension ships, stamped into
the copy when it is installed. On every connection the payload reports it, and the extension compares
it against what it currently ships.

- **Match** - nothing to do.
- **Mismatch** - the side panel and every open note panel show *You Must Update The Injected Script -
  Click here*, with both revisions underneath. Pressing it re-runs the injector, then asks for a
  restart. A stale panel deliberately shows no note at all: displaying one would look like it worked
  while running code the extension did not ship.
- **No revision at all** - treated as current. That is the development case, where a payload was
  copied in by hand or by a build that predates stamping, and enforcing a version there would mean
  re-running the injector after every edit just to be allowed to test.

A content hash rather than a version number on purpose: a hand-maintained version only changes when
someone remembers to change it, and a stale payload reporting a perfectly correct version is exactly
the failure this is meant to catch.

**What is installed is deliberately small.** Only two files are copied into VS Code:
`media/ainotes-inject.js`, the script that runs in the workbench, and `media/ainotes-ui.html`, which
is a **loader** - a framed page that draws nothing of its own. The note pane it shows lives in
`media/pane` (`pane.css`, `pane.html`, `pane.js`), stays in the extension, and is **pushed to the
loader at runtime** over the same road the notes travel. So the revision above is a hash of those two
installed files only, and changing how the pane looks or behaves does not move it: update the
extension, restart VS Code, and the new pane is there with no re-patching.

That works because of one asymmetry. The workbench document allows no inline script and refuses every
HTML sink through Trusted Types; the framed page has no CSP at all - it declares none and VS Code adds
none to a file it serves - so markup and a script element there are exactly what they look like. The
loader is where the pane can be delivered as text.

The loader declares what it can run and the extension declares what its pane needs. A loader older
than the pane gets the same *You Must Update The Injected Script* offer as a stale payload, rather than
a pane that silently never appears.

## How it fits together

The panel is a page of our own framed inside the Claude tab. It has no access to the extension host
and none to the filesystem - the workbench renderer is sandboxed, so there is no `fs`, and the File
System Access API is present but refuses the grant. Every read and write therefore travels:

```
note panel  --postMessage-->  injected script      (same origin)
            --postMessage-->  AI Notes side panel  (a real webview)
            --acquireVsCodeApi-->  extension host  --> .ainotes.json
```

and back the same way. Three things follow from that shape:

- **The side panel's webview is the relay**, so it is kept alive while hidden. Without that, selecting
  any other view container would dispose it and every note panel would go silent.
- **It is event driven, not request/response.** A panel announces itself; it is sent its note when the
  other side is ready. There are no timeouts and no deadlines to miss, so start-up order does not
  matter - whichever side comes up last triggers the sync.
- **A closed and reopened Claude tab recovers on its own.** A one-second sweep drops panels whose tab
  has gone, rebuilds any container VS Code emptied, and keeps announcing anything not yet connected.
- **An editor moved into its own window keeps its panel.** *Move Editor into New Window* is not a
  second workbench: VS Code opens it as `window.open("about:blank")`, so it loads no HTML and no
  script tag of ours can be in it - and it copies the workbench's CSP across with `script-src`
  rewritten to `'none'`, so none ever could. It also replaces that window's `document.createElement`
  with a function that throws, deliberately, so `instanceof` keeps working across windows. So the
  script stays in the main window and drives the other one: it learns of each window as it is opened,
  sweeps its document too, and creates every element with the main document, which the other window
  adopts on append. Those panels relay through the side panel in the main window, because an
  auxiliary window has no sidebar of its own.

## The notes file

`.ainotes.json` in the workspace root (configurable). It is written whole, through a sibling temp file
and a rename, so a crash mid-write cannot leave a half-written file where the notes used to be.

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

A **version 1** file, which held one note with its fields at the top level, migrates into the array on
first read. Nothing is discarded, including a file that has been hand-edited into something that is
not valid JSON at all - its contents become the text of a note rather than being dropped.

A note is created on the first save, not when a panel opens, so glancing at a session never adds an
empty row to the file.

`.ainotes.json` is git-ignored by default: it is per-developer state, not a deliverable. Remove the
entry from `.gitignore` if you want the notes committed.

Panel heights are **not** in this file. They are per-machine view state, kept in VS Code's workspace
storage, because a window size has no business turning up in a diff.

## How sessions are found

Two sources, because they answer different questions:

| Source | Answers | Gives |
| --- | --- | --- |
| `~/.claude/sessions/<pid>.json` | what is **running now** | session id, cwd, pid, start time, and the session's **name** (`ainotes-2f`) |
| `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl` | what has **ever run** in this folder | session id, last activity, the session's **title**, and the first prompt the human typed |

A session counts as live only when a process with its pid is still running - a registry file outlives
its process, so without that check the list would show ghosts.

### Two different names

The **registry name** (`ainotes-2f`, `zod-ea`) belongs to a **process**, and it is the address used for
cross-session messaging. Restarting Claude under the same session id produces a different one: session
`d79fa84e-…` was `ainotes-cb` one hour and `ainotes-b0` the next. It is read fresh every time and
never cached, because a remembered one is the address of a process that has gone. This is what the
note panel's footer shows.

The **title** belongs to the session. Claude Code writes an `ai-title` record into the transcript once
the topic is clear and rewrites it as the topic moves, and a `custom-title` record when the session is
renamed by hand. It survives restarts and outlives the session, and a rename beats the generated title
- the same precedence Claude Code's own extension uses.

Titles are read from the last 512 KB of the transcript rather than by parsing the whole file. Measured
on transcripts up to 14.4 MB, the last `ai-title` sat between 2.5 KB and 31 KB from the end.

The transcript folder name is the workspace path with every non-alphanumeric character replaced by a
dash (`c:\D\AINotes` becomes `c--D-AINotes`). VS Code and Claude Code do not always agree on the drive
letter's case, so the folder is matched case-insensitively against what is on disk.

### How a panel knows which session it is in

The panel knows which tab it sits in, and nothing more - the Claude webview's own URL carries a
webview id and no session id. So it reports the tab's **caption**, and the extension resolves that:
exact title match first, then a prefix match, then the one session running in this folder.

The prefix match earns its place: VS Code truncates a long tab caption with an ellipsis
(`Claude capabilities over…`) in the label *and* in `aria-label`, with no untruncated copy anywhere in
the DOM, so an exact comparison can never match a long title.

The limit of resolving by caption: **two sessions with the same title resolve to the same session, and
so share one note.** Nothing in the tab API can separate them - a `Tab` carries no id, and a webview
tab's `input` is a `TabInputWebview` whose only member is a `viewType` identical for every Claude
tab - so on that side the caption is genuinely all there is.

In the DOM there *is* more, and it is where the row list comes from. VS Code stamps
`data-resource-name` on every tab from the basename of its editor's resource, and a webview editor's
resource is `webview-panel://webview-panel/webview-${providerId}-${resourceId}`, where `providerId`
is the view type the extension asked for and `resourceId` is a uuid minted per editor. A Claude tab
therefore reads `webview-claudeVSCodePanel-<uuid>`: **unique per tab**, readable while that tab is
inactive, and carrying the same view type the extension matches on.

So the injected script enumerates the Claude tabs itself and hands the list over - key, caption and
active state per tab - and the extension turns each caption into a title and a note and sends rows
back. **Double-clicking a row presses the tab that row names**, by key. Nothing is counted, no text is
matched, and two sessions sharing a title are two rows that focus two different tabs. Three costs, all
deliberate: the list is only as fresh as the one-second sweep, it only exists while the injection is
live (an unpatched window shows the activation banner instead of a list), and its order follows the
DOM rather than the editor API.

That id is also **what a note is bound to**. A panel reports the id of the tab it lives in with every
register and every save, and the extension gives each distinct tab its own distinct session out of the
candidates the caption offers. So two sessions called *Fix the build* are two tabs with two notes,
where before the lookup found two answers, refused to choose, and left both panels reporting *no
session matches*. A claim outlives the caption that made it - a session renamed mid-flight keeps its
note - and is released when that tab closes, freeing the session for a tab that reopens it.

What the key is *not* is the Claude session id. That is not anywhere in the workbench DOM: it lives
inside the Claude webview's own page, which is another origin, and in Claude's session files, which
only the extension host can read - and Claude Code's extension exports nothing (`module.exports` is
`{activate, deactivate}`), so its own session-to-panel map cannot be asked either. Nor can
`data-resource-name` be read from the extension host, which is why the list is sourced from the DOM
rather than from `vscode.window.tabGroups`. The caption remains how a session is *found* the first
time; the tab id is what the binding is *kept* under.

## Commands

| Command | Does |
| --- | --- |
| `AI Notes: Save Notes Now` | Flushes pending keystrokes to disk |
| `AI Notes: Open Notes File` | Opens `.ainotes.json` in an editor tab |

## Settings

| Setting | Default | Does |
| --- | --- | --- |
| `ainotes.storeFileName` | `.ainotes.json` | Name of the dot-file, relative to the workspace root |
| `ainotes.autosaveDelayMs` | `800` | Idle time after the last keystroke before writing |
| `ainotes.sessionHistoryLimit` | `25` | How many past sessions are considered when resolving a tab caption |
| `ainotes.claudeHome` | `""` | Override the scanned Claude home. Empty means `$CLAUDE_CONFIG_DIR`, else `~/.claude` |

## Developing

```
npm install
npm run compile      # or: npm run watch
```

Then press `F5` ("Run Extension") to launch an Extension Development Host.

The injected payload is `media/ainotes-inject.js` (the script that runs in the workbench) and
`media/ainotes-ui.html` (the loader framed inside the Claude tab). Neither is compiled - the patch
copies them in as they are - so after editing either one, press **Patch VS Code** to reinstall them
and restart. The buttons live behind the hamburger menu in the side panel.

Editing the note pane itself - `media/pane/pane.css`, `pane.html`, `pane.js` - needs none of that. It
is pushed from the extension at runtime, so reloading the extension host is enough in the development
window, and a VS Code restart is enough anywhere else.

Both halves log to the console with an `[AI Notes]` prefix: the injected script and the framed page to
the **workbench** developer tools (Help → Toggle Developer Tools), the side panel to its own webview
tools. The extension's side of every exchange goes to the **AI Notes** output channel, which needs no
developer tools at all.

`build.cmd` does the same from a shell, and `build.cmd --install` additionally packages
`dist/ainotes-<version>.vsix` and installs it with `code --install-extension --force`. Reload the
window afterwards to pick it up.

## Install

```
.\build.cmd --install
```

This builds the .vsix file and installs it locally. Then patch and restart, as above.
