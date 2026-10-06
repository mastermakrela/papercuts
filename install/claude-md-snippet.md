# Log papercuts

Important! When you hit a small friction while working — a tool call that missed and
had to be retried, a confusing or undocumented setup step, a flaky command, a stale
cache, a misleading error, a non-obvious gotcha — log it to `PAPERCUTS.md` via
`papercut -m <model> "message"` (a real executable on PATH, so it resolves in agent
tool shells too). One or two sentences: what you were doing → what got in the way (a
guess at the cause/fix is a bonus). Do this proactively, in the moment, even though
none of these are blocking — logged together they show where the repo needs sanding
down. This is distinct from a changelog (what you accomplished) and from tracked
issues (real bugs / tracked work).

To mine a whole session for papercuts at once, the `/papercut` slash command runs
`papercut-review`, which feeds the session transcript to Haiku (via
`claude -p --model haiku` — no separate API key needed) and appends what it finds.
This is user-triggered only via `/papercut` — don't run the review yourself
unprompted.

`PAPERCUTS.md` is a local-only file, not repo content. Never stage or commit it, and
never let it ride along in a commit you make for other work. The first time you log a
papercut in a repo, make sure it is ignored: add `PAPERCUTS.md` to the repo's
`.gitignore`, or to `.git/info/exclude` if you would rather not touch a tracked file
(client repos, shared branches). A team that wants a shared friction log can decide to
commit it instead, but that is an explicit choice, not the default.

Papercuts resolve `PAPERCUTS.md` to the repo's main worktree root (via
`git rev-parse --git-common-dir`), never the literal cwd — so papercuts logged from a
linked worktree land in the same file as ones logged from the main worktree, and
survive that worktree's deletion. Outside a git repo it falls back to cwd.

Every papercut ALSO appends to a global append-only store at
`~/.claude/papercuts/log.jsonl` (repo, branch, model, date, source), so friction can
be queried across all projects — most of it turns out to be shared global-setup
issues, not per-project ones. Query it with `papercuts`: `--repo <substr>`,
`--grep <substr>`, `--since/--until/--year`, `--list` (full text, with ids), `--json`.
When I ask what's been going wrong across projects, read this store rather than
grepping individual repos.

The report shows OPEN papercuts only. When a fix for a logged papercut is in place
(a hook changed, a rule documented, a prepare script added), consume it:
`papercuts resolve --grep <substr>... --until <date-the-fix-landed> [--repo R] -m "<what fixed it>"`
(`-n` previews; or `papercuts resolve <id>... -m …` with ids from `--list`/`--compact`).
`PAPERCUTS.md` is regenerated from the store's open entries, so the lines disappear
(and `papercuts unresolve <id>` brings them back); the pattern is stored, so a later
papercut matching it is reported as a possible regression — `papercut` prints a hint
when you log one. Use specific substrings, not generic words. `papercuts sync-md -n`
shows what regenerating a drifted file would change. Only resolve what you verified in
code or config, never on a guess, and never by citing the rule an entry says it already knew about.
