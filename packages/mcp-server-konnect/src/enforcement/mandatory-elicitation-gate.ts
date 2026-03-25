// src/enforcement/mandatory-elicitation-gate.ts
import { MigrationAnalyzer } from "../operations/migration-analyzer.js";
import { ElicitationManager, type ElicitationSession, KongElicitationPatterns } from "../utils/elicitation.js";
import { createContextLogger } from "../utils/mcp-logger.js";

const log = createContextLogger("enforcement");

export interface MandatoryContext {
	domain: string;
	environment: string;
	team: string;
	sessionId?: string;
	elicitationComplete: boolean;
	contextConfidence: number;
}

export interface KongOperationContext {
	operationName: string;
	parameters: Record<string, any>;
	requestContext: {
		userMessage: string;
		files?: string[];
		configs?: any[];
	};
}

export class ElicitationBlockedError extends Error {
	constructor(
		public missingFields: string[],
		public elicitationSession: ElicitationSession,
		public override message: string = `OPERATION BLOCKED: Missing mandatory context: ${missingFields.join(", ")}`,
	) {
		super(message);
		this.name = "ElicitationBlockedError";
	}
}

/**
 * SINGLETON ENFORCEMENT GATE
 *
 * This class makes elicitation mandatory by:
 * 1. Blocking ALL Kong operations until context is complete
 * 2. Providing zero fallback mechanisms
 * 3. Forcing explicit user input for all critical fields
 * 4. Maintaining session state across interactions
 */
export class MandatoryElicitationGate {
	private static instance: MandatoryElicitationGate;
	private elicitationManager: ElicitationManager;
	private migrationAnalyzer: MigrationAnalyzer;
	private activeSessions: Map<string, MandatoryContext> = new Map();

	private constructor() {
		this.elicitationManager = new ElicitationManager();
		const elicitationPatterns = new KongElicitationPatterns(this.elicitationManager);
		this.migrationAnalyzer = new MigrationAnalyzer(this.elicitationManager, elicitationPatterns);
	}

	public static getInstance(): MandatoryElicitationGate {
		if (!MandatoryElicitationGate.instance) {
			MandatoryElicitationGate.instance = new MandatoryElicitationGate();
		}
		return MandatoryElicitationGate.instance;
	}

	/**
	 * MANDATORY CONTEXT VALIDATION - BLOCKS ALL OPERATIONS
	 *
	 * This is the primary enforcement method. Every Kong operation
	 * MUST pass through this validation gate.
	 */
	public async validateMandatoryContext(context: KongOperationContext): Promise<MandatoryContext> {
		log.debug({ operationName: context.operationName }, "Enforcement gate validating context");

		// Step 1: Analyze current context and confidence
		const migrationContext = {
			userMessage: context.requestContext.userMessage,
			deckFiles: context.requestContext.files || [],
			deckConfigs: context.requestContext.configs || [],
			gitContext: {},
		};

		const analysis = await this.migrationAnalyzer.analyzeMigration(migrationContext);

		// Step 2: Check if we have active elicitation session
		const sessionId = this.generateSessionId(context);
		const existingContext = this.activeSessions.get(sessionId);

		if (existingContext?.elicitationComplete) {
			log.debug({ sessionId }, "Enforcement gate context already validated");
			return existingContext;
		}

		// Step 3: MANDATORY FIELD VALIDATION - NO FALLBACKS
		const missingFields: string[] = [];

		if (analysis.missingInfo.domain) {
			missingFields.push("domain");
		}
		if (analysis.missingInfo.environment) {
			missingFields.push("environment");
		}
		if (analysis.missingInfo.team) {
			missingFields.push("team");
		}

		// Step 4: BLOCK OPERATION IF ANY MANDATORY FIELDS MISSING
		if (missingFields.length > 0) {
			log.warn(
				{ operationName: context.operationName, missingFields },
				"Enforcement gate blocking operation - missing fields",
			);

			// Create elicitation session for missing context
			const elicitationSession = this.elicitationManager.createSession({
				analysis,
				requestContext: context.requestContext,
				operationName: context.operationName,
				deterministic: true, // For consistent session IDs
			});

			// Store the original context so we can recreate the deterministic session ID later
			elicitationSession.context.originalKongContext = context;

			// Import KongOperationBlockedError from kong-tool-blockers
			const { KongOperationBlockedError } = await import("./kong-tool-blockers.js");
			throw new KongOperationBlockedError(context.operationName, missingFields, elicitationSession);
		}

		// Step 5: Create validated context
		const validatedContext: MandatoryContext = {
			domain: analysis.domain?.value || "unknown",
			environment: analysis.environment?.value || "unknown",
			team: analysis.team?.value || "unknown",
			sessionId,
			elicitationComplete: true,
			contextConfidence: analysis.confidence.overall,
		};

		// Step 6: Cache validated context for session
		this.activeSessions.set(sessionId, validatedContext);

		log.info(
			{
				domain: validatedContext.domain,
				environment: validatedContext.environment,
				team: validatedContext.team,
			},
			"Enforcement gate context validated successfully",
		);

		return validatedContext;
	}

