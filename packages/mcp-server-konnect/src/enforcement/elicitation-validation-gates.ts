// src/enforcement/elicitation-validation-gates.ts
import { createContextLogger } from "../utils/mcp-logger.js";
import type { KongOperationBlockedError } from "./kong-tool-blockers";
import { MandatoryElicitationGate } from "./mandatory-elicitation-gate";

const log = createContextLogger("enforcement");

export interface ElicitationRequest {
	sessionId: string;
	blockedOperation: string;
	missingFields: string[];
	questions: ElicitationQuestion[];
	progressIndicator: string;
	canDecline: boolean;
	declineConsequence: string;
}

export interface ElicitationQuestion {
	field: string;
	question: string;
	suggestions?: string[];
	required: boolean;
	helpText: string;
	validationPattern?: RegExp;
	examples: string[];
}

export interface ElicitationResponse {
	sessionId: string;
	responses: Record<string, string>;
	declined: boolean;
	declinedFields?: string[];
}

/**
 * ELICITATION REQUEST FORMATTER
 *
 * Converts blocked operation errors into user-friendly
 * elicitation requests with clear questions and guidance.
 */
export class ElicitationRequestFormatter {
	/**
	 * FORMAT BLOCKED OPERATION ERROR
	 *
	 * Converts a KongOperationBlockedError into a structured
	 * elicitation request that guides the user.
	 */
	static formatBlockedOperation(error: KongOperationBlockedError): ElicitationRequest {
		const questions = error.missingFields.map((field) =>
			ElicitationRequestFormatter.createQuestionForField(field, error.operation),
		);

		return {
			sessionId: error.elicitationSession.sessionId || "unknown",
			blockedOperation: error.operation,
			missingFields: error.missingFields,
			questions,
			progressIndicator: `[BLOCKED] KONG OPERATION BLOCKED: ${error.operation.toUpperCase()}`,
			canDecline: true,
			declineConsequence: `WARNING: DEPLOYMENT BLOCKED: Cannot proceed with ${error.operation} without mandatory context`,
		};
	}

	/**
	 * CREATE QUESTION FOR FIELD
	 *
	 * Generates contextual questions for each missing field
	 */
	private static createQuestionForField(field: string, operation: string): ElicitationQuestion {
		const fieldQuestions = {
			domain: {
				question: "INFO: Which domain/area does this Kong configuration belong to?",
				suggestions: ["api", "backend", "platform", "devops", "finance", "user-management"],
				helpText:
					"Domain helps categorize and organize your Kong entities. Examples: 'api' for API gateway services, 'backend' for internal services, 'platform' for infrastructure services.",
				examples: ["api", "backend", "platform", "devops"],
			},
			environment: {
				question: "INFO: Which environment is this deployment for?",
				suggestions: ["development", "staging", "production", "testing"],
				helpText:
					"Environment specification is critical for proper deployment targeting. No default values are used for production safety.",
				examples: ["development", "staging", "production"],
			},
			team: {
				question: "[TEAM] Which team owns and manages this configuration?",
				suggestions: ["platform", "backend", "frontend", "devops", "infrastructure"],
				helpText:
					"Team ownership ensures proper access control and maintenance responsibility. This affects who can modify these Kong entities.",
				examples: ["platform-team", "backend-team", "devops-team"],
			},
		};

		const fieldConfig = fieldQuestions[field as keyof typeof fieldQuestions];

		if (!fieldConfig) {
			return {
				field,
				question: `Please specify the ${field} for this Kong ${operation}:`,
				required: true,
				helpText: `This field is required for proper Kong entity management.`,
				examples: ["value1", "value2"],
			};
		}

		return {
			field,
			question: fieldConfig.question,
			suggestions: fieldConfig.suggestions,
			required: true,
			helpText: fieldConfig.helpText,
			validationPattern: /^[a-z][a-z0-9-]*[a-z0-9]$/, // lowercase-with-hyphens
			examples: fieldConfig.examples,
		};
	}

