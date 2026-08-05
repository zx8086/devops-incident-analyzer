// tests/unit/esql-async-search.test.ts
// SIO-1391: ES|QL + async search. Two behaviours carry real risk and are asserted here:
//   1. ES|QL returns COLUMN-oriented {columns, values}; we re-shape to rows keyed by column name,
//      because an LLM reading parallel arrays mis-aligns them.
//   2. An async search that is still running has NOT proven absence -- is_running/is_partial must
//      surface explicitly with a warning, never be flattened into a plausible-looking empty result.
import { describe, expect, test } from "bun:test";
import {
	registerAsyncSearchDeleteTool,
	registerAsyncSearchGetTool,
	registerAsyncSearchSubmitTool,
} from "../../src/tools/search/async_search.js";
import { registerEsqlQueryTool } from "../../src/tools/search/esql_query.js";

type Handler = (args: unknown, extra: unknown) => Promise<{ content: Array<{ text: string }> }>;
type Registrar = (server: never, client: never) => void;

// Captures the registered handler plus every outbound request, so tests assert what was actually
// sent to Elasticsearch rather than trusting the wrapper.
function harness(register: Registrar, esImpl: Record<string, unknown>) {
	const sent: Array<Record<string, unknown>> = [];
	const wrap = (fn: (req: Record<string, unknown>) => unknown) => async (req: Record<string, unknown>) => {
		sent.push(req);
		return fn(req);
	};
	const esClient = {
		esql: { query: wrap((esImpl.esqlQuery as (r: Record<string, unknown>) => unknown) ?? (() => ({}))) },
		asyncSearch: {
			submit: wrap((esImpl.submit as (r: Record<string, unknown>) => unknown) ?? (() => ({}))),
			get: wrap((esImpl.get as (r: Record<string, unknown>) => unknown) ?? (() => ({}))),
			delete: wrap((esImpl.del as (r: Record<string, unknown>) => unknown) ?? (() => ({}))),
		},
	} as never;

	let handler: Handler | undefined;
	const server = {
		registerTool: (_n: string, _c: unknown, h: Handler) => {
			handler = h;
			return {};
		},
	} as never;

	register(server, esClient);
	if (!handler) throw new Error("tool did not register");
	return { handler, sent };
}

const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0]?.text ?? "{}");

describe("elasticsearch_esql_query", () => {
	test("re-shapes column-oriented results into rows keyed by column name", async () => {
		// Live shape from eu-cld: {columns:[{name,type}], values:[[...]]}.
		const { handler } = harness(registerEsqlQueryTool as Registrar, {
			esqlQuery: () => ({
				took: 47,
				is_partial: false,
				columns: [
					{ name: "c", type: "long" },
					{ name: "log.level", type: "keyword" },
				],
				values: [
					[22382525411, null],
					[4911982507, "informational"],
				],
			}),
		});

		const out = parse(await handler({ query: "FROM logs-* | STATS c = COUNT(*) BY log.level | LIMIT 2" }, {}));

		expect(out.row_count).toBe(2);
		expect(out.rows[0]).toEqual({ c: 22382525411, "log.level": null });
		expect(out.rows[1]).toEqual({ c: 4911982507, "log.level": "informational" });
		// Column types are preserved rather than lost in the re-shape.
		expect(out.columns).toHaveLength(2);
	});

	test("surfaces is_partial so a partial result is not read as a complete answer", async () => {
		const { handler } = harness(registerEsqlQueryTool as Registrar, {
			esqlQuery: () => ({ is_partial: true, columns: [{ name: "a", type: "long" }], values: [[1]] }),
		});

		expect(parse(await handler({ query: "FROM logs-* | LIMIT 1" }, {})).is_partial).toBe(true);
	});

	test("rejects an empty query at validation, before any request", async () => {
		const { handler, sent } = harness(registerEsqlQueryTool as Registrar, { esqlQuery: () => ({}) });

		await expect(handler({ query: "" }, {})).rejects.toThrow(/Validation failed/);
		expect(sent).toHaveLength(0);
	});

	test("rejects a query with no LIMIT, before any request", async () => {
		// CodeRabbit (PR #596): the description told the model to LIMIT but nothing enforced it.
		// Verified live: a no-LIMIT ES|QL query really does return Elasticsearch's default 1000 rows.
		const { handler, sent } = harness(registerEsqlQueryTool as Registrar, { esqlQuery: () => ({}) });

		await expect(handler({ query: "FROM logs-* | KEEP @timestamp" }, {})).rejects.toThrow(/LIMIT/);
		expect(sent).toHaveLength(0);
	});

	test("accepts LIMIT-less shapes that are legitimately bounded (verified live)", async () => {
		// Deliberately NOT enforcing "must END with LIMIT" -- all of these work against a real
		// cluster, and the stricter rule would reject working queries to enforce a style preference.
		const cases = [
			"FROM logs-* | STATS c = COUNT(*)", // ungrouped agg -> 1 row (verified live)
			"FROM logs-* | KEEP @timestamp | LIMIT 5 | SORT @timestamp DESC", // LIMIT mid-pipeline
			"from logs-* | keep @timestamp | limit 2", // ES|QL keywords are case-insensitive
			"FROM logs-* | STATS c = COUNT(*) BY svc | LIMIT 10", // grouped, but explicitly limited
			"FROM logs-* | STATS c=COUNT(*) BY a | STATS t=SUM(c)", // regrouped down to one row
		];

		for (const query of cases) {
			const { handler, sent } = harness(registerEsqlQueryTool as Registrar, {
				esqlQuery: () => ({ columns: [], values: [] }),
			});
			await handler({ query }, {});
			expect(sent).toHaveLength(1);
		}
	});

	test("rejects aggregations that do NOT bound the row count", async () => {
		// CodeRabbit round 2 (PR #596): the first exemption was too broad. Verified live on eu-cld --
		// `STATS ... BY <field>` returns one row per GROUP (1000, the default cap) and INLINESTATS
		// annotates rows without reducing them (also 1000). Only an UNGROUPED stats bounds output.
		const cases = [
			"FROM logs-* | STATS c = COUNT(*) BY service.name",
			"FROM logs-* | stats c = count(*) by svc", // case-insensitive
			"FROM logs-* | KEEP @timestamp | INLINESTATS c = COUNT(*)",
		];

		for (const query of cases) {
			const { handler, sent } = harness(registerEsqlQueryTool as Registrar, { esqlQuery: () => ({}) });
			await expect(handler({ query }, {})).rejects.toThrow(/LIMIT/);
			expect(sent).toHaveLength(0);
		}
	});

	test("passes an optional pre-filter through to the request", async () => {
		const { handler, sent } = harness(registerEsqlQueryTool as Registrar, {
			esqlQuery: () => ({ columns: [], values: [] }),
		});

		await handler({ query: "FROM logs-* | LIMIT 1", filter: { range: { "@timestamp": { gte: "now-1h" } } } }, {});

		expect(JSON.stringify(sent[0]?.filter)).toContain("now-1h");
	});
});

