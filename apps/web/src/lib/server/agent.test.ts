// apps/web/src/lib/server/agent.test.ts
import { describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";

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
	// SIO-780: datasources route test runs later and imports these from the same
	// @devops-agent/agent module; include them here so the cached namespace has
	// the symbols when the cross-test mock pollution kicks in.
	getConnectedServers: mock(() => [] as string[]),
	getServerStates: mock(() => ({}) as Record<string, string>),
	processAttachments: mock(() => Promise.resolve({ contentBlocks: [], metadata: [], warnings: [] })),
	// SIO-906: events route test imports mcpEvents from this specifier; include it so
	// the shared process-global mock stays link-compatible across files.
	mcpEvents: new EventEmitter(),
}));

mock.module("@devops-agent/gitagent-bridge", () => ({
	getRecursionLimit: (maxTurns?: number) => (maxTurns ?? 30) * 2,
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
		redactPiiContent: (s: string) => s,
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
		// messages is an array of RemoveMessage; dataSourceResults reset to []
		expect(Array.isArray((update as { messages: unknown[] }).messages)).toBe(true);
		expect((update as { dataSourceResults: unknown[] }).dataSourceResults).toEqual([]);
	});

	test("pruneThreadState is a no-op when under threshold", async () => {
		mockUpdateState.mockClear();
		mockGetState.mockResolvedValueOnce({ values: { messages: [{ id: "a" }] } });
		await pruneThreadState("thread-2", "incident-analyzer");
		expect(mockUpdateState).not.toHaveBeenCalled();
	});
});
