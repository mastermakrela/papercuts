import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
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
	/** One or more substrings (OR); older records stored a single string. */
	grep?: string | string[];
	repo?: string;
	/** The date the fix landed; matching entries after it count as regressions. */
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

/** Same semantics as `papercuts --grep`: case-insensitive substring; several patterns OR. */
export function matchesGrep(message: string, patterns: string | string[]): boolean {
	const m = message.toLowerCase();
	return (Array.isArray(patterns) ? patterns : [patterns]).some((p) => m.includes(p.toLowerCase()));
}

export function patternsOf(r: Resolution): string[] {
	return !r.grep ? [] : Array.isArray(r.grep) ? r.grep : [r.grep];
}

/**
 * Resolves to the repo's main worktree root, not the literal cwd — so a papercut
 * logged from a linked worktree still lands in a file that survives that worktree
 * being deleted. Falls back to `cwd` outside a git repo (`inRepo: false`).
 */
export async function resolvePapercutsDir(cwd: string): Promise<{ dir: string; inRepo: boolean }> {
	try {
		const out = (await $`git -C ${cwd} rev-parse --git-common-dir`.quiet()).stdout.toString().trim();
		if (!out) return { dir: cwd, inRepo: false };
		return { dir: dirname(resolve(cwd, out)), inRepo: true };
	} catch {
		return { dir: cwd, inRepo: false };
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
	// A resolution whose every id was revoked is void: its pattern no longer counts.
	const active = new Set(resolvedIndex(resolutions).values());
	return resolutions.filter(
		(r): r is Resolution =>
			isResolution(r) &&
			active.has(r) &&
			!!r.grep &&
			(r.until ? entry.date > r.until : entry.ts > r.ts) &&
			(!r.repo || entry.repo.includes(r.repo)) &&
			matchesGrep(entry.message, r.grep),
	);
}

export function regressionHint(r: Resolution): string {
	return `note: matches resolved pattern "${patternsOf(r).join('" | "')}" (${r.date}: ${r.note}) — if that fix is in place, this is a regression`;
}

const MD_HEADER = `# Papercuts\n\nFriction encountered while working in this repo — logged in the moment, none of it blocking. See CLAUDE.md → "Log papercuts".\n`;

const bullet = (r: Pick<PapercutRecord, "model" | "message">) => `- (${r.model}) ${r.message.trim()}`;

/** Bullet lines of a PAPERCUTS.md, or null when the file does not exist. */
async function readBullets(path: string): Promise<string[] | null> {
	const f = Bun.file(path);
	if (!(await f.exists())) return null;
	return (await f.text()).split("\n").filter((l) => l.startsWith("- "));
}

/**
 * Writes to the repo-local PAPERCUTS.md (human-readable, per-repo signal) AND to the
 * global JSONL store (cross-project querying). `dir` must already be a repo root.
 * The markdown is only appended to here; if it has drifted from the store, a hint
 * points at `papercuts sync-md` — regeneration never happens on the log path.
 */
export async function appendPapercuts(
	dir: string,
	entries: PapercutEntry[],
	source: PapercutRecord["source"] = "manual",
): Promise<PapercutRecord[]> {
	if (!entries.length) return [];
	const file = `${dir}/PAPERCUTS.md`;

	const f = Bun.file(file);
	const exists = await f.exists();
	const content = exists ? await f.text() : MD_HEADER;

	const day = today();
	const headers = [...content.matchAll(/^## (.+)$/gm)];
	const lastHeader = headers.at(-1)?.[1];

	// Append only: rewriting the whole file loses the lines of parallel instances.
	// Parallel first writes of a day can repeat its `## day` header; no line is lost.
	let out = exists && !content.endsWith("\n") ? "\n" : "";
	if (lastHeader !== day) out += `\n## ${day}\n\n`;
	out += entries.map(bullet).join("\n") + "\n";

	if (!exists) await writeFile(file, MD_HEADER, { flag: "wx" }).catch(() => {}); // lost the creation race: file exists now
	await appendFile(file, out);

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

	const bullets = (await readBullets(file))?.length ?? 0;
	const open = (await openEntries(dir)).length;
	if (bullets !== open) {
		console.error(
			`note: ${file} has ${bullets} bullet(s) but the store has ${open} open entr${open === 1 ? "y" : "ies"} for this dir — left as is; \`papercuts sync-md -n --repo ${basename(dir)}\` shows what regenerating it would change`,
		);
	}
	return records;
}

type Store = { records: PapercutRecord[]; resolved: Map<string, Resolution> };

async function loadStore(): Promise<Store> {
	return { records: await readGlobal(), resolved: resolvedIndex(await readResolutions()) };
}

async function openEntries(dir: string, store?: Store): Promise<PapercutRecord[]> {
	const { records, resolved } = store ?? (await loadStore());
	return records.filter((r) => r.repoPath === dir && !resolved.has(entryId(r)));
}

export type MarkdownSync = {
	path: string;
	existed: boolean;
	/** Bullets in the file before (0 if it did not exist). */
	before: number;
	after: number;
	/** Bullets in the file that match no store entry (open or resolved) for this dir. */
	dropped: number;
	/** The regenerated content differs from the file (or the file is new). */
	changed: boolean;
	/** `changed` and not a dry run. */
	written: boolean;
};

/**
 * Regenerates `<dir>/PAPERCUTS.md` from the store: every OPEN entry whose repoPath
 * is `dir`, grouped under `## YYYY-MM-DD` (newest day last), replaced atomically
 * (temp file + rename). The store is the source of truth, so a bullet that exists
 * only in the file disappears; it is counted in `dropped`. A missing file is only
 * created when there are open entries. Returns null when there is nothing to do:
 * `dir` no longer exists, or it has neither a file nor open entries.
 */
export async function regenerateMarkdown(
	dir: string,
	opts: { dryRun?: boolean; store?: Store } = {},
): Promise<MarkdownSync | null> {
	if (!(await stat(dir).then((s) => s.isDirectory(), () => false))) return null;
	const path = `${dir}/PAPERCUTS.md`;
	const store = opts.store ?? (await loadStore());
	const open = await openEntries(dir, store);
	const existing = await readBullets(path);

	// Bullets the store knows nothing about (for this dir) are lost on regeneration.
	const known = new Map<string, number>();
	for (const r of store.records) {
		if (r.repoPath === dir) known.set(bullet(r), (known.get(bullet(r)) ?? 0) + 1);
	}
	let dropped = 0;
	for (const line of existing ?? []) {
		const left = known.get(line.trim());
		if (left) known.set(line.trim(), left - 1);
		else dropped++;
	}

	if (existing === null && !open.length) return null;

	const byDay = new Map<string, PapercutRecord[]>();
	for (const r of open) byDay.set(r.date, [...(byDay.get(r.date) ?? []), r]);
	let out = MD_HEADER;
	for (const [day, rs] of [...byDay].sort((a, b) => a[0].localeCompare(b[0]))) {
		out += `\n## ${day}\n\n${rs.map(bullet).join("\n")}\n`;
	}

	const changed = existing === null || (await Bun.file(path).text()) !== out;
	const written = changed && !opts.dryRun;
	if (written) {
		const tmp = `${path}.${process.pid}.tmp`;
		await Bun.write(tmp, out);
		await rename(tmp, path);
	}
	return { path, existed: existing !== null, before: existing?.length ?? 0, after: open.length, dropped, changed, written };
}

/** Regenerates PAPERCUTS.md for each dir from one snapshot of the store. */
export async function regenerateMarkdowns(dirs: Iterable<string>, opts: { dryRun?: boolean } = {}): Promise<MarkdownSync[]> {
	const store = await loadStore();
	const out: MarkdownSync[] = [];
	for (const dir of new Set(dirs)) {
		const r = await regenerateMarkdown(dir, { ...opts, store });
		if (r) out.push(r);
	}
	return out;
}

/**
 * Folds the free-text `-m <model>` spellings into family + version for tallies:
 * `claude-opus-5-5`, `Opus 5 (1M context)`, `haiku via /papercut` → `opus-5.5`,
 * `opus-5`, `haiku`. Unknown names pass through lowercased. The store stays raw.
 */
export function normalizeModel(raw: string): string {
	const s = raw
		.toLowerCase()
		.trim()
		.replace(/^claude-/, "")
		.replace(/\s*\(1m context\)|\[1m\]/g, "");
	const m = s.match(/^(opus|sonnet|haiku|fable)[\s-]?(?:(\d+)(?:[.-](\d{1,2})(?!\d))?)?/);
	if (!m) return s;
	return [m[1], m[2] && (m[3] ? `${m[2]}.${m[3]}` : m[2])].filter(Boolean).join("-");
}
