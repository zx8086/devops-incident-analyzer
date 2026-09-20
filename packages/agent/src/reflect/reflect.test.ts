// packages/agent/src/reflect/reflect.test.ts
//
// SIO-1834: the A1-A3 checks from the handover's section 13 table. Each is the smallest
// thing that fails if the logic breaks.
import { describe, expect, test } from "bun:test";
import { datasourcesFromTags, runToRawSession, threadFromTags } from "./adapter-langsmith.ts";
import { clip, normalizeSession, TOOL_RESULT_CLIP } from "./normalize.ts";
import { datasourceForTool, scanSession } from "./scan.ts";
import type { RawSession } from "./schema.ts";
import { verdictForCategory } from "./schema.ts";

// Built from the shape measured on the live project (see adapter-langsmith.ts header).
function fakeRun(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: "01a0bc43-d3f4-71ed-8843-aef5d85b68d1",
		name: "agent.request",
		start_time: "2026-09-20T10:00:00.000Z",
		tags: ["chat", "thread:t-1", "datasources:aws,elastic"],
		inputs: { messages: [{ id: ["x"], lc: 1, type: "constructor", kwargs: { content: "why is checkout slow" } }] },
		outputs: { messages: [], dataSourceResults: [] },
		...overrides,
	};
}

function sessionFrom(run: Record<string, unknown>) {
	return normalizeSession(runToRawSession(run));
}

describe("adapter", () => {
	test("maps a real-shaped run to a RawSession", () => {
		const session = runToRawSession(fakeRun());
		expect(session.meta.id).toBe("01a0bc43-d3f4-71ed-8843-aef5d85b68d1");
		expect(session.meta.threadId).toBe("t-1");
		expect(session.meta.datasources).toEqual(["aws", "elastic"]);
		expect(session.meta.headless).toBe(false);
		expect(session.messages[0]?.role).toBe("user");
	});

	test("a run without the chat tag is headless, so reactions are skipped", () => {
		const session = runToRawSession(fakeRun({ tags: ["datasources:aws"] }));
		expect(session.meta.headless).toBe(true);
	});

	test("datasources:auto and a missing tag both yield no datasources", () => {
		expect(datasourcesFromTags(["datasources:auto"])).toEqual([]);
		expect(datasourcesFromTags(["chat"])).toEqual([]);
		expect(threadFromTags(["chat"])).toBeNull();
	});

	test("tolerates a root with zero dataSourceResults (measured: 2 of 8 runs)", () => {
		const session = runToRawSession(fakeRun({ outputs: {} }));
		expect(session.messages.length).toBe(1);
	});

	test("reads typed toolErrors into failed tool_result parts", () => {
		const session = runToRawSession(
			fakeRun({
				outputs: {
					dataSourceResults: [
						{
							dataSourceId: "elastic",
							toolOutputs: [{ toolName: "elasticsearch_search", toolArgs: { index: "logs" } }],
							toolErrors: [{ toolName: "elasticsearch_esql_query", category: "bad-query", message: "parse error" }],
						},
					],
				},
			}),
		);
		const parts = session.messages.flatMap((m) => m.parts);
		const result = parts.find((p) => p.type === "tool_result");
		expect(result).toMatchObject({ failed: true, category: "bad-query", name: "elasticsearch_esql_query" });
	});

	test("an unrecognized category degrades to null, not to an excused failure", () => {
		const session = runToRawSession(
			fakeRun({
				outputs: {
					dataSourceResults: [
						{ dataSourceId: "aws", toolErrors: [{ toolName: "aws_x", category: "bogus", message: "m" }] },
					],
				},
			}),
		);
		const result = session.messages.flatMap((m) => m.parts).find((p) => p.type === "tool_result");
		expect(result && "category" in result && result.category).toBeNull();
		// null must be treated as indicting: an unknown failure is not silently environmental.
		expect(verdictForCategory(null)).toBe("indicting");
	});
});

describe("normalize", () => {
	test("clips a long tool result head+tail, leaving prose untouched", () => {
		const clipped = clip("x".repeat(2000), TOOL_RESULT_CLIP);
		expect(clipped.length).toBe(TOOL_RESULT_CLIP + 3); // 600 + the "..." marker
		expect(clipped).toContain("...");
		expect(clip("short", TOOL_RESULT_CLIP)).toBe("short");
	});

	test("assigns a message index", () => {
		const raw: RawSession = {
			meta: { host: "langsmith", id: "r", threadId: null, created: null, headless: false, datasources: [] },
			messages: [
				{ role: "user", created: null, parts: [{ type: "text", text: "a" }] },
				{ role: "assistant", created: null, parts: [{ type: "text", text: "b" }] },
			],
		};
		expect(normalizeSession(raw).messages.map((m) => m.index)).toEqual([0, 1]);
	});
});

