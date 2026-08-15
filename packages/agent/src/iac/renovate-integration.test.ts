// agent/src/iac/renovate-integration.test.ts
import { afterEach, describe, expect, mock, test } from "bun:test";
import { Command, END, MemorySaver, START, StateGraph } from "@langchain/langgraph";
// SIO-1045: captured BEFORE any mock.module() call in this file runs, so afterEach can restore the
// real implementations -- mock.module() is process-global and bun:test's mock.restore() does NOT
// undo it (only resets spy call state), so without this the last mock.module(...) registered below
// leaks into every OTHER test file that runs later in the same bun test process. Spreading into a
// plain object at load time copies the function VALUES, immune to bun's later namespace live-patching
// (see iac-change-memory.test.ts for the full rationale).
import * as realMemoryBackendNs from "../memory-backend.ts";
import * as realMemoryWriterNs from "../memory-writer.ts";
import { buildRenovateGateMessage, parseFirstOpenMrUrl, parseRenovateTargetJson } from "./nodes.ts";
import { IacState, type IacStateType } from "./state.ts";

const realMemoryBackend = { ...realMemoryBackendNs };
const realMemoryWriter = { ...realMemoryWriterNs };

function restoreRealMemoryMocks(): void {
	mock.module("../memory-backend.ts", () => realMemoryBackend);
	mock.module("../memory-writer.ts", () => realMemoryWriter);
}

describe("buildRenovateGateMessage", () => {
	test("names the exact marker and describes the trigger", () => {
		const msg = buildRenovateGateMessage({
			marker: "renovate/eu-b2b-prometheus",
			line: " - [ ] <!-- unschedule-branch=renovate/eu-b2b-prometheus -->chore(deps): [eu-b2b] prometheus to v1.24.4",
		});
		expect(msg).toContain("renovate/eu-b2b-prometheus");
		expect(msg).toContain("chore(deps): [eu-b2b] prometheus to v1.24.4");
	});
});

// SIO-1471: renovateTriggerGate's decline path (approve: false, or approve omitted from the
// interrupt payload) must leave a message on state.messages -- previously it set NOTHING,
// so a declined turn fell all the way through to teardownIac's generic gitops fallback and
// showed a misleading "MR opened"/"MR step complete" line for a turn that never entered the
// MR-authoring flow. Exercised as a real interrupt()/Command({resume}) round-trip inside a
// minimal IacState graph, matching topic-shift.integration.test.ts's established pattern for
// testing interrupt()-driven nodes (interrupt() throws GraphInterrupt outside a running graph,
// so it cannot be unit-called directly).
describe("renovateTriggerGate interrupt round-trip (SIO-1471)", () => {
	function buildMiniGateGraph() {
		const graph = new StateGraph(IacState)
			.addNode("renovateTriggerGate", async (state: IacStateType) => {
				const { renovateTriggerGate } = await import("./nodes.ts");
				return renovateTriggerGate(state);
			})
			.addEdge(START, "renovateTriggerGate")
			.addEdge("renovateTriggerGate", END);
		return graph.compile({ checkpointer: new MemorySaver() });
	}

	const marker = { marker: "renovate/eu-b2b-prometheus", line: "chore(deps): [eu-b2b] prometheus to v1.24.4" };

	test("approve: false sets a decline message naming the marker", async () => {
		const compiled = buildMiniGateGraph();
		const config = { configurable: { thread_id: `t-renovate-decline-${Date.now()}` } };
		const inputState = { requestId: "req-1", renovateMarker: marker };

		await compiled.invoke(inputState as unknown as Parameters<typeof compiled.invoke>[0], config);

		const resumeInput = new Command({ resume: { approve: false } }) as unknown as Parameters<typeof compiled.invoke>[0];
		await compiled.invoke(resumeInput, config);

		const after = await compiled.getState(config);
		const values = after.values as IacStateType;
		expect(values.renovateTriggerApproved).toBe(false);
		expect(values.messages.length).toBeGreaterThan(0);
		const lastMessage = String(values.messages[values.messages.length - 1]?.content ?? "");
		expect(lastMessage).toContain(marker.marker);
		expect(lastMessage.toLowerCase()).toContain("declin");
	});

	test("approve omitted (undefined) is treated as a decline and still sets a message", async () => {
		const compiled = buildMiniGateGraph();
		const config = { configurable: { thread_id: `t-renovate-undefined-${Date.now()}` } };
		const inputState = { requestId: "req-1", renovateMarker: marker };

		await compiled.invoke(inputState as unknown as Parameters<typeof compiled.invoke>[0], config);

		const resumeInput = new Command({ resume: {} }) as unknown as Parameters<typeof compiled.invoke>[0];
		await compiled.invoke(resumeInput, config);

		const after = await compiled.getState(config);
		const values = after.values as IacStateType;
		expect(values.renovateTriggerApproved).toBe(false);
		expect(values.messages.length).toBeGreaterThan(0);
	});

	test("approve: true does NOT set a decline message", async () => {
		const compiled = buildMiniGateGraph();
		const config = { configurable: { thread_id: `t-renovate-approve-${Date.now()}` } };
		const inputState = { requestId: "req-1", renovateMarker: marker };

		await compiled.invoke(inputState as unknown as Parameters<typeof compiled.invoke>[0], config);

		const resumeInput = new Command({ resume: { approve: true } }) as unknown as Parameters<typeof compiled.invoke>[0];
		await compiled.invoke(resumeInput, config);

		const after = await compiled.getState(config);
		const values = after.values as IacStateType;
		expect(values.renovateTriggerApproved).toBe(true);
		expect(values.messages.length).toBe(0);
	});
});

