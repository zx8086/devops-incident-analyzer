// src/tools/elicitation-tool.ts
import { z } from "zod";
import { MigrationAnalyzer } from "../operations/migration-analyzer.js";
import { contextDetector } from "../utils/context-detection.js";
import { elicitationManager, kongElicitationPatterns } from "../utils/elicitation.js";
import { elicitationBridge } from "../utils/elicitation-bridge.js";
import { createContextLogger } from "../utils/mcp-logger.js";
import { TagElicitationEngine } from "../utils/tag-elicitation.js";

const log = createContextLogger("elicitation");

/**
 * MCP Tool for Kong Migration Elicitation
 *
 * Provides elicitation capabilities as an MCP tool that can be used
 * within the Kong migration workflows to gather missing information.
 */

// Parameter schemas
export const analyzeContextParameters = () =>
	z.object({
		userMessage: z.string().optional().describe("User's original migration request"),
		deckFiles: z.array(z.string()).optional().describe("Paths to Kong deck YAML files"),
		deckConfigs: z.array(z.any()).optional().describe("Parsed deck configurations"),
		gitContext: z
			.object({
				branch: z.string().optional(),
				repoName: z.string().optional(),
				teamMembers: z.array(z.string()).optional(),
			})
			.optional()
			.describe("Git repository context"),
	});

export const createElicitationSessionParameters = () =>
	z.object({
		analysisResult: z.any().describe("Migration analysis result from analyze-context"),
		context: z.any().describe("Original migration context"),
	});

export const processElicitationResponseParameters = () =>
	z.object({
		sessionId: z.string().describe("Elicitation session ID"),
		requestId: z.string().describe("Elicitation request ID"),
		response: z
			.object({
				data: z.any().optional(),
				declined: z.boolean().optional(),
				cancelled: z.boolean().optional(),
				error: z.string().optional(),
			})
			.describe("User response to elicitation request"),
	});

export const getSessionStatusParameters = () =>
	z.object({
		sessionId: z.string().describe("Elicitation session ID"),
	});

// Tool implementations
export class ElicitationOperations {
	private migrationAnalyzer: MigrationAnalyzer;
	private tagElicitationEngine: TagElicitationEngine;

	constructor() {
		this.migrationAnalyzer = new MigrationAnalyzer(elicitationManager, kongElicitationPatterns);
		this.tagElicitationEngine = new TagElicitationEngine(elicitationManager);
	}

	/**
	 * Analyze migration context and determine elicitation requirements
	 */
	async analyzeContext(
		userMessage?: string,
		deckFiles?: string[],
		deckConfigs?: any[],
		gitContext?: any,
	): Promise<{
		contextDetection: any;
		migrationAnalysis: any;
		elicitationRequired: boolean;
		recommendations: string[];
		summary: string;
	}> {
		// Detect context from various sources
		let contextDetection = contextDetector.detectFromMessage(userMessage || "");

		if (deckFiles && deckFiles.length > 0) {
			const pathDetection = contextDetector.detectFromFilePaths(deckFiles);
			contextDetection = contextDetector.mergeResults(contextDetection, pathDetection);
		}

		if (deckConfigs && deckConfigs.length > 0) {
			const configDetection = contextDetector.detectFromDeckConfig(deckConfigs);
			contextDetection = contextDetector.mergeResults(contextDetection, configDetection);
		}

		// Perform migration analysis
		const migrationAnalysis = await this.migrationAnalyzer.analyzeMigration({
			userMessage,
			deckFiles,
			deckConfigs,
			filePaths: deckFiles,
			gitContext,
		});

		// Generate summary
		const summary = this.generateAnalysisSummary(contextDetection, migrationAnalysis);

		return {
			contextDetection,
			migrationAnalysis,
			elicitationRequired: migrationAnalysis.elicitationRequired,
			recommendations: migrationAnalysis.recommendations,
			summary,
		};
	}

