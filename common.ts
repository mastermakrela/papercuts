import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { $ } from "bun";

export type PapercutEntry = { model: string; message: string };

/** One line of the global JSONL store. */
export type PapercutRecord = {
	ts: string;
	date: string;
	model: string;
	repo: string;
	repoPath: string;
	branch: string | null;
	source: "manual" | "review" | "backfill";
	message: string;
};

/**
 * One line of the resolutions store. A resolution marks entries as addressed; it
 * keeps the `grep` pattern it was made with so later entries matching the same
 * pattern can be surfaced as "the fix did not take". A revocation undoes one.
 */
export type Resolution = {
	ts: string;
	date: string;
	ids: string[];
	note: string;
	grep?: string;
	repo?: string;
	until?: string;
};
export type Revocation = { ts: string; date: string; revokes: string[] };
export type ResolutionRecord = Resolution | Revocation;

/** Append-only global store: every papercut from every repo, for cross-project reporting. */
const GLOBAL_LOG =
	process.env.PAPERCUTS_LOG ?? `${process.env.HOME}/.claude/papercuts/log.jsonl`;
/** Lives next to the log so a PAPERCUTS_LOG override redirects both. */
const RESOLUTIONS_LOG = `${dirname(GLOBAL_LOG)}/resolutions.jsonl`;

export function today(): string {
	return new Intl.DateTimeFormat("en-CA").format(new Date());
}

/**
 * Stable id for a papercut, derived from the record itself so the existing store
 * needs no migration: 8 hex chars of sha1(ts + message).
 */
export function entryId(r: Pick<PapercutRecord, "ts" | "message">): string {
	return createHash("sha1").update(`${r.ts}\n${r.message}`).digest("hex").slice(0, 8);
}

/** Same semantics as `papercuts --grep`: case-insensitive substring. */
export function matchesGrep(message: string, pattern: string): boolean {
	return message.toLowerCase().includes(pattern.toLowerCase());
}

/**
 * Resolves to the repo's main worktree root, not the literal cwd — so a papercut
 * logged from a linked worktree still lands in a file that survives that worktree
 * being deleted. Falls back to `cwd` outside a git repo.
 */
export async function resolvePapercutsDir(cwd: string): Promise<string> {
	try {
		const out = (await $`git -C ${cwd} rev-parse --git-common-dir`.quiet()).stdout.toString().trim();
		if (!out) return cwd;
		return dirname(resolve(cwd, out));
	} catch {
		return cwd;
	}
}

async function currentBranch(dir: string): Promise<string | null> {
	try {
		const out = (await $`git -C ${dir} rev-parse --abbrev-ref HEAD`.quiet()).stdout.toString().trim();
		return out || null;
	} catch {
		return null;
	}
}

