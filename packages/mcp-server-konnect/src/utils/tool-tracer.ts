/**
 * MCP tool tracer wrapper for comprehensive tool execution tracing
 */

import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import { getToolByMethod } from "../tools/registry.js";
import {
  getOrCreateConversation,
  trackConversationFlow,
} from "./conversation-tracker.js";
import { detectIntent } from "./intent-detector.js";
import { getCurrentSession } from "./session-manager.js";
import type { UniversalTracingManager } from "./tracing.js";

interface ToolExecutionContext {
  toolName: string;
  category: string;
  parameters: any;
  region?: string;
  timestamp: string;
  // Enhanced conversation context
  conversationId?: string;
  messageCount?: number;
  userIntent?: string;
  conversationFlow?: string;
  sessionId?: string;
}

/**
 * Create a traced tool handler with enhanced conversation awareness
 */
export function createTracedToolHandler(
  originalHandler: (args: any, extra: RequestHandlerExtra) => Promise<any>,
  toolName: string,
  tracingManager: UniversalTracingManager,
) {
  return async (args: any, extra: RequestHandlerExtra) => {
    // Get tool information for context
    const toolInfo = getToolByMethod(toolName);
    const category = toolInfo?.category || "unknown";

    // Get current session for conversation tracking
    const session = getCurrentSession();

    // Enhanced conversation context
    let conversationContext: any = {};
    if (session?.sessionId) {
      const conversation = getOrCreateConversation(session.sessionId, toolName);
      const intent = detectIntent(toolName, args, conversation.toolSequence);

      // Track conversation flow before execution
      trackConversationFlow(toolName, intent.primary);

      conversationContext = {
        conversationId: conversation.conversationId,
        messageCount: conversation.messageCount + 1, // Next message
        userIntent: intent.primary,
        conversationFlow:
          conversation.toolSequence.length > 1 ? "continuing" : "new",
        sessionId: session.sessionId,
      };
    }

    // Extract contextual metadata from arguments
    const metadata = extractToolMetadata(toolName, args);

    // Create enhanced execution context
    const context: ToolExecutionContext = {
      toolName,
      category,
      parameters: sanitizeParameters(args),
      region: process.env.KONNECT_REGION || "us",
      timestamp: new Date().toISOString(),
      ...conversationContext,
      ...metadata,
    };

    // Execute with enhanced tracing
    const { result, traceContext } = await tracingManager.traceToolExecution(
      toolName,
      () => originalHandler(args, extra),
      context,
    );

    // Enhance result with comprehensive trace context
    if (traceContext && (await tracingManager.isEnabled())) {
      return {
        ...result,
        _trace: {
          runId: traceContext.runId,
          traceUrl: traceContext.traceUrl,
          sessionId: traceContext.sessionId,
          // Enhanced conversation context in trace
          conversationId: traceContext.conversationId,
          conversationFlow: traceContext.conversationFlow,
          userIntent: traceContext.userIntent,
          messageCount: conversationContext.messageCount,
          conversationQuality: traceContext.conversationQuality
            ? {
                coherenceScore: traceContext.conversationQuality.coherenceScore,
                efficiencyScore:
                  traceContext.conversationQuality.efficiencyScore,
                userExperienceScore:
                  traceContext.conversationQuality.userExperienceScore,
              }
            : undefined,
        },
      };
    }

    return result;
  };
}

/**
 * Extract relevant metadata from tool arguments for better tracing context
 */
function extractToolMetadata(toolName: string, args: any): Record<string, any> {
  const metadata: Record<string, any> = {};

  // Common fields across tools
  if (args.controlPlaneId) {
    metadata.controlPlaneId = args.controlPlaneId;
  }

  // Tool-specific metadata extraction
  switch (toolName) {
    case "query_api_requests":
      metadata.timeRange = args.timeRange;
      metadata.maxResults = args.maxResults;
      metadata.filterCount = [
        args.statusCodes,
        args.excludeStatusCodes,
        args.httpMethods,
        args.consumerIds,
        args.serviceIds,
        args.routeIds,
      ].filter((f) => f && f.length > 0).length;
      break;

    case "get_consumer_requests":
      metadata.timeRange = args.timeRange;
      metadata.consumerId = args.consumerId;
      metadata.successOnly = args.successOnly;
      metadata.failureOnly = args.failureOnly;
      break;

    case "list_control_planes":
      metadata.pageSize = args.pageSize;
      metadata.hasFilters = !!(
        args.filterName ||
        args.filterClusterType ||
        args.filterCloudGateway
      );
      break;

    case "list_certificates":
      metadata.size = args.size;
      metadata.hasOffset = !!args.offset;
      break;

    case "create_certificate":
      metadata.hasAlternativeCert = !!(args.certAlt || args.keyAlt);
      metadata.tagCount = args.tags?.length || 0;
      break;

    case "update_certificate":
      metadata.certificateId = args.certificateId;
      metadata.updateFields = [
        args.cert && "cert",
        args.key && "key",
        args.certAlt && "certAlt",
        args.keyAlt && "keyAlt",
        args.tags && "tags",
      ].filter(Boolean);
      break;

    case "delete_certificate":
      metadata.certificateId = args.certificateId;
      break;

    default:
      // Generic metadata for unknown tools
      metadata.argumentCount = Object.keys(args).length;
      break;
  }

  return metadata;
}

