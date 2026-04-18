// apps/web/src/lib/server/agent.test.ts
import { describe, expect, mock, test } from "bun:test";

const mockStreamEvents = mock(() => ({
	async *[Symbol.asyncIterator]() {
		// empty stream
	},
}));

mock.module("@devops-agent/agent", () => ({
	buildGraph: mock(() =>
		Promise.resolve({
			streamEvents: mockStreamEvents,
		}),
	),
	createMcpClient: mock(() => Promise.resolve()),
	getAgent: () => ({
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
	}),
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

mock.module("@devops-agent/shared", () => ({
	isKillSwitchActive: () => false,
	KillSwitchError: class KillSwitchError extends Error {},
}));

mock.module("@langchain/core/messages", () => ({
	HumanMessage: class HumanMessage {
		content: string;
		constructor(content: string | { content: string }) {
			this.content = typeof content === "string" ? content : content.content;
		}
	},
}));

const { invokeAgent } = await import("./agent.ts");

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
