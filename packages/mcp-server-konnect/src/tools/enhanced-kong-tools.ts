/**
 * Enhanced Kong Tools with Native MCP Elicitation
 *
 * Uses MCP's built-in context.elicit() for progressive context gathering
 * following best practices from elicitation.md
 */

import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { KongApi } from "../api/kong-api.js";
import { elicitationBridge } from "../utils/elicitation-bridge.js";
import { type KongDeploymentContext, mcpElicitationManager } from "../utils/mcp-elicitation.js";
import * as configOps from "./configuration/operations.js";

/**
 * Enhanced Create Service with Native MCP Elicitation
 */
export async function createServiceWithElicitation(
	api: KongApi,
	args: any,
	extra: RequestHandlerExtra<any, any>,
): Promise<any> {
	try {
		// Step 1: Extract any provided context from tags
		const providedContext: Partial<KongDeploymentContext> = {
			domain: extractFromTags(args.tags, "domain"),
			environment: extractFromTags(args.tags, "env"),
			team: extractFromTags(args.tags, "team"),
		};

		// Step 2: Check what context is missing
		const missing = [];
		if (!providedContext.domain) missing.push("domain");
		if (!providedContext.environment) missing.push("environment");
		if (!providedContext.team) missing.push("team");

		const completeContext = { ...providedContext } as KongDeploymentContext;

		// Step 3: Use proper MCP elicitation for missing context
		if (missing.length > 0) {
			// Build elicitation schema dynamically based on what's missing
			const properties: any = {};

			if (missing.includes("domain")) {
				properties.domain = {
					type: "string",
					description: "What domain does this service belong to?",
					enum: ["api", "platform", "devops", "demo", "backend", "frontend", "auth", "data"],
				};
			}

			if (missing.includes("environment")) {
				properties.environment = {
					type: "string",
					description: "What environment is this for? (e.g., development, staging, production, test, demo)",
				};
			}

			if (missing.includes("team")) {
				properties.team = {
					type: "string",
					description: "Which team owns this service?",
					enum: ["platform", "devops", "api", "backend", "frontend"],
				};
			}

			// Use proper MCP elicitation
			if (extra.elicitation?.requestInput) {
				const elicitationResponse = await extra.elicitation.requestInput({
					message: `Please provide configuration details for service "${args.name}":`,
					schema: {
						type: "object",
						properties,
						required: missing,
					},
				});

				if (elicitationResponse) {
					// Update context with elicited values
					if (elicitationResponse.domain) completeContext.domain = elicitationResponse.domain;
					if (elicitationResponse.environment) completeContext.environment = elicitationResponse.environment;
					if (elicitationResponse.team) completeContext.team = elicitationResponse.team;
				}
			} else {
				// Fallback for environments without elicitation support
				return {
					error: "USER_INPUT_REQUIRED",
					message: `Missing required context for service "${args.name}". Please provide: ${missing.join(", ")}`,
					missingContext: missing,
				};
			}
		}

		// Step 4: Generate production-ready tags
		const tags = generateServiceTags(completeContext, args.name);

		// Step 5: Create service with complete context
		const serviceData = {
			name: args.name,
			host: args.host,
			port: args.port,
			protocol: args.protocol,
			path: args.path,
			retries: args.retries,
			connectTimeout: args.connectTimeout,
			writeTimeout: args.writeTimeout,
			readTimeout: args.readTimeout,
			tags: tags,
			enabled: args.enabled,
		};

		const result = await configOps.createService(api, args.controlPlaneId, serviceData);

		// Determine context source before clearing
		const usedBridge = elicitationBridge.hasValidCompletedSession();

		// Clear the session from bridge after successful use
		if (usedBridge) {
			elicitationBridge.clearLatestSession();
		}

		return {
			...result,
			deploymentContext: completeContext,
			appliedTags: tags,
			message: `Service '${args.name}' created successfully with complete deployment context`,
			contextGathering: {
				source: usedBridge ? "elicitation-bridge" : "native-mcp",
				elicitationUsed:
					Object.keys(providedContext).filter((k) => !providedContext[k as keyof KongDeploymentContext]).length > 0,
				finalContext: completeContext,
			},
		};
	} catch (error) {
		return {
			error: "SERVICE_CREATION_FAILED",
			message: error instanceof Error ? error.message : "Unknown error occurred",
			troubleshooting: [
				"Ensure the control plane ID is valid",
				"Verify the service host is accessible",
				"Check that all required context was provided",
			],
		};
	}
}

