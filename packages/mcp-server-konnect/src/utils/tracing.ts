/**
 * Universal LangSmith tracing manager with auto-detection and graceful degradation
 * Using the proven traceable pattern from the implementation guide
 */

import {
  getRuntimeInfo,
  initializeEnvironment,
  loadTracingConfig,
  type TracingConfig,
  validateTracingConfig,
} from "../config/tracing-config.js";
import {
  analyzeConversationQuality,
  type ConversationQuality,
  generateConversationInsights,
} from "./conversation-metrics.js";
import {
  type ConversationInfo,
  createConversationAwareTraceName,
  getConversationStats,
  getOrCreateConversation,
  trackConversationFlow,
  updateConversation,
} from "./conversation-tracker.js";
import {
  detectContextTransition,
  detectIntent,
  type UserIntent,
} from "./intent-detector.js";
import { mcpLogger } from "./mcp-logger.js";
import {
  createNamedConnectionTrace,
  detectSessionResumption,
  getCurrentSession,
  getSessionConversationSummary,
  incrementToolCallCount,
  updateSessionWithConversation,
} from "./session-manager.js";

interface TraceMetadata {
  category: string;
  region?: string;
  controlPlaneId?: string;
  duration?: number;
  success?: boolean;
  errorType?: string;
  toolVersion?: string;
  // Enhanced conversation context
  conversationId?: string;
  messageCount?: number;
  conversationFlow?: string;
  userIntent?: string;
  topicTransition?: boolean;
  [key: string]: any;
}

interface TraceContext {
  runId?: string;
  traceUrl?: string;
  sessionId?: string;
  // Enhanced conversation context
  conversationId?: string;
  conversationFlow?: string;
  userIntent?: string;
  conversationQuality?: ConversationQuality;
}

// Import traceable function for the proven pattern
let traceable: any = null;
let getCurrentRunTree: any = null;

export class UniversalTracingManager {
  private client: any = null;
  private config: TracingConfig;
  private enabled = false;
  private sessionId: string;
  private initialized = false;

  constructor() {
    this.config = {} as TracingConfig; // Initialize with empty config, will be loaded async
    this.sessionId = `mcp-session-${Date.now()}`;
    // Initialize asynchronously - graceful degradation if it fails
    this.initialize().catch(() => {
      this.enabled = false;
      mcpLogger.warning(
        "tracing",
        "LangSmith initialization failed during construction - graceful degradation active",
      );
    });
  }

  /**
   * Initialize environment and tracing with universal runtime support
   */
  private async initialize(): Promise<void> {
    try {
      // Initialize environment loading (handles Bun vs Node.js differences)
      await initializeEnvironment();

      // Load configuration after environment is initialized
      this.config = loadTracingConfig();

      // Show runtime info for debugging
      const runtimeInfo = await getRuntimeInfo();
      mcpLogger.info(
        "tracing",
        `Runtime: ${runtimeInfo.runtime} ${runtimeInfo.version} (env source: ${runtimeInfo.envSource})`,
      );

      // Initialize LangSmith
      await this.initializeLangSmith();

      this.initialized = true;
    } catch (error: any) {
      mcpLogger.error("tracing", "Tracing initialization failed", {
        error: error.message,
      });
      this.enabled = false;
      this.initialized = true;
    }
  }

