// agent/src/skill-learner.test.ts
//
// SIO-1045: this file OWNS a mock.module("./memory-backend.ts", ...) registered at file scope,
// BEFORE the static import of ./skill-learner.ts below (which statically imports enqueueFact /
// searchAgentMemory / selectedBackend from ./memory-backend.ts). See fleet-upgrade.test.ts for the
// full rationale: bun's mock.module is process-global and last-registration-wins, so a sibling file
// that mocks the same module path (packages/agent/src/iac/iac-change-memory.test.ts and
// reconcile.test.ts both mock the identical absolute file via a "../memory-backend.ts" specifier) can
// leak into this file on CI even with the polluter's own restore in place. The factory re-exports the
// REAL module verbatim, so learnFromTurn exercises the real backend logic; the existing
// __setAgentMemoryClient injection in afterEach is unchanged.
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as realMemoryBackend from "./memory-backend.ts";

mock.module("./memory-backend.ts", () => realMemoryBackend);

// Drive the worthiness judge's output. createLlm wraps ChatBedrockConverse from
// @langchain/aws; mocking it keeps createLlm("skillLearner") inert + observable.
let llmContent = '{"worthy":false}';
let invokeCalls = 0;
mock.module("@langchain/aws", () => ({
	ChatBedrockConverse: class {
		withFallbacks() {
			return this;
		}
		bindTools() {
			return this;
		}
		async invoke() {
			invokeCalls += 1;
			return { content: llmContent };
		}
	},
}));

import {
	buildSkillAnnotations,
	buildSkillFactText,
	isSkillLearningEnabled,
	learnFromTurn,
	preGateSkip,
	redactForJudge,
	type SkillLearnerTurn,
	SkillProposalSchema,
} from "./skill-learner.ts";

const NOW = "2026-06-25T12:00:00Z";

function turn(over: Partial<SkillLearnerTurn> = {}): SkillLearnerTurn {
	return {
		agentName: "incident-analyzer",
		threadId: "t1",
		queryComplexity: "complex",
		confidenceScore: 0.8,
		datasourcesUsed: ["kafka", "elastic"],
		transcript: "User: lag spike?\n\nAssistant: correlated kafka lag with elastic errors.",
		...over,
	};
}

const prevBackend = process.env.LIVE_MEMORY_BACKEND;
const prevFlag = process.env.SKILL_LEARNING_ENABLED;

beforeEach(() => {
	invokeCalls = 0;
	llmContent = '{"worthy":false}';
});

afterEach(async () => {
	if (prevBackend === undefined) delete process.env.LIVE_MEMORY_BACKEND;
	else process.env.LIVE_MEMORY_BACKEND = prevBackend;
	if (prevFlag === undefined) delete process.env.SKILL_LEARNING_ENABLED;
	else process.env.SKILL_LEARNING_ENABLED = prevFlag;
	const { __setAgentMemoryClient, __resetMemoryQueue } = await import("./memory-backend.ts");
	__setAgentMemoryClient(null);
	__resetMemoryQueue();
	// SIO-1045: re-claim ownership after every test in this file (see the file-scope comment above).
	mock.module("./memory-backend.ts", () => realMemoryBackend);
});

describe("isSkillLearningEnabled", () => {
	test("true only for 'true'/'1'", () => {
		expect(isSkillLearningEnabled({ SKILL_LEARNING_ENABLED: "true" } as NodeJS.ProcessEnv)).toBe(true);
		expect(isSkillLearningEnabled({ SKILL_LEARNING_ENABLED: "1" } as NodeJS.ProcessEnv)).toBe(true);
		expect(isSkillLearningEnabled({ SKILL_LEARNING_ENABLED: "yes" } as NodeJS.ProcessEnv)).toBe(false);
		expect(isSkillLearningEnabled({} as NodeJS.ProcessEnv)).toBe(false);
	});
});

