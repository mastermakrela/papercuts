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
	source: "manual" | "review";
	message: string;
};

/** Append-only global store: every papercut from every repo, for cross-project reporting. */
const GLOBAL_LOG =
	process.env.PAPERCUTS_LOG ?? `${process.env.HOME}/.claude/papercuts/log.jsonl`;

export function today(): string {
	return new Intl.DateTimeFormat("en-CA").format(new Date());
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
async function appendGlobal(records: PapercutRecord[]) {
	if (!records.length) return;
	await mkdir(dirname(GLOBAL_LOG), { recursive: true });
	await appendFile(GLOBAL_LOG, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

export async function readGlobal(): Promise<PapercutRecord[]> {
	let raw: string;
	try {
		raw = await readFile(GLOBAL_LOG, "utf8");
	} catch {
		return [];
	}
	const out: PapercutRecord[] = [];
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

/**
 * Writes to the repo-local PAPERCUTS.md (human-readable, per-repo signal) AND to the
 * global JSONL store (cross-project querying). `dir` must already be a repo root.
 */
export async function appendPapercuts(
	dir: string,
	entries: PapercutEntry[],
	source: PapercutRecord["source"] = "manual",
) {
	if (!entries.length) return;
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
	await appendGlobal(
		entries.map((e) => ({
			ts,
			date: day,
			model: e.model,
			repo: basename(dir),
			repoPath: dir,
			branch,
			source,
			message: e.message.trim(),
		})),
	);
}
