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
