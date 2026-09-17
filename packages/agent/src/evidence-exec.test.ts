// agent/src/evidence-exec.test.ts
import { describe, expect, test } from "bun:test";
import { runInSandbox } from "@devops-agent/shared/src/sandbox-exec.ts";
import { ToolMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import {
	buildRunJsOnEvidenceTool,
	evidenceText,
	isEvidenceExecEnabled,
	splitTransform,
	TRANSFORM_PARAM,
	withTransformParam,
} from "./evidence-exec.ts";
import { instrumentTools, type RawToolOutput } from "./sub-agent-instrumentation.ts";

// SIO-1776. The REAL sandbox engine throughout: a fake runner would only certify what we
// assume QuickJS does.

const silent = { info: () => {}, warn: () => {} };
const HITS = Array.from({ length: 900 }, (_, i) => ({
	_id: `d${i}`,
	_source: {
		service: i % 3 ? "prana-order" : "prana-import-export",
		message: `FOP ValidationException order ${i} `.repeat(6),
	},
}));

describe("isEvidenceExecEnabled", () => {
	test("is opt-in: only an explicit true/1 turns it on", () => {
		expect(isEvidenceExecEnabled({})).toBe(false);
		expect(isEvidenceExecEnabled({ EVIDENCE_EXEC_ENABLED: "false" })).toBe(false);
		expect(isEvidenceExecEnabled({ EVIDENCE_EXEC_ENABLED: "yes" })).toBe(false);
		expect(isEvidenceExecEnabled({ EVIDENCE_EXEC_ENABLED: "true" })).toBe(true);
		expect(isEvidenceExecEnabled({ EVIDENCE_EXEC_ENABLED: "1" })).toBe(true);
	});
});

describe("splitTransform", () => {
	test("strips the parameter from a LangGraph tool call and from bare args", () => {
		const call = { id: "c1", name: "t", type: "tool_call", args: { q: "x", [TRANSFORM_PARAM]: "return 1" } };
		expect(splitTransform(call)).toEqual({
			arg: { id: "c1", name: "t", type: "tool_call", args: { q: "x" } },
			transform: "return 1",
		});
		expect(splitTransform({ q: "x", [TRANSFORM_PARAM]: "return 1" })).toEqual({
			arg: { q: "x" },
			transform: "return 1",
		});
	});

	test("leaves a call without one untouched, and treats a blank one as absent but still strips it", () => {
		const call = { id: "c1", name: "t", type: "tool_call", args: { q: "x" } };
		expect(splitTransform(call).arg).toBe(call);
		expect(splitTransform({ q: "x", [TRANSFORM_PARAM]: "  " })).toEqual({ arg: { q: "x" }, transform: undefined });
	});
});

describe("withTransformParam", () => {
	test("extends a JSON Schema (the MCP adapter shape) without touching the original", () => {
		const original = { type: "object", properties: { q: { type: "string" } }, additionalProperties: false };
		const out = withTransformParam(original) as typeof original & { properties: Record<string, { type: string }> };
		expect(out.properties[TRANSFORM_PARAM]?.type).toBe("string");
		expect(out.additionalProperties).toBe(false);
		expect(TRANSFORM_PARAM in original.properties).toBe(false);
	});

	test("extends a Zod object and keeps it optional", () => {
		const out = withTransformParam(z.object({ q: z.string() })) as z.ZodObject<z.ZodRawShape>;
		expect(out.safeParse({ q: "x" }).success).toBe(true);
		expect(out.safeParse({ q: "x", [TRANSFORM_PARAM]: "return 1" }).success).toBe(true);
	});

	test("leaves anything else alone", () => {
		expect(withTransformParam(undefined)).toBeUndefined();
		expect(withTransformParam({ type: "string" })).toEqual({ type: "string" });
	});
});

describe("evidenceText", () => {
	test("joins MCP text blocks; passes strings through; stringifies the rest", () => {
		expect(evidenceText("plain")).toBe("plain");
		expect(
			evidenceText([
				{ type: "text", text: '{"a":' },
				{ type: "text", text: "1}" },
			]),
		).toBe('{"a":1}');
		expect(evidenceText({ a: 1 })).toBe('{"a":1}');
	});
});

describe("_transform through instrumentTools", () => {
	function harness(withSandbox: boolean) {
		const seenArgs: unknown[] = [];
		const search = tool(
			async (args: Record<string, unknown>) => {
				seenArgs.push(args);
				return JSON.stringify({ hits: { hits: HITS } });
			},
			{ name: "elasticsearch_search", description: "x", schema: z.object({ index: z.string() }).passthrough() },
		);
		const rawOutputs: RawToolOutput[] = [];
		const [wrapped] = instrumentTools([search], {
			dataSourceId: "elastic",
			log: silent,
			rawOutputs,
			capBytes: 131_072,
			...(withSandbox && { sandbox: runInSandbox }),
		});
		if (!wrapped) throw new Error("no tool");
		const call = (id: string, args: Record<string, unknown>) =>
			wrapped.invoke({ id, name: "elasticsearch_search", args, type: "tool_call" });
		return { wrapped, seenArgs, rawOutputs, call };
	}
	const text = (m: unknown) => String(m instanceof ToolMessage ? m.content : m);

	test("the model sees only the derived answer; the full result is still captured", async () => {
		const { call, rawOutputs, seenArgs } = harness(true);
		const out = await call("c1", {
			index: "logs-*",
			[TRANSFORM_PARAM]: `const c = {}; for (const h of result.hits.hits) c[h._source.service] = (c[h._source.service] || 0) + 1; return c;`,
		});
		const shown = text(out);
		expect(shown).toContain('{"prana-import-export":300,"prana-order":600}');
		expect(shown).toContain("evidence id e1");
		expect(shown.length).toBeLessThan(400);
		// Full fidelity where it matters: what the extractors and search_evidence read.
		expect(String(rawOutputs[0]?.content).length).toBeGreaterThan(100_000);
		// And the real tool never saw the parameter.
		expect(seenArgs[0]).toEqual({ index: "logs-*" });
	}, 15_000);

	test("the loop-guard signature ignores the transform: same args, different code, is a duplicate", async () => {
		const { call, seenArgs } = harness(true);
		await call("c1", { index: "logs-*", [TRANSFORM_PARAM]: "return result.hits.hits.length" });
		const second = text(await call("c2", { index: "logs-*", [TRANSFORM_PARAM]: "return 1" }));
		// Refused by the guard as the same call: the real tool ran once and no payload came back.
		// (Asserted on behaviour, not wording: elasticsearch_search has its own stop message.)
		expect(seenArgs).toHaveLength(1);
		expect(second).not.toContain("FOP ValidationException");
		expect(second).not.toContain("transformed from");
	}, 15_000);

	test("a failing transform costs nothing: normal (capped) output plus the reason", async () => {
		const { call } = harness(true);
		const shown = text(await call("c1", { index: "logs-*", [TRANSFORM_PARAM]: "return result.nope.length" }));
		expect(shown).toContain("_transform was not applied");
		expect(shown).toContain("TypeError");
		expect(shown).toContain("FOP ValidationException"); // the tool's own output is there
	}, 15_000);

	test("the model-facing schema gains the parameter only when the sandbox is on", () => {
		const on = harness(true).wrapped.schema as unknown as z.ZodObject<z.ZodRawShape>;
		const off = harness(false).wrapped.schema as unknown as z.ZodObject<z.ZodRawShape>;
		expect(TRANSFORM_PARAM in on.shape).toBe(true);
		expect(TRANSFORM_PARAM in off.shape).toBe(false);
	});

	test("flag off: nothing is stripped or transformed", async () => {
		const { call, seenArgs } = harness(false);
		const shown = text(await call("c1", { index: "logs-*", [TRANSFORM_PARAM]: "return 1" }));
		expect(shown).toContain("FOP ValidationException");
		expect(seenArgs[0]).toEqual({ index: "logs-*", [TRANSFORM_PARAM]: "return 1" });
	});
});

describe("run_js_on_evidence", () => {
	const captured = [
		{ toolName: "elasticsearch_search", content: JSON.stringify({ hits: { hits: HITS.slice(0, 50) } }) },
		{
			toolName: "aws_logs_get_query_results",
			content: [{ type: "text", text: JSON.stringify({ results: [{ count: 46 }] }) }],
		},
	];
	const ask = async (t: ReturnType<typeof buildRunJsOnEvidenceTool>, code: string) => String(await t.invoke({ code }));

	test("computes across several captured results, addressed in call order", async () => {
		const t = buildRunJsOnEvidenceTool(() => captured, runInSandbox, silent);
		const out = await ask(
			t,
			`return { ids: evidence.list().map((e) => e.id + ":" + e.tool), es: evidence.get("e1").hits.hits.length, cw: evidence.get("e2").results[0].count };`,
		);
		expect(JSON.parse(out)).toEqual({
			ids: ["e1:elasticsearch_search", "e2:aws_logs_get_query_results"],
			es: 50,
			cw: 46,
		});
	}, 15_000);

	test("reads evidence at call time, and says so when there is none yet", async () => {
		const live: typeof captured = [];
		const t = buildRunJsOnEvidenceTool(() => live, runInSandbox, silent);
		expect(await ask(t, "return 1")).toContain("No tool results have been captured");
		live.push(captured[0] as (typeof captured)[number]);
		expect(await ask(t, "return evidence.list().length")).toBe("1");
	}, 15_000);

	test("the third failure in a row tells the model to stop; a success resets it", async () => {
		const t = buildRunJsOnEvidenceTool(() => captured, runInSandbox, silent);
		expect(await ask(t, "return nope.x")).toContain("Fix the code and try once more");
		expect(await ask(t, "return nope.y")).toContain("Fix the code and try once more");
		expect(await ask(t, "return nope.z")).toContain("Do not call run_js_on_evidence again");
		expect(await ask(t, "return 2")).toBe("2");
		expect(await ask(t, "return nope.a")).toContain("Fix the code and try once more");
	}, 20_000);
});
