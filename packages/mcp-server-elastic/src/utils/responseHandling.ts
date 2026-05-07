/* src/utils/responseHandling.ts */

import { logger } from "./logger.js";

export interface PaginationOptions {
	limit?: number;
	maxLimit?: number;
	defaultLimit?: number;
	offset?: number;
}

export interface ResponseSizeOptions {
	maxTokens?: number;
	summarize?: boolean;
	truncateFields?: string[];
	excludeFields?: string[];
}

export interface ResponseMetadata {
	total: number;
	returned: number;
	truncated: boolean;
	effectiveLimit: number;
	summary?: string;
}

// SIO-655: reject limit > maxLimit instead of silently clamping. Silent clamping
// paired with metadata that echoed the requested value caused callers to trust
// results that were actually truncated. Handlers catch this and convert to McpError.
export class PaginationLimitError extends RangeError {
	constructor(
		public readonly requested: number,
		public readonly maxLimit: number,
	) {
		super(`Requested limit ${requested} exceeds maxLimit ${maxLimit} for this tool.`);
		this.name = "PaginationLimitError";
	}
}

export function paginateResults<T>(
	items: T[],
	options: PaginationOptions = {},
): { results: T[]; metadata: ResponseMetadata } {
	const { limit, maxLimit = 100, offset = 0, defaultLimit = 20 } = options;

	if (limit !== undefined && limit > maxLimit) {
		throw new PaginationLimitError(limit, maxLimit);
	}

	const effectiveLimit = limit ?? defaultLimit;
	const startIndex = Math.max(0, offset);
	const endIndex = startIndex + effectiveLimit;

	const results = items.slice(startIndex, endIndex);
	const metadata: ResponseMetadata = {
		total: items.length,
		returned: results.length,
		truncated: items.length > endIndex,
		effectiveLimit,
	};

	if (metadata.truncated) {
		metadata.summary = `Showing ${results.length} of ${items.length} results. Use pagination parameters to see more.`;
	}

	return { results, metadata };
}

export function estimateTokenCount(text: string): number {
	// Rough approximation: ~4 characters per token for JSON content
	return Math.ceil(text.length / 4);
}

export function truncateResponse(
	content: string,
	options: ResponseSizeOptions = {},
): { content: string; truncated: boolean; originalTokens: number; finalTokens: number } {
	const { maxTokens = 20000 } = options;

	const originalTokens = estimateTokenCount(content);

	if (originalTokens <= maxTokens) {
		return {
			content,
			truncated: false,
			originalTokens,
			finalTokens: originalTokens,
		};
	}

	// Calculate how much to keep (leaving room for truncation message)
	const truncationMessage = "\n\n... [Response truncated due to size limits] ...";
	const maxChars = (maxTokens - estimateTokenCount(truncationMessage)) * 4;

	const truncatedContent = content.substring(0, maxChars) + truncationMessage;
	const finalTokens = estimateTokenCount(truncatedContent);

	logger.warn(
		{
			originalTokens,
			finalTokens,
			maxTokens,
		},
		"Response truncated due to size limits",
	);

	return {
		content: truncatedContent,
		truncated: true,
		originalTokens,
		finalTokens,
	};
}

export function reduceObjectSize<T>(obj: T, options: ResponseSizeOptions = {}): T {
	const { truncateFields = [], excludeFields = [] } = options;

	if (typeof obj !== "object" || obj === null) {
		return obj;
	}

	if (Array.isArray(obj)) {
		return obj.map((item) => reduceObjectSize(item, options)) as unknown as T;
	}

	const result: Record<string, unknown> = {};

	for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
		// Skip excluded fields
		if (excludeFields.includes(key)) {
			continue;
		}

		// Truncate specified fields if they're arrays
		if (truncateFields.includes(key) && Array.isArray(value)) {
			const maxItems = 5; // Reduce from 10 to 5 for better size control
			result[key] =
				value.length > maxItems ? [...value.slice(0, maxItems), `... and ${value.length - maxItems} more`] : value;
			continue;
		}

		// Recursively process nested objects
		result[key] = reduceObjectSize(value, options);
	}

	return result as unknown as T;
}

export function createPaginationHeader(metadata: ResponseMetadata, entityName = "items"): string {
	const lines = [
		`## ${entityName.charAt(0).toUpperCase() + entityName.slice(1)} (${metadata.returned}${metadata.truncated ? ` of ${metadata.total}` : ""})`,
	];

	if (metadata.truncated) {
		lines.push(`${metadata.summary}`);
	}

	return `${lines.join("\n")}\n`;
}

export function formatAsMarkdown(obj: unknown, title?: string): string {
	const lines: string[] = [];

	if (title) {
		lines.push(`### ${title}`);
	}

	if (typeof obj === "object" && obj !== null) {
		for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
			if (Array.isArray(value)) {
				lines.push(`- **${key}**: ${value.length} items`);
				if (value.length <= 5) {
					for (const item of value) {
						lines.push(`  - ${item}`);
					}
				} else {
					for (const item of value.slice(0, 3)) {
						lines.push(`  - ${item}`);
					}
					lines.push(`  - ... and ${value.length - 3} more`);
				}
			} else if (typeof value === "object" && value !== null) {
				lines.push(`- **${key}**: [Object]`);
			} else {
				lines.push(`- **${key}**: ${value}`);
			}
		}
	} else {
		lines.push(String(obj));
	}

	return lines.join("\n");
}

export const sortFunctions = {
	byName: (a: { name?: string }, b: { name?: string }) => (a.name || "").localeCompare(b.name || ""),
	byDate: (
		a: { date?: string | number; modified_date?: string | number },
		b: { date?: string | number; modified_date?: string | number },
	) => new Date(b.date || b.modified_date || 0).getTime() - new Date(a.date || a.modified_date || 0).getTime(),
	bySize: (a: { size?: number }, b: { size?: number }) => (b.size || 0) - (a.size || 0),
	byCount: (a: { count?: number }, b: { count?: number }) => (b.count || 0) - (a.count || 0),
};

export const responsePresets = {
	list: {
		defaultLimit: 20,
		maxLimit: 100,
		maxTokens: 15000,
	},
	detail: {
		defaultLimit: 5,
		maxLimit: 20,
		maxTokens: 20000,
	},
	summary: {
		defaultLimit: 50,
		maxLimit: 200,
		maxTokens: 10000,
	},
} as const;
