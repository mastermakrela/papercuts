# papercuts

**[mastermakrela.github.io/papercuts](https://mastermakrela.github.io/papercuts/)**

Log the small friction coding agents hit while working — a tool call that missed and
had to be retried, a confusing setup step, a flaky command, a stale cache, a
misleading error — so it stops being invisible. None of it is blocking, which is
exactly why it never gets written down; logged together it shows where a repo (or
your global setup) needs sanding down.

Every papercut lands in two places:

- **`PAPERCUTS.md`** at the repo's main worktree root — the human-readable, per-repo
  signal. Worktree-safe: logged from a linked worktree, it still lands in the main
  worktree's file (resolved via `git rev-parse --git-common-dir`), so it survives the
  worktree being deleted.
- **`~/.claude/papercuts/log.jsonl`** — a global append-only store (repo, branch,
  model, date, source) for querying friction *across* projects. In practice most
  papercuts turn out to be shared global-setup issues, not per-project ones.
  Single-line appends under `O_APPEND` are atomic, so parallel agent sessions can't
  interleave.

`PAPERCUTS.md` is local-only and should be gitignored, including in this repo. It is
your friction log, not repo content. The entries shown on
[the site](https://mastermakrela.github.io/papercuts/) were logged while building this
tool.

## The three commands

| Command | What it does |
| --- | --- |
| `papercut -m <model> "message"` | Log one papercut from the current directory's repo. Agents call this in the moment, per an instruction in your global `CLAUDE.md`. |
| `papercut-review` | Mine the *whole current session* for papercuts at once: finds the newest Claude Code transcript for the cwd, feeds it to Haiku via `claude -p --model haiku` (no separate API key needed), appends what it finds. Wired up as the `/papercut` slash command. |
| `papercuts` | Query the global store: `--repo <substr>`, `--grep <substr>`, `--since`/`--until`/`--year`, `--list` (full text, with ids), `--json`. No flags prints tallies by repo, model, and date — open papercuts only, plus a "possible regressions" section (see below). `--all` includes resolved entries, `--resolved` shows only them. |
| `papercuts resolve` | Mark papercuts as addressed: `papercuts resolve <id>... -m "what fixed it"` or `papercuts resolve --grep <substr> [--repo R] [--until YYYY-MM-DD] -m "what fixed it"` (`-n` previews). `papercuts unresolve <id>...` reopens. |

## Resolving papercuts

A friction log is only useful if it shrinks when you sand something down. Once a
fix is in place:

```
papercuts resolve --grep "paraglide" --repo wirtgen --until 2026-08-20 \
  -m "apps/web prepare script now runs paraglide-js compile"
```

- Resolutions are append-only records in `~/.claude/papercuts/resolutions.jsonl`
  (next to the log; a `PAPERCUTS_LOG` override redirects both). Entries are
  identified by a stable 8-char id derived from the record itself, so the existing
  store needs no migration. `--list` and `--json` print the ids.
- `--grep` resolutions store the pattern. A later papercut matching that pattern is
  evidence the fix did not take: `papercut` prints a hint when logging one, and the
  report lists them under "possible regressions". `--until` says "fixed by that date"
  so only newer entries count; without it, newer-than-the-resolution counts.
- Resolved entries are removed from the affected repos' `PAPERCUTS.md` (exact message
  match; `--keep-md` skips that). The global store keeps everything.
- `papercuts unresolve <id>...` reopens entries (the markdown lines are not restored).
- A pattern starting with a dash needs the `=` form: `--grep=--attach`.

## Setup

Requirements: [Bun](https://bun.sh) on your PATH. The session-review command
additionally assumes [Claude Code](https://claude.com/claude-code) (it reads Claude
Code transcripts and shells out to `claude -p`); `papercut` and `papercuts` work with
any agent that can run a shell command.

There's nothing to build or install — the scripts run via their `#!/usr/bin/env bun`
shebang, straight from the clone. Paste this into Claude Code:

```text
Set up the papercuts tool (https://github.com/mastermakrela/papercuts) for me:

1. Clone the repo to a permanent location (suggest ~/Scripts/papercuts unless I say
   otherwise). If it's already cloned, use that clone.
2. Symlink the three scripts into ~/.local/bin (mkdir -p it, and warn me if it's not
   on my PATH):
   ln -s <clone>/log.ts    ~/.local/bin/papercut
   ln -s <clone>/report.ts ~/.local/bin/papercuts
   ln -s <clone>/review.ts ~/.local/bin/papercut-review
3. Install the /papercut slash command: copy install/SKILL.md to
   ~/.claude/skills/papercut/SKILL.md (create the directory).
4. Append the contents of install/claude-md-snippet.md as a new section of my global
   ~/.claude/CLAUDE.md — this is what tells agents to log papercuts proactively.
   Skip this step if I already have a "Log papercuts" section; ask before rewording
   anything that's already there.
5. Add a global gitignore rule so my friction logs never get committed anywhere:
   append PAPERCUTS.md to the file named by `git config --get core.excludesfile`
   (default ~/.config/git/ignore; create it and point core.excludesfile at it if it
   is not set yet).
6. Verify: `command -v papercut`, then in some scratch git repo run
   `papercut -m setup-test "papercuts installed"` and show me the PAPERCUTS.md line,
   the matching line in ~/.claude/papercuts/log.jsonl, and that `git status` in that
   repo does NOT list PAPERCUTS.md.
```

Manual setup is the same thing by hand: clone, the three symlinks,
`install/SKILL.md` → `~/.claude/skills/papercut/`, and the
`install/claude-md-snippet.md` section into `~/.claude/CLAUDE.md`.

## Notes

- The global store location can be overridden with `PAPERCUTS_LOG`.
- The commands are symlinks to the scripts themselves — real PATH executables rather
  than shell aliases on purpose, because aliases are unreliable in non-interactive
  agent tool shells.
- `/papercut` is deliberately user-triggered only (`disable-model-invocation: true`);
  in-the-moment `papercut` calls are the proactive path.
- The setup prompt tells your agent to keep `PAPERCUTS.md` out of version control, so
  a friction log never turns into a diff someone has to review.
- `PAPERCUTS.md` is distinct from a changelog (what was accomplished) and from your
  issue tracker (real bugs / tracked work). Papercuts are the stuff too small for
  either.
- For development: `bun install` pulls in `@types/bun` for typechecking; nothing is
  needed at runtime.

## License

[MIT](LICENSE)
