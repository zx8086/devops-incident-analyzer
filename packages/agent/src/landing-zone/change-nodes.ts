// packages/agent/src/landing-zone/change-nodes.ts

import { createHash, createHmac } from "node:crypto";
import { AIMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import { interrupt } from "@langchain/langgraph";
import { parse as parseYaml } from "yaml";
import { createLlm } from "../llm.ts";
import { getToolsForDataSource } from "../mcp-bridge.ts";
import { extractTextFromContent } from "../message-utils.ts";
import type { LandingZoneStateType } from "./state.ts";
import {
	type LandingZoneCandidate,
	LandingZoneCandidateSchema,
	type LandingZoneCandidateValidation,
	LandingZoneCandidateValidationSchema,
	LandingZoneMergeRequestSchema,
	LandingZonePipelineObservationSchema,
	LandingZoneReviewDecisionSchema,
	type ProposedChangeReview,
	ProposedChangeReviewSchema,
} from "./types.ts";

export type { LandingZoneCandidate } from "./types.ts";

export interface LandingZoneChangeTools {
	draftCandidate(state: LandingZoneStateType, amendmentInstructions?: string): Promise<LandingZoneCandidate>;
	validateCandidate(candidate: LandingZoneCandidate): Promise<LandingZoneCandidateValidation[]>;
	openMergeRequest(
		candidate: LandingZoneCandidate,
		review: ProposedChangeReview,
	): Promise<{ iid: number; webUrl: string; sourceSha: string }>;
	watchPipeline(
		mergeRequest: { iid: number; webUrl: string; sourceSha: string },
		candidate: LandingZoneCandidate,
	): Promise<{ status: string; summary: string }>;
}

function latestText(state: LandingZoneStateType): string {
	const content = state.messages.at(-1)?.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => (typeof part === "object" && part !== null && "text" in part ? String(part.text) : ""))
		.join("\n");
}

