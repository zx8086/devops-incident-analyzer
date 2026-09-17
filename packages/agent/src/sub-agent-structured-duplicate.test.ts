// agent/src/sub-agent-structured-duplicate.test.ts
import { describe, expect, test } from "bun:test";
import { ToolMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { dropDuplicateStructuredContent, instrumentTools, type RawToolOutput } from "./sub-agent-instrumentation.ts";

// SIO-1774. Fixture shape taken from the LangSmith trace of run f77ce7dd (root run 01a0aed1):
// aws_cloudwatch_describe_alarms' ToolMessage content was a JSON STRING with top-level keys
// [type, text, structuredContent] -- 37.3 KB of text plus 38.6 KB of the same alarms again.
const alarms = Array.from({ length: 26 }, (_, i) => ({
	AlarmName: `svc-${i}-cpu-high`,
	StateValue: "ALARM",
	StateReason: "Threshold Crossed: 1 datapoint was greater than the threshold",
	MetricName: "CPUUtilization",
	Namespace: "AWS/ECS",
}));
const text = JSON.stringify({ MetricAlarms: alarms });
const wrapperString = JSON.stringify({ type: "text", text, structuredContent: { MetricAlarms: alarms } });

describe("dropDuplicateStructuredContent", () => {
	test("returns the text for the adapter's wrapper, as a string or as an object", () => {
		expect(dropDuplicateStructuredContent(wrapperString)).toBe(text);
		expect(dropDuplicateStructuredContent(JSON.parse(wrapperString))).toBe(text);
		expect(
			dropDuplicateStructuredContent(JSON.stringify({ type: "text", text, structuredContent: {}, meta: { a: 1 } })),
		).toBe(text);
	});

	test("leaves everything that is not exactly that wrapper alone", () => {
		expect(dropDuplicateStructuredContent(text)).toBeNull(); // an ordinary JSON result
		expect(dropDuplicateStructuredContent("plain words")).toBeNull();
		expect(dropDuplicateStructuredContent([{ type: "text", text }])).toBeNull(); // multi-block content
		expect(dropDuplicateStructuredContent({ type: "text", text })).toBeNull(); // no structured copy
		// A tool whose OWN payload has these keys plus others is data, not the wrapper.
		expect(
			dropDuplicateStructuredContent(JSON.stringify({ type: "text", text: "x", structuredContent: {}, hits: 3 })),
		).toBeNull();
		expect(dropDuplicateStructuredContent('{"structuredContent": broken')).toBeNull();
	});
});

describe("instrumentTools with a structured-output tool", () => {
	test("the model reads the payload once; capture and structuredContent are untouched", async () => {
		const artifact = [{ type: "mcp_structured_content", data: { MetricAlarms: alarms } }];
		const describeAlarms = tool(
			async (_args, config) =>
				new ToolMessage({
					content: wrapperString,
					tool_call_id: (config as { toolCall?: { id?: string } })?.toolCall?.id ?? "c1",
					name: "aws_cloudwatch_describe_alarms",
					artifact,
				}),
			{
				name: "aws_cloudwatch_describe_alarms",
				description: "x",
				schema: z.object({ StateValue: z.string().optional() }),
			},
		);
		const rawOutputs: RawToolOutput[] = [];
		const entries: Array<Record<string, unknown>> = [];
		const log = { info: (o: unknown) => entries.push(o as Record<string, unknown>), warn: () => {} };
		const [wrapped] = instrumentTools([describeAlarms], { dataSourceId: "aws", log, rawOutputs, capBytes: 131_072 });
		const out = (await wrapped?.invoke({
			id: "c1",
			name: "aws_cloudwatch_describe_alarms",
			args: { StateValue: "ALARM" },
			type: "tool_call",
		})) as ToolMessage;

		expect(out.content).toBe(text);
		expect(String(out.content).length).toBeLessThan(wrapperString.length * 0.55);
		expect(out.tool_call_id).toBe("c1");
		expect(out.artifact).toEqual(artifact);
		// Persistence and the typed-finding path see exactly what they saw before.
		expect(rawOutputs[0]?.content).toBe(wrapperString);
		expect(rawOutputs[0]?.structuredContent).toEqual({ MetricAlarms: alarms });
		// And the log says it happened, with the size the MODEL actually received.
		const observed = entries.find((e) => e.event === "subagent.tool_result");
		expect(observed?.structuredDuplicateDropped).toBe(true);
		expect(observed?.bytes).toBe(Buffer.byteLength(text, "utf8"));
	});
});
