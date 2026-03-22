/**
 * Conversation Quality Metrics System
 * Provides comprehensive analysis of conversation quality, efficiency, and user satisfaction
 */

import type {
  ConversationFlow,
  ConversationInfo,
} from "./conversation-tracker.js";
import type { UserIntent } from "./intent-detector.js";

export interface ConversationQuality {
  coherenceScore: number; // How well tools flow together (0-1)
  efficiencyScore: number; // Redundant vs productive tool calls (0-1)
  satisfactionIndicators: string[];
  conversationCompleteness: number; // How complete the conversation feels (0-1)
  engagementLevel: "low" | "medium" | "high";
  complexityLevel: "simple" | "moderate" | "complex";
  userExperienceScore: number; // Overall UX score (0-1)
}

export interface PerformanceMetrics {
  averageResponseTime: number;
  slowOperationsCount: number;
  errorRate: number;
  successRate: number;
  totalOperations: number;
  timeToFirstSuccess: number;
  peakPerformancePeriod?: {
    start: number;
    end: number;
    avgResponseTime: number;
  };
}

export interface ConversationInsights {
  dominantPatterns: string[];
  userJourney: Array<{
    phase: string;
    tools: string[];
    duration: number;
    outcome: "successful" | "partial" | "failed";
  }>;
  recommendedImprovements: string[];
  skillLevel: "beginner" | "intermediate" | "advanced";
}

/**
 * Analyze conversation quality comprehensively
 */
export function analyzeConversationQuality(
  conversation: ConversationInfo,
  intent?: UserIntent,
  flow?: ConversationFlow,
): ConversationQuality {
  const coherenceScore = calculateCoherenceScore(conversation, flow);
  const efficiencyScore = calculateEfficiencyScore(conversation);
  const satisfactionIndicators = identifySatisfactionIndicators(conversation);
  const conversationCompleteness = calculateCompleteness(conversation, intent);
  const engagementLevel = assessEngagementLevel(conversation);
  const complexityLevel = assessComplexityLevel(conversation);
  const userExperienceScore = calculateUserExperienceScore({
    coherenceScore,
    efficiencyScore,
    completeness: conversationCompleteness,
    performance: conversation.averageResponseTime,
  });

  return {
    coherenceScore,
    efficiencyScore,
    satisfactionIndicators,
    conversationCompleteness,
    engagementLevel,
    complexityLevel,
    userExperienceScore,
  };
}

/**
 * Calculate how coherent the conversation flow is
 */
function calculateCoherenceScore(
  conversation: ConversationInfo,
  flow?: ConversationFlow,
): number {
  const { toolSequence, contextSwitches } = conversation;

  if (toolSequence.length < 2) return 1.0; // Single tool is perfectly coherent

  let score = 1.0;

  // Flow confidence contributes to coherence
  if (flow?.confidence) {
    score = (score + flow.confidence) / 2;
  }

  // Penalize excessive context switches
  const contextSwitchPenalty = Math.min(contextSwitches * 0.1, 0.3);
  score -= contextSwitchPenalty;

  // Reward logical tool progressions
  const logicalProgressions = identifyLogicalProgressions(toolSequence);
  const progressionBonus = Math.min(logicalProgressions * 0.1, 0.2);
  score += progressionBonus;

  // Penalize random tool jumping
  const randomness = calculateRandomness(toolSequence);
  score -= randomness * 0.2;

  return Math.max(0, Math.min(1, score));
}

/**
 * Calculate efficiency of tool usage
 */
function calculateEfficiencyScore(conversation: ConversationInfo): number {
  const { toolSequence, errorCount, messageCount } = conversation;

  if (toolSequence.length === 0) return 0;

  // Base efficiency: unique tools / total calls
  const uniqueTools = new Set(toolSequence);
  let efficiency = uniqueTools.size / toolSequence.length;

  // Adjust for error rate
  const successRate = (messageCount - errorCount) / messageCount;
  efficiency = (efficiency + successRate) / 2;

  // Reward completing tasks with fewer tools
  if (hasCompletionIndicators(toolSequence)) {
    efficiency += 0.1;
  }

  // Penalize excessive repetition
  const repetitionPenalty = calculateRepetitionPenalty(toolSequence);
  efficiency -= repetitionPenalty;

  return Math.max(0, Math.min(1, efficiency));
}

