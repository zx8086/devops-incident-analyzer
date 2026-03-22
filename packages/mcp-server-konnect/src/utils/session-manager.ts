/**
 * Session Management System for MCP Server
 * Implements AsyncLocalStorage for context propagation and session grouping
 * Based on the proven patterns from LANGSMITH_TRACING_IMPLEMENTATION.md
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { mcpLogger } from "./mcp-logger.js";

export interface SessionContext {
  sessionId: string; // Unique session identifier
  connectionId: string; // Connection-specific ID
  transportMode: "stdio" | "sse";
  startTime: number;
  clientInfo?: {
    name?: string;
    version?: string;
    userAgent?: string;
  };
  userId?: string;
  toolCallCount?: number;
  metadata?: Record<string, any>;
  // Enhanced conversation context
  currentThread?: string;
  threadHistory: string[];
  lastIntent?: string;
  conversationStartTime?: number;
  topicTransitions: Array<{
    from: string;
    to: string;
    timestamp: number;
    triggerTool: string;
  }>;
}

// Global session storage using AsyncLocalStorage
const sessionStorage = new AsyncLocalStorage<SessionContext>();

/**
 * Run operations within session context
 */
export function runWithSession<T>(
  context: SessionContext,
  fn: () => T | Promise<T>,
): T | Promise<T> {
  return sessionStorage.run(context, fn);
}

/**
 * Get current session from any nested operation
 */
export function getCurrentSession(): SessionContext | undefined {
  const session = sessionStorage.getStore();
  if (!session) {
    mcpLogger.debug(
      "session",
      "No session context available in AsyncLocalStorage",
    );
  }
  return session;
}

/**
 * Get session ID from current context
 */
export function getCurrentSessionId(): string | undefined {
  return getCurrentSession()?.sessionId;
}

/**
 * Get client info from current context
 */
export function getCurrentClientInfo():
  | SessionContext["clientInfo"]
  | undefined {
  return getCurrentSession()?.clientInfo;
}

/**
 * Create a session context object
 */
export function createSessionContext(
  connectionId: string,
  transportMode: "stdio" | "sse",
  sessionId?: string,
  clientInfo?: SessionContext["clientInfo"],
  userId?: string,
): SessionContext {
  const now = Date.now();
  return {
    sessionId: sessionId || connectionId,
    connectionId,
    transportMode,
    startTime: now,
    clientInfo,
    userId,
    toolCallCount: 0,
    metadata: {},
    // Enhanced conversation context
    threadHistory: [],
    conversationStartTime: now,
    topicTransitions: [],
  };
}

/**
 * Generates a session ID based on connection context
 */
export function generateSessionId(
  connectionId: string,
  clientInfo?: { name?: string },
): string {
  const timestamp = Date.now();
  const clientPrefix =
    clientInfo?.name?.toLowerCase().replace(/\s+/g, "-") || "unknown";
  const shortId = connectionId.substring(0, 6);

  return `${clientPrefix}-${timestamp}-${shortId}`;
}

/**
 * Detect client based on transport mode and environment
 */
export function detectClient(
  transportMode: "stdio" | "sse",
): SessionContext["clientInfo"] {
  if (transportMode === "stdio") {
    // Most likely Claude Desktop or CLI tools
    return {
      name: "Claude Desktop",
      version: "unknown",
      userAgent: "claude-desktop",
    };
  } else {
    // SSE likely means web client
    return {
      name: "Web Client",
      version: "unknown",
      userAgent: "web-client",
    };
  }
}

/**
 * Log session info for debugging
 */
export function logSessionInfo(prefix = "Session Info") {
  const session = getCurrentSession();
  if (session) {
    mcpLogger.debug("session", prefix, {
      sessionId: `${session.sessionId?.substring(0, 10)}...`,
      connectionId: `${session.connectionId?.substring(0, 10)}...`,
      client: session.clientInfo?.name || "unknown",
      transport: session.transportMode,
      duration: session.startTime ? Date.now() - session.startTime : 0,
      toolCallCount: session.toolCallCount || 0,
    });
  } else {
    mcpLogger.debug("session", `${prefix}: No active session`);
  }
}

/**
 * Session cleanup on connection close
 */
export function cleanupSession(sessionId: string) {
  mcpLogger.debug("session", "Cleaning up session", { sessionId });

  const session = getCurrentSession();
  if (session?.startTime) {
    const duration = Date.now() - session.startTime;
    const conversationDuration = session.conversationStartTime
      ? Date.now() - session.conversationStartTime
      : duration;

    mcpLogger.info("session", "Session ended", {
      sessionId,
      duration,
      conversationDuration,
      clientName: session.clientInfo?.name,
      toolCallCount: session.toolCallCount || 0,
      threadCount: session.threadHistory.length,
      topicTransitions: session.topicTransitions.length,
    });
  }
}

