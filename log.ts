#!/usr/bin/env bun
import { parseArgs } from "util";
import {
	appendPapercuts,
	readResolutions,
	regressionHint,
	regressionsOf,
	resolvePapercutsDir,
} from "./common.ts";

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

const [record] = await appendPapercuts(dir, [{ model, message }]);
console.log(`Logged papercut to ${dir}/PAPERCUTS.md`);

// A fresh papercut that matches an already-resolved pattern means the fix did not take.
for (const r of regressionsOf(record!, await readResolutions())) {
	console.error(regressionHint(r));
}
