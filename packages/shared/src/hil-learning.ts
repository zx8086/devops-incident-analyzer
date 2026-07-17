// packages/shared/src/hil-learning.ts
//
// SIO-1126: the structured LearningProposal the HIL learning distiller emits
// ("learn from TICKET-123"). Lives in shared because both the agent (produces,
// validates) and the web app (renders the review card, resumes with per-item
// decisions) consume the shape. Every item carries a stable id (per-item
// approve/reject) and 1-3 verbatim evidence quotes from the ticket so nothing
// ungrounded survives into the knowledge graph. The four-class shape is the
// stable contract across phases: Phase 1 (SIO-1126) applies rootCause +
// memoryFacts; Phase 2 (SIO-1127) activates bindings + heuristics.

import { z } from "zod";

const LearningItemBase = z.object({
	id: z.string().min(1).describe("Stable item id for per-item approve/reject, e.g. rc-1, fact-2"),
	evidence: z
		.array(z.string().min(1))
		.min(1)
		.max(3)
		.describe("Verbatim quotes from the ticket comments grounding this item"),
});

export const RootCauseCorrectionSchema = LearningItemBase.extend({
	kind: z.literal("root-cause"),
	causeClass: z
		.string()
		.regex(/^[a-z0-9-]{4,64}$/)
		.describe("Kebab-case cause class, e.g. route53-resolver-rule-vpc-association-missing"),
	description: z.string().min(1).describe("What actually caused the incident, per the human resolution"),
	resolution: z.string().min(1).describe("What fixed it (or the agreed fix)"),
	invalidatedHypotheses: z
		.array(z.object({ hypothesis: z.string().min(1), reason: z.string().min(1) }))
		.max(5)
		.describe("Agent hypotheses the human resolution ruled out, with why"),
	runbookFilename: z
		.string()
		.regex(/^[a-z0-9-]+\.md$/)
		.optional()
		.describe("Existing runbook catalog filename that covers the fix; omit when none applies"),
});
export type RootCauseCorrection = z.infer<typeof RootCauseCorrectionSchema>;

export const BindingCorrectionSchema = LearningItemBase.extend({
	kind: z.literal("binding"),
	action: z.enum(["confirm", "invalidate"]),
	service: z.string().min(1),
	datasource: z.enum(["elastic", "aws", "kafka", "couchbase", "konnect", "gitlab", "atlassian"]),
	bindingKind: z
		.string()
		.min(1)
		.describe("Telemetry binding kind; re-validated against BindingKindSchema at write time"),
	resourceId: z.string().min(1).describe("Must appear literally in the ticket text"),
	locator: z.string().optional(),
	reason: z.string().min(1),
});
export type BindingCorrection = z.infer<typeof BindingCorrectionSchema>;

export const HeuristicSchema = LearningItemBase.extend({
	kind: z.literal("heuristic"),
	name: z
		.string()
		.regex(/^[a-z0-9-]+$/)
		.describe("Kebab-case skill-proposal name"),
	description: z.string().min(1),
	whenToUse: z.string().min(1),
	procedure: z.string().min(1),
});
export type Heuristic = z.infer<typeof HeuristicSchema>;

export const MemoryFactSchema = LearningItemBase.extend({
	kind: z.literal("memory-fact"),
	text: z.string().min(1).describe("A durable, self-contained fact for future recall"),
});
export type MemoryFact = z.infer<typeof MemoryFactSchema>;

export const LearningProposalSchema = z.object({
	ticketKey: z.string().min(1),
	rootCause: RootCauseCorrectionSchema.nullable(),
	bindings: z.array(BindingCorrectionSchema).max(10),
	heuristics: z.array(HeuristicSchema).max(3),
	memoryFacts: z.array(MemoryFactSchema).max(8),
});
export type LearningProposal = z.infer<typeof LearningProposalSchema>;

export type HilDecision = "approve" | "reject";
export type HilDecisions = Record<string, HilDecision>;

// SIO-1128: per-item text edits from the review card, keyed by item id -> field -> new
// value. Only invariant-free PROSE fields are editable (see HIL_EDITABLE_FIELDS); grounded
// or structured fields (resourceId, causeClass, bindingKind, datasource, heuristic name,
// runbookFilename, evidence) stay read-only, so an edit can never break resourceId
// grounding or a kebab-case regex. Kept separate from HilDecisions (approve/reject).
export const HIL_EDITABLE_FIELDS = {
	rootCause: ["description", "resolution"],
	binding: ["reason"],
	heuristic: ["description", "whenToUse", "procedure"],
	memoryFact: ["text"],
} as const;

export type HilItemEdits = Record<string, Record<string, string>>;

export const HilItemEditsSchema: z.ZodType<HilItemEdits> = z.record(z.string(), z.record(z.string(), z.string()));

// SIO-1146: per-item outcome row for the terminal learning card. `status` reflects
// what applyLearnings actually did -- a rejected decision wins over any skip entry,
// and "skipped" REQUIRES the real write-time reason (dedup, disabled flag, soft
// failure) that the client cannot reconstruct from the review prompt; the
// discriminated union pins that contract at the boundary (CodeRabbit PR #412).
const HilApplyItemBase = z.object({
	id: z.string().min(1),
	kind: z.enum(["root-cause", "binding", "heuristic", "memory-fact"]),
	label: z.string(),
});
export const HilApplyItemSchema = z.discriminatedUnion("status", [
	// applied may still carry a supplementary note (e.g. draft-runbook PR outcome).
	HilApplyItemBase.extend({ status: z.literal("applied"), reason: z.string().optional() }),
	HilApplyItemBase.extend({ status: z.literal("rejected"), reason: z.string().optional() }),
	HilApplyItemBase.extend({ status: z.literal("skipped"), reason: z.string() }),
]);
export type HilApplyItem = z.infer<typeof HilApplyItemSchema>;

// SIO-1146: the structured apply outcome, streamed as hil_learning_applied so the
// UI can render a terminal outcome card instead of only the prose summary bubble.
// `skipped` keeps the report-level entries (curation/graph/facts) that
// buildApplySummary renders; rows whose id matches no item become card footnotes.
export const HilApplyReportSchema = z.object({
	ticketKey: z.string().min(1),
	incidentId: z.string(),
	incidentCreated: z.boolean(),
	rootCauseWritten: z.boolean(),
	curated: z.boolean().optional(),
	runbookLinked: z.string().optional(),
	factsWritten: z.number(),
	bindingsConfirmed: z.number(),
	bindingsInvalidated: z.number(),
	heuristicsProposed: z.number(),
	draftRunbookUrl: z.string().optional(),
	skipped: z.array(z.object({ id: z.string(), reason: z.string() })),
	items: z.array(HilApplyItemSchema),
});
export type HilApplyReport = z.infer<typeof HilApplyReportSchema>;

// The match-gate candidate surfaced to the UI. `via` distinguishes vector KNN
// hits from the deterministic ticket-mention pin.
export const HilMatchCandidateSchema = z.object({
	id: z.string(),
	summary: z.string(),
	severity: z.string(),
	distance: z.number(),
	hasRootCause: z.boolean(),
	// SIO-1134: "ticket-link" = exact curated linkage (Incident.ticketKey), the
	// strongest signal; "ticket-mention" = key found in the stored summary.
	// SIO-1133: "request-id" = the report's stamped Request-Id (== KG node id) found
	// in the ticket text -- authoritative, resolves without embeddings.
	via: z.enum(["vector", "ticket-mention", "ticket-link", "request-id"]),
});
export type HilMatchCandidate = z.infer<typeof HilMatchCandidateSchema>;
