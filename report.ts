#!/usr/bin/env bun
/**
 * Query the global papercut store across all projects, and mark papercuts as resolved.
 *
 * Usage:
 *   papercuts [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--year YYYY] [--repo <substr>]
 *             [--grep <substr>] [--all | --resolved] [--list] [--json]
 *   papercuts resolve <id>... -m "<what fixed it>" [--keep-md]
 *   papercuts resolve --grep <substr> [--repo <substr>] [--since D] [--until D]
 *             -m "<what fixed it>" [-n] [--keep-md]
 *   papercuts unresolve <id>...
 *
 * The default report hides resolved entries; `--all` includes them, `--resolved`
 * shows only them. Ids are printed by `--list` and `--json`. A pattern that starts
 * with a dash must be written as `--grep=--flag`.
 */
import { parseArgs } from "util";
import {
	appendResolution,
	entryId,
	isResolution,
	matchesGrep,
	pruneFromMarkdown,
	readGlobal,
	readResolutions,
	regressionsOf,
	resolvedIndex,
	today,
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
		grep: { type: "string" },
		json: { type: "boolean" },
		list: { type: "boolean" },
		all: { type: "boolean" },
		resolved: { type: "boolean" },
		message: { type: "string", short: "m" },
		"dry-run": { type: "boolean", short: "n" },
		"keep-md": { type: "boolean" },
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
	if (values.grep) records = records.filter((r) => matchesGrep(r.message, values.grep!));
	return records;
}

function fail(msg: string): never {
	console.error(msg);
	process.exit(1);
}

async function pruneMarkdown(targets: Annotated[]) {
	if (values["keep-md"]) return;
	const byDir = new Map<string, string[]>();
	for (const t of targets) byDir.set(t.repoPath, [...(byDir.get(t.repoPath) ?? []), t.message]);
	let files = 0;
	let lines = 0;
	for (const [dir, messages] of byDir) {
		const n = await pruneFromMarkdown(dir, messages);
		if (n) {
			files++;
			lines += n;
		}
	}
	if (lines) console.log(`Pruned ${lines} line(s) from ${files} PAPERCUTS.md file(s).`);
}

if (subcommand === "resolve") {
	const note = values.message?.trim();
	if (!note) fail('resolve needs -m "<what fixed it>"');

	let targets: Annotated[];
	if (ids.length) {
		if (values.grep) fail("resolve takes either ids or --grep, not both");
		const byId = new Map(everything.map((r) => [r.id, r]));
		const unknown = ids.filter((id) => !byId.has(id));
		if (unknown.length) fail(`Unknown id(s): ${unknown.join(", ")}`);
		targets = ids.map((id) => byId.get(id)!);
	} else if (values.grep) {
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
		...(values.grep ? { grep: values.grep } : {}),
		...(values.grep && values.repo ? { repo: values.repo } : {}),
		...(values.grep && until ? { until } : {}),
	};
	await appendResolution(record);
	console.log(`Resolved ${targets.length} papercut(s): ${record.ids.join(" ")}`);
	console.log(`  note: ${note}`);
	if (record.grep) console.log(`  later entries matching "${record.grep}" will be reported as possible regressions`);
	await pruneMarkdown(targets);
	process.exit(0);
}

if (subcommand === "unresolve") {
	if (!ids.length) fail("unresolve needs at least one id");
	const unknown = ids.filter((id) => !index.has(id));
	if (unknown.length) fail(`Not currently resolved: ${unknown.join(", ")}`);
	await appendResolution({ ts: new Date().toISOString(), date: today(), revokes: ids });
	console.log(`Reopened ${ids.length} papercut(s): ${ids.join(" ")} (PAPERCUTS.md lines are not restored).`);
	process.exit(0);
}

if (subcommand) fail(`Unknown subcommand '${subcommand}' (expected: resolve, unresolve)`);
if (values.message || values["dry-run"] || values["keep-md"]) fail("-m / -n / --keep-md only apply to resolve");
if (values.all && values.resolved) fail("--all and --resolved are mutually exclusive");

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

const byModel = tally((r) => r.model);
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
		console.log(`    ↳ resolved ${res.date} via "${res.grep}": ${res.note}`);
	}
}

const line = (r: Annotated) =>
	`- [${r.id}] [${r.date}] (${r.model}) ${r.message}` +
	(r.resolved ? `\n    ✓ resolved ${r.resolved.date}: ${r.resolved.note}` : "");

if (values.list) {
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
		console.log(`- ${r.date} ${r.ids.length.toString().padStart(3)} entr${r.ids.length === 1 ? "y" : "ies"}${r.grep ? ` grep="${r.grep}"` : ""}${r.repo ? ` repo=${r.repo}` : ""}: ${r.note}`);
	}
}
console.log();