/** Single-line JSONL appends under O_APPEND are atomic, so concurrent Claude instances can't interleave. */
async function appendJsonl(path: string, records: object[]) {
	if (!records.length) return;
	await mkdir(dirname(path), { recursive: true });
	await appendFile(path, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

async function readJsonl<T>(path: string): Promise<T[]> {
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch {
		return [];
	}
	const out: T[] = [];
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		try {
			out.push(JSON.parse(line));
		} catch {
			// skip a torn/partial line rather than failing the whole read
		}
	}
	return out;
}

export function readGlobal(): Promise<PapercutRecord[]> {
	return readJsonl<PapercutRecord>(GLOBAL_LOG);
}

export function readResolutions(): Promise<ResolutionRecord[]> {
	return readJsonl<ResolutionRecord>(RESOLUTIONS_LOG);
}

export function appendResolution(record: ResolutionRecord) {
	return appendJsonl(RESOLUTIONS_LOG, [record]);
}

export function isResolution(r: ResolutionRecord): r is Resolution {
	return "ids" in r;
}

/** id → the resolution that currently covers it (replayed in order; revocations remove). */
export function resolvedIndex(records: ResolutionRecord[]): Map<string, Resolution> {
	const index = new Map<string, Resolution>();
	for (const r of records) {
		if (isResolution(r)) for (const id of r.ids) index.set(id, r);
		else for (const id of r.revokes) index.delete(id);
	}
	return index;
}

/**
 * Resolutions whose stored grep pattern matches the entry and whose fix predates it:
 * a papercut logged after the fix landed is evidence the fix did not take. A
 * resolution made with `--until` says "fixed by that date"; without it, the fix is
 * assumed to be in place from the moment it was recorded.
 */
export function regressionsOf(
	entry: Pick<PapercutRecord, "message" | "ts" | "date" | "repo">,
	resolutions: ResolutionRecord[],
): Resolution[] {
	return resolutions.filter(
		(r): r is Resolution =>
			isResolution(r) &&
			!!r.grep &&
			(r.until ? entry.date > r.until : entry.ts > r.ts) &&
			(!r.repo || entry.repo.includes(r.repo)) &&
			matchesGrep(entry.message, r.grep),
	);
}

export function regressionHint(r: Resolution): string {
	return `note: matches resolved pattern "${r.grep}" (${r.date}: ${r.note}) — if that fix is in place, this is a regression`;
}

/**
 * Writes to the repo-local PAPERCUTS.md (human-readable, per-repo signal) AND to the
 * global JSONL store (cross-project querying). `dir` must already be a repo root.
 */
export async function appendPapercuts(
	dir: string,
	entries: PapercutEntry[],
	source: PapercutRecord["source"] = "manual",
): Promise<PapercutRecord[]> {
	if (!entries.length) return [];
	const file = `${dir}/PAPERCUTS.md`;

	const f = Bun.file(file);
	const content = (await f.exists())
		? await f.text()
		: `# Papercuts\n\nFriction encountered while working in this repo — logged in the moment, none of it blocking. See CLAUDE.md → "Log papercuts".\n`;

	const day = today();
	const headers = [...content.matchAll(/^## (.+)$/gm)];
	const lastHeader = headers.at(-1)?.[1];

	let out = content.trimEnd() + "\n";
	if (lastHeader !== day) out += `\n## ${day}\n\n`;
	out += entries.map((e) => `- (${e.model}) ${e.message.trim()}`).join("\n") + "\n";

	await Bun.write(file, out);

	const ts = new Date().toISOString();
	const branch = await currentBranch(dir);
	const records: PapercutRecord[] = entries.map((e) => ({
		ts,
		date: day,
		model: e.model,
		repo: basename(dir),
		repoPath: dir,
		branch,
		source,
		message: e.message.trim(),
	}));
	await appendJsonl(GLOBAL_LOG, records);
	return records;
}

/**
 * Removes resolved entries from a repo's PAPERCUTS.md (exact message match) and
 * drops day headers left without entries. Returns how many bullets were removed.
 */
export async function pruneFromMarkdown(dir: string, messages: string[]): Promise<number> {
	const file = Bun.file(`${dir}/PAPERCUTS.md`);
	if (!(await file.exists())) return 0;
	const wanted = new Set(messages.map((m) => m.trim()));
	const kept: string[] = [];
	let removed = 0;
	for (const line of (await file.text()).split("\n")) {
		const m = line.match(/^- \((?:[^()]|\([^()]*\))*\) (.*)$/);
		if (m && wanted.has(m[1]!.trim())) {
			removed++;
			continue;
		}
		kept.push(line);
	}
	if (!removed) return 0;

	// Drop `## day` headers that no longer have a bullet before the next header/EOF.
	const out: string[] = [];
	for (let i = 0; i < kept.length; i++) {
		const line = kept[i]!;
		if (/^## /.test(line)) {
			let j = i + 1;
			while (j < kept.length && kept[j]!.trim() === "") j++;
			if (j >= kept.length || /^## /.test(kept[j]!)) continue;
		}
		out.push(line);
	}
	await Bun.write(file.name!, out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n");
	return removed;
}
