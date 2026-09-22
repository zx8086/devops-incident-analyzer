// packages/shared/src/landing-zone-types.ts

import { z } from "zod";

const IdentifierSchema = z.string().trim().min(1).max(512);
const SummarySchema = z.string().trim().min(1).max(8_192);
const TimestampSchema = z.iso.datetime({ offset: true });

export const EvidenceSourceSchema = z.enum([
	"pvh-okf",
	"gitlab",
	"terraform-docs",
	"aws-docs",
	"aws-api",
	"memory",
	"knowledge-graph",
]);
export type EvidenceSource = z.infer<typeof EvidenceSourceSchema>;

export const EvidenceStatusSchema = z.enum(["observed", "inferred", "proposed", "unverified"]);
export type EvidenceStatus = z.infer<typeof EvidenceStatusSchema>;

export const AlignmentSchema = z.enum(["aligned", "divergent", "exception", "unresolved", "unverified"]);
export type Alignment = z.infer<typeof AlignmentSchema>;

export const ReconciliationStatusSchema = z.enum(["aligned", "drifted", "pending", "unknown", "conflicting-evidence"]);
export type ReconciliationStatus = z.infer<typeof ReconciliationStatusSchema>;

export const TopologyStateSchema = z.enum(["desired", "observed", "proposed", "unverified"]);
export type TopologyState = z.infer<typeof TopologyStateSchema>;

export const FreshnessStatusSchema = z.enum(["current", "stale", "unknown"]);
export type FreshnessStatus = z.infer<typeof FreshnessStatusSchema>;

export const EvidenceFreshnessSchema = z
	.object({
		status: FreshnessStatusSchema,
		sourceUpdatedAt: TimestampSchema.optional(),
		staleAfter: TimestampSchema.optional(),
	})
	.strict();
export type EvidenceFreshness = z.infer<typeof EvidenceFreshnessSchema>;

export const EvidenceProvenanceSchema = z
	.object({
		url: z.url().max(2_048).optional(),
		repository: IdentifierSchema.optional(),
		commitSha: z
			.string()
			.regex(/^[0-9a-f]{7,64}$/i)
			.optional(),
		path: z.string().trim().min(1).max(2_048).optional(),
		awsResourceId: IdentifierSchema.optional(),
		memoryBlockId: IdentifierSchema.optional(),
		graphEntityId: IdentifierSchema.optional(),
		terraformAddress: IdentifierSchema.optional(),
	})
	.strict()
	.refine((value) => Object.values(value).some((locator) => locator !== undefined), {
		message: "at least one provenance locator is required",
	});
export type EvidenceProvenance = z.infer<typeof EvidenceProvenanceSchema>;

export const EvidenceItemSchema = z
	.object({
		id: IdentifierSchema,
		claimKey: IdentifierSchema,
		claimValue: SummarySchema.optional(),
		source: EvidenceSourceSchema,
		retrievedAt: TimestampSchema,
		status: EvidenceStatusSchema,
		summary: SummarySchema,
		provenance: EvidenceProvenanceSchema,
		freshness: EvidenceFreshnessSchema,
		confidence: z.number().min(0).max(1).optional(),
	})
	.strict();
export type EvidenceItem = z.infer<typeof EvidenceItemSchema>;

export const ComparisonActionSchema = z.enum(["explain", "monitor", "propose", "escalate"]);
export type ComparisonAction = z.infer<typeof ComparisonActionSchema>;

export const StandardsComparisonSchema = z
	.object({
		claim: SummarySchema,
		pvhStandard: EvidenceItemSchema.optional(),
		liveImplementation: EvidenceItemSchema.optional(),
		terraformContract: EvidenceItemSchema.optional(),
		awsRecommendation: EvidenceItemSchema.optional(),
		alignment: AlignmentSchema,
		action: ComparisonActionSchema,
	})
	.strict();
export type StandardsComparison = z.infer<typeof StandardsComparisonSchema>;

export const EvidenceReconciliationSchema = z
	.object({
		status: ReconciliationStatusSchema,
		conclusion: SummarySchema,
		comparisons: z.array(StandardsComparisonSchema).max(100),
		conflicts: z.array(SummarySchema).max(100),
		unavailableSources: z.array(EvidenceSourceSchema).max(EvidenceSourceSchema.options.length),
	})
	.strict();
export type EvidenceReconciliation = z.infer<typeof EvidenceReconciliationSchema>;

export const RiskLevelSchema = z.enum(["low", "medium", "high", "blocked"]);
export type RiskLevel = z.infer<typeof RiskLevelSchema>;

export const LandingZoneRiskAssessmentSchema = z
	.object({
		level: RiskLevelSchema,
		reasons: z.array(SummarySchema).max(100),
		requiresHumanDecision: z.boolean(),
		blocked: z.boolean(),
		stopConditions: z.array(SummarySchema).max(100),
		requiredEvidenceSources: z.array(EvidenceSourceSchema).max(EvidenceSourceSchema.options.length),
	})
	.strict()
	.refine((value) => value.blocked === (value.level === "blocked"), {
		message: "blocked risk level and blocked flag must agree",
	});
export type LandingZoneRiskAssessment = z.infer<typeof LandingZoneRiskAssessmentSchema>;

export const ResponseCitationSchema = z
	.object({
		id: IdentifierSchema,
		claim: SummarySchema,
		evidenceIds: z.array(IdentifierSchema).min(1).max(25),
	})
	.strict();
export type ResponseCitation = z.infer<typeof ResponseCitationSchema>;

export const TopologyEvidenceStateSchema = z
	.object({
		resourceKey: IdentifierSchema,
		state: TopologyStateSchema,
		reconciliationStatus: ReconciliationStatusSchema,
		evidenceIds: z.array(IdentifierSchema).min(1).max(25),
	})
	.strict();
export type TopologyEvidenceState = z.infer<typeof TopologyEvidenceStateSchema>;