describe("preGateSkip", () => {
	test("passes a worthy-looking complex multi-tool turn", () => {
		expect(preGateSkip(turn())).toBeNull();
	});
	test("skips non-orchestrator agents", () => {
		expect(preGateSkip(turn({ agentName: "elastic-iac" }))).toContain("not eligible");
	});
	test("skips simple turns", () => {
		expect(preGateSkip(turn({ queryComplexity: "simple" }))).toBe("simple turn");
	});
	test("skips low-confidence turns", () => {
		expect(preGateSkip(turn({ confidenceScore: 0.4 }))).toContain("< 0.6");
	});
	test("skips single-datasource turns", () => {
		expect(preGateSkip(turn({ datasourcesUsed: ["kafka"] }))).toContain("1 datasource");
	});
	test("counts DISTINCT datasources", () => {
		expect(preGateSkip(turn({ datasourcesUsed: ["kafka", "kafka"] }))).toContain("1 datasource");
	});
});

describe("SkillProposalSchema", () => {
	test("accepts a worthy kebab-case proposal", () => {
		const p = SkillProposalSchema.parse({
			worthy: true,
			name: "lag-error-correlation",
			description: "Correlate kafka lag with elastic errors.",
			task_category: "lag-correlation",
		});
		expect(p.name).toBe("lag-error-correlation");
	});
	test("rejects a non-kebab name", () => {
		expect(() => SkillProposalSchema.parse({ worthy: true, name: "Lag Correlation" })).toThrow();
	});
});

describe("buildSkillAnnotations", () => {
	test("emits kind:skill + seeded learning fields as strings", () => {
		const a = buildSkillAnnotations(
			{ worthy: true, name: "lag-corr", description: "d", task_category: "lag" },
			"t9",
			NOW,
		);
		expect(a).toEqual({
			kind: "skill",
			skill_name: "lag-corr",
			task_category: "lag",
			confidence: "0.5",
			learned_from: "thread:t9",
			learned_at: NOW,
			usage_count: "0",
			success_count: "0",
			failure_count: "0",
		});
	});
});

describe("buildSkillFactText", () => {
	test("labels the proposal and includes when/procedure", () => {
		const text = buildSkillFactText({
			worthy: true,
			name: "lag-corr",
			description: "Correlate lag with errors.",
			when_to_use: "consumer lag rising",
			procedure_summary: "1. check lag 2. check errors",
		});
		expect(text).toContain("Proposed skill: lag-corr - Correlate lag with errors.");
		expect(text).toContain("When to use: consumer lag rising");
		expect(text).toContain("Procedure:");
	});
});

describe("redactForJudge", () => {
	// NOTE: redactForJudge delegates PII stripping to @devops-agent/shared's
	// redactPiiContent, whose behavior is proven in packages/shared/src/__tests__/
	// pii-redactor.test.ts. We intentionally do NOT re-assert SSN/email stripping
	// here: aggregator.test.ts stubs that function to an identity passthrough
	// process-globally, so such an assertion would be load-order flaky. We assert
	// only the cap that redactForJudge itself owns.
	test("caps the transcript to 6000 chars before the judge", () => {
		const out = redactForJudge("x".repeat(10_000));
		expect(out.length).toBe(6000);
	});
	test("passes short transcripts through unchanged in length", () => {
		const out = redactForJudge("short");
		expect(out.length).toBeLessThanOrEqual(5);
	});
});

