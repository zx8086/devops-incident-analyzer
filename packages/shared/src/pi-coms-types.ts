// shared/src/pi-coms-types.ts
// SIO-1635: contracts for the pi-coms hub handoff (verify-with-pi / investigate-with-pi).
// The Zod schemas validate what the hub agent replies; the JSON Schema constants are
// handed to the hub as `response_schema` so the agent knows the shape to produce.
// The hub only checks JSON parseability upstream, conformance is enforced here.
import { z } from "zod";

export const PI_ACTION_TOOLS = ["verify-with-pi", "investigate-with-pi"] as const;
export type PiActionTool = (typeof PI_ACTION_TOOLS)[number];

export function isPiActionTool(tool: string): tool is PiActionTool {
	return (PI_ACTION_TOOLS as readonly string[]).includes(tool);
}

export const PiClaimStatusSchema = z.enum(["confirmed", "contradicted", "unverifiable"]);
export type PiClaimStatus = z.infer<typeof PiClaimStatusSchema>;

export const PiVerdictSchema = z.object({
	verdict: z.enum(["confirmed", "partially_confirmed", "contradicted", "unverifiable"]),
	summary: z.string(),
	claims: z.array(
		z.object({
			claim: z.string(),
			status: PiClaimStatusSchema,
			evidence: z.string(),
		}),
	),
	additional_observations: z.array(z.string()).optional(),
	recommended_investigation: z.string().nullable().optional(),
});
export type PiVerdict = z.infer<typeof PiVerdictSchema>;

export const PiInvestigationSchema = z.object({
	summary: z.string(),
	root_cause_hypothesis: z.string(),
	evidence: z.array(z.object({ resource: z.string(), observation: z.string() })),
	suggested_actions: z.array(z.string()),
	confidence: z.number().min(0).max(1),
});
export type PiInvestigation = z.infer<typeof PiInvestigationSchema>;

// SIO-1830: the spoke's NATIVE reply shape. A spoke persona is built around "diagnoses"
// (the monitor's finding vocabulary), and on 2026-09-20 an eu-oit-prd spoke answered an
// investigate request in that shape even though the analyzer had injected
// PI_INVESTIGATION_RESPONSE_SCHEMA into its turn content. Both schemas rejected it and a
// correct, well-evidenced diagnosis was silently discarded.
//
// The schema nudge is already in place (pi-coms/extensions/coms-net.ts puts it in the
// turn text, noting "both account agents guessed the same wrong shape"), so it has failed
// in production at least once. This adapter makes the READER tolerant rather than relying
// on the writer complying: an answer the operator can use must not be lost to a dialect.
//
// Deliberately a SEPARATE schema, not a loosening of PiInvestigationSchema: a genuinely
// malformed reply must still fail.
export const PiDiagnosesReplySchema = z.object({
	diagnoses: z
		.array(
			z.object({
				probable_cause: z.string(),
				affected_resources: z.array(z.string()).optional(),
				suggested_action: z.string().optional(),
				evidence: z.array(z.object({ command: z.string().optional(), observation: z.string() })).optional(),
				confidence: z.number().min(0).max(1).optional(),
			}),
		)
		.min(1),
});

// Folds the diagnoses envelope into the investigation shape the rest of the pipeline reads.
// Field mapping, from the live payload:
//   probable_cause    -> summary AND root_cause_hypothesis (the spoke writes one prose field)
//   evidence[].command -> resource  (the spoke records the COMMAND it ran, not a resource arn;
//                                    affected_resources carries the arns, so they are prepended
//                                    as their own evidence lines rather than being lost)
//   suggested_action  -> suggested_actions[]  (singular string -> array)
//   confidence        -> confidence, defaulting to 0.5 when the spoke omits it: absent
//                        confidence must not read as certainty.
export function investigationFromDiagnoses(reply: z.infer<typeof PiDiagnosesReplySchema>): PiInvestigation {
	const [first] = reply.diagnoses;
	if (!first) throw new Error("PiDiagnosesReplySchema guarantees at least one diagnosis");
	// The producer sends one entry per dedup_key and the monitor asks for exactly that
	// (coms-net-monitor.ts:505), so a multi-diagnosis reply is normal, not an edge case.
	// Reading only [0] silently dropped every later cause, its evidence and its action.
	const evidence = reply.diagnoses.flatMap((d) => [
		...(d.affected_resources ?? []).map((resource) => ({ resource, observation: "named as an affected resource" })),
		...(d.evidence ?? []).map((e) => ({ resource: e.command ?? "(command not recorded)", observation: e.observation })),
	]);
	// Confidence is the WEAKEST of the causes, not the first one's: the investigation is only
	// as good as its shakiest constituent, and averaging would let one certain cause mask a guess.
	const confidence = Math.min(...reply.diagnoses.map((d) => d.confidence ?? 0.5));
	return {
		summary:
			reply.diagnoses.length === 1
				? first.probable_cause
				: `${reply.diagnoses.length} causes reported: ${reply.diagnoses.map((d) => d.probable_cause).join(" | ")}`,
		root_cause_hypothesis: reply.diagnoses.map((d) => d.probable_cause).join("\n\n"),
		evidence,
		suggested_actions: reply.diagnoses.flatMap((d) => (d.suggested_action ? [d.suggested_action] : [])),
		confidence,
	};
}

