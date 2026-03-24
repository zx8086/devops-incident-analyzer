import { z } from "zod";
import type { ElicitationManager, ElicitationRequest } from "./elicitation.js";

/**
 * Advanced Tagging Elicitation System
 *
 * Provides intelligent, context-aware elicitation for Kong entity tagging
 * with smart suggestions, validation, and progressive disclosure patterns.
 */

export interface EntityContext {
	type: "service" | "route" | "plugin" | "consumer";
	name?: string;
	config?: Record<string, unknown>;
	relationships?: {
		serviceId?: string;
		routeId?: string;
		consumerId?: string;
	};
	deckSource?: Record<string, unknown>;
}

export interface TaggingContext {
	domain: string;
	environment: string;
	team: string;
	entities: EntityContext[];
}

export interface TagSuggestion {
	tag: string;
	confidence: number;
	reasoning: string;
	category: "function" | "type" | "criticality" | "access" | "protocol";
}

export interface TaggingPlan {
	entity: EntityContext;
	mandatoryTags: string[];
	suggestedContextualTags: TagSuggestion[];
	elicitationRequired: boolean;
	confidence: number;
}

export class TagElicitationEngine {
	private elicitationManager: ElicitationManager;

	// Tag pattern knowledge base
	private readonly tagPatterns = {
		function: {
			"api-gateway": ["gateway", "api", "proxy", "routing"],
			authentication: ["auth", "login", "oauth", "jwt", "key", "token"],
			security: ["rate", "limit", "cors", "acl", "rbac", "firewall"],
			"data-processing": ["transform", "process", "validate", "parse"],
			notification: ["notify", "alert", "webhook", "email", "sms"],
			analytics: ["log", "metric", "monitor", "track", "audit"],
			payment: ["pay", "billing", "invoice", "transaction", "stripe"],
			storage: ["file", "upload", "download", "media", "s3", "blob"],
		},
		type: {
			"external-api": ["public", "external", "client", "mobile", "web"],
			"internal-api": ["internal", "private", "microservice", "backend"],
			middleware: ["middleware", "proxy", "filter", "interceptor"],
			"security-layer": ["security", "guard", "protection", "shield"],
		},
		criticality: {
			high: ["auth", "security", "payment", "core", "critical", "production"],
			medium: ["business", "feature", "service", "api"],
			low: ["utility", "helper", "test", "demo", "development"],
		},
		access: {
			public: ["public", "external", "open", "client"],
			private: ["private", "internal", "restricted"],
			partner: ["partner", "b2b", "vendor", "third-party"],
		},
		protocol: {
			http: ["http", "rest", "api", "web"],
			grpc: ["grpc", "rpc", "proto"],
			tcp: ["tcp", "socket", "stream"],
			websocket: ["ws", "websocket", "realtime"],
		},
	};

	constructor(elicitationManager: ElicitationManager) {
		this.elicitationManager = elicitationManager;
	}

	/**
	 * Create comprehensive tagging plan for all entities
	 */
	async createTaggingPlan(context: TaggingContext): Promise<TaggingPlan[]> {
		const plans: TaggingPlan[] = [];

		for (const entity of context.entities) {
			const plan = await this.analyzeEntityTagging(entity, context);
			plans.push(plan);
		}

		return plans;
	}

	/**
	 * Generate elicitation session for entities requiring additional tagging info
	 */
	async createTaggingElicitationSession(
		plans: TaggingPlan[],
		context: TaggingContext,
	): Promise<{
		sessionId: string;
		requests: ElicitationRequest[];
		summary: string;
	}> {
		const entitiesNeedingElicitation = plans.filter((plan) => plan.elicitationRequired);

		if (entitiesNeedingElicitation.length === 0) {
			return {
				sessionId: "",
				requests: [],
				summary: "SUCCESS: All entities have sufficient tagging information",
			};
		}

		const session = this.elicitationManager.createSession({
			context,
			plans,
			timestamp: new Date().toISOString(),
		});

		const requests: ElicitationRequest[] = [];

		for (const plan of entitiesNeedingElicitation) {
			// Create contextual tagging request for each entity
			const request = this.createEntityTaggingRequest(session.sessionId, plan, context);
			requests.push(request);
		}

		const summary = this.generateTaggingElicitationSummary(entitiesNeedingElicitation, context);

		return {
			sessionId: session.sessionId,
			requests,
			summary,
		};
	}