  /**
   * Initialize LangSmith with auto-detection and graceful degradation
   */
  private async initializeLangSmith(): Promise<void> {
    try {
      // Validate configuration
      const validation = validateTracingConfig(this.config);
      if (!validation.isValid) {
        mcpLogger.error("tracing", "LangSmith tracing configuration invalid", {
          errors: validation.errors,
        });
        return;
      }

      if (!this.config.enabled) {
        mcpLogger.info(
          "tracing",
          "LangSmith tracing disabled (LANGSMITH_TRACING=false)",
        );
        return;
      }

      // Try to import LangSmith SDK - both Client and traceable
      const langsmithImport = await import("langsmith");
      const { Client } = langsmithImport;

      // Try to import traceable from correct path (as per implementation guide)
      try {
        const traceableImport = await import("langsmith/traceable");

        if ("traceable" in traceableImport) {
          traceable = traceableImport.traceable;
        }

        if ("getCurrentRunTree" in traceableImport) {
          getCurrentRunTree = traceableImport.getCurrentRunTree;
        }
      } catch (traceableError: any) {
        mcpLogger.warning("tracing", "Failed to import traceable functions", {
          error: traceableError.message,
        });
      }

      // Set up environment variables for LangSmith SDK (both standard and legacy)
      process.env.LANGCHAIN_TRACING_V2 = "true";
      process.env.LANGCHAIN_API_KEY = this.config.apiKey;
      process.env.LANGCHAIN_PROJECT =
        this.config.project || "konnect-mcp-server";
      process.env.LANGCHAIN_ENDPOINT =
        this.config.endpoint || "https://api.smith.langchain.com";

      // Legacy custom names for backward compatibility
      process.env.LANGSMITH_TRACING = "true";
      process.env.LANGSMITH_API_KEY = this.config.apiKey;
      if (this.config.project) {
        process.env.LANGSMITH_PROJECT = this.config.project;
      }

      this.client = new Client({
        apiKey: this.config.apiKey,
        apiUrl: this.config.endpoint,
        projectName: this.config.project,
      });

      this.enabled = true;
      mcpLogger.info(
        "tracing",
        `LangSmith tracing enabled for project: ${this.config.project}`,
        {
          dashboardUrl: `${this.config.endpoint?.replace("api.", "")}/p/${this.config.project}`,
        },
      );
    } catch (error: any) {
      mcpLogger.warning(
        "tracing",
        "LangSmith initialization failed - graceful degradation active",
        { error: error.message },
      );
      this.enabled = false;
    }
  }

  /**
   * Wait for initialization to complete
   */
  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;

    // Wait up to 5 seconds for initialization
    const timeout = 5000;
    const startTime = Date.now();

    while (!this.initialized && Date.now() - startTime < timeout) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  /**
   * Check if tracing is enabled and available
   */
  async isEnabled(): Promise<boolean> {
    await this.ensureInitialized();
    return this.enabled && this.client !== null;
  }

  /**
   * Get current configuration
   */
  async getConfig(): Promise<TracingConfig> {
    await this.ensureInitialized();
    return { ...this.config };
  }

