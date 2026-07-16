// apps/web/src/lib/components/CouchbaseFindingsCard.test.ts
// SIO-776: typed couchbase findings render inline in chat.
import { describe, expect, test } from "bun:test";
import { render } from "svelte/server";
import CouchbaseFindingsCard from "./CouchbaseFindingsCard.svelte";

describe("CouchbaseFindingsCard.svelte", () => {
	test("renders nothing when findings has no slowQueries", () => {
		const { body } = render(CouchbaseFindingsCard, { props: { findings: {} } });
		expect(body).not.toContain("Couchbase findings");
		expect(body).not.toContain("Slow queries");
	});

	test("renders nothing when slowQueries is empty array", () => {
		const { body } = render(CouchbaseFindingsCard, { props: { findings: { slowQueries: [] } } });
		expect(body).not.toContain("Couchbase findings");
	});

	test("renders one slow query with statement + avgServiceTime + runs", () => {
		const { body } = render(CouchbaseFindingsCard, {
			props: {
				findings: {
					slowQueries: [
						{
							statement: "SELECT v.* FROM `default` v WHERE v.type = 'article' OFFSET 100000",
							avgServiceTime: "9.93s",
							queries: 1,
						},
					],
				},
			},
		});
		expect(body).toContain("Couchbase findings");
		expect(body).toContain("Slow queries");
		expect(body).toContain("SELECT v.*");
		expect(body).toContain("9.93s");
		expect(body).toContain("×1");
	});

	test("sorts queries by avgServiceTime descending", () => {
		const { body } = render(CouchbaseFindingsCard, {
			props: {
				findings: {
					slowQueries: [
						{ statement: "SELECT FAST", avgServiceTime: "120ms" },
						{ statement: "SELECT SLOW", avgServiceTime: "9.93s" },
						{ statement: "SELECT MEDIUM", avgServiceTime: "1.5s" },
					],
				},
			},
		});
		// Confirm ordering by index in serialized HTML.
		const slow = body.indexOf("SELECT SLOW");
		const medium = body.indexOf("SELECT MEDIUM");
		const fast = body.indexOf("SELECT FAST");
		expect(slow).toBeGreaterThan(-1);
		expect(medium).toBeGreaterThan(slow);
		expect(fast).toBeGreaterThan(medium);
	});

	test("renders unscoped badge and explanatory line when unscoped is true", () => {
		const { body } = render(CouchbaseFindingsCard, {
			props: {
				findings: {
					unscoped: true,
					slowQueries: [{ statement: "SELECT v.* FROM `default` v", avgServiceTime: "9.93s" }],
				},
			},
		});
		expect(body).toContain("Unscoped");
		expect(body).toContain("No slow query referenced the focus services -- showing top cluster-wide queries.");
	});

	test("does not render unscoped badge or explanatory line without the flag", () => {
		const { body } = render(CouchbaseFindingsCard, {
			props: {
				findings: {
					slowQueries: [{ statement: "SELECT v.* FROM `default` v", avgServiceTime: "9.93s" }],
				},
			},
		});
		expect(body).toContain("Couchbase findings");
		expect(body).not.toContain("Unscoped");
		expect(body).not.toContain("No slow query referenced the focus services");
	});

	test("handles missing avgServiceTime gracefully (em-dash placeholder)", () => {
		const { body } = render(CouchbaseFindingsCard, {
			props: {
				findings: {
					slowQueries: [{ statement: "SELECT ANY", queries: 5 }],
				},
			},
		});
		expect(body).toContain("SELECT ANY");
		expect(body).toContain("—");
		expect(body).toContain("×5");
	});
});
