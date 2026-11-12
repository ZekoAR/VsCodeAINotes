# ClaudeCodeNotes AGENTS-archive.md

Text removed from `AGENTS.md` on 2026-11-10 (owner order: shrink the rules). Not imported.

## General rules not yet in the master (all now in the master: `performance.md` and `gates.md`)

Kept here until they are added to the master's topic files.

- **Prefer the parallel/amortized shape by default:** batch, reuse scratch buffers, upload or process
  what is used rather than what is allocated, bake static work once. These are defaults, not
  optimizations to defer.
- **Before you write a sweep, ask whether the quantity you are sweeping can reach the output at all.**
- **If you cannot reproduce a written-down number, do not report "close enough" and do not skip the row.**
- **Some things do not reproduce byte for byte** - anything ordered by concurrent scheduling rather than
  by the data. Switch them off for any comparison that is not about them.
