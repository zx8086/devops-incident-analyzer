// packages/agent/src/mitigation-branches.test.ts
//
// SIO-741: per-branch success + timeout + non-deadline error coverage.

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { BaseMessage } from "@langchain/core/messages";

const ORIG_ENV = { ...process.env };

type BranchMode = "succeed" | "hang" | "throwOther" | "duplicateIndexKey";
type BranchKind = "investigate" | "monitor" | "escalate";

let mode: BranchMode = "succeed";
const capturedSystemPrompts: string[] = [];

mock.module("@langchain/aws", () => ({
	ChatBedrockConverse: class {
		withFallbacks() {
			return this;
		}
		bindTools() {
			return this;
		}
		async invoke(
			messages: BaseMessage[] | Array<{ role: string; content: string }>,
			config?: { signal?: AbortSignal },
		) {
			const msgArray = messages as Array<{ role?: string; content?: string }>;
			const sys = msgArray.find((m) => m?.role === "system");
			if (sys?.content) capturedSystemPrompts.push(sys.content);

			if (mode === "succeed") {
				return { content: JSON.stringify({ items: ["one", "two", "three"] }) };
			}
			// SIO-1243: the production escalate item -- a covering index whose key list repeats
			// `articleType`. Identifiers genericized.
			if (mode === "duplicateIndexKey") {
				return {
					content: JSON.stringify({
						items: [
							"Add a covering index (requires human approval):\n\n```sql\nCREATE INDEX idx_dates_covering ON `default`.`seasons`.`dates`(`salesOrganizationCode`, `articleType`, `styleSeasonCodeFms`, `documentUpdatedBy`, `articleType`);\n```",
							"Unrelated step with no DDL.",
						],
					}),
				};
			}
			if (mode === "throwOther") {
				throw new Error("upstream-explosion");
			}
			return await new Promise<{ content: string }>((_resolve, reject) => {
				config?.signal?.addEventListener("abort", () => {
					const err = new Error("Aborted");
					err.name = "AbortError";
					reject(err);
				});
			});
		}
	},
}));

mock.module("./prompt-context.ts", () => ({
	getRunbookFilenames: () => [] as string[],
	getAgent: () => ({ manifest: {} }),
	// SIO-1040: aggregate() now reads buildOrchestratorPromptParts; stub it so the
	// process-global mock never lets a real prompt build run against this thin getAgent.
	buildOrchestratorPromptParts: () => ({ stable: "", volatile: "" }),
}));

import { proposeEscalate, proposeInvestigate, proposeMonitor } from "./mitigation-branches.ts";
import type { AgentStateType } from "./state.ts";

beforeEach(() => {
	process.env = { ...ORIG_ENV };
	capturedSystemPrompts.length = 0;
	mode = "succeed";
});

afterEach(() => {
	process.env = { ...ORIG_ENV };
});

function baseState(overrides: Partial<AgentStateType> = {}): AgentStateType {
	return {
		messages: [],
		attachmentMeta: [],
		queryComplexity: "complex",
		targetDataSources: ["elastic"],
		targetDeployments: [],
		retryDeployments: [],
		dataSourceResults: [],
		currentDataSource: "",
		extractedEntities: { dataSources: [] },
		previousEntities: { dataSources: [] },
		toolPlanMode: "autonomous",
		toolPlan: [],
		validationResult: "pass",
		retryCount: 0,
		alignmentRetries: 0,
		alignmentHints: [],
		skippedDataSources: [],
		isFollowUp: false,
		finalAnswer: "x".repeat(200),
		dataSourceContext: undefined,
		requestId: "test-request",
		suggestions: [],
		normalizedIncident: { severity: "high" },
		mitigationSteps: { investigate: [], monitor: [], escalate: [], relatedRunbooks: [] },
		mitigationFragments: [],
		confidenceScore: 0.7,
		lowConfidence: false,
		degradedRules: [],
		confidenceCap: undefined,
		pendingCorrelations: [],
		pendingActions: [],
		actionResults: [],
		selectedRunbooks: null,
		partialFailures: [],
		...overrides,
	} as AgentStateType;
}

const BRANCHES: Array<{ name: BranchKind; fn: typeof proposeInvestigate; envKey: string }> = [
	{ name: "investigate", fn: proposeInvestigate, envKey: "AGENT_LLM_TIMEOUT_MITIGATE_INVESTIGATE_MS" },
	{ name: "monitor", fn: proposeMonitor, envKey: "AGENT_LLM_TIMEOUT_MITIGATE_MONITOR_MS" },
	{ name: "escalate", fn: proposeEscalate, envKey: "AGENT_LLM_TIMEOUT_MITIGATE_ESCALATE_MS" },
];

