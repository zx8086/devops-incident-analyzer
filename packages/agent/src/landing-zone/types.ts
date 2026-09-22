// packages/agent/src/landing-zone/types.ts

import {
	type EvidenceItem,
	EvidenceItemSchema,
	type EvidenceReconciliation,
	EvidenceReconciliationSchema,
	type LandingZoneRiskAssessment,
	LandingZoneRiskAssessmentSchema,
	ResponseCitationSchema,
	TopologyEvidenceStateSchema,
} from "@devops-agent/shared";
import { z } from "zod";

export const LandingZoneIntentSchema = z.enum(["learn", "understand", "review", "propose-change"]);
export type LandingZoneIntent = z.infer<typeof LandingZoneIntentSchema>;

export const LandingZoneEvidenceResultSchema = EvidenceItemSchema;
export type LandingZoneEvidenceResult = EvidenceItem;

export const LandingZoneReconciliationSchema = EvidenceReconciliationSchema;
export type LandingZoneReconciliation = EvidenceReconciliation;

export const LandingZoneRiskSchema = LandingZoneRiskAssessmentSchema;
export type LandingZoneRisk = LandingZoneRiskAssessment;

export const ProposedChangeReviewSchema = z
	.object({
		repositories: z.array(z.string()),
		orderedSteps: z.array(z.string()),
		validationCommands: z.array(z.string()),
		missingAuthoritativeInputs: z.array(z.string()),
	})
	.strict();
export type ProposedChangeReview = z.infer<typeof ProposedChangeReviewSchema>;

export const LandingZoneOutcomeSchema = z.enum(["pending", "answered", "blocked", "failed"]);
export type LandingZoneOutcome = z.infer<typeof LandingZoneOutcomeSchema>;

export const LandingZoneStateInputSchema = z
	.object({
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
		responseCitations: z.array(ResponseCitationSchema),
		topologyStates: z.array(TopologyEvidenceStateSchema),
	})
	.strict();
