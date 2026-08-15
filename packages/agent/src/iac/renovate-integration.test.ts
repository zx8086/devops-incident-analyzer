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

	// SIO-1471: the generic memory-summary branch keys on state.mrUrl, which this sub-flow
	// never sets, so its durable-memory breadcrumb was contentless ("intent=renovate-integration-update"
	// and nothing else). teardownIac now adds the resolved marker + the Renovate-created MR link
	// (when present) to the breadcrumb so a later session can recall what actually happened.
	test("records the resolved marker and Renovate MR link in the durable memory breadcrumb", async () => {
		let capturedSummary: string | undefined;
		mock.module("../memory-writer.ts", () => ({
			appendDailyLog: (entry: { summary: string }) => {
				capturedSummary = entry.summary;
			},
			recordKeyDecision: () => {},
		}));
		mock.module("../memory-backend.ts", () => ({
			selectedBackend: () => "file",
			recallInFlightFleetUpgrades: async () => [],
			searchAgentMemory: async () => [],
			dedupeHitsBy: <T>(hits: T[]) => hits,
		}));
		const { teardownIac } = await import("./nodes.ts");
		await teardownIac({
			requestId: "req-1",
			threadId: "thread-abc",
			intent: "renovate-integration-update",
			renovateMarker: { marker: "renovate/eu-b2b-prometheus", line: "x" },
			renovateMrUrl: "https://gitlab.example/x/-/merge_requests/517",
		} as unknown as IacStateType);

		expect(capturedSummary).toContain("marker=renovate/eu-b2b-prometheus");
		expect(capturedSummary).toContain("MR=https://gitlab.example/x/-/merge_requests/517");
	});

	// SIO-1471 follow-up: a completed renovate trigger (an MR was found) is a durable Profile
	// fact on the agent-memory backend, mirroring the fleet-upgrade and gitops iac-change facts
	// (buildFleetFactDecision / buildIacChangeDecision) -- otherwise a later session can recall
	// "eu-b2b fleet -> 9.4.2" or "eu-b2b/lifecycle-policies changed" but NOT "gl-testing-system
	// was updated via Renovate", even though the daily-log breadcrumb (tested above) exists.
	test("records a durable renovate-trigger fact on the agent-memory backend when an MR was found", async () => {
		let capturedDecision: string | undefined;
		let capturedAnnotations: Record<string, string> | undefined;
		mock.module("../memory-writer.ts", () => ({
			appendDailyLog: () => {},
			recordKeyDecision: (entry: { decision: string; annotations?: Record<string, string> }) => {
				capturedDecision = entry.decision;
				capturedAnnotations = entry.annotations;
			},
		}));
		mock.module("../memory-backend.ts", () => ({
			selectedBackend: () => "agent-memory",
			recallInFlightFleetUpgrades: async () => [],
			searchAgentMemory: async () => [],
			dedupeHitsBy: <T>(hits: T[]) => hits,
		}));
		const { teardownIac } = await import("./nodes.ts");
		await teardownIac({
			requestId: "req-1",
			threadId: "thread-abc",
			intent: "renovate-integration-update",
			targetDeployment: "eu-b2b",
			renovateMarker: { marker: "renovate/eu-b2b-prometheus", line: "x" },
			renovateMrUrl: "https://gitlab.example/x/-/merge_requests/517",
		} as unknown as IacStateType);

		expect(capturedDecision).toBeDefined();
		expect(capturedDecision).toContain("eu-b2b");
		expect(capturedDecision).toContain("renovate/eu-b2b-prometheus");
		expect(capturedAnnotations).toMatchObject({
			kind: "renovate-trigger",
			deployment: "eu-b2b",
			marker: "renovate/eu-b2b-prometheus",
			mr_url: "https://gitlab.example/x/-/merge_requests/517",
		});
	});

	test("does NOT record a durable fact when no MR was found yet (nothing settled to recall)", async () => {
		let recordCalled = false;
		mock.module("../memory-writer.ts", () => ({
			appendDailyLog: () => {},
			recordKeyDecision: () => {
				recordCalled = true;
			},
		}));
		mock.module("../memory-backend.ts", () => ({
			selectedBackend: () => "agent-memory",
			recallInFlightFleetUpgrades: async () => [],
			searchAgentMemory: async () => [],
			dedupeHitsBy: <T>(hits: T[]) => hits,
		}));
		const { teardownIac } = await import("./nodes.ts");
		await teardownIac({
			requestId: "req-1",
			threadId: "thread-abc",
			intent: "renovate-integration-update",
			targetDeployment: "eu-b2b",
			renovateMarker: { marker: "renovate/eu-b2b-prometheus", line: "x" },
			renovateMrUrl: "",
		} as unknown as IacStateType);

		expect(recordCalled).toBe(false);
	});

	test("does NOT record a durable fact on the file backend (durable learnings stay PR-gated)", async () => {
		let recordCalled = false;
		mock.module("../memory-writer.ts", () => ({
			appendDailyLog: () => {},
			recordKeyDecision: () => {
				recordCalled = true;
			},
		}));
		mock.module("../memory-backend.ts", () => ({
			selectedBackend: () => "file",
			recallInFlightFleetUpgrades: async () => [],
			searchAgentMemory: async () => [],
			dedupeHitsBy: <T>(hits: T[]) => hits,
		}));
		const { teardownIac } = await import("./nodes.ts");
		await teardownIac({
			requestId: "req-1",
			threadId: "thread-abc",
			intent: "renovate-integration-update",
			targetDeployment: "eu-b2b",
			renovateMarker: { marker: "renovate/eu-b2b-prometheus", line: "x" },
			renovateMrUrl: "https://gitlab.example/x/-/merge_requests/517",
		} as unknown as IacStateType);

		expect(recordCalled).toBe(false);
	});
});