/**
 * Enhanced Create Route with Native MCP Elicitation
 */
export async function createRouteWithElicitation(
	api: KongApi,
	args: any,
	extra: RequestHandlerExtra<any, any>,
): Promise<any> {
	try {
		// Step 1: Extract any provided context from tags
		const providedContext: Partial<KongDeploymentContext> = {
			domain: extractFromTags(args.tags, "domain"),
			environment: extractFromTags(args.tags, "env"),
			team: extractFromTags(args.tags, "team"),
		};

		// Step 2: Check what context is missing
		const missing = [];
		if (!providedContext.domain) missing.push("domain");
		if (!providedContext.environment) missing.push("environment");
		if (!providedContext.team) missing.push("team");

		const completeContext = { ...providedContext } as KongDeploymentContext;

		// Step 3: Use proper MCP elicitation for missing context
		if (missing.length > 0) {
			// Build elicitation schema dynamically based on what's missing
			const properties: any = {};

			if (missing.includes("domain")) {
				properties.domain = {
					type: "string",
					description: "What domain does this route belong to?",
					enum: ["api", "platform", "devops", "demo", "backend", "frontend", "auth", "data"],
				};
			}

			if (missing.includes("environment")) {
				properties.environment = {
					type: "string",
					description: "What environment is this for? (e.g., development, staging, production, test, demo)",
				};
			}

			if (missing.includes("team")) {
				properties.team = {
					type: "string",
					description: "Which team owns this route?",
					enum: ["platform", "devops", "api", "backend", "frontend"],
				};
			}

			// Use proper MCP elicitation
			if (extra.elicitation?.requestInput) {
				const elicitationResponse = await extra.elicitation.requestInput({
					message: `Please provide configuration details for route "${args.name}":`,
					schema: {
						type: "object",
						properties,
						required: missing,
					},
				});

				if (elicitationResponse) {
					// Update context with elicited values
					if (elicitationResponse.domain) completeContext.domain = elicitationResponse.domain;
					if (elicitationResponse.environment) completeContext.environment = elicitationResponse.environment;
					if (elicitationResponse.team) completeContext.team = elicitationResponse.team;
				}
			} else {
				// Fallback for environments without elicitation support
				return {
					error: "USER_INPUT_REQUIRED",
					message: `Missing required context for route "${args.name}". Please provide: ${missing.join(", ")}`,
					missingContext: missing,
				};
			}
		}

		// Step 4: Generate production-ready tags
		const tags = generateRouteTags(completeContext, args.name);

		const routeData = {
			name: args.name,
			protocols: args.protocols,
			methods: args.methods,
			hosts: args.hosts,
			paths: args.paths,
			serviceId: args.serviceId,
			stripPath: args.stripPath,
			preserveHost: args.preserveHost,
			regexPriority: args.regexPriority,
			tags: tags,
			enabled: args.enabled,
		};

		const result = await configOps.createRoute(api, args.controlPlaneId, routeData);

		return {
			...result,
			deploymentContext: completeContext,
			appliedTags: tags,
			contextSource: providedContext ? "cached" : "elicited",
		};
	} catch (error) {
		return {
			error: "ROUTE_CREATION_FAILED",
			message: error instanceof Error ? error.message : "Unknown error occurred",
		};
	}
}

/**
 * Enhanced Create Consumer with Native MCP Elicitation
 */
