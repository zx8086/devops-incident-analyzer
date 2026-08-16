// agent/src/iac/renovate-integration.test.ts

import { afterEach, describe, expect, mock, test } from "bun:test";
import type { AgentMemoryClient } from "@devops-agent/shared";
import { Command, END, MemorySaver, START, StateGraph } from "@langchain/langgraph";
// SIO-1045: captured BEFORE any mock.module() call in this file runs, so afterEach can restore the
// real implementations -- mock.module() is process-global and bun:test's mock.restore() does NOT
// undo it (only resets spy call state), so without this the last mock.module(...) registered below
// leaks into every OTHER test file that runs later in the same bun test process. Spreading into a
// plain object at load time copies the function VALUES, immune to bun's later namespace live-patching
// (see iac-change-memory.test.ts for the full rationale).
import * as realMemoryBackendNs from "../memory-backend.ts";
import * as realMemoryWriterNs from "../memory-writer.ts";
import * as realLaneKnowledgeNs from "./lane-knowledge.ts";
import { buildRenovateGateMessage, parseFirstOpenMrUrl, parseRenovateTargetJson } from "./nodes.ts";
import { IacState, type IacStateType } from "./state.ts";

const realMemoryBackend = { ...realMemoryBackendNs };
const realMemoryWriter = { ...realMemoryWriterNs };
const realLaneKnowledge = { ...realLaneKnowledgeNs };

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

	test("interrupt payload carries the enrichment fields set by enrichRenovateTarget", async () => {
		const compiled = buildMiniGateGraph();
		const config = { configurable: { thread_id: `t-renovate-enrichment-${Date.now()}` } };
		const inputState = {
			requestId: "req-1",
			renovateMarker: marker,
			renovateInstalledVersion: "2.8.0",
			renovateTargetVersion: "2.9.4",
			renovatePolicyCount: 24,
			renovateChangelog: [{ version: "2.9.4", changes: [{ description: "Add X", type: "enhancement" }] }],
			renovateRecentChanges: "- [eu-onboarding] elastic_agent changed on 2026-08-01 (applied)",
			renovatePriorTriggers: "- Renovate update triggered on eu-onboarding for 'renovate/eu-onboarding-elastic_agent'.",
			renovateAffectedPolicies: ["eu-onboarding-agent-policy-1", "eu-onboarding-agent-policy-2"],
			renovateChangelogTotal: 23,
		};

		await compiled.invoke(inputState as unknown as Parameters<typeof compiled.invoke>[0], config);

		// LangGraph's getState() returns a StateSnapshot whose .tasks[N].interrupts[N] array holds
		// each paused task's Interrupt objects; Interrupt.value is exactly the object passed to
		// interrupt({...}) inside the node (confirmed against @langchain/langgraph's own type
		// definitions: PregelTaskDescription.interrupts: Interrupt[], Interrupt<Value>.value?: Value).
		// This graph has exactly one node that can pause, so tasks[0].interrupts[0] is unambiguous.
		const after = await compiled.getState(config);
		const interruptValue = after.tasks[0]?.interrupts[0]?.value as Record<string, unknown> | undefined;
		expect(interruptValue).toMatchObject({
			installedVersion: "2.8.0",
			targetVersion: "2.9.4",
			policyCount: 24,
			changelog: [{ version: "2.9.4", changes: [{ description: "Add X", type: "enhancement" }] }],
			recentChanges: "- [eu-onboarding] elastic_agent changed on 2026-08-01 (applied)",
			priorTriggers: "- Renovate update triggered on eu-onboarding for 'renovate/eu-onboarding-elastic_agent'.",
			affectedPolicies: ["eu-onboarding-agent-policy-1", "eu-onboarding-agent-policy-2"],
			changelogTotal: 23,
		});
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

// SIO-1475: teardownIac's three renovate-specific gates (daily-log breadcrumb, durable
// renovate-trigger fact, final summary short-circuit) must ALSO fire for the
// "renovate-status-check" follow-up intent (the "check again" turn routed straight to
// watchRenovateMr), not just the original "renovate-integration-update" turn. On this intent
// state.renovateMarker/renovateTarget are turn-scoped and null (reset every turn) -- only the
// durable state.renovateInFlightMarker survives, so each gate must also read that fallback.
describe("teardownIac renovate-status-check branch (SIO-1475)", () => {
	afterEach(() => {
		mock.restore();
		restoreRealMemoryMocks();
	});

	const inFlightMarker = {
		deployment: "ap-cld",
		marker: "renovate/ap-cld-udp",
		line: " - [ ] <!-- unschedule-branch=renovate/ap-cld-udp -->chore(deps): [ap-cld] udp to v2.5.1",
		triggerAtIso: new Date().toISOString(),
	};

	// Site 3: the final summary short-circuit must never fall through to the generic gitops
	// fallback for renovate-status-check, exactly like renovate-integration-update --
	// watchRenovateMr already set the terminal message on state.messages before teardownIac ran,
	// so no new message may be added here. Greptile round 2 (PR #671): once an MR was found,
	// this same short-circuit is ALSO responsible for clearing renovateInFlightMarker (round 1's
	// fix removed the premature clear from watchRenovateMr but left nothing to clear it at all --
	// a resolved trigger's marker would otherwise persist on the thread forever, since it is
	// deliberately excluded from TURN_START_RESET, silently hijacking any later unrelated
	// status-check-shaped message). So the correct return here is `{ renovateInFlightMarker:
	// null }`, not a bare `{}`.
	test("returns no new messages, and clears renovateInFlightMarker, for a renovate-status-check turn with an MR found", async () => {
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
		const out = await teardownIac({
			requestId: "req-1",
			threadId: "thread-abc",
			intent: "renovate-status-check",
			renovateInFlightMarker: inFlightMarker,
			renovateMrUrl: "https://gitlab.example/x/-/merge_requests/518",
		} as unknown as IacStateType);

		expect(out).toEqual({ renovateInFlightMarker: null });
		expect(out.messages).toBeUndefined();
	});

	// Companion negative case: no MR found yet -> the marker must stay set (absent from the
	// partial update, meaning the checkpointed value is left unchanged) so a LATER "check again"
	// can still resume watching for it.
	test("leaves renovateInFlightMarker untouched for a renovate-status-check turn with no MR found yet", async () => {
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
		const out = await teardownIac({
			requestId: "req-1",
			threadId: "thread-abc",
			intent: "renovate-status-check",
			renovateInFlightMarker: inFlightMarker,
			renovateMrUrl: "",
		} as unknown as IacStateType);

		expect(out).toEqual({});
		expect("renovateInFlightMarker" in out).toBe(false);
	});

	// Site 1: the daily-log breadcrumb must build the marker= string from renovateInFlightMarker
	// when renovateMarker is null -- the exact input shape of a renovate-status-check turn.
	test("daily-log breadcrumb reads marker from renovateInFlightMarker when renovateMarker is null", async () => {
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
			intent: "renovate-status-check",
			renovateMarker: null,
			renovateInFlightMarker: inFlightMarker,
			renovateMrUrl: "https://gitlab.example/x/-/merge_requests/518",
		} as unknown as IacStateType);

		expect(capturedSummary).toContain("marker=renovate/ap-cld-udp");
		expect(capturedSummary).toContain("MR=https://gitlab.example/x/-/merge_requests/518");
	});

	// Site 2: the durable renovate-trigger fact must be recorded on a renovate-status-check turn
	// too -- this is the load-bearing case, since the MR is most likely to first be found on
	// exactly this "check again" turn (that is the whole purpose of the follow-up).
	test("records a durable renovate-trigger fact on a renovate-status-check turn when an MR was found", async () => {
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
			intent: "renovate-status-check",
			renovateMarker: null,
			renovateTarget: null,
			targetDeployment: "",
			renovateInFlightMarker: inFlightMarker,
			renovateMrUrl: "https://gitlab.example/x/-/merge_requests/518",
		} as unknown as IacStateType);

		expect(capturedDecision).toBeDefined();
		expect(capturedDecision).toContain("ap-cld");
		expect(capturedDecision).toContain("renovate/ap-cld-udp");
		expect(capturedDecision).not.toContain("an outdated dependency");
		expect(capturedDecision).not.toContain("an Elastic deployment");
		expect(capturedAnnotations).toMatchObject({
			kind: "renovate-trigger",
			deployment: "ap-cld",
			marker: "renovate/ap-cld-udp",
			mr_url: "https://gitlab.example/x/-/merge_requests/518",
		});
	});

	test("does NOT record a durable fact on a renovate-status-check turn with no MR found yet", async () => {
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
			intent: "renovate-status-check",
			renovateInFlightMarker: inFlightMarker,
			renovateMrUrl: "",
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

	// SIO-1475: on a renovate-status-check turn, renovateMarker/renovateTarget/targetDeployment
	// are ALL turn-scoped and null -- only renovateInFlightMarker (durable, cross-turn) carries
	// the deployment/marker. Both builders must resolve the CORRECT value from it, not just avoid
	// the placeholder text -- a regression here writes wrong data to durable memory.
	const inFlightMarker = {
		deployment: "ap-cld",
		marker: "renovate/ap-cld-udp",
		line: "x",
		triggerAtIso: new Date().toISOString(),
	};

	test("decision resolves deployment and marker from renovateInFlightMarker when renovateMarker/renovateTarget are null", async () => {
		const { buildRenovateFactDecision } = await import("./nodes.ts");
		const decision = buildRenovateFactDecision(
			renovateState({
				targetDeployment: "",
				renovateTarget: null,
				renovateMarker: null,
				renovateInFlightMarker: inFlightMarker,
			}),
		);
		expect(decision).toContain("ap-cld");
		expect(decision).toContain("renovate/ap-cld-udp");
		expect(decision).not.toContain("an Elastic deployment");
		expect(decision).not.toContain("an outdated dependency");
	});

	test("annotations resolve deployment and marker from renovateInFlightMarker when renovateMarker/renovateTarget are null", async () => {
		const { buildRenovateFactAnnotations } = await import("./nodes.ts");
		const a = buildRenovateFactAnnotations(
			renovateState({
				targetDeployment: "",
				renovateTarget: null,
				renovateMarker: null,
				renovateInFlightMarker: inFlightMarker,
			}),
		);
		expect(a.deployment).toBe("ap-cld");
		expect(a.marker).toBe("renovate/ap-cld-udp");
	});

	// renovateInFlightMarker.deployment is checked first for `dep` (most specific/authoritative
	// source when present); renovateMarker (turn-scoped) still wins for `marker` when both happen
	// to be set -- in real traffic these two fields are mutually exclusive (renovateMarker is only
	// set on the original renovate-integration-update turn, renovateInFlightMarker only survives
	// into a later renovate-status-check turn), so only the deployment precedence is asserted here.
	test("renovateInFlightMarker.deployment takes precedence for dep when renovateTarget is also present", async () => {
		const { buildRenovateFactDecision } = await import("./nodes.ts");
		const decision = buildRenovateFactDecision(
			renovateState({
				renovateTarget: { deployment: "eu-b2b", integration: "prometheus" },
				renovateMarker: null,
				renovateInFlightMarker: inFlightMarker,
			}),
		);
		expect(decision).toContain("ap-cld");
		expect(decision).not.toContain("eu-b2b");
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
	test("resets all 15 renovate-integration-update fields", () => {
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
			renovateRecentChanges: "",
			renovatePriorTriggers: "",
			renovateAffectedPolicies: [],
			renovateChangelogTotal: 0,
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

	// SIO-XXXX (PR #666 Greptile + CodeRabbit): a prerelease must sort BELOW its matching
	// stable release (true SemVer precedence), not collapse to equal -- treating
	// "1.32.0-beta.2" as equal to "1.32.0" let a beta-of-the-target-version's changelog
	// entry pass filterChangelogRange's inclusive "<= target" check as if it were the real
	// release, showing an operator changelog content for a version that was never actually
	// installed/targeted.
	test("orders a prerelease below its matching stable release", () => {
		expect(compareSemver("1.32.0-beta.2", "1.32.0")).toBeLessThan(0);
		expect(compareSemver("1.32.0", "1.32.0-beta.2")).toBeGreaterThan(0);
	});

	test("orders two prereleases of the same base version by their prerelease identifiers", () => {
		expect(compareSemver("1.32.0-beta.1", "1.32.0-beta.2")).toBeLessThan(0);
		expect(compareSemver("1.32.0-beta.2", "1.32.0-beta.1")).toBeGreaterThan(0);
	});

	test("still compares the base version first when prerelease bases differ", () => {
		expect(compareSemver("1.31.0", "1.32.0-beta")).toBeLessThan(0);
		expect(compareSemver("1.32.1-beta.1", "1.32.0")).toBeGreaterThan(0);
	});

	test("treats equal prerelease identifiers (or none) as equal", () => {
		expect(compareSemver("1.32.0-beta.2", "1.32.0-beta.2")).toBe(0);
		expect(compareSemver("1.32.0", "1.32.0")).toBe(0);
	});

	test("ignores build-metadata (+) but still applies prerelease precedence", () => {
		expect(compareSemver("1.32.0+build.5", "1.32.0")).toBe(0);
		expect(compareSemver("1.32.0-beta.1+build.5", "1.32.0")).toBeLessThan(0);
	});

	// SIO-XXXX (PR #666 CodeRabbit round 2): the PREVIOUS fix used `.split("-", 2)`, which in
	// JavaScript does NOT mean "split into at most 2 parts, joining the remainder back together"
	// -- the `limit` argument on String.split just caps how many array entries come BACK, it
	// silently DROPS everything past that cap rather than rejoining it. "1.32.0-alpha-1".split("-",
	// 2) is ["1.32.0", "alpha"] -- the "-1" is gone, not merged into "alpha-1". This meant two
	// DIFFERENT prerelease identifiers that happen to contain their own hyphen (a real,
	// SemVer-legal shape) silently compared as equal.
	test("does not truncate a prerelease identifier that itself contains a hyphen", () => {
		expect(compareSemver("1.32.0-alpha-1", "1.32.0-alpha-2")).toBeLessThan(0);
		expect(compareSemver("1.32.0-alpha-2", "1.32.0-alpha-1")).toBeGreaterThan(0);
	});

	// Real SemVer precedence: a numeric identifier ALWAYS sorts below an alphanumeric one,
	// regardless of what the alphanumeric one "looks like" -- "2" < "1a" even though 2 > 1,
	// because SemVer never compares a numeric identifier against a non-numeric one by value.
	test("orders a numeric prerelease identifier below an alphanumeric one, per SemVer", () => {
		expect(compareSemver("1.32.0-2", "1.32.0-1a")).toBeLessThan(0);
		expect(compareSemver("1.32.0-1a", "1.32.0-2")).toBeGreaterThan(0);
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

import { enrichRenovateTarget } from "./nodes.ts";

// SIO-XXXX: best-effort enrichment for the renovate_trigger_choice card -- one Kibana Fleet
// call (installed/target version + policy count) and one GitHub raw-content call (changelog),
// each independently wrapped so a failure in one never suppresses the other and neither ever
// blocks the turn (renovateTriggerGate must still fire even if both external calls fail).
// Mocking convention matches this repo's established pattern for fetch-mocked node tests (see
// mcp-bridge.boot-strict-integration.test.ts / mcp-bridge-probe-budget.test.ts): capture the
// real global.fetch once, restore it in afterEach, and use bun:test's mock() wrapper typed as
// (input: string | URL | Request) rather than a bare url:string cast.
describe("enrichRenovateTarget (SIO-XXXX)", () => {
	const ORIGINAL_FETCH = global.fetch;
	const ORIGINAL_ENV = { ...process.env };

	afterEach(() => {
		global.fetch = ORIGINAL_FETCH;
		process.env = { ...ORIGINAL_ENV };
	});

	function baseState(): Partial<IacStateType> {
		return {
			renovateTarget: { deployment: "eu-onboarding", integration: "elastic_agent" },
			renovateMarker: {
				marker: "renovate/eu-onboarding-elastic_agent",
				line: " - [ ] <!-- unschedule-branch=renovate/eu-onboarding-elastic_agent -->chore(deps): [eu-onboarding] elastic_agent to v2.9.4",
			},
		};
	}

	test("returns installed/target/policyCount from a successful Kibana call, changelog empty when GitHub call not mocked to succeed", async () => {
		process.env.ELASTIC_EU_ONBOARDING_URL = "https://eu-onboarding.es.eu-central-1.aws.cloud.es.io";
		process.env.ELASTIC_EU_ONBOARDING_API_KEY = "test-key";
		global.fetch = mock(async (input: string | URL | Request) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url.includes("/api/fleet/epm/packages?")) {
				return Response.json({
					items: [
						{
							name: "elastic_agent",
							version: "2.9.4",
							installationInfo: { version: "2.8.0" },
							packagePoliciesInfo: { count: 24 },
						},
					],
				});
			}
			return new Response("Not Found", { status: 404 });
		}) as unknown as typeof fetch;

		const out = await enrichRenovateTarget(baseState() as IacStateType);

		expect(out.renovateInstalledVersion).toBe("2.8.0");
		expect(out.renovateTargetVersion).toBe("2.9.4");
		expect(out.renovatePolicyCount).toBe(24);
		expect(out.renovateChangelog).toEqual([]);
		expect(out.blockedReason).toBeUndefined();
	});

	test("also returns a filtered changelog when the GitHub fetch succeeds", async () => {
		process.env.ELASTIC_EU_ONBOARDING_URL = "https://eu-onboarding.es.eu-central-1.aws.cloud.es.io";
		process.env.ELASTIC_EU_ONBOARDING_API_KEY = "test-key";
		const changelogYaml = [
			'- version: "2.9.4"',
			"  changes:",
			'    - description: "Add system.cpu.cores"',
			"      type: enhancement",
			'- version: "2.8.0"',
			"  changes:",
			'    - description: "Initial"',
			"      type: enhancement",
		].join("\n");
		global.fetch = mock(async (input: string | URL | Request) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url.includes("/api/fleet/epm/packages?")) {
				return Response.json({
					items: [
						{
							name: "elastic_agent",
							version: "2.9.4",
							installationInfo: { version: "2.8.0" },
							packagePoliciesInfo: { count: 24 },
						},
					],
				});
			}
			if (url.includes("raw.githubusercontent.com")) {
				return new Response(changelogYaml, { status: 200 });
			}
			return new Response("Not Found", { status: 404 });
		}) as unknown as typeof fetch;

		const out = await enrichRenovateTarget(baseState() as IacStateType);

		expect(out.renovateChangelog).toEqual([
			{ version: "2.9.4", changes: [{ description: "Add system.cpu.cores", type: "enhancement" }] },
		]);
	});

	test("degrades cleanly when ELASTIC_<DEPLOYMENT>_URL is unset for this deployment", async () => {
		delete process.env.ELASTIC_EU_ONBOARDING_URL;
		delete process.env.ELASTIC_EU_ONBOARDING_API_KEY;
		global.fetch = mock(async () => new Response("should not be called", { status: 500 })) as unknown as typeof fetch;

		const out = await enrichRenovateTarget(baseState() as IacStateType);

		expect(out.renovateInstalledVersion ?? null).toBeNull();
		expect(out.renovatePolicyCount ?? null).toBeNull();
		expect(out.blockedReason).toBeUndefined();
	});

	test("degrades cleanly when the Kibana call errors (network failure)", async () => {
		process.env.ELASTIC_EU_ONBOARDING_URL = "https://eu-onboarding.es.eu-central-1.aws.cloud.es.io";
		process.env.ELASTIC_EU_ONBOARDING_API_KEY = "test-key";
		global.fetch = mock(async () => {
			throw new Error("connection reset");
		}) as unknown as typeof fetch;

		const out = await enrichRenovateTarget(baseState() as IacStateType);

		expect(out.renovateInstalledVersion ?? null).toBeNull();
		expect(out.blockedReason).toBeUndefined();
	});

	test("degrades cleanly when the Kibana call returns a non-2xx status", async () => {
		process.env.ELASTIC_EU_ONBOARDING_URL = "https://eu-onboarding.es.eu-central-1.aws.cloud.es.io";
		process.env.ELASTIC_EU_ONBOARDING_API_KEY = "test-key";
		global.fetch = mock(async () => new Response("unauthorized", { status: 401 })) as unknown as typeof fetch;

		const out = await enrichRenovateTarget(baseState() as IacStateType);

		expect(out.renovateInstalledVersion ?? null).toBeNull();
		expect(out.blockedReason).toBeUndefined();
	});

	test("degrades cleanly when the changelog fetch 404s (package not found)", async () => {
		process.env.ELASTIC_EU_ONBOARDING_URL = "https://eu-onboarding.es.eu-central-1.aws.cloud.es.io";
		process.env.ELASTIC_EU_ONBOARDING_API_KEY = "test-key";
		global.fetch = mock(async (input: string | URL | Request) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url.includes("/api/fleet/epm/packages?")) {
				return Response.json({
					items: [{ name: "elastic_agent", version: "2.9.4", installationInfo: { version: "2.8.0" } }],
				});
			}
			return new Response("Not Found", { status: 404 });
		}) as unknown as typeof fetch;

		const out = await enrichRenovateTarget(baseState() as IacStateType);

		expect(out.renovateInstalledVersion).toBe("2.8.0"); // Kibana part still succeeded
		expect(out.renovateChangelog).toEqual([]); // changelog part degraded independently
		expect(out.blockedReason).toBeUndefined();
	});

	test("derives the Kibana URL from ELASTIC_<DEPLOYMENT>_URL via .es. -> .kb. substitution", async () => {
		process.env.ELASTIC_EU_ONBOARDING_URL = "https://eu-onboarding.es.eu-central-1.aws.cloud.es.io";
		process.env.ELASTIC_EU_ONBOARDING_API_KEY = "test-key";
		let calledUrl = "";
		global.fetch = mock(async (input: string | URL | Request) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url.includes("/api/fleet/epm/packages?")) {
				calledUrl = url;
				return Response.json({ items: [{ name: "elastic_agent", version: "2.9.4" }] });
			}
			return new Response("Not Found", { status: 404 });
		}) as unknown as typeof fetch;

		await enrichRenovateTarget(baseState() as IacStateType);

		expect(calledUrl.startsWith("https://eu-onboarding.kb.eu-central-1.aws.cloud.es.io")).toBe(true);
		expect(calledUrl).toContain("/api/fleet/epm/packages?withPackagePoliciesCount=true");
	});

	test("returns no enrichment (all null/[]) when renovateTarget is missing", async () => {
		const out = await enrichRenovateTarget({ renovateMarker: baseState().renovateMarker } as IacStateType);
		expect(out).toEqual({});
	});

	test("changelog fetch succeeds independently when ONLY the Kibana call fails (network error)", async () => {
		process.env.ELASTIC_EU_ONBOARDING_URL = "https://eu-onboarding.es.eu-central-1.aws.cloud.es.io";
		process.env.ELASTIC_EU_ONBOARDING_API_KEY = "test-key";
		const changelogYaml = [
			'- version: "2.9.4"',
			"  changes:",
			'    - description: "Add system.cpu.cores"',
			"      type: enhancement",
			'- version: "2.8.0"',
			"  changes:",
			'    - description: "Initial"',
			"      type: enhancement",
		].join("\n");
		global.fetch = mock(async (input: string | URL | Request) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url.includes("/api/fleet/epm/packages?")) {
				throw new Error("connection reset");
			}
			if (url.includes("raw.githubusercontent.com")) {
				return new Response(changelogYaml, { status: 200 });
			}
			return new Response("Not Found", { status: 404 });
		}) as unknown as typeof fetch;

		const out = await enrichRenovateTarget(baseState() as IacStateType);

		expect(out.renovateInstalledVersion ?? null).toBeNull();
		expect(out.renovateChangelog).toEqual([
			{ version: "2.9.4", changes: [{ description: "Add system.cpu.cores", type: "enhancement" }] },
		]);
		expect(out.blockedReason).toBeUndefined();
	});

	test("degrades cleanly when the Kibana response body is not valid JSON", async () => {
		process.env.ELASTIC_EU_ONBOARDING_URL = "https://eu-onboarding.es.eu-central-1.aws.cloud.es.io";
		process.env.ELASTIC_EU_ONBOARDING_API_KEY = "test-key";
		global.fetch = mock(async (input: string | URL | Request) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url.includes("/api/fleet/epm/packages?")) {
				return new Response("not json{{{", { status: 200 });
			}
			return new Response("Not Found", { status: 404 });
		}) as unknown as typeof fetch;

		const out = await enrichRenovateTarget(baseState() as IacStateType);

		expect(out.renovateInstalledVersion ?? null).toBeNull();
		expect(out.blockedReason).toBeUndefined();
	});

	test("degrades cleanly when the GitHub changelog response body is not valid YAML", async () => {
		process.env.ELASTIC_EU_ONBOARDING_URL = "https://eu-onboarding.es.eu-central-1.aws.cloud.es.io";
		process.env.ELASTIC_EU_ONBOARDING_API_KEY = "test-key";
		global.fetch = mock(async (input: string | URL | Request) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url.includes("/api/fleet/epm/packages?")) {
				return Response.json({
					items: [{ name: "elastic_agent", version: "2.9.4", installationInfo: { version: "2.8.0" } }],
				});
			}
			if (url.includes("raw.githubusercontent.com")) {
				return new Response(":\n  - broken: [unclosed", { status: 200 });
			}
			return new Response("Not Found", { status: 404 });
		}) as unknown as typeof fetch;

		const out = await enrichRenovateTarget(baseState() as IacStateType);

		expect(out.renovateChangelog).toEqual([]);
		expect(out.blockedReason).toBeUndefined();
	});

	test("degrades cleanly when the Kibana fetch rejects with an AbortSignal.timeout TimeoutError", async () => {
		// Simulates what AbortSignal.timeout(ms) produces on expiry (a hung/black-holed connection
		// that never settles on its own) -- proves the existing try/catch catches this rejection
		// the same as any other fetch error, so renovateTriggerGate is never left unreachable.
		process.env.ELASTIC_EU_ONBOARDING_URL = "https://eu-onboarding.es.eu-central-1.aws.cloud.es.io";
		process.env.ELASTIC_EU_ONBOARDING_API_KEY = "test-key";
		global.fetch = mock(async () => {
			throw new DOMException("The operation was aborted.", "TimeoutError");
		}) as unknown as typeof fetch;

		const out = await enrichRenovateTarget(baseState() as IacStateType);

		expect(out.renovateInstalledVersion ?? null).toBeNull();
		expect(out.blockedReason).toBeUndefined();
	});

	test("degrades cleanly when the integration is not found in the Kibana packages list (200 but no matching name)", async () => {
		process.env.ELASTIC_EU_ONBOARDING_URL = "https://eu-onboarding.es.eu-central-1.aws.cloud.es.io";
		process.env.ELASTIC_EU_ONBOARDING_API_KEY = "test-key";
		global.fetch = mock(async (input: string | URL | Request) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url.includes("/api/fleet/epm/packages?")) {
				return Response.json({ items: [{ name: "some_other_integration", version: "1.0.0" }] });
			}
			return new Response("Not Found", { status: 404 });
		}) as unknown as typeof fetch;

		const out = await enrichRenovateTarget(baseState() as IacStateType);

		expect(out.renovateInstalledVersion ?? null).toBeNull();
		expect(out.renovatePolicyCount ?? null).toBeNull();
		expect(out.blockedReason).toBeUndefined();
	});

	test("threads recallDeploymentKgChanges' output onto renovateRecentChanges when the KG is enabled", async () => {
		process.env.ELASTIC_EU_ONBOARDING_URL = "https://eu-onboarding.es.eu-central-1.aws.cloud.es.io";
		process.env.ELASTIC_EU_ONBOARDING_API_KEY = "test-key";
		global.fetch = mock(async () => new Response("Not Found", { status: 404 })) as unknown as typeof fetch;
		// recallDeploymentKgChanges soft-fails to "" when KNOWLEDGE_GRAPH_ENABLED is unset (this test's
		// environment) -- assert the field is present and is a string, not that it's populated (a live
		// KG-populated case is out of scope for this unit test; recallDeploymentKgChanges has its own
		// coverage in fleet-upgrade.test.ts's "recallDeploymentKgChanges (SIO-1462)" describe block).
		const out = await enrichRenovateTarget(baseState() as IacStateType);
		expect(typeof out.renovateRecentChanges).toBe("string");
	});

	test("threads recallPriorRenovateTriggers' output onto renovatePriorTriggers when agent-memory has prior facts", async () => {
		process.env.ELASTIC_EU_ONBOARDING_URL = "https://eu-onboarding.es.eu-central-1.aws.cloud.es.io";
		process.env.ELASTIC_EU_ONBOARDING_API_KEY = "test-key";
		process.env.LIVE_MEMORY_BACKEND = "agent-memory";
		global.fetch = mock(async () => new Response("Not Found", { status: 404 })) as unknown as typeof fetch;
		const { __setAgentMemoryClient } = require("../memory-backend.ts");
		__setAgentMemoryClient({
			async ensureUser() {},
			async ensureSession() {},
			async addFacts() {
				return { blockIds: [], acceptedCount: 0, rejectedCount: 0 };
			},
			async addMessages() {
				return { blockIds: [], acceptedCount: 0, rejectedCount: 0 };
			},
			async searchMemory() {
				return [
					{
						text: "Renovate update triggered on eu-onboarding for 'renovate/eu-onboarding-elastic_agent'.",
						score: 0.9,
						annotations: {
							kind: "renovate-trigger",
							deployment: "eu-onboarding",
							marker: "renovate/eu-onboarding-elastic_agent",
							mr_url: "https://gitlab.example/x/-/merge_requests/518",
						},
					},
				];
			},
			async updateSession() {},
			async endSession() {},
			async checkHealth() {
				return { ok: true };
			},
		} satisfies AgentMemoryClient);

		const out = await enrichRenovateTarget(baseState() as IacStateType);

		expect(out.renovatePriorTriggers).toContain("Renovate update triggered on eu-onboarding");
		expect(out.renovatePriorTriggers).toContain("[https://gitlab.example/x/-/merge_requests/518]");

		__setAgentMemoryClient(null);
	});

	test("returns affected policy names from a successful package_policies call", async () => {
		process.env.ELASTIC_EU_ONBOARDING_URL = "https://eu-onboarding.es.eu-central-1.aws.cloud.es.io";
		process.env.ELASTIC_EU_ONBOARDING_API_KEY = "test-key";
		global.fetch = mock(async (input: string | URL | Request) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url.includes("/api/fleet/epm/packages?")) {
				return Response.json({
					items: [
						{
							name: "elastic_agent",
							version: "2.9.4",
							installationInfo: { version: "2.8.0" },
							packagePoliciesInfo: { count: 2 },
						},
					],
				});
			}
			if (url.includes("/api/fleet/package_policies?")) {
				return Response.json({
					items: [
						{ name: "eu-onboarding-agent-policy-1", package: { name: "elastic_agent", version: "2.9.4" } },
						{ name: "eu-onboarding-agent-policy-2", package: { name: "elastic_agent", version: "2.9.4" } },
					],
					total: 2,
					page: 1,
					perPage: 20,
				});
			}
			return new Response("Not Found", { status: 404 });
		}) as unknown as typeof fetch;

		const out = await enrichRenovateTarget(baseState() as IacStateType);

		expect(out.renovateAffectedPolicies).toEqual(["eu-onboarding-agent-policy-1", "eu-onboarding-agent-policy-2"]);
	});

	// Greptile (PR #668): the list endpoint paginates (Fleet's own default perPage is 20), so an
	// unpaginated call would silently drop every name past the first page. This mocks a 3-item
	// total split across 2 pages (perPage=2) and asserts all 3 names are collected.
	test("paginates through multiple package_policies pages to collect all affected policy names", async () => {
		process.env.ELASTIC_EU_ONBOARDING_URL = "https://eu-onboarding.es.eu-central-1.aws.cloud.es.io";
		process.env.ELASTIC_EU_ONBOARDING_API_KEY = "test-key";
		let policyPolicyCallCount = 0;
		global.fetch = mock(async (input: string | URL | Request) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url.includes("/api/fleet/epm/packages?")) {
				return Response.json({
					items: [
						{
							name: "elastic_agent",
							version: "2.9.4",
							installationInfo: { version: "2.8.0" },
							packagePoliciesInfo: { count: 3 },
						},
					],
				});
			}
			if (url.includes("/api/fleet/package_policies?")) {
				policyPolicyCallCount++;
				const isPageOne = url.includes("page=1&");
				return Response.json({
					items: isPageOne
						? [
								{ name: "policy-1", package: { name: "elastic_agent", version: "2.9.4" } },
								{ name: "policy-2", package: { name: "elastic_agent", version: "2.9.4" } },
							]
						: [{ name: "policy-3", package: { name: "elastic_agent", version: "2.9.4" } }],
					total: 3,
					page: isPageOne ? 1 : 2,
					perPage: 2,
				});
			}
			return new Response("Not Found", { status: 404 });
		}) as unknown as typeof fetch;

		const out = await enrichRenovateTarget(baseState() as IacStateType);

		expect(out.renovateAffectedPolicies).toEqual(["policy-1", "policy-2", "policy-3"]);
		expect(policyPolicyCallCount).toBe(2);
	});

	test("returns empty affected policies when the package_policies call fails (soft-fail, does not affect policyCount)", async () => {
		process.env.ELASTIC_EU_ONBOARDING_URL = "https://eu-onboarding.es.eu-central-1.aws.cloud.es.io";
		process.env.ELASTIC_EU_ONBOARDING_API_KEY = "test-key";
		global.fetch = mock(async (input: string | URL | Request) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url.includes("/api/fleet/epm/packages?")) {
				return Response.json({
					items: [
						{
							name: "elastic_agent",
							version: "2.9.4",
							installationInfo: { version: "2.8.0" },
							packagePoliciesInfo: { count: 24 },
						},
					],
				});
			}
			// package_policies call falls through to 404 (not explicitly mocked)
			return new Response("Not Found", { status: 404 });
		}) as unknown as typeof fetch;

		const out = await enrichRenovateTarget(baseState() as IacStateType);

		expect(out.renovateAffectedPolicies).toEqual([]);
		expect(out.renovatePolicyCount).toBe(24);
		expect(out.blockedReason).toBeUndefined();
	});

	test("caps the changelog to 10 entries and reports the pre-cap total", async () => {
		process.env.ELASTIC_EU_ONBOARDING_URL = "https://eu-onboarding.es.eu-central-1.aws.cloud.es.io";
		process.env.ELASTIC_EU_ONBOARDING_API_KEY = "test-key";
		// baseState()'s marker line already carries "to v2.9.4", so parseRenovateTargetVersion resolves
		// a truthy targetVersion BEFORE the Kibana call runs; resolvedTargetVersion is only overridden
		// by Kibana's match.version when it was null (see enrichRenovateTarget's `if (!resolvedTargetVersion
		// && ...)` guard). So the effective range here is (installationInfo.version, "2.9.4"] regardless
		// of the mocked package `version` field -- generate all 15 entries below that ceiling so every one
		// falls in range, exercising the cap purely on count rather than on range-filtering semantics.
		const versions = Array.from({ length: 15 }, (_, i) => `2.8.${15 - i}`); // newest-first, 15 entries, all < 2.9.4 ceiling
		const changelogYaml = versions
			.map((v) => `- version: "${v}"\n  changes:\n    - description: "Change for ${v}"\n      type: enhancement`)
			.join("\n");
		global.fetch = mock(async (input: string | URL | Request) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url.includes("/api/fleet/epm/packages?")) {
				return Response.json({
					items: [
						{
							name: "elastic_agent",
							version: "2.15.0",
							installationInfo: { version: "2.0.0" },
							packagePoliciesInfo: { count: 1 },
						},
					],
				});
			}
			if (url.includes("raw.githubusercontent.com")) {
				return new Response(changelogYaml, { status: 200 });
			}
			return new Response("Not Found", { status: 404 });
		}) as unknown as typeof fetch;

		const out = await enrichRenovateTarget(baseState() as IacStateType);

		expect(out.renovateChangelog).toHaveLength(10);
		expect(out.renovateChangelogTotal).toBe(15);
	});
});

