/**
 * Simple MCP Elicitation Helper
 * Makes direct elicitation/requestInput JSON-RPC calls
 */

export interface ElicitationSchema {
	type: "object";
	properties: Record<
		string,
		{
			type: string;
			description: string;
			enum?: string[];
			default?: unknown;
		}
	>;
	required: string[];
}

export interface ElicitationRequest {
	message: string;
	schema: ElicitationSchema;
}

/**
 * Create an MCP elicitation response that Claude Desktop will handle
 */
export function createElicitationResponse(request: ElicitationRequest) {
	return {
		method: "elicitation/requestInput",
		params: request,
	};
}

/**
 * Check if tags contain required deployment context
 */
export function extractDeploymentContext(tags?: string[]): {
	domain?: string;
	environment?: string;
	team?: string;
	missing: string[];
} {
	if (!tags || tags.length === 0) {
		return { missing: ["domain", "environment", "team"] };
	}

	const domain = tags.find((tag) => tag.startsWith("domain-"))?.replace("domain-", "");
	const environment = tags.find((tag) => tag.startsWith("env-"))?.replace("env-", "");
	const team = tags.find((tag) => tag.startsWith("team-"))?.replace("team-", "");

	const missing = [];
	if (!domain) missing.push("domain");
	if (!environment) missing.push("environment");
	if (!team) missing.push("team");

	return { domain, environment, team, missing };
}

/**
 * Generate complete 5-tag structure for Kong entities
 */
export function generateTags(
	context: { domain: string; environment: string; team: string },
	entityType: "service" | "route" | "consumer" | "plugin",
	entityName?: string,
): string[] {
	const baseTags = [`env-${context.environment}`, `domain-${context.domain}`, `team-${context.team}`];

	// Add contextual tags based on entity type
	const contextualTags = getContextualTags(entityType, entityName);

	return [...baseTags, ...contextualTags];
}

function getContextualTags(entityType: string, _entityName?: string): string[] {
	const tagMap = {
		service: ["function-api-gateway", "type-external-api"],
		route: ["function-routing", "type-external-api"],
		consumer: ["function-authentication", "access-external"],
		plugin: ["function-security", "type-middleware"],
	};

	return tagMap[entityType as keyof typeof tagMap] || ["function-unknown", "type-unknown"];
}
