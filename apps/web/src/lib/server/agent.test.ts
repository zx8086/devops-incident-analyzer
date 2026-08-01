// apps/web/src/lib/server/agent.test.ts
import { describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import { z } from "zod";

const mockStreamEvents = mock(() => ({
	async *[Symbol.asyncIterator]() {
		// empty stream
	},
}));

const mockUpdateState = mock(() => Promise.resolve());
const mockGetState = mock(() => Promise.resolve({ values: { messages: [{ id: "old1" }, { id: "a" }, { id: "b" }] } }));

const mockAgentDef = {
	manifest: {
		compliance: {
			risk_tier: "medium" as const,
			supervision: {
				human_in_the_loop: "conditional" as const,
			},
			recordkeeping: {
				audit_logging: true,
				retention_period: "1y",
				immutable: true,
			},
			data_governance: {
				pii_handling: "redact" as const,
				data_classification: "internal",
			},
		},
		runtime: { max_turns: 30, timeout: 300 },
	},
	tools: [],
	subAgents: new Map(),
	knowledge: [],
};

mock.module("@devops-agent/observability", () => ({
	getLogger: () => ({
		info: () => undefined,
		warn: () => undefined,
		error: () => undefined,
		debug: () => undefined,
	}),
	getChildLogger: () => ({
		info: () => undefined,
		warn: () => undefined,
		error: () => undefined,
		debug: () => undefined,
	}),
	runWithRequestContext: (_ctx: unknown, fn: () => unknown) => fn(),
	traceSpan: async (_name: string, _op: string, fn: () => Promise<unknown>) => fn(),
	getCurrentRequestContext: () => undefined,
}));

mock.module("@devops-agent/agent", () => ({
	buildGraph: mock(() =>
		Promise.resolve({
			streamEvents: mockStreamEvents,
			getState: mockGetState,
			updateState: mockUpdateState,
		}),
	),
	// elastic-iac graph (multi-agent plumbing). agent.ts imports both builders + getAgentByName.
	buildIacGraph: mock(() =>
		Promise.resolve({
			streamEvents: mockStreamEvents,
			getState: mockGetState,
			updateState: mockUpdateState,
		}),
	),
	createMcpClient: mock(() => Promise.resolve()),
	stopHealthPolling: mock(() => undefined),
	getAgent: () => mockAgentDef,
	getAgentByName: () => mockAgentDef,
	// SIO-930: agent.ts imports iacTurnOutcome (used by getIacTurnOutcome). The mock must export it
	// or the namespace import throws "Export named 'getIacTurnOutcome' not found" downstream.
	iacTurnOutcome: mock(() => "completed" as const),
	AttachmentError: class AttachmentError extends Error {},
	flushLangSmithCallbacks: mock(() => Promise.resolve()),
	// SIO-846: agent.ts now runs session bootstrap/teardown via these.
	runBootstrap: mock(() => Promise.resolve({ stepsRun: [] })),
	runTeardown: mock(() => Promise.resolve([])),
	// SIO-942: agent.ts imports + re-exports runPostTurn (per-turn live-memory flush).
	runPostTurn: mock(() => Promise.resolve()),
	// SIO-952: agent.ts imports + re-exports setSessionOutcome (stamps the turn
	// outcome onto the Agent Memory session at conversation-close).
	setSessionOutcome: mock(() => undefined),
	// SIO-862: agent.ts calls these at module load (installMemoryPromotion/installGraphWarmer
	// register lifecycle seams). The mock must export them or the namespace import throws.
	installMemoryPromotion: mock(() => undefined),
	installGraphWarmer: mock(() => undefined),
	// SIO-938: agent.ts calls installAgentMemory() at module load to register the
	// agent-memory recall/flush seams. Mock must export it or the namespace import throws.
	installAgentMemory: mock(() => undefined),
	// SIO-476: state-pruning helpers consumed by pruneThreadState.
	needsPruning: (msgs: unknown[]) => msgs.length > 2,
	pruneState: () => ({ removeIds: ["old1"] }),
	// SIO-1110: agent.ts threads the graph deadline into configurable under this key.
	GRAPH_DEADLINE_KEY: "graphDeadlineAt",
	// SIO-1222: agent.ts now routes both of its message-content reads through this helper
	// (readCompletedTurn's transcript and getLastAssistantText), so transcript assertions must
	// exercise real shape handling rather than a stub.
	//
	// SIO-1222 review: this must mirror packages/agent/src/message-utils.ts EXACTLY, including the
	// lone-block branch -- an earlier version returned "" for a single unwrapped text block while
	// production returns its text, so a test could pass against behaviour production renders
	// differently. Uses the same Zod-backed predicate as production rather than hand-rolled
	// `unknown` narrowing.
	extractTextFromContent: (content: unknown): string => {
		const textBlock = z.object({ type: z.literal("text"), text: z.string() }).passthrough();
		const isTextBlock = (b: unknown): b is { type: "text"; text: string } => textBlock.safeParse(b).success;
		if (typeof content === "string") return content;
		// SIO-1231: no separator. Production joins with "" -- a "\n" here would let a test pass
		// against a shape that renders garbled in the browser, which is the exact failure mode
		// this mock's "mirror production EXACTLY" contract exists to prevent.
		if (Array.isArray(content))
			return content
				.filter(isTextBlock)
				.map((b) => b.text)
				.join("");
		// A single content block that was never wrapped in an array.
		return isTextBlock(content) ? content.text : "";
	},
	// SIO-780: datasources route test runs later and imports these from the same
	// @devops-agent/agent module; include them here so the cached namespace has
	// the symbols when the cross-test mock pollution kicks in.
	getConnectedServers: mock(() => [] as string[]),
	getServerStates: mock(() => ({}) as Record<string, string>),
	processAttachments: mock(() => Promise.resolve({ contentBlocks: [], metadata: [], warnings: [] })),
	// SIO-906: events route test imports mcpEvents from this specifier; include it so
	// the shared process-global mock stays link-compatible across files.
	mcpEvents: new EventEmitter(),
	// SIO-1045: agent.ts itself imports these at module scope (installSkillLearner is
	// CALLED at load time; appliedSkillsForNames is used in readCompletedTurn). Also
	// cover the memory/promote and actions routes that import the same specifier so
	// the process-global mock cache stays link-compatible regardless of file order.
	appliedSkillsForNames: mock(() => [] as unknown[]),
	installSkillLearner: mock(() => undefined),
	promoteToMemory: mock(() => Promise.resolve()),
	executeAction: mock(() => Promise.resolve()),
	getAvailableActionTools: mock(() => [] as unknown[]),
	// SIO-1045/SIO-1053/SIO-1358: schedules.ts is imported (and its module-scope startSchedules
	// call reads reconcileEnabled()/topologyCronEnabled()/purgeCronEnabled()) transitively via
	// agent.ts -- must resolve on this same process-global mock cache entry. All three false
	// keeps every schedule filtered out before registerSchedules() is even called under test.
	reconcileAll: mock(() => Promise.resolve({ reconciled: 0, skipped: 0, errors: 0 })),
	reconcileEnabled: mock(() => false),
	runTopologySweep: mock(() => Promise.resolve({ sources: {} })),
	topologyCronEnabled: mock(() => false),
	runUncuratedPurgeSweep: mock(() => Promise.resolve({ incidents: 0, edges: 0 })),
	purgeCronEnabled: mock(() => false),
	// SIO-1358: schedules.ts's other @devops-agent/agent imports -- getWorkspaceRoot resolves the
	// real repo root (harmless; loadSchedules/loadWorkflows below are gitagent-bridge stubs so no
	// real YAML is read), registerSchedules is a no-op stub since the schedules map is empty here.
	getWorkspaceRoot: mock(() => "/tmp"),
	registerSchedules: mock(() => []),
	selectedBackend: mock(() => "file" as const),
	// SIO-1124: the /api/tickets routes import these from this same specifier.
	getTicketProvider: mock(() => undefined),
	listAvailableTicketProviders: mock(() => [] as unknown[]),
}));

mock.module("@devops-agent/gitagent-bridge", () => ({
	getRecursionLimit: (maxTurns?: number) => (maxTurns ?? 30) * 2,
	// SIO-1358: schedules.ts value-imports these; empty maps keep startSchedules() a no-op
	// under test (nothing to register even before the enablement-flag filtering above).
	loadSchedules: () => new Map(),
	loadWorkflows: () => new Map(),
	complianceToMetadata: (compliance?: Record<string, unknown>) => {
		if (!compliance) return {};
		return {
			compliance_risk_tier: "medium",
			compliance_audit_logging: "true",
			compliance_retention_period: "1y",
			compliance_immutable_logs: "true",
			compliance_hitl: "conditional",
			compliance_pii_handling: "redact",
			compliance_data_classification: "internal",
		};
	},
}));

mock.module("@devops-agent/shared", () => {
	const { z } = require("zod");
	return {
		isKillSwitchActive: () => false,
		KillSwitchError: class KillSwitchError extends Error {},
		AttachmentBlockSchema: z.any(),
		DataSourceContextSchema: z.any(),
		PendingActionSchema: z.any(),
		// SIO-1146: sse-pump value-imports this for the hil_learning_applied forward
		// (same last-wins mock-cache race as the SIO-1045 note below).
		HilApplyReportSchema: z.unknown(),
		// sse-pump value-imports this to validate the subagent_progress custom event
		// before forwarding. A z.any() stub would accept malformed payloads and mask
		// a forwarding regression, so this mirrors the real StreamEventSchema's
		// subagent_progress variant (packages/shared/src/agent-state.ts) closely
		// enough to actually reject bad shapes, without pulling in the full union.
		StreamEventSchema: z.discriminatedUnion("type", [
			z.object({
				type: z.literal("subagent_progress"),
				dataSourceId: z.string(),
				deploymentId: z.string().optional(),
				status: z.enum(["running", "done"]),
				toolCallCount: z.number().optional(),
				distinctToolCount: z.number().optional(),
			}),
		]),
		// SIO-1204: sse-pump value-imports this to validate the network_topology
		// payload before forwarding (same last-wins mock-cache race noted above).
		NetworkTopologySchema: z.object({
			builtAtTurn: z.number(),
			sources: z.array(z.string()),
			nodes: z.array(z.object({ id: z.string(), kind: z.string() }).passthrough()),
			edges: z.array(z.object({ from: z.string(), to: z.string(), kind: z.string() }).passthrough()),
			truncated: z.boolean().optional(),
		}),
		// SIO-1215: sse-pump value-imports this to validate the ml_anomaly_explainer
		// payload before forwarding (same last-wins mock-cache race noted above).
		MlAnomalyExplainerSchema: z.object({
			builtAtTurn: z.number(),
			mode: z.enum(["overview", "detail"]),
			minScoreApplied: z.number().optional(),
			lookback: z.string(),
			records: z.array(z.object({ jobId: z.string(), recordScore: z.number() }).passthrough()),
			jobsSummary: z.array(z.object({ jobId: z.string(), count: z.number() }).passthrough()),
			investigationActions: z.array(z.string()),
			truncated: z.boolean().optional(),
		}),
		redactPiiContent: (s: string) => s,
		// SIO-1045: agent.ts imports startKnowledgeGraphServer from
		// @devops-agent/mcp-server-knowledge-graph (unmocked, real module), whose
		// transport.ts imports isBenignStreamCancel + createBootstrapAdapter +
		// createMcpApplication + createReadinessProbe from this same specifier at
		// module load. Must be present or that real import throws a link error.
		isBenignStreamCancel: () => false,
		createBootstrapAdapter: () => undefined,
		createMcpApplication: () => undefined,
		createReadinessProbe: () => undefined,
		buildTelemetryConfig: () => undefined,
		// SIO-1044: knowledge-graph server.ts now imports createCachedServerFactory at module load.
		createCachedServerFactory: () => () => undefined,
		// SIO-1351: knowledge-graph server's logger.ts now imports createMcpLogger at module load
		// (previously a bare pino() call, no @devops-agent/shared dependency). Same link-error
		// requirement as the other stubs above.
		createMcpLogger: () => ({
			child: () => ({ info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined }),
			info: () => undefined,
			warn: () => undefined,
			error: () => undefined,
			debug: () => undefined,
		}),
	};
});

mock.module("@langchain/core/messages", () => ({
	HumanMessage: class HumanMessage {
		content: string;
		constructor(content: string | { content: string }) {
			this.content = typeof content === "string" ? content : content.content;
		}
	},
	RemoveMessage: class RemoveMessage {
		id: string;
		constructor({ id }: { id: string }) {
			this.id = id;
		}
	},
}));

const { invokeAgent, pruneThreadState } = await import("./agent.ts");

describe("invokeAgent", () => {
	test("merges compliance metadata into streamEvents config", async () => {
		await invokeAgent([{ role: "user", content: "test" }], {
			threadId: "thread-1",
			metadata: {
				request_id: "req-1",
				session_id: "sess-1",
			},
		});

		expect(mockStreamEvents).toHaveBeenCalledTimes(1);

		const call = mockStreamEvents.mock.calls[0] as unknown as [unknown, Record<string, unknown>];
		const [, config] = call;
		const metadata = config.metadata as Record<string, unknown>;

		// Compliance fields are present
		expect(metadata.compliance_risk_tier).toBe("medium");
		expect(metadata.compliance_audit_logging).toBe("true");
		expect(metadata.compliance_retention_period).toBe("1y");
		expect(metadata.compliance_immutable_logs).toBe("true");
		expect(metadata.compliance_hitl).toBe("conditional");
		expect(metadata.compliance_pii_handling).toBe("redact");
		expect(metadata.compliance_data_classification).toBe("internal");

		// Per-request fields are preserved (not overwritten)
		expect(metadata.request_id).toBe("req-1");
		expect(metadata.session_id).toBe("sess-1");
	});

	test("includes compliance metadata even without per-request metadata", async () => {
		mockStreamEvents.mockClear();

		await invokeAgent([{ role: "user", content: "test" }], {
			threadId: "thread-2",
		});

		expect(mockStreamEvents).toHaveBeenCalledTimes(1);

		const call2 = mockStreamEvents.mock.calls[0] as unknown as [unknown, Record<string, unknown>];
		const [, config] = call2;
		const metadata = config.metadata as Record<string, unknown>;

		expect(metadata.compliance_risk_tier).toBe("medium");
		expect(metadata.compliance_hitl).toBe("conditional");
	});
});

describe("pruneThreadState", () => {
	test("pruneThreadState removes ids via updateState when over threshold", async () => {
		mockUpdateState.mockClear();
		mockGetState.mockClear();
		await pruneThreadState("thread-1", "incident-analyzer");
		expect(mockUpdateState).toHaveBeenCalled();
		const call0 = mockUpdateState.mock.calls[0] as unknown as [unknown, unknown];
		const [config, update] = call0;
		expect(config).toEqual({ configurable: { thread_id: "thread-1" } });
		// messages is an array of RemoveMessage carrying the pruned ids (not an
		// empty array or rewritten plain objects); dataSourceResults reset to []
		const messages = (update as { messages: Array<{ id: string }> }).messages;
		expect(Array.isArray(messages)).toBe(true);
		expect(messages.length).toBe(1);
		expect(messages[0]?.id).toBe("old1");
		expect((update as { dataSourceResults: unknown[] }).dataSourceResults).toEqual([]);
	});

	test("pruneThreadState is a no-op when under threshold", async () => {
		mockUpdateState.mockClear();
		mockGetState.mockResolvedValueOnce({ values: { messages: [{ id: "a" }] } });
		await pruneThreadState("thread-2", "incident-analyzer");
		expect(mockUpdateState).not.toHaveBeenCalled();
	});
});
