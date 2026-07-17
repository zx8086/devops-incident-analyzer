// agent/src/ticket-providers/types.ts
import type {
	CreatedTicket,
	CreateTicketRequest,
	TicketAssignee,
	TicketEpic,
	TicketIssueType,
	TicketProject,
	TicketProviderId,
} from "@devops-agent/shared";

// Minimal seam between a TicketProvider and the MCP layer. The default
// implementation rides the already-connected MCP bridge (bridge-invoker.ts);
// tests inject fakes so no mock.module is needed.
export interface McpToolInvoker {
	hasTool(toolName: string): boolean;
	invoke(toolName: string, args: Record<string, unknown>): Promise<string>;
}

export interface TicketProvider {
	readonly id: TicketProviderId;
	readonly label: string;
	isAvailable(): boolean;
	listProjects(query?: string): Promise<TicketProject[]>;
	searchAssignees(query: string): Promise<TicketAssignee[]>;
	listIssueTypes(projectKey: string): Promise<TicketIssueType[]>;
	listEpics(projectKey: string): Promise<TicketEpic[]>;
	createTicket(req: CreateTicketRequest): Promise<CreatedTicket>;
	// SIO-1145: post a markdown comment onto an existing ticket. Returns the
	// created comment id (best-effort identity for logging); success-only callers
	// may ignore it.
	addComment(issueKey: string, body: string): Promise<{ id: string }>;
}

export class TicketProviderError extends Error {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "TicketProviderError";
	}
}