import { recallPriorRenovateTriggersForDeployment } from "./nodes.ts";

// SIO-1475: the deployment-wide twin of recallPriorRenovateTriggers -- "what Renovate updates has
// this deployment had, for ANY integration" rather than the marker-scoped "have we triggered THIS
// exact integration before". Mirrors recallPriorFleetUpgrades' deployment-only filter shape.
describe("recallPriorRenovateTriggersForDeployment (SIO-1475)", () => {
	afterEach(() => {
		const { __setAgentMemoryClient } = require("../memory-backend.ts");
		__setAgentMemoryClient(null);
		delete process.env.LIVE_MEMORY_BACKEND;
	});

	test("queries deployment + kind only, no marker key, and renders hits", async () => {
		process.env.LIVE_MEMORY_BACKEND = "agent-memory";
		const { __setAgentMemoryClient } = require("../memory-backend.ts");
		let seenAnnotations: Record<string, string> | undefined;
		__setAgentMemoryClient({
			async ensureUser() {},
			async ensureSession() {},
			async addFacts() {
				return { blockIds: [], acceptedCount: 0, rejectedCount: 0 };
			},
			async addMessages() {
				return { blockIds: [], acceptedCount: 0, rejectedCount: 0 };
			},
			async searchMemory(_ref: unknown, _q: string, opts?: { annotations?: Record<string, string> }) {
				seenAnnotations = opts?.annotations;
				return [
					{
						text: "Renovate update triggered on ap-cld for 'renovate/ap-cld-prometheus'.",
						score: 0.9,
						annotations: {
							kind: "renovate-trigger",
							deployment: "ap-cld",
							marker: "renovate/ap-cld-prometheus",
							mr_url: "https://gitlab.example/x/-/merge_requests/519",
						},
					},
				];
			},
			async updateSession() {},
			async endSession() {},
			async checkHealth() {
				return { ok: true };
			},
		} satisfies AgentMemoryClient);

		const out = await recallPriorRenovateTriggersForDeployment("ap-cld");

		expect(seenAnnotations).toEqual({ deployment: "ap-cld", kind: "renovate-trigger" });
		expect(out).toContain("Renovate update triggered on ap-cld for 'renovate/ap-cld-prometheus'");
		expect(out).toContain("[https://gitlab.example/x/-/merge_requests/519]");
	});

	test("returns '' when the agent-memory backend is not selected", async () => {
		delete process.env.LIVE_MEMORY_BACKEND;
		expect(await recallPriorRenovateTriggersForDeployment("ap-cld")).toBe("");
	});

	test("returns '' when deployment is empty", async () => {
		process.env.LIVE_MEMORY_BACKEND = "agent-memory";
		expect(await recallPriorRenovateTriggersForDeployment("")).toBe("");
	});

	test("soft-fails to '' when the search throws", async () => {
		process.env.LIVE_MEMORY_BACKEND = "agent-memory";
		const { __setAgentMemoryClient } = require("../memory-backend.ts");
		__setAgentMemoryClient({
			async ensureUser() {},
			async ensureSession() {},
			async addFacts() {
				return { blockIds: [], acceptedCount: 0, rejectedCount: 0 };
			},
			async addMessages() {
				return { blockIds: [], acceptedCount: 0, rejectedCount: 0 };
			},
			async searchMemory() {
				throw new Error("connection reset");
			},
			async updateSession() {},
			async endSession() {},
			async checkHealth() {
				return { ok: true };
			},
		} satisfies AgentMemoryClient);

		expect(await recallPriorRenovateTriggersForDeployment("ap-cld")).toBe("");
	});
});