export async function createConsumerWithElicitation(
	api: KongApi,
	args: any,
	extra: RequestHandlerExtra<any, any>,
): Promise<any> {
	try {
		const providedContext: Partial<KongDeploymentContext> = {
			domain: extractFromTags(args.tags, "domain"),
			environment: extractFromTags(args.tags, "env"),
			team: extractFromTags(args.tags, "team"),
		};

		// Check what context is missing
		const missing = [];
		if (!providedContext.domain) missing.push("domain");
		if (!providedContext.environment) missing.push("environment");
		if (!providedContext.team) missing.push("team");

		let completeContext = { ...providedContext } as KongDeploymentContext;

		// Step 3: Use native MCP elicitation for missing context
		if (missing.length > 0) {
			const mcpContext = (extra as any).context;

			if (mcpContext && mcpContext.elicit) {
				// Try native MCP elicitation (Claude Code)
				try {
					const elicitationResult = await mcpContext.elicit({
						message: `Kong deployment requires additional context for consumer: ${args.username}`,
						schema: {
							type: "object",
							properties: {
								domain: {
									type: "string",
									description: "Domain classification for this consumer",
									enum: ["api", "platform", "devops", "b2b", "demo", "backend", "frontend", "auth", "data"],
								},
								environment: {
									type: "string",
									description: "Target deployment environment",
									enum: ["development", "staging", "production", "test"],
								},
								team: {
									type: "string",
									description: "Team that owns this consumer",
									enum: ["platform", "devops", "api", "backend", "frontend"],
								},
							},
							required: missing,
						},
					});

					if (elicitationResult.action === "accept") {
						completeContext = {
							domain: elicitationResult.data.domain || providedContext.domain!,
							environment: elicitationResult.data.environment || providedContext.environment!,
							team: elicitationResult.data.team || providedContext.team!,
						};
					} else {
						return {
							error: "DEPLOYMENT_CANCELLED",
							message: "Consumer creation cancelled - user declined to provide required context",
						};
					}
				} catch (error) {
					return {
						error: "ELICITATION_FAILED",
						message: "Failed to gather deployment context",
						details: error instanceof Error ? error.message : "Unknown error",
					};
				}
			} else {
				// Claude Desktop compatible approach - return clear instructions
				const questions = [];
				if (missing.includes("domain")) {
					questions.push(
						"1. **What domain does this consumer belong to?**\n   Options: api, platform, devops, b2b, demo, backend, frontend, auth, data",
					);
				}
				if (missing.includes("environment")) {
					questions.push("2. **What environment is this for?**\n   Options: development, staging, production, test");
				}
				if (missing.includes("team")) {
					questions.push("3. **Which team owns this consumer?**\n   Options: platform, devops, api, backend, frontend");
				}

				return {
					error: "USER_INPUT_REQUIRED",
					message: `I need more information to create the consumer "${args.username}". Please answer these questions:\n\n${questions.join("\n\n")}\n\nOnce you provide this information, I'll create the consumer with the appropriate tags (domain-{your_choice}, env-{your_choice}, team-{your_choice}).`,
					requiresUserInput: true,
					pendingOperation: "create_consumer",
					consumerConfig: args,
				};
			}
		}

		const tags = generateConsumerTags(completeContext, args.username);

		const consumerData = {
			username: args.username,
			customId: args.customId,
			tags: tags,
			enabled: args.enabled,
		};

		const result = await configOps.createConsumer(api, args.controlPlaneId, consumerData);

		return {
			...result,
			deploymentContext: completeContext,
			appliedTags: tags,
		};
	} catch (error) {
		return {
			error: "CONSUMER_CREATION_FAILED",
			message: error instanceof Error ? error.message : "Unknown error occurred",
		};
	}
}

/**
 * Enhanced Create Plugin with Native MCP Elicitation
 */
