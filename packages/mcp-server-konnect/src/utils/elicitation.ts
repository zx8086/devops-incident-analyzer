import { z } from "zod";

/**
 * MCP-style Elicitation Framework for Kong Migrations
 *
 * Implements structured information gathering patterns following MCP elicitation principles:
 * - Progressive disclosure
 * - User autonomy
 * - Context preservation
 * - Transparent information requests
 */

// Loose context payload passed into elicitation message builders. Each caller
// only sets the fields that apply to its scenario (e.g. detectedDomains for
// domain elicitation, filepath for environment elicitation).
export interface ElicitationContext {
	detectedDomains?: string[];
	detectedEnv?: string;
	domain?: string;
	entityName?: string;
	entityConfig?: Record<string, unknown>;
	filepath?: string;
	serviceNames?: string[];
	userMessage?: string;
	suggestedTags?: string[];
	[key: string]: unknown;
}

// Elicitation response types
export interface ElicitationRequest {
	id: string;
	message: string;
	// biome-ignore lint/suspicious/noExplicitAny: ZodSchema<any> is the standard untyped schema slot Zod uses.
	schema: z.ZodSchema<any>;
	context?: Record<string, unknown>;
	required: boolean;
	suggestions?: string[];
	timeout?: number;
}

export interface ElicitationResponse<T = unknown> {
	requestId: string;
	data?: T;
	declined: boolean;
	cancelled: boolean;
	error?: string;
}

export interface ElicitationSession {
	sessionId: string;
	requests: ElicitationRequest[];
	responses: Map<string, ElicitationResponse>;
	context: Record<string, unknown>;
	createdAt: Date;
}

// Elicitation error types
export class ElicitationError extends Error {
	constructor(
		message: string,
		public code: "DECLINED" | "CANCELLED" | "TIMEOUT" | "VALIDATION_FAILED",
	) {
		super(message);
		this.name = "ElicitationError";
	}
}

// Core elicitation manager
export class ElicitationManager {
	private sessions = new Map<string, ElicitationSession>();
	private requestCounter = 0;