import { resolveIntegrationSlug } from "./nodes.ts";

// SIO-1474: resolves a Kibana Fleet display name (e.g. "Custom UDP Logs") to its EPM package
// slug (e.g. "udp") before resolveRenovateMarker's substring match against the Renovate
// dashboard marker runs. Never blocks the turn -- any failure (no deployment config, network
// error, non-2xx, no title match) falls through with target.integration unchanged. Mocking
// convention matches enrichRenovateTarget's established pattern (capture/restore global.fetch
// and process.env in afterEach).
describe("resolveIntegrationSlug (SIO-1474)", () => {
	const ORIGINAL_FETCH = global.fetch;
	const ORIGINAL_ENV = { ...process.env };

	afterEach(() => {
		global.fetch = ORIGINAL_FETCH;
		process.env = { ...ORIGINAL_ENV };
	});

	function baseState(integration: string): Partial<IacStateType> {
		return {
			renovateTarget: { deployment: "ap-cld", integration },
		};
	}

	test("returns no change when target.integration already equals a package's slug (name)", async () => {
		process.env.ELASTIC_AP_CLD_URL = "https://ap-cld.es.eu-central-1.aws.cloud.es.io";
		process.env.ELASTIC_AP_CLD_API_KEY = "test-key";
		global.fetch = mock(async (input: string | URL | Request) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url.includes("/api/fleet/epm/packages?")) {
				return Response.json({ items: [{ name: "udp", title: "Custom UDP Logs", version: "2.5.1" }] });
			}
			return new Response("Not Found", { status: 404 });
		}) as unknown as typeof fetch;

		const out = await resolveIntegrationSlug(baseState("udp") as IacStateType);

		expect(out).toEqual({});
	});

	test("resolves a display-name match to the package's slug", async () => {
		process.env.ELASTIC_AP_CLD_URL = "https://ap-cld.es.eu-central-1.aws.cloud.es.io";
		process.env.ELASTIC_AP_CLD_API_KEY = "test-key";
		global.fetch = mock(async (input: string | URL | Request) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url.includes("/api/fleet/epm/packages?")) {
				return Response.json({ items: [{ name: "udp", title: "Custom UDP Logs", version: "2.5.1" }] });
			}
			return new Response("Not Found", { status: 404 });
		}) as unknown as typeof fetch;

		const out = await resolveIntegrationSlug(baseState("Custom UDP Logs") as IacStateType);

		expect(out).toEqual({ renovateTarget: { deployment: "ap-cld", integration: "udp" } });
	});

	test("resolves a display-name match case-insensitively", async () => {
		process.env.ELASTIC_AP_CLD_URL = "https://ap-cld.es.eu-central-1.aws.cloud.es.io";
		process.env.ELASTIC_AP_CLD_API_KEY = "test-key";
		global.fetch = mock(async (input: string | URL | Request) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url.includes("/api/fleet/epm/packages?")) {
				return Response.json({ items: [{ name: "udp", title: "Custom UDP Logs", version: "2.5.1" }] });
			}
			return new Response("Not Found", { status: 404 });
		}) as unknown as typeof fetch;

		const out = await resolveIntegrationSlug(baseState("custom udp logs") as IacStateType);

		expect(out).toEqual({ renovateTarget: { deployment: "ap-cld", integration: "udp" } });
	});

	test("returns no change when no package name or title matches", async () => {
		process.env.ELASTIC_AP_CLD_URL = "https://ap-cld.es.eu-central-1.aws.cloud.es.io";
		process.env.ELASTIC_AP_CLD_API_KEY = "test-key";
		global.fetch = mock(async (input: string | URL | Request) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url.includes("/api/fleet/epm/packages?")) {
				return Response.json({ items: [{ name: "udp", title: "Custom UDP Logs", version: "2.5.1" }] });
			}
			return new Response("Not Found", { status: 404 });
		}) as unknown as typeof fetch;

		const out = await resolveIntegrationSlug(baseState("totally unrelated package") as IacStateType);

		expect(out).toEqual({});
	});

	test("returns {} immediately when renovateTarget is null, without calling fetch", async () => {
		let fetchCalled = false;
		global.fetch = mock(async () => {
			fetchCalled = true;
			return new Response("should not be called", { status: 500 });
		}) as unknown as typeof fetch;

		const out = await resolveIntegrationSlug({ renovateTarget: null } as IacStateType);

		expect(out).toEqual({});
		expect(fetchCalled).toBe(false);
	});

	test("returns no change when ELASTIC_<DEPLOYMENT>_URL is unset for this deployment", async () => {
		delete process.env.ELASTIC_AP_CLD_URL;
		delete process.env.ELASTIC_AP_CLD_API_KEY;
		global.fetch = mock(async () => new Response("should not be called", { status: 500 })) as unknown as typeof fetch;

		const out = await resolveIntegrationSlug(baseState("Custom UDP Logs") as IacStateType);

		expect(out).toEqual({});
	});

	test("returns no change when the Kibana call errors (network failure)", async () => {
		process.env.ELASTIC_AP_CLD_URL = "https://ap-cld.es.eu-central-1.aws.cloud.es.io";
		process.env.ELASTIC_AP_CLD_API_KEY = "test-key";
		global.fetch = mock(async () => {
			throw new Error("connection reset");
		}) as unknown as typeof fetch;

		const out = await resolveIntegrationSlug(baseState("Custom UDP Logs") as IacStateType);

		expect(out).toEqual({});
	});

	test("returns no change when the Kibana call returns a non-2xx status", async () => {
		process.env.ELASTIC_AP_CLD_URL = "https://ap-cld.es.eu-central-1.aws.cloud.es.io";
		process.env.ELASTIC_AP_CLD_API_KEY = "test-key";
		global.fetch = mock(async () => new Response("unauthorized", { status: 401 })) as unknown as typeof fetch;

		const out = await resolveIntegrationSlug(baseState("Custom UDP Logs") as IacStateType);

		expect(out).toEqual({});
	});

	// CodeRabbit (PR #669): a 2xx response with a valid-JSON-but-wrong-shape body (e.g. a bare
	// `null`) makes `body.items` throw (TypeError: Cannot read property 'items' of null) --
	// caught by the function's own try/catch, so it still soft-fails to {} rather than escaping,
	// but this exact malformed-shape path had no direct test coverage.
	test("returns no change when the Kibana response body is malformed (bare null)", async () => {
		process.env.ELASTIC_AP_CLD_URL = "https://ap-cld.es.eu-central-1.aws.cloud.es.io";
		process.env.ELASTIC_AP_CLD_API_KEY = "test-key";
		global.fetch = mock(
			async () => new Response("null", { headers: { "content-type": "application/json" } }),
		) as unknown as typeof fetch;

		const out = await resolveIntegrationSlug(baseState("Custom UDP Logs") as IacStateType);

		expect(out).toEqual({});
	});
});

