import { expect, test } from "bun:test";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { $ } from "bun";

// The store path is read when common.ts loads, so redirect it before importing: tests never touch the real store.
const tmp = await realpath(await mkdtemp(`${tmpdir()}/papercuts-test-`));
process.env.PAPERCUTS_LOG = `${tmp}/log.jsonl`;
const { appendPapercuts, entryId, normalizeModel, regenerateMarkdown, regressionsOf, resolvePapercutsDir } = await import("./common.ts");

const git = (cwd: string, ...args: string[]) =>
	$`git -c user.email=t@t -c user.name=t -c protocol.file.allow=always -C ${cwd} ${args}`.quiet();

test("normalizeModel folds spellings into family + version", () => {
	const cases: [string, string][] = [
		["claude-opus-5-5", "opus-5.5"],
		["Opus 5 (1M context)", "opus-5"],
		["claude-sonnet-4-5-20250929", "sonnet-4.5"],
		["claude-opus-4-20250514", "opus-4"],
		["haiku via /papercut", "haiku"],
		["gpt-5", "gpt-5"],
	];
	for (const [raw, want] of cases) expect(normalizeModel(raw)).toBe(want);
});

test("regressionsOf flags only matches logged after the fix date", () => {
	const res = { ts: "2026-10-01T10:00:00.000Z", date: "2026-10-01", ids: ["a"], note: "fixed", grep: "paraglide", until: "2026-09-20" };
	const entry = (date: string, message: string) => ({ ts: `${date}T09:00:00.000Z`, date, repo: "r", message });
	expect(regressionsOf(entry("2026-09-21", "Paraglide failed"), [res])).toHaveLength(1);
	expect(regressionsOf(entry("2026-09-20", "paraglide failed"), [res])).toHaveLength(0);
	expect(regressionsOf(entry("2026-09-21", "something else"), [res])).toHaveLength(0);
	const revoked = { ts: "2026-10-02T10:00:00.000Z", date: "2026-10-02", revokes: ["a"] };
	expect(regressionsOf(entry("2026-09-21", "paraglide failed"), [res, revoked])).toHaveLength(0);
});

test("parallel appends keep every line in PAPERCUTS.md", async () => {
	const dir = `${tmp}/parallel`;
	await $`mkdir ${dir}`;
	await Promise.all(Array.from({ length: 8 }, (_, i) => appendPapercuts(dir, [{ model: "m", message: `msg ${i}` }])));
	const bullets = (await Bun.file(`${dir}/PAPERCUTS.md`).text()).split("\n").filter((l) => l.startsWith("- "));
	expect(bullets).toHaveLength(8);
});

test("regenerateMarkdown writes only open entries and counts hand-written lines as dropped", async () => {
	const dir = `${tmp}/regen`;
	await $`mkdir ${dir}`;
	const rec = (message: string) => ({ ts: "2026-10-01T00:00:00.000Z", date: "2026-10-01", model: "m", repo: "regen", repoPath: dir, branch: null, source: "manual" as const, message });
	const resolved = new Map([[entryId(rec("fixed one")), { ts: "", date: "", ids: [], note: "n" }]]);
	await Bun.write(`${dir}/PAPERCUTS.md`, "- (m) hand written\n- (m) still open\n");
	const r = await regenerateMarkdown(dir, { store: { records: [rec("fixed one"), rec("still open")], resolved } });
	expect(r).toMatchObject({ before: 2, after: 1, dropped: 1, written: true });
	expect(await Bun.file(`${dir}/PAPERCUTS.md`).text()).toContain("- (m) still open");
	expect(await Bun.file(`${dir}/PAPERCUTS.md`).text()).not.toContain("fixed one");
});

test("resolvePapercutsDir: a linked worktree maps to the main root, a submodule to its own root", async () => {
	const main = `${tmp}/main`;
	await $`mkdir ${main} && git -C ${main} init -q`.quiet();
	await git(main, "commit", "-q", "--allow-empty", "-m", "i");
	await git(main, "worktree", "add", "-q", `${tmp}/linked`);
	expect((await resolvePapercutsDir(`${tmp}/linked`)).dir).toBe(main);

	await $`mkdir ${tmp}/sub && git -C ${tmp}/sub init -q`.quiet();
	await git(`${tmp}/sub`, "commit", "-q", "--allow-empty", "-m", "i");
	await git(main, "submodule", "add", "-q", `${tmp}/sub`, "sub");
	expect((await resolvePapercutsDir(`${main}/sub`)).dir).toBe(`${main}/sub`);

	expect(await resolvePapercutsDir(await mkdtemp(`${tmpdir()}/papercuts-nogit-`))).toMatchObject({ inRepo: false });
});
