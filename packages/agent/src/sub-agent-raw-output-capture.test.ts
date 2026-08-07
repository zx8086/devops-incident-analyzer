// agent/src/sub-agent-raw-output-capture.test.ts

import { describe, expect, test } from "bun:test";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { extractElasticFindings } from "./correlation/extractors/elastic.ts";
import { extractKafkaFindings } from "./correlation/extractors/kafka.ts";
import { buildPersistedToolOutput, normalizeToolContent } from "./sub-agent.ts";
import { instrumentTools, type RawToolOutput } from "./sub-agent-instrumentation.ts";

// SIO-1248: end-to-end guard for the decoupling.
//
// Before this change the in-flight cap and the persisted cap were in SERIES --
// toolOutputs[] was derived from response.messages, i.e. the POST-truncation
// ToolMessages. That forced one payload to serve two consumers with opposite
// needs, so `elasticsearch_search` was exempted from truncation entirely and a
// 233KB search result (~58k tokens) flowed straight into the ReAct context.
// Six of those blew the 200k window (live run 2026-07-27, thread sio1247-verify).
//
// The contract now: the LLM sees a capped copy; the extractor sees everything.

const MONITOR_COUNT = 900;
const DOWN_EVERY = 7;

function syntheticsPayload(): string {
	const hits = Array.from({ length: MONITOR_COUNT }, (_, i) => ({
		_index: "synthetics-http-default",
		_id: `id-${i}`,
		_source: {
			monitor: { id: `m-${i}`, status: i % DOWN_EVERY === 0 ? "down" : "up", name: `mon-${i}`, type: "http" },
			observer: { geo: { name: "eu-west-1" } },
			"@timestamp": "2026-07-27T10:00:00Z",
			url: { full: `https://example.com/very/long/path/segment/${i}` },
		},
	}));
	return JSON.stringify({ hits: { total: { value: MONITOR_COUNT }, hits } });
}

const EXPECTED_DOWN = Array.from({ length: MONITOR_COUNT }, (_, i) => i).filter((i) => i % DOWN_EVERY === 0).length;

describe("SIO-1248 in-flight cap vs persisted fidelity", () => {
	test("bounds the LLM copy while the extractor still sees every monitor", async () => {
		const payload = syntheticsPayload();
		// Well above the 131_072 production default, mirroring the live failure.
		expect(Buffer.byteLength(payload, "utf8")).toBeGreaterThan(131_072);

		const rawOutputs: RawToolOutput[] = [];
		const fake = tool(async () => payload, {
			name: "elasticsearch_search",
			description: "x",
			schema: z.object({}),
		});
		const wrapped = instrumentTools([fake], {
			dataSourceId: "elastic",
			log: { info: () => {}, warn: () => {} },
			capBytes: 131_072,
			rawOutputs,
		})[0];
		if (!wrapped) throw new Error("instrumentTools returned empty array");

		const llmFacing = await wrapped.invoke({
			id: "c",
			name: "elasticsearch_search",
			args: {},
			type: "tool_call",
		});
		const llmText = normalizeToolContent((llmFacing as { content: unknown }).content);

		// 1. The ReAct context is bounded -- this is the actual overflow fix.
		expect(Buffer.byteLength(llmText, "utf8")).toBeLessThanOrEqual(131_072);
		// The model still learns the result was reduced and how much it covered.
		const llmParsed = JSON.parse(llmText) as { hits: { _truncated?: boolean; _totalHits?: number } };
		expect(llmParsed.hits._truncated).toBe(true);
		expect(llmParsed.hits._totalHits).toBe(MONITOR_COUNT);

		// 2. The persisted/extractor path keeps full fidelity via the raw capture.
		expect(rawOutputs).toHaveLength(1);
		const persisted = buildPersistedToolOutput(
			rawOutputs[0]?.toolName ?? "unknown",
			normalizeToolContent(rawOutputs[0]?.content),
			65_536,
		);
		const findings = extractElasticFindings([
			{ toolName: "elasticsearch_search", rawJson: persisted.rawJson },
		] as never);

		expect(findings.syntheticMonitors).toHaveLength(MONITOR_COUNT);
		expect(findings.syntheticMonitors?.filter((m) => m.status === "down")).toHaveLength(EXPECTED_DOWN);
	});

	test("regression: deriving toolOutputs from the capped LLM copy loses coverage", async () => {
		// Pins WHY the raw capture is required. This is the old series behaviour:
		// feeding the truncated in-flight text into the persistence path collapses
		// 900 monitors to the truncator's fixed HITS_KEEP slice.
		const payload = syntheticsPayload();
		const wrapped = instrumentTools(
			[tool(async () => payload, { name: "elasticsearch_search", description: "x", schema: z.object({}) })],
			{ dataSourceId: "elastic", log: { info: () => {}, warn: () => {} }, capBytes: 131_072 },
		)[0];
		if (!wrapped) throw new Error("instrumentTools returned empty array");

		const capped = await wrapped.invoke({ id: "c", name: "elasticsearch_search", args: {}, type: "tool_call" });
		const persisted = buildPersistedToolOutput(
			"elasticsearch_search",
			normalizeToolContent((capped as { content: unknown }).content),
			65_536,
		);
		const findings = extractElasticFindings([
			{ toolName: "elasticsearch_search", rawJson: persisted.rawJson },
		] as never);

		expect(findings.syntheticMonitors?.length ?? 0).toBeLessThan(MONITOR_COUNT);
	});
});

