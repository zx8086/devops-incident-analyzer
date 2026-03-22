/**
 * UNIFIED ELICITATION BRIDGE
 *
 * This bridge connects two separate elicitation systems:
 * 1. Migration Analysis Elicitation (analyze context → create session)
 * 2. Kong Operation Blocking (block operation → elicit context)
 *
 * PROBLEM SOLVED: Agent creates migration session but can't use it for blocked operations
 * SOLUTION: Bridge that transfers context between systems
 */

import { ElicitationOperations } from "../tools/elicitation-tool.js";
import { mcpLogger } from "../utils/mcp-logger.js";
import { elicitationOrchestrator } from "./elicitation-validation-gates.js";
import { MandatoryElicitationGate } from "./mandatory-elicitation-gate.js";

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
  private gate = MandatoryElicitationGate.getInstance();

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
    analysisResult: any,
    context: any,
  ): void {
    mcpLogger.debug("enforcement", "Bridge registering migration session", {
      migrationSessionId,
    });

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
      data?: any;
      declined?: boolean;
      cancelled?: boolean;
    },
  ): Promise<{
    success: boolean;
    contextCaptured: boolean;
    bridgeReady: boolean;
  }> {
    mcpLogger.debug("enforcement", "Bridge processing migration response", {
      migrationSessionId,
    });

    const bridgeSession = this.sessionBridge.get(migrationSessionId);
    if (!bridgeSession) {
      mcpLogger.error("enforcement", "Bridge migration session not found", {
        migrationSessionId,
      });
      return { success: false, contextCaptured: false, bridgeReady: false };
    }

    // Handle declined/cancelled
    if (userResponse.declined || userResponse.cancelled) {
      mcpLogger.warning(
        "enforcement",
        "Bridge user declined/cancelled migration session",
        { migrationSessionId },
      );
      bridgeSession.isComplete = true;
      return { success: true, contextCaptured: false, bridgeReady: false };
    }

    // Extract user context from response
    if (userResponse.data) {
      mcpLogger.info(
        "enforcement",
        "Bridge capturing context from migration response",
        { responseData: userResponse.data },
      );

      // Handle different response formats
      let extractedContext: any = {};

      if (typeof userResponse.data === "object") {
        extractedContext = userResponse.data;
      } else if (typeof userResponse.data === "string") {
        // Assume it's domain if single string
        extractedContext = { domain: userResponse.data };
      }

      // Update bridge session with captured context
      bridgeSession.userContext = {
        domain: extractedContext.domain,
        environment: extractedContext.environment,
        team: extractedContext.team,
      };

      bridgeSession.isComplete = this.isContextComplete(
        bridgeSession.userContext,
      );

      mcpLogger.info("enforcement", "Bridge context captured successfully", {
        domain: bridgeSession.userContext.domain,
        environment: bridgeSession.userContext.environment,
        team: bridgeSession.userContext.team,
        complete: bridgeSession.isComplete,
      });

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
    operation: string,
  ): Promise<{
    bridged: boolean;
    autoUnblocked: boolean;
    migrationSessionId?: string;
  }> {
    mcpLogger.debug(
      "enforcement",
      "Bridge attempting to bridge Kong blocking session",
      { blockingSessionId },
    );

    // Look for a completed migration session with the needed context
    for (const [
      migrationSessionId,
      bridgeSession,
    ] of this.sessionBridge.entries()) {
      if (
        bridgeSession.isComplete &&
        this.hasRequiredFields(bridgeSession.userContext, missingFields)
      ) {
        mcpLogger.info(
          "enforcement",
          "Bridge found compatible migration session",
          { migrationSessionId },
        );

        // Establish bidirectional mapping
        this.migrationToBlocking.set(migrationSessionId, blockingSessionId);
        this.blockingToMigration.set(blockingSessionId, migrationSessionId);

        // Update bridge session
        bridgeSession.blockingSessionId = blockingSessionId;
        bridgeSession.isBridged = true;

        // Attempt to auto-unblock using migration context
        const autoUnblocked = await this.autoUnblockOperation(
          blockingSessionId,
          bridgeSession.userContext,
        );

        return {
          bridged: true,
          autoUnblocked,
          migrationSessionId,
        };
      }
    }

    mcpLogger.warning(
      "enforcement",
      "Bridge no compatible migration session found",
      { blockingSessionId },
    );
    return { bridged: false, autoUnblocked: false };
  }

  /**
   * AUTO-UNBLOCK OPERATION
   *
   * Use captured migration context to automatically unblock Kong operations
   */
  private async autoUnblockOperation(
    blockingSessionId: string,
    userContext: any,
  ): Promise<boolean> {
    try {
      mcpLogger.info("enforcement", "Bridge auto-unblocking session", {
        blockingSessionId,
        userContext,
      });

      // Use the elicitation orchestrator to process the bridged response
      const response = {
        sessionId: blockingSessionId,
        responses: userContext,
        declined: false,
      };

      const result =
        await elicitationOrchestrator.processElicitationResponse(response);

      if (result.success) {
        mcpLogger.info(
          "enforcement",
          "Bridge auto-unblocked session successfully",
          { blockingSessionId },
        );
        return true;
      } else {
        mcpLogger.error(
          "enforcement",
          "Bridge failed to auto-unblock session",
          { blockingSessionId, errors: result.errors },
        );
        return false;
      }
    } catch (error) {
      mcpLogger.error("enforcement", "Bridge error auto-unblocking session", {
        blockingSessionId,
        error,
      });
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
    userResponse: any,
  ): Promise<{
    success: boolean;
    bridgeUpdated: boolean;
    migrationSessionId?: string;
  }> {
    mcpLogger.debug(
      "enforcement",
      "Bridge processing direct blocking response",
      { blockingSessionId },
    );

    // Process the response normally through the orchestrator
    const result = await elicitationOrchestrator.processElicitationResponse({
      sessionId: blockingSessionId,
      responses: userResponse.responses || userResponse,
      declined: userResponse.declined || false,
    });

    // If bridged, update the migration session
    const migrationSessionId = this.blockingToMigration.get(blockingSessionId);
    if (migrationSessionId && result.success) {
      const bridgeSession = this.sessionBridge.get(migrationSessionId);
      if (bridgeSession) {
        bridgeSession.userContext = {
          ...bridgeSession.userContext,
          ...(userResponse.responses || userResponse),
        };
        bridgeSession.isComplete = true;
        mcpLogger.info(
          "enforcement",
          "Bridge updated migration session from blocking response",
          { migrationSessionId },
        );
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
  private isContextComplete(context: any): boolean {
    return !!(context.domain && context.environment && context.team);
  }

  private hasRequiredFields(context: any, requiredFields: string[]): boolean {
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