export async function createPluginWithElicitation(
	api: KongApi,
	args: any,
	extra: RequestHandlerExtra<any, any>,
): Promise<any> {
	try {
		const providedContext: Partial<KongDeploymentContext> = {
			domain: extractFromTags(args.tags, "domain"),
			environment: extractFromTags(args.tags, "env"),
			team: extractFromTags(args.tags, "team"),
		};

		// Use cached context for plugins (often created in batches)
		const cacheKey = `plugin-context-${args.controlPlaneId}`;
		const completeContext = await mcpElicitationManager.getCachedOrElicit(
			cacheKey,
			async () => {
				const mcpContext = (extra as any).context;
				return await mcpElicitationManager.gatherKongContext(providedContext, mcpContext);
			},
			600, // 10 minutes cache for plugins
		);

		if (!completeContext) {
			return {
				error: "DEPLOYMENT_CANCELLED",
				message: "Plugin creation cancelled - required deployment context not provided",
			};
		}

		const tags = generatePluginTags(completeContext, args.name);

		const pluginData = {
			name: args.name,
			config: args.config,
			protocols: args.protocols,
			consumerId: args.consumerId,
			serviceId: args.serviceId,
			routeId: args.routeId,
			tags: tags,
			enabled: args.enabled,
		};

		const result = await configOps.createPlugin(api, args.controlPlaneId, pluginData);

		return {
			...result,
			deploymentContext: completeContext,
			appliedTags: tags,
			scope: args.serviceId ? "service" : args.routeId ? "route" : "global",
		};
	} catch (error) {
		return {
			error: "PLUGIN_CREATION_FAILED",
			message: error instanceof Error ? error.message : "Unknown error occurred",
		};
	}
}

/**
 * Utility function to extract values from tags
 */
function extractFromTags(tags: string[] | undefined, prefix: string): string | undefined {
	if (!tags) return undefined;

	const tag = tags.find((tag) => tag.startsWith(`${prefix}-`));
	return tag ? tag.substring(prefix.length + 1) : undefined;
}

function generateServiceTags(context: KongDeploymentContext, serviceName: string): string[] {
	return [
		`env-${context.environment}`,
		`domain-${context.domain}`,
		`team-${context.team}`,
		"function-api-gateway",
		"type-external-api",
	];
}

function generateRouteTags(context: KongDeploymentContext, routeName: string): string[] {
	return [
		`env-${context.environment}`,
		`domain-${context.domain}`,
		`team-${context.team}`,
		"function-routing",
		"access-public",
	];
}

function generateConsumerTags(context: KongDeploymentContext, consumerName: string): string[] {
	return [
		`env-${context.environment}`,
		`domain-${context.domain}`,
		`team-${context.team}`,
		"type-api-consumer",
		"access-authenticated",
	];
}

function generatePluginTags(context: KongDeploymentContext, pluginName: string): string[] {
	return [
		`env-${context.environment}`,
		`domain-${context.domain}`,
		`team-${context.team}`,
		"type-middleware",
		`plugin-${pluginName}`,
	];
}

/**
 * Generate elicitation questions for Claude Desktop
 */
function generateElicitationQuestions(missing: string[]) {
	const questions = [];

	if (missing.includes("domain")) {
		questions.push({
			field: "domain",
			question: "What domain does this service belong to?",
			options: ["api", "platform", "devops", "b2b", "demo", "backend", "frontend", "auth", "data"],
			description: "Domain classification helps categorize the service purpose",
		});
	}

	if (missing.includes("environment")) {
		questions.push({
			field: "environment",
			question: "What environment is this for?",
			options: ["development", "staging", "production", "test"],
			description: "Target deployment environment",
		});
	}

	if (missing.includes("team")) {
		questions.push({
			field: "team",
			question: "Which team owns this service?",
			options: ["platform", "devops", "api", "backend", "frontend"],
			description: "Team responsible for this service",
		});
	}

	return questions;
}

/**
 * Tool registry for enhanced Kong tools
 */
export const enhancedKongTools = {
	createServiceWithElicitation,
	createRouteWithElicitation,
	createConsumerWithElicitation,
	createPluginWithElicitation,
};