	/**
	 * Create elicitation session based on analysis
	 * Now compatible with both Claude Code and Claude Desktop
	 */
	async createElicitationSession(
		analysisResult: any,
		context: any,
	): Promise<{
		sessionId: string;
		requests: any[];
		summary: string;
		needsUserInput: boolean;
		claudeDesktopPrompt?: string;
		directInstructions?: string;
	}> {
		// Parse analysisResult if it's a string
		if (typeof analysisResult === "string") {
			try {
				analysisResult = JSON.parse(analysisResult);
			} catch (error) {
				log.error({ error }, "Failed to parse analysisResult JSON");
				return {
					sessionId: "",
					requests: [],
					summary: "ERROR: Invalid analysis result format",
					needsUserInput: false,
				};
			}
		}

		// Handle case where analysisResult is null/undefined or elicitation is not required
		if (!analysisResult) {
			return {
				sessionId: "",
				requests: [],
				summary: "ERROR: No analysis result provided",
				needsUserInput: false,
			};
		}

		// CRITICAL FIX: Check migrationAnalysis.elicitationRequired if top-level not available
		const elicitationRequired =
			analysisResult.elicitationRequired ?? analysisResult.migrationAnalysis?.elicitationRequired;

		if (!elicitationRequired) {
			return {
				sessionId: "",
				requests: [],
				summary: "SUCCESS: All required information is available",
				needsUserInput: false,
			};
		}

		// Safely extract migration analysis with fallback
		let migrationAnalysis;
		if (analysisResult.migrationAnalysis) {
			migrationAnalysis = analysisResult.migrationAnalysis;
		} else {
			// Create a fallback migration analysis
			migrationAnalysis = {
				elicitationRequired: true,
				missingInfo: { domain: true, environment: true, team: true },
				entityCounts: {
					total: 1,
					services: 1,
					routes: 1,
					consumers: 0,
					plugins: 0,
				},
				confidence: {
					overall: 0,
					breakdown: { domain: 0, environment: 0, team: 0 },
				},
			};
		}

		const elicitationSession = await this.migrationAnalyzer.createElicitationSession(migrationAnalysis, context);

		// Generate Claude Desktop friendly prompt
		const claudeDesktopPrompt = this.generateClaudeDesktopPrompt(elicitationSession.requests, migrationAnalysis);
		const directInstructions = this.generateDirectInstructions(elicitationSession.requests);

		return {
			sessionId: elicitationSession.sessionId,
			requests: elicitationSession.requests.map((req) => ({
				id: req.id,
				message: req.message,
				required: req.required,
				suggestions: req.suggestions,
				schema: this.serializeSchema(req.schema),
			})),
			summary: elicitationSession.summary,
			needsUserInput: true,
			claudeDesktopPrompt,
			directInstructions,
		};
	}

	/**
	 * Process user response to elicitation request
	 */
	async processElicitationResponse(
		sessionId: string,
		requestId: string,
		response: {
			data?: any;
			declined?: boolean;
			cancelled?: boolean;
			error?: string;
		},
	): Promise<{
		success: boolean;
		message: string;
		sessionComplete: boolean;
		nextRequest?: any;
	}> {
		try {
			const processedResponse = elicitationManager.processResponse(sessionId, requestId, response);
			const isSessionComplete = elicitationManager.isSessionComplete(sessionId);

			let message = "";
			if (response.declined) {
				message = `Request declined. You can proceed with default values or provide the information later.`;
			} else if (response.cancelled) {
				message = `Request cancelled. Migration workflow stopped.`;
			} else if (processedResponse.data !== undefined) {
				message = `Response recorded: ${JSON.stringify(processedResponse.data)}`;
			}

			// CRITICAL: Store session in bridge when complete for Claude Desktop compatibility
			if (isSessionComplete) {
				elicitationBridge.setCompletedSession(sessionId);
				message += ` SUCCESS: Elicitation complete - session ready for enhanced operations.`;
			}

			// Get next pending request if session not complete
			let nextRequest;
			if (!isSessionComplete && !response.cancelled) {
				const session = elicitationManager.getSessionResponses(sessionId);
				// This would need implementation to find next pending request
				// For now, we'll indicate that more info is needed
			}

			return {
				success: true,
				message,
				sessionComplete: isSessionComplete,
				nextRequest,
			};
		} catch (error) {
			return {
				success: false,
				message: `Error processing response: ${error instanceof Error ? error.message : "Unknown error"}`,
				sessionComplete: false,
			};
		}
	}

