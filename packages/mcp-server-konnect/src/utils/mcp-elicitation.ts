/**
 * MCP-Native Elicitation Implementation
 *
 * Based on best practices from elicitation.md - uses MCP's built-in context.elicit()
 * instead of complex enforcement layers.
 */

import { elicitationBridge } from "./elicitation-bridge.js";
import { createContextLogger } from "./mcp-logger.js";

const log = createContextLogger("elicitation");

export interface KongDeploymentContext {
	domain?: string;
	environment?: string;
	team?: string;
	[key: string]: any;
}

export interface ElicitationRequest {
	message: string;
	schema: any;
	timeout?: number;
}

/**
 * Progressive Context Gatherer using MCP's native elicitation
 */
export class MCPElicitationManager {
	private contextCache = new Map<
		string,
		{
			data: any;
			timestamp: number;
			ttl: number;
		}
	>();

	/**
	 * Gather required Kong deployment context using progressive disclosure
	 *
	 * CLAUDE DESKTOP COMPATIBILITY: First checks for completed elicitation sessions
	 * before falling back to native MCP elicitation (Claude Code)
	 */
	async gatherKongContext(
		provided: Partial<KongDeploymentContext>,
		mcpContext: any,
	): Promise<KongDeploymentContext | null> {
		const missing = this.identifyMissingContext(provided);

		if (missing.length === 0) {
			return provided as KongDeploymentContext;
		}

		// CRITICAL: Check elicitation bridge for completed sessions first (Claude Desktop)
		if (elicitationBridge.hasValidCompletedSession()) {
			const bridgeContext = elicitationBridge.getLatestCompletedContext();
			if (bridgeContext) {
				const completeContext = { ...provided, ...bridgeContext };
				log.info({ context: completeContext }, "Using context from completed elicitation session");

				// Cache the result for future use
				this.cacheContext("kong-deployment", completeContext, 3600); // 1 hour TTL
				return completeContext;
			}
		}

		// Fallback to native MCP elicitation (Claude Code)
		log.debug("No completed sessions found, attempting native MCP elicitation");

		// Phase 1: Essential information (mandatory fields)
		const essentialResult = await this.elicitEssentialContext(missing, mcpContext);
		if (!essentialResult) return null;

		const completeContext = { ...provided, ...essentialResult };

		// Phase 2: Additional context if needed (optional fields)
		if (this.shouldGatherAdditionalContext(completeContext)) {
			const additionalResult = await this.elicitAdditionalContext(completeContext, mcpContext);
			if (additionalResult) {
				Object.assign(completeContext, additionalResult);
			}
		}

		// Cache the result for future use
		this.cacheContext("kong-deployment", completeContext, 3600); // 1 hour TTL

		return completeContext;
	}

	/**
	 * Get cached context or elicit new information
	 */
	async getCachedOrElicit<T>(key: string, elicitFunc: () => Promise<T>, ttlSeconds: number = 3600): Promise<T | null> {
		const cached = this.contextCache.get(key);

		if (cached && Date.now() - cached.timestamp < cached.ttl * 1000) {
			return cached.data as T;
		}

		try {
			const data = await elicitFunc();
			this.cacheContext(key, data, ttlSeconds);
			return data;
		} catch (error) {
			log.error({ key, error }, "Elicitation failed for context key");
			return null;
		}
	}

	private identifyMissingContext(provided: Partial<KongDeploymentContext>): string[] {
		const required = ["domain", "environment", "team"];
		return required.filter((field) => !provided[field]);
	}

	private async elicitEssentialContext(
		missingFields: string[],
		mcpContext: any,
	): Promise<Partial<KongDeploymentContext> | null> {
		if (!mcpContext || !mcpContext.elicit) {
			// Fallback for environments without MCP elicitation
			log.warn("MCP elicitation not available, context required but cannot be gathered");
			return null;
		}

		const schema = this.buildEssentialSchema(missingFields);

		try {
			const result = await mcpContext.elicit({
				message: `SECURITY: Kong Deployment Context Required

Missing essential information for production-grade deployment:
${missingFields.map((field) => `• ${this.getFieldDescription(field)}`).join("\n")}

Please provide this information to proceed with deployment.`,
				schema,
				timeout: 30000, // 30 seconds
			});

			if (result.action === "accept") {
				return this.validateAndNormalizeContext(result.data);
			} else if (result.action === "decline") {
				log.warn("User declined to provide essential context");
				return null;
			} else {
				log.info("Elicitation cancelled by user");
				return null;
			}
		} catch (error) {
			log.error({ error }, "Essential context elicitation failed");
			return null;
		}
	}