/**
 * Identify satisfaction indicators from conversation patterns
 */
function identifySatisfactionIndicators(
  conversation: ConversationInfo,
): string[] {
  const indicators: string[] = [];
  const { errorCount, messageCount, averageResponseTime, toolSequence } =
    conversation;

  // Error-free operation
  if (errorCount === 0 && messageCount > 1) {
    indicators.push("error-free-session");
  }

  // Fast response times
  if (averageResponseTime < 1000) {
    indicators.push("responsive-performance");
  }

  // Comprehensive exploration
  if (messageCount > 5 && new Set(toolSequence).size > 3) {
    indicators.push("comprehensive-exploration");
  }

  // Successful completion patterns
  if (hasCompletionIndicators(toolSequence)) {
    indicators.push("task-completion");
  }

  // Progressive skill demonstration
  if (showsProgressiveComplexity(toolSequence)) {
    indicators.push("skill-progression");
  }

  // Efficient problem solving
  if (showsEfficientProblemSolving(toolSequence)) {
    indicators.push("efficient-problem-solving");
  }

  return indicators;
}

/**
 * Calculate conversation completeness
 */
function calculateCompleteness(
  conversation: ConversationInfo,
  intent?: UserIntent,
): number {
  const { toolSequence, messageCount } = conversation;

  if (!intent) return 0.5; // Default middle score without intent

  let completeness = 0.5;

  // Check if conversation matches expected patterns for the intent
  switch (intent.primary) {
    case "exploration": {
      // Should have both list and get operations
      const hasList = toolSequence.some((tool) => tool.includes("list"));
      const hasGet = toolSequence.some((tool) => tool.includes("get_"));
      completeness = hasList && hasGet ? 0.9 : 0.6;
      break;
    }

    case "configuration": {
      // Should have create/update operations
      const hasCreate = toolSequence.some((tool) => tool.includes("create"));
      const hasValidation = toolSequence.some(
        (tool) => tool.includes("get_") || tool.includes("list"),
      );
      completeness = hasCreate ? (hasValidation ? 0.95 : 0.8) : 0.4;
      break;
    }

    case "analysis": {
      // Should have query operations and possibly follow-up
      const hasQuery = toolSequence.some(
        (tool) => tool.includes("query") || tool.includes("analytics"),
      );
      const hasFollowUp = messageCount > 1;
      completeness = hasQuery ? (hasFollowUp ? 0.9 : 0.7) : 0.3;
      break;
    }

    default: {
      // Generic completeness based on conversation length and diversity
      const diversity =
        new Set(toolSequence).size / Math.min(toolSequence.length, 10);
      const lengthFactor = Math.min(messageCount / 5, 1);
      completeness = (diversity + lengthFactor) / 2;
    }
  }

  return Math.max(0, Math.min(1, completeness));
}

/**
 * Assess user engagement level
 */
function assessEngagementLevel(
  conversation: ConversationInfo,
): "low" | "medium" | "high" {
  const { messageCount, toolSequence, totalExecutionTime } = conversation;
  const duration = Date.now() - conversation.startTime;

  // High engagement indicators
  if (
    messageCount > 10 ||
    new Set(toolSequence).size > 6 ||
    duration > 5 * 60 * 1000
  ) {
    // 5+ minutes
    return "high";
  }

  // Medium engagement indicators
  if (
    messageCount > 3 ||
    new Set(toolSequence).size > 2 ||
    duration > 60 * 1000
  ) {
    // 1+ minute
    return "medium";
  }

  return "low";
}

/**
 * Assess conversation complexity level
 */
function assessComplexityLevel(
  conversation: ConversationInfo,
): "simple" | "moderate" | "complex" {
  const { toolSequence, contextSwitches, topics } = conversation;
  const uniqueTools = new Set(toolSequence).size;

  // Complex indicators
  if (
    uniqueTools > 8 ||
    contextSwitches > 3 ||
    topics.length > 4 ||
    hasAdvancedToolUsage(toolSequence)
  ) {
    return "complex";
  }

  // Moderate indicators
  if (uniqueTools > 3 || contextSwitches > 1 || topics.length > 2) {
    return "moderate";
  }

  return "simple";
}

