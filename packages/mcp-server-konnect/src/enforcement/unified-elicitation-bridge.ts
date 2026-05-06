import { createContextLogger } from "../utils/logger.js";
import { elicitationOrchestrator } from "./elicitation-validation-gates.js";

const log = createContextLogger("enforcement");

export interface BridgedElicitationSession {
	migrationSessionId: string;
	blockingSessionId?: string;
	userContext: {
		domain?: string;
		environment?: string;
		team?: string;
	};
	isBridged: boolean;
	isComplete: boolean;
}

/**
 * UNIFIED ELICITATION BRIDGE CLASS
 *
 * Manages the connection between migration analysis and Kong operation blocking
 */
export class UnifiedElicitationBridge {
	private static instance: UnifiedElicitationBridge;
	private sessionBridge = new Map<string, BridgedElicitationSession>();
	private migrationToBlocking = new Map<string, string>(); // migration session → blocking session
	private blockingToMigration = new Map<string, string>(); // blocking session → migration session

	static getInstance(): UnifiedElicitationBridge {
		if (!UnifiedElicitationBridge.instance) {
			UnifiedElicitationBridge.instance = new UnifiedElicitationBridge();
		}
		return UnifiedElicitationBridge.instance;
	}

	/**
	 * REGISTER MIGRATION SESSION
	 *
	 * When a migration analysis creates an elicitation session,
	 * register it for potential bridging to Kong operations
	 */
	registerMigrationSession(
		migrationSessionId: string,
		_analysisResult: Record<string, unknown>,
		_context: Record<string, unknown>,
	): void {
		log.debug({ migrationSessionId }, "Bridge registering migration session");

		this.sessionBridge.set(migrationSessionId, {
			migrationSessionId,
			userContext: {},
			isBridged: false,
			isComplete: false,
		});
	}

	/**
	 * PROCESS MIGRATION RESPONSE AND BRIDGE
	 *
	 * When user responds to migration elicitation, capture the context
	 * and prepare it for Kong operation bridging
	 */
	async processMigrationResponse(
		migrationSessionId: string,
		userResponse: {
			data?: unknown;
			declined?: boolean;
			cancelled?: boolean;
		},
	): Promise<{
		success: boolean;
		contextCaptured: boolean;
		bridgeReady: boolean;
	}> {
		log.debug({ migrationSessionId }, "Bridge processing migration response");

		const bridgeSession = this.sessionBridge.get(migrationSessionId);
		if (!bridgeSession) {
			log.error({ migrationSessionId }, "Bridge migration session not found");
			return { success: false, contextCaptured: false, bridgeReady: false };
		}

		// Handle declined/cancelled
		if (userResponse.declined || userResponse.cancelled) {
			log.warn({ migrationSessionId }, "Bridge user declined/cancelled migration session");
			bridgeSession.isComplete = true;
			return { success: true, contextCaptured: false, bridgeReady: false };
		}

		// Extract user context from response
		if (userResponse.data) {
			log.info({ responseData: userResponse.data }, "Bridge capturing context from migration response");

			// Handle different response formats
			let extractedContext: Record<string, unknown> = {};

			if (userResponse.data && typeof userResponse.data === "object") {
				extractedContext = userResponse.data as Record<string, unknown>;
			} else if (typeof userResponse.data === "string") {
				// Assume it's domain if single string
				extractedContext = { domain: userResponse.data };
			}

			// Narrow each field to string before populating bridge userContext.
			const asString = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
			bridgeSession.userContext = {
				domain: asString(extractedContext.domain),
				environment: asString(extractedContext.environment),
				team: asString(extractedContext.team),
			};

			bridgeSession.isComplete = this.isContextComplete(bridgeSession.userContext);

			log.info(
				{
					domain: bridgeSession.userContext.domain,
					environment: bridgeSession.userContext.environment,
					team: bridgeSession.userContext.team,
					complete: bridgeSession.isComplete,
				},
				"Bridge context captured successfully",
			);

			return {
				success: true,
				contextCaptured: true,
				bridgeReady: bridgeSession.isComplete,
			};
		}

		return { success: true, contextCaptured: false, bridgeReady: false };
	}

	/**
	 * BRIDGE TO KONG OPERATION BLOCKING
	 *
	 * When a Kong operation gets blocked, check if we have migration
	 * context that can be used to unblock it automatically
	 */
	async bridgeToKongBlocking(
		blockingSessionId: string,
		missingFields: string[],
		_operation: string,
	): Promise<{
		bridged: boolean;
		autoUnblocked: boolean;
		migrationSessionId?: string;
	}> {
		log.debug({ blockingSessionId }, "Bridge attempting to bridge Kong blocking session");

		// Look for a completed migration session with the needed context
		for (const [migrationSessionId, bridgeSession] of this.sessionBridge.entries()) {
			if (bridgeSession.isComplete && this.hasRequiredFields(bridgeSession.userContext, missingFields)) {
				log.info({ migrationSessionId }, "Bridge found compatible migration session");

				// Establish bidirectional mapping
				this.migrationToBlocking.set(migrationSessionId, blockingSessionId);
				this.blockingToMigration.set(blockingSessionId, migrationSessionId);

				// Update bridge session
				bridgeSession.blockingSessionId = blockingSessionId;
				bridgeSession.isBridged = true;

				// Attempt to auto-unblock using migration context
				const autoUnblocked = await this.autoUnblockOperation(blockingSessionId, bridgeSession.userContext);

				return {
					bridged: true,
					autoUnblocked,
					migrationSessionId,
				};
			}
		}

		log.warn({ blockingSessionId }, "Bridge no compatible migration session found");
		return { bridged: false, autoUnblocked: false };
	}