describe("learnFromTurn", () => {
	function memStub(searchResult: Array<{ text: string; annotations?: Record<string, string> }> = []) {
		const added: Array<{ facts: string[]; annotations?: Record<string, string> }> = [];
		const client = {
			async ensureUser() {},
			async ensureSession() {},
			async addFacts(_ref: unknown, facts: string[], opts?: { annotations?: Record<string, string> }) {
				added.push({ facts, annotations: opts?.annotations });
				return { blockIds: ["b1"], acceptedCount: facts.length, rejectedCount: 0 };
			},
			async addMessages() {
				return { blockIds: [], acceptedCount: 0, rejectedCount: 0 };
			},
			async searchMemory() {
				return searchResult;
			},
			async updateSession() {},
			async endSession() {},
			async checkHealth() {
				return { ok: true };
			},
		};
		return { client, added };
	}

	test("no-op when SKILL_LEARNING_ENABLED is unset", async () => {
		delete process.env.SKILL_LEARNING_ENABLED;
		process.env.LIVE_MEMORY_BACKEND = "agent-memory";
		llmContent = '{"worthy":true,"name":"lag-corr","description":"d"}';
		await learnFromTurn(turn(), NOW);
		expect(invokeCalls).toBe(0); // never reached the judge
	});

	test("no-op on the file backend even when enabled", async () => {
		process.env.SKILL_LEARNING_ENABLED = "true";
		delete process.env.LIVE_MEMORY_BACKEND;
		await learnFromTurn(turn(), NOW);
		expect(invokeCalls).toBe(0);
	});

	test("pre-gate skip avoids the judge call", async () => {
		process.env.SKILL_LEARNING_ENABLED = "true";
		process.env.LIVE_MEMORY_BACKEND = "agent-memory";
		await learnFromTurn(turn({ queryComplexity: "simple" }), NOW);
		expect(invokeCalls).toBe(0);
	});

	test("crystallizes a worthy proposal as a durable kind:skill fact", async () => {
		process.env.SKILL_LEARNING_ENABLED = "true";
		process.env.LIVE_MEMORY_BACKEND = "agent-memory";
		const { __setAgentMemoryClient, flushAgentMemory, setActiveMemorySession } = await import("./memory-backend.ts");
		const { client, added } = memStub();
		// biome-ignore lint/suspicious/noExplicitAny: SIO-1015 - test stub for the AgentMemoryClient surface
		__setAgentMemoryClient(client as any);
		setActiveMemorySession("incident-analyzer", "t1");
		llmContent = '{"worthy":true,"name":"lag-corr","description":"Correlate lag with errors.","task_category":"lag"}';

		await learnFromTurn(turn(), NOW);
		await flushAgentMemory(); // drain the write-behind queue

		expect(added.length).toBe(1);
		expect(added[0]?.annotations?.kind).toBe("skill");
		expect(added[0]?.annotations?.skill_name).toBe("lag-corr");
		expect(added[0]?.annotations?.confidence).toBe("0.5");
		expect(added[0]?.facts[0]).toContain("Proposed skill: lag-corr");
	});

	test("dedup: skips when a kind:skill fact with the same name already exists", async () => {
		process.env.SKILL_LEARNING_ENABLED = "true";
		process.env.LIVE_MEMORY_BACKEND = "agent-memory";
		const { __setAgentMemoryClient, flushAgentMemory } = await import("./memory-backend.ts");
		// searchMemory returns an existing proposal -> proposalExists() true -> no write.
		const { client, added } = memStub([
			{ text: "Proposed skill: lag-corr - ...", annotations: { kind: "skill", skill_name: "lag-corr" } },
		]);
		// biome-ignore lint/suspicious/noExplicitAny: SIO-1015 - test stub for the AgentMemoryClient surface
		__setAgentMemoryClient(client as any);
		llmContent = '{"worthy":true,"name":"lag-corr","description":"d"}';

		await learnFromTurn(turn(), NOW);
		await flushAgentMemory();

		expect(added.length).toBe(0);
	});

	test("worthy:false does not write", async () => {
		process.env.SKILL_LEARNING_ENABLED = "true";
		process.env.LIVE_MEMORY_BACKEND = "agent-memory";
		const { __setAgentMemoryClient, flushAgentMemory } = await import("./memory-backend.ts");
		const { client, added } = memStub();
		// biome-ignore lint/suspicious/noExplicitAny: SIO-1015 - test stub for the AgentMemoryClient surface
		__setAgentMemoryClient(client as any);
		llmContent = '{"worthy":false}';

		await learnFromTurn(turn(), NOW);
		await flushAgentMemory();

		expect(invokeCalls).toBe(1); // judge ran
		expect(added.length).toBe(0); // but nothing crystallized
	});
});