	/**
	 * Process elicitation responses and generate final tag assignments
	 */
	async processTaggingResponses(
		sessionId: string,
		plans: TaggingPlan[],
		_context: TaggingContext,
	): Promise<Map<string, string[]>> {
		const responses = this.elicitationManager.getSessionResponses(sessionId);
		const finalTags = new Map<string, string[]>();

		for (const plan of plans) {
			const entityKey = `${plan.entity.type}:${plan.entity.name || "unnamed"}`;
			const tags = [...plan.mandatoryTags];

			if (plan.elicitationRequired) {
				// Find response for this entity
				const entityResponse = Array.from(responses.values()).find((response) =>
					response.requestId.includes(entityKey.replace(":", "_")),
				);

				if (entityResponse?.data) {
					// Add user-provided contextual tags
					tags.push(...entityResponse.data);
				} else {
					// Fall back to highest confidence suggested tags
					const fallbackTags = plan.suggestedContextualTags
						.filter((suggestion) => suggestion.confidence > 0.7)
						.slice(0, 2)
						.map((suggestion) => suggestion.tag);
					tags.push(...fallbackTags);
				}
			} else {
				// Use suggested tags for high-confidence cases
				const autoTags = plan.suggestedContextualTags
					.filter((suggestion) => suggestion.confidence > 0.8)
					.slice(0, 3)
					.map((suggestion) => suggestion.tag);
				tags.push(...autoTags);
			}

			finalTags.set(entityKey, tags);
		}

		return finalTags;
	}

	// Private helper methods
	private async analyzeEntityTagging(entity: EntityContext, context: TaggingContext): Promise<TaggingPlan> {
		const mandatoryTags = [`env-${context.environment}`, `domain-${context.domain}`, `team-${context.team}`];

		const suggestedTags = this.generateContextualTagSuggestions(entity);

		// Calculate confidence based on entity information completeness and suggestion confidence
		const confidence = this.calculateEntityTaggingConfidence(entity, suggestedTags);

		// Require elicitation if confidence is low or insufficient high-confidence suggestions
		const highConfidenceTags = suggestedTags.filter((tag) => tag.confidence > 0.8);
		const elicitationRequired = confidence < 0.7 || highConfidenceTags.length < 2;

		return {
			entity,
			mandatoryTags,
			suggestedContextualTags: suggestedTags,
			elicitationRequired,
			confidence,
		};
	}

	private generateContextualTagSuggestions(entity: EntityContext): TagSuggestion[] {
		const suggestions: TagSuggestion[] = [];
		const entityName = entity.name || "";
		const entityConfig = entity.config || {};

		// Analyze entity based on type
		switch (entity.type) {
			case "service":
				suggestions.push(...this.analyzeServiceTags(entityName, entityConfig));
				break;
			case "route":
				suggestions.push(...this.analyzeRouteTags(entityName, entityConfig));
				break;
			case "plugin":
				suggestions.push(...this.analyzePluginTags(entityName, entityConfig));
				break;
			case "consumer":
				suggestions.push(...this.analyzeConsumerTags(entityName, entityConfig));
				break;
		}

		// Sort by confidence and limit to top suggestions
		return suggestions.sort((a, b) => b.confidence - a.confidence).slice(0, 8);
	}

	private analyzeServiceTags(name: string, config: Record<string, unknown>): TagSuggestion[] {
		const suggestions: TagSuggestion[] = [];
		const nameLower = name.toLowerCase();

		// Function detection
		for (const [func, keywords] of Object.entries(this.tagPatterns.function)) {
			for (const keyword of keywords) {
				if (nameLower.includes(keyword)) {
					suggestions.push({
						tag: `function-${func}`,
						confidence: 0.8,
						reasoning: `Service name contains '${keyword}' suggesting ${func} functionality`,
						category: "function",
					});
					break;
				}
			}
		}

		// Protocol detection from config
		if (typeof config.protocol === "string") {
			const protocol = config.protocol.toLowerCase();
			suggestions.push({
				tag: `protocol-${protocol}`,
				confidence: 0.9,
				reasoning: `Service explicitly configured with ${protocol} protocol`,
				category: "protocol",
			});
		}

		// Access scope detection
		const host = typeof config.host === "string" ? config.host : "";
		if (host) {
			const isExternal = !host.match(/^(localhost|127\.|10\.|172\.(1[6-9]|2[0-9]|3[0-1])\.|192\.168\.)/);
			if (isExternal) {
				suggestions.push({
					tag: "access-public",
					confidence: 0.7,
					reasoning: "Service connects to external host, likely public-facing",
					category: "access",
				});
			} else {
				suggestions.push({
					tag: "access-private",
					confidence: 0.6,
					reasoning: "Service connects to internal host, likely private",
					category: "access",
				});
			}
		}

		// Type detection
		for (const [type, keywords] of Object.entries(this.tagPatterns.type)) {
			for (const keyword of keywords) {
				if (nameLower.includes(keyword)) {
					suggestions.push({
						tag: `type-${type}`,
						confidence: 0.7,
						reasoning: `Service name suggests ${type} architecture`,
						category: "type",
					});
					break;
				}
			}
		}

		// Default function if none detected
		if (!suggestions.some((s) => s.category === "function")) {
			suggestions.push({
				tag: "function-api-gateway",
				confidence: 0.5,
				reasoning: "Default function for Kong services",
				category: "function",
			});
		}

		return suggestions;
	}