	/**
	 * PROCESS ELICITATION RESPONSE
	 *
	 * Handles user responses from elicitation and updates context
	 */
	public async processElicitationResponse(
		sessionId: string,
		responses: Record<string, string>,
	): Promise<MandatoryContext> {
		log.debug({ sessionId }, "Enforcement gate processing elicitation response");

		// SECURITY: Validate that this session was actually created by a blocked operation
		// This prevents bypass attempts with fake session IDs
		const elicitationSession = this.elicitationManager.getSession(sessionId);
		if (!elicitationSession) {
			throw new Error(
				`SECURITY VIOLATION: Session ${sessionId} not found - cannot process elicitation response for non-existent session`,
			);
		}

		// Validate responses contain all mandatory fields
		const requiredFields = ["domain", "environment", "team"];
		const missingFields = requiredFields.filter((field) => !responses[field]);

		if (missingFields.length > 0) {
			throw new Error(`ELICITATION INCOMPLETE: Missing responses for: ${missingFields.join(", ")}`);
		}

		// Create validated context from responses
		const validatedContext: MandatoryContext = {
			domain: responses.domain!,
			environment: responses.environment!,
			team: responses.team!,
			sessionId,
			elicitationComplete: true,
			contextConfidence: 1.0, // Explicit user input = 100% confidence
		};

		// Cache for future operations in this session
		this.activeSessions.set(sessionId, validatedContext);

		// IMPORTANT: Also store using the deterministic session ID that validateMandatoryContext expects
		// This handles the case where the elicitation session ID (elicit_*) differs from the
		// gate's deterministic session ID (session-*)
		const elicitationSessionData = this.elicitationManager.getSession(sessionId);
		if (elicitationSessionData?.context?.originalKongContext) {
			const originalContext = elicitationSessionData.context.originalKongContext;
			const deterministicSessionId = this.generateSessionId(originalContext);
			this.activeSessions.set(deterministicSessionId, validatedContext);
			log.debug({ sessionId, deterministicSessionId }, "Enforcement gate context stored for both sessions");
		}

		log.info({ sessionId }, "Enforcement gate elicitation complete - context validated");

		return validatedContext;
	}

	/**
	 * GENERATE SESSION ID
	 *
	 * Creates consistent session identifiers for context tracking
	 */
	private generateSessionId(context: KongOperationContext): string {
		// Create a deterministic hash based on operation and message content
		// This ensures the same operation context always gets the same session ID
		const hash = Buffer.from(
			JSON.stringify({
				operation: context.operationName,
				message: context.requestContext.userMessage.slice(0, 100),
				// No timestamp - we want consistent session IDs for the same context
			}),
		)
			.toString("base64")
			.slice(0, 12);

		return `session-${hash}`;
	}

	/**
	 * CLEAR SESSION CONTEXT
	 *
	 * Removes cached context (used for testing and cleanup)
	 */
	public clearSession(sessionId: string): void {
		this.activeSessions.delete(sessionId);
		log.debug({ sessionId }, "Enforcement gate cleared session context");
	}

	/**
	 * GET ACTIVE SESSIONS
	 *
	 * Returns all active sessions (for debugging and monitoring)
	 */
	public getActiveSessions(): Map<string, MandatoryContext> {
		return new Map(this.activeSessions);
	}

	/**
	 * BYPASS PREVENTION - NO BYPASS METHODS ALLOWED
	 *
	 * This class intentionally provides NO bypass mechanisms.
	 * Any attempt to bypass elicitation is architecturally prevented.
	 */
}

/**
 * CONVENIENCE WRAPPER - MANDATORY ELICITATION ENFORCEMENT
 *
 * This wrapper ensures ALL Kong operations go through mandatory validation
 */
export async function withMandatoryElicitation<T>(
	operationName: string,
	context: KongOperationContext,
	operation: (validatedContext: MandatoryContext) => Promise<T>,
): Promise<T> {
	const gate = MandatoryElicitationGate.getInstance();
	const validatedContext = await gate.validateMandatoryContext(context);

	log.info({ operationName }, "Mandatory elicitation executing operation with validated context");

	return await operation(validatedContext);
}