  /**
   * Trace a tool execution with enhanced conversation awareness
   */
  async traceToolExecution<T>(
    toolName: string,
    operation: () => Promise<T>,
    metadata: TraceMetadata = { category: "unknown" },
  ): Promise<{ result: T; traceContext?: TraceContext }> {
    // Ensure initialization is complete
    await this.ensureInitialized();

    // Get current session context for grouping
    const session = getCurrentSession();

    // If tracing is disabled, execute directly (graceful degradation)
    if (!this.enabled || !traceable) {
      const result = await operation();
      return { result };
    }

    try {
      // Apply sampling rate
      if (Math.random() > this.config.samplingRate) {
        const result = await operation();
        return { result };
      }

      // Enhanced conversation tracking
      let conversation: ConversationInfo | null = null;
      let conversationAwareTraceName = toolName;
      let userIntent: UserIntent | undefined;
      let conversationQuality: ConversationQuality | undefined;
      let conversationStats: any;

      if (session?.sessionId) {
        // Get or create conversation context
        conversation = getOrCreateConversation(session.sessionId, toolName);

        // Track conversation flow before execution
        trackConversationFlow(toolName);

        // Detect user intent
        userIntent = detectIntent(
          toolName,
          metadata,
          conversation.toolSequence,
        );

        // Update session with conversation context
        const primaryTopic = userIntent.primary;
        updateSessionWithConversation(
          toolName,
          userIntent.primary,
          primaryTopic,
        );

        // Get conversation statistics for metadata
        conversationStats = getConversationStats(session.sessionId);

        // Create conversation-aware trace name
        conversationAwareTraceName = createConversationAwareTraceName(
          toolName,
          conversation,
        );

        // Detect session resumption
        const resumption = detectSessionResumption(session.sessionId);
        if (resumption.isResumption) {
          mcpLogger.info("tracing", "Session resumption detected", {
            sessionId: session.sessionId.substring(0, 8) + "...",
            gapDuration: resumption.gapDuration,
            contextLoss: resumption.contextLoss,
          });
        }
      }

      // Increment tool call counter for session tracking
      incrementToolCallCount();

      // Create enhanced traceable function with proper input capture
      const toolTracer = traceable(
        async (toolInput: any) => {
          // ✅ NOW CAPTURES INPUT ARGUMENTS
          const startTime = Date.now();
          const currentRun = getCurrentRunTree ? getCurrentRunTree() : null;

          mcpLogger.debug(
            "tracing",
            "Executing tool with enhanced session context",
            {
              toolName,
              conversationAwareTraceName,
              project: this.config.project,
              sessionId: session?.sessionId,
              conversationId: conversation?.conversationId,
              messageCount: conversation?.messageCount,
              userIntent: userIntent?.primary,
              clientName: session?.clientInfo?.name,
              hasParentTrace: !!currentRun,
              parentTraceId: currentRun?.id,
              inputReceived: !!toolInput,
            },
          );

          try {
            const result = await operation();
            const executionTime = Date.now() - startTime;
            const success = true;

            // Update conversation with execution results
            if (session?.sessionId && conversation) {
              const updatedConversation = updateConversation(
                session.sessionId,
                toolName,
                executionTime,
                success,
              );

              // Analyze conversation quality
              const conversationStats = getConversationStats(session.sessionId);
              if (conversationStats.conversation) {
                conversationQuality = analyzeConversationQuality(
                  conversationStats.conversation,
                  userIntent,
                  conversationStats.flow,
                );
              }
            }

            mcpLogger.debug(
              "tracing",
              "Tool execution completed with conversation context",
              {
                toolName,
                conversationAwareTraceName,
                project: this.config.project,
                executionTime,
                sessionId: session?.sessionId,
                conversationId: conversation?.conversationId,
                messageCount: conversation?.messageCount + 1,
                userIntent: userIntent?.primary,
                conversationQuality: conversationQuality
                  ? {
                      coherenceScore: conversationQuality.coherenceScore,
                      efficiencyScore: conversationQuality.efficiencyScore,
                      completeness:
                        conversationQuality.conversationCompleteness,
                    }
                  : undefined,
                hasResult: !!result,
              },
            );

            // Enhanced result with comprehensive trace metadata
            return {
              ...result,
              _trace: {
                runId: currentRun?.id,
                executionTime,
                sessionId: session?.sessionId,
                conversationId: conversation?.conversationId,
                clientName: session?.clientInfo?.name,
                toolName,
                conversationFlow: conversationStats?.flow?.type,
                userIntent: userIntent?.primary,
                messageCount: conversation?.messageCount,
                category: metadata.category || "kong-konnect",
                conversationQuality: conversationQuality
                  ? {
                      coherenceScore: conversationQuality.coherenceScore,
                      efficiencyScore: conversationQuality.efficiencyScore,
                      userExperienceScore:
                        conversationQuality.userExperienceScore,
                    }
                  : undefined,
              },
            };
          } catch (error: any) {
            const executionTime = Date.now() - startTime;
            const success = false;

            // Update conversation with execution failure
            if (session?.sessionId && conversation) {
              updateConversation(
                session.sessionId,
                toolName,
                executionTime,
                success,
              );
            }

            // Log error with enhanced context
            mcpLogger.error("tracing", "Tool execution failed", {
              toolName,
              conversationAwareTraceName,
              executionTime,
              sessionId: session?.sessionId,
              conversationId: conversation?.conversationId,
              userIntent: userIntent?.primary,
              error: error instanceof Error ? error.message : String(error),
            });

            throw error; // Re-throw to maintain error propagation
          }
        },
        {
          name: conversationAwareTraceName, // Enhanced dynamic name with conversation context
          run_type: "tool",
          project_name: this.config.project,
          metadata: {
            // Core tool metadata
            tool_name: toolName,
            category: metadata.category || "kong-konnect",
            toolVersion: "2.1.0", // Updated version with conversation support
            runtime: "bun",

            // Session metadata
            session_id: session?.sessionId,
            connection_id: session?.connectionId,
            client_name: session?.clientInfo?.name,
            client_version: session?.clientInfo?.version,
            transport_mode: session?.transportMode,

            // Enhanced conversation metadata
            conversation_id: conversation?.conversationId,
            message_count: conversation?.messageCount,
            is_new_conversation: conversation?.isNewConversation,
            context_switches: conversation?.contextSwitches,
            topic_count: conversation?.topics?.length || 0,
            current_topic: conversation?.currentTopic,

            // Intent and flow metadata
            user_intent_primary: userIntent?.primary,
            user_intent_secondary: userIntent?.secondary,
            intent_confidence: userIntent?.confidence,
            conversation_flow_type: conversationStats?.flow?.type,
            conversation_flow_confidence: conversationStats?.flow?.confidence,

            // Quality metrics
            conversation_efficiency: conversationStats?.efficiency,
            conversation_coherence: conversationStats?.coherence,

            // Session resumption
            session_resumption: session
              ? detectSessionResumption(session.sessionId).isResumption
              : false,

            ...metadata, // Include any additional metadata
          },
          tags: [
            "mcp-server",
            "mcp-tool",
            "conversation-aware",
            `tool:${toolName}`,
            `category:${metadata.category || "unknown"}`,
            session?.clientInfo?.name
              ? `client:${session.clientInfo.name}`
              : "client:unknown",
            `transport:${session?.transportMode}`,
            userIntent?.primary
              ? `intent:${userIntent.primary}`
              : "intent:unknown",
            conversation?.isNewConversation
              ? "conversation:new"
              : "conversation:continuing",
            conversationStats?.flow
              ? `flow:${conversationStats.flow.type}`
              : null,
            "kong-konnect",
          ].filter(Boolean) as string[],
        },
      );

      // Pass the actual tool arguments as input to capture them in the trace
      const toolInput = {
        toolName,
        arguments: metadata.parameters || {}, // This contains the actual tool arguments
        metadata: {
          category: metadata.category,
          session: {
            sessionId: session?.sessionId,
            conversationId: conversation?.conversationId,
            clientName: session?.clientInfo?.name,
          },
          timestamp: metadata.timestamp,
          region: metadata.region,
        },
      };

      const result = await toolTracer(toolInput);

      return {
        result,
        traceContext: {
          sessionId: session?.sessionId || this.sessionId,
          runId: result._trace?.runId,
          conversationId: conversation?.conversationId,
          conversationFlow: conversationStats?.flow?.type,
          userIntent: userIntent?.primary,
          conversationQuality,
        },
      };
    } catch (tracingError: any) {
      // If tracing fails, still execute the operation
      mcpLogger.error("tracing", "LangSmith tracing error", {
        error: tracingError.message,
      });
      const result = await operation();
      return { result };
    }
  }