describe("mitigation branches", () => {
	for (const branch of BRANCHES) {
		describe(`${branch.name} branch`, () => {
			test("success returns a single fragment with parsed items", async () => {
				mode = "succeed";
				const result = await branch.fn(baseState());
				expect(result.mitigationFragments).toEqual([{ kind: branch.name, items: ["one", "two", "three"] }]);
				expect(result.partialFailures).toBeUndefined();
			});

			test("deadline timeout returns failed fragment + matching partialFailures entry", async () => {
				mode = "hang";
				process.env[branch.envKey] = "30";
				const result = await branch.fn(baseState());
				expect(result.mitigationFragments).toEqual([{ kind: branch.name, items: [], failed: true }]);
				expect(result.partialFailures).toEqual([{ node: `proposeMitigation.${branch.name}`, reason: "timeout" }]);
			});

			test("non-deadline error returns empty fragment without a partialFailure entry", async () => {
				mode = "throwOther";
				const result = await branch.fn(baseState());
				expect(result.mitigationFragments).toEqual([{ kind: branch.name, items: [] }]);
				expect(result.partialFailures).toBeUndefined();
			});

			test("bails out cleanly when finalAnswer is too short", async () => {
				mode = "succeed";
				const result = await branch.fn(baseState({ finalAnswer: "" }));
				expect(result.mitigationFragments).toEqual([{ kind: branch.name, items: [] }]);
			});
		});
	}

	test("each branch prompt is scoped to its own category only", async () => {
		mode = "succeed";
		await proposeInvestigate(baseState());
		const investigatePrompt = capturedSystemPrompts[0];
		expect(investigatePrompt).toContain("investigate");
		// The scoped prompt should NOT contain the other categories' RULES headlines.
		// (Word-boundary check to allow incidental mentions inside example text.)
		expect(investigatePrompt).not.toMatch(/Category: monitor/);
		expect(investigatePrompt).not.toMatch(/Category: escalate/);

		capturedSystemPrompts.length = 0;
		await proposeMonitor(baseState());
		const monitorPrompt = capturedSystemPrompts[0];
		expect(monitorPrompt).toContain("monitor");
		expect(monitorPrompt).not.toMatch(/Category: investigate/);
		expect(monitorPrompt).not.toMatch(/Category: escalate/);

		capturedSystemPrompts.length = 0;
		await proposeEscalate(baseState());
		const escalatePrompt = capturedSystemPrompts[0];
		expect(escalatePrompt).toContain("escalate");
		expect(escalatePrompt).not.toMatch(/Category: investigate/);
		expect(escalatePrompt).not.toMatch(/Category: monitor/);
	});
});

// SIO-1243: BranchOutputSchema validates the JSON SHAPE only, so a hallucinated CREATE INDEX
// reached the operator verbatim under "Escalate (requires human approval)". The dedupe is a
// mechanical invariant enforced deterministically on every branch's items.
describe("SIO-1243: emitted CREATE INDEX key dedupe", () => {
	test("removes a duplicate index key from an escalate item", async () => {
		mode = "duplicateIndexKey";
		const out = await proposeEscalate(baseState());
		const items = out.mitigationFragments?.[0]?.items ?? [];
		expect(items).toHaveLength(2);
		const ddlItem = items[0] as string;
		expect(ddlItem.match(/articleType/g)).toHaveLength(1);
		expect(ddlItem).toContain(
			"CREATE INDEX idx_dates_covering ON `default`.`seasons`.`dates`(`salesOrganizationCode`, `articleType`, `styleSeasonCodeFms`, `documentUpdatedBy`);",
		);
		// Surrounding prose and the fenced block survive untouched.
		expect(ddlItem).toStartWith("Add a covering index (requires human approval):");
		expect(ddlItem).toContain("```sql");
	});

	test("applies to investigate and monitor too, not just escalate", async () => {
		mode = "duplicateIndexKey";
		for (const fn of [proposeInvestigate, proposeMonitor]) {
			const out = await fn(baseState());
			const ddlItem = (out.mitigationFragments?.[0]?.items?.[0] ?? "") as string;
			expect(ddlItem.match(/articleType/g)).toHaveLength(1);
		}
	});

	test("leaves items without DDL byte-identical", async () => {
		mode = "duplicateIndexKey";
		const out = await proposeEscalate(baseState());
		expect(out.mitigationFragments?.[0]?.items?.[1]).toBe("Unrelated step with no DDL.");
	});

	test("a clean branch response is passed through unchanged", async () => {
		mode = "succeed";
		const out = await proposeEscalate(baseState());
		expect(out.mitigationFragments?.[0]?.items).toEqual(["one", "two", "three"]);
	});
});