/**
 * Sanitize tool parameters for tracing (remove sensitive data)
 */
function sanitizeParameters(args: any): any {
  if (!args || typeof args !== "object") {
    return args;
  }

  const sanitized = { ...args };

  // List of sensitive parameter names to redact
  const sensitiveParams = [
    "cert",
    "certificate",
    "key",
    "privateKey",
    "private_key",
    "certAlt",
    "keyAlt",
    "secret",
    "token",
    "password",
    "apiKey",
    "api_key",
  ];

  for (const param of sensitiveParams) {
    if (param in sanitized) {
      sanitized[param] = "*** REDACTED FOR SECURITY ***";
    }
  }

  return sanitized;
}

/**
 * Create a conversation-aware batch tracer for multiple related tool executions
 */
export class BatchToolTracer {
  private tracingManager: UniversalTracingManager;
  private sessionName: string;
  private session: any = null;
  private conversationContext?: any;

  constructor(tracingManager: UniversalTracingManager, sessionName: string) {
    this.tracingManager = tracingManager;
    this.sessionName = sessionName;

    // Capture conversation context at batch start
    const currentSession = getCurrentSession();
    if (currentSession?.sessionId) {
      const conversation = getOrCreateConversation(
        currentSession.sessionId,
        "batch",
      );
      this.conversationContext = {
        sessionId: currentSession.sessionId,
        conversationId: conversation.conversationId,
        batchStartMessageCount: conversation.messageCount,
      };
    }
  }

  async startSession(metadata: Record<string, any> = {}) {
    // Enhanced metadata with conversation context
    const enhancedMetadata = {
      ...metadata,
      conversationContext: this.conversationContext,
      batchType: "conversation-aware",
      timestamp: new Date().toISOString(),
    };

    this.session = await this.tracingManager.createSessionTrace(
      enhancedMetadata,
      async () => {
        return { sessionStarted: true, sessionName: this.sessionName };
      },
    );
    return this.session;
  }

  async traceToolBatch<T>(
    toolName: string,
    operations: Array<() => Promise<T>>,
    batchMetadata: Record<string, any> = {},
  ): Promise<T[]> {
    const results: T[] = [];
    const session = getCurrentSession();

    // Track batch as a workflow
    if (session?.sessionId) {
      trackConversationFlow(`batch_${toolName}`, "bulk_operation");
    }

    for (let i = 0; i < operations.length; i++) {
      const operation = operations[i];
      const metadata = {
        category: "batch",
        ...batchMetadata,
        batchIndex: i,
        batchSize: operations.length,
        sessionName: this.sessionName,
        // Enhanced conversation metadata
        conversationId: this.conversationContext?.conversationId,
        batchStartMessageCount:
          this.conversationContext?.batchStartMessageCount,
        batchProgressPercent: Math.round((i / operations.length) * 100),
      };

      const { result } = await this.tracingManager.traceToolExecution(
        `${toolName}_batch_${i}`,
        operation,
        metadata,
      );

      results.push(result);
    }

    return results;
  }

  /**
   * Get batch execution summary with conversation context
   */
  getBatchSummary(): {
    sessionName: string;
    conversationContext?: any;
    completedAt: string;
  } {
    return {
      sessionName: this.sessionName,
      conversationContext: this.conversationContext,
      completedAt: new Date().toISOString(),
    };
  }
}

/**
 * Tool performance metrics collector
 */
export class ToolPerformanceCollector {
  private metrics = new Map<
    string,
    {
      callCount: number;
      totalDuration: number;
      errorCount: number;
      lastCalled: string;
    }
  >();

  recordToolExecution(toolName: string, duration: number, success: boolean) {
    const existing = this.metrics.get(toolName) || {
      callCount: 0,
      totalDuration: 0,
      errorCount: 0,
      lastCalled: "",
    };

    existing.callCount++;
    existing.totalDuration += duration;
    existing.lastCalled = new Date().toISOString();

    if (!success) {
      existing.errorCount++;
    }

    this.metrics.set(toolName, existing);
  }

  getToolStats(toolName: string) {
    const stats = this.metrics.get(toolName);
    if (!stats) return null;

    return {
      ...stats,
      averageDuration: stats.totalDuration / stats.callCount,
      successRate: (stats.callCount - stats.errorCount) / stats.callCount,
      errorRate: stats.errorCount / stats.callCount,
    };
  }

  getAllStats() {
    const result: Record<string, any> = {};

    for (const [toolName, stats] of this.metrics) {
      result[toolName] = {
        ...stats,
        averageDuration: stats.totalDuration / stats.callCount,
        successRate: (stats.callCount - stats.errorCount) / stats.callCount,
        errorRate: stats.errorCount / stats.callCount,
      };
    }

    return result;
  }

  reset() {
    this.metrics.clear();
  }
}