  /**
   * Create a session-level trace that acts as parent for all tool calls
   */
  async createSessionTrace<T>(
    sessionContext: any,
    operation: () => Promise<T>,
  ): Promise<T> {
    await this.ensureInitialized();

    if (!this.enabled || !traceable) {
      return await operation();
    }

    try {
      const traceName = createNamedConnectionTrace(sessionContext);

      const sessionTracer = traceable(
        async () => {
          const startTime = Date.now();

          mcpLogger.info("tracing", `Starting MCP session: ${traceName}`, {
            connectionId: sessionContext.connectionId,
            transportMode: sessionContext.transportMode,
            clientInfo: sessionContext.clientInfo,
            sessionId: sessionContext.sessionId,
          });

          try {
            const result = await operation();
            const executionTime = Date.now() - startTime;

            mcpLogger.info("tracing", `MCP session established: ${traceName}`, {
              executionTime,
            });

            return result;
          } catch (error) {
            mcpLogger.error("tracing", `MCP session failed: ${traceName}`, {
              error,
            });
            throw error;
          }
        },
        {
          name: traceName,
          run_type: "chain", // Session-level trace
          project_name: this.config.project,
          metadata: {
            session_type: "mcp-connection",
            transport_mode: sessionContext.transportMode,
            client_name: sessionContext.clientInfo?.name || "unknown",
            client_version: sessionContext.clientInfo?.version || "unknown",
            session_id: sessionContext.sessionId,
            user_id: sessionContext.userId,
          },
          tags: [
            "mcp-connection",
            `transport:${sessionContext.transportMode}`,
            sessionContext.clientInfo?.name
              ? `client:${sessionContext.clientInfo.name}`
              : "client:unknown",
          ].filter(Boolean) as string[],
        },
      );

      return await sessionTracer();
    } catch (error: any) {
      mcpLogger.error("tracing", "Session tracing error", {
        error: error.message,
      });
      return await operation();
    }
  }

