/**
 * Intent Detection System for Enhanced Conversation Awareness
 * Analyzes tool usage patterns to detect user intent and conversation goals
 */

export interface UserIntent {
	primary: string;
	secondary?: string[];
	confidence: number;
	evidence: string[];
	suggestedNextActions?: string[];
}

export interface ConversationPattern {
	name: string;
	description: string;
	tools: string[];
	sequence?: "any" | "ordered" | "contains";
	confidence: number;
}

export interface ContextTransition {
	from: string;
	to: string;
	timestamp: number;
	triggerTool: string;
	reason: string;
}

/**
 * Pre-defined conversation patterns for Kong MCP server
 */
const CONVERSATION_PATTERNS: ConversationPattern[] = [
	{
		name: "API Gateway Setup",
		description: "Setting up a new API gateway configuration",
		tools: ["create_service", "create_route", "create_consumer", "create_plugin"],
		sequence: "contains",
		confidence: 0.9,
	},
	{
		name: "Security Audit",
		description: "Reviewing and analyzing security configurations",
		tools: ["list_certificates", "get_certificate", "list_consumers", "list_plugins"],
		sequence: "any",
		confidence: 0.85,
	},
	{
		name: "Performance Analysis",
		description: "Analyzing API performance and usage patterns",
		tools: ["query_api_requests", "get_consumer_requests", "analytics"],
		sequence: "any",
		confidence: 0.9,
	},
	{
		name: "Infrastructure Discovery",
		description: "Exploring and understanding the current infrastructure",
		tools: ["list_control_planes", "list_services", "list_routes", "list_data_plane_nodes"],
		sequence: "any",
		confidence: 0.8,
	},
	{
		name: "Certificate Management",
		description: "Managing SSL/TLS certificates and security",
		tools: ["list_certificates", "create_certificate", "update_certificate", "delete_certificate"],
		sequence: "contains",
		confidence: 0.95,
	},
	{
		name: "Developer Portal Setup",
		description: "Setting up developer portal and API publishing",
		tools: ["create_portal", "publish_portal_product", "create_portal_application"],
		sequence: "contains",
		confidence: 0.9,
	},
	{
		name: "Troubleshooting Session",
		description: "Investigating and resolving system issues",
		tools: ["get_control_plane", "list_data_plane_nodes", "query_api_requests"],
		sequence: "any",
		confidence: 0.75,
	},
	{
		name: "Resource Cleanup",
		description: "Removing unused or problematic resources",
		tools: ["delete_service", "delete_route", "delete_consumer", "delete_plugin"],
		sequence: "any",
		confidence: 0.8,
	},
];

/**
 * Intent classification based on tool usage patterns
 */
const INTENT_CLASSIFIERS = {
	exploration: {
		patterns: ["list_", "get_"],
		description: "User is exploring and discovering resources",
		suggestedActions: ["Continue browsing related resources", "Deep dive into specific items"],
	},
	configuration: {
		patterns: ["create_", "update_", "config"],
		description: "User is creating or modifying configurations",
		suggestedActions: ["Validate configuration", "Test the changes", "Set up monitoring"],
	},
	analysis: {
		patterns: ["query_", "analytics", "get_consumer_requests"],
		description: "User is analyzing data and performance",
		suggestedActions: ["Export results", "Set up alerts", "Create reports"],
	},
	security: {
		patterns: ["certificate", "credential", "consumer", "auth"],
		description: "User is working with security-related configurations",
		suggestedActions: ["Review access policies", "Validate certificates", "Test authentication"],
	},
	maintenance: {
		patterns: ["delete_", "cleanup", "remove"],
		description: "User is performing maintenance tasks",
		suggestedActions: ["Verify dependencies", "Backup before changes", "Monitor for issues"],
	},
	development: {
		patterns: ["portal", "application", "product"],
		description: "User is working on developer experience features",
		suggestedActions: ["Test API endpoints", "Update documentation", "Review developer feedback"],
	},
};

/**
 * Detect user intent from tool usage patterns
 */
