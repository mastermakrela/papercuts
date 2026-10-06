#!/usr/bin/env bun
/**
 * Query the global papercut store across all projects, and mark papercuts as resolved.
 *
 * Usage:
 *   papercuts [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--year YYYY] [--repo <substr>]
 *             [--grep <substr>]... [--all | --resolved] [--list | --compact] [--json]
 *   papercuts resolve <id>... -m "<what fixed it>" [--keep-md]
 *   papercuts resolve --grep <substr>... --until <fix-date> [--repo <substr>] [--since D]
 *             -m "<what fixed it>" [-n] [--keep-md]
 *   papercuts unresolve <id>... [--keep-md]
 *   papercuts sync-md [--repo <substr>] [-n]
 *
 * The default report hides resolved entries; `--all` includes them, `--resolved`
 * shows only them. Ids are printed by `--list`, `--compact` and `--json`. `--grep`
 * may be repeated (any match counts); a pattern that starts with a dash must be
 * written as `--grep=--flag`. A pattern resolution needs `--until`: the date the fix
 * landed, so matching entries logged after it stay open and are flagged.
 *
 * Each repo's PAPERCUTS.md is a view of its open entries in the store: resolve and
 * unresolve regenerate the affected files (unless --keep-md), sync-md regenerates
 * every file (or those of --repo); -n prints the plan only. The "By model" tally
 * folds spellings of the same model together; --raw-models shows them as logged.
 */
import { parseArgs } from "util";
import {
	appendResolution,
	entryId,
	isResolution,
	matchesGrep,
	normalizeModel,
	patternsOf,
	readGlobal,
	readResolutions,
	regenerateMarkdowns,
	regressionsOf,
	resolvedIndex,
	today,
	type MarkdownSync,
	type PapercutRecord,
	type Resolution,
} from "./common.ts";

const { values, positionals } = parseArgs({
	args: Bun.argv.slice(2),
	options: {
		since: { type: "string" },
		until: { type: "string" },
		year: { type: "string" },
		repo: { type: "string" },
		grep: { type: "string", multiple: true },
		json: { type: "boolean" },
		list: { type: "boolean" },
		compact: { type: "boolean" },
		all: { type: "boolean" },
		resolved: { type: "boolean" },
		message: { type: "string", short: "m" },
		"dry-run": { type: "boolean", short: "n" },
		"keep-md": { type: "boolean" },
		"raw-models": { type: "boolean" },
	},
	strict: true,
	allowPositionals: true,
});

const [subcommand, ...ids] = positionals;

type Annotated = PapercutRecord & { id: string; resolved?: Resolution; regressionOf?: Resolution[] };

const resolutionRecords = await readResolutions();
const index = resolvedIndex(resolutionRecords);
const everything: Annotated[] = (await readGlobal()).map((r) => {
	const id = entryId(r);
	const resolved = index.get(id);
	const regressionOf = resolved ? [] : regressionsOf(r, resolutionRecords);
	return { ...r, id, resolved, ...(regressionOf.length ? { regressionOf } : {}) };
});
if (!everything.length) {
	console.error("Global papercut store is empty — nothing logged yet.");
	process.exit(1);
}

const since = values.year ? `${values.year}-01-01` : values.since;
const until = values.year ? `${values.year}-12-31` : values.until;

function applyFilters(records: Annotated[]): Annotated[] {
	if (since) records = records.filter((r) => r.date >= since);
	if (until) records = records.filter((r) => r.date <= until);
	if (values.repo) records = records.filter((r) => r.repo.includes(values.repo!));
	if (values.grep?.length) records = records.filter((r) => matchesGrep(r.message, values.grep!));
	return records;
}

function fail(msg: string): never {
	console.error(msg);
	process.exit(1);
}

function printSync(results: MarkdownSync[], dryRun: boolean) {
	for (const r of results) {
		const verb = r.existed ? ["would rewrite", "rewritten"] : ["would create", "created"];
		const state = !r.changed ? "unchanged" : verb[dryRun ? 0 : 1];
		const dropped = r.dropped ? `, ${r.dropped} dropped (not in store for this dir)` : "";
		console.log(`  ${r.path}: ${r.before} bullets → ${r.after} bullets${dropped} [${state}]`);
	}
}

