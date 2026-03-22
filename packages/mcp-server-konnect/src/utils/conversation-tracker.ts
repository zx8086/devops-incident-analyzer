/**
 * Conversation Tracking System for Enhanced LangSmith Session Awareness
 * Tracks conversation flow, tool sequences, and provides context for better trace organization
 */

import { mcpLogger } from "./mcp-logger.js";
import { getCurrentSession } from "./session-manager.js";

export interface ConversationInfo {
  conversationId: string;
  sessionId: string;
  messageCount: number;
  isNewConversation: boolean;
  startTime: number;
  lastActivity: number;
  lastToolCall: string;
  lastContext?: string;
  toolSequence: string[];
  contextSwitches: number;
  topics: string[];
  currentTopic?: string;
  averageResponseTime: number;
  totalExecutionTime: number;
  errorCount: number;
  successCount: number;
}

export interface ConversationFlow {
  type: string;
  description: string;
  confidence: number;
}

// In-memory conversation storage (keyed by sessionId)
const conversations = new Map<string, ConversationInfo>();

// Conversation timeout (30 minutes of inactivity = new conversation)
const CONVERSATION_TIMEOUT = 30 * 60 * 1000;

/**
 * Get or create a conversation context for the current session
 */
export function getOrCreateConversation(
  sessionId: string,
  toolName?: string,
): ConversationInfo {
  let conversation = conversations.get(sessionId);
  const now = Date.now();

  // Check if conversation exists and is still active (within timeout)
  const isExpired =
    conversation && now - conversation.lastActivity > CONVERSATION_TIMEOUT;

  if (!conversation || isExpired) {
    // Create new conversation
    const conversationId = generateConversationId(sessionId);

    conversation = {
      conversationId,
      sessionId,
      messageCount: 0,
      isNewConversation: true,
      startTime: now,
      lastActivity: now,
      lastToolCall: toolName || "",
      toolSequence: [],
      contextSwitches: 0,
      topics: [],
      averageResponseTime: 0,
      totalExecutionTime: 0,
      errorCount: 0,
      successCount: 0,
    };

    conversations.set(sessionId, conversation);

    mcpLogger.debug("conversation", "Created new conversation", {
      conversationId,
      sessionId: sessionId.substring(0, 8) + "...",
      isExpired: !!isExpired,
    });
  } else {
    // Update existing conversation
    conversation.isNewConversation = false;
    conversation.lastActivity = now;
  }

  return conversation;
}

/**
 * Update conversation with tool execution data
 */
export function updateConversation(
  sessionId: string,
  toolName: string,
  executionTime: number,
  success: boolean,
  context?: string,
): ConversationInfo {
  const conversation = getOrCreateConversation(sessionId, toolName);

  // Update message count and tool sequence
  conversation.messageCount++;
  conversation.toolSequence.push(toolName);
  conversation.lastToolCall = toolName;
  conversation.lastActivity = Date.now();

  // Track execution metrics
  conversation.totalExecutionTime += executionTime;
  if (success) {
    conversation.successCount++;
  } else {
    conversation.errorCount++;
  }

  // Calculate average response time
  conversation.averageResponseTime =
    conversation.totalExecutionTime / conversation.messageCount;

  // Detect context switches
  if (
    context &&
    conversation.lastContext &&
    context !== conversation.lastContext
  ) {
    conversation.contextSwitches++;
    conversation.lastContext = context;
  } else if (context && !conversation.lastContext) {
    conversation.lastContext = context;
  }

  // Detect and track topics
  const detectedTopic = detectTopicFromTool(toolName, context);
  if (detectedTopic && !conversation.topics.includes(detectedTopic)) {
    conversation.topics.push(detectedTopic);
    conversation.currentTopic = detectedTopic;
  }

  // Keep tool sequence manageable (last 20 tools)
  if (conversation.toolSequence.length > 20) {
    conversation.toolSequence = conversation.toolSequence.slice(-20);
  }

  conversations.set(sessionId, conversation);
  return conversation;
}

/**
 * Generate unique conversation ID
 */
function generateConversationId(sessionId: string): string {
  const timestamp = Date.now();
  const randomSuffix = Math.random().toString(36).substring(2, 8);
  const sessionPrefix = sessionId.split("-")[0] || "conv";

  return `${sessionPrefix}_${timestamp}_${randomSuffix}`;
}

/**
 * Create conversation-aware trace name
 */
export function createConversationAwareTraceName(
  toolName: string,
  conversationInfo: ConversationInfo,
): string {
  let traceName = toolName;

  // Add conversation context
  const conversationParts = conversationInfo.conversationId.split("_");
  const conversationIdentifier = conversationParts[
    conversationParts.length - 1
  ].substring(0, 6);

  if (conversationInfo.isNewConversation) {
    traceName += ` [NEW:${conversationIdentifier}]`;
  } else {
    traceName += ` [${conversationIdentifier}:${conversationInfo.messageCount}]`;
  }

  // Add flow context if detected
  const flow = detectConversationFlow(conversationInfo.toolSequence);
  if (flow && flow.confidence > 0.7) {
    traceName += ` {${flow.type}}`;
  }

  return traceName;
}

/**
 * Detect conversation flow patterns from tool sequence
 */