export function detectIntent(toolName: string, args: any, toolHistory: string[] = []): UserIntent {
	const allTools = [...toolHistory, toolName];
	const evidence: string[] = [];
	const secondaryIntents: string[] = [];

	// Primary intent detection based on current tool
	let primaryIntent = "general";
	let confidence = 0.5;

	// Check against intent classifiers
	for (const [intent, classifier] of Object.entries(INTENT_CLASSIFIERS)) {
		const matches = classifier.patterns.some((pattern) => toolName.includes(pattern));
		if (matches) {
			primaryIntent = intent;
			confidence = 0.8;
			evidence.push(`Tool '${toolName}' matches ${intent} pattern`);
			break;
		}
	}

	// Check for conversation patterns
	const matchedPatterns = CONVERSATION_PATTERNS.filter((pattern) => {
		const toolMatches = pattern.tools.some((tool) => allTools.some((usedTool) => usedTool.includes(tool)));
		return toolMatches;
	});

	if (matchedPatterns.length > 0) {
		const bestPattern = matchedPatterns.reduce((best, current) =>
			current.confidence > best.confidence ? current : best,
		);

		if (bestPattern.confidence > confidence) {
			primaryIntent = bestPattern.name.toLowerCase().replace(/\s+/g, "_");
			confidence = bestPattern.confidence;
			evidence.push(`Matches conversation pattern: ${bestPattern.name}`);
		}

		// Add secondary intents from other matched patterns
		matchedPatterns.forEach((pattern) => {
			if (pattern.name !== bestPattern.name) {
				const secondaryIntent = pattern.name.toLowerCase().replace(/\s+/g, "_");
				if (!secondaryIntents.includes(secondaryIntent)) {
					secondaryIntents.push(secondaryIntent);
				}
			}
		});
	}

	// Analyze tool sequence for additional context
	if (allTools.length >= 2) {
		const sequence = analyzeToolSequence(allTools);
		if (sequence.confidence > 0.7) {
			evidence.push(`Tool sequence suggests: ${sequence.intent}`);
			if (sequence.confidence > confidence) {
				primaryIntent = sequence.intent;
				confidence = sequence.confidence;
			}
		}
	}

	// Analyze arguments for additional context
	const argAnalysis = analyzeToolArguments(toolName, args);
	if (argAnalysis.intent && argAnalysis.confidence > 0.6) {
		evidence.push(`Arguments suggest: ${argAnalysis.intent}`);
		if (!secondaryIntents.includes(argAnalysis.intent)) {
			secondaryIntents.push(argAnalysis.intent);
		}
	}

	// Get suggested next actions
	const classifier = INTENT_CLASSIFIERS[primaryIntent as keyof typeof INTENT_CLASSIFIERS];
	const suggestedNextActions = classifier?.suggestedActions || [];

	return {
		primary: primaryIntent,
		secondary: secondaryIntents.length > 0 ? secondaryIntents : undefined,
		confidence: Math.min(confidence, 1.0),
		evidence,
		suggestedNextActions,
	};
}

/**
 * Analyze tool sequence for intent patterns
 */
function analyzeToolSequence(tools: string[]): {
	intent: string;
	confidence: number;
} {
	const recent = tools.slice(-5);

	// List → Get pattern (browsing to detail)
	if (
		recent.some((tool) => tool.includes("list")) &&
		recent.some((tool) => tool.includes("get_") && !tool.includes("list"))
	) {
		return { intent: "detailed_exploration", confidence: 0.85 };
	}

	// Multiple creates (bulk setup)
	const createCount = recent.filter((tool) => tool.includes("create")).length;
	if (createCount >= 2) {
		return { intent: "bulk_configuration", confidence: 0.9 };
	}

	// Analytics → Query pattern (research)
	if (
		recent.some((tool) => tool.includes("query")) &&
		recent.some((tool) => tool.includes("analytics") || tool.includes("get_consumer"))
	) {
		return { intent: "data_research", confidence: 0.8 };
	}

	// Mixed CRUD operations (maintenance)
	const hasCreate = recent.some((tool) => tool.includes("create"));
	const hasUpdate = recent.some((tool) => tool.includes("update"));
	const hasDelete = recent.some((tool) => tool.includes("delete"));
	const crudCount = [hasCreate, hasUpdate, hasDelete].filter(Boolean).length;

	if (crudCount >= 2) {
		return { intent: "system_maintenance", confidence: 0.75 };
	}

	return { intent: "general", confidence: 0.5 };
}