	/**
	 * Get status of elicitation session
	 */
	async getSessionStatus(sessionId: string): Promise<{
		sessionId: string;
		summary: any;
		isComplete: boolean;
		responses: Record<string, any>;
		recommendations: string[];
	}> {
		const summary = elicitationManager.getSessionSummary(sessionId);
		const isComplete = elicitationManager.isSessionComplete(sessionId);
		const responses = Object.fromEntries(elicitationManager.getSessionResponses(sessionId));

		const recommendations = this.generateCompletionRecommendations(summary, isComplete);

		return {
			sessionId,
			summary,
			isComplete,
			responses,
			recommendations,
		};
	}

	/**
	 * Generate final tag assignments from completed elicitation session
	 */
	async generateTagAssignments(
		sessionId: string,
		migrationAnalysis: any,
	): Promise<{
		success: boolean;
		tagAssignments: Record<string, string[]>;
		summary: string;
		validationResults: any;
	}> {
		const isComplete = elicitationManager.isSessionComplete(sessionId);

		if (!isComplete) {
			return {
				success: false,
				tagAssignments: {},
				summary: "Elicitation session not complete - cannot generate tag assignments",
				validationResults: { valid: false, errors: ["Session incomplete"] },
			};
		}

		const responses = elicitationManager.getSessionResponses(sessionId);
		const tagAssignments: Record<string, string[]> = {};

		// Extract domain, environment, team from responses - NO FALLBACKS
		let domain: string | null = null;
		let environment: string | null = null;
		let team: string | null = null;

		// Map responses based on order: domain, environment, team
		const responseArray = Array.from(responses.values());
		if (responseArray[0]?.data) domain = responseArray[0].data;
		if (responseArray[1]?.data) environment = responseArray[1].data;
		if (responseArray[2]?.data) team = responseArray[2].data;

		// CRITICAL: Validate all mandatory fields are provided - NO FALLBACKS
		if (!domain || !environment || !team) {
			const missingFields = [];
			if (!domain) missingFields.push("domain");
			if (!environment) missingFields.push("environment");
			if (!team) missingFields.push("team");

			return {
				success: false,
				tagAssignments: {},
				summary: `ERROR: Cannot generate tag assignments - missing required fields: ${missingFields.join(", ")}`,
				validationResults: {
					valid: false,
					errors: [`Missing mandatory fields: ${missingFields.join(", ")}`],
				},
			};
		}

		// Generate tag assignments for each entity type based on analysis
		const entityCounts = migrationAnalysis.entityCounts;

		// Example tag assignment logic - would need actual entity analysis
		for (let i = 0; i < entityCounts.services; i++) {
			tagAssignments[`service-${i}`] = [
				`env-${environment}`,
				`domain-${domain}`,
				`team-${team}`,
				"function-api-gateway",
				"type-external-api",
			];
		}

		for (let i = 0; i < entityCounts.routes; i++) {
			tagAssignments[`route-${i}`] = [
				`env-${environment}`,
				`domain-${domain}`,
				`team-${team}`,
				"function-routing",
				"access-public",
			];
		}

		const validationResults = this.validateTagAssignments(tagAssignments);
		const summary = this.generateTagAssignmentSummary(tagAssignments, validationResults);

		return {
			success: validationResults.valid,
			tagAssignments,
			summary,
			validationResults,
		};
	}