// SIO-1471: teardownIac must NOT append its generic gitops-flavored fallback lines ("MR
// opened: ..." / "MR step complete. Review and apply manually...") for the
// renovate-integration-update intent -- that fallback assumes an MR-authoring flow this
// sub-flow never enters, and its own nodes (resolveRenovateMarker / renovateTriggerGate /
// watchRenovateMr) already set the correct terminal message earlier in the turn. The fix
// returns {} for this intent so no new message is appended.
describe("teardownIac renovate-integration-update branch (SIO-1471)", () => {
	afterEach(() => {
		mock.restore();
		// SIO-1045: undo this block's mock.module("../memory-backend.ts" / "../memory-writer.ts", ...)
		// so it cannot leak into a test file that runs later in the same bun test process.
		restoreRealMemoryMocks();
	});

	async function runTeardown(state: Partial<IacStateType>) {
		mock.module("../memory-writer.ts", () => ({
			appendDailyLog: () => {},
			recordKeyDecision: () => {},
		}));
		mock.module("../memory-backend.ts", () => ({
			selectedBackend: () => "file",
			recallInFlightFleetUpgrades: async () => [],
			searchAgentMemory: async () => [],
			dedupeHitsBy: <T>(hits: T[]) => hits,
		}));
		const { teardownIac } = await import("./nodes.ts");
		return teardownIac({
			requestId: "req-1",
			threadId: "thread-abc",
			intent: "renovate-integration-update",
			...state,
		} as unknown as IacStateType);
	}

	test("returns {} (no new messages) so the sub-flow's own terminal message stands alone", async () => {
		const out = await runTeardown({});
		expect(out).toEqual({});
	});

	test("does not append the generic gitops fallback even when mrUrl happens to be unset", async () => {
		const out = await runTeardown({ mrUrl: "" });
		expect(out.messages).toBeUndefined();
	});
});

// Renovate on-demand MR automation: extractRenovateTarget's LLM call returns a JSON
// object with deployment+integration; parseRenovateTargetJson validates and normalizes
// it, returning null on malformed/incomplete output so the node can clarify instead of
// silently guessing.
describe("parseRenovateTargetJson", () => {
	test("parses a well-formed extraction", () => {
		expect(parseRenovateTargetJson('{"deployment":"eu-b2b","integration":"prometheus"}')).toEqual({
			deployment: "eu-b2b",
			integration: "prometheus",
		});
	});

	test("null when deployment is missing", () => {
		expect(parseRenovateTargetJson('{"integration":"prometheus"}')).toBeNull();
	});

	test("null when integration is missing", () => {
		expect(parseRenovateTargetJson('{"deployment":"eu-b2b"}')).toBeNull();
	});

	test("null when either field is an empty string", () => {
		expect(parseRenovateTargetJson('{"deployment":"","integration":"prometheus"}')).toBeNull();
		expect(parseRenovateTargetJson('{"deployment":"eu-b2b","integration":""}')).toBeNull();
	});

	test("null on malformed JSON", () => {
		expect(parseRenovateTargetJson("not json")).toBeNull();
	});

	test("tolerates surrounding prose (extracts the JSON block)", () => {
		expect(
			parseRenovateTargetJson('Here is the extraction: {"deployment":"ap-cld","integration":"cisco_ftd"} done.'),
		).toEqual({ deployment: "ap-cld", integration: "cisco_ftd" });
	});
});

import { filterDashboardMatches, hasSingleRenovateMatch, parseRenovateDashboardEntries } from "./nodes.ts";

