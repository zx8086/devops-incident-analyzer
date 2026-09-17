// shared/src/__tests__/sqlite-open.test.ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSqlite } from "../sqlite-open.ts";

// node:sqlite needs Node >= 22.5. Absent or older node skips rather than fails: the
// repo's runtime is Bun, and node is only the web app's dev host.
function nodeHasSqlite(): boolean {
	const node = Bun.which("node");
	if (!node) return false;
	const version = Bun.spawnSync([node, "--version"]).stdout.toString().trim().replace(/^v/, "");
	const [major = 0, minor = 0] = version.split(".").map(Number);
	return major > 22 || (major === 22 && minor >= 5);
}

// SIO-1772: both consumers' binding styles, plus the FTS5 features the evidence
// index depends on. The first two tests exercise the bun:sqlite half; the last one
// bundles a probe and runs it under a real `node`, because the node:sqlite half is
// the whole point of the module and cannot execute inside `bun test`.
describe("openSqlite", () => {
	test("prefixed params (default) with FTS5 porter, snippet and bm25", async () => {
		const db = await openSqlite(":memory:");
		db.exec("CREATE VIRTUAL TABLE e USING fts5(title, content, tokenize='porter unicode61')");
		db.prepare("INSERT INTO e (title, content) VALUES ($t, $c)").run({
			$t: "hits[0]",
			$c: "response was cached twice",
		});
		const rows = db
			.prepare("SELECT snippet(e, 1, '[', ']', '...', 8) AS s FROM e WHERE e MATCH $m ORDER BY bm25(e, 5.0, 1.0)")
			.all<{ s: string }>({ $m: "caching" });
		expect(rows).toEqual([{ s: "response was [cached] twice" }]);
		db.close();
	});

	test("bare named params when requested", async () => {
		const db = await openSqlite(":memory:", { bareNamedParameters: true });
		db.exec("CREATE TABLE t (name TEXT, n INTEGER)");
		db.prepare("INSERT INTO t VALUES ($name, $n)").run({ name: "a", n: 2 });
		expect(db.prepare("SELECT name, n FROM t").all<{ name: string; n: number }>()).toEqual([{ name: "a", n: 2 }]);
		db.close();
	});

	test.skipIf(!nodeHasSqlite())(
		"node:sqlite half: same surface, and concurrent first opens restore emitWarning",
		async () => {
			const dir = mkdtempSync(join(tmpdir(), "sqlite-open-node-"));
			try {
				const built = await Bun.build({
					entrypoints: [join(import.meta.dir, "fixtures/sqlite-open-node-probe.ts")],
					target: "node",
					outdir: dir,
				});
				expect(built.success).toBe(true);
				const run = Bun.spawnSync(["node", join(dir, "sqlite-open-node-probe.js")]);
				expect(run.stderr.toString()).toBe("");
				expect(JSON.parse(run.stdout.toString())).toEqual({
					runtime: "node",
					// Greptile, PR #805: per-call swapping raced and left the filter installed.
					emitWarningRestored: true,
					snippets: [{ s: "response was [cached] twice" }],
					rows: [{ name: "a", n: 2 }],
				});
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		},
	);
});
