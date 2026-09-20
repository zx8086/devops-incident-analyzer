// packages/agent/src/reflect/reflect.test.ts
//
// SIO-1834: the A1-A3 checks from the handover's section 13 table. Each is the smallest
// thing that fails if the logic breaks.
import { describe, expect, test } from "bun:test";
import { argsCanIdentify, datasourcesFromTags, runToRawSession, threadFromTags } from "./adapter-langsmith.ts";
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

	// Greptile P1 (PR #862), verified on real traces: inputs.messages carries the thread's
	// accumulated user history (one thread's consecutive runs held 1 then 2 messages, both
	// human). Taking them all would re-emit an earlier turn as a fresh signal in every later
	// run of that thread.
	test("only the turn this run introduced is kept, not the thread's history", () => {
		const session = runToRawSession(
			fakeRun({
				inputs: {
					messages: [
						{ kwargs: { content: "the turn from the previous run of this thread" } },
						{ kwargs: { content: "the turn this run actually introduced" } },
					],
				},
			}),
		);
		const userTexts = session.messages
			.filter((m) => m.role === "user")
			.flatMap((m) => m.parts.map((p) => (p.type === "text" ? p.text : "")));
		expect(userTexts).toEqual(["the turn this run actually introduced"]);
	});

	// Greptile (PR #862): the coercion helpers turned a malformed field into an empty one
	// BEFORE RawSessionSchema saw it, so a corrupt run yielded a session with no tool calls
	// -- indistinguishable from a clean one, in a pipeline whose entire job is spotting
	// failures. It must be reported, not silently emptied.
	test("a malformed run is rejected rather than quietly read as empty", () => {
		expect(() => runToRawSession(fakeRun({ outputs: { dataSourceResults: "not-an-array" } }))).toThrow();
		expect(() => runToRawSession(fakeRun({ outputs: { dataSourceResults: [{ toolOutputs: 42 }] } }))).toThrow();
	});

	// LangSmith owns this payload and adds fields to it, so an unknown key is normal and
	// must never fail a run.
	test("an unknown field from LangSmith is tolerated", () => {
		const session = runToRawSession(
			fakeRun({
				outputs: {
					someFutureField: { nested: true },
					dataSourceResults: [
						{ dataSourceId: "aws", somethingNew: 1, toolOutputs: [{ toolName: "aws_x", toolArgs: {} }] },
					],
				},
			}),
		);
		expect(session.messages.some((m) => m.parts.some((p) => p.type === "tool_call"))).toBe(true);
	});

	// LangChain emits all four of these, so the content reader is a Zod UNION rather than one
	// shape: rejecting any would drop real turns. Anything else reads as empty, which is safe
	// because the run has already passed the boundary schemas.
	test("every LangChain message shape is read, and an unreadable one is empty", () => {
		const shapes: Array<[string, unknown]> = [
			["hydrated string", { kwargs: { content: "hello" } }],
			["direct string", { content: "hello" }],
			["direct blocks", { content: [{ type: "text", text: "hello" }] }],
			["hydrated blocks", { kwargs: { content: [{ type: "text", text: "hello" }] } }],
		];
		for (const [label, message] of shapes) {
			const session = runToRawSession(fakeRun({ inputs: { messages: [message] } }));
			const text = session.messages.find((m) => m.role === "user")?.parts[0];
			expect(text && text.type === "text" ? text.text : `MISSED: ${label}`).toBe("hello");
		}
		// Unreadable content contributes no turn rather than throwing away the run.
		const odd = runToRawSession(fakeRun({ inputs: { messages: [{ kwargs: { content: 42 } }] } }));
		expect(odd.messages.some((m) => m.role === "user")).toBe(false);
	});

	// The regression a uniform-blocks test could not see (Greptile, PR #862): an attachment
	// turn mixes text with image_url/file blocks. Requiring `text` on every block rejected
	// the whole array, dropping the user's request -- and with it the scan's `request`
	// handle, which cross-session retry detection depends on.
	test("a turn mixing text with an image block keeps its text", () => {
		const session = runToRawSession(
			fakeRun({
				inputs: {
					messages: [
						{
							kwargs: {
								content: [
									{ type: "text", text: "why is checkout slow" },
									{ type: "image_url", image_url: { url: "http://example.test/y.png" } },
									{ type: "text", text: "since this morning" },
								],
							},
						},
					],
				},
			}),
		);
		const part = session.messages.find((m) => m.role === "user")?.parts[0];
		expect(part && part.type === "text" ? part.text : null).toBe("why is checkout slow\nsince this morning");
	});

	test("a turn of only non-text blocks yields no user turn", () => {
		const session = runToRawSession(
			fakeRun({
				inputs: { messages: [{ kwargs: { content: [{ type: "image_url", image_url: { url: "http://x/y" } }] } }] },
			}),
		);
		expect(session.messages.some((m) => m.role === "user")).toBe(false);
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

	// Greptile P2 (PR #862): redacting only tool results left user text and tool arguments
	// unredacted, and both reach a report -- user text as Scan.request.text and a reaction's
	// evidence, tool args as a repeat-call's evidence.
	test("redacts user text and tool arguments, not just tool results", () => {
		const raw: RawSession = {
			meta: { host: "x", id: "r", threadId: null, created: null, headless: false, datasources: [] },
			messages: [
				{ role: "user", created: null, parts: [{ type: "text", text: "contact me at alice@example.com" }] },
				{
					role: "assistant",
					created: null,
					parts: [
						{
							type: "tool_call",
							toolCallId: null,
							name: "t",
							input: '{"email":"bob@example.com"}',
							argsIdentifyTheCall: true,
						},
						{
							type: "tool_result",
							toolCallId: null,
							name: "t",
							content: "failed for carol@example.com",
							failed: true,
							category: "bad-query",
						},
					],
				},
			],
		};
		const flat = JSON.stringify(normalizeSession(raw));
		// redactPiiContent keeps hostnames and ids by design (SIO-861); emails are redacted.
		expect(flat).not.toContain("alice@example.com");
		expect(flat).not.toContain("bob@example.com");
		expect(flat).not.toContain("carol@example.com");
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
		// A scalar-input tool: SIO-1856 makes a repeat provable only for these.
		const call = { toolName: "aws_ecs_list_services", toolArgs: { cluster: "prod" }, rawJson: '{"same":1}' };
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
		expect(repeat?.evidence[0]?.excerpt).toContain("prod");
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

	// SIO-1856. toolArgs is scalars-only, so a tool whose real input is a nested object
	// records nothing that identifies the call: 831 of 1084 elasticsearch_search calls had
	// NO args, and 31 dispatches had "identical" searches returning DIFFERENT results.
	// Reporting those as repeats would justify caching two different searches together.
	test("a search with an unrecordable query is never reported as a repeat", () => {
		const call = { toolName: "elasticsearch_search", toolArgs: {}, rawJson: '{"same":1}' };
		const scan = scanSession(
			sessionFrom(
				fakeRun({
					outputs: { dataSourceResults: [{ dataSourceId: "elastic", toolOutputs: [call, call, call] }] },
				}),
			),
		);
		expect(scan.signals.some((s) => s.kind === "repeat-call")).toBe(false);
		expect(scan.stats.repeats).toBe(0);
		// and the report says what it could not measure, rather than staying silent
		expect(scan.notes.join(" ")).toContain("cannot identify the call");
	});

	test("a genuinely no-arg listing is still a provable repeat", () => {
		const call = { toolName: "aws_ecs_list_clusters", toolArgs: {}, rawJson: '{"clusters":[]}' };
		const scan = scanSession(
			sessionFrom(
				fakeRun({ outputs: { dataSourceResults: [{ dataSourceId: "aws", toolOutputs: [call, call, call] }] } }),
			),
		);
		const repeat = scan.signals.find((s) => s.kind === "repeat-call");
		expect(repeat?.count).toBe(3);
	});

	test("argsCanIdentify trusts the allowlist, never a call's recorded shape", () => {
		// On the allowlist: takes no args by nature, so an empty bag IS the whole input.
		expect(argsCanIdentify("aws_ecs_list_clusters", {})).toBe(true);
		// Off it: an empty bag means the input was DROPPED, not that there was none.
		expect(argsCanIdentify("elasticsearch_search", {})).toBe(false);

		// The case that broke an "all recorded values are scalar" fallback, found on a real
		// report: every value here IS scalar, and the query body is still missing, so two
		// searches of the same index for different things look identical.
		expect(argsCanIdentify("elasticsearch_search", { index: "logs-*,logs-apm.*", size: 10 })).toBe(false);
		expect(argsCanIdentify("elasticsearch_search", { index: "logs-*", query: { match_all: {} } })).toBe(false);
	});

	// Greptile P1 (PR #862): kafka_list_consumer_groups takes `states: z.array(z.string())`
	// (mcp-server-kafka parameters.ts:60). The recorder drops arrays, so two calls filtering
	// different states record identically -- the exact false repeat the allowlist prevents.
	test("a tool with an array parameter is not on the scalar allowlist", () => {
		expect(argsCanIdentify("kafka_list_consumer_groups", {})).toBe(false);
		// Its array-free siblings stay eligible.
		expect(argsCanIdentify("kafka_list_topics", {})).toBe(true);
		expect(argsCanIdentify("kafka_list_dlq_topics", {})).toBe(true);
	});

	// Greptile P2 (PR #862): redaction maps every value of a PII class onto ONE placeholder,
	// so two calls differing only by an email collapse to the same bytes. Matching therefore
	// uses a digest taken BEFORE redaction.
	test("two calls differing only by a redacted value are not a repeat", () => {
		const scan = scanSession(
			sessionFrom(
				fakeRun({
					outputs: {
						dataSourceResults: [
							{
								dataSourceId: "aws",
								toolOutputs: [
									{ toolName: "aws_ecs_list_services", toolArgs: { cluster: "alice@corp.com" }, rawJson: "{}" },
									{ toolName: "aws_ecs_list_services", toolArgs: { cluster: "bob@corp.com" }, rawJson: "{}" },
								],
							},
						],
					},
				}),
			),
		);
		expect(scan.signals.some((s) => s.kind === "repeat-call")).toBe(false);
		// and the report still shows the redacted form, never the raw address
		expect(JSON.stringify(scan)).not.toContain("alice@corp.com");
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

	// The within-run reaction lane is source-agnostic, so it is exercised directly with a
	// multi-turn normalized session. A LangSmith run cannot produce one (the adapter keeps
	// only the turn that run introduced), which is why this does not go through fakeRun.
	test("a user redo after the opening request is high and names the run's datasources", () => {
		const scan = scanSession({
			source: {
				host: "x",
				id: "r",
				threadId: null,
				created: null,
				headless: false,
				datasources: ["aws", "elastic"],
			},
			messages: [
				{
					index: 0,
					role: "user",
					created: null,
					parts: [{ type: "text", text: "please investigate the checkout latency spike this morning" }],
				},
				{ index: 1, role: "assistant", created: null, parts: [{ type: "text", text: "here is the report" }] },
				{
					index: 2,
					role: "user",
					created: null,
					parts: [{ type: "text", text: "no, start over from scratch please" }],
				},
			],
		});
		const redo = scan.signals.find((s) => s.kind === "user-redo");
		expect(redo?.severity).toBe("high");
		expect(redo?.suspects).toEqual(["aws", "elastic"]);
	});

	// Greptile P2 (PR #862): the comma-only delimiter missed every punctuated correction.
	test("a punctuated correction is a correction", () => {
		for (const text of ["Wrong. Query the other index instead", "No! Use production", "Stop; use staging please"]) {
			const scan = scanSession({
				source: { host: "x", id: "r", threadId: null, created: null, headless: false, datasources: ["aws"] },
				messages: [
					{
						index: 0,
						role: "user",
						created: null,
						parts: [{ type: "text", text: "look at the checkout service errors this morning" }],
					},
					{ index: 1, role: "user", created: null, parts: [{ type: "text", text }] },
				],
			});
			expect(scan.signals.some((s) => s.kind === "user-correction")).toBe(true);
		}
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
		const scan = scanSession({
			source: { host: "x", id: "r", threadId: null, created: null, headless: false, datasources: ["aws"] },
			messages: [
				{ index: 0, role: "user", created: null, parts: [{ type: "text", text: "redo it from scratch" }] },
				{
					index: 1,
					role: "user",
					created: null,
					parts: [{ type: "text", text: "no, start over from scratch again" }],
				},
			],
		});
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
