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
import * as realMemoryBackendNs from "./memory-backend.ts";

// SIO-1045: a namespace import (`import * as ns`) is a LIVE VIEW -- when any file registers a
// mock.module() for this path, bun live-patches every existing namespace binding, INCLUDING this
// captured `realMemoryBackendNs` object, so re-claiming with `() => realMemoryBackendNs` would
// re-register the very poison it means to undo (a circular no-op). A value snapshot (spread into a
// plain object at load time, before any mock.module() call below runs) copies the function VALUES and
// is immune to that later live-patching.
const realMemoryBackend = { ...realMemoryBackendNs };

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
	initialTaskSuccess,
	isSkillLearningEnabled,
	latestPerSkill,
	learnFromTurn,
	lessonQuality,
	preGateSkip,
	redactForJudge,
	type SkillLearnerTurn,
	SkillProposalSchema,
	summarizeSkillProposalHits,
	verifyEvidence,
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
	// SIO-1045: re-claim ownership before every test in this file, so it is self-claiming even if a
	// sibling suite poisoned the module between this file's load and this test's execution.
	mock.module("./memory-backend.ts", () => realMemoryBackend);
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

describe("summarizeSkillProposalHits (SIO-1345 / SIO-1889)", () => {
	test("maps annotations to summaries, defaulting pre-SIO-1889 facts to candidate/turn, and drops nameless hits", () => {
		const out = summarizeSkillProposalHits([
			{
				text: "Proposed skill: lag-corr - d",
				annotations: {
					kind: "skill",
					skill_name: "lag-corr",
					task_category: "lag",
					learned_at: NOW,
					learned_from: "thread:t1",
				},
			},
			{
				text: "approved one",
				annotations: {
					kind: "skill",
					skill_name: "resolver-check",
					status: "approved",
					source: "hil",
					task_success: "1",
					task_success_source: "hil",
				},
			},
			{ text: "nameless", annotations: { kind: "skill" } },
		]);
		expect(out).toHaveLength(2);
		expect(out[0]).toMatchObject({
			name: "lag-corr",
			category: "lag",
			learnedAt: NOW,
			learnedFrom: "thread:t1",
			status: "candidate",
			source: "turn",
			taskSuccess: "",
			taskSuccessSource: "",
			kind: "skill",
		});
		expect(out[1]).toMatchObject({ name: "resolver-check", status: "approved", source: "hil", taskSuccess: "1" });
	});
});

describe("latestPerSkill (SIO-1889)", () => {
	test("a state transition is a newer fact with the same name; the latest wins regardless of order", () => {
		const older = {
			text: "c",
			annotations: { kind: "skill", skill_name: "x", status: "candidate", learned_at: "2026-09-01T00:00:00Z" },
		};
		const newer = {
			text: "r",
			annotations: { kind: "skill", skill_name: "x", status: "rejected", learned_at: "2026-09-02T00:00:00Z" },
		};
		const other = { text: "o", annotations: { kind: "skill", skill_name: "y", learned_at: "2026-08-01T00:00:00Z" } };
		expect(latestPerSkill([newer, older, other]).map((h) => h.text)).toEqual(["r", "o"]);
		expect(latestPerSkill([older, newer, other]).map((h) => h.text)).toEqual(["r", "o"]);
	});
});

describe("isSkillLearningEnabled", () => {
	// SIO-1889: kill-switch semantics (default ON), matching every other capability flag.
	test("on unless explicitly false or 0", () => {
		expect(isSkillLearningEnabled({} as NodeJS.ProcessEnv)).toBe(true);
		expect(isSkillLearningEnabled({ SKILL_LEARNING_ENABLED: "true" } as NodeJS.ProcessEnv)).toBe(true);
		expect(isSkillLearningEnabled({ SKILL_LEARNING_ENABLED: "false" } as NodeJS.ProcessEnv)).toBe(false);
		expect(isSkillLearningEnabled({ SKILL_LEARNING_ENABLED: "0" } as NodeJS.ProcessEnv)).toBe(false);
	});
});

