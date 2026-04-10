import type { z } from "zod";

// Import all tool modules
import { analyticsTools } from "./analytics/tools.js";
import { certificatesTools } from "./certificates/tools.js";
import { configurationTools } from "./configuration/tools.js";
import { controlPlanesTools } from "./control-planes/tools.js";
import { elicitationTools } from "./elicitation-tool.js";
import { portalTools } from "./portal/tools.js";
import { portalManagementTools } from "./portal-management/tools.js";

// Common tool interface
export interface MCPTool {
	method: string;
	name: string;
	description: string;
	parameters: z.ZodObject;
	category: string;
}

/**
 * Get all available MCP tools organized by category
 */
export function getAllTools(): MCPTool[] {
	return [
		// Analytics tools (2 tools)
		...analyticsTools(),

		// Control planes tools (4 tools)
		...controlPlanesTools(),

		// Certificate management tools (5 tools)
		...certificatesTools(),

		// Configuration management tools (21 tools) - Enhanced CRUD operations for services, routes, consumers, plugins
		...configurationTools(),

		// Portal management tools (23 tools) - Developer portal, applications, registrations, credentials
		...portalTools(),

		// Portal management tools (8 tools) - Portal creation, configuration, API publishing
		...portalManagementTools(),

		// Elicitation tools (4 tools) - Smart information gathering for migrations
		...elicitationTools,

		// TODO: Add remaining tool categories
		// ...upstreamsTools(), - Upstream and target management
		// Data plane tools integrated in control_planes category above
		// ...credentialsTools(), - Consumer credentials and SNI management
	];
}

/**
 * Get tools by category
 */
export function getToolsByCategory(category: string): MCPTool[] {
	return getAllTools().filter((tool) => tool.category === category);
}

/**
 * Get tool by method name
 */
export function getToolByMethod(method: string): MCPTool | undefined {
	return getAllTools().find((tool) => tool.method === method);
}

/**
 * Get all available categories
 */
export function getAllCategories(): string[] {
	const categories = new Set(getAllTools().map((tool) => tool.category));
	return Array.from(categories).sort();
}

/**
 * Get tool count by category
 */
export function getToolStats(): Record<string, number> {
	const stats: Record<string, number> = {};
	getAllTools().forEach((tool) => {
		stats[tool.category] = (stats[tool.category] || 0) + 1;
	});
	return stats;
}

/**
 * Validate that all tools have unique method names
 */
export function validateToolRegistry(): { isValid: boolean; errors: string[] } {
	const methods = new Set<string>();
	const errors: string[] = [];
	const tools = getAllTools();

	for (const tool of tools) {
		if (methods.has(tool.method)) {
			errors.push(`Duplicate method name found: ${tool.method}`);
		}
		methods.add(tool.method);

		// Validate tool structure
		if (!tool.method || !tool.name || !tool.description || !tool.parameters || !tool.category) {
			errors.push(`Invalid tool structure for method: ${tool.method}`);
		}
	}

	return {
		isValid: errors.length === 0,
		errors,
	};
}
