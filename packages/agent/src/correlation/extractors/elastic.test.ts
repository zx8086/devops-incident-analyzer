// packages/agent/src/correlation/extractors/elastic.test.ts
// SIO-785 follow-up (2026-05-18): minimal Elastic extractor surfaces synthetic
// monitor status. Tests mirror the SOUL-mandated cross-check pattern (SIO-717).

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ToolOutput } from "@devops-agent/shared";
import { extractElasticFindings } from "./elastic.ts";

describe("extractElasticFindings", () => {
	test("returns empty when no elasticsearch_search outputs are present", () => {
		const outputs: ToolOutput[] = [{ toolName: "kafka_list_topics", rawJson: { topics: [] } }];
		expect(extractElasticFindings(outputs)).toEqual({});
	});

	test("parses one synthetic monitor hit (real ES response shape)", () => {
		const outputs: ToolOutput[] = [
			{
				toolName: "elasticsearch_search",
				rawJson: {
					hits: {
						hits: [
							{
								_source: {
									monitor: { name: "ksql-prd-healthcheck", status: "up" },
									url: { full: "https://ksql.prd.shared-services.eu.pvh.cloud/healthcheck" },
									"@timestamp": "2026-05-18T07:23:18.000Z",
									observer: { geo: { name: "eu-central-1a" } },
								},
							},
						],
					},
				},
			},
		];
		const findings = extractElasticFindings(outputs);
		expect(findings.syntheticMonitors).toEqual([
			{
				name: "ksql-prd-healthcheck",
				status: "up",
				url: "https://ksql.prd.shared-services.eu.pvh.cloud/healthcheck",
				observedAt: "2026-05-18T07:23:18.000Z",
				geo: "eu-central-1a",
			},
		]);
	});

	test("dedupes by monitor name (keeps first / most-recent doc)", () => {
		const outputs: ToolOutput[] = [
			{
				toolName: "elasticsearch_search",
				rawJson: {
					hits: {
						hits: [
							{
								_source: {
									monitor: { name: "kafka-prd-healthcheck", status: "up" },
									"@timestamp": "2026-05-18T07:30:00.000Z",
								},
							},
							{
								_source: {
									monitor: { name: "kafka-prd-healthcheck", status: "down" },
									"@timestamp": "2026-05-18T07:00:00.000Z",
								},
							},
						],
					},
				},
			},
		];
		const findings = extractElasticFindings(outputs);
		expect(findings.syntheticMonitors).toHaveLength(1);
		expect(findings.syntheticMonitors?.[0]?.status).toBe("up"); // most-recent wins
	});

	test("skips hits whose _source lacks monitor.status", () => {
		const outputs: ToolOutput[] = [
			{
				toolName: "elasticsearch_search",
				rawJson: {
					hits: {
						hits: [
							{ _source: { some_other_index_doc: true } },
							{
								_source: {
									monitor: { name: "valid-monitor", status: "up" },
								},
							},
						],
					},
				},
			},
		];
		const findings = extractElasticFindings(outputs);
		expect(findings.syntheticMonitors).toHaveLength(1);
		expect(findings.syntheticMonitors?.[0]?.name).toBe("valid-monitor");
	});

	test("ignores malformed JSON-envelope elasticsearch_search outputs", () => {
		const outputs: ToolOutput[] = [{ toolName: "elasticsearch_search", rawJson: { not: "an es response" } }];
		expect(extractElasticFindings(outputs)).toEqual({});
	});

	test("returns empty for a string rawJson with no Document ID markers", () => {
		const outputs: ToolOutput[] = [
			{ toolName: "elasticsearch_search", rawJson: "string response" },
			{ toolName: "elasticsearch_search", rawJson: "" },
			{ toolName: "elasticsearch_search", rawJson: "Total results: 10000, showing 0 from position 0" },
		];
		expect(extractElasticFindings(outputs)).toEqual({});
	});

	test("parses synthetic monitors from real text-block MCP response (string rawJson)", () => {
		const realResponse = [
			"Total results: 10000, showing 2 from position 0",
			"",
			"Document ID: AbcXyz",
			"Score: 1",
			"",
			'agent: {\n  "name": "job-1",\n  "type": "heartbeat"\n}',
			'monitor: {\n  "origin": "ui",\n  "name": "https://example.com/page",\n  "id": "mon-uuid-1",\n  "type": "browser",\n  "status": "down"\n}',
			'url: {\n  "full": "https://example.com/page"\n}',
			'observer: {\n  "geo": {\n    "name": "Europe - Germany"\n  },\n  "name": "europe-west3-a"\n}',
			"@timestamp: 2026-05-18T14:58:52.969Z",
		].join("\n");

		const outputs: ToolOutput[] = [{ toolName: "elasticsearch_search", rawJson: realResponse }];
		const findings = extractElasticFindings(outputs);
		expect(findings.syntheticMonitors).toHaveLength(1);
		expect(findings.syntheticMonitors?.[0]).toEqual({
			name: "https://example.com/page",
			status: "down",
			url: "https://example.com/page",
			observedAt: "2026-05-18T14:58:52.969Z",
			geo: "Europe - Germany",
		});
	});

	test("falls back to summary.status when monitor.status is missing", () => {
		const realResponse = [
			"Document ID: AbcXyz",
			"",
			'monitor: {\n  "name": "https://example.com/x",\n  "id": "mon-uuid-2",\n  "type": "browser"\n}',
			'summary: {\n  "up": 0,\n  "down": 1,\n  "status": "down"\n}',
			"@timestamp: 2026-05-18T14:58:52.969Z",
		].join("\n");
		const outputs: ToolOutput[] = [{ toolName: "elasticsearch_search", rawJson: realResponse }];
		const findings = extractElasticFindings(outputs);
		expect(findings.syntheticMonitors?.[0]?.status).toBe("down");
	});

	test("falls back to state.status when monitor.status AND summary.status are missing", () => {
		const realResponse = [
			"Document ID: AbcXyz",
			"",
			'monitor: {\n  "name": "https://example.com/y",\n  "id": "mon-uuid-3"\n}',
			'state: {\n  "up": 0,\n  "down": 4323,\n  "status": "down"\n}',
		].join("\n");
		const outputs: ToolOutput[] = [{ toolName: "elasticsearch_search", rawJson: realResponse }];
		const findings = extractElasticFindings(outputs);
		expect(findings.syntheticMonitors?.[0]?.status).toBe("down");
	});

	test("dedupes by monitor.id (not name) across multiple Document blocks", () => {
		// Two heartbeat records for the same monitor.id — first wins (most-recent).
		const realResponse = [
			"Document ID: First",
			"",
			'monitor: {\n  "name": "https://example.com/z",\n  "id": "shared-uuid",\n  "status": "up"\n}',
			"@timestamp: 2026-05-18T15:00:00.000Z",
			"",
			"Document ID: Second",
			"",
			'monitor: {\n  "name": "https://example.com/z",\n  "id": "shared-uuid",\n  "status": "down"\n}',
			"@timestamp: 2026-05-18T14:00:00.000Z",
		].join("\n");
		const outputs: ToolOutput[] = [{ toolName: "elasticsearch_search", rawJson: realResponse }];
		const findings = extractElasticFindings(outputs);
		expect(findings.syntheticMonitors).toHaveLength(1);
		expect(findings.syntheticMonitors?.[0]?.status).toBe("up"); // first wins
	});

	test("parses against the captured live fixture", async () => {
		const fs = await import("node:fs/promises");
		const path = await import("node:path");
		const fixturePath = path.join(import.meta.dir, "__fixtures__", "elastic-synthetics-real.txt");
		const realResponse = await fs.readFile(fixturePath, "utf-8");
		const outputs: ToolOutput[] = [{ toolName: "elasticsearch_search", rawJson: realResponse }];
		const findings = extractElasticFindings(outputs);
		// Real fixture has at least one parseable monitor record.
		expect((findings.syntheticMonitors ?? []).length).toBeGreaterThan(0);
		// Every parsed monitor has a name and a status string.
		for (const m of findings.syntheticMonitors ?? []) {
			expect(typeof m.name).toBe("string");
			expect(m.name.length).toBeGreaterThan(0);
			expect(typeof m.status).toBe("string");
			expect(m.status.length).toBeGreaterThan(0);
		}
	});
});

