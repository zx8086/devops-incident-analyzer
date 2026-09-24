// packages/agent/src/landing-zone/types.ts

import {
	type EvidenceItem,
	EvidenceItemSchema,
	type EvidenceReconciliation,
	EvidenceReconciliationSchema,
	EvidenceSourceSchema,
	type LandingZoneRiskAssessment,
	LandingZoneRiskAssessmentSchema,
	ResponseCitationSchema,
	StandardsComparisonSchema,
	TopologyEvidenceStateSchema,
} from "@devops-agent/shared";
import { z } from "zod";

export const LandingZoneIntentSchema = z.enum(["learn", "understand", "review", "propose-change"]);
export type LandingZoneIntent = z.infer<typeof LandingZoneIntentSchema>;

export const LANDING_ZONE_REPOSITORIES = [
	"aws-lz-account-creator",
	"aws-lz-ami",
	"aws-lz-app-proxy",
	"aws-lz-backup",
	"aws-lz-citrix",
	"aws-lz-dc",
	"aws-lz-dfs",
	"aws-lz-f5-ingress",
	"aws-lz-finops",
	"aws-lz-infra-ss-components",
	"aws-lz-logging",
	"aws-lz-monitoring",
	"aws-lz-network-core",
	"aws-lz-network-workloads",
	"aws-lz-post-vending",
	"aws-lz-security-tools",
	"aws-lz-shared-tools",
	"aws-lz-ssm",
	"aws-lz-storage",
	"aws-lz-vending-orchestrator",
	"dhco-gitlab-terraform",
	"gitlab-k8s-runners-lzv2",
	"gitlab-k8s-runners-terraform",
] as const;

export const LandingZoneRepositorySchema = z.enum(LANDING_ZONE_REPOSITORIES);
export type LandingZoneRepository = z.infer<typeof LandingZoneRepositorySchema>;

export const AwsAccountIdSchema = z.string().regex(/^\d{12}$/);
export const LandingZoneResolutionSourceSchema = z.enum([
	"explicit",
	"deterministic",
	"model",
	"session",
	"unresolved",
]);
export const LandingZoneRequestSubjectSchema = z.enum([
	"account-vending",
	"repository-explanation",
	"topology",
	"standards-comparison",
	"general",
]);
export const LandingZoneTopologyViewSchema = z.enum(["network", "dns", "path"]);

export const LandingZoneRequestResolutionSchema = z
	.object({
		intent: LandingZoneIntentSchema,
		subject: LandingZoneRequestSubjectSchema,
		repositories: z.array(LandingZoneRepositorySchema).max(LANDING_ZONE_REPOSITORIES.length),
		accountIds: z.array(AwsAccountIdSchema).max(20),
		application: z.string().trim().min(1).max(100).nullable(),
		environment: z.string().trim().min(1).max(20).nullable(),
		topologyView: LandingZoneTopologyViewSchema.nullable(),
		clarification: z.string().trim().min(1).max(500).nullable(),
		repositoryResolution: LandingZoneResolutionSourceSchema,
		accountResolution: LandingZoneResolutionSourceSchema,
	})
	.strict();
export type LandingZoneRequestResolution = z.infer<typeof LandingZoneRequestResolutionSchema>;

export const LandingZoneAnswerSchema = z
	.object({
		answerMarkdown: z.string().trim().min(1).max(32_768),
		citations: z.array(ResponseCitationSchema).max(100),
		limitations: z.array(z.string().trim().min(1).max(2_000)).max(50),
	})
	.strict();
export type LandingZoneAnswer = z.infer<typeof LandingZoneAnswerSchema>;

export const LandingZoneAnswerValidationSchema = z
	.object({
		valid: z.boolean(),
		issues: z.array(z.string().trim().min(1).max(2_000)).max(50),
	})
	.strict();
export type LandingZoneAnswerValidation = z.infer<typeof LandingZoneAnswerValidationSchema>;

export const LandingZoneMemoryKindSchema = z.enum([
	"terraform-change",
	"account-vending",
	"network-onboarding",
	"dns-design",
	"gitlab-project",
	"runner-onboarding",
	"plan-outcome",
	"key-decision",
	"platform-exception",
	"failed-approach",
	"learned-pattern",
	"in-flight-change",
]);
export type LandingZoneMemoryKind = z.infer<typeof LandingZoneMemoryKindSchema>;