describe("SIO-1425/1437 structuredContent capture", () => {
	test("captures ToolMessage.artifact's mcp_structured_content alongside text content", async () => {
		const structured = { groupId: "g1", totalLag: "42", topics: [] };
		const fake = tool(
			async () => [JSON.stringify(structured), [{ type: "mcp_structured_content", data: structured }]],
			{
				name: "kafka_get_consumer_group_lag",
				description: "x",
				schema: z.object({}),
				responseFormat: "content_and_artifact",
			},
		);

		const rawOutputs: RawToolOutput[] = [];
		const wrapped = instrumentTools([fake], {
			dataSourceId: "kafka",
			log: { info: () => {}, warn: () => {} },
			rawOutputs,
		})[0];
		if (!wrapped) throw new Error("instrumentTools returned empty array");

		await wrapped.invoke({ id: "c", name: "kafka_get_consumer_group_lag", args: {}, type: "tool_call" });

		expect(rawOutputs).toHaveLength(1);
		expect(rawOutputs[0]?.structuredContent).toEqual(structured);
	});

	test("leaves structuredContent undefined when the tool has no artifact", async () => {
		const fake = tool(async () => "plain text result", {
			name: "gitlab_get_blame",
			description: "x",
			schema: z.object({}),
		});

		const rawOutputs: RawToolOutput[] = [];
		const wrapped = instrumentTools([fake], {
			dataSourceId: "gitlab",
			log: { info: () => {}, warn: () => {} },
			rawOutputs,
		})[0];
		if (!wrapped) throw new Error("instrumentTools returned empty array");

		await wrapped.invoke({ id: "c", name: "gitlab_get_blame", args: {}, type: "tool_call" });

		expect(rawOutputs).toHaveLength(1);
		expect(rawOutputs[0]?.structuredContent).toBeUndefined();
	});

	// A malformed/unrecognized artifact array is a DIFFERENT code path from an absent
	// artifact: an absent artifact exits extractStructuredContent before Array.isArray,
	// while an artifact array with no matching entry runs the full safeParse loop and
	// falls through to undefined. Exercises that fall-through explicitly.
	test("leaves structuredContent undefined when the artifact array has no matching entry", async () => {
		const structured = { groupId: "g1", totalLag: "42", topics: [] };
		const fake = tool(async () => ["plain text result", [{ type: "other", data: structured }]], {
			name: "kafka_get_consumer_group_lag",
			description: "x",
			schema: z.object({}),
			responseFormat: "content_and_artifact",
		});

		const rawOutputs: RawToolOutput[] = [];
		const wrapped = instrumentTools([fake], {
			dataSourceId: "kafka",
			log: { info: () => {}, warn: () => {} },
			rawOutputs,
		})[0];
		if (!wrapped) throw new Error("instrumentTools returned empty array");

		await wrapped.invoke({ id: "c", name: "kafka_get_consumer_group_lag", args: {}, type: "tool_call" });

		expect(rawOutputs).toHaveLength(1);
		expect(rawOutputs[0]?.structuredContent).toBeUndefined();
	});

	test("end-to-end: kafka_get_consumer_group_lag structuredContent reaches extractKafkaFindings identically to text re-parse", async () => {
		const structured = {
			groupId: "checkout-workers",
			groupState: "Stable",
			totalLag: "150",
			topics: [
				{
					topic: "orders",
					partitions: [
						{
							partition: 0,
							committedOffset: "100",
							latestOffset: "250",
							lag: "150",
						},
					],
					totalLag: "150",
				},
			],
		};
		const fake = tool(
			async () => [JSON.stringify(structured), [{ type: "mcp_structured_content", data: structured }]],
			{
				name: "kafka_get_consumer_group_lag",
				description: "x",
				schema: z.object({}),
				responseFormat: "content_and_artifact",
			},
		);

		const rawOutputs: RawToolOutput[] = [];
		const wrapped = instrumentTools([fake], {
			dataSourceId: "kafka",
			log: { info: () => {}, warn: () => {} },
			rawOutputs,
		})[0];
		if (!wrapped) throw new Error("instrumentTools returned empty array");

		await wrapped.invoke({
			id: "c",
			name: "kafka_get_consumer_group_lag",
			args: {},
			type: "tool_call",
		});

		const raw = rawOutputs[0];
		if (!raw) throw new Error("no raw output captured");
		const normalizedText = normalizeToolContent(raw.content);

		const structuredPersisted = buildPersistedToolOutput(raw.toolName, normalizedText, 65_536, raw.structuredContent);
		// The no-drift contract this whole feature depends on: the structured route and the
		// pre-existing text-reparse route (structuredContent explicitly undefined, same
		// underlying text) must produce byte-identical extractor output.
		const textPersisted = buildPersistedToolOutput(raw.toolName, normalizedText, 65_536, undefined);

		const structuredFindings = extractKafkaFindings([
			{ toolName: "kafka_get_consumer_group_lag", rawJson: structuredPersisted.rawJson },
		] as never);
		const textFindings = extractKafkaFindings([
			{ toolName: "kafka_get_consumer_group_lag", rawJson: textPersisted.rawJson },
		] as never);

		expect(structuredFindings).toEqual(textFindings);
		expect(structuredFindings.consumerGroups).toHaveLength(1);
		expect(structuredFindings.consumerGroups?.[0]?.id).toBe("checkout-workers");
		expect(structuredFindings.consumerGroups?.[0]?.totalLag).toBe(150);
	});
});
