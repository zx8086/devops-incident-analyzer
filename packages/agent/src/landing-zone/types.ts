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
	TopologyEvidenceStateSchema,
} from "@devops-agent/shared";
import { z } from "zod";

export const LandingZoneIntentSchema = z.enum(["learn", "understand", "review", "propose-change"]);
export type LandingZoneIntent = z.infer<typeof LandingZoneIntentSchema>;

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
		gitlabEvidence: EvidenceCollectionOutcomeSchema,
		okfEvidence: EvidenceCollectionOutcomeSchema,
		terraformDocsEvidence: EvidenceCollectionOutcomeSchema,
		awsDocsEvidence: EvidenceCollectionOutcomeSchema,
		awsApiEvidence: EvidenceCollectionOutcomeSchema,
		memoryEvidence: EvidenceCollectionOutcomeSchema,
		knowledgeGraphEvidence: EvidenceCollectionOutcomeSchema,
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