/**
 * Calculate overall user experience score
 */
function calculateUserExperienceScore(factors: {
  coherenceScore: number;
  efficiencyScore: number;
  completeness: number;
  performance: number;
}): number {
  const { coherenceScore, efficiencyScore, completeness, performance } =
    factors;

  // Performance score (inverse of response time, capped)
  const performanceScore = Math.max(0, 1 - performance / 5000); // 5s = 0 score

  // Weighted average
  const weights = {
    coherence: 0.25,
    efficiency: 0.25,
    completeness: 0.3,
    performance: 0.2,
  };

  return (
    coherenceScore * weights.coherence +
    efficiencyScore * weights.efficiency +
    completeness * weights.completeness +
    performanceScore * weights.performance
  );
}

/**
 * Generate conversation insights and recommendations
 */
export function generateConversationInsights(
  conversation: ConversationInfo,
  quality: ConversationQuality,
): ConversationInsights {
  const dominantPatterns = identifyDominantPatterns(conversation.toolSequence);
  const userJourney = analyzeUserJourney(conversation);
  const recommendedImprovements = generateRecommendations(
    quality,
    conversation,
  );
  const skillLevel = assessSkillLevel(conversation);

  return {
    dominantPatterns,
    userJourney,
    recommendedImprovements,
    skillLevel,
  };
}

// Helper functions

function identifyLogicalProgressions(toolSequence: string[]): number {
  let progressions = 0;

  for (let i = 0; i < toolSequence.length - 1; i++) {
    const current = toolSequence[i];
    const next = toolSequence[i + 1];

    // List → Get progression
    if (current.includes("list") && next.includes("get_")) {
      progressions++;
    }

    // Create → Validate progression
    if (
      current.includes("create") &&
      (next.includes("get_") || next.includes("list"))
    ) {
      progressions++;
    }

    // Query → Analyze progression
    if (current.includes("query") && next.includes("get_consumer")) {
      progressions++;
    }
  }

  return progressions;
}

function calculateRandomness(toolSequence: string[]): number {
  if (toolSequence.length < 3) return 0;

  // Measure how often consecutive tools are completely different
  let randomTransitions = 0;

  for (let i = 0; i < toolSequence.length - 1; i++) {
    const current = toolSequence[i];
    const next = toolSequence[i + 1];

    // Check if tools share any common words/patterns
    const currentWords = current.split("_");
    const nextWords = next.split("_");
    const hasCommonWords = currentWords.some((word) =>
      nextWords.includes(word),
    );

    if (!hasCommonWords) {
      randomTransitions++;
    }
  }

  return randomTransitions / (toolSequence.length - 1);
}

function hasCompletionIndicators(toolSequence: string[]): boolean {
  // Look for patterns that suggest task completion
  const completionPatterns = [
    // Create → Validate pattern
    (seq: string[]) =>
      seq.some((t) => t.includes("create")) &&
      seq.some((t) => t.includes("get_")),

    // Analysis pattern completion
    (seq: string[]) => seq.some((t) => t.includes("query")) && seq.length > 1,

    // Full CRUD cycle
    (seq: string[]) => {
      const hasCreate = seq.some((t) => t.includes("create"));
      const hasRead = seq.some((t) => t.includes("get_") || t.includes("list"));
      const hasUpdate = seq.some((t) => t.includes("update"));
      return (hasCreate && hasRead) || (hasRead && hasUpdate);
    },
  ];

  return completionPatterns.some((pattern) => pattern(toolSequence));
}

function showsProgressiveComplexity(toolSequence: string[]): boolean {
  if (toolSequence.length < 3) return false;

  // Check if tools become more complex over time
  const complexity = toolSequence.map((tool) => {
    if (tool.includes("list")) return 1;
    if (tool.includes("get_")) return 2;
    if (tool.includes("create") || tool.includes("update")) return 3;
    if (tool.includes("delete")) return 4;
    return 2;
  });

  // Check if complexity generally increases
  let increases = 0;
  for (let i = 0; i < complexity.length - 1; i++) {
    if (complexity[i + 1] > complexity[i]) {
      increases++;
    }
  }

  return increases > complexity.length / 3;
}