	private analyzeRouteTags(name: string, config: Record<string, unknown>): TagSuggestion[] {
		const suggestions: TagSuggestion[] = [];
		const _nameLower = name.toLowerCase();

		// Always suggest routing function
		suggestions.push({
			tag: "function-routing",
			confidence: 0.9,
			reasoning: "Routes inherently handle traffic routing",
			category: "function",
		});

		// Access detection from paths and protocols
		const protocols = Array.isArray(config.protocols) ? (config.protocols as string[]) : [];
		if (protocols.includes("https") || protocols.includes("http")) {
			suggestions.push({
				tag: "access-public",
				confidence: 0.7,
				reasoning: "HTTP/HTTPS protocols indicate public web access",
				category: "access",
			});
		}

		// Type detection from paths
		const paths = Array.isArray(config.paths) ? (config.paths as string[]) : [];
		if (paths.length > 0) {
			const hasApiPath = paths.some((path: string) => path.includes("/api"));
			if (hasApiPath) {
				suggestions.push({
					tag: "type-external-api",
					confidence: 0.8,
					reasoning: "Route includes /api paths indicating external API",
					category: "type",
				});
			}
		}

		// Method analysis
		const methods = Array.isArray(config.methods) ? (config.methods as string[]) : [];
		if (methods.length === 1 && methods[0] === "GET") {
			suggestions.push({
				tag: "type-read-only",
				confidence: 0.6,
				reasoning: "GET-only route suggests read-only access",
				category: "type",
			});
		}

		return suggestions;
	}

	private analyzePluginTags(name: string, _config: Record<string, unknown>): TagSuggestion[] {
		const suggestions: TagSuggestion[] = [];
		const pluginName = name.toLowerCase();

		// Security plugins are always high criticality
		const securityPlugins = ["rate-limiting", "key-auth", "oauth2", "jwt", "acl", "cors", "bot-detection"];
		if (securityPlugins.includes(pluginName)) {
			suggestions.push({
				tag: "function-security",
				confidence: 0.95,
				reasoning: `${name} is a security plugin`,
				category: "function",
			});
			suggestions.push({
				tag: "criticality-high",
				confidence: 0.9,
				reasoning: "Security plugins are critical for system protection",
				category: "criticality",
			});
		}

		// Authentication plugins
		const authPlugins = ["key-auth", "oauth2", "jwt", "basic-auth", "ldap-auth"];
		if (authPlugins.includes(pluginName)) {
			suggestions.push({
				tag: "function-authentication",
				confidence: 0.95,
				reasoning: `${name} handles authentication`,
				category: "function",
			});
		}

		// Transform/processing plugins
		const transformPlugins = ["request-transformer", "response-transformer", "correlation-id"];
		if (transformPlugins.includes(pluginName)) {
			suggestions.push({
				tag: "function-data-processing",
				confidence: 0.8,
				reasoning: `${name} transforms or processes data`,
				category: "function",
			});
		}

		// Observability plugins
		const observabilityPlugins = ["prometheus", "datadog", "zipkin", "http-log"];
		if (observabilityPlugins.includes(pluginName)) {
			suggestions.push({
				tag: "function-analytics",
				confidence: 0.9,
				reasoning: `${name} provides observability features`,
				category: "function",
			});
		}

		return suggestions;
	}

	private analyzeConsumerTags(name: string, _config: Record<string, unknown>): TagSuggestion[] {
		const suggestions: TagSuggestion[] = [];

		// Always suggest authentication function
		suggestions.push({
			tag: "function-authentication",
			confidence: 0.9,
			reasoning: "Consumers are used for API authentication and access control",
			category: "function",
		});

		// Analyze consumer name patterns
		const nameLower = name.toLowerCase();
		if (nameLower.includes("external") || nameLower.includes("client") || nameLower.includes("public")) {
			suggestions.push({
				tag: "access-external",
				confidence: 0.8,
				reasoning: "Consumer name suggests external client access",
				category: "access",
			});
		} else if (nameLower.includes("internal") || nameLower.includes("service")) {
			suggestions.push({
				tag: "access-internal",
				confidence: 0.8,
				reasoning: "Consumer name suggests internal service access",
				category: "access",
			});
		}

		return suggestions;
	}

