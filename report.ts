#!/usr/bin/env bun
/**
 * Query the global papercut store across all projects.
 *
 * Usage: bun report.ts [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--year YYYY]
 *                      [--repo <substr>] [--grep <substr>] [--json] [--list]
 */
import { parseArgs } from "util";
import { readGlobal, type PapercutRecord } from "./common.ts";

const { values } = parseArgs({
	args: Bun.argv.slice(2),
	options: {
		since: { type: "string" },
		until: { type: "string" },
		year: { type: "string" },
		repo: { type: "string" },
		grep: { type: "string" },
		json: { type: "boolean" },
		list: { type: "boolean" },
	},
	strict: true,
	allowPositionals: false,
});

let records = await readGlobal();
if (!records.length) {
	console.error("Global papercut store is empty — nothing logged yet.");
	process.exit(1);
}

const since = values.year ? `${values.year}-01-01` : values.since;
const until = values.year ? `${values.year}-12-31` : values.until;

if (since) records = records.filter((r) => r.date >= since);
if (until) records = records.filter((r) => r.date <= until);
if (values.repo) records = records.filter((r) => r.repo.includes(values.repo!));
if (values.grep) {
	const q = values.grep.toLowerCase();
	records = records.filter((r) => r.message.toLowerCase().includes(q));
}

if (values.json) {
	console.log(JSON.stringify(records, null, 2));
	process.exit(0);
}

const tally = (key: (r: PapercutRecord) => string) => {
	const m = new Map<string, number>();
	for (const r of records) m.set(key(r), (m.get(key(r)) ?? 0) + 1);
	return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
};

const dates = records.map((r) => r.date).sort();
const bar = (n: number, max: number) => "█".repeat(Math.max(1, Math.round((n / max) * 24)));

console.log(`\nPapercuts: ${records.length} entries`);
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

if (values.list) {
	console.log(`\n${"─".repeat(70)}`);
	const grouped = new Map<string, PapercutRecord[]>();
	for (const r of records) {
		if (!grouped.has(r.repo)) grouped.set(r.repo, []);
		grouped.get(r.repo)!.push(r);
	}
	for (const [repo, rs] of [...grouped.entries()].sort((a, b) => b[1].length - a[1].length)) {
		console.log(`\n## ${repo} (${rs.length})`);
		for (const r of rs) console.log(`- [${r.date}] (${r.model}) ${r.message}`);
	}
}
console.log();