// SIO-1471 follow-up: the durable renovate-trigger fact builders, mirroring
// buildFleetFactDecision/buildFleetFactAnnotations (fleet-upgrade.test.ts) and
// buildIacChangeDecision/buildIacChangeAnnotations (iac-change-memory.test.ts).
describe("buildRenovateFactDecision / buildRenovateFactAnnotations", () => {
	function renovateState(over: Partial<IacStateType> = {}): IacStateType {
		return {
			requestId: "req-1",
			threadId: "thread-abc",
			intent: "renovate-integration-update",
			targetDeployment: "eu-b2b",
			renovateMarker: { marker: "renovate/eu-b2b-prometheus", line: "x" },
			renovateMrUrl: "https://gitlab.example/x/-/merge_requests/517",
			...over,
		} as unknown as IacStateType;
	}

	test("decision names the deployment, the marker, and the MR", async () => {
		const { buildRenovateFactDecision } = await import("./nodes.ts");
		const decision = buildRenovateFactDecision(renovateState());
		expect(decision).toContain("eu-b2b");
		expect(decision).toContain("renovate/eu-b2b-prometheus");
		expect(decision).toContain("https://gitlab.example/x/-/merge_requests/517");
	});

	// Greptile + CodeRabbit (PR #665 round 1): the renovate-integration-update sub-flow's own
	// nodes never set state.targetDeployment (that field is only written by drift/gitops/
	// fleet-upgrade) -- extractRenovateTarget sets state.renovateTarget.deployment instead. On
	// the REAL path targetDeployment and iacRequest.cluster are both empty, so without this
	// fallback the durable fact always recorded the generic "an Elastic deployment" placeholder
	// and the deployment annotation was omitted entirely, making the fact unfindable by a later
	// deployment-scoped recall. Assert the actual resolved value, not just non-emptiness -- the
	// original version of this test only checked decision.length > 0, which is why it passed
	// against the placeholder text and missed the bug both bots caught.
	test("decision resolves the deployment from renovateTarget on the real path (targetDeployment unset)", async () => {
		const { buildRenovateFactDecision } = await import("./nodes.ts");
		const decision = buildRenovateFactDecision(
			renovateState({ targetDeployment: "", renovateTarget: { deployment: "eu-b2b", integration: "prometheus" } }),
		);
		expect(decision).toContain("eu-b2b");
		expect(decision).not.toContain("an Elastic deployment");
	});

	test("annotations carry kind, deployment, marker, and mr_url", async () => {
		const { buildRenovateFactAnnotations } = await import("./nodes.ts");
		const a = buildRenovateFactAnnotations(renovateState());
		expect(a).toMatchObject({
			kind: "renovate-trigger",
			deployment: "eu-b2b",
			marker: "renovate/eu-b2b-prometheus",
			mr_url: "https://gitlab.example/x/-/merge_requests/517",
		});
	});

	test("annotations resolve the deployment from renovateTarget on the real path (targetDeployment unset)", async () => {
		const { buildRenovateFactAnnotations } = await import("./nodes.ts");
		const a = buildRenovateFactAnnotations(
			renovateState({ targetDeployment: "", renovateTarget: { deployment: "eu-b2b", integration: "prometheus" } }),
		);
		expect(a.deployment).toBe("eu-b2b");
	});

	test("annotations omit mr_url when no MR was found", async () => {
		const { buildRenovateFactAnnotations } = await import("./nodes.ts");
		const a = buildRenovateFactAnnotations(renovateState({ renovateMrUrl: "" }));
		expect(a.mr_url).toBeUndefined();
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

	// Greptile (PR #663): an already-checked entry ("- [x]") means Renovate already read
	// this tick -- it is not a PENDING update and must not be re-triggerable. Only
	// unchecked ("- [ ]") lines are genuinely awaiting-schedule candidates.
	test("excludes an already-checked entry", () => {
		const body =
			" - [x] <!-- unschedule-branch=renovate/eu-b2b-prometheus -->chore(deps): [eu-b2b] prometheus to v1.24.4\n" +
			" - [ ] <!-- unschedule-branch=renovate/ap-cld-cisco_ftd -->chore(deps): [ap-cld] cisco_ftd to v3.13.10\n";
		expect(parseRenovateDashboardEntries(body)).toEqual([
			{
				marker: "renovate/ap-cld-cisco_ftd",
				line: " - [ ] <!-- unschedule-branch=renovate/ap-cld-cisco_ftd -->chore(deps): [ap-cld] cisco_ftd to v3.13.10",
			},
		]);
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

import { parseFirstIssueIid, parseIssueDescription, RENOVATE_DASHBOARD_TITLE } from "./nodes.ts";

// SIO-XXXX: live-verified against project 82850717 -- a bare "Dependency Dashboard" search
// string matches FIVE issues as a substring (iid 6/8/9 stale/superseded "Dependency
// Dashboard" issues, iid 10 "Terraform Dependency Dashboard"), so resolveRenovateMarker
// resolved the wrong (stale) issue. RENOVATE_DASHBOARD_TITLE must be the exact, unique
// title of the correct dashboard (iid 11) so the gitlab_search call disambiguates by title
// rather than relying on "first substring match wins".
describe("RENOVATE_DASHBOARD_TITLE", () => {
	test("is the exact title of the Elastic Fleet & Agent Dependency Dashboard, not the generic prefix", () => {
		expect(RENOVATE_DASHBOARD_TITLE).toBe("Elastic Fleet & Agent Dependency Dashboard");
		expect(RENOVATE_DASHBOARD_TITLE).not.toBe("Dependency Dashboard");
	});
});

// gitlab_search (scope: work_items) response shape: an array of GitLab search-result
// objects. Only the numeric `iid` field is needed here, but the `title` must exactly
// match RENOVATE_DASHBOARD_TITLE -- gitlab_search's title match is not guaranteed
// exact/unique (five issues collided on a bare "Dependency Dashboard" substring search).
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
		expect(parseFirstIssueIid(JSON.stringify([{ title: "Elastic Fleet & Agent Dependency Dashboard" }]))).toBeNull();
	});

	test("null when the first result's title does not exactly match RENOVATE_DASHBOARD_TITLE", () => {
		const raw = JSON.stringify([{ iid: 6, title: "Dependency Dashboard" }]);
		expect(parseFirstIssueIid(raw)).toBeNull();
	});

	test("null when the first result is a different dashboard entirely (e.g. Terraform's)", () => {
		const raw = JSON.stringify([{ iid: 10, title: "Terraform Dependency Dashboard" }]);
		expect(parseFirstIssueIid(raw)).toBeNull();
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

// gitlab_list_merge_requests_by_source_branch is a gitlabFetch-backed elastic-iac tool
// (packages/mcp-server-elastic-iac/src/tools/shared.ts), so its real response is ALWAYS
// prefixed with the HTTP status: `[${res.status}] ${text}`. The bare-JSON cases below (no
// prefix) do not exercise that envelope; the "[200] [...]" case is the shape this function
// actually receives in production, same envelope parseNewestPipeline/parseLatestAgentMr
// already handle.
describe("parseFirstOpenMrUrl", () => {
	test("returns the web_url of the first MR in the array", () => {
		const raw = JSON.stringify([{ iid: 42, web_url: "https://gitlab.example/x/-/merge_requests/42", state: "opened" }]);
		expect(parseFirstOpenMrUrl(raw)).toBe("https://gitlab.example/x/-/merge_requests/42");
	});

	// Greptile round 2 (PR #663): the branch is versionless and reused across releases, so
	// an open MR on it could be a STALE one this trigger never touched (e.g. this run's
	// tick/schedule silently failed while an older, unrelated open MR happened to exist).
	// A sinceIso cutoff proves freshness -- only an MR Renovate actually touched AT OR AFTER
	// the trigger counts as "created by this run".
	test("with a sinceIso cutoff, skips an MR updated before the trigger", () => {
		const raw = JSON.stringify([
			{
				iid: 42,
				web_url: "https://gitlab.example/x/-/merge_requests/42",
				state: "opened",
				updated_at: "2026-08-15T10:00:00.000Z",
			},
		]);
		expect(parseFirstOpenMrUrl(raw, "2026-08-15T12:00:00.000Z")).toBeNull();
	});

	test("with a sinceIso cutoff, returns an MR updated at or after the trigger", () => {
		const raw = JSON.stringify([
			{
				iid: 42,
				web_url: "https://gitlab.example/x/-/merge_requests/42",
				state: "opened",
				updated_at: "2026-08-15T12:00:00.000Z",
			},
		]);
		expect(parseFirstOpenMrUrl(raw, "2026-08-15T12:00:00.000Z")).toBe("https://gitlab.example/x/-/merge_requests/42");
	});

	test("with a sinceIso cutoff, finds the first FRESH MR even if it is not array index 0", () => {
		const raw = JSON.stringify([
			{ iid: 41, web_url: "https://gitlab.example/x/-/merge_requests/41", updated_at: "2026-08-15T09:00:00.000Z" },
			{ iid: 42, web_url: "https://gitlab.example/x/-/merge_requests/42", updated_at: "2026-08-15T12:30:00.000Z" },
		]);
		expect(parseFirstOpenMrUrl(raw, "2026-08-15T12:00:00.000Z")).toBe("https://gitlab.example/x/-/merge_requests/42");
	});

	test("without a sinceIso cutoff, behaves exactly as before (back-compat)", () => {
		const raw = JSON.stringify([{ iid: 42, web_url: "https://gitlab.example/x/-/merge_requests/42" }]);
		expect(parseFirstOpenMrUrl(raw)).toBe("https://gitlab.example/x/-/merge_requests/42");
	});

	test("null on an empty array", () => {
		expect(parseFirstOpenMrUrl("[]")).toBeNull();
	});

	test("null on malformed/error response", () => {
		expect(parseFirstOpenMrUrl("[404] not found")).toBeNull();
	});

	test("real gitlabFetch envelope: '[200] [...]' status prefix -- the shape this function actually receives", () => {
		const raw = `[200] ${JSON.stringify([{ iid: 517, web_url: "https://gitlab.example/x/-/merge_requests/517", state: "opened" }])}`;
		expect(parseFirstOpenMrUrl(raw)).toBe("https://gitlab.example/x/-/merge_requests/517");
	});

	test("real gitlabFetch envelope: '[200] []' empty array -> null", () => {
		expect(parseFirstOpenMrUrl("[200] []")).toBeNull();
	});
});

// Greptile (PR #663): the 7 renovate-integration-update sub-flow fields are now reset at
// turn start by TURN_START_RESET (bootstrapIac spreads it on every turn), matching every
// other turn-scoped field (blockedReason, versionDrift, etc.) -- this prevents a declined
// gate (renovateTriggerApproved: false) or a resolved marker from a PRIOR turn leaking into
// a LATER, unrelated turn on the same thread, which would otherwise cause
// iacTurnOutcome's declined-check to misreport that unrelated turn as declined.
import { TURN_START_RESET } from "./nodes.ts";

describe("TURN_START_RESET (renovate-integration-update fields)", () => {
	test("resets all 11 renovate-integration-update fields", () => {
		expect(TURN_START_RESET).toMatchObject({
			renovateTarget: null,
			renovateCandidates: [],
			renovateMarker: null,
			renovateTriggerApproved: null,
			renovateIssueIid: null,
			renovateMrUrl: "",
			renovateTriggerAtIso: "",
			renovateInstalledVersion: null,
			renovateTargetVersion: null,
			renovatePolicyCount: null,
			renovateChangelog: [],
		});
	});
});

import { compareSemver, parseRenovateTargetVersion } from "./nodes.ts";

describe("parseRenovateTargetVersion", () => {
	test("parses the target version from a real dashboard line", () => {
		const line =
			" - [ ] <!-- unschedule-branch=renovate/eu-onboarding-elastic_agent -->chore(deps): [eu-onboarding] elastic_agent to v2.9.4";
		expect(parseRenovateTargetVersion(line)).toBe("2.9.4");
	});

	test("parses a version with only major.minor (no patch)", () => {
		const line = " - [ ] <!-- unschedule-branch=x -->chore(deps): [eu-b2b] system to v2.22";
		expect(parseRenovateTargetVersion(line)).toBe("2.22");
	});

	test("returns null when the line has no 'to vX.Y.Z' suffix", () => {
		expect(parseRenovateTargetVersion("chore(deps): bump something")).toBeNull();
	});

	test("returns null for an empty string", () => {
		expect(parseRenovateTargetVersion("")).toBeNull();
	});
});

describe("compareSemver", () => {
	test("orders a lower version before a higher one", () => {
		expect(compareSemver("2.8.0", "2.9.4")).toBeLessThan(0);
	});

	test("orders a higher version after a lower one", () => {
		expect(compareSemver("2.9.4", "2.8.0")).toBeGreaterThan(0);
	});

	test("returns 0 for equal versions", () => {
		expect(compareSemver("2.9.4", "2.9.4")).toBe(0);
	});

	test("compares patch versions correctly (numeric, not lexical)", () => {
		// Lexical comparison would wrongly order "2.9.10" before "2.9.9" -- must compare numerically.
		expect(compareSemver("2.9.9", "2.9.10")).toBeLessThan(0);
	});

	test("treats a missing patch component as 0", () => {
		expect(compareSemver("2.22", "2.22.1")).toBeLessThan(0);
		expect(compareSemver("2.22.0", "2.22")).toBe(0);
	});
});

import { type ChangelogEntry, filterChangelogRange } from "./nodes.ts";

describe("filterChangelogRange", () => {
	const entries: ChangelogEntry[] = [
		{ version: "2.9.4", changes: [{ description: "Add system.cpu.cores", type: "enhancement" }] },
		{ version: "2.9.3", changes: [{ description: "Fix X", type: "bugfix" }] },
		{ version: "2.9.1", changes: [{ description: "Fix Y", type: "bugfix" }] },
		{ version: "2.8.1", changes: [{ description: "Fix Z", type: "bugfix" }] },
		{ version: "2.8.0", changes: [{ description: "Initial", type: "enhancement" }] },
	];

	test("returns every entry strictly above installed and up to and including target", () => {
		const result = filterChangelogRange(entries, "2.8.0", "2.9.4");
		expect(result.map((e) => e.version)).toEqual(["2.9.4", "2.9.3", "2.9.1", "2.8.1"]);
	});

	test("excludes the installed version itself", () => {
		const result = filterChangelogRange(entries, "2.8.1", "2.9.4");
		expect(result.map((e) => e.version)).not.toContain("2.8.1");
	});

	test("excludes versions above the target", () => {
		const result = filterChangelogRange(entries, "2.8.0", "2.9.1");
		expect(result.map((e) => e.version)).toEqual(["2.9.1", "2.8.1"]);
	});

	test("returns an empty array when installed already equals target", () => {
		expect(filterChangelogRange(entries, "2.9.4", "2.9.4")).toEqual([]);
	});

	test("falls back to only the target version's own entry when installedVersion is null", () => {
		const result = filterChangelogRange(entries, null, "2.9.3");
		expect(result.map((e) => e.version)).toEqual(["2.9.3"]);
	});

	test("returns an empty array when installedVersion is null and the target has no matching entry", () => {
		expect(filterChangelogRange(entries, null, "3.0.0")).toEqual([]);
	});

	test("preserves newest-first order from the input", () => {
		const result = filterChangelogRange(entries, "2.8.0", "2.9.4");
		for (let i = 1; i < result.length; i++) {
			const prev = result[i - 1];
			const curr = result[i];
			if (prev && curr) {
				expect(compareSemverForTest(prev.version, curr.version)).toBeGreaterThanOrEqual(0);
			}
		}
	});
});

// Local helper for the ordering assertion above -- avoids re-exporting compareSemver just for the test.
function compareSemverForTest(a: string, b: string): number {
	const pa = a.split(".").map(Number);
	const pb = b.split(".").map(Number);
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
		if (diff !== 0) return diff;
	}
	return 0;
}
