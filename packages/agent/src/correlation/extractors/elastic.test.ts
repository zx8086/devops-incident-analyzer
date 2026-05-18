// packages/agent/src/correlation/extractors/elastic.test.ts
// SIO-785 follow-up (2026-05-18): minimal Elastic extractor surfaces synthetic
// monitor status. Tests mirror the SOUL-mandated cross-check pattern (SIO-717).
import { describe, expect, test } from "bun:test";
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
