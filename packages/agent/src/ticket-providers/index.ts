// agent/src/ticket-providers/index.ts
import { type TicketProviderId, TicketProviderIdSchema, type TicketProviderInfo } from "@devops-agent/shared";
import { createJiraTicketProvider } from "./jira.ts";
import type { TicketProvider } from "./types.ts";

// Adding a provider = one factory entry here + widening TicketProviderIdSchema
// in @devops-agent/shared. Instances are memoized per process so provider-level
// caches (e.g. Jira project TTL cache) survive across requests.
const factories: Record<TicketProviderId, () => TicketProvider> = {
	jira: createJiraTicketProvider,
};

const instances = new Map<TicketProviderId, TicketProvider>();

export function getTicketProvider(id: string): TicketProvider | undefined {
	const parsed = TicketProviderIdSchema.safeParse(id);
	if (!parsed.success) return undefined;
	let instance = instances.get(parsed.data);
	if (!instance) {
		instance = factories[parsed.data]();
		instances.set(parsed.data, instance);
	}
	return instance;
}

export function listAvailableTicketProviders(): TicketProviderInfo[] {
	const available: TicketProviderInfo[] = [];
	for (const id of TicketProviderIdSchema.options) {
		const provider = getTicketProvider(id);
		if (provider?.isAvailable()) {
			available.push({ id: provider.id, label: provider.label });
		}
	}
	return available;
}

export function __setTicketProviderForTest(id: TicketProviderId, provider: TicketProvider | null): void {
	if (provider) {
		instances.set(id, provider);
	} else {
		instances.delete(id);
	}
}

export function __resetTicketProvidersForTest(): void {
	instances.clear();
}

export { createBridgeToolInvoker } from "./bridge-invoker.ts";
export { buildCreateIssueArgs, createJiraTicketProvider, type JiraTicketProviderOptions } from "./jira.ts";
export { type McpToolInvoker, type TicketProvider, TicketProviderError } from "./types.ts";