// SIO-787 (SIO-778 Phase B): APM service aggregation extraction from
// `elasticsearch_search` against the `traces-apm-*` index pattern.
describe("extractElasticFindings — APM services (SIO-787)", () => {
	test("parses APM aggregation buckets from real eu-b2b text-block fixture", async () => {
		const fs = await import("node:fs/promises");
		const path = await import("node:path");
		const fixturePath = path.join(import.meta.dir, "__fixtures__", "elastic-apm-services-real.txt");
		const realResponse = await fs.readFile(fixturePath, "utf-8");
		const outputs: ToolOutput[] = [
			{
				toolName: "elasticsearch_search",
				toolArgs: { deployment: "eu-b2b", index: "traces-apm-*" },
				rawJson: realResponse,
			} as ToolOutput,
		];
		const findings = extractElasticFindings(outputs);
		// Real fixture captured 50 buckets from eu-b2b.
		expect(findings.apmServices).toBeDefined();
		expect(findings.apmServices?.length).toBe(50);
		// Phase A path must not fire — fixture has no synthetic monitor docs.
		expect(findings.syntheticMonitors).toBeUndefined();
		// Spot-check two well-known buckets from the live capture.
		const martech = findings.apmServices?.find((s) => s.serviceName === "martech-contact");
		expect(martech).toBeDefined();
		expect(martech?.transactionCount).toBe(57247);
		expect(martech?.errorRate).toBeCloseTo(0.1321, 3);
		expect(martech?.avgDurationMs).toBeCloseTo(93.83, 1);
		expect(martech?.observedAt).toBe("2026-05-18T16:33:17.266Z");

		const connectors = findings.apmServices?.find((s) => s.serviceName === "connectors-api");
		expect(connectors?.errorRate).toBeCloseTo(0.0716, 3);
		expect(connectors?.avgDurationMs).toBeCloseTo(345.3, 1);
	});

	test("preserves eu-b2b plural service-name form verbatim (reference_b2b_apm_service_naming)", () => {
		// The eu-b2b APM index stores plural service names (`notifications-service`)
		// while kafka consumer groups use the singular form. The extractor must
		// not normalise — that responsibility belongs to a future Phase D rule
		// helper (`getElasticApmService`) per SIO-778 spec lines 196-207.
		const rawJson =
			"Search results with aggregations:\n\n" +
			JSON.stringify({
				by_service: {
					buckets: [
						{
							key: "notifications-service",
							doc_count: 10000,
							errors: { doc_count: 50 },
							avg_duration: { value: 100000 },
							latest: { value_as_string: "2026-05-18T16:00:00.000Z" },
						},
					],
				},
			});
		const outputs: ToolOutput[] = [
			{
				toolName: "elasticsearch_search",
				toolArgs: { deployment: "eu-b2b", index: "traces-apm-*" },
				rawJson,
			} as ToolOutput,
		];
		const findings = extractElasticFindings(outputs);
		expect(findings.apmServices?.[0]?.serviceName).toBe("notifications-service");
	});

	test("skips errorRate when doc_count is zero (divide-by-zero guard)", () => {
		const rawJson =
			"Search results with aggregations:\n\n" +
			JSON.stringify({
				by_service: {
					buckets: [
						{
							key: "idle-service",
							doc_count: 0,
							errors: { doc_count: 0 },
							avg_duration: { value: null },
						},
					],
				},
			});
		const outputs: ToolOutput[] = [
			{
				toolName: "elasticsearch_search",
				toolArgs: { index: "traces-apm-*" },
				rawJson,
			} as ToolOutput,
		];
		const findings = extractElasticFindings(outputs);
		expect(findings.apmServices?.[0]?.serviceName).toBe("idle-service");
		expect(findings.apmServices?.[0]?.transactionCount).toBe(0);
		expect(findings.apmServices?.[0]?.errorRate).toBeUndefined();
		expect(findings.apmServices?.[0]?.avgDurationMs).toBeUndefined();
	});

	test("converts avg_duration.value from microseconds to milliseconds", () => {
		const rawJson =
			"Search results with aggregations:\n\n" +
			JSON.stringify({
				by_service: {
					buckets: [
						{
							key: "fast-service",
							doc_count: 100,
							errors: { doc_count: 0 },
							avg_duration: { value: 1_500_000 }, // 1.5s in µs
						},
					],
				},
			});
		const outputs: ToolOutput[] = [
			{
				toolName: "elasticsearch_search",
				toolArgs: { index: "traces-apm-*" },
				rawJson,
			} as ToolOutput,
		];
		const findings = extractElasticFindings(outputs);
		expect(findings.apmServices?.[0]?.avgDurationMs).toBe(1500);
	});

	test("returns empty apmServices when aggregation object is missing", () => {
		const outputs: ToolOutput[] = [
			{
				toolName: "elasticsearch_search",
				toolArgs: { index: "traces-apm-*" },
				rawJson: "Search results with aggregations:\n\n{}",
			} as ToolOutput,
		];
		const findings = extractElasticFindings(outputs);
		expect(findings.apmServices).toBeUndefined();
	});

	test("does not fire on a generic logs-* search (no false positives)", () => {
		// A logs-* search returns hits[].source documents, not aggregations.
		// The extractor must not infer APM intent from a hits payload.
		const outputs: ToolOutput[] = [
			{
				toolName: "elasticsearch_search",
				toolArgs: { index: "logs-*" },
				rawJson: {
					hits: {
						hits: [{ _source: { message: "error: timeout", level: "error" } }],
					},
				},
			} as ToolOutput,
		];
		const findings = extractElasticFindings(outputs);
		expect(findings.apmServices).toBeUndefined();
	});

	test("Phase A synthetic-monitor fixture still parses without spurious apmServices", async () => {
		// Regression guard: parsing the Phase A fixture must yield syntheticMonitors
		// and zero apmServices, even though the text contains the literal substring
		// "by_service" in some monitor configurations (it does not in this fixture,
		// but the test pins the behavior).
		const fs = await import("node:fs/promises");
		const path = await import("node:path");
		const fixturePath = path.join(import.meta.dir, "__fixtures__", "elastic-synthetics-real.txt");
		const realResponse = await fs.readFile(fixturePath, "utf-8");
		const outputs: ToolOutput[] = [
			{
				toolName: "elasticsearch_search",
				toolArgs: { index: "synthetics-*" },
				rawJson: realResponse,
			} as ToolOutput,
		];
		const findings = extractElasticFindings(outputs);
		expect((findings.syntheticMonitors ?? []).length).toBeGreaterThan(0);
		expect(findings.apmServices).toBeUndefined();
	});

	test("accepts JSON-envelope form with aggregations.by_service at root", () => {
		// When the MCP response is already a parsed object (no text-block prefix),
		// the extractor must walk rawJson.aggregations.by_service.buckets[].
		const outputs: ToolOutput[] = [
			{
				toolName: "elasticsearch_search",
				toolArgs: { index: "traces-apm-*" },
				rawJson: {
					aggregations: {
						by_service: {
							buckets: [
								{
									key: "envelope-svc",
									doc_count: 1000,
									errors: { doc_count: 10 },
									avg_duration: { value: 200_000 },
									latest: { value_as_string: "2026-05-18T16:00:00.000Z" },
								},
							],
						},
					},
				},
			} as ToolOutput,
		];
		const findings = extractElasticFindings(outputs);
		expect(findings.apmServices?.[0]?.serviceName).toBe("envelope-svc");
		expect(findings.apmServices?.[0]?.errorRate).toBeCloseTo(0.01, 4);
		expect(findings.apmServices?.[0]?.avgDurationMs).toBe(200);
	});
});