/**
 * Analyze tool arguments for intent clues
 */
function analyzeToolArguments(toolName: string, args: any): { intent: string; confidence: number } {
	if (!args || typeof args !== "object") {
		return { intent: "general", confidence: 0.1 };
	}

	// Look for bulk operations (high pageSize, multiple IDs, etc.)
	if (args.pageSize && args.pageSize > 50) {
		return { intent: "bulk_analysis", confidence: 0.7 };
	}

	// Look for filtering (user is searching for specific things)
	const filterCount = Object.keys(args).filter(
		(key) => key.startsWith("filter") || key.includes("Filter") || key.includes("search"),
	).length;

	if (filterCount > 0) {
		return { intent: "targeted_search", confidence: 0.8 };
	}

	// Look for time-based analysis
	if (args.timeRange || args.timeWindow) {
		return { intent: "temporal_analysis", confidence: 0.75 };
	}

	// Look for security-related fields
	const securityFields = ["cert", "certificate", "key", "secret", "token", "auth"];
	const hasSecurityFields = securityFields.some((field) =>
		Object.keys(args).some((key) => key.toLowerCase().includes(field)),
	);

	if (hasSecurityFields) {
		return { intent: "security_management", confidence: 0.8 };
	}

	return { intent: "general", confidence: 0.3 };
}

/**
 * Detect context transitions in conversation
 */
export function detectContextTransition(
	previousTools: string[],
	currentTool: string,
	previousIntent?: string,
): ContextTransition | null {
	if (!previousIntent || previousTools.length === 0) {
		return null;
	}

	const currentIntent = detectIntent(currentTool, {}, previousTools);

	// Check if there's a significant intent change
	if (currentIntent.primary !== previousIntent && currentIntent.confidence > 0.7) {
		const transition: ContextTransition = {
			from: previousIntent,
			to: currentIntent.primary,
			timestamp: Date.now(),
			triggerTool: currentTool,
			reason: determineTransitionReason(previousIntent, currentIntent.primary),
		};

		return transition;
	}

	return null;
}

/**
 * Determine the reason for context transition
 */
function determineTransitionReason(from: string, to: string): string {
	const transitionMap: Record<string, Record<string, string>> = {
		exploration: {
			configuration: "Found resources to configure",
			analysis: "Discovered data to analyze",
			security: "Identified security items to review",
		},
		configuration: {
			analysis: "Validating created configurations",
			exploration: "Exploring related resources",
			maintenance: "Cleaning up after configuration",
		},
		analysis: {
			configuration: "Acting on analysis findings",
			exploration: "Investigating analysis results",
			security: "Security concerns from analysis",
		},
	};

	return transitionMap[from]?.[to] || `Shifted focus from ${from} to ${to}`;
}

/**
 * Get intent-based suggestions for next actions
 */
export function getIntentBasedSuggestions(
	intent: UserIntent,
	toolHistory: string[],
	context?: Record<string, any>,
): string[] {
	const suggestions: string[] = [...(intent.suggestedNextActions || [])];

	// Add context-specific suggestions
	switch (intent.primary) {
		case "exploration":
			if (!toolHistory.some((tool) => tool.includes("get_"))) {
				suggestions.push("Deep dive into specific resources");
			}
			break;

		case "configuration":
			if (!toolHistory.some((tool) => tool.includes("list"))) {
				suggestions.push("Review existing configurations first");
			}
			suggestions.push("Test the new configuration");
			break;

		case "security":
			suggestions.push("Verify certificate expiration dates");
			suggestions.push("Review access permissions");
			break;

		case "performance_analysis":
			suggestions.push("Set up monitoring alerts");
			suggestions.push("Compare with historical data");
			break;
	}

	return [...new Set(suggestions)]; // Remove duplicates
}
