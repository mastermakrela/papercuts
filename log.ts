#!/usr/bin/env bun
import { parseArgs } from "util";
import { appendPapercuts, resolvePapercutsDir } from "./common.ts";

const { values, positionals } = parseArgs({
	args: Bun.argv.slice(2),
	options: {
		model: { type: "string", short: "m" },
	},
	strict: true,
	allowPositionals: true,
});

const message = positionals.join(" ").trim();
if (!message) {
	console.error('Usage: papercut -m <model> "message"');
	process.exit(1);
}

const model = values.model ?? "unknown";
const dir = await resolvePapercutsDir(process.cwd());

await appendPapercuts(dir, [{ model, message }]);
console.log(`Logged papercut to ${dir}/PAPERCUTS.md`);
