// apps/web/src/lib/pi-fleet-types.ts
// SIO-1650: response contracts of the /api/pi/* routes. Browser-safe (zod only):
// the pane store parses these, the server module produces them.
import { z } from "zod";

export const PiFleetEnvironmentSchema = z.enum(["dev", "stg", "prd"]);
export type PiFleetEnvironment = z.infer<typeof PiFleetEnvironmentSchema>;

export const PiFleetPeerSchema = z.object({
	name: z.string(),
	status: z.enum(["online", "stale", "offline"]),
	purpose: z.string().nullable(),
	sessionId: z.string(),
});
export type PiFleetPeer = z.infer<typeof PiFleetPeerSchema>;

export const PiFleetHubSchema = z.object({
	environment: PiFleetEnvironmentSchema,
	project: z.string(),
	fallbackTarget: z.string(),
	peers: z.array(PiFleetPeerSchema),
	// A hub that could not be listed keeps its row with the reason; the other hubs still list.
	error: z.string().nullable(),
});
export type PiFleetHub = z.infer<typeof PiFleetHubSchema>;

export const PiFleetAgentsResponseSchema = z.object({
	configured: z.boolean(),
	senderPrefix: z.string(),
	// One await slice per HTTP request; the browser re-polls until totalBudgetMs is spent.
	awaitMs: z.number().int().positive(),
	totalBudgetMs: z.number().int().positive(),
	hubs: z.array(PiFleetHubSchema),
});
export type PiFleetAgentsResponse = z.infer<typeof PiFleetAgentsResponseSchema>;

export const PiFleetMessageStatusSchema = z.enum([
	"queued",
	"delivered",
	"complete",
	"error",
	"timeout",
	"budget_exhausted",
]);
export type PiFleetMessageStatus = z.infer<typeof PiFleetMessageStatusSchema>;

export const PiFleetMessageStatusResponseSchema = z.object({
	environment: PiFleetEnvironmentSchema,
	msgId: z.string(),
	status: PiFleetMessageStatusSchema,
	// The spoke's reply as the hub stored it: rendered as data, never executed or prompted.
	response: z.unknown(),
	error: z.string().nullable(),
});
export type PiFleetMessageStatusResponse = z.infer<typeof PiFleetMessageStatusResponseSchema>;

export const PiFleetMessageResponseSchema = PiFleetMessageStatusResponseSchema.extend({
	target: z.string(),
	sender: z.string(),
	sentAt: z.string(),
});
export type PiFleetMessageResponse = z.infer<typeof PiFleetMessageResponseSchema>;

export const PiFleetInboxMessageSchema = z.object({
	msgId: z.string(),
	senderName: z.string(),
	targetName: z.string().nullable(),
	prompt: z.string(),
	status: z.string(),
	error: z.string().nullable(),
	response: z.unknown(),
	createdAt: z.string(),
	completedAt: z.string().nullable(),
});
export type PiFleetInboxMessage = z.infer<typeof PiFleetInboxMessageSchema>;

export const PiFleetMailboxResponseSchema = z.object({
	environment: PiFleetEnvironmentSchema,
	name: z.string(),
	messages: z.array(PiFleetInboxMessageSchema),
});
export type PiFleetMailboxResponse = z.infer<typeof PiFleetMailboxResponseSchema>;