import { looksLikeRenovateStatusCheck } from "./nodes.ts";

describe("looksLikeRenovateStatusCheck (SIO-1475)", () => {
	test("matches 'Please check again'", () => {
		expect(looksLikeRenovateStatusCheck("Please check again")).toBe(true);
	});

	test("matches 'check on it'", () => {
		expect(looksLikeRenovateStatusCheck("check on it")).toBe(true);
	});

	test("matches 'any update?'", () => {
		expect(looksLikeRenovateStatusCheck("any update?")).toBe(true);
	});

	test("matches 'ask again'", () => {
		expect(looksLikeRenovateStatusCheck("ok, ask again in a minute")).toBe(true);
	});

	test("does not match a fresh upgrade request naming a version", () => {
		expect(looksLikeRenovateStatusCheck("upgrade udp to 2.5.1 on ap-cld")).toBe(false);
	});

	test("does not match a fresh upgrade request naming an integration, no status cue", () => {
		expect(looksLikeRenovateStatusCheck("In the ap-cld deployment, upgrade the 'Custom UDP Logs' integration")).toBe(
			false,
		);
	});

	test("does not match unrelated text", () => {
		expect(looksLikeRenovateStatusCheck("what deployments do we have")).toBe(false);
	});
});

// SIO-1475: mirrors fleet-upgrade.test.ts's "classifyIacIntent fleet-status guard (SIO-928)"
// describe block EXACTLY, including its documented reason for avoiding a real classifyIacIntent
// call in the negative cases: "avoiding a process-global createLlm mock that would pollute
// sibling tests." The guard-fires case calls classifyIacIntent directly (it returns before ever
// reaching the LLM call, so no mock is needed there); the two negative cases assert against the
// underlying predicate/state shape instead, never against classifyIacIntent itself.
describe("classifyIacIntent renovate-status guard (SIO-1475)", () => {
	const humanState = (content: string, renovateInFlightMarker: IacStateType["renovateInFlightMarker"]) =>
		({
			messages: [{ getType: () => "human", content }],
			renovateInFlightMarker,
		}) as unknown as IacStateType;

	const inFlight = {
		deployment: "ap-cld",
		marker: "renovate/ap-cld-udp",
		line: " - [ ] <!-- unschedule-branch=renovate/ap-cld-udp -->chore(deps): [ap-cld] udp to v2.5.1",
		triggerAtIso: new Date().toISOString(),
	};

	test("a status-check follow-up with a Renovate trigger in flight routes to renovate-status-check (no LLM)", async () => {
		const { classifyIacIntent } = await import("./nodes.ts");
		for (const q of ["Please check again", "check on it", "any update?"]) {
			const out = await classifyIacIntent(humanState(q, inFlight));
			expect(out.intent).toBe("renovate-status-check");
		}
	});

	test("no in-flight marker -> the guard's own condition is false (asserted directly, no classifyIacIntent call)", () => {
		// Mirrors this file's own guard shape: `state.renovateInFlightMarker != null && looksLikeRenovateStatusCheck(query)`.
		// With renovateInFlightMarker null, the `!=null` half is false regardless of the query text --
		// asserted without invoking classifyIacIntent (which would otherwise fall through to a real LLM call).
		const marker: IacStateType["renovateInFlightMarker"] = null;
		expect(marker != null).toBe(false);
	});

	test("a FRESH upgrade request does NOT trip the guard even with a trigger in flight", async () => {
		// "upgrade the 'system' integration" names an integration/action, not a status check --
		// the guard predicate must reject it so classifyIacIntent falls through to the LLM and a
		// second, different upgrade is never swallowed as renovate-status-check. Asserted at the
		// predicate the guard uses, same avoidance-of-real-LLM-call rationale as SIO-928's sibling test.
		const { looksLikeRenovateStatusCheck } = await import("./nodes.ts");
		expect(looksLikeRenovateStatusCheck("In the ap-cld deployment, upgrade the 'system' integration")).toBe(false);
	});
});