	/**
	 * AUTO-UNBLOCK OPERATION
	 *
	 * Use captured migration context to automatically unblock Kong operations
	 */
	private async autoUnblockOperation(
		blockingSessionId: string,
		userContext: Record<string, unknown>,
	): Promise<boolean> {
		try {
			log.info({ blockingSessionId, userContext }, "Bridge auto-unblocking session");

			// Coerce userContext to the orchestrator's expected string-map shape.
			// userContext is a Record<string, unknown>; non-string values are dropped.
			const responses: Record<string, string> = {};
			for (const [k, v] of Object.entries(userContext)) {
				if (typeof v === "string") responses[k] = v;
			}
			const result = await elicitationOrchestrator.processElicitationResponse({
				sessionId: blockingSessionId,
				responses,
				declined: false,
			});

			if (result.success) {
				log.info({ blockingSessionId }, "Bridge auto-unblocked session successfully");
				return true;
			} else {
				log.error({ blockingSessionId, errors: result.errors }, "Bridge failed to auto-unblock session");
				return false;
			}
		} catch (error) {
			log.error({ blockingSessionId, error }, "Bridge error auto-unblocking session");
			return false;
		}
	}

	/**
	 * PROCESS DIRECT BLOCKING RESPONSE
	 *
	 * When user provides context directly to a blocked operation,
	 * process it normally and update any bridged migration sessions
	 */
	async processBlockingResponse(
		blockingSessionId: string,
		userResponse: Record<string, unknown>,
	): Promise<{
		success: boolean;
		bridgeUpdated: boolean;
		migrationSessionId?: string;
	}> {
		log.debug({ blockingSessionId }, "Bridge processing direct blocking response");

		// userResponse may carry the structured ElicitationResponse shape (with
		// `responses` and `declined`) or be a flat string-map. Coerce both into
		// the orchestrator-expected shape.
		const responsesValue =
			userResponse.responses && typeof userResponse.responses === "object"
				? (userResponse.responses as Record<string, string>)
				: (userResponse as Record<string, string>);
		const declinedValue = typeof userResponse.declined === "boolean" ? userResponse.declined : false;

		const result = await elicitationOrchestrator.processElicitationResponse({
			sessionId: blockingSessionId,
			responses: responsesValue,
			declined: declinedValue,
		});

		// If bridged, update the migration session
		const migrationSessionId = this.blockingToMigration.get(blockingSessionId);
		if (migrationSessionId && result.success) {
			const bridgeSession = this.sessionBridge.get(migrationSessionId);
			if (bridgeSession) {
				bridgeSession.userContext = {
					...bridgeSession.userContext,
					...responsesValue,
				};
				bridgeSession.isComplete = true;
				log.info({ migrationSessionId }, "Bridge updated migration session from blocking response");
			}
		}

		return {
			success: result.success,
			bridgeUpdated: !!migrationSessionId,
			migrationSessionId,
		};
	}

	/**
	 * GET BRIDGED SESSION STATUS
	 *
	 * Returns comprehensive status of bridged sessions
	 */
	getBridgedSessionStatus(sessionId: string): {
		isMigrationSession: boolean;
		isBlockingSession: boolean;
		bridgeSession?: BridgedElicitationSession;
		linkedSessionId?: string;
	} {
		// Check if it's a migration session
		const bridgeSession = this.sessionBridge.get(sessionId);
		if (bridgeSession) {
			return {
				isMigrationSession: true,
				isBlockingSession: false,
				bridgeSession,
				linkedSessionId: bridgeSession.blockingSessionId,
			};
		}

		// Check if it's a blocking session
		const migrationSessionId = this.blockingToMigration.get(sessionId);
		if (migrationSessionId) {
			return {
				isMigrationSession: false,
				isBlockingSession: true,
				bridgeSession: this.sessionBridge.get(migrationSessionId),
				linkedSessionId: migrationSessionId,
			};
		}

		return {
			isMigrationSession: false,
			isBlockingSession: false,
		};
	}

	/**
	 * Helper methods
	 */
	private isContextComplete(context: Record<string, unknown>): boolean {
		return !!(context.domain && context.environment && context.team);
	}

	private hasRequiredFields(context: Record<string, unknown>, requiredFields: string[]): boolean {
		return requiredFields.every((field) => !!context[field]);
	}

	/**
	 * GET ALL SESSIONS FOR DEBUGGING
	 */
	getAllSessions(): {
		bridgeSessions: Map<string, BridgedElicitationSession>;
		migrationToBlocking: Map<string, string>;
		blockingToMigration: Map<string, string>;
	} {
		return {
			bridgeSessions: this.sessionBridge,
			migrationToBlocking: this.migrationToBlocking,
			blockingToMigration: this.blockingToMigration,
		};
	}

	/**
	 * CLEAR ALL SESSIONS (for testing)
	 */
	clearAllSessions(): void {
		this.sessionBridge.clear();
		this.migrationToBlocking.clear();
		this.blockingToMigration.clear();
	}
}

// Global instance
export const unifiedElicitationBridge = UnifiedElicitationBridge.getInstance();