  /**
   * Log session information for debugging (sessions are created via metadata)
   */
  logSessionInfo(metadata: Record<string, any> = {}) {
    mcpLogger.info("tracing", `Session ID: ${this.sessionId}`, {
      sessionMetadata: {
        createdAt: new Date().toISOString(),
        version: "2.0.0",
        ...metadata,
      },
    });
  }

  /**
   * Sanitize output data for tracing (remove sensitive information)
   */
  private sanitizeOutput(output: any): any {
    if (!output || typeof output !== "object") {
      return output;
    }

    const sanitized = JSON.parse(JSON.stringify(output));

    // Remove or redact sensitive fields
    const sensitiveFields = [
      "key",
      "cert",
      "certificate",
      "private_key",
      "secret",
      "token",
      "password",
    ];

    function redactSensitive(obj: any): any {
      if (typeof obj !== "object" || obj === null) {
        return obj;
      }

      if (Array.isArray(obj)) {
        return obj.map(redactSensitive);
      }

      const result = { ...obj };
      for (const [key, value] of Object.entries(result)) {
        if (
          sensitiveFields.some((field) => key.toLowerCase().includes(field))
        ) {
          result[key] = "*** REDACTED FOR SECURITY ***";
        } else if (typeof value === "object") {
          result[key] = redactSensitive(value);
        }
      }

      return result;
    }

    return redactSensitive(sanitized);
  }

  /**
   * Create a dynamically named traceable function for a specific tool
   * This enables proper tool-specific naming in LangSmith traces
   */
  createToolTracer<T extends any[], R>(
    toolName: string,
  ): (
    operation: (...args: T) => Promise<R>,
    metadata?: TraceMetadata,
  ) => Promise<R> {
    return async (
      operation: (...args: T) => Promise<R>,
      metadata: TraceMetadata = { category: "tool" },
    ): Promise<R> => {
      const { result } = await this.traceToolExecution(
        toolName,
        operation,
        metadata,
      );
      return result;
    };
  }

  /**
   * Get enhanced tracing statistics with conversation awareness
   */
  async getStats(): Promise<{
    enabled: boolean;
    initialized: boolean;
    project: string;
    sessionId: string;
    samplingRate: number;
    runtime: string;
    // Enhanced conversation stats
    conversationSupport: boolean;
    sessionSummary?: ReturnType<typeof getSessionConversationSummary>;
    conversationQuality?: ConversationQuality;
  }> {
    await this.ensureInitialized();
    const runtimeInfo = await getRuntimeInfo();

    // Get session conversation summary if available
    const sessionSummary = getSessionConversationSummary();
    let conversationQuality: ConversationQuality | undefined;

    if (sessionSummary?.sessionId) {
      const conversationStats = getConversationStats(sessionSummary.sessionId);
      if (conversationStats.conversation) {
        conversationQuality = analyzeConversationQuality(
          conversationStats.conversation,
          undefined, // No specific intent for overall stats
          conversationStats.flow,
        );
      }
    }

    return {
      enabled: this.enabled,
      initialized: this.initialized,
      project: this.config.project || "unknown",
      sessionId: this.sessionId,
      samplingRate: this.config.samplingRate,
      runtime: `${runtimeInfo.runtime} ${runtimeInfo.version}`,
      conversationSupport: true,
      sessionSummary,
      conversationQuality,
    };
  }

  /**
   * Get conversation insights for current session
   */
  async getConversationInsights(): Promise<{
    hasActiveConversation: boolean;
    conversation?: ConversationInfo;
    quality?: ConversationQuality;
    insights?: any;
    recommendations?: string[];
  }> {
    const session = getCurrentSession();
    if (!session?.sessionId) {
      return { hasActiveConversation: false };
    }

    const conversationStats = getConversationStats(session.sessionId);
    if (!conversationStats.conversation) {
      return { hasActiveConversation: false };
    }

    const quality = analyzeConversationQuality(
      conversationStats.conversation,
      undefined,
      conversationStats.flow,
    );

    const insights = generateConversationInsights(
      conversationStats.conversation,
      quality,
    );

    return {
      hasActiveConversation: true,
      conversation: conversationStats.conversation,
      quality,
      insights,
      recommendations: insights.recommendedImprovements,
    };
  }
}
