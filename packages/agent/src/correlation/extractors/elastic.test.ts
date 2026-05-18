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

	test("ignores malformed elasticsearch_search outputs", () => {
		const outputs: ToolOutput[] = [
			{ toolName: "elasticsearch_search", rawJson: { not: "an es response" } },
			{ toolName: "elasticsearch_search", rawJson: "string response" },
		];
		expect(extractElasticFindings(outputs)).toEqual({});
	});
});