// SIO-788 (SIO-778 Phase C): log-cluster extractor tests. Synthetic-fixture
// driven; live eu-b2b capture deferred per session decision (see ticket
// "Preconditions"). When the real fixture lands, add a fixture-driven happy
// path test that loads __fixtures__/elastic-log-clusters-real.txt and asserts
// >=2 clusters, sorted by count desc, capped at 10.
describe("extractElasticFindings — log clusters (SIO-788)", () => {
	function logsResponse(hits: Array<Record<string, unknown>>, index = "logs-app-*"): ToolOutput {
		return {
			toolName: "elasticsearch_search",
			toolArgs: { index },
			rawJson: { hits: { hits: hits.map((_source) => ({ _source })) } },
		} as unknown as ToolOutput;
	}

	test("signature is deterministic across calls for the same distinctive-token set", () => {
		const a = logsResponse([
			{
				message: "Database connection timeout after 30000 ms for tenant abc-123",
				level: "error",
				service: "payments-service",
				"@timestamp": "2026-05-18T10:00:00.000Z",
			},
		]);
		const b = logsResponse([
			{
				message: "Database connection timeout after 30000 ms for tenant abc-123",
				level: "error",
				service: "payments-service",
				"@timestamp": "2026-05-18T10:05:00.000Z",
			},
		]);
		const sigA = extractElasticFindings([a]).logClusters?.[0]?.signature;
		const sigB = extractElasticFindings([b]).logClusters?.[0]?.signature;
		expect(sigA).toBeDefined();
		expect(sigA).toBe(sigB);
		expect(sigA).toMatch(/^[0-9a-f]{16}$/);
	});

	test("collapses noisy variations that differ only in numbers/short tokens", () => {
		const output = logsResponse([
			{
				message: "Database connection timeout after 30000 ms for tenant abc-001",
				level: "error",
				"@timestamp": "2026-05-18T10:00:00.000Z",
			},
			{
				message: "Database connection timeout after 45000 ms for tenant xyz-999",
				level: "error",
				"@timestamp": "2026-05-18T10:01:00.000Z",
			},
			{
				message: "Different error entirely: cache eviction loop runaway repeating",
				level: "error",
				"@timestamp": "2026-05-18T10:02:00.000Z",
			},
		]);
		const findings = extractElasticFindings([output]);
		expect(findings.logClusters?.length).toBe(2);
		const top = findings.logClusters?.find((c) => c.count === 2);
		expect(top?.count).toBe(2);
		expect(top?.sampleMessage).toBe("Database connection timeout after 30000 ms for tenant abc-001");
	});

	test("service field uses modal value when one covers >=50% of hits; omitted otherwise", () => {
		const dominant = logsResponse([
			{ message: "Repeating distinctive failure pattern xyzzy", service: "svc-a" },
			{ message: "Repeating distinctive failure pattern xyzzy", service: "svc-a" },
			{ message: "Repeating distinctive failure pattern xyzzy", service: "svc-a" },
			{ message: "Repeating distinctive failure pattern xyzzy", service: "svc-b" },
		]);
		const a = extractElasticFindings([dominant]).logClusters?.[0];
		expect(a?.service).toBe("svc-a");

		// 1/3 split: top value covers only 33% — below the 50% threshold.
		const minority = logsResponse([
			{ message: "Yet another distinctive failure pattern quuux", service: "svc-a" },
			{ message: "Yet another distinctive failure pattern quuux", service: "svc-b" },
			{ message: "Yet another distinctive failure pattern quuux", service: "svc-c" },
		]);
		const c = extractElasticFindings([minority]).logClusters?.[0];
		expect(c?.service).toBeUndefined();
	});

	test("firstSeen / lastSeen track min and max timestamps across the cluster", () => {
		const output = logsResponse([
			{
				message: "Repeating distinctive failure pattern xyzzy",
				"@timestamp": "2026-05-18T10:05:00.000Z",
			},
			{
				message: "Repeating distinctive failure pattern xyzzy",
				"@timestamp": "2026-05-18T10:01:00.000Z",
			},
			{
				message: "Repeating distinctive failure pattern xyzzy",
				"@timestamp": "2026-05-18T10:08:00.000Z",
			},
		]);
		const cluster = extractElasticFindings([output]).logClusters?.[0];
		expect(cluster?.firstSeen).toBe("2026-05-18T10:01:00.000Z");
		expect(cluster?.lastSeen).toBe("2026-05-18T10:08:00.000Z");
	});

	test("drops hits whose distinctive-token set is empty (pure stopwords / short tokens)", () => {
		const output = logsResponse([{ message: "the and or in of to as is it" }, { message: "404 500 200 ok yes no" }]);
		const findings = extractElasticFindings([output]);
		expect(findings.logClusters).toBeUndefined();
	});

	test("caps output at 10 clusters sorted by count desc", () => {
		const hits: Array<Record<string, unknown>> = [];
		const baseTokens = [
			"alpha_distinctive_failure_xyzzy_pattern",
			"bravo_distinctive_failure_xyzzy_pattern",
			"charlie_distinctive_failure_xyzzy_pattern",
			"delta_distinctive_failure_xyzzy_pattern",
			"echo_distinctive_failure_xyzzy_pattern",
			"foxtrot_distinctive_failure_xyzzy_pattern",
			"golf_distinctive_failure_xyzzy_pattern",
			"hotel_distinctive_failure_xyzzy_pattern",
			"india_distinctive_failure_xyzzy_pattern",
			"juliet_distinctive_failure_xyzzy_pattern",
			"kilo_distinctive_failure_xyzzy_pattern",
			"lima_distinctive_failure_xyzzy_pattern",
			"mike_distinctive_failure_xyzzy_pattern",
			"november_distinctive_failure_xyzzy_pattern",
			"oscar_distinctive_failure_xyzzy_pattern",
		];
		for (let i = 0; i < 5; i++) hits.push({ message: baseTokens[0] });
		for (let i = 1; i < baseTokens.length; i++) hits.push({ message: baseTokens[i] });
		const output = logsResponse(hits);
		const findings = extractElasticFindings([output]);
		expect(findings.logClusters?.length).toBe(10);
		expect(findings.logClusters?.[0]?.count).toBe(5);
		const others = findings.logClusters?.slice(1) ?? [];
		expect(others.every((c) => c.count === 1)).toBe(true);
	});

	test("does NOT fire when toolArgs.index points to traces-apm-* (mutual exclusion)", () => {
		const output: ToolOutput = {
			toolName: "elasticsearch_search",
			toolArgs: { index: "traces-apm-*" },
			rawJson: {
				hits: {
					hits: [
						{
							_source: {
								message: "Distinctive repeating failure pattern xyzzy that would cluster",
								level: "error",
							},
						},
					],
				},
			},
		} as unknown as ToolOutput;
		const findings = extractElasticFindings([output]);
		expect(findings.logClusters).toBeUndefined();
	});

	test("does NOT fire when toolArgs.index points to synthetics-* (mutual exclusion)", () => {
		const output: ToolOutput = {
			toolName: "elasticsearch_search",
			toolArgs: { index: "synthetics-prod-*" },
			rawJson: {
				hits: {
					hits: [
						{
							_source: {
								message: "Distinctive repeating failure pattern xyzzy that would cluster",
								level: "error",
							},
						},
					],
				},
			},
		} as unknown as ToolOutput;
		const findings = extractElasticFindings([output]);
		expect(findings.logClusters).toBeUndefined();
	});

	test("fires without an index hint when a majority of hits have level: error", () => {
		const output: ToolOutput = {
			toolName: "elasticsearch_search",
			toolArgs: {},
			rawJson: {
				hits: {
					hits: [
						{ _source: { message: "Distinctive repeating failure pattern xyzzy", level: "error" } },
						{ _source: { message: "Distinctive repeating failure pattern xyzzy", level: "error" } },
						{ _source: { message: "Distinctive repeating failure pattern xyzzy", level: "info" } },
					],
				},
			},
		} as unknown as ToolOutput;
		const findings = extractElasticFindings([output]);
		expect(findings.logClusters?.length).toBe(1);
		expect(findings.logClusters?.[0]?.count).toBe(3);
		expect(findings.logClusters?.[0]?.level).toBe("error");
	});

	test("Phase A / B no-regression: combined output produces all three populated arrays", () => {
		const synthetic: ToolOutput = {
			toolName: "elasticsearch_search",
			toolArgs: { index: "synthetics-prod-*" },
			rawJson: {
				hits: {
					hits: [
						{
							_source: {
								monitor: { name: "phase-a-monitor", status: "up" },
								"@timestamp": "2026-05-18T07:00:00.000Z",
							},
						},
					],
				},
			},
		} as unknown as ToolOutput;
		const apm: ToolOutput = {
			toolName: "elasticsearch_search",
			toolArgs: { index: "traces-apm-*" },
			rawJson: {
				aggregations: {
					by_service: {
						buckets: [
							{
								key: "phase-b-service",
								doc_count: 100,
								errors: { doc_count: 5 },
								avg_duration: { value: 250000 },
							},
						],
					},
				},
			},
		} as unknown as ToolOutput;
		const logs = logsResponse(
			[{ message: "Phase-c distinctive repeating failure pattern xyzzy", level: "error" }],
			"logs-app-*",
		);
		const findings = extractElasticFindings([synthetic, apm, logs]);
		expect(findings.syntheticMonitors?.length).toBe(1);
		expect(findings.apmServices?.length).toBe(1);
		expect(findings.logClusters?.length).toBe(1);
		expect(findings.syntheticMonitors?.[0]?.name).toBe("phase-a-monitor");
		expect(findings.apmServices?.[0]?.serviceName).toBe("phase-b-service");
	});

	test("parses against the captured live eu-b2b logs-* fixture", () => {
		const fixturePath = join(import.meta.dir, "__fixtures__", "elastic-log-clusters-real.txt");
		const realResponse = readFileSync(fixturePath, "utf-8");
		const outputs: ToolOutput[] = [
			{
				toolName: "elasticsearch_search",
				toolArgs: { index: "logs-*" },
				rawJson: realResponse,
			} as unknown as ToolOutput,
		];
		const findings = extractElasticFindings(outputs);
		const clusters = findings.logClusters ?? [];
		// Real fixture has 100 documents covering at least 2 distinct error patterns.
		expect(clusters.length).toBeGreaterThanOrEqual(2);
		// Top-K cap is 10.
		expect(clusters.length).toBeLessThanOrEqual(10);
		// Sorted by count desc.
		for (let i = 1; i < clusters.length; i++) {
			const prev = clusters[i - 1];
			const curr = clusters[i];
			if (prev && curr) expect(prev.count).toBeGreaterThanOrEqual(curr.count);
		}
		// Every cluster has a 16-char sha1-hex signature and a non-empty sample.
		for (const c of clusters) {
			expect(c.signature).toMatch(/^[0-9a-f]{16}$/);
			expect(c.sampleMessage.length).toBeGreaterThan(0);
		}
		// At least one cluster has its modal service resolved to a real eu-b2b
		// service-name string (e.g. "metricbeat"). The control-plane log entries
		// without `service.name` legitimately produce undefined; verify the
		// branch fires at all.
		expect(clusters.some((c) => typeof c.service === "string" && c.service.length > 0)).toBe(true);
	});
});