function candidateFromPrompt(state: LandingZoneStateType): LandingZoneCandidate {
	const text = latestText(state);
	const fenced = text.match(/```(?:landing-zone-change|json)\s*([\s\S]*?)```/i)?.[1];
	if (!fenced) {
		throw new Error(
			"A complete candidate could not be derived safely. Provide verified repository, project, revision, file, and governance values.",
		);
	}
	try {
		return LandingZoneCandidateSchema.parse(JSON.parse(fenced));
	} catch (error) {
		throw new Error(
			`The supplied Landing Zone candidate is invalid: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

async function draftCandidateFromEvidence(
	state: LandingZoneStateType,
	amendmentInstructions?: string,
): Promise<LandingZoneCandidate> {
	const text = latestText(state);
	if (/```(?:landing-zone-change|json)\s*[\s\S]*?```/i.test(text)) return candidateFromPrompt(state);
	const evidence = state.evidenceResults.map(({ id, source, status, summary, provenance, freshness }) => ({
		id,
		source,
		status,
		summary,
		provenance,
		freshness,
	}));
	const response = await createLlm("iacDrafter", "landing-zone-terraform").invoke([
		new SystemMessage(
			"Draft one bounded PVH Landing Zone GitOps candidate as strict JSON matching: " +
				"{repository,projectId,baseBranch,baseSha,targetBranch,changeSummary,title,backendChangeApproved,files:[{path,content,expectedFileSha}]}. " +
				"Use only values present in current evidence or the user request. Never invent governance values, project IDs, SHAs, OU IDs, accounts, CIDRs, roles, or permission sets. " +
				"The target branch must start agent/landing-zone/. Use null expectedFileSha only for a proven new file. Return JSON only; if any required value is missing, return an invalid empty object so the graph stops safely.",
		),
		new HumanMessage(
			JSON.stringify({
				request: text,
				amendmentInstructions: amendmentInstructions ?? null,
				repositories: state.repositoryScope,
				evidence,
			}),
		),
	]);
	const raw = extractTextFromContent(response.content)
		.trim()
		.replace(/^```(?:json)?\s*/i, "")
		.replace(/\s*```$/, "");
	return LandingZoneCandidateSchema.parse(JSON.parse(raw));
}

function textPayload(value: unknown): unknown {
	if (typeof value === "string") {
		try {
			return JSON.parse(value);
		} catch {
			return value;
		}
	}
	if (typeof value !== "object" || value === null) return value;
	const content = (value as { content?: unknown }).content;
	if (!Array.isArray(content)) return value;
	const text = content.find(
		(part): part is { type: "text"; text: string } =>
			typeof part === "object" &&
			part !== null &&
			(part as { type?: unknown }).type === "text" &&
			typeof (part as { text?: unknown }).text === "string",
	)?.text;
	if (!text) return value;
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

async function invokeWriteTool(name: string, input: Record<string, unknown>): Promise<unknown> {
	const tool = getToolsForDataSource("landing-zone-iac").find((candidate) => candidate.name === name);
	if (!tool) throw new Error(`${name} is unavailable; Landing Zone write mode is not connected`);
	const result = await tool.invoke(input);
	if (typeof result === "object" && result !== null && (result as { isError?: unknown }).isError === true) {
		throw new Error(`${name} was rejected: ${JSON.stringify(textPayload(result))}`);
	}
	return textPayload(result);
}

function reviewManifest(candidate: LandingZoneCandidate, review: ProposedChangeReview) {
	const secret = process.env.LANDING_ZONE_WRITE_REVIEW_SECRET;
	if (!secret || Buffer.byteLength(secret, "utf8") < 32) {
		throw new Error("Landing Zone review signing is not configured");
	}
	const issuedAt = new Date();
	const manifest = {
		approvalId: crypto.randomUUID(),
		issuedAt: issuedAt.toISOString(),
		expiresAt: new Date(issuedAt.getTime() + 10 * 60_000).toISOString(),
		repository: candidate.repository,
		projectId: candidate.projectId,
		baseBranch: candidate.baseBranch,
		baseSha: candidate.baseSha,
		targetBranch: candidate.targetBranch,
		changeSummary: candidate.changeSummary,
		backendChangeApproved: candidate.backendChangeApproved,
		files: review.files,
		mergeRequest: {
			title: review.title,
			evidence: review.standardsComparison.length
				? review.standardsComparison.map((comparison) => `${comparison.claim}: ${comparison.alignment}`)
				: ["Current repository evidence and the routed PVH concept were reviewed."],
			validationResults: review.validations.map(
				(validation) => `${validation.command}: ${validation.status} - ${validation.summary}`,
			),
			riskSummary: review.destructiveFlags.length
				? review.destructiveFlags.join(" ")
				: `Risk ${review.riskLevel}; no destructive flag was detected.`,
			expectedPlanShape: review.expectedPlan,
		},
	};
	const token = `v1.${createHmac("sha256", secret).update(JSON.stringify(manifest)).digest("hex")}`;
	return { manifest, token };
}

export const DEFAULT_CHANGE_TOOLS: LandingZoneChangeTools = {
	draftCandidate: draftCandidateFromEvidence,
	validateCandidate: async (candidate) => {
		const allowedSurface: Record<string, RegExp> = {
			"aws-lz-account-creator": /^accounts\/[^/]+\.ya?ml$/i,
			"aws-lz-network-workloads": /^environments\/[^/]+\/vpcs\/[^/]+\.ya?ml$/i,
			"aws-lz-network-core": /^environments\/[^/]+\/WAN\/[^/]+\.ya?ml$/i,
			"aws-lz-post-vending": /^workloads\/[^/]+\.ya?ml$/i,
			"gitlab-k8s-runners-lzv2": /^runners\/[^/]+\/[^/]+\.ya?ml$/i,
		};
		const surface = allowedSurface[candidate.repository];
		const surfacePassed = surface !== undefined && candidate.files.every((file) => surface.test(file.path));
		let yamlError: string | undefined;
		if (surfacePassed) {
			for (const file of candidate.files) {
				try {
					const parsed = parseYaml(file.content);
					if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
						throw new Error("root must be a mapping");
					}
				} catch (error) {
					yamlError = `${file.path}: ${error instanceof Error ? error.message : String(error)}`;
					break;
				}
			}
		}
		return [
			{
				command: "candidate contract",
				status: LandingZoneCandidateSchema.safeParse(candidate).success ? "passed" : "failed",
				required: true,
				summary: "The bounded candidate was checked against the Landing Zone proposal schema.",
			},
			{
				command: "repository authoring surface and YAML validation",
				status: surfacePassed ? (yamlError ? "failed" : "passed") : "unavailable",
				required: true,
				summary: surfacePassed
					? (yamlError ??
						"Every proposed file matches the repository authoring surface and parses as a YAML mapping. GitLab CI remains authoritative for generator and plan validation.")
					: "No safe in-process validator exists for this repository or file surface; the proposal is blocked before review.",
			},
		];
	},
	openMergeRequest: async (candidate, review) => {
		const { manifest, token } = reviewManifest(candidate, review);
		const common = {
			repository: candidate.repository,
			projectId: candidate.projectId,
			baseBranch: candidate.baseBranch,
			baseSha: candidate.baseSha,
			targetBranch: candidate.targetBranch,
			changeSummary: candidate.changeSummary,
			reviewManifest: manifest,
			reviewToken: token,
		};
		await invokeWriteTool("lz_create_branch", common);
		const committed = (await invokeWriteTool("lz_commit_allowed_files", {
			...common,
			expectedBranchSha: candidate.baseSha,
			commitMessage: candidate.title,
			backendChangeApproved: candidate.backendChangeApproved,
			files: candidate.files,
		})) as { sha?: unknown };
		if (typeof committed?.sha !== "string") throw new Error("GitLab did not return the reviewed commit SHA");
		const opened = await invokeWriteTool("lz_open_merge_request", {
			...common,
			sourceSha: committed.sha,
			title: manifest.mergeRequest.title,
			evidence: manifest.mergeRequest.evidence,
			validationResults: manifest.mergeRequest.validationResults,
			riskSummary: manifest.mergeRequest.riskSummary,
			expectedPlanShape: manifest.mergeRequest.expectedPlanShape,
		});
		return LandingZoneMergeRequestSchema.parse({ ...(opened as object), sourceSha: committed.sha });
	},
	watchPipeline: async (mergeRequest, candidate) => {
		const observation = await invokeWriteTool("lz_watch_pipeline", {
			repository: candidate.repository,
			projectId: candidate.projectId,
			iid: mergeRequest.iid,
		});
		return LandingZonePipelineObservationSchema.parse({
			status: "observing",
			summary: JSON.stringify(observation).slice(0, 8_192),
		});
	},
};

export async function validateLandingZoneCandidate(
	candidate: LandingZoneCandidate,
	tools: Pick<LandingZoneChangeTools, "validateCandidate">,
): Promise<{ passed: boolean; validations: LandingZoneCandidateValidation[]; blockedReason: string | null }> {
	const parsedCandidate = LandingZoneCandidateSchema.parse(candidate);
	const validations = (await tools.validateCandidate(parsedCandidate)).map((result) =>
		LandingZoneCandidateValidationSchema.parse(result),
	);
	if (validations.length === 0) {
		return { passed: false, validations, blockedReason: "No candidate validation result was produced." };
	}
	const blocking = validations.filter((validation) => validation.required && validation.status !== "passed");
	return {
		passed: blocking.length === 0,
		validations,
		blockedReason:
			blocking.length > 0
				? `Required candidate validation did not pass: ${blocking.map((validation) => validation.command).join(", ")}.`
				: null,
	};
}

export function createLandingZoneChangeNodes(tools: LandingZoneChangeTools = DEFAULT_CHANGE_TOOLS) {
	return {
		draftChange: async (state: LandingZoneStateType): Promise<Partial<LandingZoneStateType>> => {
			if (state.intent !== "propose-change" || state.risk?.blocked || !state.risk?.requiresHumanDecision) {
				return { blockedReason: "The risk gate did not authorize a Landing Zone proposal." };
			}
			if (state.proposalIteration >= 3) {
				return { blockedReason: "The proposal reached the maximum of three review amendments." };
			}
			try {
				const candidate = LandingZoneCandidateSchema.parse(
					await tools.draftCandidate(state, state.amendmentInstructions ?? undefined),
				);
				if (!state.repositoryScope.includes(candidate.repository)) {
					throw new Error(`${candidate.repository} is outside the evidence-backed repository scope`);
				}
				return {
					changeCandidate: candidate,
					candidateValidations: [],
					candidateValidationPassed: false,
					proposedChangeReview: null,
					reviewDecision: null,
					amendmentInstructions: null,
					proposalIteration: state.proposalIteration + 1,
					blockedReason: null,
				};
			} catch (error) {
				return { blockedReason: error instanceof Error ? error.message : "Candidate drafting failed." };
			}
		},

		validateCandidate: async (state: LandingZoneStateType): Promise<Partial<LandingZoneStateType>> => {
			if (!state.changeCandidate) return { blockedReason: "No change candidate exists to validate." };
			try {
				const result = await validateLandingZoneCandidate(state.changeCandidate, tools);
				return {
					candidateValidations: result.validations,
					candidateValidationPassed: result.passed,
					blockedReason: result.blockedReason,
				};
			} catch (error) {
				return {
					candidateValidationPassed: false,
					blockedReason: error instanceof Error ? error.message : "Candidate validation failed.",
				};
			}
		},

		prepareReview: async (state: LandingZoneStateType): Promise<Partial<LandingZoneStateType>> => {
			const candidate = state.changeCandidate;
			if (!candidate || !state.candidateValidationPassed || !state.risk || state.risk.blocked) {
				return { blockedReason: "Risk and candidate validation must pass before human review." };
			}
			const files = candidate.files.map((file) => ({
				path: file.path,
				contentSha256: createHash("sha256").update(file.content, "utf8").digest("hex"),
				expectedFileSha: file.expectedFileSha,
			}));
			const destructiveFlags = state.risk.reasons.filter((reason) =>
				/destruct|delete|replace|public|iam|backend|state|secret/i.test(reason),
			);
			const unresolvedEvidence = [
				...(state.reconciliation?.unavailableSources.map((source) => `${source} evidence was unavailable.`) ?? []),
				...(state.reconciliation?.conflicts ?? []),
			];
			const review = ProposedChangeReviewSchema.parse({
				reviewId: crypto.randomUUID(),
				repository: candidate.repository,
				projectId: candidate.projectId,
				baseBranch: candidate.baseBranch,
				baseSha: candidate.baseSha,
				targetBranch: candidate.targetBranch,
				changeSummary: candidate.changeSummary,
				title: candidate.title,
				files,
				diffSummary: candidate.files
					.map(
						(file) =>
							`${file.expectedFileSha === null ? "Create" : "Update"} ${file.path}\n--- proposed full content ---\n${file.content}`,
					)
					.join("\n"),
				standardsComparison: state.reconciliation?.comparisons ?? [],
				validations: state.candidateValidations,
				expectedPlan: `GitLab CI should plan ${files.length} reviewed file change(s). No apply is performed by the agent.`,
				stopConditions: state.risk.stopConditions,
				destructiveFlags,
				unresolvedEvidence,
				riskLevel: state.risk.level,
			});
			return { proposedChangeReview: review, blockedReason: null };
		},

		reviewGate: (state: LandingZoneStateType): Partial<LandingZoneStateType> => {
			if (
				!state.proposedChangeReview ||
				!state.changeCandidate ||
				!state.candidateValidationPassed ||
				state.risk?.blocked ||
				state.proposedChangeReview.stopConditions.length > 0
			) {
				return { blockedReason: "The proposal is not eligible for human approval." };
			}
			const decision = LandingZoneReviewDecisionSchema.parse(
				interrupt({
					type: "landing_zone_plan_review",
					review: ProposedChangeReviewSchema.parse(state.proposedChangeReview),
					message:
						"Review the evidence-backed Landing Zone proposal. Approval opens or updates an MR; it never applies.",
				}),
			);
			if (decision.decision === "amend") {
				return { reviewDecision: decision, amendmentInstructions: decision.instructions };
			}
			if (decision.decision === "reject") {
				return { reviewDecision: decision, blockedReason: `Proposal rejected: ${decision.reason}` };
			}
			return { reviewDecision: decision, blockedReason: null };
		},

		openMergeRequest: async (state: LandingZoneStateType): Promise<Partial<LandingZoneStateType>> => {
			if (
				state.reviewDecision?.decision !== "approve" ||
				!state.candidateValidationPassed ||
				state.risk?.blocked ||
				!state.changeCandidate ||
				!state.proposedChangeReview
			) {
				return { blockedReason: "A current approved review is required before opening a merge request." };
			}
			try {
				return {
					mergeRequest: LandingZoneMergeRequestSchema.parse(
						await tools.openMergeRequest(state.changeCandidate, state.proposedChangeReview),
					),
				};
			} catch (error) {
				return { blockedReason: error instanceof Error ? error.message : "Merge request creation failed." };
			}
		},

		watchPipeline: async (state: LandingZoneStateType): Promise<Partial<LandingZoneStateType>> => {
			if (!state.mergeRequest || !state.changeCandidate) {
				return { blockedReason: "No reviewed merge request exists for pipeline observation." };
			}
			try {
				return {
					pipelineObservation: LandingZonePipelineObservationSchema.parse(
						await tools.watchPipeline(state.mergeRequest, state.changeCandidate),
					),
				};
			} catch (error) {
				return { blockedReason: error instanceof Error ? error.message : "Pipeline observation failed." };
			}
		},

		recordOutcome: async (state: LandingZoneStateType): Promise<Partial<LandingZoneStateType>> => {
			let response: string;
			if (state.mergeRequest) {
				response = `Opened merge request !${state.mergeRequest.iid}: ${state.mergeRequest.webUrl}`;
				if (state.pipelineObservation) response += `\n\n${state.pipelineObservation.summary}`;
				response += "\n\nThe agent did not merge or apply this change.";
			} else if (state.reviewDecision?.decision === "reject") {
				response = `Proposal rejected: ${state.reviewDecision.reason}`;
			} else {
				response = state.blockedReason ?? "The Landing Zone proposal stopped without a repository write.";
			}
			return {
				messages: [new AIMessage(response)],
				response,
				outcome: state.mergeRequest ? "answered" : "blocked",
			};
		},
	};
}