	/**
	 * Create a new elicitation session for gathering information
	 */
	createSession(context?: Record<string, unknown>): ElicitationSession {
		const sessionId = `elicit_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

		const session: ElicitationSession = {
			sessionId,
			requests: [],
			responses: new Map(),
			context: context || {},
			createdAt: new Date(),
		};

		this.sessions.set(sessionId, session);
		return session;
	}

	/**
	 * Add an elicitation request to a session
	 */
	addRequest(
		sessionId: string,
		message: string,
		// biome-ignore lint/suspicious/noExplicitAny: ZodSchema<any> is the standard untyped Zod schema slot.
		schema: z.ZodSchema<any>,
		options: {
			required?: boolean;
			suggestions?: string[];
			timeout?: number;
			context?: Record<string, unknown>;
		} = {},
	): ElicitationRequest {
		const session = this.sessions.get(sessionId);
		if (!session) {
			throw new Error(`Session ${sessionId} not found`);
		}

		const request: ElicitationRequest = {
			id: `req_${++this.requestCounter}`,
			message,
			schema,
			context: options.context,
			required: options.required ?? true,
			suggestions: options.suggestions,
			timeout: options.timeout,
		};

		session.requests.push(request);
		return request;
	}

	/**
	 * Process a user response to an elicitation request
	 */
	processResponse<T>(
		sessionId: string,
		requestId: string,
		response: Partial<ElicitationResponse<T>>,
	): ElicitationResponse<T> {
		const session = this.sessions.get(sessionId);
		if (!session) {
			throw new ElicitationError(`Session ${sessionId} not found`, "VALIDATION_FAILED");
		}

		const request = session.requests.find((r) => r.id === requestId);
		if (!request) {
			throw new ElicitationError(`Request ${requestId} not found in session`, "VALIDATION_FAILED");
		}

		// Handle declined/cancelled responses
		if (response.declined || response.cancelled) {
			const finalResponse: ElicitationResponse<T> = {
				requestId,
				declined: response.declined || false,
				cancelled: response.cancelled || false,
				error: response.error,
			};

			session.responses.set(requestId, finalResponse);
			return finalResponse;
		}

		// Validate response data
		if (response.data !== undefined) {
			try {
				const validatedData = request.schema.parse(response.data);
				const finalResponse: ElicitationResponse<T> = {
					requestId,
					data: validatedData,
					declined: false,
					cancelled: false,
				};

				session.responses.set(requestId, finalResponse);
				return finalResponse;
			} catch (error) {
				throw new ElicitationError(
					`Validation failed: ${error instanceof Error ? error.message : "Unknown error"}`,
					"VALIDATION_FAILED",
				);
			}
		}

		throw new ElicitationError("No valid response data provided", "VALIDATION_FAILED");
	}

	/**
	 * Get a session by ID
	 */
	getSession(sessionId: string): ElicitationSession | undefined {
		return this.sessions.get(sessionId);
	}

	/**
	 * Get all responses for a session
	 */
	getSessionResponses(sessionId: string): Map<string, ElicitationResponse> {
		const session = this.sessions.get(sessionId);
		if (!session) {
			throw new Error(`Session ${sessionId} not found`);
		}
		return new Map(session.responses);
	}

	/**
	 * Check if all required requests have been answered
	 */
	isSessionComplete(sessionId: string): boolean {
		const session = this.sessions.get(sessionId);
		if (!session) {
			return false;
		}

		const requiredRequests = session.requests.filter((r) => r.required);
		return requiredRequests.every((request) => {
			const response = session.responses.get(request.id);
			return response && !response.declined && !response.cancelled && response.data !== undefined;
		});
	}

	/**
	 * Clean up old sessions
	 */
	cleanupSession(sessionId: string): void {
		this.sessions.delete(sessionId);
	}

	/**
	 * Get session summary for reporting
	 */
	getSessionSummary(sessionId: string): {
		total: number;
		completed: number;
		declined: number;
		cancelled: number;
		pending: number;
	} {
		const session = this.sessions.get(sessionId);
		if (!session) {
			throw new Error(`Session ${sessionId} not found`);
		}

		const summary = {
			total: session.requests.length,
			completed: 0,
			declined: 0,
			cancelled: 0,
			pending: 0,
		};

		session.requests.forEach((request) => {
			const response = session.responses.get(request.id);
			if (!response) {
				summary.pending++;
			} else if (response.declined) {
				summary.declined++;
			} else if (response.cancelled) {
				summary.cancelled++;
			} else if (response.data !== undefined) {
				summary.completed++;
			} else {
				summary.pending++;
			}
		});

		return summary;
	}
}

// Pre-built elicitation patterns for common Kong migration scenarios
export class KongElicitationPatterns {
	private manager: ElicitationManager;

	constructor(manager: ElicitationManager) {
		this.manager = manager;
	}

	/**
	 * Elicit domain information with intelligent suggestions
	 */
	requestDomain(
		sessionId: string,
		context: {
			detectedDomains?: string[];
			serviceNames?: string[];
			userMessage?: string;
		} = {},
	): ElicitationRequest {
		const suggestions = this.generateDomainSuggestions(context);

		return this.manager.addRequest(
			sessionId,
			this.buildDomainMessage(context),
			z
				.string()
				.min(3)
				.max(40)
				.regex(
					/^[a-z0-9]([a-z0-9_-]*[a-z0-9])?$/,
					"Domain must be lowercase with underscores/hyphens, 3-40 characters",
				),
			{
				required: true,
				suggestions,
				context: context,
			},
		);
	}

	/**
	 * Elicit environment information
	 */
	requestEnvironment(
		sessionId: string,
		context: {
			detectedEnv?: string;
			filepath?: string;
		} = {},
	): ElicitationRequest {
		const suggestions = ["development", "staging", "production", "test"];

		return this.manager.addRequest(sessionId, this.buildEnvironmentMessage(context), z.string().min(1), {
			required: true,
			suggestions,
			context,
		});
	}

	/**
	 * Elicit team information
	 */
	requestTeam(
		sessionId: string,
		context: {
			suggestedTeams?: string[];
			domain?: string;
		} = {},
	): ElicitationRequest {
		const suggestions = context.suggestedTeams || ["platform", "devops", "api", "backend", "frontend"];

		return this.manager.addRequest(
			sessionId,
			this.buildTeamMessage(context),
			z
				.string()
				.min(2)
				.max(40)
				.regex(/^[a-z0-9_-]+$/, "Team must be lowercase with underscores/hyphens, 2-40 characters"),
			{
				required: true,
				suggestions,
				context,
			},
		);
	}

	/**
	 * Elicit contextual tags for entity classification
	 */
	requestContextualTags(
		sessionId: string,
		entityType: "service" | "route" | "plugin" | "consumer",
		context: {
			entityName?: string;
			entityConfig?: Record<string, unknown>;
			suggestedTags?: string[];
		} = {},
	): ElicitationRequest {
		return this.manager.addRequest(
			sessionId,
			this.buildContextualTagsMessage(entityType, context),
			z
				.array(z.string().regex(/^[a-z0-9-]+$/))
				.min(2)
				.max(3),
			{
				required: true,
				suggestions: context.suggestedTags || this.getDefaultContextualTags(entityType),
				context: { entityType, ...context },
			},
		);
	}

	private buildDomainMessage(context: ElicitationContext): string {
		let message = "INFO: **Domain Classification Required**\n\n";
		message += "What domain should this Kong configuration be tagged with?\n";

		if (context.detectedDomains?.length) {
			message += `\nTIP: Detected possible domains: ${context.detectedDomains.join(", ")}`;
		}

		if (context.serviceNames?.length) {
			message += `\nINFO: Found services: ${context.serviceNames.slice(0, 3).join(", ")}${context.serviceNames.length > 3 ? "..." : ""}`;
		}

		message += "\n\n**Examples:** devops, api, platform, finance, marketing";
		message += "\n**Format:** lowercase-with-underscores-for-spaces, 3-40 characters";

		return message;
	}

	private buildEnvironmentMessage(context: ElicitationContext): string {
		let message = "INFO: **Environment Specification Required**\n\n";
		message += "Which environment is this Kong configuration for?\n";

		if (context.detectedEnv) {
			message += `\nTIP: Detected environment: ${context.detectedEnv}`;
		}

		if (context.filepath) {
			message += `\n📁 Configuration file: ${context.filepath}`;
		}

		return message;
	}

	private buildTeamMessage(context: ElicitationContext): string {
		let message = "👥 **Team Ownership Required**\n\n";
		message += "Which team owns this Kong configuration?\n";

		if (context.domain) {
			message += `\nINFO: Domain: ${context.domain}`;
		}

		message += "\n\n**Examples:** platform, devops, api, backend, frontend";
		message += "\n**Format:** lowercase-with-underscores-for-spaces, 2-40 characters";

		return message;
	}

	private buildContextualTagsMessage(entityType: string, context: ElicitationContext): string {
		let message = `INFO: **${entityType.charAt(0).toUpperCase() + entityType.slice(1)} Classification Required**\n\n`;
		message += `Help classify this ${entityType} for better operational intelligence:\n`;

		if (context.entityName) {
			message += `\n📌 ${entityType.charAt(0).toUpperCase() + entityType.slice(1)}: ${context.entityName}`;
		}

		message += `\n\n**Please provide 2-3 classification tags:**`;
		message += `\n• What **function** does this serve? (e.g., function-api-gateway, function-authentication)`;
		message += `\n• What **type** is this? (e.g., type-external-api, type-internal-service)`;
		message += `\n• How **critical** is it? (e.g., criticality-high, criticality-medium)`;

		return message;
	}

	private generateDomainSuggestions(context: ElicitationContext): string[] {
		const suggestions = new Set<string>();

		// Add detected domains
		if (context.detectedDomains?.length) {
			for (const domain of context.detectedDomains) {
				suggestions.add(domain);
			}
		}

		// Extract from service names
		if (context.serviceNames?.length) {
			context.serviceNames.forEach((name: string) => {
				const parts = name.toLowerCase().split(/[-_]/);
				parts.forEach((part) => {
					if (part.length >= 3 && ["api", "service", "app", "web"].includes(part)) {
						// Skip generic terms, look for domain-like terms
					} else if (part.length >= 3 && part.length <= 15) {
						suggestions.add(part);
					}
				});
			});
		}

		// Add common defaults
		for (const d of ["platform", "api", "devops", "backend", "frontend", "auth", "data"]) {
			suggestions.add(d);
		}

		return Array.from(suggestions).slice(0, 8);
	}

	private getDefaultContextualTags(entityType: string): string[] {
		const tagMap = {
			service: ["function-api-gateway", "type-external-api", "criticality-medium"],
			route: ["function-routing", "type-external-api", "access-public"],
			plugin: ["function-security", "criticality-high", "type-middleware"],
			consumer: ["function-authentication", "access-external", "type-client"],
		};

		return tagMap[entityType as keyof typeof tagMap] || [];
	}
}

// Export singleton instance
export const elicitationManager = new ElicitationManager();
export const kongElicitationPatterns = new KongElicitationPatterns(elicitationManager);