export const LandingZonePriorMemorySchema = z
	.object({
		text: z.string().trim().min(1).max(8_192),
		annotations: z.record(z.string(), z.string()),
		blockId: z.string().trim().min(1).optional(),
		advisory: z.literal(true),
		requiresLiveRevalidation: z.literal(true),
	})
	.strict();
export type LandingZonePriorMemory = z.infer<typeof LandingZonePriorMemorySchema>;

export const LandingZoneEvidenceResultSchema = EvidenceItemSchema;
export type LandingZoneEvidenceResult = EvidenceItem;

const EvidenceCollectionOutcomeSchema = z
	.object({
		source: EvidenceSourceSchema,
		status: z.enum(["collected", "unavailable", "skipped"]),
		evidence: z.array(EvidenceItemSchema),
		reason: z.string().optional(),
	})
	.strict()
	.nullable();

export const LandingZoneReconciliationSchema = EvidenceReconciliationSchema;
export type LandingZoneReconciliation = EvidenceReconciliation;

export const LandingZoneRiskSchema = LandingZoneRiskAssessmentSchema;
export type LandingZoneRisk = LandingZoneRiskAssessment;

const CommitShaSchema = z.string().regex(/^[0-9a-f]{40}$/i);
const ContentShaSchema = z.string().regex(/^[0-9a-f]{64}$/i);
const RepositoryPathSchema = z
	.string()
	.trim()
	.min(1)
	.max(500)
	.refine(
		(path) =>
			!path.startsWith("/") &&
			!path.includes("\\") &&
			!path.split("/").some((part) => part === "" || part === "." || part === ".."),
		"must be a safe repository-relative path",
	);

export const LandingZoneCandidateFileSchema = z
	.object({
		path: RepositoryPathSchema,
		content: z.string().max(524_288),
		expectedFileSha: CommitShaSchema.nullable(),
	})
	.strict();

export const LandingZoneCandidateSchema = z
	.object({
		repository: z.string().trim().min(1),
		projectId: z.number().int().positive(),
		baseBranch: z.string().trim().min(1).max(255),
		baseSha: CommitShaSchema,
		targetBranch: z.string().trim().min(1).max(255),
		changeSummary: z.string().trim().min(1).max(2_000),
		title: z.string().trim().min(1).max(240),
		backendChangeApproved: z.boolean(),
		files: z.array(LandingZoneCandidateFileSchema).min(1).max(20),
	})
	.strict();
export type LandingZoneCandidate = z.infer<typeof LandingZoneCandidateSchema>;

export const LandingZoneCandidateValidationSchema = z
	.object({
		command: z.string().trim().min(1).max(1_000),
		status: z.enum(["passed", "failed", "unavailable", "skipped"]),
		required: z.boolean(),
		summary: z.string().trim().min(1).max(4_000),
	})
	.strict();
export type LandingZoneCandidateValidation = z.infer<typeof LandingZoneCandidateValidationSchema>;

export const LandingZoneReviewDecisionSchema = z.discriminatedUnion("decision", [
	z.object({ decision: z.literal("approve") }).strict(),
	z.object({ decision: z.literal("reject"), reason: z.string().trim().min(1).max(2_000) }).strict(),
	z.object({ decision: z.literal("amend"), instructions: z.string().trim().min(1).max(4_000) }).strict(),
]);
export type LandingZoneReviewDecision = z.infer<typeof LandingZoneReviewDecisionSchema>;

export const ProposedChangeReviewSchema = z
	.object({
		reviewId: z.string().uuid(),
		repository: z.string().trim().min(1),
		projectId: z.number().int().positive(),
		baseBranch: z.string().trim().min(1).max(255),
		baseSha: CommitShaSchema,
		targetBranch: z.string().trim().min(1).max(255),
		changeSummary: z.string().trim().min(1).max(2_000),
		title: z.string().trim().min(1).max(240),
		files: z
			.array(
				z
					.object({
						path: RepositoryPathSchema,
						contentSha256: ContentShaSchema,
						expectedFileSha: CommitShaSchema.nullable(),
					})
					.strict(),
			)
			.min(1)
			.max(20),
		diffSummary: z.string().trim().min(1).max(8_192),
		standardsComparison: z.array(StandardsComparisonSchema).max(100),
		validations: z.array(LandingZoneCandidateValidationSchema).min(1).max(50),
		expectedPlan: z.string().trim().min(1).max(8_192),
		stopConditions: z.array(z.string().trim().min(1).max(2_000)).max(100),
		destructiveFlags: z.array(z.string().trim().min(1).max(2_000)).max(100),
		unresolvedEvidence: z.array(z.string().trim().min(1).max(2_000)).max(100),
		riskLevel: z.enum(["low", "medium", "high", "blocked"]),
	})
	.strict();
