// shared/src/__tests__/sqlite-open.test.ts
import { describe, expect, test } from "bun:test";
import { openSqlite } from "../sqlite-open.ts";

// SIO-1772: both consumers' binding styles, plus the FTS5 features the evidence
// index depends on. The node:sqlite half cannot run under `bun test`; it is proven
// by bundling for node (see the PR), and both halves implement this same surface.
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
});