export const PI_VERDICT_RESPONSE_SCHEMA = {
	type: "object",
	required: ["verdict", "summary", "claims"],
	properties: {
		verdict: { type: "string", enum: ["confirmed", "partially_confirmed", "contradicted", "unverifiable"] },
		summary: { type: "string" },
		claims: {
			type: "array",
			items: {
				type: "object",
				required: ["claim", "status", "evidence"],
				properties: {
					claim: { type: "string" },
					status: { type: "string", enum: ["confirmed", "contradicted", "unverifiable"] },
					evidence: { type: "string" },
				},
			},
		},
		additional_observations: { type: "array", items: { type: "string" } },
		recommended_investigation: { type: ["string", "null"] },
	},
} as const;

export const PI_INVESTIGATION_RESPONSE_SCHEMA = {
	type: "object",
	required: ["summary", "root_cause_hypothesis", "evidence", "suggested_actions", "confidence"],
	properties: {
		summary: { type: "string" },
		root_cause_hypothesis: { type: "string" },
		evidence: {
			type: "array",
			items: {
				type: "object",
				required: ["resource", "observation"],
				properties: { resource: { type: "string" }, observation: { type: "string" } },
			},
		},
		suggested_actions: { type: "array", items: { type: "string" } },
		confidence: { type: "number", minimum: 0, maximum: 1 },
	},
} as const;

// Result payloads the executor puts in ActionResult.result so the card can render
// them without re-parsing the raw hub reply.
export const PiVerifyResultSchema = z.object({
	kind: z.literal("verdict"),
	target: z.string(),
	estate: z.string(),
	msg_id: z.string(),
	verdict: PiVerdictSchema,
});
export type PiVerifyResult = z.infer<typeof PiVerifyResultSchema>;

export const PiInvestigateResultSchema = z.object({
	kind: z.literal("investigation"),
	target: z.string(),
	estate: z.string(),
	msg_id: z.string(),
	investigation: PiInvestigationSchema,
});
export type PiInvestigateResult = z.infer<typeof PiInvestigateResultSchema>;

// The estate agent was offline and the send was parked in the hub mailbox.
export const PiQueuedResultSchema = z.object({
	kind: z.literal("queued"),
	target: z.string(),
	estate: z.string(),
	msg_id: z.string(),
});
export type PiQueuedResult = z.infer<typeof PiQueuedResultSchema>;

export const PiActionResultPayloadSchema = z.discriminatedUnion("kind", [
	PiVerifyResultSchema,
	PiInvestigateResultSchema,
	PiQueuedResultSchema,
]);
export type PiActionResultPayload = z.infer<typeof PiActionResultPayloadSchema>;

// SIO-1652: fleet inbox digest written by the fetchFleetInbox node. Structured
// facts (kind, severity, counts, alarm names, timestamps) feed the aggregator
// prompt and the card; `excerpt` is display-only untrusted text (spoke model
// output or operator free text), capped, and never enters a prompt.
// SIO-1825: `daily-digest` and `suppression-review` are the monitor's other two
// message kinds. They used to parse as nothing and be dropped, so the inbox read
// empty on accounts the monitor reports on every day. `monitor-report` keeps its
// meaning -- an INCIDENT report, the only kind carrying a fresh finding count.
export const FleetInboxKindSchema = z.enum([
	"monitor-report",
	"daily-digest",
	"suppression-review",
	"conversation",
	"other",
]);
export type FleetInboxKind = z.infer<typeof FleetInboxKindSchema>;