	private calculateEntityTaggingConfidence(entity: EntityContext, suggestions: TagSuggestion[]): number {
		let confidence = 0.3; // Base confidence

		// Entity name provides context
		if (entity.name && entity.name.length > 3) {
			confidence += 0.2;
		}

		// Configuration provides context
		if (entity.config && Object.keys(entity.config).length > 0) {
			confidence += 0.2;
		}

		// High-confidence suggestions boost overall confidence
		const avgSuggestionConfidence =
			suggestions.length > 0 ? suggestions.reduce((sum, s) => sum + s.confidence, 0) / suggestions.length : 0;

		confidence += avgSuggestionConfidence * 0.3;

		return Math.min(confidence, 1.0);
	}

	private createEntityTaggingRequest(
		sessionId: string,
		plan: TaggingPlan,
		_context: TaggingContext,
	): ElicitationRequest {
		const entity = plan.entity;
		const entityDisplay = `${entity.type}: ${entity.name || "unnamed"}`;

		let message = `**Contextual Tags Required for ${entityDisplay}**\n\n`;
		message += `This ${entity.type} needs additional classification tags for operational intelligence.\n\n`;

		if (entity.name) {
			message += `**Entity**: ${entity.name}\n`;
		}

		if (entity.config) {
			const configSummary = this.summarizeEntityConfig(entity);
			if (configSummary) {
				message += `**Configuration**: ${configSummary}\n`;
			}
		}

		message += `\n**Please select 2-3 contextual tags:**\n`;

		// Group suggestions by category
		const categorizedSuggestions = this.categorizeSuggestions(plan.suggestedContextualTags);

		Object.entries(categorizedSuggestions).forEach(([category, suggestions]) => {
			if (suggestions.length > 0) {
				message += `\n**${category.charAt(0).toUpperCase() + category.slice(1)}**: ${suggestions
					.slice(0, 3)
					.map((s) => s.tag)
					.join(", ")}`;
			}
		});

		const _requestId = `${entity.type}_${entity.name?.replace(/[^a-z0-9]/gi, "_") || "unnamed"}_tags`;

		return this.elicitationManager.addRequest(
			sessionId,
			message,
			z
				.array(z.string().regex(/^[a-z0-9-]+$/))
				.min(2)
				.max(3),
			{
				required: true,
				suggestions: plan.suggestedContextualTags.slice(0, 8).map((s) => s.tag),
				context: { entity, plan },
			},
		);
	}

	private summarizeEntityConfig(entity: EntityContext): string {
		switch (entity.type) {
			case "service":
				return `${entity.config?.protocol || "http"}://${entity.config?.host || "unknown"}:${entity.config?.port || "80"}`;
			case "route": {
				const paths = (entity.config?.paths as string[] | undefined)?.join(", ") || "/";
				const methods = (entity.config?.methods as string[] | undefined)?.join(", ") || "ALL";
				return `${methods} ${paths}`;
			}
			case "plugin":
				return `${entity.name} plugin`;
			case "consumer":
				return `API consumer`;
			default:
				return "";
		}
	}

	private categorizeSuggestions(suggestions: TagSuggestion[]): Record<string, TagSuggestion[]> {
		const categorized: Record<string, TagSuggestion[]> = {
			function: [],
			type: [],
			criticality: [],
			access: [],
			protocol: [],
		};

		suggestions.forEach((suggestion) => {
			const category = categorized[suggestion.category];
			if (category) {
				category.push(suggestion);
			}
		});

		return categorized;
	}

	private generateTaggingElicitationSummary(plans: TaggingPlan[], _context: TaggingContext): string {
		let summary = `**Contextual Tagging Required**\n\n`;
		summary += `${plans.length} entities need additional classification tags:\n\n`;

		plans.forEach((plan, index) => {
			const entity = plan.entity;
			summary += `${index + 1}. **${entity.type}**: ${entity.name || "unnamed"}\n`;
			summary += `   • Confidence: ${Math.round(plan.confidence * 100)}%\n`;
			summary += `   • Top suggestions: ${plan.suggestedContextualTags
				.slice(0, 3)
				.map((s) => s.tag)
				.join(", ")}\n\n`;
		});

		summary += `**Why contextual tags matter:**\n`;
		summary += `• Enable intelligent operational monitoring\n`;
		summary += `• Support automated resource management\n`;
		summary += `• Improve troubleshooting and discovery\n`;
		summary += `• Meet production tagging requirements (5+ tags per entity)`;

		return summary;
	}
}