	// Private helper methods
	private generateAnalysisSummary(contextDetection: any, migrationAnalysis: any): string {
		let summary = `**Migration Context Analysis**\n\n`;

		// Context detection summary
		summary += `**Context Detection Results:**\n`;
		if (contextDetection.summary.bestDomain) {
			summary += `• Domain: ${contextDetector.explainDetection(contextDetection.summary.bestDomain)}\n`;
		}
		if (contextDetection.summary.bestEnvironment) {
			summary += `• Environment: ${contextDetector.explainDetection(contextDetection.summary.bestEnvironment)}\n`;
		}
		if (contextDetection.summary.bestTeam) {
			summary += `• Team: ${contextDetector.explainDetection(contextDetection.summary.bestTeam)}\n`;
		}

		summary += `\n**Migration Analysis:**\n`;
		summary += `• Total entities: ${migrationAnalysis.entityCounts.total}\n`;
		summary += `• Overall confidence: ${Math.round(migrationAnalysis.confidence.overall * 100)}%\n`;
		summary += `• Risk level: ${migrationAnalysis.riskAssessment}\n`;

		if (migrationAnalysis.elicitationRequired) {
			summary += `\nWARNING: **Information needed:**\n`;
			Object.entries(migrationAnalysis.missingInfo).forEach(([key, missing]) => {
				if (missing) {
					summary += `• ${key.charAt(0).toUpperCase() + key.slice(1)} specification required\n`;
				}
			});
		} else {
			summary += `\nSUCCESS: All required information available`;
		}

		return summary;
	}

	private serializeSchema(schema: z.ZodSchema<any>): any {
		// Convert Zod schema to JSON-serializable format
		// This is a simplified version - would need full implementation
		return {
			type: "object",
			description: "User response schema",
		};
	}

	private generateCompletionRecommendations(summary: any, isComplete: boolean): string[] {
		const recommendations: string[] = [];

		if (!isComplete) {
			if (summary.declined > 0) {
				recommendations.push("Some information was declined - consider using safe defaults");
			}
			if (summary.pending > 0) {
				recommendations.push(`${summary.pending} questions still pending - complete for optimal results`);
			}
		}

		if (summary.completed > 0) {
			recommendations.push("Use provided information to generate comprehensive tag assignments");
		}

		if (isComplete) {
			recommendations.push("All information gathered - proceed with migration using tag assignments");
		}

		return recommendations;
	}

	private validateTagAssignments(tagAssignments: Record<string, string[]>): {
		valid: boolean;
		errors: string[];
		warnings: string[];
	} {
		const errors: string[] = [];
		const warnings: string[] = [];

		Object.entries(tagAssignments).forEach(([entity, tags]) => {
			// Check minimum tag count
			if (tags.length < 5) {
				errors.push(`${entity} has only ${tags.length} tags, minimum 5 required`);
			}

			// Check mandatory tags
			const hasEnv = tags.some((tag) => tag.startsWith("env-"));
			const hasDomain = tags.some((tag) => tag.startsWith("domain-"));
			const hasTeam = tags.some((tag) => tag.startsWith("team-"));

			if (!hasEnv) errors.push(`${entity} missing env-* tag`);
			if (!hasDomain) errors.push(`${entity} missing domain-* tag`);
			if (!hasTeam) errors.push(`${entity} missing team-* tag`);

			// Check tag format
			tags.forEach((tag) => {
				if (!tag.match(/^[a-z0-9-]+$/)) {
					errors.push(`${entity} has invalid tag format: ${tag}`);
				}
			});
		});

		return {
			valid: errors.length === 0,
			errors,
			warnings,
		};
	}

	private generateTagAssignmentSummary(tagAssignments: Record<string, string[]>, validationResults: any): string {
		let summary = `**Tag Assignment Summary**\n\n`;

		const entityCount = Object.keys(tagAssignments).length;
		const totalTags = Object.values(tagAssignments).flat().length;
		const avgTagsPerEntity = entityCount > 0 ? Math.round(totalTags / entityCount) : 0;

		summary += `• **Entities tagged**: ${entityCount}\n`;
		summary += `• **Total tags**: ${totalTags}\n`;
		summary += `• **Average tags per entity**: ${avgTagsPerEntity}\n`;

		if (validationResults.valid) {
			summary += `\nSUCCESS: **Validation**: All tag assignments meet requirements`;
		} else {
			summary += `\nERROR: **Validation errors**: ${validationResults.errors.length}`;
			validationResults.errors.slice(0, 3).forEach((error: string) => {
				summary += `\n  • ${error}`;
			});
		}

		return summary;
	}

