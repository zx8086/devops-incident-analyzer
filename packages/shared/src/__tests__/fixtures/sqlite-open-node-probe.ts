// shared/src/__tests__/fixtures/sqlite-open-node-probe.ts
// Bundled for node and executed by sqlite-open.test.ts. Prints one JSON line.
import { openSqlite } from "../../sqlite-open.ts";

const original = process.emitWarning;
const concurrent = await Promise.all([openSqlite(":memory:"), openSqlite(":memory:"), openSqlite(":memory:")]);
for (const d of concurrent) d.close();

const fts = await openSqlite(":memory:");
fts.exec("CREATE VIRTUAL TABLE e USING fts5(title, content, tokenize='porter unicode61')");
fts.prepare("INSERT INTO e (title, content) VALUES ($t, $c)").run({ $t: "hits[0]", $c: "response was cached twice" });
const snippets = fts
	.prepare("SELECT snippet(e, 1, '[', ']', '...', 8) AS s FROM e WHERE e MATCH $m ORDER BY bm25(e, 5.0, 1.0)")
	.all<{ s: string }>({ $m: "caching" });
fts.close();

const bare = await openSqlite(":memory:", { bareNamedParameters: true });
bare.exec("CREATE TABLE t (name TEXT, n INTEGER)");
bare.prepare("INSERT INTO t VALUES ($name, $n)").run({ name: "a", n: 2 });
const rows = bare.prepare("SELECT name, n FROM t").all<{ name: string; n: number }>();
bare.close();

console.log(
	JSON.stringify({
		runtime: typeof Bun === "undefined" ? "node" : "bun",
		emitWarningRestored: process.emitWarning === original,
		snippets,
		rows,
	}),
);