describe("parseRenovateDashboardEntries", () => {
	test("extracts marker+line pairs", () => {
		const body =
			" - [ ] <!-- unschedule-branch=renovate/eu-b2b-prometheus -->chore(deps): [eu-b2b] prometheus to v1.24.4\n";
		expect(parseRenovateDashboardEntries(body)).toEqual([
			{
				marker: "renovate/eu-b2b-prometheus",
				line: " - [ ] <!-- unschedule-branch=renovate/eu-b2b-prometheus -->chore(deps): [eu-b2b] prometheus to v1.24.4",
			},
		]);
	});

	test("empty array on a body with no marker lines", () => {
		expect(parseRenovateDashboardEntries("nothing here")).toEqual([]);
	});
});

describe("filterDashboardMatches", () => {
	const entries = [
		{ marker: "renovate/eu-b2b-prometheus", line: "chore(deps): [eu-b2b] prometheus to v1.24.4" },
		{ marker: "renovate/ap-cld-prometheus", line: "chore(deps): [ap-cld] prometheus to v1.24.4" },
		{ marker: "renovate/eu-b2b-cisco_ftd", line: "chore(deps): [eu-b2b] cisco_ftd to v3.13.10" },
	];

	test("returns the single entry matching both deployment and integration (case-insensitive)", () => {
		expect(filterDashboardMatches(entries, "eu-b2b", "PROMETHEUS")).toEqual([
			{ marker: "renovate/eu-b2b-prometheus", line: "chore(deps): [eu-b2b] prometheus to v1.24.4" },
		]);
	});

	test("returns multiple entries when the integration alone matches across deployments", () => {
		expect(filterDashboardMatches(entries, "", "prometheus")).toHaveLength(2);
	});

	test("empty array when nothing matches", () => {
		expect(filterDashboardMatches(entries, "us-cld", "netskope")).toEqual([]);
	});
});

describe("hasSingleRenovateMatch (graph-edge predicate)", () => {
	test("true for exactly one candidate", () => {
		expect(hasSingleRenovateMatch([{ marker: "renovate/eu-b2b-prometheus", line: "x" }])).toBe(true);
	});
	test("false for zero candidates", () => {
		expect(hasSingleRenovateMatch([])).toBe(false);
	});
	test("false for 2+ candidates (ambiguous)", () => {
		expect(
			hasSingleRenovateMatch([
				{ marker: "renovate/eu-b2b-prometheus", line: "x" },
				{ marker: "renovate/ap-cld-prometheus", line: "y" },
			]),
		).toBe(false);
	});
});

import { parseFirstIssueIid, parseIssueDescription } from "./nodes.ts";

// gitlab_search (scope: work_items) response shape: an array of GitLab search-result
// objects. Only the numeric `iid` field is needed here.
describe("parseFirstIssueIid", () => {
	test("returns the iid of the first result", () => {
		const raw = JSON.stringify([{ iid: 11, title: "Elastic Fleet & Agent Dependency Dashboard" }]);
		expect(parseFirstIssueIid(raw)).toBe(11);
	});

	test("null on an empty array (no dashboard issue found)", () => {
		expect(parseFirstIssueIid("[]")).toBeNull();
	});

	test("null on malformed JSON", () => {
		expect(parseFirstIssueIid("not json")).toBeNull();
	});

	test("null when the first result has no numeric iid", () => {
		expect(parseFirstIssueIid(JSON.stringify([{ title: "no iid here" }]))).toBeNull();
	});
});

// gitlab_get_issue response shape: a single issue object with a `description` field.
describe("parseIssueDescription", () => {
	test("returns the description field", () => {
		const raw = JSON.stringify({ iid: 11, description: "## Awaiting Schedule\n\n - [ ] ..." });
		expect(parseIssueDescription(raw)).toBe("## Awaiting Schedule\n\n - [ ] ...");
	});

	test("empty string when description is missing", () => {
		expect(parseIssueDescription(JSON.stringify({ iid: 11 }))).toBe("");
	});

	test("empty string on malformed JSON", () => {
		expect(parseIssueDescription("not json")).toBe("");
	});
});

// gitlab_list_merge_requests_by_source_branch response shape: a raw GitLab merge-request
// array (newest first), same envelope watchPipeline's other parsers already handle.
describe("parseFirstOpenMrUrl", () => {
	test("returns the web_url of the first MR in the array", () => {
		const raw = JSON.stringify([{ iid: 42, web_url: "https://gitlab.example/x/-/merge_requests/42", state: "opened" }]);
		expect(parseFirstOpenMrUrl(raw)).toBe("https://gitlab.example/x/-/merge_requests/42");
	});

	test("null on an empty array", () => {
		expect(parseFirstOpenMrUrl("[]")).toBeNull();
	});

	test("null on malformed/error response", () => {
		expect(parseFirstOpenMrUrl("[404] not found")).toBeNull();
	});
});