describe("scan", () => {
	test("categories split three ways", () => {
		expect(verdictForCategory("bad-query")).toBe("indicting");
		expect(verdictForCategory("unknown")).toBe("indicting");
		// agent-state.ts:20-24 calls these normal findings, not malfunctions.
		expect(verdictForCategory("not-found")).toBe("expected");
		expect(verdictForCategory("no-data")).toBe("expected");
		expect(verdictForCategory("auth")).toBe("environment");
		expect(verdictForCategory("transient")).toBe("environment");
	});

	test("an expected outcome is low and never a tool-failure", () => {
		const scan = scanSession(
			sessionFrom(
				fakeRun({
					outputs: {
						dataSourceResults: [
							{
								dataSourceId: "couchbase",
								toolErrors: [{ toolName: "capella_x", category: "no-data", message: "empty" }],
							},
						],
					},
				}),
			),
		);
		expect(scan.signals.map((s) => s.kind)).toContain("expected-outcome");
		expect(scan.signals.find((s) => s.kind === "expected-outcome")?.severity).toBe("low");
		expect(scan.signals.some((s) => s.kind === "tool-failure")).toBe(false);
	});

	test("an environment failure is counted but produces no signal", () => {
		const scan = scanSession(
			sessionFrom(
				fakeRun({
					outputs: {
						dataSourceResults: [
							{ dataSourceId: "aws", toolErrors: [{ toolName: "aws_x", category: "auth", message: "401" }] },
						],
					},
				}),
			),
		);
		expect(scan.stats.environmentFailures).toBe(1);
		expect(scan.signals.length).toBe(0);
	});

	test("an indicting failure names its datasource and is high", () => {
		const scan = scanSession(
			sessionFrom(
				fakeRun({
					outputs: {
						dataSourceResults: [
							{
								dataSourceId: "elastic",
								toolErrors: [{ toolName: "elasticsearch_esql_query", category: "bad-query", message: "x" }],
							},
						],
					},
				}),
			),
		);
		const signal = scan.signals.find((s) => s.kind === "tool-failure");
		expect(signal?.severity).toBe("high");
		expect(signal?.suspects).toEqual(["elastic"]);
		expect(signal?.evidence.length).toBeGreaterThan(0);
	});

	test("repeat call: identical input AND identical result 3x is one medium signal", () => {
		const call = { toolName: "aws_logs_start_query", toolArgs: { q: "fields @m" }, rawJson: '{"same":1}' };
		const scan = scanSession(
			sessionFrom(
				fakeRun({ outputs: { dataSourceResults: [{ dataSourceId: "aws", toolOutputs: [call, call, call] }] } }),
			),
		);
		const repeat = scan.signals.find((s) => s.kind === "repeat-call");
		expect(repeat?.count).toBe(3);
		expect(repeat?.severity).toBe("medium");
		expect(repeat?.suspects).toEqual(["aws"]);
		// The evidence shows the args, not the {args,result} envelope or the result hash.
		expect(repeat?.evidence[0]?.excerpt).toContain("fields @m");
		expect(repeat?.evidence[0]?.excerpt).not.toContain("result");
	});

	// Measured: of 48 same-arg pairs in one AWS trace, 20 returned DIFFERENT results --
	// aws_logs_get_query_results(queryId) polling an async query. Polling is not a loop.
	test("same args but a changing result is a poll, not a repeat", () => {
		const poll = (n: number) => ({
			toolName: "aws_logs_get_query_results",
			toolArgs: { queryId: "q-1" },
			rawJson: `{"status":"Running","n":${n}}`,
		});
		const scan = scanSession(
			sessionFrom(
				fakeRun({
					outputs: { dataSourceResults: [{ dataSourceId: "aws", toolOutputs: [poll(1), poll(2), poll(3)] }] },
				}),
			),
		);
		expect(scan.signals.some((s) => s.kind === "repeat-call")).toBe(false);
		expect(scan.stats.repeats).toBe(0);
	});

	// Measured on real traces: one turn holds several dataSourceResults for the SAME
	// datasource (aws x4), one per sub-agent dispatch. Counting across them reported 78% of
	// all calls as repeats. Fan-out is not a loop.
	test("the same call in two dispatches is fan-out, not a repeat", () => {
		// Identical result too, so this passes only because of the dispatch boundary.
		const call = { toolName: "aws_logs_start_query", toolArgs: { q: "fields @m" }, rawJson: '{"same":1}' };
		const scan = scanSession(
			sessionFrom(
				fakeRun({
					outputs: {
						dataSourceResults: [
							{ dataSourceId: "aws", toolOutputs: [call] },
							{ dataSourceId: "aws", toolOutputs: [call] },
						],
					},
				}),
			),
		);
		expect(scan.signals.some((s) => s.kind === "repeat-call")).toBe(false);
		expect(scan.stats.toolCalls).toBe(2);
	});

	test("differing input is not a repeat", () => {
		const scan = scanSession(
			sessionFrom(
				fakeRun({
					outputs: {
						dataSourceResults: [
							{
								dataSourceId: "aws",
								toolOutputs: [
									{ toolName: "aws_x", toolArgs: { q: 1 } },
									{ toolName: "aws_x", toolArgs: { q: 2 } },
								],
							},
						],
					},
				}),
			),
		);
		expect(scan.signals.some((s) => s.kind === "repeat-call")).toBe(false);
	});

	test("a user redo after the opening request is high and names the run's datasources", () => {
		const scan = scanSession(
			sessionFrom(
				fakeRun({
					inputs: {
						messages: [
							{ kwargs: { content: "please investigate the checkout latency spike this morning" } },
							{ kwargs: { content: "no, start over from scratch please" } },
						],
					},
				}),
			),
		);
		const redo = scan.signals.find((s) => s.kind === "user-redo");
		expect(redo?.severity).toBe("high");
		expect(redo?.suspects).toEqual(["aws", "elastic"]);
	});

	test("the opening request itself never counts as a reaction", () => {
		const scan = scanSession(
			sessionFrom(
				fakeRun({
					// >= MIN_REQUEST_WORDS so it also qualifies as the matching handle.
					inputs: { messages: [{ kwargs: { content: "redo the whole analysis from scratch for yesterday please" } }] },
				}),
			),
		);
		expect(scan.signals.some((s) => s.kind === "user-redo")).toBe(false);
		expect(scan.request).not.toBeNull();
	});

	// The opener is excluded by position, not by word count: a SHORT opener is still the
	// opener (it just cannot serve as the cross-session matching handle), while a genuine
	// reaction after it must still register.
	test("a short opener is excluded but a later reaction still registers", () => {
		const scan = scanSession(
			sessionFrom(
				fakeRun({
					inputs: {
						messages: [
							{ kwargs: { content: "redo it from scratch" } },
							{ kwargs: { content: "no, start over from scratch again" } },
						],
					},
				}),
			),
		);
		expect(scan.request).toBeNull(); // too short to be a matching handle
		const redo = scan.signals.find((s) => s.kind === "user-redo");
		expect(redo?.count).toBe(1); // the later turn only, not the opener
	});

	test("a headless run yields no user-reaction signals", () => {
		const scan = scanSession(
			sessionFrom(
				fakeRun({
					tags: ["datasources:aws"],
					inputs: {
						messages: [
							{ kwargs: { content: "investigate the checkout latency spike this morning please" } },
							{ kwargs: { content: "no, start over from scratch" } },
						],
					},
				}),
			),
		);
		expect(scan.signals.some((s) => s.kind.startsWith("user-"))).toBe(false);
		expect(scan.notes).toContain("headless run: user-reaction detectors skipped");
	});

	test("injected host text is not read as the user's words", () => {
		const scan = scanSession(
			sessionFrom(
				fakeRun({
					inputs: {
						messages: [
							{ kwargs: { content: "investigate the checkout latency spike this morning please" } },
							{ kwargs: { content: "[Request interrupted by user] no, stop that" } },
						],
					},
				}),
			),
		);
		expect(scan.signals.some((s) => s.kind === "user-correction")).toBe(false);
	});

	test("datasource is resolved from the tool-name prefix", () => {
		expect(datasourceForTool("aws_logs_start_query")).toBe("aws");
		expect(datasourceForTool("elasticsearch_search")).toBe("elastic");
		expect(datasourceForTool("capella_get_buckets")).toBe("couchbase");
		expect(datasourceForTool("gitlab_get_merge_request")).toBe("gitlab");
		expect(datasourceForTool("ksql_list_streams")).toBe("kafka");
		expect(datasourceForTool("mystery_tool")).toBeNull();
		expect(datasourceForTool(null)).toBeNull();
	});
});
