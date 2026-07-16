// shared/src/ticket-types.ts
import { z } from "zod";

export const TicketProviderIdSchema = z.enum(["jira"]);
export type TicketProviderId = z.infer<typeof TicketProviderIdSchema>;

export const TicketProviderInfoSchema = z.object({
	id: TicketProviderIdSchema,
	label: z.string(),
});
export type TicketProviderInfo = z.infer<typeof TicketProviderInfoSchema>;

export const TicketProjectSchema = z.object({
	id: z.string(),
	key: z.string(),
	name: z.string(),
});
export type TicketProject = z.infer<typeof TicketProjectSchema>;

export const TicketAssigneeSchema = z.object({
	id: z.string().describe("Provider-native user id (Jira: accountId)"),
	displayName: z.string(),
});
export type TicketAssignee = z.infer<typeof TicketAssigneeSchema>;

export const TicketIssueTypeSchema = z.object({
	id: z.string(),
	name: z.string(),
});
export type TicketIssueType = z.infer<typeof TicketIssueTypeSchema>;

export const TicketEpicSchema = z.object({
	key: z.string(),
	summary: z.string(),
});
export type TicketEpic = z.infer<typeof TicketEpicSchema>;

export const CreateTicketRequestSchema = z.object({
	projectKey: z.string().min(1),
	issueTypeName: z.string().min(1),
	summary: z.string().min(1).max(255),
	description: z.string().max(32_000),
	assigneeId: z.string().min(1).nullable().describe("Provider-native user id; null creates the ticket unassigned"),
	epicKey: z.string().min(1).nullable().describe("Parent epic key; null creates the ticket without an epic"),
	// SIO-1134: the investigation turn this report came from. When present, a
	// successful creation links the KG Incident to the returned ticket key --
	// the human curation signal that marks this run as the canonical record.
	requestId: z.string().min(1).optional(),
});
export type CreateTicketRequest = z.infer<typeof CreateTicketRequestSchema>;

export const CreatedTicketSchema = z.object({
	key: z.string(),
	url: z.string().optional(),
});
export type CreatedTicket = z.infer<typeof CreatedTicketSchema>;