/**
 * Increment tool call counter for current session
 */
export function incrementToolCallCount() {
  const session = getCurrentSession();
  if (session) {
    session.toolCallCount = (session.toolCallCount || 0) + 1;
  }
}

/**
 * Creates properly named session traces for better identification
 */
export function createNamedConnectionTrace(context: SessionContext): string {
  let traceName = "MCP Connection";

  // Client identification
  if (context.clientInfo?.name) {
    const clientName = context.clientInfo.name
      .replace(/[^a-zA-Z0-9\s]/g, "")
      .trim();
    traceName = `${clientName}`;
  }

  // Transport mode and session identifier
  traceName += ` (${context.transportMode.toUpperCase()})`;

  if (context.sessionId) {
    const sessionParts = context.sessionId.split("-");
    const sessionIdentifier =
      sessionParts.length > 2
        ? sessionParts[sessionParts.length - 1].substring(0, 6)
        : context.sessionId.substring(0, 8);
    traceName += ` [${sessionIdentifier}]`;
  }

  return traceName;
}

/**
 * Detect if this is a session resumption after a gap
 */
export function detectSessionResumption(sessionId: string): {
  isResumption: boolean;
  gapDuration?: number;
  contextLoss?: boolean;
  previousThreads?: string[];
} {
  const session = getCurrentSession();

  if (!session || !session.conversationStartTime) {
    return { isResumption: false };
  }

  const now = Date.now();
  const timeSinceLastActivity = now - session.startTime;

  // Consider > 5 minutes as session resumption
  if (timeSinceLastActivity > 5 * 60 * 1000) {
    return {
      isResumption: true,
      gapDuration: timeSinceLastActivity,
      contextLoss: timeSinceLastActivity > 30 * 60 * 1000, // > 30 min = likely context loss
      previousThreads: session.threadHistory.slice(-5), // Last 5 threads
    };
  }

  return { isResumption: false };
}

/**
 * Update session with conversation context
 */
export function updateSessionWithConversation(
  toolName: string,
  intent?: string,
  topic?: string,
): void {
  const session = getCurrentSession();
  if (!session) return;

  // Update current thread if topic changed
  if (topic && session.currentThread !== topic) {
    if (session.currentThread) {
      // Record topic transition
      session.topicTransitions.push({
        from: session.currentThread,
        to: topic,
        timestamp: Date.now(),
        triggerTool: toolName,
      });

      // Add to thread history
      if (!session.threadHistory.includes(session.currentThread)) {
        session.threadHistory.push(session.currentThread);
      }
    }

    session.currentThread = topic;
  }

  // Update last intent
  if (intent) {
    session.lastIntent = intent;
  }

  // Keep thread history manageable (last 10 threads)
  if (session.threadHistory.length > 10) {
    session.threadHistory = session.threadHistory.slice(-10);
  }

  // Keep topic transitions manageable (last 20 transitions)
  if (session.topicTransitions.length > 20) {
    session.topicTransitions = session.topicTransitions.slice(-20);
  }
}

/**
 * Get session conversation summary
 */
export function getSessionConversationSummary(): {
  sessionId: string;
  duration: number;
  conversationDuration: number;
  toolCallCount: number;
  currentThread?: string;
  threadCount: number;
  topicTransitions: number;
  lastIntent?: string;
  clientInfo?: SessionContext["clientInfo"];
} | null {
  const session = getCurrentSession();
  if (!session) return null;

  const now = Date.now();

  return {
    sessionId: session.sessionId,
    duration: now - session.startTime,
    conversationDuration: session.conversationStartTime
      ? now - session.conversationStartTime
      : 0,
    toolCallCount: session.toolCallCount || 0,
    currentThread: session.currentThread,
    threadCount: session.threadHistory.length,
    topicTransitions: session.topicTransitions.length,
    lastIntent: session.lastIntent,
    clientInfo: session.clientInfo,
  };
}

/**
 * Start a new conversation thread within the session
 */
export function startNewConversationThread(reason: string = "manual"): void {
  const session = getCurrentSession();
  if (!session) return;

  // Archive current thread if exists
  if (session.currentThread) {
    if (!session.threadHistory.includes(session.currentThread)) {
      session.threadHistory.push(session.currentThread);
    }
  }

  // Reset conversation start time
  session.conversationStartTime = Date.now();
  session.currentThread = undefined;

  mcpLogger.debug("session", "Started new conversation thread", {
    sessionId: session.sessionId.substring(0, 8) + "...",
    reason,
    previousThreadCount: session.threadHistory.length,
  });
}