describe("async search lifecycle", () => {
	test("submit sets keep_on_completion so a fast search is still retrievable by id", async () => {
		// Without keep_on_completion, a search finishing inside wait_for_completion_timeout is not
		// stored and the follow-up _get 404s -- the lifecycle would break precisely on fast queries.
		const { handler, sent } = harness(registerAsyncSearchSubmitTool as Registrar, {
			submit: () => ({ id: "abc", is_running: false, is_partial: false, response: {} }),
		});

		await handler({ index: "traces-apm*", size: 0, aggs: { a: { terms: { field: "x" } } } }, {});

		expect(sent[0]?.keep_on_completion).toBe(true);
		expect(sent[0]?.wait_for_completion_timeout).toBe("1s");
		expect(sent[0]?.keep_alive).toBe("5m");
	});

	test("warns while still running, and stops warning once complete", async () => {
		const running = harness(registerAsyncSearchSubmitTool as Registrar, {
			submit: () => ({ id: "abc", is_running: true, is_partial: true }),
		});
		const runningOut = parse(await running.handler({ index: "logs-*" }, {}));
		expect(runningOut.is_running).toBe(true);
		expect(runningOut._warning).toContain("INCOMPLETE");

		const done = harness(registerAsyncSearchGetTool as Registrar, {
			get: () => ({ id: "abc", is_running: false, is_partial: false, response: { aggregations: {} } }),
		});
		const doneOut = parse(await done.handler({ id: "abc" }, {}));
		expect(doneOut.is_running).toBe(false);
		expect(doneOut._warning).toBeUndefined();
	});

	test("get and delete require an id", async () => {
		const get = harness(registerAsyncSearchGetTool as Registrar, { get: () => ({}) });
		await expect(get.handler({ id: "" }, {})).rejects.toThrow(/Validation failed/);
		expect(get.sent).toHaveLength(0);

		const del = harness(registerAsyncSearchDeleteTool as Registrar, { del: () => ({ acknowledged: true }) });
		await expect(del.handler({}, {})).rejects.toThrow(/Validation failed/);
		expect(del.sent).toHaveLength(0);
	});

	test("delete passes the id through and returns the acknowledgement", async () => {
		const { handler, sent } = harness(registerAsyncSearchDeleteTool as Registrar, {
			del: () => ({ acknowledged: true }),
		});

		expect(parse(await handler({ id: "xyz" }, {})).acknowledged).toBe(true);
		expect(sent[0]?.id).toBe("xyz");
	});
});