export function detectConversationFlow(
  toolSequence: string[],
): ConversationFlow | null {
  if (toolSequence.length < 2) return null;

  const recent = toolSequence.slice(-5); // Look at last 5 tools
  const sequence = recent.join(" → ");

  // Search and Analysis pattern
  if (
    recent.some((tool) => tool.includes("search") || tool.includes("query")) &&
    recent.some((tool) => tool.includes("analytics") || tool.includes("get_"))
  ) {
    return {
      type: "SEARCH→ANALYZE",
      description: "Information retrieval followed by detailed analysis",
      confidence: 0.9,
    };
  }

  // Browse to Detail pattern
  if (
    recent.some((tool) => tool.includes("list")) &&
    recent.some((tool) => tool.includes("get_") && !tool.includes("list"))
  ) {
    return {
      type: "BROWSE→DETAIL",
      description: "Browsing resources then examining specific items",
      confidence: 0.85,
    };
  }

  // Bulk Creation pattern
  const createTools = recent.filter((tool) => tool.includes("create"));
  if (createTools.length >= 2) {
    return {
      type: "BULK-CREATE",
      description: "Creating multiple resources in sequence",
      confidence: 0.8,
    };
  }

  // Configuration pattern
  if (
    recent.some((tool) => tool.includes("create")) &&
    recent.some((tool) => tool.includes("update") || tool.includes("config"))
  ) {
    return {
      type: "CONFIG→REFINE",
      description: "Creating then refining configuration",
      confidence: 0.75,
    };
  }

  // Troubleshooting pattern
  if (
    recent.some((tool) => tool.includes("list") || tool.includes("get_")) &&
    recent.some((tool) => tool.includes("delete") || tool.includes("fix"))
  ) {
    return {
      type: "INVESTIGATE→FIX",
      description: "Investigating issues then applying fixes",
      confidence: 0.8,
    };
  }

  // Default exploratory pattern
  if (new Set(recent).size > 3) {
    // Diverse tool usage
    return {
      type: "EXPLORATORY",
      description: "Exploring different aspects of the system",
      confidence: 0.6,
    };
  }

  return null;
}

/**
 * Detect topic/domain from tool name and context
 */
function detectTopicFromTool(
  toolName: string,
  context?: string,
): string | null {
  const topicPatterns: Record<string, string> = {
    // Kong-specific domains
    analytics: "data-analysis",
    query: "information-retrieval",
    search: "information-retrieval",
    control_plane: "infrastructure-management",
    certificate: "security-management",
    service: "service-management",
    route: "routing-configuration",
    consumer: "access-management",
    plugin: "feature-configuration",
    portal: "developer-experience",
    credential: "authentication",

    // General patterns
    list: "resource-discovery",
    get: "resource-inspection",
    create: "resource-creation",
    update: "resource-modification",
    delete: "resource-cleanup",
  };

  // Check tool name patterns
  for (const [pattern, topic] of Object.entries(topicPatterns)) {
    if (toolName.toLowerCase().includes(pattern)) {
      return topic;
    }
  }

  // Check context if provided
  if (context) {
    for (const [pattern, topic] of Object.entries(topicPatterns)) {
      if (context.toLowerCase().includes(pattern)) {
        return topic;
      }
    }
  }

  return "general";
}

/**
 * Track conversation flow for intent detection
 */
export function trackConversationFlow(
  toolName: string,
  context?: string,
): void {
  const session = getCurrentSession();
  if (!session) return;

  const conversation = getOrCreateConversation(session.sessionId, toolName);

  // This is called before execution, so we just update the tracking
  // The actual metrics update happens in updateConversation after execution
  mcpLogger.debug("conversation", "Tracking conversation flow", {
    toolName,
    conversationId: conversation.conversationId.substring(0, 10) + "...",
    messageCount: conversation.messageCount + 1, // +1 because this will be the next message
    hasContext: !!context,
  });
}

/**
 * Get conversation statistics for a session
 */
export function getConversationStats(sessionId: string): {
  conversation: ConversationInfo | null;
  flow: ConversationFlow | null;
  efficiency: number;
  coherence: number;
} {
  const conversation = conversations.get(sessionId);

  if (!conversation) {
    return {
      conversation: null,
      flow: null,
      efficiency: 0,
      coherence: 0,
    };
  }

  const flow = detectConversationFlow(conversation.toolSequence);

  // Calculate efficiency (unique tools / total calls)
  const uniqueTools = new Set(conversation.toolSequence);
  const efficiency = uniqueTools.size / conversation.toolSequence.length;

  // Calculate coherence (flow confidence + topic consistency)
  const flowConfidence = flow?.confidence || 0;
  const topicConsistency = conversation.topics.length <= 3 ? 1 : 0.5; // Penalize topic jumping
  const coherence = (flowConfidence + topicConsistency) / 2;

  return {
    conversation,
    flow,
    efficiency,
    coherence,
  };
}

/**
 * Clean up old conversations (call periodically)
 */
export function cleanupOldConversations(): void {
  const now = Date.now();
  const staleThreshold = 4 * 60 * 60 * 1000; // 4 hours

  for (const [sessionId, conversation] of conversations) {
    if (now - conversation.lastActivity > staleThreshold) {
      conversations.delete(sessionId);
      mcpLogger.debug("conversation", "Cleaned up stale conversation", {
        sessionId: sessionId.substring(0, 8) + "...",
        conversationId: conversation.conversationId,
      });
    }
  }
}

/**
 * Get all active conversations (for debugging)
 */
export function getActiveConversations(): ConversationInfo[] {
  return Array.from(conversations.values());
}