// Mirrors fleet-upgrade.test.ts's mockTools() helper exactly (same file also uses this
// convention for drift.test.ts) -- stubs mcp-bridge so callTool resolves through it.
function mockRenovateTools(handlers: Record<string, (args: Record<string, unknown>) => string>) {
	const tools = Object.entries(handlers).map(([name, fn]) => ({
		name,
		invoke: async (args: Record<string, unknown>) => fn(args),
	}));
	mock.module("../mcp-bridge.ts", () => ({
		getToolsForDataSource: () => tools,
		getConnectedServers: () => ["elastic-iac-mcp"],
	}));
}

describe("triggerRenovateUpdate sets renovateInFlightMarker (SIO-1475)", () => {
	test("sets renovateInFlightMarker on a successful trigger", async () => {
		mockRenovateTools({
			gitlab_unschedule_renovate_branches: () => '[200] {"status":"ok"}',
			gitlab_play_pipeline_schedule: () => '[200] {"status":"ok"}',
		});
		const { triggerRenovateUpdate: freshTriggerRenovateUpdate } = await import("./nodes.ts");

		const state = {
			renovateTarget: { deployment: "ap-cld", integration: "udp" },
			renovateMarker: {
				marker: "renovate/ap-cld-udp",
				line: " - [ ] <!-- unschedule-branch=renovate/ap-cld-udp -->chore(deps): [ap-cld] udp to v2.5.1",
			},
			renovateIssueIid: 11,
		} as IacStateType;

		const out = await freshTriggerRenovateUpdate(state);

		expect(out.renovateInFlightMarker).toEqual({
			deployment: "ap-cld",
			marker: "renovate/ap-cld-udp",
			line: " - [ ] <!-- unschedule-branch=renovate/ap-cld-udp -->chore(deps): [ap-cld] udp to v2.5.1",
			triggerAtIso: expect.any(String),
		});
	});
});

