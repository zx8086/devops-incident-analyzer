/**
 * MCP-Compliant Pagination Utility
 * Implements cursor-based pagination per MCP Specification 2025-06-18
 */

import type { ListTruncationMarker } from "@devops-agent/shared";
import type { MCPTool } from "../tools/registry.js";

// SIO-839: build the shared-shaped truncation marker for a Kong resource list. Konnect
// delegates pagination to Kong (no in-memory slice), so this only signals "more exists,
// here is how to fetch it" -- it never drops data. Emitted only when Kong capped the page.
// `total` falls back to the shown count when Kong did not report a real total; the advice
// makes clear the cap came from Kong, not a precise total. `cursor` is Kong's offset token
// (offset-based tools); omit it for page-number tools and steer the model to `pageNumber`.
export function buildKongTruncationMarker(args: {
	capped: boolean;
	shown: number;
	total?: number;
	cursor?: string;
	advice?: string;
}): ListTruncationMarker | undefined {
	if (!args.capped) return undefined;
	return {
		shown: args.shown,
		total: args.total ?? args.shown,
		advice:
			args.advice ??
			"Kong capped this page at 100 rows. Page with the returned offset to fetch more (this signals more data exists; nothing was dropped).",
		...(args.cursor ? { cursor: args.cursor } : {}),
	};
}

export interface PaginationCursor {
	offset: number;
	category?: string;
	timestamp: number;
}

export interface PaginatedResponse<T> {
	items: T[];
	nextCursor?: string;
}

export interface PaginationParams {
	cursor?: string;
	pageSize?: number;
}

export class MCPPaginator {
	private defaultPageSize = 20; // Reasonable default for tool lists
	private maxPageSize = 50; // Prevent oversized responses

	/**
	 * Encode pagination cursor as opaque string
	 */
	private encodeCursor(cursor: PaginationCursor): string {
		return Buffer.from(JSON.stringify(cursor)).toString("base64");
	}

	/**
	 * Decode pagination cursor from opaque string
	 */
	private decodeCursor(cursorString: string): PaginationCursor {
		try {
			const decoded = Buffer.from(cursorString, "base64").toString("utf-8");
			const cursor = JSON.parse(decoded) as PaginationCursor;

			// Validate cursor structure
			if (typeof cursor.offset !== "number" || typeof cursor.timestamp !== "number") {
				throw new Error("Invalid cursor structure");
			}

			// Check cursor age (24 hour expiry)
			const maxAge = 24 * 60 * 60 * 1000; // 24 hours
			if (Date.now() - cursor.timestamp > maxAge) {
				throw new Error("Cursor expired");
			}

			return cursor;
		} catch (error) {
			throw new Error(`Invalid cursor: ${error instanceof Error ? error.message : "Unknown error"}`);
		}
	}

	/**
	 * Paginate tools list with optional category filtering
	 */
	paginateTools(allTools: MCPTool[], params: PaginationParams = {}): PaginatedResponse<MCPTool> {
		const pageSize = Math.min(params.pageSize || this.defaultPageSize, this.maxPageSize);
		let startOffset = 0;
		let categoryFilter: string | undefined;

		// Decode cursor if provided
		if (params.cursor) {
			try {
				const cursor = this.decodeCursor(params.cursor);
				startOffset = cursor.offset;
				categoryFilter = cursor.category;
			} catch (error) {
				throw new Error(`Invalid pagination cursor: ${error instanceof Error ? error.message : "Unknown error"}`);
			}
		}

		// Apply category filter if specified
		let filteredTools = allTools;
		if (categoryFilter) {
			filteredTools = allTools.filter((tool) => tool.category === categoryFilter);
		}

		// Apply pagination
		const endOffset = startOffset + pageSize;
		const pageItems = filteredTools.slice(startOffset, endOffset);

		// Generate next cursor if more items exist
		let nextCursor: string | undefined;
		if (endOffset < filteredTools.length) {
			const nextCursorData: PaginationCursor = {
				offset: endOffset,
				category: categoryFilter,
				timestamp: Date.now(),
			};
			nextCursor = this.encodeCursor(nextCursorData);
		}

		return {
			items: pageItems,
			nextCursor,
		};
	}

	/**
	 * Get tools by category with pagination
	 */
	paginateToolsByCategory(
		allTools: MCPTool[],
		category: string,
		params: PaginationParams = {},
	): PaginatedResponse<MCPTool> {
		const categoryTools = allTools.filter((tool) => tool.category === category);
		return this.paginateTools(categoryTools, params);
	}

	/**
	 * Get available tool categories for client navigation
	 */
	getToolCategories(allTools: MCPTool[]): string[] {
		return [...new Set(allTools.map((tool) => tool.category))].sort();
	}
}

// Export singleton instance
export const mcpPaginator = new MCPPaginator();