/** resolve/unresolve: re-derive the PAPERCUTS.md of every repo the change touched. */
async function syncMarkdown(targets: Annotated[]) {
	if (values["keep-md"]) return;
	const results = await regenerateMarkdowns(targets.map((t) => t.repoPath));
	if (results.length) console.log("PAPERCUTS.md:");
	printSync(results, false);
}

if (subcommand === "resolve") {
	const note = values.message?.trim();
	if (!note) fail('resolve needs -m "<what fixed it>"');

	const patterns = values.grep ?? [];
	let targets: Annotated[];
	if (ids.length) {
		if (patterns.length) fail("resolve takes either ids or --grep, not both");
		const byId = new Map(everything.map((r) => [r.id, r]));
		const unknown = ids.filter((id) => !byId.has(id));
		if (unknown.length) fail(`Unknown id(s): ${unknown.join(", ")}`);
		targets = ids.map((id) => byId.get(id)!);
	} else if (patterns.length) {
		if (values.year) fail("resolve --grep takes --until <fix-date>, not --year");
		if (!until || !/^\d{4}-\d{2}-\d{2}$/.test(until)) {
			fail(
				"resolve --grep needs --until <YYYY-MM-DD>: the date the fix landed. Entries up to that date are resolved; later matches stay open and are reported as possible regressions.",
			);
		}
		targets = applyFilters(everything.filter((r) => !r.resolved));
	} else {
		fail("resolve needs ids or --grep <substr>");
	}

	const already = targets.filter((r) => r.resolved);
	targets = targets.filter((r) => !r.resolved);
	if (already.length) console.error(`Skipping ${already.length} already-resolved id(s).`);
	if (!targets.length) fail("Nothing to resolve.");

	if (values["dry-run"]) {
		console.log(`Would resolve ${targets.length} papercut(s):`);
		for (const r of targets) console.log(`- [${r.id}] [${r.date}] ${r.repo}: ${r.message.slice(0, 140)}`);
		process.exit(0);
	}

	const record: Resolution = {
		ts: new Date().toISOString(),
		date: today(),
		ids: targets.map((r) => r.id),
		note,
		...(patterns.length ? { grep: patterns.length === 1 ? patterns[0]! : patterns } : {}),
		...(patterns.length && values.repo ? { repo: values.repo } : {}),
		...(patterns.length && until ? { until } : {}),
	};
	await appendResolution(record);
	console.log(`Resolved ${targets.length} papercut(s): ${record.ids.join(" ")}`);
	console.log(`  note: ${note}`);
	if (patterns.length) {
		console.log(`  entries after ${until} matching "${patterns.join('" | "')}" will be reported as possible regressions`);
	}
	await syncMarkdown(targets);
	process.exit(0);
}

if (subcommand === "unresolve") {
	if (!ids.length) fail("unresolve needs at least one id");
	const unknown = ids.filter((id) => !index.has(id));
	if (unknown.length) fail(`Not currently resolved: ${unknown.join(", ")}`);
	await appendResolution({ ts: new Date().toISOString(), date: today(), revokes: ids });
	console.log(`Reopened ${ids.length} papercut(s): ${ids.join(" ")}`);
	await syncMarkdown(everything.filter((r) => ids.includes(r.id)));
	process.exit(0);
}

if (subcommand === "sync-md") {
	if (ids.length) fail("sync-md takes no positional arguments (use --repo <substr>)");
	const dirs = everything.filter((r) => !values.repo || r.repo.includes(values.repo)).map((r) => r.repoPath);
	const dryRun = !!values["dry-run"];
	const results = await regenerateMarkdowns(dirs, { dryRun });
	if (!results.length) fail("No PAPERCUTS.md to regenerate (no existing repo dir with a file or open entries).");
	printSync(results, dryRun);
	const changed = results.filter((r) => r.changed).length;
	const dropped = results.reduce((n, r) => n + r.dropped, 0);
	console.log(`${dryRun ? "Would rewrite" : "Rewrote"} ${changed} of ${results.length} file(s)${dropped ? `; ${dropped} line(s) dropped (not in store for their dir)` : ""}.`);
	process.exit(0);
}