describe("preGateSkip", () => {
	test("passes a worthy-looking complex multi-tool turn", () => {
		expect(preGateSkip(turn())).toBeNull();
	});
	// SIO-1889: an agent without a confidence score is gated on its graph's own outcome.
	test("an outcome-bearing agent passes only on a completed turn", () => {
		const iac = { agentName: "elastic-iac", confidenceScore: undefined, datasourcesUsed: [] };
		expect(preGateSkip(turn({ ...iac, outcome: "completed" }))).toBeNull();
		expect(preGateSkip(turn({ ...iac, outcome: "rejected" }))).toBe("turn outcome rejected");
		expect(preGateSkip(turn({ ...iac }))).toBe("turn outcome unknown");
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
			status: "candidate",
			source: "turn",
			task_success: "",
			task_success_source: "",
			evidence_count: "0",
		});
	});

	// SIO-1889: the beacon state fields are set through overrides (HIL: born approved).
	test("overrides set the candidate state fields on top of the defaults", () => {
		const a = buildSkillAnnotations(
			{ worthy: true, name: "resolver-check", description: "d", evidence: ["q1", "q2"] },
			"t9",
			NOW,
			"ticket:DEVOPS-1355",
			{ status: "approved", source: "hil", task_success: "1", task_success_source: "hil" },
		);
		expect(a).toMatchObject({
			status: "approved",
			source: "hil",
			task_success: "1",
			task_success_source: "hil",
			evidence_count: "2",
			learned_from: "ticket:DEVOPS-1355",
		});
	});

	// SIO-1127: the HIL learning path overrides learned_from to ticket:<key>.
	test("honors the learnedFrom override (ticket provenance for HIL learning)", () => {
		const a = buildSkillAnnotations(
			{ worthy: true, name: "resolver-check", description: "d" },
			"ignored-thread",
			NOW,
			"ticket:DEVOPS-1355",
		);
		expect(a.learned_from).toBe("ticket:DEVOPS-1355");
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
		expect(text).not.toContain("Evidence:");
	});

	test("renders verified evidence quotes as a bulleted Evidence section", () => {
		const text = buildSkillFactText({
			worthy: true,
			name: "lag-corr",
			description: "d",
			evidence: ["consumer lag 12k", "errors spiked\nat 10:02"],
		});
		expect(text).toContain("Evidence:\n- consumer lag 12k\n- errors spiked at 10:02");
	});
});

describe("verifyEvidence (SIO-1889)", () => {
	test("keeps only quotes actually present in the transcript, whitespace-insensitive", () => {
		const transcript = "User: lag spike?\n\nAssistant: correlated  kafka lag\nwith elastic errors.";
		expect(
			verifyEvidence(["correlated kafka lag with elastic errors", "invented claim here", "short"], transcript),
		).toEqual(["correlated kafka lag with elastic errors"]);
		expect(verifyEvidence(undefined, transcript)).toEqual([]);
	});
});

describe("lessonQuality (SIO-1889 rubric)", () => {
	const good = {
		worthy: true,
		name: "lag-corr",
		description: "Correlate consumer lag with downstream error spikes.",
		when_to_use: "When a lag alert coincides with an error-rate rise.",
		procedure_summary: "Pull lag and error rate over the same window, align timestamps, confirm the overlap.",
		evidence: ["correlated kafka lag with elastic errors"],
	};
	test("passes a well-formed proposal", () => {
		expect(lessonQuality(good)).toEqual({ ok: true });
	});
	test("names the failing rubric item", () => {
		expect(lessonQuality({ ...good, description: "x".repeat(81) })).toEqual({ ok: false, reason: "title" });
		expect(lessonQuality({ ...good, when_to_use: "Consumer lag rising" })).toEqual({
			ok: false,
			reason: "applicability",
		});
		expect(lessonQuality({ ...good, procedure_summary: "too short" })).toEqual({ ok: false, reason: "body" });
		expect(lessonQuality({ ...good, evidence: [] })).toEqual({ ok: false, reason: "evidence" });
	});
});

