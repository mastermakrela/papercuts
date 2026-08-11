---
name: papercut
description: Mine the current session for papercuts (small friction, not blocking) and log them to PAPERCUTS.md. User-triggered only — never invoke this on your own initiative.
disable-model-invocation: true
---

Run, from the current project directory:

```
papercut-review
```

This locates the most-recently-modified transcript for the current project under
`~/.claude/projects/<encoded-cwd>/`, feeds a condensed rendering of it to Haiku via
`claude -p --model haiku`, and appends whatever papercuts it finds to `PAPERCUTS.md`
at the repo's main worktree root (creating the file if needed) — not the literal cwd,
so this is safe to run from inside a linked git worktree.

Entries also land in the global store (`~/.claude/papercuts/log.jsonl`) automatically,
so no extra step is needed for cross-project reporting.

Report back concisely: how many papercuts were logged (or that none were found).
Do not editorialize or re-review the transcript yourself — the script's model call is
the review.