	/**
	 * FORMAT ELICITATION REQUEST FOR USER
	 *
	 * Creates a user-friendly message that can be presented
	 * to guide elicitation completion.
	 */
	static formatForUser(request: ElicitationRequest): string {
		const lines = [
			`${request.progressIndicator}`,
			``,
			`INFO: **MANDATORY CONTEXT REQUIRED**`,
			`Operation: \`${request.blockedOperation}\``,
			`Session: \`${request.sessionId}\``,
			``,
			`[LOCKED] **ZERO-FALLBACK POLICY**: Production deployments require explicit specification of all mandatory fields.`,
			``,
			`INFO: **REQUIRED INFORMATION**:`,
			``,
		];

		// Add questions
		request.questions.forEach((question, index) => {
			lines.push(`**${index + 1}. ${question.question}**`);
			lines.push(`   TIP: ${question.helpText}`);

			if (question.suggestions && question.suggestions.length > 0) {
				lines.push(`   [PIN] Suggestions: ${question.suggestions.map((s) => `\`${s}\``).join(", ")}`);
			}

			lines.push(`   [EDIT] Examples: ${question.examples.map((e) => `\`${e}\``).join(", ")}`);
			lines.push(``);
		});

		// Add decline information
		if (request.canDecline) {
			lines.push(`WARNING: **DECLINE CONSEQUENCE**: ${request.declineConsequence}`);
			lines.push(``);
		}

		lines.push(`INFO: **NEXT STEPS**:`);
		lines.push(`- Provide responses for all ${request.missingFields.length} required fields`);
		lines.push(`- Use \`mcp__kong-konnect__process_elicitation_response\` tool to continue`);
		lines.push(`- Or decline to block deployment and maintain production safety`);

		return lines.join("\n");
	}
}

/**
 * ELICITATION RESPONSE VALIDATOR
 *
 * Validates user responses to elicitation requests
 */
export class ElicitationResponseValidator {
	/**
	 * VALIDATE ELICITATION RESPONSE
	 *
	 * Ensures user responses meet requirements and format standards
	 */
	static validateResponse(response: ElicitationResponse): {
		valid: boolean;
		errors: string[];
		normalizedResponses: Record<string, string>;
	} {
		const errors: string[] = [];
		const normalizedResponses: Record<string, string> = {};

		// Check if declined
		if (response.declined) {
			return {
				valid: false,
				errors: [`User declined elicitation. Deployment blocked for production safety.`],
				normalizedResponses: {},
			};
		}

		// Validate required fields
		const requiredFields = ["domain", "environment", "team"];
		const missingFields = requiredFields.filter((field) => !response.responses[field]);

		if (missingFields.length > 0) {
			errors.push(`Missing required fields: ${missingFields.join(", ")}`);
		}

		// Validate and normalize each response
		for (const [field, value] of Object.entries(response.responses)) {
			if (!value || typeof value !== "string") {
				errors.push(`Field '${field}' must be a non-empty string`);
				continue;
			}

			// Normalize to lowercase-with-hyphens format
			const normalized = value
				.toLowerCase()
				.trim()
				.replace(/[^a-z0-9-]/g, "-")
				.replace(/-+/g, "-")
				.replace(/^-|-$/g, "");

			// Validate format
			const formatPattern = /^[a-z][a-z0-9-]*[a-z0-9]$/;
			if (!formatPattern.test(normalized)) {
				errors.push(
					`Field '${field}' must follow lowercase-with-hyphens format. Got: '${value}', normalized: '${normalized}'`,
				);
				continue;
			}

			// Field-specific validation
			if (field === "environment" && !["development", "staging", "production", "testing"].includes(normalized)) {
				errors.push(`Environment must be one of: development, staging, production, testing. Got: '${normalized}'`);
				continue;
			}

			normalizedResponses[field] = normalized;
		}

		return {
			valid: errors.length === 0,
			errors,
			normalizedResponses,
		};
	}
}

/**
 * ELICITATION FLOW ORCHESTRATOR
 *
 * Manages the complete elicitation process from error to resolution
 */
export class ElicitationFlowOrchestrator {
	private gate = MandatoryElicitationGate.getInstance();

	/**
	 * HANDLE BLOCKED OPERATION
	 *
	 * Processes a blocked Kong operation and returns elicitation request
	 */
	async handleBlockedOperation(error: KongOperationBlockedError): Promise<ElicitationRequest> {
		log.warn({ operation: error.operation }, "Elicitation flow handling blocked operation");

		const request = ElicitationRequestFormatter.formatBlockedOperation(error);

		log.info(
			{
				sessionId: request.sessionId,
				operation: request.blockedOperation,
				missingFields: request.missingFields,
			},
			"Elicitation request created",
		);

		return request;
	}

	/**
	 * PROCESS ELICITATION RESPONSE
	 *
	 * Handles user response and updates the mandatory context
	 */
	async processElicitationResponse(response: ElicitationResponse): Promise<{
		success: boolean;
		message: string;
		errors?: string[];
		contextUpdated?: boolean;
	}> {
		log.info({ sessionId: response.sessionId }, "Elicitation flow processing response");

		// Validate response format and content
		const validation = ElicitationResponseValidator.validateResponse(response);

		if (!validation.valid) {
			log.error({ errors: validation.errors }, "Elicitation validation failed");
			return {
				success: false,
				message: `Elicitation response validation failed`,
				errors: validation.errors,
			};
		}

		try {
			// Update mandatory context with validated responses
			const mandatoryContext = await this.gate.processElicitationResponse(
				response.sessionId,
				validation.normalizedResponses,
			);

			log.info(
				{
					sessionId: response.sessionId,
					domain: mandatoryContext.domain,
					environment: mandatoryContext.environment,
					team: mandatoryContext.team,
					confidence: mandatoryContext.contextConfidence,
				},
				"Elicitation completed successfully",
			);

			return {
				success: true,
				message: `SUCCESS: Elicitation completed successfully. Kong operations now unblocked for session ${response.sessionId}`,
				contextUpdated: true,
			};
		} catch (error) {
			log.error({ error }, "Elicitation processing error");
			return {
				success: false,
				message: `Failed to process elicitation response: ${error instanceof Error ? error.message : "Unknown error"}`,
				errors: [error instanceof Error ? error.message : "Unknown processing error"],
			};
		}
	}

	/**
	 * GET ELICITATION STATUS
	 *
	 * Returns current status of elicitation for a session
	 */
	async getElicitationStatus(sessionId: string): Promise<{
		exists: boolean;
		completed?: boolean;
		context?: any;
	}> {
		const activeSessions = this.gate.getActiveSessions();
		const sessionContext = activeSessions.get(sessionId);

		if (!sessionContext) {
			return { exists: false };
		}

		return {
			exists: true,
			completed: sessionContext.elicitationComplete,
			context: {
				domain: sessionContext.domain,
				environment: sessionContext.environment,
				team: sessionContext.team,
				confidence: sessionContext.contextConfidence,
			},
		};
	}
}

/**
 * GLOBAL ELICITATION ORCHESTRATOR INSTANCE
 *
 * Singleton instance for consistent elicitation management
 */
export const elicitationOrchestrator = new ElicitationFlowOrchestrator();