export type ProposedChangeReview = z.infer<typeof ProposedChangeReviewSchema>;

export const LandingZoneMergeRequestSchema = z
	.object({
		iid: z.number().int().positive(),
		webUrl: z.string().url(),
		sourceSha: CommitShaSchema,
	})
	.strict();
export type LandingZoneMergeRequest = z.infer<typeof LandingZoneMergeRequestSchema>;

export const LandingZonePipelineObservationSchema = z
	.object({
		status: z.string().trim().min(1).max(200),
		summary: z.string().trim().min(1).max(8_192),
	})
	.strict();
export type LandingZonePipelineObservation = z.infer<typeof LandingZonePipelineObservationSchema>;

export const LandingZoneOutcomeSchema = z.enum(["pending", "answered", "blocked", "failed"]);
export type LandingZoneOutcome = z.infer<typeof LandingZoneOutcomeSchema>;

export const LandingZoneStateInputSchema = z
	.object({
		messages: z.array(z.unknown()),
		requestId: z.string().min(1),
		intent: LandingZoneIntentSchema,
		requestResolution: LandingZoneRequestResolutionSchema.nullable(),
		clarificationCount: z.number().int().min(0).max(2),
		repositoryScope: z.array(z.string()),
		accountScope: z.array(z.string()),
		authorizedAccountScope: z.array(z.string()),
		selectedKnowledge: z.array(z.string()),
		gitlabEvidence: EvidenceCollectionOutcomeSchema,
		okfEvidence: EvidenceCollectionOutcomeSchema,
		terraformDocsEvidence: EvidenceCollectionOutcomeSchema,
		awsDocsEvidence: EvidenceCollectionOutcomeSchema,
		awsApiEvidence: EvidenceCollectionOutcomeSchema,
		memoryEvidence: EvidenceCollectionOutcomeSchema,
		knowledgeGraphEvidence: EvidenceCollectionOutcomeSchema,
		evidenceResults: z.array(LandingZoneEvidenceResultSchema),
		priorMemory: z.array(LandingZonePriorMemorySchema),
		reconciliation: LandingZoneReconciliationSchema.nullable(),
		risk: LandingZoneRiskSchema.nullable(),
		answerResult: LandingZoneAnswerSchema.nullable(),
		answerValidation: LandingZoneAnswerValidationSchema.nullable(),
		answerRetryCount: z.number().int().min(0).max(2),
		response: z.string().nullable(),
		blockedReason: z.string().nullable(),
		outcome: LandingZoneOutcomeSchema,
		changeCandidate: LandingZoneCandidateSchema.nullable(),
		candidateValidations: z.array(LandingZoneCandidateValidationSchema),
		candidateValidationPassed: z.boolean(),
		proposedChangeReview: ProposedChangeReviewSchema.nullable(),
		reviewDecision: LandingZoneReviewDecisionSchema.nullable(),
		amendmentInstructions: z.string().nullable(),
		proposalIteration: z.number().int().min(0).max(3),
		mergeRequest: LandingZoneMergeRequestSchema.nullable(),
		pipelineObservation: LandingZonePipelineObservationSchema.nullable(),
		responseCitations: z.array(ResponseCitationSchema),
		topologyStates: z.array(TopologyEvidenceStateSchema),
	})
	.strict()
	.superRefine((state, context) => {
		const evidenceIds = new Set(state.evidenceResults.map((item) => item.id));
		for (const [citationIndex, citation] of state.responseCitations.entries()) {
			for (const [evidenceIndex, evidenceId] of citation.evidenceIds.entries()) {
				if (evidenceIds.has(evidenceId)) continue;
				context.addIssue({
					code: "custom",
					message: `unknown evidence id: ${evidenceId}`,
					path: ["responseCitations", citationIndex, "evidenceIds", evidenceIndex],
				});
			}
		}
		for (const [topologyIndex, topologyState] of state.topologyStates.entries()) {
			for (const [evidenceIndex, evidenceId] of topologyState.evidenceIds.entries()) {
				if (evidenceIds.has(evidenceId)) continue;
				context.addIssue({
					code: "custom",
					message: `unknown evidence id: ${evidenceId}`,
					path: ["topologyStates", topologyIndex, "evidenceIds", evidenceIndex],
				});
			}
		}
	});