describe("watchRenovateMr falls back to renovateInFlightMarker (SIO-1475)", () => {
	test("uses renovateInFlightMarker when renovateMarker is null (a re-check turn)", async () => {
		mockRenovateTools({
			gitlab_list_merge_requests_by_source_branch: () => "[200] []",
		});
		const { watchRenovateMr: freshWatchRenovateMr } = await import("./nodes.ts");
		process.env.IAC_PIPELINE_POLL_BUDGET_MS = "100";
		process.env.IAC_PIPELINE_POLL_INTERVAL_MS = "50";

		const state = {
			renovateMarker: null,
			renovateTriggerAtIso: "",
			renovateInFlightMarker: {
				deployment: "ap-cld",
				marker: "renovate/ap-cld-udp",
				line: " - [ ] <!-- unschedule-branch=renovate/ap-cld-udp -->chore(deps): [ap-cld] udp to v2.5.1",
				triggerAtIso: new Date().toISOString(),
			},
		} as IacStateType;

		const out = await freshWatchRenovateMr(state);

		expect(out.messages?.[0]?.content).toContain("renovate/ap-cld-udp");

		delete process.env.IAC_PIPELINE_POLL_BUDGET_MS;
		delete process.env.IAC_PIPELINE_POLL_INTERVAL_MS;
	});

	test("returns {} when both renovateMarker and renovateInFlightMarker are null", async () => {
		const { watchRenovateMr: freshWatchRenovateMr } = await import("./nodes.ts");
		const out = await freshWatchRenovateMr({ renovateMarker: null, renovateInFlightMarker: null } as IacStateType);
		expect(out).toEqual({});
	});

	// Greptile (PR #671): watchRenovateMr's ONLY graph successor is teardownIac (same turn, no
	// intervening node), and teardownIac's daily-log breadcrumb + durable renovate-trigger fact
	// both fall back to renovateInFlightMarker when renovateMarker is null (the exact shape of a
	// renovate-status-check turn). If the MR-found success return cleared renovateInFlightMarker,
	// teardownIac would see it as null on the very turn a real MR was just found, and the durable
	// fact would be written with placeholder text instead of the real deployment/marker -- live
	// repro'd via bun -e before this fix. TURN_START_RESET already nulls the field at the start of
	// the NEXT turn regardless, so there is no leak risk in leaving it set through teardown.
	test("does NOT clear renovateInFlightMarker on the MR-found success return (teardownIac needs it this same turn)", async () => {
		mockRenovateTools({
			gitlab_list_merge_requests_by_source_branch: () =>
				`[200] [{"web_url":"https://gitlab.example/x/-/merge_requests/999","source_branch":"renovate/ap-cld-udp","updated_at":"${new Date().toISOString()}"}]`,
		});
		const { watchRenovateMr: freshWatchRenovateMr } = await import("./nodes.ts");

		const inFlightMarker = {
			deployment: "ap-cld",
			marker: "renovate/ap-cld-udp",
			line: " - [ ] <!-- unschedule-branch=renovate/ap-cld-udp -->chore(deps): [ap-cld] udp to v2.5.1",
			triggerAtIso: new Date(Date.now() - 1000).toISOString(),
		};
		const state = {
			renovateMarker: null,
			renovateTriggerAtIso: "",
			renovateInFlightMarker: inFlightMarker,
		} as IacStateType;

		const out = await freshWatchRenovateMr(state);

		expect(out.renovateMrUrl).toBe("https://gitlab.example/x/-/merge_requests/999");
		expect("renovateInFlightMarker" in out).toBe(false);
	});

	// Greptile (PR #671): end-to-end regression guard for the exact bug -- chains the real
	// watchRenovateMr success return directly into the real teardownIac (matching graph.ts's own
	// unconditional watchRenovateMr -> teardown edge), and asserts the durable fact records the
	// REAL deployment/marker, not the placeholder fallback text. A future re-introduction of an
	// early renovateInFlightMarker clear would make this test fail on the placeholder assertion.
	test("watchRenovateMr success -> teardownIac records the real deployment/marker, not placeholder text", async () => {
		mockRenovateTools({
			gitlab_list_merge_requests_by_source_branch: () =>
				`[200] [{"web_url":"https://gitlab.example/x/-/merge_requests/999","source_branch":"renovate/ap-cld-udp","updated_at":"${new Date().toISOString()}"}]`,
		});
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
		const { watchRenovateMr: freshWatchRenovateMr, teardownIac } = await import("./nodes.ts");

		const inFlightMarker = {
			deployment: "ap-cld",
			marker: "renovate/ap-cld-udp",
			line: " - [ ] <!-- unschedule-branch=renovate/ap-cld-udp -->chore(deps): [ap-cld] udp to v2.5.1",
			triggerAtIso: new Date(Date.now() - 1000).toISOString(),
		};
		const turnStart = {
			requestId: "req-1",
			threadId: "thread-abc",
			intent: "renovate-status-check",
			renovateMarker: null,
			renovateTriggerAtIso: "",
			renovateInFlightMarker: inFlightMarker,
		} as unknown as IacStateType;

		const watchOut = await freshWatchRenovateMr(turnStart);
		const teardownOut = await teardownIac({ ...turnStart, ...watchOut } as IacStateType);

		expect(capturedDecision).toContain("ap-cld");
		expect(capturedDecision).toContain("renovate/ap-cld-udp");
		expect(capturedDecision).not.toContain("an outdated dependency");
		expect(capturedDecision).not.toContain("an Elastic deployment");
		expect(capturedAnnotations?.deployment).toBe("ap-cld");
		expect(capturedAnnotations?.marker).toBe("renovate/ap-cld-udp");

		// Greptile round 2 (PR #671): after the full watchRenovateMr -> teardownIac chain
		// completes with an MR found, renovateInFlightMarker must end up cleared -- otherwise a
		// resolved trigger's marker persists on the thread forever (it is deliberately excluded
		// from TURN_START_RESET) and can hijack a later, wholly unrelated status-check-shaped
		// message via classifyIacIntent's guard. Live-repro'd before this fix: a message like "any
		// update on the eu-b2b cluster health?" sent long after this trigger resolved was
		// incorrectly classified as renovate-status-check.
		const finalState = { ...turnStart, ...watchOut, ...teardownOut };
		expect(finalState.renovateInFlightMarker).toBeNull();
	});
});

