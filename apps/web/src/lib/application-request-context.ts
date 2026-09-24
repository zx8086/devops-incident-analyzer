// apps/web/src/lib/application-request-context.ts

import type { DataSourceContext } from "@devops-agent/shared";
import type { AgentId } from "./agent-ids.ts";

export interface ContextualRequestFields {
	dataSources: string[];
	targetDeployments?: string[];
	uiAwsEstates?: string[];
	isFollowUp?: true;
	dataSourceContext?: DataSourceContext;
}

export function contextualRequestFields(
	agent: AgentId,
	fields: ContextualRequestFields,
): ContextualRequestFields | Record<string, never> {
	return agent === "landing-zone-terraform" ? {} : fields;
}