describe("initialTaskSuccess (SIO-1889)", () => {
	const applied = (taskSuccess: number) => ({
		outcome: "applied" as const,
		model: "jev",
		verdict: { qualifies: true, score: 0.9, taskSuccess, reason: "qualifies" },
	});
	test("a completed outcome outranks the Jev estimate", () => {
		const t = turn({ agentName: "elastic-iac", confidenceScore: undefined, outcome: "completed" });
		expect(initialTaskSuccess(t, applied(0.1))).toEqual({ task_success: "1", task_success_source: "turn-outcome" });
	});
	test("a confidence agent takes Jev when it applied, else nothing", () => {
		expect(initialTaskSuccess(turn(), applied(0.8))).toEqual({ task_success: "1", task_success_source: "jev" });
		expect(initialTaskSuccess(turn(), applied(0.3))).toEqual({ task_success: "0", task_success_source: "jev" });
		expect(initialTaskSuccess(turn(), { outcome: "skipped", reason: "no-key" })).toEqual({
			task_success: "",
			task_success_source: "",
		});
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

	test("no-op when SKILL_LEARNING_ENABLED is switched off", async () => {
		process.env.SKILL_LEARNING_ENABLED = "false";
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
		llmContent =
			'{"worthy":true,"name":"lag-corr","description":"Correlate lag with errors.","when_to_use":"When lag and errors rise together.","procedure_summary":"Pull consumer lag and elastic error rate over one window, then align the timestamps to confirm.","task_category":"lag","evidence":["correlated kafka lag with elastic errors"]}';

		await learnFromTurn(turn(), NOW);
		await flushAgentMemory(); // drain the write-behind queue

		expect(added.length).toBe(1);
		expect(added[0]?.annotations?.kind).toBe("skill");
		expect(added[0]?.annotations?.skill_name).toBe("lag-corr");
		expect(added[0]?.annotations?.confidence).toBe("0.5");
		// SIO-1889: born a candidate; no Jev key under test and a confidence agent -> no task_success yet.
		expect(added[0]?.annotations?.status).toBe("candidate");
		expect(added[0]?.annotations?.source).toBe("turn");
		expect(added[0]?.annotations?.task_success).toBe("");
		expect(added[0]?.annotations?.evidence_count).toBe("1");
		expect(added[0]?.facts[0]).toContain("Proposed skill: lag-corr");
		expect(added[0]?.facts[0]).toContain("Evidence:\n- correlated kafka lag with elastic errors");
	});

	// SIO-1889: the learner runs for every agent; an IaC turn with a completed outcome
	// crystallizes under ITS identity with task_success from the outcome.
	test("an outcome-bearing agent's completed turn crystallizes with task_success from the outcome", async () => {
		process.env.SKILL_LEARNING_ENABLED = "true";
		process.env.LIVE_MEMORY_BACKEND = "agent-memory";
		const { __setAgentMemoryClient, flushAgentMemory, setActiveMemorySession } = await import("./memory-backend.ts");
		const { client, added } = memStub();
		// biome-ignore lint/suspicious/noExplicitAny: SIO-1015 - test stub for the AgentMemoryClient surface
		__setAgentMemoryClient(client as any);
		setActiveMemorySession("elastic-iac", "t2");
		llmContent =
			'{"worthy":true,"name":"lag-corr","description":"Correlate lag with errors.","when_to_use":"When lag and errors rise together.","procedure_summary":"Pull consumer lag and elastic error rate over one window, then align the timestamps to confirm.","task_category":"lag","evidence":["correlated kafka lag with elastic errors"]}';

		await learnFromTurn(
			turn({ agentName: "elastic-iac", confidenceScore: undefined, datasourcesUsed: [], outcome: "completed" }),
			NOW,
		);
		await flushAgentMemory();

		expect(invokeCalls).toBe(1);
		expect(added.length).toBe(1);
		expect(added[0]?.annotations?.task_success).toBe("1");
		expect(added[0]?.annotations?.task_success_source).toBe("turn-outcome");
	});

	test("a Jev verdict that does not qualify ends the turn before the judge", async () => {
		process.env.SKILL_LEARNING_ENABLED = "true";
		process.env.LIVE_MEMORY_BACKEND = "agent-memory";
		llmContent =
			'{"worthy":true,"name":"lag-corr","description":"Correlate lag with errors.","when_to_use":"When lag and errors rise together.","procedure_summary":"Pull consumer lag and elastic error rate over one window, then align the timestamps to confirm.","task_category":"lag","evidence":["correlated kafka lag with elastic errors"]}';
		await learnFromTurn(turn(), NOW, {
			gate: async () => ({
				outcome: "applied",
				model: "jev",
				verdict: { qualifies: false, score: 0.3, taskSuccess: 0.2, reason: "task_success" },
			}),
		});
		expect(invokeCalls).toBe(0);
	});

	test("a qualifying Jev verdict seeds task_success from jev for a confidence agent", async () => {
		process.env.SKILL_LEARNING_ENABLED = "true";
		process.env.LIVE_MEMORY_BACKEND = "agent-memory";
		const { __setAgentMemoryClient, flushAgentMemory } = await import("./memory-backend.ts");
		const { client, added } = memStub();
		// biome-ignore lint/suspicious/noExplicitAny: SIO-1015 - test stub for the AgentMemoryClient surface
		__setAgentMemoryClient(client as any);
		llmContent =
			'{"worthy":true,"name":"lag-corr","description":"Correlate lag with errors.","when_to_use":"When lag and errors rise together.","procedure_summary":"Pull consumer lag and elastic error rate over one window, then align the timestamps to confirm.","task_category":"lag","evidence":["correlated kafka lag with elastic errors"]}';
		await learnFromTurn(turn(), NOW, {
			gate: async () => ({
				outcome: "applied",
				model: "jev",
				verdict: { qualifies: true, score: 0.9, taskSuccess: 0.95, reason: "qualifies" },
			}),
		});
		await flushAgentMemory();
		expect(added[0]?.annotations?.task_success).toBe("1");
		expect(added[0]?.annotations?.task_success_source).toBe("jev");
	});

	test("a proposal that fails the lesson rubric is not stored", async () => {
		process.env.SKILL_LEARNING_ENABLED = "true";
		process.env.LIVE_MEMORY_BACKEND = "agent-memory";
		const { __setAgentMemoryClient, flushAgentMemory } = await import("./memory-backend.ts");
		const { client, added } = memStub();
		// biome-ignore lint/suspicious/noExplicitAny: SIO-1015 - test stub for the AgentMemoryClient surface
		__setAgentMemoryClient(client as any);
		// Evidence the judge did not copy from the transcript is dropped, leaving none.
		llmContent =
			'{"worthy":true,"name":"lag-corr","description":"Correlate lag with errors.","when_to_use":"When lag rises.","procedure_summary":"Pull consumer lag and elastic error rate over one window, then align the timestamps.","evidence":["a claim not in the transcript"]}';
		await learnFromTurn(turn(), NOW);
		await flushAgentMemory();
		expect(invokeCalls).toBe(1);
		expect(added.length).toBe(0);
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
		// A rubric-valid proposal, so the dedup (not the rubric) is what stops the write.
		llmContent =
			'{"worthy":true,"name":"lag-corr","description":"Correlate lag with errors.","when_to_use":"When lag and errors rise together.","procedure_summary":"Pull consumer lag and elastic error rate over one window, then align the timestamps to confirm.","task_category":"lag","evidence":["correlated kafka lag with elastic errors"]}';

		await learnFromTurn(turn(), NOW);
		await flushAgentMemory();

		expect(invokeCalls).toBe(1);
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