	/**
	 * Generate Claude Desktop friendly prompt
	 */
	private generateClaudeDesktopPrompt(requests: any[], migrationAnalysis: any): string {
		const entityCount = migrationAnalysis.entityCounts?.total || 0;

		let prompt = `## 🚨 Missing Information for Kong Deployment\n\n`;
		prompt += `I need to deploy **${entityCount} entities** to Kong Konnect, but I'm missing some required information for proper tagging and organization.\n\n`;

		prompt += `**Required Information:**\n\n`;

		requests.forEach((req, index) => {
			const fieldName = this.extractFieldFromRequest(req);
			const suggestions = req.suggestions || [];

			prompt += `**${index + 1}. ${fieldName.toUpperCase()}**\n`;
			prompt += `${req.message.replace(/[🏷️🌍👥]/gu, "").trim()}\n`;

			if (suggestions.length > 0) {
				prompt += `💡 **Suggestions:** ${suggestions.join(", ")}\n`;
			}
			prompt += `\n`;
		});

		prompt += `**How to Provide Information:**\n`;
		prompt += `Please respond with: \`domain=your_domain, environment=your_environment, team=your_team\`\n\n`;
		prompt += `**Example:** \`domain=api, environment=production, team=platform\`\n\n`;
		prompt += `Once you provide this information, I'll deploy the configuration with proper tags like:\n`;
		prompt += `- \`env-production\`\n`;
		prompt += `- \`domain-api\`\n`;
		prompt += `- \`team-platform\`\n`;
		prompt += `- Plus 2 contextual tags per entity\n`;

		return prompt;
	}

	/**
	 * Generate direct instructions for Claude Desktop
	 */
	private generateDirectInstructions(requests: any[]): string {
		const fields = requests.map((req) => this.extractFieldFromRequest(req));
		return `To proceed, please provide: ${fields.map((f) => `${f}=your_${f}`).join(", ")}`;
	}

	/**
	 * Extract field name from request
	 */
	private extractFieldFromRequest(request: any): string {
		if (request.id?.includes("domain") || request.message?.toLowerCase().includes("domain")) {
			return "domain";
		}
		if (request.id?.includes("environment") || request.message?.toLowerCase().includes("environment")) {
			return "environment";
		}
		if (request.id?.includes("team") || request.message?.toLowerCase().includes("team")) {
			return "team";
		}
		return request.id || "unknown";
	}
}

// Tool definitions for registration
export const elicitationTools = [
	{
		method: "analyze_migration_context",
		name: "Analyze Migration Context",
		description: `
Analyze Kong migration context and determine what information needs to be elicited from users.

This tool performs intelligent analysis of:
- User messages for explicit information
- File paths for environment/domain hints  
- Deck configurations for service details
- Git context for team information

Returns confidence scores and identifies missing mandatory information (domain, environment, team).
`,
		parameters: analyzeContextParameters(),
		category: "elicitation",
	},
	{
		method: "create_elicitation_session",
		name: "Create Elicitation Session",
		description: `
Create an MCP elicitation session to gather missing information for Kong migration.

Based on migration analysis, creates structured prompts for:
- Domain classification with intelligent suggestions
- Environment specification with validation
- Team ownership with contextual hints
- Contextual tags for operational intelligence

Returns session ID and list of elicitation requests.
`,
		parameters: createElicitationSessionParameters(),
		category: "elicitation",
	},
	{
		method: "process_elicitation_response",
		name: "Process Elicitation Response",
		description: `
Process user response to an elicitation request with validation.

Handles:
- Data validation against schema
- User declinations with graceful fallbacks
- Session cancellation
- Progress tracking

Returns success status and next steps.
`,
		parameters: processElicitationResponseParameters(),
		category: "elicitation",
	},
	{
		method: "get_session_status",
		name: "Get Elicitation Session Status",
		description: `
Get current status and progress of an elicitation session.

Returns:
- Completion status
- Response summary
- Pending requests
- Recommendations for next steps
`,
		parameters: getSessionStatusParameters(),
		category: "elicitation",
	},
];
