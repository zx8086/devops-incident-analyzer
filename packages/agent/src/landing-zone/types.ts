// packages/agent/src/landing-zone/types.ts

import { z } from "zod";

export const LandingZoneIntentSchema = z.enum(["learn", "understand", "review", "propose-change"]);
export type LandingZoneIntent = z.infer<typeof LandingZoneIntentSchema>;

export const LandingZoneEvidenceResultSchema = z.object({
	source: z.enum(["repository", "gitlab", "aws", "terraform", "knowledge", "memory", "graph"]),
	status: z.enum(["observed", "degraded", "unavailable"]),
	summary: z.string(),
	repository: z.string().nullable(),
	citations: z.array(z.string()),
	observedAt: z.string().datetime().nullable(),
});
export type LandingZoneEvidenceResult = z.infer<typeof LandingZoneEvidenceResultSchema>;

export const LandingZoneReconciliationSchema = z.object({
	conclusion: z.string(),
	classification: z.enum(["Observed", "Inferred", "Proposed", "Unverified"]),
	conflicts: z.array(z.string()),
	degradedSources: z.array(z.string()),
});
export type LandingZoneReconciliation = z.infer<typeof LandingZoneReconciliationSchema>;

export const LandingZoneRiskSchema = z.object({
	level: z.enum(["low", "medium", "high", "blocked"]),
	reasons: z.array(z.string()),
	requiresHumanDecision: z.boolean(),
});
export type LandingZoneRisk = z.infer<typeof LandingZoneRiskSchema>;

export const ProposedChangeReviewSchema = z.object({
	repositories: z.array(z.string()),
	orderedSteps: z.array(z.string()),
	validationCommands: z.array(z.string()),
	missingAuthoritativeInputs: z.array(z.string()),
});
export type ProposedChangeReview = z.infer<typeof ProposedChangeReviewSchema>;

export const LandingZoneOutcomeSchema = z.enum(["pending", "answered", "blocked", "failed"]);
export type LandingZoneOutcome = z.infer<typeof LandingZoneOutcomeSchema>;

export const LandingZoneStateInputSchema = z.object({
	messages: z.array(z.unknown()),
	requestId: z.string().min(1),
	intent: LandingZoneIntentSchema,
	repositoryScope: z.array(z.string()),
	accountScope: z.array(z.string()),
	selectedKnowledge: z.array(z.string()),
	evidenceResults: z.array(LandingZoneEvidenceResultSchema),
	reconciliation: LandingZoneReconciliationSchema.nullable(),
	risk: LandingZoneRiskSchema.nullable(),
	response: z.string().nullable(),
	blockedReason: z.string().nullable(),
	outcome: LandingZoneOutcomeSchema,
	proposedChangeReview: ProposedChangeReviewSchema.nullable(),
});
