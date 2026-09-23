import { describe, expect, test } from "bun:test";
import type { EvidenceItem, EvidenceSource } from "@devops-agent/shared";
import { HumanMessage } from "@langchain/core/messages";
import { Command } from "@langchain/langgraph";
import {
	DEFAULT_CHANGE_TOOLS,
	type LandingZoneCandidate,
	type LandingZoneChangeTools,
	validateLandingZoneCandidate,
} from "./change-nodes.ts";
import type { LandingZoneEvidenceCollectors } from "./evidence.ts";
import { buildLandingZoneGraph } from "./graph.ts";
import { LandingZoneReviewDecisionSchema, ProposedChangeReviewSchema } from "./types.ts";

const baseSha = "a".repeat(40);
const candidate: LandingZoneCandidate = {
	repository: "aws-lz-account-creator",
	projectId: 42,
	baseBranch: "main",
	baseSha,
	targetBranch: "agent/landing-zone/martech-account",
	changeSummary: "Add the reviewed MarTech account request",
	title: "Add MarTech account request",
	backendChangeApproved: false,
	files: [
		{
			path: "accounts/martech.yml",
			content: "application_name: martech\n",
			expectedFileSha: null,
		},
	],
};

const observedEvidence: EvidenceItem = {
	id: "gitlab:account-creator:abc123",
	claimKey: "repository:aws-lz-account-creator:authoring-surface",
	claimValue: "accounts/*.yml",
	source: "gitlab",
	retrievedAt: "2026-09-23T10:30:00.000Z",
	status: "observed",
	summary: "Account requests are authored in YAML.",
	provenance: { repository: "aws-lz-account-creator", path: "accounts/example.yml" },
	freshness: { status: "current" },
};

function collectors(): LandingZoneEvidenceCollectors {
	const collect = (source: EvidenceSource) => async () => [{ ...observedEvidence, id: `${source}:fixture`, source }];
	return {
		"pvh-okf": collect("pvh-okf"),
		gitlab: collect("gitlab"),
		"terraform-docs": collect("terraform-docs"),
		"aws-docs": collect("aws-docs"),
		"aws-api": collect("aws-api"),
		memory: collect("memory"),
		"knowledge-graph": collect("knowledge-graph"),
	};
}

function tools(calls: string[]): LandingZoneChangeTools {
	return {
		draftCandidate: async (_state, amendment) => {
			calls.push(amendment ? `draft:${amendment}` : "draft");
			return candidate;
		},
		validateCandidate: async () => {
			calls.push("validate");
			return [
				{
					command: "repository validator",
					status: "passed",
					required: true,
					summary: "Account schema and generator validation passed in an isolated workspace.",
				},
			];
		},
		openMergeRequest: async (_candidate, review) => {
			calls.push(`open:${review.baseSha}`);
			return { iid: 17, webUrl: "https://gitlab.example/merge_requests/17", sourceSha: "b".repeat(40) };
		},
		watchPipeline: async () => {
			calls.push("watch");
			return { status: "success", summary: "GitLab CI plan completed successfully." };
		},
	};
}

describe("Landing Zone proposal contracts", () => {
	test("accepts only the exact approve, reject, and amend resume shapes", () => {
		expect(LandingZoneReviewDecisionSchema.parse({ decision: "approve" })).toEqual({ decision: "approve" });
		expect(LandingZoneReviewDecisionSchema.parse({ decision: "reject", reason: "Wrong OU" })).toEqual({
			decision: "reject",
			reason: "Wrong OU",
		});
		expect(
			LandingZoneReviewDecisionSchema.parse({ decision: "amend", instructions: "Use the approved owner" }),
		).toEqual({
			decision: "amend",
			instructions: "Use the approved owner",
		});
		expect(LandingZoneReviewDecisionSchema.safeParse({ decision: "reject" }).success).toBeFalse();
		expect(LandingZoneReviewDecisionSchema.safeParse({ decision: "approve", reason: "extra" }).success).toBeFalse();
	});

	test("requires the complete evidence, risk, validation, and expected-plan review payload", () => {
		const parsed = ProposedChangeReviewSchema.parse({
			reviewId: "11111111-1111-4111-8111-111111111111",
			repository: candidate.repository,
			projectId: candidate.projectId,
			baseBranch: candidate.baseBranch,
			baseSha: candidate.baseSha,
			targetBranch: candidate.targetBranch,
			changeSummary: candidate.changeSummary,
			title: candidate.title,
			files: [{ path: "accounts/martech.yml", contentSha256: "c".repeat(64), expectedFileSha: null }],
			diffSummary: "Create accounts/martech.yml",
			standardsComparison: [],
			validations: [{ command: "repository validator", status: "passed", required: true, summary: "Passed." }],
			expectedPlan: "One account module addition; no replacement or deletion.",
			stopConditions: [],
			destructiveFlags: [],
			unresolvedEvidence: [],
			riskLevel: "high",
		});
		expect(parsed.files[0]?.path).toBe("accounts/martech.yml");
		expect(ProposedChangeReviewSchema.safeParse({ ...parsed, expectedPlan: "" }).success).toBeFalse();
	});

	test("fails candidate validation closed when a required command is unavailable", async () => {
		const result = await validateLandingZoneCandidate(candidate, {
			validateCandidate: async () => [
				{ command: "terraform validate", status: "unavailable", required: true, summary: "Terraform is unavailable." },
			],
		});
		expect(result.passed).toBeFalse();
		expect(result.blockedReason).toContain("terraform validate");
	});

	test("requires repository surface and YAML validation in the production validator", async () => {
		const candidateFile = candidate.files[0];
		if (!candidateFile) throw new Error("Candidate fixture must include a file");

		const valid = await validateLandingZoneCandidate(candidate, DEFAULT_CHANGE_TOOLS);
		expect(valid.passed).toBeTrue();
		const invalid = await validateLandingZoneCandidate(
			{ ...candidate, files: [{ ...candidateFile, content: "application_name: [" }] },
			DEFAULT_CHANGE_TOOLS,
		);
		expect(invalid.passed).toBeFalse();
		expect(invalid.blockedReason).toContain("repository authoring surface and YAML validation");
		const unsupported = await validateLandingZoneCandidate(
			{ ...candidate, repository: "dhco-gitlab-terraform", files: [{ ...candidateFile, path: "projects.tf" }] },
			DEFAULT_CHANGE_TOOLS,
		);
		expect(unsupported.passed).toBeFalse();
	});
});

