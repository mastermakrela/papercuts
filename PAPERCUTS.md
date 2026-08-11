# Papercuts

Friction encountered while working in this repo — logged in the moment, none of it blocking. See CLAUDE.md → "Log papercuts".

## 2026-08-08

- (opus-5) Building a discovery step with Bun's $ shell: literal glob args like find ... -not -path */node_modules/* get glob-expanded by Bun Shell before reaching find, so the command silently matched nothing instead of erroring. Fix: don't shell out for file walks — use a pruning readdir walk, or pass glob patterns as interpolated variables so they're quoted.

## 2026-08-11

- (fable-5) Publishing the papercuts dir that was cp'd from ~/Scripts/papercut: the copied node_modules had a broken .bin/tsc shim (Cannot find module ../lib/tsc.js), so bunx tsc failed until rm -rf node_modules && bun install. Don't trust a cp'd node_modules — reinstall.
- (fable-5) Removing a function from common.ts: the Edit tool twice failed to match a string that Read/sed verifiably showed on disk (tab-indented block with template literals), and an intermediate grep -n for the same symbol returned nothing; gave up bisecting and rewrote the file with Write.