	private async elicitAdditionalContext(
		baseContext: KongDeploymentContext,
		mcpContext: any,
	): Promise<Partial<KongDeploymentContext> | null> {
		const additionalSchema = {
			type: "object",
			properties: {
				description: {
					type: "string",
					description: "Optional description for this deployment",
				},
				tags: {
					type: "array",
					items: { type: "string" },
					description: "Additional tags for entities",
				},
				criticality: {
					type: "string",
					enum: ["low", "medium", "high", "critical"],
					description: "Criticality level for this deployment",
				},
			},
			additionalProperties: false,
		};

		try {
			const result = await mcpContext.elicit({
				message: `INFO: Optional Deployment Context

You're deploying to: ${baseContext.environment} environment, ${baseContext.domain} domain, ${baseContext.team} team

Would you like to provide additional context? (You can skip this step)`,
				schema: additionalSchema,
				timeout: 20000, // 20 seconds
			});

			if (result.action === "accept") {
				return result.data;
			}
		} catch (error) {
			// Additional context is optional, so failures are not critical
			log.debug(
				{ error: error instanceof Error ? error.message : String(error) },
				"Additional context elicitation skipped or failed",
			);
		}

		return null;
	}

	private buildEssentialSchema(missingFields: string[]): any {
		const properties: any = {};
		const required: string[] = [];

		missingFields.forEach((field) => {
			switch (field) {
				case "domain":
					properties.domain = {
						type: "string",
						enum: ["api", "platform", "backend", "demo", "development", "infrastructure"],
						description: "Domain classification for service organization",
					};
					required.push("domain");
					break;

				case "environment":
					properties.environment = {
						type: "string",
						enum: ["production", "staging", "development", "test"],
						description: "Target deployment environment",
					};
					required.push("environment");
					break;

				case "team":
					properties.team = {
						type: "string",
						description: "Team responsible for this service (e.g., platform, devops, api, backend)",
					};
					required.push("team");
					break;
			}
		});

		return {
			type: "object",
			properties,
			required,
			additionalProperties: false,
		};
	}

	private getFieldDescription(field: string): string {
		const descriptions = {
			domain: "Domain (api, platform, backend, etc.)",
			environment: "Environment (production, staging, development, test)",
			team: "Team ownership (platform, devops, api, etc.)",
		};
		return descriptions[field as keyof typeof descriptions] || field;
	}

	private validateAndNormalizeContext(data: any): Partial<KongDeploymentContext> {
		const normalized: Partial<KongDeploymentContext> = {};

		if (data.domain) {
			normalized.domain = data.domain.toLowerCase().trim();
		}

		if (data.environment) {
			normalized.environment = data.environment.toLowerCase().trim();
		}

		if (data.team) {
			normalized.team = data.team.toLowerCase().trim();
		}

		return normalized;
	}

	private shouldGatherAdditionalContext(context: KongDeploymentContext): boolean {
		// Gather additional context for production or high-priority deployments
		return context.environment === "production" || context.domain === "api";
	}

	private cacheContext(key: string, data: any, ttlSeconds: number): void {
		this.contextCache.set(key, {
			data,
			timestamp: Date.now(),
			ttl: ttlSeconds,
		});
	}

	/**
	 * Generate production-ready tags from context
	 */
	generateTags(context: KongDeploymentContext, entityType: string, _entityName?: string): string[] {
		const tags: string[] = [];

		// Mandatory tags (3)
		tags.push(`env-${context.environment}`);
		tags.push(`domain-${context.domain}`);
		tags.push(`team-${context.team}`);

		// Contextual tags based on entity type (2)
		switch (entityType) {
			case "service":
				tags.push("function-api-gateway");
				tags.push("type-external-api");
				break;
			case "route":
				tags.push("function-routing");
				tags.push("access-public");
				break;
			case "consumer":
				tags.push("function-authentication");
				tags.push("access-external");
				break;
			case "plugin":
				tags.push("function-security");
				tags.push("criticality-high");
				break;
			default:
				tags.push(`function-${entityType}`);
				tags.push("type-component");
		}

		// Additional tags from context
		if (context.criticality) {
			tags[tags.length - 1] = `criticality-${context.criticality}`;
		}

		return tags.slice(0, 5); // Kong's recommended limit
	}
}

/**
 * Global elicitation manager instance
 */
export const mcpElicitationManager = new MCPElicitationManager();