if (subcommand) fail(`Unknown subcommand '${subcommand}' (expected: resolve, unresolve, sync-md)`);
if (values.message || values["dry-run"] || values["keep-md"]) fail("-m / -n / --keep-md only apply to resolve / unresolve / sync-md");
if (values.all && values.resolved) fail("--all and --resolved are mutually exclusive");
if (values.list && values.compact) fail("--list and --compact are mutually exclusive");

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const filtered = applyFilters(everything);
const openCount = filtered.filter((r) => !r.resolved).length;
const resolvedCount = filtered.length - openCount;
const records = values.resolved
	? filtered.filter((r) => r.resolved)
	: values.all
		? filtered
		: filtered.filter((r) => !r.resolved);

if (values.json) {
	console.log(JSON.stringify(records, null, 2));
	process.exit(0);
}

if (!records.length) {
	console.log(`\nNo ${values.resolved ? "resolved" : "open"} papercuts match (${openCount} open, ${resolvedCount} resolved in range).\n`);
	process.exit(0);
}

const tally = (key: (r: PapercutRecord) => string) => {
	const m = new Map<string, number>();
	for (const r of records) m.set(key(r), (m.get(key(r)) ?? 0) + 1);
	return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
};

const dates = records.map((r) => r.date).sort();
const bar = (n: number, max: number) => "█".repeat(Math.max(1, Math.round((n / max) * 24)));
const scope = values.resolved ? "resolved" : values.all ? "open + resolved" : "open";

console.log(`\nPapercuts: ${records.length} ${scope} (${openCount} open, ${resolvedCount} resolved in range)`);
console.log(`Range:     ${dates[0]} → ${dates.at(-1)}`);
console.log(`Repos:     ${new Set(records.map((r) => r.repo)).size}`);

const byRepo = tally((r) => r.repo);
console.log(`\nBy repo`);
for (const [repo, n] of byRepo) {
	console.log(`  ${n.toString().padStart(3)}  ${bar(n, byRepo[0]![1]).padEnd(25)} ${repo}`);
}

const byModel = tally((r) => (values["raw-models"] ? r.model : normalizeModel(r.model)));
console.log(`\nBy model`);
for (const [model, n] of byModel) console.log(`  ${n.toString().padStart(3)}  ${model}`);

const byDate = tally((r) => r.date).sort((a, b) => a[0].localeCompare(b[0]));
console.log(`\nBy date`);
for (const [date, n] of byDate) console.log(`  ${n.toString().padStart(3)}  ${date}`);

const regressions = records.filter((r) => r.regressionOf?.length);
if (regressions.length && !values.resolved) {
	console.log(`\nPossible regressions — open entries newer than a resolution whose pattern they match (${regressions.length})`);
	for (const r of regressions) {
		const res = r.regressionOf![0]!;
		console.log(`- [${r.id}] [${r.date}] ${r.repo}: ${r.message.slice(0, 120)}`);
		console.log(`    ↳ resolved ${res.date} via "${patternsOf(res).join('" | "')}": ${res.note}`);
	}
}

const line = (r: Annotated) =>
	values.compact
		? `- [${r.id}] [${r.date}] ${r.message.slice(0, 100)}${r.message.length > 100 ? "…" : ""}${r.resolved ? " ✓" : ""}`
		: `- [${r.id}] [${r.date}] (${r.model}) ${r.message}` +
			(r.resolved ? `\n    ✓ resolved ${r.resolved.date}: ${r.resolved.note}` : "");

if (values.list || values.compact) {
	console.log(`\n${"─".repeat(70)}`);
	const grouped = new Map<string, Annotated[]>();
	for (const r of records) {
		if (!grouped.has(r.repo)) grouped.set(r.repo, []);
		grouped.get(r.repo)!.push(r);
	}
	for (const [repo, rs] of [...grouped.entries()].sort((a, b) => b[1].length - a[1].length)) {
		console.log(`\n## ${repo} (${rs.length})`);
		for (const r of rs) console.log(line(r));
	}
}

const resolutions = resolutionRecords.filter(isResolution);
if (values.resolved && resolutions.length) {
	console.log(`\nResolutions (${resolutions.length})`);
	for (const r of resolutions) {
		const pats = patternsOf(r);
		console.log(`- ${r.date} ${r.ids.length.toString().padStart(3)} entr${r.ids.length === 1 ? "y" : "ies"}${pats.length ? ` grep="${pats.join('" | "')}"` : ""}${r.until ? ` fixed-by=${r.until}` : ""}${r.repo ? ` repo=${r.repo}` : ""}: ${r.note}`);
	}
}
console.log();
