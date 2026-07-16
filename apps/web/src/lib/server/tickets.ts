// apps/web/src/lib/server/tickets.ts
import { getTicketProvider, type TicketProvider } from "@devops-agent/agent";
import { ensureMcpConnected } from "$lib/server/agent";

// Shared resolver for the /api/tickets/[provider] routes: unknown ids and
// providers whose backing MCP tool surface is missing (read-only or
// disconnected server) both read as "not there" -> the routes 404.
export async function resolveAvailableTicketProvider(id: string): Promise<TicketProvider | undefined> {
	await ensureMcpConnected();
	const provider = getTicketProvider(id);
	return provider?.isAvailable() ? provider : undefined;
}