function showsEfficientProblemSolving(toolSequence: string[]): boolean {
  // Look for efficient patterns like: list → get → fix
  return (
    toolSequence.length >= 3 &&
    toolSequence.length <= 6 && // Not too many tools
    new Set(toolSequence).size === toolSequence.length
  ); // No repetition
}

function calculateRepetitionPenalty(toolSequence: string[]): number {
  if (toolSequence.length < 2) return 0;

  const repetitions = new Map<string, number>();
  let penalty = 0;

  for (const tool of toolSequence) {
    const count = (repetitions.get(tool) || 0) + 1;
    repetitions.set(tool, count);

    // Penalty for excessive repetition (> 2 times)
    if (count > 2) {
      penalty += 0.1;
    }
  }

  return Math.min(penalty, 0.5); // Cap penalty at 0.5
}

function hasAdvancedToolUsage(toolSequence: string[]): boolean {
  const advancedTools = [
    "query_api_requests",
    "create_certificate",
    "update_plugin",
    "create_portal",
  ];
  return toolSequence.some((tool) => advancedTools.includes(tool));
}

function identifyDominantPatterns(toolSequence: string[]): string[] {
  const patterns = [];

  if (toolSequence.filter((t) => t.includes("list")).length > 2) {
    patterns.push("heavy-browsing");
  }

  if (toolSequence.filter((t) => t.includes("create")).length > 2) {
    patterns.push("bulk-creation");
  }

  if (toolSequence.filter((t) => t.includes("query")).length > 1) {
    patterns.push("analytical");
  }

  return patterns;
}

function analyzeUserJourney(conversation: ConversationInfo): Array<{
  phase: string;
  tools: string[];
  duration: number;
  outcome: "successful" | "partial" | "failed";
}> {
  const { toolSequence, errorCount, messageCount } = conversation;

  // Simple journey analysis - could be much more sophisticated
  const phases = [];
  let currentPhase = "exploration";
  let phaseTools = [];

  for (const tool of toolSequence) {
    if (tool.includes("list") || tool.includes("get_")) {
      if (currentPhase !== "exploration") {
        phases.push({
          phase: currentPhase,
          tools: [...phaseTools],
          duration: 0, // Would need timestamps to calculate
          outcome: "successful" as const,
        });
        phaseTools = [];
      }
      currentPhase = "exploration";
    } else if (tool.includes("create") || tool.includes("update")) {
      currentPhase = "configuration";
    } else if (tool.includes("query") || tool.includes("analytics")) {
      currentPhase = "analysis";
    }

    phaseTools.push(tool);
  }

  // Add final phase
  if (phaseTools.length > 0) {
    phases.push({
      phase: currentPhase,
      tools: phaseTools,
      duration: 0,
      outcome: errorCount === 0 ? "successful" : "partial",
    });
  }

  return phases;
}

function generateRecommendations(
  quality: ConversationQuality,
  conversation: ConversationInfo,
): string[] {
  const recommendations = [];

  if (quality.coherenceScore < 0.6) {
    recommendations.push("Consider planning your approach before starting");
    recommendations.push("Try to complete one task before moving to another");
  }

  if (quality.efficiencyScore < 0.7) {
    recommendations.push("Avoid repeating the same operations");
    recommendations.push(
      "Use list operations to explore before diving into details",
    );
  }

  if (quality.conversationCompleteness < 0.7) {
    recommendations.push("Consider validating changes after making them");
    recommendations.push("Follow through on started tasks");
  }

  if (conversation.averageResponseTime > 3000) {
    recommendations.push(
      "Consider using filters to narrow down large result sets",
    );
  }

  return recommendations;
}

function assessSkillLevel(
  conversation: ConversationInfo,
): "beginner" | "intermediate" | "advanced" {
  const { toolSequence, contextSwitches, errorCount } = conversation;
  const uniqueTools = new Set(toolSequence).size;

  if (uniqueTools > 8 && contextSwitches > 2 && errorCount === 0) {
    return "advanced";
  }

  if (
    uniqueTools > 4 ||
    (hasAdvancedToolUsage(toolSequence) && errorCount < 2)
  ) {
    return "intermediate";
  }

  return "beginner";
}
