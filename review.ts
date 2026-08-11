#!/usr/bin/env bun
import { readdir, stat } from "node:fs/promises";
import { appendPapercuts, resolvePapercutsDir } from "./common.ts";

const sessionCwd = process.argv[2] ?? process.cwd();
const encoded = sessionCwd.replace(/[/.]/g, "-");
const transcriptsDir = `${process.env.HOME}/.claude/projects/${encoded}`;
const papercutsDir = await resolvePapercutsDir(sessionCwd);

const files = (await readdir(transcriptsDir)).filter((f) => f.endsWith(".jsonl"));
if (!files.length) {
	console.error(`No session transcripts found in ${transcriptsDir}`);
	process.exit(1);
}

const withMtime = await Promise.all(
	files.map(async (f) => ({ f, mtime: (await stat(`${transcriptsDir}/${f}`)).mtimeMs })),
);
withMtime.sort((a, b) => b.mtime - a.mtime);
const transcriptPath = `${transcriptsDir}/${withMtime[0]!.f}`;

const raw = await Bun.file(transcriptPath).text();
const rendered: string[] = [];

for (const line of raw.split("\n")) {
	if (!line.trim()) continue;
	let entry: any;
	try {
		entry = JSON.parse(line);
	} catch {
		continue;
	}
	if (entry.isMeta) continue;

	const role = entry?.message?.role;
	const content = entry?.message?.content;
	if (!role || content == null) continue;

	if (typeof content === "string") {
		if (content.includes("<local-command") || content.includes("<command-name>")) continue;
		rendered.push(`${role.toUpperCase()}: ${content.slice(0, 1000)}`);
		continue;
	}

	if (Array.isArray(content)) {
		for (const block of content) {
			if (block.type === "text" && block.text) {
				rendered.push(`${role.toUpperCase()}: ${String(block.text).slice(0, 1000)}`);
			} else if (block.type === "tool_use") {
				rendered.push(
					`${role.toUpperCase()} [tool_use: ${block.name}] ${JSON.stringify(block.input).slice(0, 300)}`,
				);
			} else if (block.type === "tool_result") {
				const c = typeof block.content === "string" ? block.content : JSON.stringify(block.content);
				rendered.push(
					`${role.toUpperCase()} [tool_result${block.is_error ? " ERROR" : ""}] ${c.slice(0, 300)}`,
				);
			}
		}
	}
}

let transcriptText = rendered.join("\n");
const MAX = 100_000;
if (transcriptText.length > MAX) {
	transcriptText = `[...earlier turns omitted...]\n${transcriptText.slice(-MAX)}`;
}

const prompt = `You are mining a coding-agent session transcript for "papercuts": small friction encountered while working, even though none of it was blocking — a tool call that missed and had to be retried, a confusing or undocumented setup step, a flaky command, a stale cache, a misleading error, a non-obvious gotcha.

Do NOT include: intentional bug reports or fixes (those are tracked separately as real bugs), a summary of what was accomplished (that belongs in a changelog), or ordinary back-and-forth that had no friction.

For each papercut found, output one JSON object per line (JSONL), each with a single "message" field: one or two sentences, "what was being done -> what got in the way" (a guess at the cause or fix is a bonus, not required). If you find none, output nothing at all.

Output ONLY the JSONL lines, nothing else — no preamble, no markdown fences.

<transcript>
${transcriptText}
</transcript>`;

const proc = Bun.spawn(
	["claude", "-p", "--model", "haiku", "--max-turns", "1", "--disallowedTools", "Task,Agent,Skill,Workflow"],
	{ stdin: "pipe", stdout: "pipe", stderr: "pipe" },
);
proc.stdin.write(prompt);
proc.stdin.end();

const [out, err, code] = await Promise.all([
	new Response(proc.stdout).text(),
	new Response(proc.stderr).text(),
	proc.exited,
]);

if (code !== 0) {
	console.error(`claude -p failed:\n${err}`);
	process.exit(1);
}

const entries = out
	.split("\n")
	.map((l) => l.trim())
	.filter(Boolean)
	.map((l) => {
		try {
			return JSON.parse(l);
		} catch {
			return null;
		}
	})
	.filter((e): e is { message: string } => !!e?.message);

if (!entries.length) {
	console.log("No papercuts found in this session.");
	process.exit(0);
}

await appendPapercuts(
	papercutsDir,
	entries.map((e) => ({ model: "haiku via /papercut", message: e.message })),
);
console.log(`Logged ${entries.length} papercut(s) to ${papercutsDir}/PAPERCUTS.md`);