// The monitor's own kinds, kept by buildEstateDigest. Everything else is a spoke
// conversation or an operator note and stays out of the digest.
export const MONITOR_INBOX_KINDS = [
	"monitor-report",
	"daily-digest",
	"suppression-review",
] as const satisfies readonly FleetInboxKind[];

export const FleetInboxSeveritySchema = z.enum(["info", "warn", "critical"]);
export type FleetInboxSeverity = z.infer<typeof FleetInboxSeveritySchema>;

// SIO-1815: one finding of a monitor report, as structured facts. `family` is the
// monitor's own category (alarm, logs, health, drift, tasks, ...) and stays a string, not
// an enum: the monitor ships in the fleet bundle on its own cadence (SIO-1814), so a
// reader pinned to today's families would drop a newer monitor's findings. `resource` is
// an AWS identifier (alarm name, log group, security group id). The finding's summary
// and the spoke's diagnosis are free text and are deliberately NOT carried.
export const FleetInboxFindingSchema = z.object({
	severity: FleetInboxSeveritySchema,
	family: z.string(),
	resource: z.string(),
	focus: z.boolean().describe("Whether this finding names one of the incident's focus services"),
});
export type FleetInboxFinding = z.infer<typeof FleetInboxFindingSchema>;

export const FleetInboxFamilyCountSchema = z.object({
	family: z.string(),
	count: z.number().int().nonnegative(),
	focus: z.number().int().nonnegative(),
});
export type FleetInboxFamilyCount = z.infer<typeof FleetInboxFamilyCountSchema>;

export const FleetInboxEntrySchema = z.object({
	msgId: z.string(),
	inbox: z.string(),
	sender: z.string(),
	target: z.string().nullable(),
	kind: FleetInboxKindSchema,
	severity: FleetInboxSeveritySchema.nullable(),
	findingCount: z.number().int().nonnegative().nullable(),
	alarmNames: z.array(z.string()),
	findings: z.array(FleetInboxFindingSchema),
	focus: z.boolean().describe("Whether any finding in this report names a focus service"),
	createdAt: z.string(),
	completedAt: z.string().nullable(),
	excerpt: z.string(),
});
export type FleetInboxEntry = z.infer<typeof FleetInboxEntrySchema>;

export const FleetInboxCountsSchema = z.object({
	// Every monitor message kept for this estate, across all three monitor kinds.
	total: z.number().int().nonnegative(),
	focus: z.number().int().nonnegative().describe("Reports naming a focus service"),
	critical: z.number().int().nonnegative(),
	warn: z.number().int().nonnegative(),
	// SIO-1825: per-kind, so a reader is never told "3 monitor report(s)" when the
	// estate had one incident report and two daily digests. They answer different
	// questions: an incident report is a fresh finding, a digest is a 24 h rollup
	// and the monitor's dead-man signal.
	incidentReports: z.number().int().nonnegative(),
	dailyDigests: z.number().int().nonnegative(),
	suppressionReviews: z.number().int().nonnegative(),
});
export type FleetInboxCounts = z.infer<typeof FleetInboxCountsSchema>;

export const FleetInboxEstateSchema = z.object({
	estate: z.string(),
	environment: z.enum(["dev", "stg", "prd"]),
	inboxes: z.array(z.string()),
	entries: z.array(FleetInboxEntrySchema),
	counts: FleetInboxCountsSchema,
	families: z.array(FleetInboxFamilyCountSchema),
	alarmNames: z.array(z.string()),
	latestAt: z.string().nullable(),
	error: z.string().nullable(),
});
export type FleetInboxEstate = z.infer<typeof FleetInboxEstateSchema>;

export const FleetInboxDigestSchema = z.object({
	windowFrom: z.string(),
	windowTo: z.string(),
	generatedAt: z.string(),
	focusServices: z.array(z.string()).describe("What the digest was scoped to; empty = unscoped"),
	estates: z.array(FleetInboxEstateSchema),
});
export type FleetInboxDigest = z.infer<typeof FleetInboxDigestSchema>;