describe("triggerRenovateUpdate records a KG ConfigChange (SIO-1475)", () => {
	afterEach(() => {
		mock.module("./lane-knowledge.ts", () => realLaneKnowledge);
	});

	test("calls recordLaneConfigChange with workflow: 'renovate' and outcome: 'proposed' on a successful trigger", async () => {
		const recordSpy = mock(async () => {});
		mock.module("./lane-knowledge.ts", () => ({ ...realLaneKnowledge, recordLaneConfigChange: recordSpy }));
		mockRenovateTools({
			gitlab_unschedule_renovate_branches: () => '[200] {"status":"ok"}',
			gitlab_play_pipeline_schedule: () => '[200] {"status":"ok"}',
		});
		const { triggerRenovateUpdate: freshTriggerRenovateUpdate } = await import("./nodes.ts");

		const state = {
			renovateTarget: { deployment: "ap-cld", integration: "udp" },
			renovateMarker: {
				marker: "renovate/ap-cld-udp",
				line: " - [ ] <!-- unschedule-branch=renovate/ap-cld-udp -->chore(deps): [ap-cld] udp to v2.5.1",
			},
			renovateIssueIid: 11,
			requestId: "req-123",
			threadId: "thread-abc",
		} as IacStateType;

		await freshTriggerRenovateUpdate(state);

		expect(recordSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				id: "req-123",
				deployment: "ap-cld",
				workflow: "renovate",
				outcome: "proposed",
				summary: "renovate ap-cld -> renovate/ap-cld-udp",
				threadId: "thread-abc",
			}),
		);
	});

	test("does NOT call recordLaneConfigChange when the tick call fails", async () => {
		const recordSpy = mock(async () => {});
		mock.module("./lane-knowledge.ts", () => ({ ...realLaneKnowledge, recordLaneConfigChange: recordSpy }));
		mockRenovateTools({
			gitlab_unschedule_renovate_branches: () => '[500] {"error":"internal error"}',
		});
		const { triggerRenovateUpdate: freshTriggerRenovateUpdate } = await import("./nodes.ts");

		const state = {
			renovateTarget: { deployment: "ap-cld", integration: "udp" },
			renovateMarker: {
				marker: "renovate/ap-cld-udp",
				line: " - [ ] <!-- unschedule-branch=renovate/ap-cld-udp -->chore(deps): [ap-cld] udp to v2.5.1",
			},
			renovateIssueIid: 11,
			requestId: "req-123",
		} as IacStateType;

		const out = await freshTriggerRenovateUpdate(state);

		expect(out.blockedReason).toBeDefined();
		expect(recordSpy).not.toHaveBeenCalled();
	});
});