describe("Landing Zone proposal graph", () => {
	test.each([
		["learn", "Explain how PVH account vending works"],
		["understand", "Describe the account creator repository"],
		["review", "Review the account vending configuration"],
	] as const)("keeps %s turns out of every write node", async (_intent, prompt) => {
		const calls: string[] = [];
		const graph = await buildLandingZoneGraph({
			checkpointerType: "memory",
			collectors: collectors(),
			changeTools: tools(calls),
		});
		await graph.invoke(
			{ messages: [new HumanMessage(prompt)], requestId: `request-${_intent}` },
			{ configurable: { thread_id: `thread-${_intent}` } },
		);
		expect(calls).toEqual([]);
	});

	test("cannot reach MR creation until risk, validation, and the human approval interrupt all pass", async () => {
		const calls: string[] = [];
		const graph = await buildLandingZoneGraph({
			checkpointerType: "memory",
			collectors: collectors(),
			changeTools: tools(calls),
		});
		const config = { configurable: { thread_id: "thread-proposal" } };
		await graph.invoke(
			{ messages: [new HumanMessage("Create the MarTech AWS account")], requestId: "request-proposal" },
			config,
		);
		expect(calls).toEqual(["draft", "validate"]);
		const paused = await graph.getState(config);
		const interruptValue = paused.tasks[0]?.interrupts[0]?.value as { type?: string; review?: unknown } | undefined;
		expect(interruptValue?.type).toBe("landing_zone_plan_review");
		expect(ProposedChangeReviewSchema.safeParse(interruptValue?.review).success).toBeTrue();
		expect(interruptValue?.review).toMatchObject({
			reviewId: expect.any(String),
			diffSummary: expect.stringContaining("application_name: martech"),
		});

		await graph.invoke(new Command({ resume: { decision: "approve" } }), config);
		expect(calls).toEqual(["draft", "validate", `open:${baseSha}`, "watch"]);
		const completed = await graph.getState(config);
		expect(completed.values.outcome).toBe("answered");
	});

	test("reject stops and amend re-drafts without opening an MR", async () => {
		const rejectCalls: string[] = [];
		const rejectGraph = await buildLandingZoneGraph({
			checkpointerType: "memory",
			collectors: collectors(),
			changeTools: tools(rejectCalls),
		});
		const rejectConfig = { configurable: { thread_id: "thread-reject" } };
		await rejectGraph.invoke({ messages: [new HumanMessage("Create the MarTech AWS account")] }, rejectConfig);
		await rejectGraph.invoke(new Command({ resume: { decision: "reject", reason: "Wrong OU" } }), rejectConfig);
		expect(rejectCalls).toEqual(["draft", "validate"]);

		const amendCalls: string[] = [];
		const amendGraph = await buildLandingZoneGraph({
			checkpointerType: "memory",
			collectors: collectors(),
			changeTools: tools(amendCalls),
		});
		const amendConfig = { configurable: { thread_id: "thread-amend" } };
		await amendGraph.invoke({ messages: [new HumanMessage("Create the MarTech AWS account")] }, amendConfig);
		await amendGraph.invoke(
			new Command({ resume: { decision: "amend", instructions: "Use the approved business owner" } }),
			amendConfig,
		);
		expect(amendCalls).toEqual(["draft", "validate", "draft:Use the approved business owner", "validate"]);
		const amended = await amendGraph.getState(amendConfig);
		expect(amended.tasks[0]?.interrupts[0]?.value).toMatchObject({ type: "landing_zone_plan_review" });
	});
});
